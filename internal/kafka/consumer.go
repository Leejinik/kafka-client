package kafka

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
)

// SeekMode selects the starting offset for a fetch.
type SeekMode string

const (
	SeekBeginning SeekMode = "beginning"
	SeekEnd       SeekMode = "end"
	SeekOffset    SeekMode = "offset"
	SeekTimestamp SeekMode = "timestamp"
)

// ConsumeOptions controls a single fetch operation.
type ConsumeOptions struct {
	Topic       string   `json:"topic"`
	Mode        SeekMode `json:"mode"`
	Offset      int64    `json:"offset,omitempty"`
	TimestampMs int64    `json:"timestampMs,omitempty"`
	MaxMessages int      `json:"maxMessages"`
	TimeoutMs   int      `json:"timeoutMs"`
}

// Message is a decoded representation passed to the UI.
type Message struct {
	Topic       string            `json:"topic"`
	Partition   int32             `json:"partition"`
	Offset      int64             `json:"offset"`
	TimestampMs int64             `json:"timestampMs"`
	Key         string            `json:"key"`
	Value       string            `json:"value"`
	KeyB64      string            `json:"keyB64,omitempty"`
	ValueB64    string            `json:"valueB64,omitempty"`
	KeyIsBin    bool              `json:"keyIsBinary"`
	ValueIsBin  bool              `json:"valueIsBinary"`
	Headers     map[string]string `json:"headers"`
}

// Consume fetches a bounded set of messages from a topic.
//
// Offset resolution is done explicitly via kadm.List{Start,End}Offsets and
// ListOffsetsAfterMilli rather than relying on kgo's AtStart/AtEnd helpers,
// because some brokers (older / unusual configurations) fail to resolve those
// pseudo-offsets when the consumer client is freshly created.
func (m *Manager) Consume(ctx context.Context, profileID string, opts ConsumeOptions) ([]Message, error) {
	if opts.Topic == "" {
		return nil, errors.New("topic is required")
	}
	if opts.MaxMessages <= 0 {
		opts.MaxMessages = 1000
	}
	if opts.TimeoutMs <= 0 {
		opts.TimeoutMs = 10000
	}

	c, err := m.Get(profileID)
	if err != nil {
		return nil, err
	}

	// Discover partitions for the topic.
	metaCtx, metaCancel := context.WithTimeout(ctx, 10*time.Second)
	defer metaCancel()
	topics, err := c.adm.ListTopics(metaCtx, opts.Topic)
	if err != nil {
		return nil, fmt.Errorf("list topic: %w", err)
	}
	td, ok := topics[opts.Topic]
	if !ok || td.Err != nil {
		if ok && td.Err != nil {
			return nil, fmt.Errorf("topic %s: %w", opts.Topic, td.Err)
		}
		return nil, fmt.Errorf("topic %s not found", opts.Topic)
	}
	if len(td.Partitions) == 0 {
		return nil, fmt.Errorf("topic %s has no partitions", opts.Topic)
	}

	// Always grab start/end offsets so we can compute concrete numeric
	// starting positions for every mode.
	offCtx, offCancel := context.WithTimeout(ctx, 10*time.Second)
	defer offCancel()
	startOffs, err := c.adm.ListStartOffsets(offCtx, opts.Topic)
	if err != nil {
		return nil, fmt.Errorf("start offsets: %w", err)
	}
	endOffs, err := c.adm.ListEndOffsets(offCtx, opts.Topic)
	if err != nil {
		return nil, fmt.Errorf("end offsets: %w", err)
	}
	startMap := startOffs.Offsets()[opts.Topic]
	endMap := endOffs.Offsets()[opts.Topic]

	// Compute numeric start offset per partition.
	startOffsets := map[int32]kgo.Offset{}
	switch opts.Mode {
	case SeekBeginning, "":
		for pid, s := range startMap {
			startOffsets[pid] = kgo.NewOffset().At(s.At)
		}
	case SeekEnd:
		// Show the last N messages distributed across partitions, so the
		// user sees recent history immediately. Tailing of brand-new
		// records continues for the remainder of the timeout window.
		nPart := int64(len(endMap))
		if nPart == 0 {
			nPart = 1
		}
		perPart := int64(opts.MaxMessages) / nPart
		if perPart < 1 {
			perPart = 1
		}
		for pid, e := range endMap {
			s := startMap[pid]
			from := e.At - perPart
			if from < s.At {
				from = s.At
			}
			if from < 0 {
				from = 0
			}
			startOffsets[pid] = kgo.NewOffset().At(from)
		}
	case SeekOffset:
		for pid := range td.Partitions {
			startOffsets[pid] = kgo.NewOffset().At(opts.Offset)
		}
	case SeekTimestamp:
		tsCtx, tsCancel := context.WithTimeout(ctx, 10*time.Second)
		defer tsCancel()
		resolved, err := c.adm.ListOffsetsAfterMilli(tsCtx, opts.TimestampMs, opts.Topic)
		if err != nil {
			return nil, fmt.Errorf("resolve timestamp: %w", err)
		}
		rmap := resolved.Offsets()[opts.Topic]
		for pid := range td.Partitions {
			off, ok := rmap[pid]
			if !ok || off.At < 0 {
				// no message at or after the requested timestamp; start at end so we tail
				startOffsets[pid] = kgo.NewOffset().At(endMap[pid].At)
			} else {
				startOffsets[pid] = kgo.NewOffset().At(off.At)
			}
		}
	default:
		return nil, fmt.Errorf("unknown seek mode %q", opts.Mode)
	}

	// Build a transient consumer client. We do NOT reuse the manager's
	// client because that one is configured for admin/produce traffic and
	// does not have ConsumePartitions set; mixing roles complicates
	// resource lifetime when the user changes topics or modes.
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(c.servers...),
		kgo.ClientID("kafka-client-tool-consume"),
		kgo.Dialer(aliasDialer(c.aliases)),
		kgo.ConsumePartitions(map[string]map[int32]kgo.Offset{opts.Topic: startOffsets}),
		kgo.FetchMaxBytes(50<<20),
		kgo.FetchMaxPartitionBytes(10<<20),
	)
	if err != nil {
		return nil, fmt.Errorf("consumer client: %w", err)
	}
	defer cl.Close()

	deadline := time.Now().Add(time.Duration(opts.TimeoutMs) * time.Millisecond)
	fetchCtx, fetchCancel := context.WithDeadline(ctx, deadline)
	defer fetchCancel()

	out := make([]Message, 0, opts.MaxMessages)
	delivered := map[int32]int64{}

	for len(out) < opts.MaxMessages {
		if fetchCtx.Err() != nil {
			break
		}
		fetches := cl.PollFetches(fetchCtx)
		if errs := fetches.Errors(); len(errs) > 0 {
			for _, fe := range errs {
				if errors.Is(fe.Err, context.DeadlineExceeded) || errors.Is(fe.Err, context.Canceled) {
					continue
				}
				return out, fmt.Errorf("fetch partition %d: %w", fe.Partition, fe.Err)
			}
		}
		fetches.EachRecord(func(r *kgo.Record) {
			if len(out) >= opts.MaxMessages {
				return
			}
			out = append(out, recordToMessage(r))
			if cur, ok := delivered[r.Partition]; !ok || r.Offset > cur {
				delivered[r.Partition] = r.Offset
			}
		})
		if opts.Mode == SeekEnd {
			// In tail mode we keep polling for new records until the
			// deadline, regardless of how many we already have.
			continue
		}
		// For finite modes, stop once every partition has been drained up
		// to the end offset we observed at the start of the fetch.
		drained := allDrained(delivered, endMap, startOffsets)
		if drained {
			break
		}
	}
	return out, nil
}

