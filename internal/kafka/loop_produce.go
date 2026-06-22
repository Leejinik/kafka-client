package kafka

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// ProducerTuning carries the franz-go equivalents of the classic Kafka
// producer knobs, so the load test (max mode) can be re-run with different
// settings without reconnecting the profile. A nil Tuning means "use the
// shared client as-is" (no compression, franz defaults). When non-nil, a
// dedicated throwaway producer client is built for the loop and closed when
// it finishes — the shared client (used by consume/admin/single produce) is
// never mutated.
//
// Kafka knob          → franz-go option
//   batch.size        → ProducerBatchMaxBytes
//   linger.ms         → ProducerLinger
//   compression.type  → ProducerBatchCompression
//   acks              → RequiredAcks (+ DisableIdempotentWrite when != all)
//   buffer.memory     → MaxBufferedBytes
type ProducerTuning struct {
	BatchMaxBytes    int32  `json:"batchMaxBytes"`    // batch.size in bytes; 0 = franz default (16 KiB)
	LingerMs         int64  `json:"lingerMs"`         // linger.ms; 0 = no linger
	Compression      string `json:"compression"`      // none|gzip|snappy|lz4|zstd; "" = none
	Acks             string `json:"acks"`             // all|leader|none; "" = leader(1)
	MaxBufferedBytes int64  `json:"maxBufferedBytes"` // buffer.memory in bytes; 0 = franz default
}

// LoopProduceOptions configures a repeated produce session.
//
// Mode "max":      produce as fast as possible (async + buffered) until either
//                  Count messages have been queued or DurationMs has elapsed.
//                  0 means "no limit" on the corresponding axis. (At least one
//                  of Count / DurationMs should be set, otherwise the loop is
//                  unbounded and the caller must Stop it.)
// Mode "interval": produce one message every IntervalMs, until Count messages
//                  have been sent (0 = unlimited).
type LoopProduceOptions struct {
	Topic      string            `json:"topic"`
	Key        string            `json:"key"`
	Value      string            `json:"value"`
	Headers    map[string]string `json:"headers"`
	Partition  int32             `json:"partition"`
	Mode       string            `json:"mode"`
	IntervalMs int64             `json:"intervalMs"`
	Count      int64             `json:"count"`
	DurationMs int64             `json:"durationMs"`
	Tuning     *ProducerTuning   `json:"tuning"`
}

// buildTunedClient creates a dedicated producer client for a load test using
// the same seed brokers / alias dialer as the profile's shared client, but
// with the caller-supplied producer tuning applied.
func buildTunedClient(c *Client, tn *ProducerTuning) (*kgo.Client, error) {
	opts := []kgo.Opt{
		kgo.SeedBrokers(c.servers...),
		kgo.ClientID("kafka-client-tool-loadtest"),
		kgo.MetadataMinAge(5 * time.Second),
		kgo.DialTimeout(10 * time.Second),
		kgo.Dialer(aliasDialer(c.aliases)),
	}

	switch strings.ToLower(strings.TrimSpace(tn.Compression)) {
	case "gzip":
		opts = append(opts, kgo.ProducerBatchCompression(kgo.GzipCompression()))
	case "snappy":
		opts = append(opts, kgo.ProducerBatchCompression(kgo.SnappyCompression()))
	case "lz4":
		opts = append(opts, kgo.ProducerBatchCompression(kgo.Lz4Compression()))
	case "zstd":
		opts = append(opts, kgo.ProducerBatchCompression(kgo.ZstdCompression()))
	default: // "", "none"
		opts = append(opts, kgo.ProducerBatchCompression(kgo.NoCompression()))
	}

	switch strings.ToLower(strings.TrimSpace(tn.Acks)) {
	case "all", "-1":
		// acks=all keeps franz-go's default idempotent producer.
		opts = append(opts, kgo.RequiredAcks(kgo.AllISRAcks()))
	case "none", "0":
		// Idempotency requires acks=all, so it must be disabled here.
		opts = append(opts, kgo.RequiredAcks(kgo.NoAck()), kgo.DisableIdempotentWrite())
	default: // "", "leader", "1"
		opts = append(opts, kgo.RequiredAcks(kgo.LeaderAck()), kgo.DisableIdempotentWrite())
	}

	if tn.BatchMaxBytes > 0 {
		opts = append(opts, kgo.ProducerBatchMaxBytes(tn.BatchMaxBytes))
	}
	if tn.LingerMs > 0 {
		opts = append(opts, kgo.ProducerLinger(time.Duration(tn.LingerMs)*time.Millisecond))
	}
	if tn.MaxBufferedBytes > 0 {
		opts = append(opts, kgo.MaxBufferedBytes(int(tn.MaxBufferedBytes)))
	}

	return kgo.NewClient(opts...)
}

// LoopProduceStatus is polled by the UI while the loop runs.
type LoopProduceStatus struct {
	Running    bool    `json:"running"`
	Sent       int64   `json:"sent"`
	Failed     int64   `json:"failed"`
	LastError  string  `json:"lastError"`
	ElapsedMs  int64   `json:"elapsedMs"`
	MsgsPerSec float64 `json:"msgsPerSec"`
	Mode       string  `json:"mode"`
}

