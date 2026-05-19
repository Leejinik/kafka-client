package kafka

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
)

// TopicConfigEntry represents a single topic-level configuration value.
type TopicConfigEntry struct {
	Key       string `json:"key"`
	Value     string `json:"value"`
	Source    string `json:"source"` // DYNAMIC_TOPIC_CONFIG, DEFAULT_CONFIG, ...
	Sensitive bool   `json:"sensitive"`
	ReadOnly  bool   `json:"readOnly"`
}

// TopicDescribe is the full per-topic detail used by the Edit dialog.
type TopicDescribe struct {
	Name              string             `json:"name"`
	Partitions        int                `json:"partitions"`
	ReplicationFactor int                `json:"replicationFactor"`
	Configs           []TopicConfigEntry `json:"configs"`
}

// DescribeTopic returns partition info + every topic-level config.
func (m *Manager) DescribeTopic(ctx context.Context, profileID, topic string) (TopicDescribe, error) {
	c, err := m.Get(profileID)
	if err != nil {
		return TopicDescribe{}, err
	}
	mdCtx, mdCancel := context.WithTimeout(ctx, 10*time.Second)
	defer mdCancel()
	topics, err := c.adm.ListTopics(mdCtx, topic)
	if err != nil {
		return TopicDescribe{}, fmt.Errorf("list topic: %w", err)
	}
	td, ok := topics[topic]
	if !ok || td.Err != nil {
		if ok && td.Err != nil {
			return TopicDescribe{}, fmt.Errorf("topic %s: %w", topic, td.Err)
		}
		return TopicDescribe{}, fmt.Errorf("topic %s not found", topic)
	}
	rep := 0
	for _, p := range td.Partitions {
		rep = len(p.Replicas)
		break
	}

	cfgCtx, cfgCancel := context.WithTimeout(ctx, 10*time.Second)
	defer cfgCancel()
	rcs, err := c.adm.DescribeTopicConfigs(cfgCtx, topic)
	if err != nil {
		return TopicDescribe{}, fmt.Errorf("describe configs: %w", err)
	}
	var configs []TopicConfigEntry
	for _, rc := range rcs {
		if rc.Name != topic {
			continue
		}
		if rc.Err != nil {
			return TopicDescribe{}, fmt.Errorf("describe configs for %s: %w", topic, rc.Err)
		}
		for _, cfg := range rc.Configs {
			val := ""
			if cfg.Value != nil {
				val = *cfg.Value
			}
			configs = append(configs, TopicConfigEntry{
				Key:       cfg.Key,
				Value:     val,
				Source:    cfg.Source.String(),
				Sensitive: cfg.Sensitive,
				ReadOnly:  false,
			})
		}
	}
	// Surface dynamic (explicit) configs first, then defaults; alpha within each.
	sort.SliceStable(configs, func(i, j int) bool {
		pi := sourceRank(configs[i].Source)
		pj := sourceRank(configs[j].Source)
		if pi != pj {
			return pi < pj
		}
		return configs[i].Key < configs[j].Key
	})

	return TopicDescribe{
		Name:              topic,
		Partitions:        len(td.Partitions),
		ReplicationFactor: rep,
		Configs:           configs,
	}, nil
}

func sourceRank(s string) int {
	switch s {
	case "DYNAMIC_TOPIC_CONFIG":
		return 0
	case "DYNAMIC_BROKER_CONFIG", "DYNAMIC_DEFAULT_BROKER_CONFIG":
		return 1
	case "STATIC_BROKER_CONFIG":
		return 2
	case "DEFAULT_CONFIG":
		return 3
	default:
		return 4
	}
}

// CreateTopic creates a topic with the given configuration.
func (m *Manager) CreateTopic(ctx context.Context, profileID, name string, partitions int32, replicationFactor int16, configs map[string]string) error {
	if name == "" {
		return fmt.Errorf("name is required")
	}
	if partitions <= 0 {
		return fmt.Errorf("partitions must be > 0")
	}
	if replicationFactor <= 0 {
		return fmt.Errorf("replicationFactor must be > 0")
	}
	c, err := m.Get(profileID)
	if err != nil {
		return err
	}
	cfgs := make(map[string]*string, len(configs))
	for k, v := range configs {
		v := v
		cfgs[k] = &v
	}
	createCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	resp, err := c.adm.CreateTopic(createCtx, partitions, replicationFactor, cfgs, name)
	if err != nil {
		return err
	}
	if resp.Err != nil {
		return resp.Err
	}
	return nil
}

// DeleteTopic deletes a topic. **All data is lost** — caller must confirm.
func (m *Manager) DeleteTopic(ctx context.Context, profileID, topic string) error {
	if topic == "" {
		return fmt.Errorf("topic is required")
	}
	c, err := m.Get(profileID)
	if err != nil {
		return err
	}
	delCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	resp, err := c.adm.DeleteTopics(delCtx, topic)
	if err != nil {
		return err
	}
	for _, r := range resp {
		if r.Err != nil {
			return r.Err
		}
	}
	return nil
}

// UpdateTopicPartitions increases the partition count of a topic. Kafka does
// not allow decreasing partition count.
func (m *Manager) UpdateTopicPartitions(ctx context.Context, profileID, topic string, partitions int) error {
	if topic == "" {
		return fmt.Errorf("topic is required")
	}
	if partitions <= 0 {
		return fmt.Errorf("partitions must be > 0")
	}
	c, err := m.Get(profileID)
	if err != nil {
		return err
	}
	updCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	resp, err := c.adm.UpdatePartitions(updCtx, partitions, topic)
	if err != nil {
		return err
	}
	for _, r := range resp {
		if r.Err != nil {
			return r.Err
		}
	}
	return nil
}

// AlterTopicConfigs incrementally applies the given key/value pairs.
// Empty value means delete (revert to default).
func (m *Manager) AlterTopicConfigs(ctx context.Context, profileID, topic string, configs map[string]string, deletes []string) error {
	if topic == "" {
		return fmt.Errorf("topic is required")
	}
	c, err := m.Get(profileID)
	if err != nil {
		return err
	}
	alters := make([]kadm.AlterConfig, 0, len(configs)+len(deletes))
	for k, v := range configs {
		v := v
		alters = append(alters, kadm.AlterConfig{
			Op:    kadm.SetConfig,
			Name:  k,
			Value: &v,
		})
	}
	for _, k := range deletes {
		alters = append(alters, kadm.AlterConfig{
			Op:   kadm.DeleteConfig,
			Name: k,
		})
	}
	if len(alters) == 0 {
		return nil
	}
	alterCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	resp, err := c.adm.AlterTopicConfigs(alterCtx, alters, topic)
	if err != nil {
		return err
	}
	for _, r := range resp {
		if r.Err != nil {
			return r.Err
		}
	}
	return nil
}