func allDrained(delivered map[int32]int64, endMap map[int32]kadm.Offset, starts map[int32]kgo.Offset) bool {
	for pid, end := range endMap {
		if end.At <= 0 {
			continue
		}
		// If our seek for this partition was already at/after end, treat as drained.
		if _, ok := starts[pid]; !ok {
			continue
		}
		cur, ok := delivered[pid]
		if !ok || cur < end.At-1 {
			return false
		}
	}
	return true
}

func recordToMessage(r *kgo.Record) Message {
	keyStr, keyBin := bytesToString(r.Key)
	valStr, valBin := bytesToString(r.Value)
	m := Message{
		Topic:       r.Topic,
		Partition:   r.Partition,
		Offset:      r.Offset,
		TimestampMs: r.Timestamp.UnixMilli(),
		Key:         keyStr,
		Value:       valStr,
		KeyIsBin:    keyBin,
		ValueIsBin:  valBin,
		Headers:     headerMap(r.Headers),
	}
	if keyBin {
		m.KeyB64 = base64.StdEncoding.EncodeToString(r.Key)
	}
	if valBin {
		m.ValueB64 = base64.StdEncoding.EncodeToString(r.Value)
	}
	return m
}

func headerMap(hs []kgo.RecordHeader) map[string]string {
	if len(hs) == 0 {
		return map[string]string{}
	}
	out := make(map[string]string, len(hs))
	for _, h := range hs {
		s, _ := bytesToString(h.Value)
		out[h.Key] = s
	}
	return out
}

// bytesToString returns (string, isBinary). For binary payloads we still
// return a hex preview so the UI can show something useful inline.
func bytesToString(b []byte) (string, bool) {
	if len(b) == 0 {
		return "", false
	}
	if utf8.Valid(b) {
		return string(b), false
	}
	const max = 64
	cut := b
	if len(cut) > max {
		cut = cut[:max]
	}
	const hex = "0123456789abcdef"
	out := make([]byte, 0, len(cut)*3)
	for i, x := range cut {
		if i > 0 {
			out = append(out, ' ')
		}
		out = append(out, hex[x>>4], hex[x&0x0f])
	}
	if len(b) > max {
		out = append(out, '.', '.', '.')
	}
	return string(out), true
}
