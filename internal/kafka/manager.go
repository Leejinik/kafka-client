package kafka

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
)

// TLSOptions describes the SSL settings for a connection. Enabled=false (or a
// nil *TLSOptions) means PLAINTEXT. For 1-way SSL only CACertPEM is needed;
// ClientCertPEM/ClientKeyPEM enable 2-way mTLS.
type TLSOptions struct {
	Enabled            bool
	CACertPEM          string
	ClientCertPEM      string
	ClientKeyPEM       string
	InsecureSkipVerify bool
	ServerName         string
}

// tlsDialConfig is the resolved TLS material for a cluster. It is turned into a
// per-connection *tls.Config inside the dialer, where the target hostname is
// finally known.
type tlsDialConfig struct {
	roots       *x509.CertPool    // CA certs -> chain verification; nil = OS trust store
	pinned      [][]byte          // raw DER of leaf certs trusted exactly (pinning)
	clientCerts []tls.Certificate // 2-way mTLS; empty for 1-way
	insecure    bool              // user asked to skip all verification
	serverName  string            // user override; "" = use the dialed hostname
}

// buildTLSConfig resolves TLSOptions into a *tlsDialConfig, or (nil, nil) when
// TLS is disabled. Every certificate in the trust PEM (CACertPEM) is used two
// ways at once, so the user can hand us a CA *or* a broker cert without saying
// which: each cert becomes both a chain-verification anchor (works for a real
// CA — even a hand-rolled one missing the CA:TRUE flag) and an exact-match pin
// (works when the user supplies the broker's own cert).
func buildTLSConfig(o *TLSOptions) (*tlsDialConfig, error) {
	if o == nil || !o.Enabled {
		return nil, nil
	}
	c := &tlsDialConfig{
		insecure:   o.InsecureSkipVerify,
		serverName: strings.TrimSpace(o.ServerName),
	}
	if trust := strings.TrimSpace(o.CACertPEM); trust != "" {
		rest := []byte(trust)
		parsed := 0
		for {
			var block *pem.Block
			block, rest = pem.Decode(rest)
			if block == nil {
				break
			}
			if block.Type != "CERTIFICATE" {
				continue
			}
			crt, err := x509.ParseCertificate(block.Bytes)
			if err != nil {
				continue
			}
			parsed++
			if c.roots == nil {
				c.roots = x509.NewCertPool()
			}
			c.roots.AddCert(crt)                 // chain-verification anchor (ignores the CA flag)
			c.pinned = append(c.pinned, crt.Raw) // and exact-match pin (name-agnostic)
		}
		if parsed == 0 {
			return nil, errors.New("인증서 PEM을 파싱할 수 없습니다 (유효한 -----BEGIN CERTIFICATE----- 블록이 없음)")
		}
	}
	cert := strings.TrimSpace(o.ClientCertPEM)
	key := strings.TrimSpace(o.ClientKeyPEM)
	if cert != "" || key != "" {
		pair, err := tls.X509KeyPair([]byte(o.ClientCertPEM), []byte(o.ClientKeyPEM))
		if err != nil {
			return nil, fmt.Errorf("클라이언트 인증서/키 로드 실패: %w", err)
		}
		c.clientCerts = []tls.Certificate{pair}
	}
	return c, nil
}

// tlsConfigFor builds the per-connection *tls.Config for a given target
// hostname. When verification is on we drive it ourselves (InsecureSkipVerify +
// VerifyPeerCertificate) so we can accept the legacy CN-only broker certs that
// Kafka SSL deployments still ship — modern Go rejects those outright with
// "certificate relies on legacy Common Name field, use SANs instead". We still
// verify the full chain against the CA, so this is NOT a security downgrade:
// a MITM without a CA-signed cert is still rejected.
func (t *tlsDialConfig) tlsConfigFor(dialedHost string) *tls.Config {
	name := t.serverName
	if name == "" {
		name = dialedHost
	}
	conf := &tls.Config{
		MinVersion:         tls.VersionTLS12,
		ServerName:         name, // SNI
		Certificates:       t.clientCerts,
		InsecureSkipVerify: true, // we run verification (or intentionally skip it) below
	}
	if t.insecure {
		return conf // user explicitly opted out of all verification
	}
	roots := t.roots
	pinned := t.pinned
	conf.VerifyPeerCertificate = func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
		if len(rawCerts) == 0 {
			return errors.New("서버가 인증서를 제시하지 않았습니다")
		}
		certs := make([]*x509.Certificate, 0, len(rawCerts))
		for _, raw := range rawCerts {
			crt, err := x509.ParseCertificate(raw)
			if err != nil {
				return fmt.Errorf("서버 인증서 파싱 실패: %w", err)
			}
			certs = append(certs, crt)
		}
		leaf := certs[0]
		// 1) Pinned? Trust the exact broker cert regardless of name/CA.
		for _, p := range pinned {
			if bytes.Equal(leaf.Raw, p) {
				return nil
			}
		}
		// 2) Chain of trust against the supplied certs (or OS roots if none).
		inter := x509.NewCertPool()
		for _, crt := range certs[1:] {
			inter.AddCert(crt)
		}
		if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, Intermediates: inter}); err != nil {
			return fmt.Errorf("인증서 체인 검증 실패: %w", err)
		}
		// 4) Hostname: prefer SANs; fall back to CN for legacy certs.
		if len(leaf.DNSNames) > 0 || len(leaf.IPAddresses) > 0 {
			return leaf.VerifyHostname(name)
		}
		if hostMatchesCN(name, leaf.Subject.CommonName) {
			return nil
		}
		return fmt.Errorf("호스트명 %q 이(가) 인증서 CN %q 과(와) 일치하지 않습니다", name, leaf.Subject.CommonName)
	}
	return conf
}

