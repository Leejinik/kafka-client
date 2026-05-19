package kafka

import (
	"context"
	"fmt"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
)

// PartitionReassignment is the desired replica list for a single partition.
// The first broker in Replicas is the preferred leader.
type PartitionReassignment struct {
	Partition int32   `json:"partition"`
	Replicas  []int32 `json:"replicas"`
}

// ReassignmentProgress mirrors kadm.ListPartitionReassignmentsResponse.
// Replicas is the current (in-flight) replica list; AddingReplicas /
// RemovingReplicas reflect the delta the controller is materialising.
type ReassignmentProgress struct {
	Partition        int32   `json:"partition"`
	Replicas         []int32 `json:"replicas"`
	AddingReplicas   []int32 `json:"addingReplicas,omitempty"`
	RemovingReplicas []int32 `json:"removingReplicas,omitempty"`
}

// AlterPartitionAssignments submits a partition reassignment for the given
// topic. Only the partitions present in `changes` are touched; partitions not
// listed keep their current assignment.
func (m *Manager) AlterPartitionAssignments(ctx context.Context, profileID, topic string, changes []PartitionReassignment) error {
	if topic == "" {
		return fmt.Errorf("topic is required")
	}
	if len(changes) == 0 {
		return fmt.Errorf("no changes to apply")
	}
	for _, ch := range changes {
		if len(ch.Replicas) == 0 {
			return fmt.Errorf("partition %d: replicas must not be empty", ch.Partition)
		}
		seen := make(map[int32]struct{}, len(ch.Replicas))
		for _, r := range ch.Replicas {
			if _, dup := seen[r]; dup {
				return fmt.Errorf("partition %d: duplicate broker %d in replicas", ch.Partition, r)
			}
			seen[r] = struct{}{}
		}
	}
	c, err := m.Get(profileID)
	if err != nil {
		return err
	}

	req := make(kadm.AlterPartitionAssignmentsReq)
	for _, ch := range changes {
		req.Assign(topic, ch.Partition, append([]int32(nil), ch.Replicas...))
	}

	reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	resp, err := c.adm.AlterPartitionAssignments(reqCtx, req)
	if err != nil {
		return fmt.Errorf("alter partition assignments: %w", err)
	}
	if err := resp.Error(); err != nil {
		return err
	}
	return nil
}

// ListPartitionReassignments returns currently in-flight reassignments for
// every partition of the topic. Partitions with no active reassignment have
// empty AddingReplicas / RemovingReplicas slices and are omitted from the
// returned slice (Kafka only echoes partitions with active work).
func (m *Manager) ListPartitionReassignments(ctx context.Context, profileID, topic string) ([]ReassignmentProgress, error) {
	if topic == "" {
		return nil, fmt.Errorf("topic is required")
	}
	c, err := m.Get(profileID)
	if err != nil {
		return nil, err
	}

	// We need to know the partition count to ask about them all.
	mdCtx, mdCancel := context.WithTimeout(ctx, 10*time.Second)
	defer mdCancel()
	topics, err := c.adm.ListTopics(mdCtx, topic)
	if err != nil {
		return nil, fmt.Errorf("list topic: %w", err)
	}
	td, ok := topics[topic]
	if !ok {
		return nil, fmt.Errorf("topic %s not found", topic)
	}
	if td.Err != nil {
		return nil, fmt.Errorf("topic %s: %w", topic, td.Err)
	}
	if len(td.Partitions) == 0 {
		return nil, nil
	}

	var set kadm.TopicsSet
	ps := make([]int32, 0, len(td.Partitions))
	for pid := range td.Partitions {
		ps = append(ps, pid)
	}
	set.Add(topic, ps...)

	listCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	resp, err := c.adm.ListPartitionReassignments(listCtx, set)
	if err != nil {
		return nil, fmt.Errorf("list partition reassignments: %w", err)
	}

	out := make([]ReassignmentProgress, 0, 4)
	for _, r := range resp.Sorted() {
		if len(r.AddingReplicas) == 0 && len(r.RemovingReplicas) == 0 {
			continue
		}
		out = append(out, ReassignmentProgress{
			Partition:        r.Partition,
			Replicas:         append([]int32(nil), r.Replicas...),
			AddingReplicas:   append([]int32(nil), r.AddingReplicas...),
			RemovingReplicas: append([]int32(nil), r.RemovingReplicas...),
		})
	}
	return out, nil
}
