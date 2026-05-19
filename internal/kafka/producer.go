package kafka

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// ProduceRequest describes a single message to produce.
type ProduceRequest struct {
	Topic     string            `json:"topic"`
	Key       string            `json:"key"`
	Value     string            `json:"value"`
	Headers   map[string]string `json:"headers"`
	Partition int32             `json:"partition"` // -1 means default partitioner
}

// ProduceResult is returned to the UI after produce ack.
type ProduceResult struct {
	Topic     string `json:"topic"`
	Partition int32  `json:"partition"`
	Offset    int64  `json:"offset"`
	TimestampMs int64 `json:"timestampMs"`
}

// Produce sends a single record using the per-profile client.
func (m *Manager) Produce(ctx context.Context, profileID string, req ProduceRequest) (ProduceResult, error) {
	if req.Topic == "" {
		return ProduceResult{}, errors.New("topic is required")
	}
	c, err := m.Get(profileID)
	if err != nil {
		return ProduceResult{}, err
	}

	rec := &kgo.Record{
		Topic:     req.Topic,
		Key:       []byte(req.Key),
		Value:     []byte(req.Value),
		Partition: -1,
	}
	if req.Partition >= 0 {
		rec.Partition = req.Partition
	}
	for k, v := range req.Headers {
		rec.Headers = append(rec.Headers, kgo.RecordHeader{Key: k, Value: []byte(v)})
	}

	prodCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	r, err := c.cl.ProduceSync(prodCtx, rec).First()
	if err != nil {
		return ProduceResult{}, fmt.Errorf("produce: %w", err)
	}
	return ProduceResult{
		Topic:       r.Topic,
		Partition:   r.Partition,
		Offset:      r.Offset,
		TimestampMs: r.Timestamp.UnixMilli(),
	}, nil
}
