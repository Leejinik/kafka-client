package kafka

import (
	"testing"

	"github.com/twmb/franz-go/pkg/kgo"
)

func TestBuildRecordMatcher(t *testing.T) {
	rec := &kgo.Record{
		Key:     []byte("Dev-7"),
		Value:   []byte("1643242492043, 456, 21.400000, 4885 °C"),
		Headers: []kgo.RecordHeader{{Key: "z", Value: []byte("1")}, {Key: "a", Value: []byte("Hello")}},
	}
	cases := []struct {
		name string
		opts SearchOptions
		want bool
	}{
		{"digits substring", SearchOptions{Query: "4885"}, true},
		{"trimmed query", SearchOptions{Query: "  4885 "}, true},
		{"miss", SearchOptions{Query: "78122"}, false},
		{"case-insensitive default", SearchOptions{Query: "°c"}, true},
		{"case-sensitive miss", SearchOptions{Query: "°c", CaseSensitive: true}, false},
		{"regex", SearchOptions{Query: `\b48\d\d\b`, Regex: true}, true},
		{"regex ignore case", SearchOptions{Query: `°c$`, Regex: true}, true},
		{"key target", SearchOptions{Query: "dev-7", Target: "key"}, true},
		{"value not in key", SearchOptions{Query: "4885", Target: "key"}, false},
		{"headers sorted k=v", SearchOptions{Query: "a=hello\nz=1", Target: "headers"}, true},
		{"cards OR of AND", SearchOptions{Cards: [][]string{{"nope"}, {"456", "4885"}}}, true},
		{"cards AND miss", SearchOptions{Cards: [][]string{{"456", "78122"}}}, false},
	}
	for _, c := range cases {
		m, err := buildRecordMatcher(c.opts)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got := m(rec); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
	for _, bad := range []SearchOptions{{Query: "  "}, {Cards: [][]string{{}}}, {Query: "(", Regex: true}} {
		if _, err := buildRecordMatcher(bad); err == nil {
			t.Errorf("expected error for %+v", bad)
		}
	}
}
