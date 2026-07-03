package kafka

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// TailConsume continuously polls the topic from its current end offsets and
// invokes onBatch with every flushed batch of records until ctx is done.
// Designed for tail -f UX: no record cap, no timeout — caller cancels via ctx.
//
// Batches are flushed after every poll cycle (≤ 500 ms latency on idle).
// onBatch may be called with nil/empty if no records arrived in a cycle —
// callers should ignore empty batches.
func (m *Manager) TailConsume(
	ctx context.Context,
	profileID, topic string,
	onBatch func([]Message),
) error {
	if topic == "" {
		return errors.New("topic is required")
	}
	c, err := m.Get(profileID)
	if err != nil {
		return err
	}

	metaCtx, metaCancel := context.WithTimeout(ctx, 10*time.Second)
	defer metaCancel()
	topics, err := c.adm.ListTopics(metaCtx, topic)
	if err != nil {
		return fmt.Errorf("list topic: %w", err)
	}
	td, ok := topics[topic]
	if !ok || td.Err != nil {
		if ok && td.Err != nil {
			return fmt.Errorf("topic %s: %w", topic, td.Err)
		}
		return fmt.Errorf("topic %s not found", topic)
	}

	endOffs, err := c.adm.ListEndOffsets(metaCtx, topic)
	if err != nil {
		return fmt.Errorf("end offsets: %w", err)
	}
	endMap := endOffs.Offsets()[topic]

	// Start at the current end of each partition so we only see new records.
	startOffsets := map[int32]kgo.Offset{}
	for pid := range td.Partitions {
		if end, ok := endMap[pid]; ok && end.At >= 0 {
			startOffsets[pid] = kgo.NewOffset().At(end.At)
		} else {
			startOffsets[pid] = kgo.NewOffset().AtEnd()
		}
	}

	cl, err := kgo.NewClient(
		kgo.SeedBrokers(c.servers...),
		kgo.ClientID("kafka-client-tool-tail"),
		kgo.Dialer(aliasDialer(c.aliases, c.tlsConf)),
		kgo.ConsumePartitions(map[string]map[int32]kgo.Offset{topic: startOffsets}),
		kgo.FetchMaxBytes(50<<20),
		kgo.FetchMaxPartitionBytes(10<<20),
	)
	if err != nil {
		return fmt.Errorf("consumer client: %w", err)
	}
	defer cl.Close()

	batch := make([]Message, 0, 256)
	for {
		if ctx.Err() != nil {
			return nil
		}
		// Short poll timeout so the loop wakes up regularly to check ctx
		// and to flush whatever it has gathered.
		pollCtx, pollCancel := context.WithTimeout(ctx, 500*time.Millisecond)
		fetches := cl.PollFetches(pollCtx)
		pollCancel()
		if errs := fetches.Errors(); len(errs) > 0 {
			for _, fe := range errs {
				if errors.Is(fe.Err, context.DeadlineExceeded) || errors.Is(fe.Err, context.Canceled) {
					continue
				}
				return fmt.Errorf("fetch partition %d: %w", fe.Partition, fe.Err)
			}
		}
		fetches.EachRecord(func(r *kgo.Record) {
			batch = append(batch, recordToMessage(r))
		})
		if len(batch) > 0 {
			onBatch(batch)
			batch = batch[:0]
		}
	}
}
