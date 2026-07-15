package kafka

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/twmb/franz-go/pkg/kgo"
)

// liz_publish.go replicates the Kafka messages the liz Admin Console emits for
// canned operations, so QA can reproduce them without driving the WebUI. The
// first (and today only) operation is the "device monitoring ON/OFF" toggle,
// which the console publishes as a PAIR of NOTIFICATION messages to
// liz.message.pipeline:
//
//   1. DEVICE_UPDATED_NOTIFICATION      { deviceIds:[...], restartService:bool }
//   2. SPECIFY_RULE_UPDATED_NOTIFICATION { specifyRuleId:null }
//
// Both messages of a pair share one header.time (epoch millis); each carries its
// own fresh uuid. Turning monitoring ON sends restartService=true, OFF sends
// restartService=false (the UI exposes this so it can be overridden).
//
// The batching/stepping (chunk a big device-id list into N-sized pairs, send one
// at a time or auto-run) lives in the frontend, which calls
// PublishMonitorTogglePair once per chunk.

// defaultSpecifyRuleRecipientTypes is the recipientTypes the console stamps on
// the SPECIFY_RULE_UPDATED_NOTIFICATION that trails a monitoring toggle.
var defaultSpecifyRuleRecipientTypes = []string{"ADMIN_CONSOLE", "API_SERVER", "ADMIN_MOBILE"}

// toolUUIDPrefix is a fingerprint stamped into every message's uuid so tool-sent
// traffic is distinguishable from the real Admin Console's. liz does not validate
// the uuid, so we reuse its first block (8 hex chars, kept UUID-shaped) as a
// recognizable, greppable marker: our messages' uuid starts with "c0decafe-".
const toolUUIDPrefix = "c0decafe"

// toolUUID returns a random UUID with its first block overwritten by the tool
// fingerprint, e.g. "c0decafe-1a2b-4c3d-8e4f-0123456789ab".
func toolUUID() string {
	u := uuid.NewString() // 8-4-4-4-12; index 8 is the first "-"
	return toolUUIDPrefix + u[len(toolUUIDPrefix):]
}

// lizHeader mirrors the liz.message.pipeline envelope header. Field order and
// the null / empty-array distinctions match the on-wire form (json.Marshal keeps
// struct field order; nil *int64 → null; a non-nil empty slice → []).
type lizHeader struct {
	Version        int      `json:"version"`
	Time           int64    `json:"time"`
	ProtocolCode   string   `json:"protocolCode"`
	LizMessageType string   `json:"lizMessageType"`
	RecipientTypes []string `json:"recipientTypes"`
	RecipientIds   []int64  `json:"recipientIds"`
	SenderType     string   `json:"senderType"`
	SenderId       *int64   `json:"senderId"`
	LizUserId      *int64   `json:"lizUserId"`
	Uuid           string   `json:"uuid"`
}

type deviceUpdatedMsg struct {
	Header         lizHeader `json:"header"`
	DeviceIds      []int64   `json:"deviceIds"`
	RestartService bool      `json:"restartService"`
}

type specifyRuleMsg struct {
	Header        lizHeader `json:"header"`
	SpecifyRuleId *int64    `json:"specifyRuleId"`
}

// MonitorTogglePairRequest describes one device-monitoring toggle "pair" (one
// chunk of device ids) to publish.
type MonitorTogglePairRequest struct {
	Topic          string  `json:"topic"`
	DeviceIds      []int64 `json:"deviceIds"`
	RestartService bool    `json:"restartService"`
	SenderType     string  `json:"senderType"` // default ADMIN_CONSOLE when empty
	Partition      int32   `json:"partition"`  // -1 = default partitioner

	// OmitSpecifyRule, when true, publishes ONLY the DEVICE_UPDATED_NOTIFICATION
	// and skips the trailing SPECIFY_RULE_UPDATED_NOTIFICATION. The captured
	// Admin-Console behaviour emits both (they share one header.time), so the
	// default (false) reproduces that pair; set true to send the device message
	// alone. (Zero value = include the rule, matching the observed default.)
	OmitSpecifyRule bool `json:"omitSpecifyRule"`
}

// PublishedRecord is one produced (or previewed) message: the exact JSON bytes
// sent, its ack coordinates, and its uuid. Offset/Partition are -1 on preview.
type PublishedRecord struct {
	Value     string `json:"value"`
	Partition int32  `json:"partition"`
	Offset    int64  `json:"offset"`
	Uuid      string `json:"uuid"`
}

// MonitorTogglePairResult is returned per published (or previewed) pair.
type MonitorTogglePairResult struct {
	TimeMs        int64           `json:"timeMs"`
	DeviceUpdated PublishedRecord `json:"deviceUpdated"`
	SpecifyRule   PublishedRecord `json:"specifyRule"`
}