// hostMatchesCN does a case-insensitive match of host against a certificate CN,
// honouring a single leftmost "*" wildcard label (e.g. *.liz.com).
func hostMatchesCN(host, cn string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	cn = strings.ToLower(strings.TrimSuffix(cn, "."))
	if cn == "" {
		return false
	}
	if strings.HasPrefix(cn, "*.") {
		base := cn[1:] // ".liz.com"
		// Reject public-suffix-ish wildcards like *.com: the base must carry at
		// least two labels (".liz.com" -> [liz, com]).
		if strings.Count(base, ".") < 2 {
			return false
		}
		// The wildcard must match exactly one NON-empty leftmost label, so the
		// first dot has to sit past position 0 (i<=0 rejects both "no dot" and
		// an empty leftmost label like ".liz.com").
		i := strings.IndexByte(host, '.')
		if i <= 0 {
			return false
		}
		return host[i:] == base
	}
	return host == cn
}

// Client groups the producer/consumer and admin handles for a single profile.
type Client struct {
	servers []string
	aliases map[string]string
	// tlsConf is the SSL config for this cluster (nil = PLAINTEXT). Secondary
	// clients (tail, range consume, loop produce) reuse it so they dial the
	// same SSL listeners as the shared client.
	tlsConf *tlsDialConfig
	cl      *kgo.Client
	adm     *kadm.Client
}

func (c *Client) Servers() []string             { return append([]string(nil), c.servers...) }
func (c *Client) Aliases() map[string]string    { return cloneAliases(c.aliases) }
func cloneAliases(m map[string]string) map[string]string {
	if len(m) == 0 {
		return nil
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// aliasDialer returns a net dial function that rewrites the host portion of
// host:port based on the given alias map before dialing. When tlsConf is
// non-nil the raw connection is wrapped in TLS: crucially the TCP dial goes to
// the rewritten address (an IP), but the TLS ServerName stays the *original*
// advertised hostname, so the broker cert is verified against its CN even
// though we connected by IP.
func aliasDialer(aliases map[string]string, tc *tlsDialConfig) func(ctx context.Context, network, addr string) (net.Conn, error) {
	d := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		dialAddr := addr
		host := ""
		if h, port, err := net.SplitHostPort(addr); err == nil {
			host = h
			if rep, ok := aliases[h]; ok {
				dialAddr = net.JoinHostPort(rep, port)
			}
		}
		raw, err := d.DialContext(ctx, network, dialAddr)
		if err != nil {
			return nil, err
		}
		if tc == nil {
			return raw, nil
		}
		tconn := tls.Client(raw, tc.tlsConfigFor(host))
		// Bound the handshake explicitly. franz-go's internal metadata-refresh
		// dials pass a deadline-less context, and net.Dialer.Timeout /
		// kgo.DialTimeout only cover the TCP connect (the latter is inert once a
		// custom kgo.Dialer is set). Without this, a broker whose SSL port
		// accepts TCP but never completes the handshake would wedge that
		// goroutine forever.
		hsCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if err := tconn.HandshakeContext(hsCtx); err != nil {
			raw.Close()
			return nil, fmt.Errorf("TLS handshake %s: %w", addr, err)
		}
		return tconn, nil
	}
}

// Manager keeps a pool of Kafka clients keyed by profile ID.
type Manager struct {
	mu      sync.RWMutex
	clients map[string]*Client
}

// NewManager returns an empty manager.
func NewManager() *Manager {
	return &Manager{clients: map[string]*Client{}}
}

// Connect opens (or reuses) a client for the given profile.
func (m *Manager) Connect(ctx context.Context, profileID string, servers []string, aliases map[string]string, tlsOpts *TLSOptions) error {
	if profileID == "" {
		return errors.New("profileID is required")
	}
	if len(servers) == 0 {
		return errors.New("bootstrap servers are required")
	}
	tlsConf, err := buildTLSConfig(tlsOpts)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.clients[profileID]; ok {
		return nil
	}
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(servers...),
		kgo.ClientID("kafka-client-tool"),
		kgo.MetadataMinAge(5*time.Second),
		kgo.DialTimeout(10*time.Second),
		kgo.Dialer(aliasDialer(aliases, tlsConf)),
		// Disable producer-side batch compression. franz-go defaults to Snappy,
		// which breaks on brokers whose JVM cannot load the xerial snappy
		// native library (observed: UNKNOWN_SERVER_ERROR with a
		// NoClassDefFoundError on org.xerial.snappy.Snappy in the broker log).
		// NoCompression is safe everywhere; this tool produces single messages,
		// so we don't care about batch throughput.
		kgo.ProducerBatchCompression(kgo.NoCompression()),
	)
	if err != nil {
		return fmt.Errorf("create client: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := cl.Ping(pingCtx); err != nil {
		cl.Close()
		return fmt.Errorf("ping brokers: %w", err)
	}
	m.clients[profileID] = &Client{
		servers: append([]string(nil), servers...),
		aliases: cloneAliases(aliases),
		tlsConf: tlsConf,
		cl:      cl,
		adm:     kadm.NewClient(cl),
	}
	return nil
}

// Disconnect closes a client for the given profile.
func (m *Manager) Disconnect(profileID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.clients[profileID]; ok {
		c.cl.Close()
		delete(m.clients, profileID)
	}
}

// CloseAll closes every open client.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, c := range m.clients {
		c.cl.Close()
		delete(m.clients, id)
	}
}

