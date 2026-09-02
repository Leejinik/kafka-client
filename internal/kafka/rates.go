package kafka

import (
	"context"
	"fmt"
	"sort"
	"time"
)

// MessageRate is the produced-message rate (msgs/sec) for a single topic,
// computed over a recent time window.
type MessageRate struct {
	Topic       string  `json:"topic"`
	MsgsPerSec  float64 `json:"msgsPerSec"`
	DeltaMsgs   int64   `json:"deltaMsgs"` // messages produced in window
	WindowMs    int64   `json:"windowMs"`
	Err         string  `json:"err,omitempty"`
}

// MessageRates returns the producing rate for each topic over the last
// `lookbackMs` milliseconds. Rate is sum-across-partitions of
// (currentEndOffset - offsetAtTimestamp(now-lookbackMs)) divided by the
// window in seconds.
func (m *Manager) MessageRates(ctx context.Context, profileID string, topics []string, lookbackMs int64) ([]MessageRate, error) {
	if len(topics) == 0 {
		return []MessageRate{}, nil
	}
	if lookbackMs <= 0 {
		lookbackMs = 60_000
	}
	c, err := m.Get(profileID)
	if err != nil {
		return nil, err
	}

	rateCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	ends, err := c.adm.ListEndOffsets(rateCtx, topics...)
	if err != nil {
		return nil, fmt.Errorf("end offsets: %w", err)
	}
	pastMilli := time.Now().UnixMilli() - lookbackMs
	pasts, err := c.adm.ListOffsetsAfterMilli(rateCtx, pastMilli, topics...)
	if err != nil {
		return nil, fmt.Errorf("past offsets: %w", err)
	}

	secs := float64(lookbackMs) / 1000.0
	endMap := ends.Offsets()
	pastMap := pasts.Offsets()

	out := make([]MessageRate, 0, len(topics))
	for _, topic := range topics {
		var delta int64
		topicEnds := endMap[topic]
		topicPasts := pastMap[topic]
		if len(topicEnds) == 0 {
			out = append(out, MessageRate{Topic: topic, WindowMs: lookbackMs})
			continue
		}
		for pid, end := range topicEnds {
			if end.At <= 0 {
				continue
			}
			past, ok := topicPasts[pid]
			if !ok || past.At < 0 {
				// No message at-or-after the lookback timestamp on this
				// partition; nothing produced in the window for this pid.
				continue
			}
			d := end.At - past.At
			if d > 0 {
				delta += d
			}
		}
		out = append(out, MessageRate{
			Topic:      topic,
			MsgsPerSec: float64(delta) / secs,
			DeltaMsgs:  delta,
			WindowMs:   lookbackMs,
		})
	}
	return out, nil
}

// PartitionEndOffset is one partition's current end offset (one past the last
// record), as reported by the partition leader.
type PartitionEndOffset struct {
	Partition int32  `json:"partition"`
	EndOffset int64  `json:"endOffset"`
	Err       string `json:"err,omitempty"`
}

// EndOffsetsSnapshot is a point-in-time picture of a topic's end offsets.
// SampledAtMs is the client wall clock right after the broker replied, so
// two snapshots can be turned into an ingress rate (Δoffset / Δtime) without
// consuming a single record — the only broker traffic is one ListOffsets
// request per partition leader.
type EndOffsetsSnapshot struct {
	Topic       string               `json:"topic"`
	SampledAtMs int64                `json:"sampledAtMs"`
	Partitions  []PartitionEndOffset `json:"partitions"`
}

// TopicEndOffsets returns the current end offset of every partition of a
// topic. Used by the ingress rate meter: it is the zero-load alternative to
// tail -f for answering "how many messages per second are landing here?".
func (m *Manager) TopicEndOffsets(ctx context.Context, profileID, topic string) (EndOffsetsSnapshot, error) {
	c, err := m.Get(profileID)
	if err != nil {
		return EndOffsetsSnapshot{}, err
	}
	sctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	ends, err := c.adm.ListEndOffsets(sctx, topic)
	if err != nil {
		return EndOffsetsSnapshot{}, fmt.Errorf("end offsets: %w", err)
	}
	snap := EndOffsetsSnapshot{Topic: topic, SampledAtMs: time.Now().UnixMilli()}
	for _, lo := range ends[topic] {
		p := PartitionEndOffset{Partition: lo.Partition, EndOffset: lo.Offset}
		if lo.Err != nil {
			p.Err = lo.Err.Error()
		}
		snap.Partitions = append(snap.Partitions, p)
	}
	sort.Slice(snap.Partitions, func(i, j int) bool { return snap.Partitions[i].Partition < snap.Partitions[j].Partition })
	if snap.Partitions == nil {
		snap.Partitions = []PartitionEndOffset{}
	}
	return snap, nil
}
