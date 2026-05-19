package kafka

import (
	"context"
	"fmt"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
)

// ExplicitOffset is a single (partition → offset) override used by the
// "explicit" reset mode.
type ExplicitOffset struct {
	Partition int32 `json:"partition"`
	Offset    int64 `json:"offset"`
}

// DeleteGroup removes a consumer group. Kafka only allows this when the group
// is empty (no live members). Active groups will return GROUP_NOT_EMPTY.
func (m *Manager) DeleteGroup(ctx context.Context, profileID, group string) error {
	if group == "" {
		return fmt.Errorf("group is required")
	}
	c, err := m.Get(profileID)
	if err != nil {
		return err
	}
	delCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	resp, err := c.adm.DeleteGroups(delCtx, group)
	if err != nil {
		return fmt.Errorf("delete group: %w", err)
	}
	r, ok := resp[group]
	if !ok {
		return fmt.Errorf("delete group: no response from broker")
	}
	if r.Err != nil {
		return r.Err
	}
	return nil
}

// ResetGroupOffsetsForTopic moves a consumer group's committed offsets for a
// single topic. Mode is one of: "earliest", "latest", "timestamp", "explicit".
//
// - earliest / latest: the new offset is the log start / end for every
//   partition.
// - timestamp: timestampMs is the millisecond timestamp; per-partition the new
//   offset is the first record at or after that time (or end-offset if there is
//   none).
// - explicit: only the partitions in `explicit` are reset, to the offsets
//   provided.
//
// Kafka rejects an offset commit while the group has active members
// (UNKNOWN_MEMBER_ID / REBALANCE_IN_PROGRESS). The caller should ensure the
// group is Empty / Dead before invoking this.
func (m *Manager) ResetGroupOffsetsForTopic(
	ctx context.Context,
	profileID, group, topic, mode string,
	timestampMs int64,
	explicit []ExplicitOffset,
) error {
	if group == "" {
		return fmt.Errorf("group is required")
	}
	if topic == "" {
		return fmt.Errorf("topic is required")
	}
	c, err := m.Get(profileID)
	if err != nil {
		return err
	}

	var offsets kadm.Offsets
	switch mode {
	case "earliest":
		opCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		listed, err := c.adm.ListStartOffsets(opCtx, topic)
		if err != nil {
			return fmt.Errorf("list start offsets: %w", err)
		}
		if err := listed.Error(); err != nil {
			return fmt.Errorf("list start offsets: %w", err)
		}
		offsets = listed.Offsets()
	case "latest":
		opCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		listed, err := c.adm.ListEndOffsets(opCtx, topic)
		if err != nil {
			return fmt.Errorf("list end offsets: %w", err)
		}
		if err := listed.Error(); err != nil {
			return fmt.Errorf("list end offsets: %w", err)
		}
		offsets = listed.Offsets()
	case "timestamp":
		if timestampMs <= 0 {
			return fmt.Errorf("timestampMs is required for timestamp mode")
		}
		opCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		listed, err := c.adm.ListOffsetsAfterMilli(opCtx, timestampMs, topic)
		if err != nil {
			return fmt.Errorf("list offsets after ms: %w", err)
		}
		// Partitions with no record after the timestamp return Offset = -1.
		// Replace those with the partition's end offset so the group does
		// not get stuck at -1.
		endCtx, endCancel := context.WithTimeout(ctx, 15*time.Second)
		defer endCancel()
		ends, err := c.adm.ListEndOffsets(endCtx, topic)
		if err != nil {
			return fmt.Errorf("list end offsets (fallback): %w", err)
		}
		offsets = make(kadm.Offsets)
		listed.Each(func(o kadm.ListedOffset) {
			off := o.Offset
			if off < 0 {
				if end, ok := ends.Lookup(o.Topic, o.Partition); ok {
					off = end.Offset
				} else {
					off = 0
				}
			}
			offsets.AddOffset(o.Topic, o.Partition, off, -1)
		})
	case "explicit":
		if len(explicit) == 0 {
			return fmt.Errorf("explicit offsets are required for explicit mode")
		}
		offsets = make(kadm.Offsets)
		seen := make(map[int32]struct{}, len(explicit))
		for _, e := range explicit {
			if e.Offset < 0 {
				return fmt.Errorf("partition %d: offset must be >= 0", e.Partition)
			}
			if _, dup := seen[e.Partition]; dup {
				return fmt.Errorf("partition %d listed more than once", e.Partition)
			}
			seen[e.Partition] = struct{}{}
			offsets.AddOffset(topic, e.Partition, e.Offset, -1)
		}
	default:
		return fmt.Errorf("unknown reset mode %q", mode)
	}

	if len(offsets) == 0 {
		return fmt.Errorf("no offsets to commit")
	}

	commitCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	resp, err := c.adm.CommitOffsets(commitCtx, group, offsets)
	if err != nil {
		return fmt.Errorf("commit offsets: %w", err)
	}
	if err := resp.Error(); err != nil {
		return err
	}
	return nil
}