// IsConnected reports whether a profile currently has an open client.
func (m *Manager) IsConnected(profileID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.clients[profileID]
	return ok
}

// Get returns the active client or an error.
func (m *Manager) Get(profileID string) (*Client, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	c, ok := m.clients[profileID]
	if !ok {
		return nil, fmt.Errorf("profile %s is not connected", profileID)
	}
	return c, nil
}

// Test attempts a transient connection to the given servers.
func (m *Manager) Test(ctx context.Context, servers []string, aliases map[string]string, tlsOpts *TLSOptions) error {
	if len(servers) == 0 {
		return errors.New("bootstrap servers are required")
	}
	tlsConf, err := buildTLSConfig(tlsOpts)
	if err != nil {
		return err
	}
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(servers...),
		kgo.DialTimeout(5*time.Second),
		kgo.Dialer(aliasDialer(aliases, tlsConf)),
		kgo.ClientID("kafka-client-tool-test"),
		kgo.ProducerBatchCompression(kgo.NoCompression()),
	)
	if err != nil {
		return err
	}
	defer cl.Close()
	pingCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	return cl.Ping(pingCtx)
}

// TestInfo makes a transient connection and returns cluster metadata (broker
// list + controller). Powers the "confirm brokers after connect" step in the
// profile dialog — same probe as Test but reports what it found.
func (m *Manager) TestInfo(ctx context.Context, servers []string, aliases map[string]string, tlsOpts *TLSOptions) (ClusterInfo, error) {
	if len(servers) == 0 {
		return ClusterInfo{}, errors.New("bootstrap servers are required")
	}
	tlsConf, err := buildTLSConfig(tlsOpts)
	if err != nil {
		return ClusterInfo{}, err
	}
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(servers...),
		kgo.DialTimeout(5*time.Second),
		kgo.Dialer(aliasDialer(aliases, tlsConf)),
		kgo.ClientID("kafka-client-tool-test"),
		kgo.ProducerBatchCompression(kgo.NoCompression()),
	)
	if err != nil {
		return ClusterInfo{}, err
	}
	defer cl.Close()
	adm := kadm.NewClient(cl)
	mdCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	md, err := adm.Metadata(mdCtx)
	if err != nil {
		return ClusterInfo{}, fmt.Errorf("metadata: %w", err)
	}
	info := ClusterInfo{
		ClusterID:  md.Cluster,
		Controller: md.Controller,
		Brokers:    make([]BrokerInfo, 0, len(md.Brokers)),
	}
	for _, b := range md.Brokers {
		rack := ""
		if b.Rack != nil {
			rack = *b.Rack
		}
		info.Brokers = append(info.Brokers, BrokerInfo{NodeID: b.NodeID, Host: b.Host, Port: b.Port, Rack: rack})
	}
	sort.Slice(info.Brokers, func(i, j int) bool { return info.Brokers[i].NodeID < info.Brokers[j].NodeID })
	return info, nil
}
