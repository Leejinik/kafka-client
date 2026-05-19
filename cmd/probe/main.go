// Throwaway diagnostic: produce one message directly via franz-go, bypassing
// the Wails GUI, so we can see the broker response with no UI layer.
//
// Before running, replace the placeholder IPs/hostnames below with your own
// cluster's (typically copied from ~/.kafka-client/profiles.json).
//
// Run with: go run ./cmd/probe
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"time"

	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
)

func main() {
	// Placeholder values — replace with your cluster's actual broker IPs.
	// 192.0.2.0/24 is the RFC 5737 documentation range and won't resolve.
	aliases := map[string]string{
		"broker-1": "192.0.2.10",
		"broker-2": "192.0.2.20",
		"broker-3": "192.0.2.30",
	}
	seeds := []string{
		"192.0.2.10:9092",
		"192.0.2.20:9093",
		"192.0.2.30:9094",
	}

	d := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	dialer := func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err == nil {
			if rep, ok := aliases[host]; ok {
				addr = net.JoinHostPort(rep, port)
			}
		}
		return d.DialContext(ctx, network, addr)
	}

	cl, err := kgo.NewClient(
		kgo.SeedBrokers(seeds...),
		kgo.ClientID("kafka-client-probe"),
		kgo.Dialer(dialer),
		kgo.DialTimeout(10*time.Second),
		kgo.MetadataMinAge(5*time.Second),
		// Broker has a broken xerial snappy native lib → NoCompression to bypass.
		kgo.ProducerBatchCompression(kgo.NoCompression()),
	)
	if err != nil {
		fmt.Fprintln(os.Stderr, "[fatal] newclient:", err)
		os.Exit(1)
	}
	defer cl.Close()

	pingCtx, pcancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer pcancel()
	if err := cl.Ping(pingCtx); err != nil {
		fmt.Fprintln(os.Stderr, "[fatal] ping:", err)
		os.Exit(1)
	}
	fmt.Println("[ok] connected")

	payload := map[string]any{
		"header": map[string]any{
			"version":        1,
			"time":           int64(1779150106153),
			"protocolCode":   "ALARM_OCCURED_NOTIFICATION",
			"lizMessageType": "NOTIFICATION",
			"recipientTypes": []string{},
			"recipientIds":   []string{},
			"senderType":     "COLLECTOR",
			"senderId":       9,
			"lizUserId":      nil,
			"uuid":           "0c18507b-ef20-404d-8fdc-756684d17aca",
		},
		"alarmId": 89485,
	}
	b, _ := json.Marshal(payload)
	fmt.Printf("[info] payload: %d bytes\n", len(b))
	fmt.Printf("[info] target topic: liz.message.pipeline (partition=-1)\n")

	rec := &kgo.Record{
		Topic:     "liz.message.pipeline",
		Value:     b,
		Partition: -1,
	}

	prodCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	r, err := cl.ProduceSync(prodCtx, rec).First()
	if err != nil {
		fmt.Fprintln(os.Stderr, "[err] produce:", err)
		var kfErr *kerr.Error
		if errors.As(err, &kfErr) {
			fmt.Fprintf(os.Stderr, "[err] code=%d name=%s retriable=%t\n", kfErr.Code, kfErr.Message, kfErr.Retriable)
			fmt.Fprintf(os.Stderr, "[err] description: %s\n", kfErr.Description)
		}
		os.Exit(2)
	}
	fmt.Printf("[ok] produced: partition=%d offset=%d timestamp=%s\n",
		r.Partition, r.Offset, r.Timestamp.Format(time.RFC3339))
}
