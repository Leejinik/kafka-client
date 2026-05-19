package kafka

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kmsg"
)

// GroupView is one consumer group's involvement with a single topic.
type GroupView struct {
	GroupID      string             `json:"groupId"`
	State        string             `json:"state"`         // Stable, Empty, Dead, ...
	ProtocolType string             `json:"protocolType"`  // consumer | connect | ...
	Protocol     string             `json:"protocol"`      // range | roundrobin | sticky | ...
	Coordinator  int32              `json:"coordinator"`
	Members      []GroupMemberView  `json:"members"`
	Partitions   []GroupPartitionLag `json:"partitions"`
	TotalLag     int64              `json:"totalLag"`
}

// GroupMemberView lists an individual member's assignment for the topic in question.
type GroupMemberView struct {
	MemberID   string  `json:"memberId"`
	ClientID   string  `json:"clientId"`
	ClientHost string  `json:"clientHost"`
	InstanceID string  `json:"instanceId,omitempty"`
	Partitions []int32 `json:"partitions"` // assigned partitions of THIS topic
}

// GroupPartitionLag is the per-partition lag triplet for one topic.
type GroupPartitionLag struct {
	Partition       int32  `json:"partition"`
	CommittedOffset int64  `json:"committedOffset"` // -1 if unknown
	EndOffset       int64  `json:"endOffset"`       // -1 if unknown
	Lag             int64  `json:"lag"`             // -1 on error
	MemberID        string `json:"memberId,omitempty"`
	ClientID        string `json:"clientId,omitempty"`
	Err             string `json:"err,omitempty"`
}

// ListGroupsForTopic finds every consumer group that has a committed offset
// for the given topic, and returns each group's members + per-partition lag
// for that topic only.
func (m *Manager) ListGroupsForTopic(ctx context.Context, profileID, topic string) ([]GroupView, error) {
	if topic == "" {
		return nil, fmt.Errorf("topic is required")
	}
	c, err := m.Get(profileID)
	if err != nil {
		return nil, err
	}

	listCtx, listCancel := context.WithTimeout(ctx, 15*time.Second)
	defer listCancel()
	listed, err := c.adm.ListGroups(listCtx)
	if err != nil {
		return nil, fmt.Errorf("list groups: %w", err)
	}

	groupIDs := make([]string, 0, len(listed))
	for gid := range listed {
		groupIDs = append(groupIDs, gid)
	}
	if len(groupIDs) == 0 {
		return []GroupView{}, nil
	}

	lagCtx, lagCancel := context.WithTimeout(ctx, 30*time.Second)
	defer lagCancel()
	lags, err := c.adm.Lag(lagCtx, groupIDs...)
	if err != nil {
		return nil, fmt.Errorf("group lag: %w", err)
	}

	out := make([]GroupView, 0)
	for _, gid := range groupIDs {
		dl, ok := lags[gid]
		if !ok {
			continue
		}
		topicLag, hasTopic := dl.Lag[topic]
		if !hasTopic || len(topicLag) == 0 {
			continue // group does not consume this topic
		}

		view := GroupView{
			GroupID:      dl.Group,
			State:        dl.State,
			ProtocolType: dl.ProtocolType,
			Protocol:     dl.Protocol,
			Coordinator:  dl.Coordinator.NodeID,
		}

		// Per-partition lag rows.
		parts := make([]GroupPartitionLag, 0, len(topicLag))
		for pid, pl := range topicLag {
			row := GroupPartitionLag{
				Partition:       pid,
				CommittedOffset: pl.Commit.At,
				EndOffset:       pl.End.Offset,
				Lag:             pl.Lag,
			}
			if pl.Err != nil {
				row.Err = pl.Err.Error()
			}
			if pl.Member != nil {
				row.MemberID = pl.Member.MemberID
				row.ClientID = pl.Member.ClientID
			}
			parts = append(parts, row)
			if pl.Lag > 0 {
				view.TotalLag += pl.Lag
			}
		}
		sort.Slice(parts, func(i, j int) bool { return parts[i].Partition < parts[j].Partition })
		view.Partitions = parts

		// Members assigned to this topic.
		seen := make(map[string]int)
		for _, mem := range dl.Members {
			assigned := assignedPartitionsFor(mem, topic)
			if len(assigned) == 0 {
				continue
			}
			id := mem.MemberID
			if idx, ok := seen[id]; ok {
				// merge (shouldn't normally happen)
				view.Members[idx].Partitions = append(view.Members[idx].Partitions, assigned...)
				continue
			}
			mv := GroupMemberView{
				MemberID:   mem.MemberID,
				ClientID:   mem.ClientID,
				ClientHost: mem.ClientHost,
				Partitions: assigned,
			}
			if mem.InstanceID != nil {
				mv.InstanceID = *mem.InstanceID
			}
			seen[id] = len(view.Members)
			view.Members = append(view.Members, mv)
		}
		sort.Slice(view.Members, func(i, j int) bool {
			return view.Members[i].MemberID < view.Members[j].MemberID
		})
		for i := range view.Members {
			ps := view.Members[i].Partitions
			sort.Slice(ps, func(a, b int) bool { return ps[a] < ps[b] })
		}

		out = append(out, view)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].GroupID < out[j].GroupID })
	return out, nil
}

// assignedPartitionsFor extracts the partition list a member is consuming for
// the given topic, decoded from the consumer protocol assignment payload.
func assignedPartitionsFor(mem kadm.DescribedGroupMember, topic string) []int32 {
	asn, ok := mem.Assigned.AsConsumer()
	if !ok || asn == nil {
		return nil
	}
	for _, t := range asn.Topics {
		if t.Topic == topic {
			out := make([]int32, 0, len(t.Partitions))
			out = append(out, t.Partitions...)
			return out
		}
	}
	return nil
}

// guard against unused import warnings if kmsg is only referenced via kadm.
var _ = kmsg.NewConsumerMemberAssignment
