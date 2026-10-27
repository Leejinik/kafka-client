package kafka

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/twmb/franz-go/pkg/kgo"
)

// SearchOptions drives a server-side search: instead of fetching N records and
// filtering them in the UI, the topic is scanned until MaxMessages *matching*
// records are found (or the range / timeout runs out).
//
// Direction follows Mode:
//   - beginning / offsetAfter : scan forward from the start (or Offset), keep
//     the first MaxMessages matches.
//   - end / offsetBefore      : scan backward from the end (or Offset) in
//     growing windows, keep the newest MaxMessages matches.
//
// Matching mirrors the UI's search row: Query + Regex + CaseSensitive over
// Target ("value" | "key" | "headers"), or — when Cards is non-empty — the
// advanced-search rule (OR across cards, AND of case-insensitive tokens
// within a card).
type SearchOptions struct {
	Topic         string     `json:"topic"`
	Mode          SeekMode   `json:"mode"`
	Offset        int64      `json:"offset,omitempty"`
	MaxMessages   int        `json:"maxMessages"`
	TimeoutMs     int        `json:"timeoutMs"`
	Query         string     `json:"query"`
	Regex         bool       `json:"regex"`
	CaseSensitive bool       `json:"caseSensitive"`
	Target        string     `json:"target"`
	Cards         [][]string `json:"cards,omitempty"`
}

// SearchProgress is streamed while a search runs. Total is the number of
// records in the whole searchable range (start..end snapshot), so
// Scanned/Total is a true percentage even for backward scans.
type SearchProgress struct {
	Scanned int64 `json:"scanned"`
	Total   int64 `json:"total"`
	Matched int   `json:"matched"`
}

// SearchResult carries the matches plus why the scan stopped:
// "enough" (found MaxMessages), "exhausted" (whole range read),
// "timeout" or "canceled".
type SearchResult struct {
	Messages   []Message `json:"messages"`
	Scanned    int64     `json:"scanned"`
	Total      int64     `json:"total"`
	StopReason string    `json:"stopReason"`
}

const (
	// A poll that yields nothing for this long means the snapshot range has
	// no more readable records (e.g. the last offset is a transaction marker
	// or was compacted away, so the inclusive upper bound is never seen).
	// It must comfortably exceed the time to fetch *and decode* one fetch
	// (see searchFetchBytes) on a busy broker, or a slow first fetch is
	// mistaken for the end of the range and the scan returns 0 records.
	searchIdleTimeout = 10 * time.Second
	// Backward windows start small (a dense match is found fast) and double
	// per round so sparse matches don't cost thousands of client round-trips.
	searchChunkMin = 5000
	searchChunkMax = 2000000
	// Per-partition fetch size. Highly compressible topics unpack ~450k
	// records per MB (measured on peerliz.topic): 10MB fetches took several
	// seconds each to decode — tripping the idle check above — and backward
	// windows decoded millions of records past their upper bound only to drop
	// them. 1MB keeps each poll well under a second at the same throughput.
	searchFetchBytes = 1 << 20
)

