package kafka

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// CursorEntry is an opaque per-partition continuation marker. Returned by
// ConsumeRange and passed back in the next call to fetch the following page.
type CursorEntry struct {
	Partition int32 `json:"partition"`
	Offset    int64 `json:"offset"`
}

// ConsumeRangeOptions configures a single page of a timestamp-range fetch.
//
// StartMs / EndMs are resolved to per-partition offsets via the broker's
// timestamp index. EndMs == 0 means "no end cap" (= log end). MaxMessages
// is the page size (default 1000). Cursor, if non-empty, resumes from the
// previous page's terminal offsets.
type ConsumeRangeOptions struct {
	Topic       string        `json:"topic"`
	StartMs     int64         `json:"startMs"`
	EndMs       int64         `json:"endMs"`
	MaxMessages int           `json:"maxMessages"`
	TimeoutMs   int           `json:"timeoutMs"`
	Cursor      []CursorEntry `json:"cursor,omitempty"`
	// FromEnd jumps directly to the last page of the window: per-partition
	// start = max(startOffset, endCap - perPart + 1). Cursor is ignored.
	FromEnd bool `json:"fromEnd,omitempty"`
}

// ConsumeRangePage is one page of results plus the cursor for the next page.
// Done is true when no further pages exist; Cursor is empty in that case.
// TotalCount is the total number of records that fall in [StartMs, EndMs]
// across all partitions; populated when Cursor is empty in the request
// (first page / first-page jump / last-page jump). -1 means "not computed".
type ConsumeRangePage struct {
	Messages   []Message     `json:"messages"`
	Cursor     []CursorEntry `json:"cursor"`
	Done       bool          `json:"done"`
	TotalCount int64         `json:"totalCount"`
}

