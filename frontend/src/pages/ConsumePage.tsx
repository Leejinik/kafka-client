import { useEffect, useMemo, useRef, useState } from "react";
import { Lang, t } from "../lib/i18n";
import { errString } from "../lib/errors";
import { Consume, ListTopics } from "../../wailsjs/go/main/App";
import { kafka } from "../../wailsjs/go/models";
import {
    ColumnDef,
    ResizableTh,
    VerticalSplitter,
    useColumnWidths,
    useResizableWidth,
} from "../components/ResizableColumns";
import { ContextMenu } from "../components/ContextMenu";
import { SaveMessageDialog } from "../components/SaveMessageDialog";
import { TimestampConverter } from "../components/TimestampConverter";
import { formatLocalHuman, withMsTooltips } from "../lib/formatTime";

const COLUMNS: ColumnDef[] = [
    { key: "p",         label: "P",         defaultWidth: 60,  minWidth: 40 },
    { key: "offset",    label: "Offset",    defaultWidth: 110, minWidth: 70 },
    { key: "timestamp", label: "Timestamp", defaultWidth: 170, minWidth: 110 },
    { key: "key",       label: "Key",       defaultWidth: 160, minWidth: 60 },
    { key: "value",     label: "Value",     defaultWidth: 480, minWidth: 80, grow: true },
];

interface Props {
    lang: Lang;
    profileId: string;
    defaultTopic?: string;
    topic: string;
    onTopicChange: (topic: string) => void;
}

type Mode = "beginning" | "end" | "offset" | "timestamp";
type Target = "value" | "key" | "headers";
type TsFormat = "local" | "unix";

const ROW_HEIGHT = 28;
const TS_FORMAT_KEY = "consume.tsFormat";