// SearchConsume scans opts.Topic for records matching the search and returns
// up to opts.MaxMessages of them. onProgress (may be nil) is called at most
// every ~250ms and once at the end.
func (m *Manager) SearchConsume(ctx context.Context, profileID string, opts SearchOptions, onProgress func(SearchProgress)) (SearchResult, error) {
	if opts.Topic == "" {
		return SearchResult{}, errors.New("topic is required")
	}
	if opts.MaxMessages <= 0 {
		opts.MaxMessages = 1000
	}
	match, err := buildRecordMatcher(opts)
	if err != nil {
		return SearchResult{}, err
	}
	var forward bool
	switch opts.Mode {
	case SeekBeginning, "", SeekOffset, SeekOffsetAfter:
		forward = true
	case SeekEnd, SeekOffsetBefore:
		forward = false
	default:
		return SearchResult{}, fmt.Errorf("search not supported for mode %q", opts.Mode)
	}

	c, err := m.Get(profileID)
	if err != nil {
		return SearchResult{}, err
	}
	startMap, endMap, err := topicBounds(ctx, c, opts.Topic)
	if err != nil {
		return SearchResult{}, err
	}

	// Inclusive [lo, hi] per partition over the end-offset snapshot taken
	// above; records produced after the search started are not scanned.
	lo := map[int32]int64{}
	hi := map[int32]int64{}
	var total int64
	for pid, e := range endMap {
		l, h := startMap[pid], e-1
		switch opts.Mode {
		case SeekOffset, SeekOffsetAfter:
			if opts.Offset > l {
				l = opts.Offset
			}
		case SeekOffsetBefore:
			if opts.Offset < h {
				h = opts.Offset
			}
		}
		if l > h {
			continue
		}
		lo[pid], hi[pid] = l, h
		total += h - l + 1
	}

	// TimeoutMs <= 0 means no limit: the scan runs until enough matches,
	// the end of the range, or CancelConsume.
	dctx, dcancel := context.WithCancel(ctx)
	if opts.TimeoutMs > 0 {
		dctx, dcancel = context.WithTimeout(ctx, time.Duration(opts.TimeoutMs)*time.Millisecond)
	}
	defer dcancel()

	var scanned int64
	var out []Message
	lastTick := time.Now()
	tick := func(force bool) {
		if onProgress == nil || (!force && time.Since(lastTick) < 250*time.Millisecond) {
			return
		}
		lastTick = time.Now()
		onProgress(SearchProgress{Scanned: scanned, Total: total, Matched: len(out)})
	}

	if forward {
		ranges := map[int32][2]int64{}
		for pid := range lo {
			ranges[pid] = [2]int64{lo[pid], hi[pid]}
		}
		err = scanRanges(dctx, c, opts.Topic, ranges, searchFetchBytes, func(r *kgo.Record) bool {
			scanned++
			if match(r) {
				out = append(out, recordToMessage(r))
			}
			tick(false)
			return len(out) < opts.MaxMessages
		})
	} else {
		upper := map[int32]int64{}
		for pid, h := range hi {
			upper[pid] = h
		}
		chunk := int64(searchChunkMin)
		for len(out) < opts.MaxMessages && dctx.Err() == nil {
			ranges := map[int32][2]int64{}
			for pid, u := range upper {
				if u < lo[pid] {
					continue
				}
				from := u - chunk + 1
				if from < lo[pid] {
					from = lo[pid]
				}
				ranges[pid] = [2]int64{from, u}
			}
			if len(ranges) == 0 {
				break
			}
			// A window is read forward, so its matches are collected whole
			// and then ordered newest-first before taking what's still needed.
			var round []Message
			err = scanRanges(dctx, c, opts.Topic, ranges, searchFetchBytes, func(r *kgo.Record) bool {
				scanned++
				if match(r) {
					round = append(round, recordToMessage(r))
				}
				tick(false)
				return true
			})
			sort.SliceStable(round, func(i, j int) bool { return newerFirst(round[i], round[j]) })
			for _, msg := range round {
				if len(out) >= opts.MaxMessages {
					break
				}
				out = append(out, msg)
			}
			if err != nil {
				break
			}
			for pid, rg := range ranges {
				upper[pid] = rg[0] - 1
			}
			if chunk *= 2; chunk > searchChunkMax {
				chunk = searchChunkMax
			}
		}
		// Display oldest → newest, like the plain Newest fetch.
		sort.SliceStable(out, func(i, j int) bool { return newerFirst(out[j], out[i]) })
	}
	tick(true)

	res := SearchResult{Messages: out, Scanned: scanned, Total: total}
	switch {
	case len(out) >= opts.MaxMessages:
		res.StopReason = "enough"
	case ctx.Err() != nil:
		res.StopReason = "canceled"
	case dctx.Err() != nil:
		res.StopReason = "timeout"
	default:
		res.StopReason = "exhausted"
	}
	if res.Messages == nil {
		res.Messages = []Message{}
	}
	return res, err
}

func newerFirst(a, b Message) bool {
	if a.TimestampMs != b.TimestampMs {
		return a.TimestampMs > b.TimestampMs
	}
	if a.Partition != b.Partition {
		return a.Partition > b.Partition
	}
	return a.Offset > b.Offset
}

// topicBounds returns the start and end offsets of every partition of topic.
func topicBounds(ctx context.Context, c *Client, topic string) (map[int32]int64, map[int32]int64, error) {
	bctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	topics, err := c.adm.ListTopics(bctx, topic)
	if err != nil {
		return nil, nil, fmt.Errorf("list topic: %w", err)
	}
	td, ok := topics[topic]
	if !ok {
		return nil, nil, fmt.Errorf("topic %s not found", topic)
	}
	if td.Err != nil {
		return nil, nil, fmt.Errorf("topic %s: %w", topic, td.Err)
	}
	if len(td.Partitions) == 0 {
		return nil, nil, fmt.Errorf("topic %s has no partitions", topic)
	}
	startOffs, err := c.adm.ListStartOffsets(bctx, topic)
	if err != nil {
		return nil, nil, fmt.Errorf("start offsets: %w", err)
	}
	endOffs, err := c.adm.ListEndOffsets(bctx, topic)
	if err != nil {
		return nil, nil, fmt.Errorf("end offsets: %w", err)
	}
	starts := map[int32]int64{}
	ends := map[int32]int64{}
	for pid, o := range startOffs.Offsets()[topic] {
		starts[pid] = o.At
	}
	for pid, o := range endOffs.Offsets()[topic] {
		ends[pid] = o.At
	}
	return starts, ends, nil
}