type loopState struct {
	running   atomic.Bool
	cancel    context.CancelFunc
	sent      atomic.Int64
	failed    atomic.Int64
	lastErr   atomic.Value // string
	mode      string
	startedAt time.Time
	endedAt   time.Time
}

// loops is profileID → *loopState. Keeps the last state around after a loop
// finishes so the UI can read the final counters; a new Start replaces it.
var loops sync.Map

func (m *Manager) StartLoopProduce(ctx context.Context, profileID string, opts LoopProduceOptions) error {
	if opts.Topic == "" {
		return fmt.Errorf("topic is required")
	}
	if opts.Mode != "max" && opts.Mode != "interval" {
		return fmt.Errorf("unknown mode %q", opts.Mode)
	}
	if opts.Mode == "interval" && opts.IntervalMs <= 0 {
		return fmt.Errorf("intervalMs must be > 0 for interval mode")
	}

	c, err := m.Get(profileID)
	if err != nil {
		return err
	}

	if v, ok := loops.Load(profileID); ok {
		if v.(*loopState).running.Load() {
			return fmt.Errorf("loop already running for this profile")
		}
	}

	// When tuning is requested, spin up a dedicated producer client so the
	// shared client (consume/admin/single produce) keeps its safe defaults.
	cl := c.cl
	ownClient := false
	if opts.Tuning != nil {
		tc, err := buildTunedClient(c, opts.Tuning)
		if err != nil {
			return fmt.Errorf("create tuned producer: %w", err)
		}
		cl = tc
		ownClient = true
	}

	loopCtx, cancel := context.WithCancel(context.Background())
	state := &loopState{
		cancel:    cancel,
		mode:      opts.Mode,
		startedAt: time.Now(),
	}
	state.running.Store(true)
	loops.Store(profileID, state)

	go runLoop(loopCtx, cl, ownClient, opts, state)
	return nil
}

func (m *Manager) StopLoopProduce(profileID string) {
	if v, ok := loops.Load(profileID); ok {
		v.(*loopState).cancel()
	}
}

func (m *Manager) GetLoopProduceStatus(profileID string) LoopProduceStatus {
	v, ok := loops.Load(profileID)
	if !ok {
		return LoopProduceStatus{}
	}
	s := v.(*loopState)
	sent := s.sent.Load()
	failed := s.failed.Load()
	end := s.endedAt
	if end.IsZero() {
		end = time.Now()
	}
	elapsed := end.Sub(s.startedAt).Milliseconds()
	var rate float64
	if elapsed > 0 {
		rate = float64(sent) / (float64(elapsed) / 1000.0)
	}
	lastErr := ""
	if v := s.lastErr.Load(); v != nil {
		lastErr = v.(string)
	}
	return LoopProduceStatus{
		Running:    s.running.Load(),
		Sent:       sent,
		Failed:     failed,
		LastError:  lastErr,
		ElapsedMs:  elapsed,
		MsgsPerSec: rate,
		Mode:       s.mode,
	}
}

func runLoop(ctx context.Context, cl *kgo.Client, ownClient bool, opts LoopProduceOptions, state *loopState) {
	defer func() {
		// Flush any pending records so the final sent/failed counts settle.
		flushCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_ = cl.Flush(flushCtx)
		cancel()
		// A dedicated tuned client is ours to close; the shared one is not.
		if ownClient {
			cl.Close()
		}
		state.running.Store(false)
		state.endedAt = time.Now()
	}()

	makeRec := func() *kgo.Record {
		r := &kgo.Record{
			Topic:     opts.Topic,
			Key:       []byte(opts.Key),
			Value:     []byte(opts.Value),
			Partition: -1,
		}
		if opts.Partition >= 0 {
			r.Partition = opts.Partition
		}
		for k, v := range opts.Headers {
			r.Headers = append(r.Headers, kgo.RecordHeader{Key: k, Value: []byte(v)})
		}
		return r
	}

	cb := func(_ *kgo.Record, err error) {
		if err != nil {
			state.failed.Add(1)
			state.lastErr.Store(err.Error())
			return
		}
		state.sent.Add(1)
	}

	switch opts.Mode {
	case "max":
		var deadline time.Time
		if opts.DurationMs > 0 {
			deadline = time.Now().Add(time.Duration(opts.DurationMs) * time.Millisecond)
		}
		var queued int64
		for {
			if ctx.Err() != nil {
				return
			}
			if opts.Count > 0 && queued >= opts.Count {
				return
			}
			if !deadline.IsZero() && time.Now().After(deadline) {
				return
			}
			// franz-go Produce is non-blocking until its internal buffer is
			// full (default 10000 records), at which point it blocks for
			// backpressure. That gives us natural rate limiting against a
			// slow broker.
			cl.Produce(ctx, makeRec(), cb)
			queued++
		}

	case "interval":
		ticker := time.NewTicker(time.Duration(opts.IntervalMs) * time.Millisecond)
		defer ticker.Stop()
		var queued int64
		fire := func() bool {
			cl.Produce(ctx, makeRec(), cb)
			queued++
			return opts.Count == 0 || queued < opts.Count
		}
		if !fire() {
			return
		}
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if !fire() {
					return
				}
			}
		}
	}
}