export function ConsumePage({ lang, profileId, defaultTopic, topic, onTopicChange }: Props) {
    const [topics, setTopics] = useState<string[]>([]);
    const [mode, setMode] = useState<Mode>("end");
    const [offset, setOffset] = useState<string>("0");
    const [timestamp, setTimestamp] = useState<string>("");
    const [maxMessages, setMaxMessages] = useState<number>(1000);
    const [timeoutMs, setTimeoutMs] = useState<number>(8000);

    const [messages, setMessages] = useState<kafka.Message[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [search, setSearch] = useState("");
    const [target, setTarget] = useState<Target>("value");
    const [useRegex, setUseRegex] = useState(false);
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [tsFormat, setTsFormat] = useState<TsFormat>(() => {
        const v = localStorage.getItem(TS_FORMAT_KEY);
        return v === "unix" ? "unix" : "local";
    });
    const [tsCtxMenu, setTsCtxMenu] = useState<{ x: number; y: number } | null>(null);
    const [rowCtxMenu, setRowCtxMenu] = useState<{ x: number; y: number; message: kafka.Message } | null>(null);
    const [saveDialog, setSaveDialog] = useState<kafka.Message | null>(null);
    const [savedToast, setSavedToast] = useState<string | null>(null);
    // null = original fetch order; cycle: null → "desc" → "asc" → null on header click
    const [tsSort, setTsSort] = useState<"asc" | "desc" | null>(null);

    const cycleTsSort = () => {
        setTsSort((s) => (s === null ? "desc" : s === "desc" ? "asc" : null));
    };

    useEffect(() => { localStorage.setItem(TS_FORMAT_KEY, tsFormat); }, [tsFormat]);

    const openTsCtxMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setTsCtxMenu({ x: e.clientX, y: e.clientY });
    };
    const formatTs = (ms: number): string =>
        tsFormat === "unix" ? String(ms) : new Date(ms).toLocaleString();
    const [selected, setSelected] = useState<kafka.Message | null>(null);

    const scrollRef = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState<{ start: number; end: number }>({ start: 0, end: 60 });
    const { widths, setWidth, resetWidth } = useColumnWidths("kfc.consume.colWidths", COLUMNS);
    const fixedColsWidth = COLUMNS.filter((c) => !c.grow).reduce((sum, c) => sum + widths[c.key], 0);
    const preview = useResizableWidth("kfc.consume.previewWidth", 380);

    useEffect(() => {
        (async () => {
            try {
                const list = await ListTopics(profileId);
                setTopics(list.map((t) => t.name));
                if (!topic && defaultTopic && list.find((t) => t.name === defaultTopic)) {
                    onTopicChange(defaultTopic);
                } else if (!topic && list.length > 0) {
                    onTopicChange(list[0].name);
                }
            } catch (e) {
                setError(errString(e));
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [profileId]);

    const sortedMessages = useMemo(() => {
        if (!tsSort) return messages;
        const arr = [...messages];
        arr.sort((a, b) =>
            tsSort === "asc" ? a.timestampMs - b.timestampMs : b.timestampMs - a.timestampMs,
        );
        return arr;
    }, [messages, tsSort]);

    const filtered = useMemo(() => {
        const q = search.trim();
        if (!q) return sortedMessages;
        let matcher: (s: string) => boolean;
        if (useRegex) {
            try {
                const re = new RegExp(q, caseSensitive ? "" : "i");
                matcher = (s) => re.test(s);
            } catch {
                return sortedMessages;
            }
        } else {
            const needle = caseSensitive ? q : q.toLowerCase();
            matcher = (s) => (caseSensitive ? s : s.toLowerCase()).includes(needle);
        }
        return sortedMessages.filter((m) => {
            if (target === "value") return matcher(m.value);
            if (target === "key") return matcher(m.key);
            return Object.entries(m.headers).some(([k, v]) => matcher(`${k}=${v}`));
        });
    }, [sortedMessages, search, useRegex, caseSensitive, target]);

    const visible = filtered.slice(viewport.start, viewport.end);
    const padTop = viewport.start * ROW_HEIGHT;
    const padBottom = Math.max(0, (filtered.length - viewport.end) * ROW_HEIGHT);

    const onScroll = () => {
        const el = scrollRef.current;
        if (!el) return;
        const start = Math.max(0, Math.floor(el.scrollTop / ROW_HEIGHT) - 10);
        const end = Math.min(filtered.length, start + Math.ceil(el.clientHeight / ROW_HEIGHT) + 20);
        setViewport({ start, end });
    };

    const handleFetch = async () => {
        if (!topic) return;
        setLoading(true);
        setError(null);
        try {
            let ts = 0;
            if (mode === "timestamp" && timestamp.trim()) {
                const n = Number(timestamp);
                if (!Number.isNaN(n) && n > 0) ts = Math.floor(n);
                else {
                    const parsed = Date.parse(timestamp);
                    if (!Number.isNaN(parsed)) ts = parsed;
                }
            }
            const opts = kafka.ConsumeOptions.createFrom({
                topic,
                mode,
                offset: mode === "offset" ? Number(offset) || 0 : 0,
                timestampMs: ts,
                maxMessages,
                timeoutMs,
            });
            const out = await Consume(profileId, opts);
            setMessages(out);
            setSelected(out.length > 0 ? out[0] : null);
            setViewport({ start: 0, end: Math.min(out.length, 60) });
            if (scrollRef.current) scrollRef.current.scrollTop = 0;
        } catch (e) {
            setError(errString(e));
        } finally {
            setLoading(false);
        }
    };

    const handleExport = () => {
        const data = JSON.stringify(filtered, null, 2);
        const blob = new Blob([data], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${topic || "messages"}_${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const formatJson = (s: string) => {
        try {
            const v = JSON.parse(s);
            return JSON.stringify(v, null, 2);
        } catch {
            return s;
        }
    };

    return (
        <div className="page">
            <div className="page-toolbar">
                <select value={topic} onChange={(e) => onTopicChange(e.target.value)} style={{ width: 260 }}>
                    {topics.map((tn) => (
                        <option key={tn} value={tn}>{tn}</option>
                    ))}
                </select>
                <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} style={{ width: 140 }}>
                    <option value="beginning">{t(lang, "consume.mode.beginning")}</option>
                    <option value="end">{t(lang, "consume.mode.end")}</option>
                    <option value="offset">{t(lang, "consume.mode.offset")}</option>
                    <option value="timestamp">{t(lang, "consume.mode.timestamp")}</option>
                </select>
                {mode === "offset" && (
                    <input
                        style={{ width: 120 }}
                        placeholder={t(lang, "consume.offset")}
                        value={offset}
                        onChange={(e) => setOffset(e.target.value)}
                    />
                )}
                {mode === "timestamp" && (
                    <input
                        style={{ width: 220 }}
                        placeholder={t(lang, "consume.timestamp")}
                        value={timestamp}
                        onChange={(e) => setTimestamp(e.target.value)}
                    />
                )}
                <input
                    type="number"
                    title={t(lang, "consume.max")}
                    style={{ width: 90 }}
                    value={maxMessages}
                    onChange={(e) => setMaxMessages(Number(e.target.value) || 0)}
                />
                <input
                    type="number"
                    title={t(lang, "consume.timeout")}
                    style={{ width: 90 }}
                    value={timeoutMs}
                    onChange={(e) => setTimeoutMs(Number(e.target.value) || 0)}
                />
                <button className="primary" onClick={handleFetch} disabled={loading || !topic}>
                    {loading ? t(lang, "consume.fetching") : t(lang, "consume.fetch")}
                </button>
                <div className="grow" />
                <span className="count-pill">
                    {t(lang, "consume.shownOf", { shown: filtered.length, total: messages.length })}
                </span>
                <button onClick={handleExport} disabled={filtered.length === 0}>
                    {t(lang, "consume.export")}
                </button>
            </div>

            <div className="page-toolbar">
                <input
                    className="grow"
                    placeholder={t(lang, "consume.search")}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
                <select value={target} onChange={(e) => setTarget(e.target.value as Target)} style={{ width: 100 }}>
                    <option value="value">{t(lang, "consume.target.value")}</option>
                    <option value="key">{t(lang, "consume.target.key")}</option>
                    <option value="headers">{t(lang, "consume.target.headers")}</option>
                </select>
                <label className="checkbox">
                    <input type="checkbox" checked={useRegex} onChange={(e) => setUseRegex(e.target.checked)} />
                    {t(lang, "consume.regex")}
                </label>
                <label className="checkbox">
                    <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
                    {t(lang, "consume.case")}
                </label>
            </div>

            {error && <div style={{ color: "var(--danger)" }}>{error}</div>}

            <div
                className="split"
                style={{ gridTemplateColumns: `1fr 6px ${preview.width}px` }}
            >
                <div className="table-wrap" ref={scrollRef} onScroll={onScroll}>
                    <table className="resizable-grid" style={{ tableLayout: "fixed", width: "100%", minWidth: fixedColsWidth + (COLUMNS.find((c) => c.grow)?.minWidth ?? 80) }}>
                        <colgroup>
                            {COLUMNS.map((c) => (
                                <col key={c.key} style={c.grow ? undefined : { width: widths[c.key] }} />
                            ))}
                        </colgroup>
                        <thead>
                            <tr>
                                {COLUMNS.map((c) => (
                                    <ResizableTh
                                        key={c.key}
                                        column={c}
                                        width={widths[c.key]}
                                        onResize={(w) => setWidth(c.key, w)}
                                        onReset={() => resetWidth(c.key)}
                                        onContextMenu={c.key === "timestamp" ? openTsCtxMenu : undefined}
                                        onClick={c.key === "timestamp" ? cycleTsSort : undefined}
                                    >
                                        {c.key === "timestamp"
                                            ? `${c.label}${tsSort === "desc" ? " ▼" : tsSort === "asc" ? " ▲" : ""}`
                                            : c.label}
                                    </ResizableTh>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.length === 0 ? (
                                <tr>
                                    <td colSpan={COLUMNS.length} className="muted" style={{ textAlign: "center", padding: 20 }}>
                                        {t(lang, "consume.empty")}
                                    </td>
                                </tr>
                            ) : (
                                <>
                                    {padTop > 0 && <tr style={{ height: padTop }}><td colSpan={COLUMNS.length} /></tr>}
                                    {visible.map((m, i) => {
                                        const key = `${m.partition}-${m.offset}-${i + viewport.start}`;
                                        const isSel = selected && selected.partition === m.partition && selected.offset === m.offset;
                                        const cellStyle: React.CSSProperties = {
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                        };
                                        return (
                                            <tr
                                                key={key}
                                                className={isSel ? "selected" : ""}
                                                onClick={() => setSelected(m)}
                                                onContextMenu={(e) => {
                                                    e.preventDefault();
                                                    setSelected(m);
                                                    setRowCtxMenu({ x: e.clientX, y: e.clientY, message: m });
                                                }}
                                                style={{ height: ROW_HEIGHT }}
                                            >
                                                <td style={cellStyle}>{m.partition}</td>
                                                <td className="mono" style={cellStyle}>{m.offset}</td>
                                                <td className="mono" style={cellStyle} onContextMenu={openTsCtxMenu} title={formatLocalHuman(m.timestampMs)}>{formatTs(m.timestampMs)}</td>
                                                <td className="mono" style={cellStyle}>{m.key}</td>
                                                <td className="mono" style={cellStyle}>{withMsTooltips(m.value)}</td>
                                            </tr>
                                        );
                                    })}
                                    {padBottom > 0 && <tr style={{ height: padBottom }}><td colSpan={COLUMNS.length} /></tr>}
                                </>
                            )}
                        </tbody>
                    </table>
                </div>

                <VerticalSplitter
                    value={preview.width}
                    onChange={preview.setWidth}
                    min={220}
                    max={900}
                    direction="rtl"
                    onReset={preview.reset}
                />

                <div className="detail-panel" style={{ padding: 0 }}>
                    <div style={{ padding: 14, overflow: "auto", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                        {selected ? (
                            <>
                                <div className="detail-row">
                                    <span className="label">{t(lang, "consume.detail.partition")} / {t(lang, "consume.detail.offset")}</span>
                                    <span className="value">{selected.partition} / {selected.offset}</span>
                                </div>
                                <div className="detail-row">
                                    <span className="label">{t(lang, "consume.detail.timestamp")}</span>
                                    <span className="value">{new Date(selected.timestampMs).toISOString()}</span>
                                </div>
                                <div className="detail-row">
                                    <span className="label">{t(lang, "consume.detail.key")}</span>
                                    <span className="value">{selected.key || t(lang, "common.none")}</span>
                                </div>
                                <div className="detail-row">
                                    <span className="label">{t(lang, "consume.detail.value")}</span>
                                    <span className="value">{withMsTooltips(formatJson(selected.value))}</span>
                                </div>
                                <div className="detail-row">
                                    <span className="label">{t(lang, "consume.detail.headers")}</span>
                                    <span className="value">
                                        {Object.keys(selected.headers).length === 0
                                            ? t(lang, "common.none")
                                            : withMsTooltips(Object.entries(selected.headers).map(([k, v]) => `${k}=${v}`).join("\n"))}
                                    </span>
                                </div>
                            </>
                        ) : (
                            <div className="muted">{t(lang, "consume.empty")}</div>
                        )}
                    </div>

                    <TimestampConverter lang={lang} />
                </div>
            </div>

            {tsCtxMenu && (
                <ContextMenu
                    x={tsCtxMenu.x}
                    y={tsCtxMenu.y}
                    items={[
                        {
                            label: t(lang, "consume.ts.local") + (tsFormat === "local" ? "  ✓" : ""),
                            onClick: () => setTsFormat("local"),
                        },
                        {
                            label: t(lang, "consume.ts.unix") + (tsFormat === "unix" ? "  ✓" : ""),
                            onClick: () => setTsFormat("unix"),
                        },
                    ]}
                    onClose={() => setTsCtxMenu(null)}
                />
            )}

            {rowCtxMenu && (
                <ContextMenu
                    x={rowCtxMenu.x}
                    y={rowCtxMenu.y}
                    items={[
                        {
                            label: t(lang, "saved.menu.save"),
                            onClick: () => setSaveDialog(rowCtxMenu.message),
                        },
                    ]}
                    onClose={() => setRowCtxMenu(null)}
                />
            )}

            {saveDialog && (
                <SaveMessageDialog
                    lang={lang}
                    topic={topic}
                    message={saveDialog}
                    onClose={() => setSaveDialog(null)}
                    onSaved={(name) => {
                        setSaveDialog(null);
                        setSavedToast(t(lang, "saved.toast.saved", { name }));
                        window.setTimeout(() => setSavedToast(null), 2500);
                    }}
                />
            )}

            {savedToast && <div className="toast">{savedToast}</div>}
        </div>
    );
}