// ConsumeRange returns up to MaxMessages records whose timestamps fall in
// [StartMs, EndMs]. Designed for paginating through very large time windows
// without loading everything into memory.
func (m *Manager) ConsumeRange(ctx context.Context, profileID string, opts ConsumeRangeOptions) (ConsumeRangePage, error) {
	if opts.Topic == "" {
		return ConsumeRangePage{}, errors.New("topic is required")
	}
	if opts.StartMs <= 0 {
		return ConsumeRangePage{}, errors.New("startMs is required")
	}
	if opts.MaxMessages <= 0 {
		opts.MaxMessages = 1000
	}
	if opts.TimeoutMs <= 0 {
		opts.TimeoutMs = 10000
	}

	c, err := m.Get(profileID)
	if err != nil {
		return ConsumeRangePage{}, err
	}

	metaCtx, metaCancel := context.WithTimeout(ctx, 10*time.Second)
	defer metaCancel()
	topics, err := c.adm.ListTopics(metaCtx, opts.Topic)
	if err != nil {
		return ConsumeRangePage{}, fmt.Errorf("list topic: %w", err)
	}
	td, ok := topics[opts.Topic]
	if !ok || td.Err != nil {
		if ok && td.Err != nil {
			return ConsumeRangePage{}, fmt.Errorf("topic %s: %w", opts.Topic, td.Err)
		}
		return ConsumeRangePage{}, fmt.Errorf("topic %s not found", opts.Topic)
	}

	// Resolve the inclusive end-of-window offset per partition.
	//
	// ListOffsetsAfterMilli(ts) returns the first record whose timestamp
	// is >= ts. We want records with ts <= EndMs, so we ask for the first
	// record with ts >= EndMs+1 and treat (that offset - 1) as our cap.
	// When no record exists past the window we fall back to the log end.
	logEndOffs, err := c.adm.ListEndOffsets(metaCtx, opts.Topic)
	if err != nil {
		return ConsumeRangePage{}, fmt.Errorf("end offsets: %w", err)
	}
	logEndMap := logEndOffs.Offsets()[opts.Topic]

	endCap := map[int32]int64{}
	if opts.EndMs > 0 {
		endResolved, err := c.adm.ListOffsetsAfterMilli(metaCtx, opts.EndMs+1, opts.Topic)
		if err != nil {
			return ConsumeRangePage{}, fmt.Errorf("resolve end timestamp: %w", err)
		}
		endMap := endResolved.Offsets()[opts.Topic]
		for pid := range td.Partitions {
			if e, ok := endMap[pid]; ok && e.At >= 0 {
				endCap[pid] = e.At - 1
				continue
			}
			if le, ok := logEndMap[pid]; ok && le.At > 0 {
				endCap[pid] = le.At - 1
			} else {
				endCap[pid] = -1
			}
		}
	} else {
		for pid := range td.Partitions {
			if le, ok := logEndMap[pid]; ok && le.At > 0 {
				endCap[pid] = le.At - 1
			} else {
				endCap[pid] = -1
			}
		}
	}

	// Per-partition starting offset for the window (i.e. position of the
	// first record with ts >= StartMs). Used both as the resume-from anchor
	// on the first page and as the floor when jumping to the last page.
	windowStart := map[int32]int64{}
	startResolveDone := false
	resolveWindowStart := func() error {
		if startResolveDone {
			return nil
		}
		startResolveDone = true
		startResolved, err := c.adm.ListOffsetsAfterMilli(metaCtx, opts.StartMs, opts.Topic)
		if err != nil {
			return fmt.Errorf("resolve start timestamp: %w", err)
		}
		startMap := startResolved.Offsets()[opts.Topic]
		for pid := range td.Partitions {
			maxOff, ok := endCap[pid]
			if !ok || maxOff < 0 {
				continue
			}
			s, ok := startMap[pid]
			if !ok || s.At < 0 {
				continue
			}
			if s.At > maxOff {
				continue
			}
			windowStart[pid] = s.At
		}
		return nil
	}

	// Compute the starting offset per partition for THIS fetch:
	//   - cursor present   → resume from cursor
	//   - FromEnd          → last MaxMessages records of the window
	//   - first page       → equals windowStart
	startOffsets := map[int32]int64{}
	switch {
	case len(opts.Cursor) > 0:
		for _, ce := range opts.Cursor {
			maxOff, ok := endCap[ce.Partition]
			if !ok || maxOff < 0 {
				continue
			}
			if ce.Offset > maxOff {
				continue
			}
			startOffsets[ce.Partition] = ce.Offset
		}
	case opts.FromEnd:
		if err := resolveWindowStart(); err != nil {
			return ConsumeRangePage{}, err
		}
		active := int64(0)
		for pid := range windowStart {
			if endCap[pid] >= windowStart[pid] {
				active++
			}
		}
		if active == 0 {
			return ConsumeRangePage{Done: true, TotalCount: 0}, nil
		}
		perPart := int64(opts.MaxMessages) / active
		if perPart < 1 {
			perPart = 1
		}
		for pid, ws := range windowStart {
			from := endCap[pid] - perPart + 1
			if from < ws {
				from = ws
			}
			startOffsets[pid] = from
		}
	default:
		if err := resolveWindowStart(); err != nil {
			return ConsumeRangePage{}, err
		}
		for pid, ws := range windowStart {
			startOffsets[pid] = ws
		}
	}

	// totalCount is set only when the caller is starting a fresh walk
	// (cursor empty) — that's when we have windowStart available to sum.
	var totalCount int64 = -1
	if len(opts.Cursor) == 0 {
		if err := resolveWindowStart(); err != nil {
			return ConsumeRangePage{}, err
		}
		totalCount = 0
		for pid, ws := range windowStart {
			if c := endCap[pid] - ws + 1; c > 0 {
				totalCount += c
			}
		}
	}

	if len(startOffsets) == 0 {
		return ConsumeRangePage{Done: true, TotalCount: totalCount}, nil
	}

	kgoStarts := make(map[int32]kgo.Offset, len(startOffsets))
	for pid, off := range startOffsets {
		kgoStarts[pid] = kgo.NewOffset().At(off)
	}

	cl, err := kgo.NewClient(
		kgo.SeedBrokers(c.servers...),
		kgo.ClientID("kafka-client-tool-range"),
		kgo.Dialer(aliasDialer(c.aliases, c.tlsConf)),
		kgo.ConsumePartitions(map[string]map[int32]kgo.Offset{opts.Topic: kgoStarts}),
		kgo.FetchMaxBytes(50<<20),
		kgo.FetchMaxPartitionBytes(10<<20),
	)
	if err != nil {
		return ConsumeRangePage{}, fmt.Errorf("consumer client: %w", err)
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
				return ConsumeRangePage{}, fmt.Errorf("fetch partition %d: %w", fe.Partition, fe.Err)
			}
		}
		fetches.EachRecord(func(r *kgo.Record) {
			if len(out) >= opts.MaxMessages {
				return
			}
			if maxOff, ok := endCap[r.Partition]; ok && r.Offset > maxOff {
				return
			}
			out = append(out, recordToMessage(r))
			if cur, ok := delivered[r.Partition]; !ok || r.Offset > cur {
				delivered[r.Partition] = r.Offset
			}
		})
		// Stop once every active partition has been drained up to its cap
		// — there are no more records in [start, end] to fetch.
		done := true
		for pid := range startOffsets {
			if delivered[pid] < endCap[pid] {
				done = false
				break
			}
		}
		if done {
			break
		}
	}

	// Compute the cursor for the next page. Default each partition to its
	// starting offset (i.e. nothing was consumed from it yet); for every
	// partition that DID deliver a record, advance to lastDelivered+1.
	// Partitions already at or past their cap are dropped.
	nextCursor := make(map[int32]int64, len(startOffsets))
	for pid, off := range startOffsets {
		nextCursor[pid] = off
	}
	for pid, lastOff := range delivered {
		nextCursor[pid] = lastOff + 1
	}
	cursor := make([]CursorEntry, 0, len(nextCursor))
	for pid, off := range nextCursor {
		if off > endCap[pid] {
			continue
		}
		cursor = append(cursor, CursorEntry{Partition: pid, Offset: off})
	}
	sort.Slice(cursor, func(i, j int) bool { return cursor[i].Partition < cursor[j].Partition })

	return ConsumeRangePage{
		Messages:   out,
		Cursor:     cursor,
		Done:       len(cursor) == 0,
		TotalCount: totalCount,
	}, nil
}