// scanRanges reads every record with lo <= offset <= hi for each partition in
// ranges and passes it to visit; visit returning false stops the scan.
// Returns nil on ctx cancellation (the caller inspects ctx itself).
func scanRanges(ctx context.Context, c *Client, topic string, ranges map[int32][2]int64, partBytes int32, visit func(*kgo.Record) bool) error {
	if len(ranges) == 0 {
		return nil
	}
	starts := map[int32]kgo.Offset{}
	pending := map[int32]bool{}
	for pid, rg := range ranges {
		starts[pid] = kgo.NewOffset().At(rg[0])
		pending[pid] = true
	}
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(c.servers...),
		kgo.ClientID("kafka-client-tool-search"),
		kgo.Dialer(aliasDialer(c.aliases, c.tlsConf)),
		kgo.ConsumePartitions(map[string]map[int32]kgo.Offset{topic: starts}),
		kgo.FetchMaxBytes(50<<20),
		kgo.FetchMaxPartitionBytes(partBytes),
		kgo.FetchMaxWait(500*time.Millisecond),
	)
	if err != nil {
		return fmt.Errorf("consumer client: %w", err)
	}
	defer cl.Close()

	for len(pending) > 0 {
		if ctx.Err() != nil {
			return nil
		}
		pollCtx, cancel := context.WithTimeout(ctx, searchIdleTimeout)
		fetches := cl.PollFetches(pollCtx)
		cancel()
		for _, fe := range fetches.Errors() {
			if errors.Is(fe.Err, context.DeadlineExceeded) || errors.Is(fe.Err, context.Canceled) {
				continue
			}
			return fmt.Errorf("fetch partition %d: %w", fe.Partition, fe.Err)
		}
		if fetches.NumRecords() == 0 {
			// Idle (or canceled): nothing left inside the snapshot ranges.
			return nil
		}
		stop := false
		fetches.EachRecord(func(r *kgo.Record) {
			if stop || !pending[r.Partition] {
				return
			}
			rg := ranges[r.Partition]
			if r.Offset < rg[0] {
				return
			}
			if r.Offset > rg[1] {
				delete(pending, r.Partition)
				return
			}
			if r.Offset == rg[1] {
				delete(pending, r.Partition)
			}
			if !visit(r) {
				stop = true
			}
		})
		if stop {
			return nil
		}
	}
	return nil
}

// buildRecordMatcher compiles the search in opts into a per-record predicate
// that agrees with the UI's client-side filter.
func buildRecordMatcher(opts SearchOptions) (func(*kgo.Record) bool, error) {
	hay := haystackFor(opts.Target)

	if len(opts.Cards) > 0 {
		var cards [][][]byte
		for _, card := range opts.Cards {
			var tokens [][]byte
			for _, t := range card {
				if t != "" {
					tokens = append(tokens, bytes.ToLower([]byte(t)))
				}
			}
			if len(tokens) > 0 {
				cards = append(cards, tokens)
			}
		}
		if len(cards) == 0 {
			return nil, errors.New("search is empty")
		}
		return func(r *kgo.Record) bool {
			h := bytes.ToLower(hay(r))
			for _, tokens := range cards {
				all := true
				for _, t := range tokens {
					if !bytes.Contains(h, t) {
						all = false
						break
					}
				}
				if all {
					return true
				}
			}
			return false
		}, nil
	}

	q := strings.TrimSpace(opts.Query)
	if q == "" {
		return nil, errors.New("search is empty")
	}
	if opts.Regex {
		pat := q
		if !opts.CaseSensitive {
			pat = "(?i)" + pat
		}
		re, err := regexp.Compile(pat)
		if err != nil {
			return nil, fmt.Errorf("regex: %w", err)
		}
		return func(r *kgo.Record) bool { return re.Match(hay(r)) }, nil
	}
	// A needle without letters ("4885") matches the same either way, so skip
	// lowercasing every record — it dominates CPU on multi-million scans.
	if opts.CaseSensitive || strings.ToLower(q) == strings.ToUpper(q) {
		needle := []byte(q)
		return func(r *kgo.Record) bool { return bytes.Contains(hay(r), needle) }, nil
	}
	needle := bytes.ToLower([]byte(q))
	return func(r *kgo.Record) bool { return bytes.Contains(bytes.ToLower(hay(r)), needle) }, nil
}

// haystackFor returns the bytes the UI would match against for target:
// value/key as displayed (hex preview for binary), headers as sorted "k=v"
// lines.
func haystackFor(target string) func(*kgo.Record) []byte {
	display := func(b []byte) []byte {
		if utf8.Valid(b) {
			return b
		}
		s, _ := bytesToString(b)
		return []byte(s)
	}
	switch target {
	case "key":
		return func(r *kgo.Record) []byte { return display(r.Key) }
	case "headers":
		return func(r *kgo.Record) []byte {
			hm := headerMap(r.Headers)
			keys := make([]string, 0, len(hm))
			for k := range hm {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			lines := make([]string, len(keys))
			for i, k := range keys {
				lines[i] = k + "=" + hm[k]
			}
			return []byte(strings.Join(lines, "\n"))
		}
	default:
		return func(r *kgo.Record) []byte { return display(r.Value) }
	}
}
