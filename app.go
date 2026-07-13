package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"

	"kafka-client/internal/certutil"
	"kafka-client/internal/kafka"
	"kafka-client/internal/profile"
	"kafka-client/internal/remotefetch"
	"kafka-client/internal/updater"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the root struct bound to the Wails runtime. Every exported method
// becomes callable from the React frontend.
type App struct {
	ctx      context.Context
	profiles *profile.Store
	manager  *kafka.Manager
	updater  *updater.Updater

	// version is set from main() after NewApp(); the updater is built lazily on
	// startup once we know the value.
	version string

	// In-flight Consume() cancel functions, keyed by profileID. The UI is
	// single-fetch per profile so we keep at most one entry per id.
	consumeMu     sync.Mutex
	consumeCancel map[string]context.CancelFunc
}

// NewApp wires up the dependencies.
func NewApp() *App {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	store, err := profile.New(home)
	if err != nil {
		// surfaced via logs; methods will return errors on save attempts.
		fmt.Println("profile store init failed:", err)
	}
	return &App{
		profiles:      store,
		manager:       kafka.NewManager(),
		consumeCancel: map[string]context.CancelFunc{},
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	if a.version == "" {
		a.version = "dev"
	}
	configDir := ""
	if a.profiles != nil {
		configDir = a.profiles.Dir()
	}
	a.updater = updater.New(updater.Config{
		Owner:          "Leejinik",
		Repo:           "kafka-client",
		AssetName:      "kafka-client.exe",
		CurrentVersion: a.version,
		ConfigDir:      configDir,
	})
	// Sweep any swap leftovers (e.g. <exe>.old parked by the in-place update).
	if exe, err := os.Executable(); err == nil {
		a.updater.CleanupLeftovers(exe)
	}
}

func (a *App) shutdown(ctx context.Context) {
	if a.manager != nil {
		a.manager.CloseAll()
	}
}

// --- Profile management -------------------------------------------------

func (a *App) ListProfiles() ([]profile.Profile, error) {
	return a.profiles.List()
}

func (a *App) SaveProfile(p profile.Profile) (profile.Profile, error) {
	saved, err := a.profiles.Save(p)
	if err != nil {
		return saved, err
	}
	// Drop any existing connection for this profile so the next Connect
	// picks up the updated bootstrap servers / host aliases.
	if saved.ID != "" {
		a.manager.Disconnect(saved.ID)
	}
	return saved, nil
}

func (a *App) DeleteProfile(id string) error {
	a.manager.Disconnect(id)
	return a.profiles.Delete(id)
}

func (a *App) ExportProfiles() (string, error) {
	b, err := a.profiles.Export()
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func (a *App) ImportProfiles(jsonText string) (int, error) {
	return a.profiles.Import([]byte(jsonText))
}

func (a *App) ConfigDir() string {
	if a.profiles == nil {
		return ""
	}
	return a.profiles.Dir()
}

// --- Connection ---------------------------------------------------------

// toKafkaTLS maps a stored profile TLS config to the kafka package's transient
// TLS options. Returns nil (PLAINTEXT) when TLS is absent or disabled.
func toKafkaTLS(t *profile.TLSConfig) *kafka.TLSOptions {
	if t == nil || !t.Enabled {
		return nil
	}
	return &kafka.TLSOptions{
		Enabled:            true,
		CACertPEM:          t.CACert,
		ClientCertPEM:      t.ClientCert,
		ClientKeyPEM:       t.ClientKey,
		InsecureSkipVerify: t.InsecureSkipVerify,
		ServerName:         t.ServerName,
	}
}

// RemoteListDir lists a directory on a remote host over SSH (dirs + files),
// powering the FTP-style cert browser in the SSL dialog.
func (a *App) RemoteListDir(host string, port int, user, password, dir string) ([]remotefetch.Entry, error) {
	return remotefetch.ListDir(a.ctx, host, port, user, password, dir)
}

// RemoteReadFile reads a single remote file over SSH and returns its contents
// (used to pull the selected certificate into the dialog).
func (a *App) RemoteReadFile(host string, port int, user, password, path string) (string, error) {
	return remotefetch.ReadFile(a.ctx, host, port, user, password, path)
}

// ParseCert summarizes a PEM certificate (CN/SAN, CA-or-leaf) so the dialog can
// auto-fill the broker hostname and show whether it will be used as a CA
// (truststore) or pinned (broker cert trusted directly).
func (a *App) ParseCert(pemText string) (certutil.Info, error) {
	return certutil.Parse(pemText)
}

// TestConnection probes the given seed brokers, optionally rewriting
// advertised hostnames via the supplied alias map and using the given TLS
// settings (nil / disabled = PLAINTEXT).
func (a *App) TestConnection(servers []string, hostAliases map[string]string, tls *profile.TLSConfig) error {
	return a.manager.Test(a.ctx, servers, hostAliases, toKafkaTLS(tls))
}

// TestConnectionInfo probes the brokers like TestConnection but returns the
// discovered cluster metadata (controller + broker list) so the dialog can
// confirm what it connected to.
func (a *App) TestConnectionInfo(servers []string, hostAliases map[string]string, tls *profile.TLSConfig) (kafka.ClusterInfo, error) {
	return a.manager.TestInfo(a.ctx, servers, hostAliases, toKafkaTLS(tls))
}

func (a *App) Connect(profileID string) error {
	p, err := a.profiles.Get(profileID)
	if err != nil {
		return err
	}
	return a.manager.Connect(a.ctx, profileID, p.BootstrapServers, p.HostAliases, toKafkaTLS(p.TLS))
}

func (a *App) Disconnect(profileID string) {
	a.manager.Disconnect(profileID)
}

func (a *App) IsConnected(profileID string) bool {
	return a.manager.IsConnected(profileID)
}

// --- Admin --------------------------------------------------------------

func (a *App) ListTopics(profileID string) ([]kafka.TopicSummary, error) {
	return a.manager.ListTopics(a.ctx, profileID)
}

func (a *App) ListBrokers(profileID string) ([]kafka.BrokerInfo, error) {
	return a.manager.ListBrokers(a.ctx, profileID)
}

func (a *App) GetTopicPartitions(profileID, topic string) ([]kafka.PartitionDetail, error) {
	return a.manager.GetTopicPartitions(a.ctx, profileID, topic)
}

func (a *App) GetClusterInfo(profileID string) (kafka.ClusterInfo, error) {
	return a.manager.GetClusterInfo(a.ctx, profileID)
}

func (a *App) ListGroupsForTopic(profileID, topic string) ([]kafka.GroupView, error) {
	return a.manager.ListGroupsForTopic(a.ctx, profileID, topic)
}

func (a *App) MessageRates(profileID string, topics []string, lookbackMs int64) ([]kafka.MessageRate, error) {
	return a.manager.MessageRates(a.ctx, profileID, topics, lookbackMs)
}

// --- Topic admin --------------------------------------------------------

func (a *App) DescribeTopic(profileID, topic string) (kafka.TopicDescribe, error) {
	return a.manager.DescribeTopic(a.ctx, profileID, topic)
}

func (a *App) CreateTopic(profileID, name string, partitions int, replicationFactor int, configs map[string]string) error {
	return a.manager.CreateTopic(a.ctx, profileID, name, int32(partitions), int16(replicationFactor), configs)
}

func (a *App) DeleteTopic(profileID, topic string) error {
	return a.manager.DeleteTopic(a.ctx, profileID, topic)
}

func (a *App) UpdateTopicPartitions(profileID, topic string, partitions int) error {
	return a.manager.UpdateTopicPartitions(a.ctx, profileID, topic, partitions)
}

func (a *App) AlterTopicConfigs(profileID, topic string, configs map[string]string, deletes []string) error {
	return a.manager.AlterTopicConfigs(a.ctx, profileID, topic, configs, deletes)
}

func (a *App) ReassignPartitions(profileID, topic string, changes []kafka.PartitionReassignment) error {
	return a.manager.AlterPartitionAssignments(a.ctx, profileID, topic, changes)
}

func (a *App) ListPartitionReassignments(profileID, topic string) ([]kafka.ReassignmentProgress, error) {
	return a.manager.ListPartitionReassignments(a.ctx, profileID, topic)
}

// ElectPreferredLeader runs a preferred-leader election for the given
// partitions (all partitions of the topic when the list is empty), making each
// partition's preferred replica (replica[0]) the live leader.
func (a *App) ElectPreferredLeader(profileID, topic string, partitions []int32) ([]kafka.LeaderElectionResult, error) {
	return a.manager.ElectPreferredLeaders(a.ctx, profileID, topic, partitions)
}

// --- Consumer-group admin -----------------------------------------------

func (a *App) DeleteGroup(profileID, group string) error {
	return a.manager.DeleteGroup(a.ctx, profileID, group)
}

func (a *App) ResetGroupOffsetsForTopic(
	profileID, group, topic, mode string,
	timestampMs int64,
	explicit []kafka.ExplicitOffset,
) error {
	return a.manager.ResetGroupOffsetsForTopic(a.ctx, profileID, group, topic, mode, timestampMs, explicit)
}

// --- Consume / Produce --------------------------------------------------

func (a *App) Consume(profileID string, opts kafka.ConsumeOptions) ([]kafka.Message, error) {
	ctx, cancel := context.WithCancel(a.ctx)
	a.consumeMu.Lock()
	// If somehow an older Consume is still registered for this profile,
	// cancel it before installing our own — the UI shouldn't allow this,
	// but it costs nothing to be defensive.
	if prev, ok := a.consumeCancel[profileID]; ok && prev != nil {
		prev()
	}
	a.consumeCancel[profileID] = cancel
	a.consumeMu.Unlock()
	defer func() {
		a.consumeMu.Lock()
		delete(a.consumeCancel, profileID)
		a.consumeMu.Unlock()
		cancel()
	}()
	return a.manager.Consume(ctx, profileID, opts)
}

// ConsumeRange fetches one page of records whose timestamps fall in
// [StartMs, EndMs]. The returned page includes a Cursor; pass it back as
// opts.Cursor on the next call to retrieve the following page. Uses the
// same cancel slot as Consume so CancelConsume() aborts an in-flight page.
func (a *App) ConsumeRange(profileID string, opts kafka.ConsumeRangeOptions) (kafka.ConsumeRangePage, error) {
	ctx, cancel := context.WithCancel(a.ctx)
	a.consumeMu.Lock()
	if prev, ok := a.consumeCancel[profileID]; ok && prev != nil {
		prev()
	}
	a.consumeCancel[profileID] = cancel
	a.consumeMu.Unlock()
	defer func() {
		a.consumeMu.Lock()
		delete(a.consumeCancel, profileID)
		a.consumeMu.Unlock()
		cancel()
	}()
	return a.manager.ConsumeRange(ctx, profileID, opts)
}

// CancelConsume cancels an in-flight Consume() for the given profile. Returns
// whatever has been collected so far via the original Consume call (the
// manager honours ctx cancellation by returning partial results). The same
// cancel slot is shared with StartTailConsume so this also stops a tail.
func (a *App) CancelConsume(profileID string) {
	a.consumeMu.Lock()
	cancel := a.consumeCancel[profileID]
	a.consumeMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// StartTailConsume kicks off a continuous "tail -f" consume against `topic`
// for the given profile. Records are streamed to the frontend via the
// event "consume.tail.batch:<profileID>" (payload: []kafka.Message).
// On natural termination or cancel, "consume.tail.stopped:<profileID>" fires
// (payload: optional error string, empty on clean stop).
//
// CancelConsume(profileID) stops the tail.
func (a *App) StartTailConsume(profileID, topic string) error {
	if topic == "" {
		return errors.New("topic is required")
	}
	ctx, cancel := context.WithCancel(a.ctx)
	a.consumeMu.Lock()
	if prev := a.consumeCancel[profileID]; prev != nil {
		prev()
	}
	a.consumeCancel[profileID] = cancel
	a.consumeMu.Unlock()

	go func() {
		defer func() {
			a.consumeMu.Lock()
			delete(a.consumeCancel, profileID)
			a.consumeMu.Unlock()
			cancel()
		}()
		err := a.manager.TailConsume(ctx, profileID, topic, func(batch []kafka.Message) {
			wailsruntime.EventsEmit(a.ctx, "consume.tail.batch:"+profileID, batch)
		})
		errMsg := ""
		if err != nil && !errors.Is(err, context.Canceled) {
			errMsg = err.Error()
		}
		wailsruntime.EventsEmit(a.ctx, "consume.tail.stopped:"+profileID, errMsg)
	}()
	return nil
}

func (a *App) Produce(profileID string, req kafka.ProduceRequest) (kafka.ProduceResult, error) {
	return a.manager.Produce(a.ctx, profileID, req)
}

// --- Loop produce -------------------------------------------------------

func (a *App) StartLoopProduce(profileID string, opts kafka.LoopProduceOptions) error {
	return a.manager.StartLoopProduce(a.ctx, profileID, opts)
}

func (a *App) StopLoopProduce(profileID string) {
	a.manager.StopLoopProduce(profileID)
}

func (a *App) GetLoopProduceStatus(profileID string) kafka.LoopProduceStatus {
	return a.manager.GetLoopProduceStatus(profileID)
}

// --- Auto-update --------------------------------------------------------

// GetCurrentVersion returns the build-time version (or "dev" for local builds).
func (a *App) GetCurrentVersion() string {
	if a.updater == nil {
		return a.version
	}
	return a.updater.CurrentVersion()
}

// CheckForUpdate queries GitHub Releases for a newer build.
func (a *App) CheckForUpdate() (updater.UpdateInfo, error) {
	if a.updater == nil {
		return updater.UpdateInfo{CurrentVersion: a.version}, nil
	}
	return a.updater.Check(a.ctx)
}

// ApplyUpdate downloads the new exe, stashes the release notes, spawns the
// swap helper, and quits the app — the helper finishes the swap and re-opens
// the (new) binary, which will then show the release notes once on startup.
func (a *App) ApplyUpdate(info updater.UpdateInfo) error {
	if a.updater == nil {
		return errors.New("updater not initialised")
	}
	if err := a.updater.Apply(a.ctx, info); err != nil {
		return err
	}
	// Hand off to the helper. Quit in a goroutine so this call can return
	// cleanly to the frontend before the runtime shuts down.
	go func() {
		// Give the frontend a beat to dismiss its dialog.
		wailsruntime.Quit(a.ctx)
	}()
	return nil
}

// AutoUpdate is the GUARDED silent startup path. It checks for a newer build
// and, if one is available AND the loop guard green-lights it, applies it and
// quits so the swapped-in binary relaunches. If the guard trips (5 attempts at
// the same target without the running version converging), it returns
// Blocked=true so the frontend can show a manual-update badge instead of
// looping forever.
func (a *App) AutoUpdate() updater.AutoUpdateResult {
	if a.updater == nil {
		return updater.AutoUpdateResult{}
	}
	info, err := a.updater.Check(a.ctx)
	if err != nil || !info.Available {
		return updater.AutoUpdateResult{Info: info}
	}
	if !a.updater.ShouldAutoApply(info) {
		return updater.AutoUpdateResult{Blocked: true, Info: info}
	}
	if err := a.updater.Apply(a.ctx, info); err != nil {
		return updater.AutoUpdateResult{Blocked: true, Info: info}
	}
	go wailsruntime.Quit(a.ctx)
	return updater.AutoUpdateResult{Applying: true, Info: info}
}

// GetPendingReleaseNotes returns release notes stashed by the previous
// version right before it triggered the update, iff they belong to the
// current binary version. Returns nil when there's nothing to show. Used to
// pop release notes exactly once after an auto-update.
func (a *App) GetPendingReleaseNotes() *updater.PendingNotes {
	if a.updater == nil {
		return nil
	}
	notes, ok, _ := a.updater.LoadPendingNotes()
	if !ok {
		return nil
	}
	return &notes
}

// MarkReleaseNotesSeen deletes the stashed notes file so it won't pop again.
func (a *App) MarkReleaseNotesSeen() error {
	if a.updater == nil {
		return nil
	}
	return a.updater.ClearPendingNotes()
}
