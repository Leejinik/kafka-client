# Project Status

Last updated: 2026-06-12

## Implemented feature inventory

### Profiles + Connection (M1)
- [x] CRUD via `~/.kafka-client/profiles.json` (`internal/profile`)
- [x] Multi-cluster simultaneous connections
- [x] JSON import/export (Settings tab)
- [x] Connection test before save
- [x] Sidebar right-click → 수정 / 삭제 (replaces top-bar buttons)
- [x] Host alias dial-time rewrites — no `/etc/hosts` editing needed (`Profile.HostAliases`)
- [x] SaveProfile auto-disconnects so next Connect picks up new aliases / bootstrap

### Topics (M1 + drill-down)
- [x] Topic list with 이름 / 파티션 / 복제수 / 내부 / Consumer Groups / msg/sec columns
- [x] Internal topics shown (`ListTopicsWithInternal`)
- [x] **Tree expansion** per topic
  - [x] Partition table: leader (bold), replicas (leader underlined, non-ISR red, offline orange), ISR, offline replicas
  - [x] Consumer groups: state color-coded, members + assigned partitions for THIS topic, per-partition committed/end/lag (>1000 warn, <0 error)
- [x] **Right-click context menu**: 토픽 생성 / 수정 / 삭제
- [x] Create dialog (partitions, replication factor, free-form config rows with autocomplete on common keys)
- [x] Edit dialog (current configs preloaded; partition increase only; changed cells highlighted; incremental alter)
- [x] Delete dialog ("모든 데이터가 삭제될 수 있습니다" warning, 취소 / 확인)
- [x] **Partition reassign dialog**: Replicas chips drag-to-reorder (dnd-kit) + click-chip → swap broker popover; preferred-leader = first chip; changed rows highlighted with `✱`; "변경된 행만 보기" toggle; per-row + global reset; submits only changed partitions via `kadm.AlterPartitionAssignments`
- [x] **In-flight reassignment badge** on Topics rows (polls `ListPartitionReassignments` on the same 10s tick, for expanded topics)
- [x] **Consumer-group admin** (right-click a GroupCard in the expanded view):
  - [x] Delete consumer group (`kadm.DeleteGroups`) — blocked in UI for active states
  - [x] Reset offsets for the current topic — modes: earliest / latest / by-timestamp / per-partition explicit. Implemented as `kadm.CommitOffsets` over offsets resolved via `ListStartOffsets` / `ListEndOffsets` / `ListOffsetsAfterMilli`. Timestamp-mode partitions with no record at-or-after the timestamp fall back to end-offset.
- [x] msg/sec rate (`MessageRates`: HWM - offset(now-60s)) per topic
- [x] **Controller broker ID** shown next to cluster name in top bar
- [x] **10s auto-refresh** on this tab only; cleanup on unmount stops polling

### Consume (M1)
- [x] Modes: 처음부터 / 끝에서 / 오프셋 지정 / 타임스탬프 지정 — **always resolved to numeric offsets** via kadm (avoids `kgo.AtStart`/`AtEnd` resolution bug)
- [x] 끝에서 = last `maxMessages / numPartitions` per partition (not just HWM-1)
- [x] Up to 50,000 records per fetch; virtual scroll for table body
- [x] Search: regex / substring on key / value / headers + case-sensitive option
- [x] JSON export of filtered results
- [x] Detail panel: partition / offset / timestamp ISO / key / pretty-JSON value / headers
- [x] Binary payloads → hex preview inline + base64 in detail panel
- [x] **Resizable grid columns** with visible separator borders + double-click reset
- [x] **Resizable preview panel** (drag splitter at its left edge; double-click reset)
- [x] Value column auto-fills remaining width (responds to window resize)
- [x] Topic selection shared with Produce tab

### Produce (M1)
- [x] Single-message send (key / value / headers / partition)
- [x] First-visit dismissible help banner ("?" button to reopen later)
- [x] Topic selection shared with Consume

### Standalone Unix timestamp calculator (v1.0.0_18)
- [x] **Calculator mode** entered from the disconnected placeholder ("Unix 타임스탬프 계산기" button)
- [x] Drops the entire Kafka chrome (sidebar / topbar / tabs) — renders only the `TimestampConverter` card, centered full-window
- [x] Shrinks the OS window to `CALC_WIN` (420×300) via Wails `WindowSetSize` + `WindowCenter`; restores to `APP_WIN` (1280×820) on exit
- [x] **"항상 위" (always-on-top)** checkbox — `WindowSetAlwaysOnTop`; auto-cleared on exit
- [x] "Kafka Client 모드로 전환" button (in the converter header, next to [지금]) returns to the full app
- [x] `TimestampConverter` gained optional `headerButton` / `footer` props so the same component serves both the Consume panel and the standalone mode
- [x] Initial-mount guard so launch never recenters/resizes the window

### Settings
- [x] ko / en language toggle (no restart)
- [x] Config folder path display
- [x] Profile JSON import / export

### Layout
- [x] **Resizable sidebar** (180–520 px, default 260, double-click reset)
- [x] **Resizable preview panel** in Consume (220–900 px, default 380)
- [x] All UI sizes persisted in `localStorage`
- [x] Light theme only (dark theme = future)

## Known gotchas

