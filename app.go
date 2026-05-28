package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"

	"kafka-client/internal/kafka"
	"kafka-client/internal/profile"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the root struct bound to the Wails runtime. Every exported method
// becomes callable from the React frontend.
type App struct {
	ctx      context.Context
	profiles *profile.Store
	manager  *kafka.Manager

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

// TestConnection probes the given seed brokers, optionally rewriting
// advertised hostnames via the supplied alias map.
func (a *App) TestConnection(servers []string, hostAliases map[string]string) error {
	return a.manager.Test(a.ctx, servers, hostAliases)
}

func (a *App) Connect(profileID string) error {
	p, err := a.profiles.Get(profileID)
	if err != nil {
		return err
	}
	return a.manager.Connect(a.ctx, profileID, p.BootstrapServers, p.HostAliases)
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
