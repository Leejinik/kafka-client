package kafka

import (
	"context"
	"fmt"
	"sort"
	"time"
)

// TopicSummary is used in the topic list view.
type TopicSummary struct {
	Name              string `json:"name"`
	Partitions        int    `json:"partitions"`
	ReplicationFactor int    `json:"replicationFactor"`
	Internal          bool   `json:"internal"`
}

// BrokerInfo describes a broker in the cluster.
type BrokerInfo struct {
	NodeID int32  `json:"nodeId"`
	Host   string `json:"host"`
	Port   int32  `json:"port"`
	Rack   string `json:"rack,omitempty"`
}

// PartitionDetail is per-partition replication state.
type PartitionDetail struct {
	Partition       int32   `json:"partition"`
	Leader          int32   `json:"leader"`
	Replicas        []int32 `json:"replicas"`
	ISR             []int32 `json:"isr"`
	OfflineReplicas []int32 `json:"offlineReplicas,omitempty"`
	LeaderEpoch     int32   `json:"leaderEpoch"`
}

// ClusterInfo is cluster-wide metadata used in the top bar.
type ClusterInfo struct {
	ClusterID  string       `json:"clusterId"`
	Controller int32        `json:"controller"`
	Brokers    []BrokerInfo `json:"brokers"`
}

// ListTopics returns topic summaries.
func (m *Manager) ListTopics(ctx context.Context, profileID string) ([]TopicSummary, error) {
	c, err := m.Get(profileID)
	if err != nil {
		return nil, err
	}
	listCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	topics, err := c.adm.ListTopicsWithInternal(listCtx)
	if err != nil {
		return nil, fmt.Errorf("list topics: %w", err)
	}
	out := make([]TopicSummary, 0, len(topics))
	for name, t := range topics {
		if t.Err != nil {
			continue
		}
		replication := 0
		if len(t.Partitions) > 0 {
			for _, p := range t.Partitions {
				replication = len(p.Replicas)
				break
			}
		}
		out = append(out, TopicSummary{
			Name:              name,
			Partitions:        len(t.Partitions),
			ReplicationFactor: replication,
			Internal:          t.IsInternal,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// GetTopicPartitions returns per-partition replication details for a topic.
func (m *Manager) GetTopicPartitions(ctx context.Context, profileID, topic string) ([]PartitionDetail, error) {
	c, err := m.Get(profileID)
	if err != nil {
		return nil, err
	}
	mdCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	topics, err := c.adm.ListTopics(mdCtx, topic)
	if err != nil {
		return nil, fmt.Errorf("list topic: %w", err)
	}
	td, ok := topics[topic]
	if !ok || td.Err != nil {
		if ok && td.Err != nil {
			return nil, fmt.Errorf("topic %s: %w", topic, td.Err)
		}
		return nil, fmt.Errorf("topic %s not found", topic)
	}
	out := make([]PartitionDetail, 0, len(td.Partitions))
	for pid, pd := range td.Partitions {
		out = append(out, PartitionDetail{
			Partition:       pid,
			Leader:          pd.Leader,
			Replicas:        append([]int32(nil), pd.Replicas...),
			ISR:             append([]int32(nil), pd.ISR...),
			OfflineReplicas: append([]int32(nil), pd.OfflineReplicas...),
			LeaderEpoch:     pd.LeaderEpoch,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Partition < out[j].Partition })
	return out, nil
}

// GetClusterInfo returns the controller broker, cluster ID, and broker list.
func (m *Manager) GetClusterInfo(ctx context.Context, profileID string) (ClusterInfo, error) {
	c, err := m.Get(profileID)
	if err != nil {
		return ClusterInfo{}, err
	}
	mdCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	md, err := c.adm.Metadata(mdCtx)
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
		info.Brokers = append(info.Brokers, BrokerInfo{
			NodeID: b.NodeID,
			Host:   b.Host,
			Port:   b.Port,
			Rack:   rack,
		})
	}
	sort.Slice(info.Brokers, func(i, j int) bool { return info.Brokers[i].NodeID < info.Brokers[j].NodeID })
	return info, nil
}

// ListBrokers returns the broker list from cluster metadata.
func (m *Manager) ListBrokers(ctx context.Context, profileID string) ([]BrokerInfo, error) {
	c, err := m.Get(profileID)
	if err != nil {
		return nil, err
	}
	listCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	brokers, err := c.adm.ListBrokers(listCtx)
	if err != nil {
		return nil, fmt.Errorf("list brokers: %w", err)
	}
	out := make([]BrokerInfo, 0, len(brokers))
	for _, b := range brokers {
		rack := ""
		if b.Rack != nil {
			rack = *b.Rack
		}
		out = append(out, BrokerInfo{
			NodeID: b.NodeID,
			Host:   b.Host,
			Port:   b.Port,
			Rack:   rack,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].NodeID < out[j].NodeID })
	return out, nil
}
