package profile

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

// TLSConfig holds optional SSL/TLS settings used when the cluster exposes an
// SSL listener. For 1-way SSL (server auth only, ssl.client.auth=none) just
// enable it and paste the CA certificate that signed the broker certs; the CA
// is the client's truststore. ClientCert/ClientKey are only needed for 2-way
// mTLS clusters (ssl.client.auth=required).
type TLSConfig struct {
	// Enabled turns on security.protocol=SSL for this cluster.
	Enabled bool `json:"enabled,omitempty"`
	// CACert is the PEM of the CA certificate that signed the broker certs
	// (the truststore). Empty means "use the OS trust store".
	CACert string `json:"caCert,omitempty"`
	// ClientCert / ClientKey are PEM material for 2-way mTLS. Leave empty for
	// 1-way SSL.
	ClientCert string `json:"clientCert,omitempty"`
	ClientKey  string `json:"clientKey,omitempty"`
	// InsecureSkipVerify disables certificate and hostname verification.
	// Escape hatch only — leaves the connection open to MITM.
	InsecureSkipVerify bool `json:"insecureSkipVerify,omitempty"`
	// ServerName overrides the hostname verified against the broker cert
	// (and the SNI sent). Normally left empty so the advertised hostname is
	// used, which matches the broker cert CN.
	ServerName string `json:"serverName,omitempty"`
	// Remote is the legacy single SSH target (kept so old profiles still load).
	// New profiles write Remotes instead.
	Remote *RemoteFetch `json:"remote,omitempty"`
	// Remotes holds SSH details per broker host, so a multi-broker cluster can
	// be browsed one host at a time with its own credentials.
	Remotes []RemoteFetch `json:"remotes,omitempty"`
}

// RemoteFetch holds SSH connection details used to browse/pull cert files from
// a remote host into the CA field. Persisted with the profile (plaintext
// password) at the user's request. Host identifies which broker these
// credentials belong to.
type RemoteFetch struct {
	Host     string `json:"host,omitempty"`
	Port     int    `json:"port,omitempty"`
	User     string `json:"user,omitempty"`
	Password string `json:"password,omitempty"`
	Dir      string `json:"dir,omitempty"`
}

