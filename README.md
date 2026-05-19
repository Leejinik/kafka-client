# Kafka Client

Cross-platform Kafka GUI tool. Single-binary on Windows (`.exe`, ~18 MB) and single-bundle on macOS (`.app`, universal binary).

> 자세한 모듈 구조는 [ARCHITECTURE.md](./ARCHITECTURE.md), 현재 기능 인벤토리와 알려진 함정은 [STATUS.md](./STATUS.md) 참고.

## Stack

- Go 1.22+
- Wails v2 (system webview: WebView2 on Windows, WKWebView on macOS)
- React + TypeScript (Vite)
- franz-go + kadm (pure Go Kafka client, no CGO)

## Prerequisites for building

### Windows
```powershell
winget install --id GoLang.Go -e
winget install --id OpenJS.NodeJS.LTS -e
$env:Path += ";$env:USERPROFILE\go\bin"
go install github.com/wailsapp/wails/v2/cmd/wails@latest
wails doctor
```

### macOS
```bash
xcode-select --install
brew install go node
go install github.com/wailsapp/wails/v2/cmd/wails@latest
echo 'export PATH="$HOME/go/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
wails doctor
```

> **Cross-compilation to darwin from Windows is NOT supported.** Build the `.app` on a Mac.

## Build

```powershell
# Windows (.exe)
wails build
# → build/bin/kafka-client.exe
```

```bash
# macOS (.app)
wails build -platform darwin/universal   # Intel + Apple Silicon
# or: darwin/arm64 (Apple Silicon only), darwin/amd64 (Intel only)
# → build/bin/kafka-client.app
```

## Develop

```bash
wails dev
```
Vite HMR for the frontend; Go runtime is exposed at <http://localhost:34115> for browser-attached devtools.

## Config storage

User profiles live in:
- Windows: `%USERPROFILE%\.kafka-client\profiles.json`
- macOS / Linux: `~/.kafka-client/profiles.json`

UI sizes (sidebar width, preview width, grid column widths) persist in WebView2/WKWebView `localStorage`.

## Features (current)

### Connection profiles
- Multi-cluster, multiple simultaneous connections
- JSON import/export from Settings tab
- **Host alias rewriting** (per profile): override broker-advertised hostnames at dial time, so users don't need to modify `/etc/hosts` for clusters that advertise internal hostnames (e.g. `broker-2`)
- Right-click sidebar item → 수정 / 삭제

### Topics tab
- Auto-refresh **every 10 seconds** while the tab is mounted; pauses on tab switch
- Columns: 이름 / 파티션 / 복제수 / 내부 / Consumer Groups / **msg/sec** (last 60 s window, refreshed every 10 s)
- Each topic row is a tree node; expanding shows:
  - **Partition table**: leader broker, ISR, replicas (leader underlined, missing-from-ISR colored), offline replicas
  - **Consumer Groups**: every group consuming the topic, with state (Stable / Empty / Dead color-coded), assignor protocol, coordinator broker, total lag
    - Per-group: member list (memberId / clientId / host / assigned partitions for THIS topic)
    - Per-partition lag table: committed / end offset / lag (>1000 = warn, <0 = error) / owning consumer
- **Right-click context menu**:
  - On topic row → 수정 / 삭제 (수정 dialog lists every topic-level config with current defaults; 삭제 confirmation warns "모든 데이터가 삭제될 수 있습니다")
  - On empty space / toolbar → 토픽 생성 (partitions, replication factor, optional configs)
- Top bar shows `cluster name (controller: B<n>)` — controller broker is also auto-refreshed every 10 s

### Consume tab
- Seek modes: `처음부터` / `끝에서` / `오프셋 지정` / `타임스탬프 지정`
- Up to 50,000 messages per fetch (virtual scroll table renders only visible rows)
- Search across key / value / headers with regex + case-sensitive options
- Decoders: plain text / JSON (auto pretty-print in detail panel) / binary hex preview
- **CSV/JSON Export** of filtered results
- **Resizable grid columns** with visible borders + double-click-to-reset
- **Resizable preview panel** (right side) with double-click reset
- Detail panel: partition / offset / timestamp / key / value (pretty JSON) / headers

### Produce tab
- Single-message send: key, value, headers (one `key=value` per line), partition (-1 = auto)
- **First-visit help banner** (dismissible, ? button to reopen)
- **Topic selection is shared with Consume**: picking a topic on one auto-selects on the other

### Settings tab
- Language toggle (ko / en) — i18n strings in `frontend/src/lib/i18n.ts`
- Config folder path
- Profile import / export

### Layout
- **Resizable sidebar** (180–520 px, double-click resets to 260)
- **Resizable preview panel** in Consume (220–900 px, double-click resets to 380)
- All sizes persist across restarts via `localStorage`

## What's intentionally NOT here (yet)

- Authentication: PLAINTEXT only. SASL/SSL/Kerberos = deferred
- Schema Registry / Avro / Protobuf decoding
- Live tail (server-push stream) — current "끝에서" mode polls
- Consumer-group offset reset / delete actions (read-only on groups for now)
- Producer templates / CSV bulk send
- Dashboard tab (throughput / lag time series)
- Dark theme
- Auto-update mechanism

See [STATUS.md](./STATUS.md#roadmap) for the next-up list.
