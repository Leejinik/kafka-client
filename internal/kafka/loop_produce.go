package kafka

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

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

	loopCtx, cancel := context.WithCancel(context.Background())
	state := &loopState{
		cancel:    cancel,
		mode:      opts.Mode,
		startedAt: time.Now(),
	}
	state.running.Store(true)
	loops.Store(profileID, state)

	go runLoop(loopCtx, c, opts, state)
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

func runLoop(ctx context.Context, c *Client, opts LoopProduceOptions, state *loopState) {
	defer func() {
		// Flush any pending records so the final sent/failed counts settle.
		flushCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_ = c.cl.Flush(flushCtx)
		cancel()
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
			c.cl.Produce(ctx, makeRec(), cb)
			queued++
		}

	case "interval":
		ticker := time.NewTicker(time.Duration(opts.IntervalMs) * time.Millisecond)
		defer ticker.Stop()
		var queued int64
		fire := func() bool {
			c.cl.Produce(ctx, makeRec(), cb)
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