// Profile represents a Kafka cluster connection profile.
type Profile struct {
	ID                string            `json:"id"`
	Name              string            `json:"name"`
	BootstrapServers  []string          `json:"bootstrapServers"`
	SchemaRegistryURL string            `json:"schemaRegistryUrl,omitempty"`
	DefaultTopic      string            `json:"defaultTopic,omitempty"`
	// HostAliases rewrites broker hostnames at the dial layer so users do not
	// need to add /etc/hosts entries. Keyed by the hostname the broker
	// advertises (e.g. "broker-2"), valued with the IP or alternate hostname
	// that the local machine can actually reach (e.g. "192.0.2.20").
	HostAliases map[string]string `json:"hostAliases,omitempty"`
	// TLS holds optional SSL settings. Nil / disabled means PLAINTEXT.
	TLS       *TLSConfig `json:"tls,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
}

type fileLayout struct {
	Version  int       `json:"version"`
	Profiles []Profile `json:"profiles"`
}

const fileVersion = 1

// Store persists profiles to ~/.kafka-client/profiles.json.
type Store struct {
	dir  string
	path string
	mu   sync.RWMutex
}

// New returns a Store using the given home directory.
func New(homeDir string) (*Store, error) {
	dir := filepath.Join(homeDir, ".kafka-client")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create config dir: %w", err)
	}
	return &Store{dir: dir, path: filepath.Join(dir, "profiles.json")}, nil
}

// Dir returns the config directory.
func (s *Store) Dir() string { return s.dir }

func (s *Store) loadLocked() (fileLayout, error) {
	var layout fileLayout
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return fileLayout{Version: fileVersion, Profiles: []Profile{}}, nil
	}
	if err != nil {
		return layout, err
	}
	if len(b) == 0 {
		return fileLayout{Version: fileVersion, Profiles: []Profile{}}, nil
	}
	if err := json.Unmarshal(b, &layout); err != nil {
		return layout, fmt.Errorf("parse profiles.json: %w", err)
	}
	if layout.Profiles == nil {
		layout.Profiles = []Profile{}
	}
	return layout, nil
}

func (s *Store) saveLocked(layout fileLayout) error {
	layout.Version = fileVersion
	b, err := json.MarshalIndent(layout, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// List returns all profiles, sorted by name.
func (s *Store) List() ([]Profile, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	layout, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	sort.Slice(layout.Profiles, func(i, j int) bool {
		return layout.Profiles[i].Name < layout.Profiles[j].Name
	})
	return layout.Profiles, nil
}

// Get returns a single profile by id.
func (s *Store) Get(id string) (Profile, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	layout, err := s.loadLocked()
	if err != nil {
		return Profile{}, err
	}
	for _, p := range layout.Profiles {
		if p.ID == id {
			return p, nil
		}
	}
	return Profile{}, fmt.Errorf("profile %s not found", id)
}

// Save creates or updates a profile. If p.ID is empty a new ID is assigned.
func (s *Store) Save(p Profile) (Profile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.Name == "" {
		return Profile{}, errors.New("name is required")
	}
	if len(p.BootstrapServers) == 0 {
		return Profile{}, errors.New("bootstrapServers is required")
	}
	layout, err := s.loadLocked()
	if err != nil {
		return Profile{}, err
	}
	now := time.Now()
	if p.ID == "" {
		p.ID = uuid.NewString()
		p.CreatedAt = now
		p.UpdatedAt = now
		layout.Profiles = append(layout.Profiles, p)
	} else {
		found := false
		for i, existing := range layout.Profiles {
			if existing.ID == p.ID {
				p.CreatedAt = existing.CreatedAt
				p.UpdatedAt = now
				layout.Profiles[i] = p
				found = true
				break
			}
		}
		if !found {
			return Profile{}, fmt.Errorf("profile %s not found", p.ID)
		}
	}
	if err := s.saveLocked(layout); err != nil {
		return Profile{}, err
	}
	return p, nil
}

// Delete removes a profile by id.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	layout, err := s.loadLocked()
	if err != nil {
		return err
	}
	out := layout.Profiles[:0]
	deleted := false
	for _, p := range layout.Profiles {
		if p.ID == id {
			deleted = true
			continue
		}
		out = append(out, p)
	}
	if !deleted {
		return fmt.Errorf("profile %s not found", id)
	}
	layout.Profiles = out
	return s.saveLocked(layout)
}

// Export returns the raw JSON for sharing.
func (s *Store) Export() ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	layout, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	return json.MarshalIndent(layout, "", "  ")
}

// Import merges profiles from JSON; existing ids are overwritten.
func (s *Store) Import(data []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var incoming fileLayout
	if err := json.Unmarshal(data, &incoming); err != nil {
		return 0, fmt.Errorf("invalid import payload: %w", err)
	}
	current, err := s.loadLocked()
	if err != nil {
		return 0, err
	}
	index := make(map[string]int, len(current.Profiles))
	for i, p := range current.Profiles {
		index[p.ID] = i
	}
	added := 0
	now := time.Now()
	for _, p := range incoming.Profiles {
		if p.Name == "" || len(p.BootstrapServers) == 0 {
			continue
		}
		if p.ID == "" {
			p.ID = uuid.NewString()
		}
		if p.CreatedAt.IsZero() {
			p.CreatedAt = now
		}
		p.UpdatedAt = now
		if idx, ok := index[p.ID]; ok {
			current.Profiles[idx] = p
		} else {
			current.Profiles = append(current.Profiles, p)
			index[p.ID] = len(current.Profiles) - 1
		}
		added++
	}
	if err := s.saveLocked(current); err != nil {
		return 0, err
	}
	return added, nil
}
