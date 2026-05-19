package kafka

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
)

// Client groups the producer/consumer and admin handles for a single profile.
type Client struct {
	servers []string
	aliases map[string]string
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
// host:port based on the given alias map before dialing.
func aliasDialer(aliases map[string]string) func(ctx context.Context, network, addr string) (net.Conn, error) {
	d := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	if len(aliases) == 0 {
		return d.DialContext
	}
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err == nil {
			if rep, ok := aliases[host]; ok {
				addr = net.JoinHostPort(rep, port)
			}
		}
		return d.DialContext(ctx, network, addr)
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
func (m *Manager) Connect(ctx context.Context, profileID string, servers []string, aliases map[string]string) error {
	if profileID == "" {
		return errors.New("profileID is required")
	}
	if len(servers) == 0 {
		return errors.New("bootstrap servers are required")
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
		kgo.Dialer(aliasDialer(aliases)),
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
func (m *Manager) Test(ctx context.Context, servers []string, aliases map[string]string) error {
	if len(servers) == 0 {
		return errors.New("bootstrap servers are required")
	}
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(servers...),
		kgo.DialTimeout(5*time.Second),
		kgo.Dialer(aliasDialer(aliases)),
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
