package kafka

import (
	"encoding/json"
	"regexp"
	"testing"
)

// uuidRe matches the header.uuid value so goldens can ignore the random part.
var uuidRe = regexp.MustCompile(`"uuid":"[0-9a-fA-F-]{36}"`)

func normalizeUUID(b []byte) string {
	return uuidRe.ReplaceAllString(string(b), `"uuid":"<UUID>"`)
}

// TestMonitorTogglePairGolden pins the exact on-wire bytes against the captured
// Admin-Console messages (field order, null vs [] fidelity, enum-by-name). The
// captured pair for toggling monitoring OFF on devices [316, 1] is:
//   DEVICE_UPDATED_NOTIFICATION  { deviceIds:[316,1], restartService:false }
//   SPECIFY_RULE_UPDATED_NOTIFICATION { specifyRuleId:null }
func TestMonitorTogglePairGolden(t *testing.T) {
	const now int64 = 1784080284401
	req := MonitorTogglePairRequest{
		Topic:          "liz.message.pipeline",
		DeviceIds:      []int64{316, 1},
		RestartService: false,
	}
	dev, spec := req.build(now)

	devJSON, err := json.Marshal(dev)
	if err != nil {
		t.Fatalf("marshal dev: %v", err)
	}
	specJSON, err := json.Marshal(spec)
	if err != nil {
		t.Fatalf("marshal spec: %v", err)
	}

	wantDev := `{"header":{"version":1,"time":1784080284401,"protocolCode":"DEVICE_UPDATED_NOTIFICATION","lizMessageType":"NOTIFICATION","recipientTypes":[],"recipientIds":[],"senderType":"ADMIN_CONSOLE","senderId":null,"lizUserId":null,"uuid":"<UUID>"},"deviceIds":[316,1],"restartService":false}`
	wantSpec := `{"header":{"version":1,"time":1784080284401,"protocolCode":"SPECIFY_RULE_UPDATED_NOTIFICATION","lizMessageType":"NOTIFICATION","recipientTypes":["ADMIN_CONSOLE","API_SERVER","ADMIN_MOBILE"],"recipientIds":[],"senderType":"ADMIN_CONSOLE","senderId":null,"lizUserId":null,"uuid":"<UUID>"},"specifyRuleId":null}`

	if got := normalizeUUID(devJSON); got != wantDev {
		t.Errorf("DEVICE_UPDATED mismatch:\n got: %s\nwant: %s", got, wantDev)
	}
	if got := normalizeUUID(specJSON); got != wantSpec {
		t.Errorf("SPECIFY_RULE mismatch:\n got: %s\nwant: %s", got, wantSpec)
	}

	// The two messages of a pair must share one time and carry distinct uuids.
	if dev.Header.Time != spec.Header.Time {
		t.Errorf("pair time mismatch: dev=%d spec=%d", dev.Header.Time, spec.Header.Time)
	}
	if dev.Header.Uuid == spec.Header.Uuid {
		t.Errorf("pair uuids must differ, both = %s", dev.Header.Uuid)
	}
}

// TestMonitorToggleOnRestartTrue confirms the ON path stamps restartService=true.
func TestMonitorToggleOnRestartTrue(t *testing.T) {
	req := MonitorTogglePairRequest{DeviceIds: []int64{7}, RestartService: true}
	dev, _ := req.build(1700000000000)
	b, _ := json.Marshal(dev)
	if !regexp.MustCompile(`"restartService":true`).Match(b) {
		t.Errorf("expected restartService:true, got %s", b)
	}
}