1. **Cluster IP flapping seen on a VIP-fronted cluster**: same `IP:port` can return different `cluster.id` over time, suggesting a VIP / NAT layer. Use host aliases against actual broker IPs to keep metadata consistent. franz-go picks one of the seed brokers per metadata refresh, so a mismatched seed will sometimes surface the "wrong" cluster's topic list.
2. **`kgo.Offset.AtStart()/AtEnd().Relative(-N)` does not resolve correctly** on certain Kafka deployments — manifests as `context deadline exceeded` (partition `-1`). Always pre-resolve via kadm and pass `At(N)`. Done in `consumer.go`.
3. **`ListTopics` excludes internal topics** by default. We use `ListTopicsWithInternal`. Reverting silently would empty the 내부 column.
4. **Editing profile while connected**: the old `kgo.Client` keeps its old dialer. `SaveProfile` auto-disconnects to avoid this.
5. **Wails cross-compile darwin from Windows is not supported.** Need to build `.app` on a Mac.
6. **Compacted topics**: msg/sec based on `(end - past)` overcounts when retention has compacted out earlier offsets (Kafka general limitation).
7. **macOS Gatekeeper**: unsigned `.app` requires right-click → Open on first launch (or `xattr -dr com.apple.quarantine`). Apple Developer signing not done.
8. **Windows SmartScreen**: same — "추가 정보" → "실행" first time, or `Unblock-File`. Not code-signed.

## Distribution

- **Windows**: `build/bin/kafka-client.exe` (≈18 MB) zipped with `README.txt` containing SmartScreen / WebView2 hints. Latest zip: `C:\Users\logan.lee\Desktop\kafka-client-win.zip` (6.3 MB).
- **macOS**: source zip handoff (`C:\Users\logan.lee\Desktop\kafka-client-source.zip`, ~376 KB) for the recipient to build with `wails build -platform darwin/universal`.

## Roadmap (next likely work)

### M2 candidates
- Schema Registry + Avro decoder
- Protobuf decoding from user-supplied `.proto`
- Live tail (push events from Go to JS via Wails Events)
- Dark theme

### M3 candidates
- Consumer-group offset reset / delete actions
- Producer templates
- CSV / JSON bulk file produce
- Dashboard tab (throughput / lag time-series charts)

### Polish
- Apply visible-column-borders / resizable-grid pattern to Topics tree rows
- Topic settings dialog: validate values per-key (`retention.ms` numeric, `cleanup.policy` enum)
- Keyboard shortcuts (search focus, tab switch)
- Error retry UX (network blip toast with manual retry)

## Decisions log

| When         | Decision                                                                  | Why                                                                                          |
|--------------|---------------------------------------------------------------------------|----------------------------------------------------------------------------------------------|
| early M1     | Go + Wails v2 + franz-go (over Kotlin/Compose, Tauri/Rust, Electron)      | Single static binary, pure Go Kafka client, smallest deliverable                              |
| M1           | Explicit numeric offsets via kadm                                         | `kgo.AtStart/AtEnd().Relative()` failed silently against the target cluster                   |
| M1           | Host aliases on the Profile struct + per-client dialer                    | User cluster advertises hostnames the user's machine cannot resolve                          |
| M1           | Auto-disconnect on SaveProfile                                            | Stale dialer was being reused after alias edits                                              |
| M1           | Topics auto-refresh tied to component mount (TopicsPage only)             | Stop polling when user navigates away; no background work / battery drain                    |
| M1           | Lift selected topic to App.tsx, share between Consume/Produce             | UX — picking once should apply both                                                          |
| M1           | Sidebar right-click instead of top-bar buttons                            | Reduces topbar noise, matches user mental model                                              |
| polish       | `.col-resizer` is invisible + th `border-right` provides visible line     | Border = discoverability, transparent hit area = generous click target                       |
| 2026-05-19   | Partition reassign uses chips + drag-to-reorder, not a JSON editor or matrix | User workflow was JSON + `kafka-reassign-partitions.sh --execute`; GUI just removes the script step. Chips give same primitives (leader = first replica, order = preference) with a 50-partition-friendly bulk edit affordance |
| 2026-05-19   | Reassign IPC submits only changed partitions, not all                     | `AlterPartitionAssignments` accepts a subset; sending all 50 when 3 changed would needlessly trigger controller work and obscure diffs |
| 2026-05-19   | Group offset reset scoped to the topic the GroupCard sits under, not all topics the group consumes | UI context = a specific topic's expand area; cross-topic scope would surprise the user. Matches `kafka-consumer-groups.sh --topic` flag |
| 2026-05-19   | Active groups blocked in UI before the broker error                       | Kafka returns UNKNOWN_MEMBER_ID / REBALANCE_IN_PROGRESS on delete/commit while members are live. Pre-emptive disable is clearer than surfacing the raw error |
| 2026-06-12   | Standalone calculator mode does a full-window takeover (early return before `app-root`), not an in-content panel | User wanted the converter "꽉 차게" with all Kafka UI gone. Resizing the OS window to match (via Wails runtime) makes it a genuine compact utility, not a tab |
| 2026-06-12   | Toolbar number inputs got visible inline labels (`.toolbar-field`), tooltips removed | `title` tooltips only appear on hover — users couldn't tell 메시지 수 / 타임아웃 / 파티션 apart at a glance |
| 2026-05-19   | Topics tab split into FAST (1s) + SLOW (10s) tick                          | User wanted near-real-time feel. Per-partition state + reassignment progress + msg/sec moved to 1s; `ListTopics` + `ListGroupsForTopic` (which calls `kadm.Lag(all)` and is the only expensive call) stayed at 10s. In-flight guard drops overlapping ticks |

## Useful paths

```
C:\Users\logan.lee\Desktop\kafka-client\               source root
  build\bin\kafka-client.exe                           current Windows build
  ~/.kafka-client/profiles.json                        runtime user config
C:\Users\logan.lee\Desktop\kafka-client-source.zip     macOS handoff
C:\Users\logan.lee\Desktop\kafka-client-win.zip        Windows distribution zip
C:\Users\logan.lee\.claude\plans\kafka-client-hashed-kurzweil.md   original spec / SRS
```
