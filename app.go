package main

import (
	"context"
	"fmt"
	"os"

	"kafka-client/internal/kafka"
	"kafka-client/internal/profile"
)

// App is the root struct bound to the Wails runtime. Every exported method
// becomes callable from the React frontend.
type App struct {
	ctx      context.Context
	profiles *profile.Store
	manager  *kafka.Manager
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
		profiles: store,
		manager:  kafka.NewManager(),
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
	return a.manager.Consume(a.ctx, profileID, opts)
}

func (a *App) Produce(profileID string, req kafka.ProduceRequest) (kafka.ProduceResult, error) {
	return a.manager.Produce(a.ctx, profileID, req)
}