// build constructs the two envelope structs for a pair, stamping the shared
// time and two fresh uuids.
func (r MonitorTogglePairRequest) build(now int64) (deviceUpdatedMsg, specifyRuleMsg) {
	sender := r.SenderType
	if sender == "" {
		sender = "ADMIN_CONSOLE"
	}
	ids := r.DeviceIds
	if ids == nil {
		ids = []int64{}
	}
	dev := deviceUpdatedMsg{
		Header: lizHeader{
			Version:        1,
			Time:           now,
			ProtocolCode:   "DEVICE_UPDATED_NOTIFICATION",
			LizMessageType: "NOTIFICATION",
			RecipientTypes: []string{},
			RecipientIds:   []int64{},
			SenderType:     sender,
			Uuid:           toolUUID(),
		},
		DeviceIds:      ids,
		RestartService: r.RestartService,
	}
	spec := specifyRuleMsg{
		Header: lizHeader{
			Version:        1,
			Time:           now,
			ProtocolCode:   "SPECIFY_RULE_UPDATED_NOTIFICATION",
			LizMessageType: "NOTIFICATION",
			RecipientTypes: append([]string{}, defaultSpecifyRuleRecipientTypes...),
			RecipientIds:   []int64{},
			SenderType:     sender,
			Uuid:           toolUUID(),
		},
	}
	return dev, spec
}

// PreviewMonitorTogglePair builds the pair without producing anything, returning
// the exact JSON that PublishMonitorTogglePair would send (compact, as it goes
// on the wire). Partition/Offset are -1. uuid/time are freshly generated here
// and will differ from the actual send — the UI notes this.
func (m *Manager) PreviewMonitorTogglePair(req MonitorTogglePairRequest) (MonitorTogglePairResult, error) {
	now := time.Now().UnixMilli()
	dev, spec := req.build(now)
	devJSON, err := json.Marshal(dev)
	if err != nil {
		return MonitorTogglePairResult{}, err
	}
	res := MonitorTogglePairResult{
		TimeMs:        now,
		DeviceUpdated: PublishedRecord{Value: string(devJSON), Partition: -1, Offset: -1, Uuid: dev.Header.Uuid},
	}
	if !req.OmitSpecifyRule {
		specJSON, err := json.Marshal(spec)
		if err != nil {
			return MonitorTogglePairResult{}, err
		}
		res.SpecifyRule = PublishedRecord{Value: string(specJSON), Partition: -1, Offset: -1, Uuid: spec.Header.Uuid}
	}
	return res, nil
}

// PublishMonitorTogglePair produces the DEVICE_UPDATED_NOTIFICATION +
// SPECIFY_RULE_UPDATED_NOTIFICATION pair for one chunk of device ids. The two
// records are produced in order to the same topic. If the first succeeds and the
// second fails, the returned result carries the DEVICE_UPDATED coordinates and a
// non-nil error so the UI can show the pair as half-sent (Kafka has no
// cross-record transaction here — this is intentionally best-effort per record).
func (m *Manager) PublishMonitorTogglePair(ctx context.Context, profileID string, req MonitorTogglePairRequest) (MonitorTogglePairResult, error) {
	if req.Topic == "" {
		return MonitorTogglePairResult{}, errors.New("topic is required")
	}
	if len(req.DeviceIds) == 0 {
		return MonitorTogglePairResult{}, errors.New("deviceIds is empty")
	}
	c, err := m.Get(profileID)
	if err != nil {
		return MonitorTogglePairResult{}, err
	}

	now := time.Now().UnixMilli()
	dev, spec := req.build(now)
	devJSON, err := json.Marshal(dev)
	if err != nil {
		return MonitorTogglePairResult{}, err
	}

	part := int32(-1)
	if req.Partition >= 0 {
		part = req.Partition
	}

	prodCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	devRec, err := produceOneValue(prodCtx, c, req.Topic, part, devJSON)
	if err != nil {
		return MonitorTogglePairResult{TimeMs: now}, fmt.Errorf("DEVICE_UPDATED_NOTIFICATION publish failed: %w", err)
	}
	res := MonitorTogglePairResult{
		TimeMs: now,
		DeviceUpdated: PublishedRecord{
			Value: string(devJSON), Partition: devRec.Partition, Offset: devRec.Offset, Uuid: dev.Header.Uuid,
		},
	}

	if req.OmitSpecifyRule {
		return res, nil
	}

	specJSON, err := json.Marshal(spec)
	if err != nil {
		return res, err
	}
	specRec, err := produceOneValue(prodCtx, c, req.Topic, part, specJSON)
	if err != nil {
		// DEVICE_UPDATED already went out; report the partial pair with a clear
		// error rather than pretending nothing was sent.
		return res, fmt.Errorf("SPECIFY_RULE_UPDATED_NOTIFICATION publish failed (DEVICE_UPDATED already sent): %w", err)
	}
	res.SpecifyRule = PublishedRecord{
		Value: string(specJSON), Partition: specRec.Partition, Offset: specRec.Offset, Uuid: spec.Header.Uuid,
	}
	return res, nil
}

// produceOneValue produces a single keyless record and waits for its ack.
func produceOneValue(ctx context.Context, c *Client, topic string, partition int32, value []byte) (*kgo.Record, error) {
	rec := &kgo.Record{Topic: topic, Value: value, Partition: partition}
	return c.cl.ProduceSync(ctx, rec).First()
}
