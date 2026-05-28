import { useEffect, useMemo, useRef, useState } from "react";
import { Lang, t } from "../lib/i18n";
import { errString } from "../lib/errors";
import { CancelConsume, Consume, ConsumeRange, ListTopics, StartTailConsume } from "../../wailsjs/go/main/App";
import { EventsOff, EventsOn } from "../../wailsjs/runtime";
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
    { key: "idx",       label: "#",         defaultWidth: 56,  minWidth: 40 },
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

type Mode = "beginning" | "end" | "offsetAfter" | "offsetBefore" | "timestamp" | "tail";

// Defaults the form returns to after a tail session stops.
const DEFAULT_MODE: Mode = "end";
const DEFAULT_MAX = 1000;
const DEFAULT_TIMEOUT = 8000;
type Target = "value" | "key" | "headers";
type TsFormat = "local" | "unix";

const ROW_HEIGHT = 28;
const TS_FORMAT_KEY = "consume.tsFormat";

export function ConsumePage({ lang, profileId, defaultTopic, topic, onTopicChange }: Props) {
    const [topics, setTopics] = useState<string[]>([]);
    const [mode, setMode] = useState<Mode>(DEFAULT_MODE);
    const [offset, setOffset] = useState<string>("0");
    const [timestampStart, setTimestampStart] = useState<string>("");
    const [timestampEnd, setTimestampEnd] = useState<string>("");
    const [maxMessages, setMaxMessages] = useState<number>(DEFAULT_MAX);
    const [timeoutMs, setTimeoutMs] = useState<number>(DEFAULT_TIMEOUT);

    // Pagination state for timestamp-range mode. pageCursors[i] is the
    // cursor needed to (re)fetch page i; pageCursors[0] is always [] (the
    // request resolves from StartMs). pageSizes[i] is the result count of
    // page i — used only on backward navigation to know how far to step
    // currentPageStart. currentPageStart is the 0-based index of the first
    // record on the current page, used by the # column. totalCount /
    // totalPages come from the first page response.
    const [pageCursors, setPageCursors] = useState<kafka.CursorEntry[][]>([]);
    const [pageSizes, setPageSizes] = useState<number[]>([]);
    const [pageIdx, setPageIdx] = useState(0);
    const [nextCursor, setNextCursor] = useState<kafka.CursorEntry[] | null>(null);
    const [currentPageStart, setCurrentPageStart] = useState(0);
    const [totalCount, setTotalCount] = useState<number | null>(null);
    const totalPages = totalCount !== null && maxMessages > 0
        ? Math.max(1, Math.ceil(totalCount / maxMessages))
        : null;

    const [messages, setMessages] = useState<kafka.Message[]>([]);
    const [loading, setLoading] = useState(false);
    const [tailing, setTailing] = useState(false);
    // While true (and tailing), new messages pin the view to the bottom.
    // Mouse-wheeling pauses follow; Shift+G resumes it.
    const [follow, setFollow] = useState(true);
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
    // null = original fetch order. Only one column sorted at a time.
    // Cycle on header click: null → desc → asc → null.
    type SortKey = "timestamp" | "offset";
    const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);

    const cycleSort = (key: SortKey) => {
        setSort((s) => {
            if (!s || s.key !== key) return { key, dir: "desc" };
            if (s.dir === "desc") return { key, dir: "asc" };
            return null;
        });
    };
    const sortArrow = (key: SortKey) =>
        sort?.key === key ? (sort.dir === "desc" ? " ▼" : " ▲") : "";

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

    // Tail -f event subscription. One subscription per profile lifetime.
    useEffect(() => {
        if (!profileId) return;
        const batchEvent = `consume.tail.batch:${profileId}`;
        const stopEvent = `consume.tail.stopped:${profileId}`;
        EventsOn(batchEvent, (batch: kafka.Message[]) => {
            if (!batch || batch.length === 0) return;
            setMessages((prev) => prev.concat(batch));
        });
        EventsOn(stopEvent, (errMsg: string) => {
            setTailing(false);
            if (errMsg) setError(errMsg);
            // Form returns to the initial defaults — but the messages stay.
            setMode(DEFAULT_MODE);
            setMaxMessages(DEFAULT_MAX);
            setTimeoutMs(DEFAULT_TIMEOUT);
        });
        return () => {
            EventsOff(batchEvent);
            EventsOff(stopEvent);
        };
    }, [profileId]);

    // Auto-start tail the moment the user picks the tail mode.
    useEffect(() => {
        if (mode !== "tail" || !topic || !profileId) return;
        let cancelled = false;
        setMessages([]);
        setSelected(null);
        setError(null);
        setTailing(true);
        setFollow(true);
        StartTailConsume(profileId, topic).catch((e) => {
            if (cancelled) return;
            setTailing(false);
            setError(errString(e));
        });
        return () => {
            cancelled = true;
        };
    }, [mode, topic, profileId]);

    // Pin to bottom whenever the message list grows while following.
    useEffect(() => {
        if (!tailing || !follow) return;
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [messages, tailing, follow]);

    // Any wheel interaction pauses follow. (deltaY != 0 covers both
    // directions; scrolling down at the bottom is a no-op visually but
    // we still pause so behaviour is predictable.)
    useEffect(() => {
        if (!tailing) return;
        const el = scrollRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            if (e.deltaY !== 0) setFollow(false);
        };
        el.addEventListener("wheel", onWheel, { passive: true });
        return () => el.removeEventListener("wheel", onWheel);
    }, [tailing]);

    // Shift+G snaps to bottom and resumes follow. Ignored while typing in
    // a field so the search/offset inputs accept literal "G".
    useEffect(() => {
        if (!tailing) return;
        const onKey = (e: KeyboardEvent) => {
            if (!e.shiftKey) return;
            if (e.key !== "G" && e.key !== "g" && e.code !== "KeyG") return;
            const tag = (document.activeElement?.tagName || "").toLowerCase();
            if (tag === "input" || tag === "textarea" || tag === "select") return;
            e.preventDefault();
            setFollow(true);
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [tailing]);

    // Easter egg: Ctrl+C stops tail like SIGINT in a real shell. Skip when
    // text is selected or an input has focus so normal copy still works.
    useEffect(() => {
        if (!tailing) return;
        const onKey = (e: KeyboardEvent) => {
            if (!e.ctrlKey) return;
            if (e.key !== "c" && e.key !== "C" && e.code !== "KeyC") return;
            const tag = (document.activeElement?.tagName || "").toLowerCase();
            if (tag === "input" || tag === "textarea") return;
            const sel = window.getSelection();
            if (sel && sel.toString().length > 0) return;
            e.preventDefault();
            void CancelConsume(profileId);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [tailing, profileId]);

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
        if (!sort) return messages;
        const arr = [...messages];
        const cmp = (a: kafka.Message, b: kafka.Message) => {
            if (sort.key === "offset") {
                if (a.partition !== b.partition) return a.partition - b.partition;
                return Number(a.offset - b.offset);
            }
            return a.timestampMs - b.timestampMs;
        };
        arr.sort((a, b) => (sort.dir === "asc" ? cmp(a, b) : -cmp(a, b)));
        return arr;
    }, [messages, sort]);

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

    // Parse an ISO string or numeric ms into a unix-ms number, or 0 if blank/invalid.
    const parseTs = (raw: string): number => {
        const s = raw.trim();
        if (!s) return 0;
        const n = Number(s);
        if (!Number.isNaN(n) && n > 0) return Math.floor(n);
        const parsed = Date.parse(s);
        return Number.isNaN(parsed) ? 0 : parsed;
    };

    const fetchRangePage = async (cursor: kafka.CursorEntry[], fromEnd = false) => {
        const start = parseTs(timestampStart);
        if (start <= 0) throw new Error(t(lang, "consume.timestamp.start"));
        const end = parseTs(timestampEnd); // 0 means "no end cap"
        const opts = kafka.ConsumeRangeOptions.createFrom({
            topic,
            startMs: start,
            endMs: end,
            maxMessages,
            timeoutMs,
            cursor: fromEnd ? [] : cursor,
            fromEnd,
        });
        return await ConsumeRange(profileId, opts);
    };

    const handleFetch = async () => {
        if (!topic || mode === "tail") return;
        setLoading(true);
        setError(null);
        try {
            if (mode === "timestamp") {
                const page = await fetchRangePage([]);
                const size = page.messages?.length || 0;
                setMessages(page.messages || []);
                setSelected(size > 0 ? page.messages[0] : null);
                setPageCursors([[]]);
                setPageSizes([size]);
                setPageIdx(0);
                setCurrentPageStart(0);
                setTotalCount(page.totalCount >= 0 ? page.totalCount : null);
                setNextCursor(page.done ? null : page.cursor);
                setViewport({ start: 0, end: Math.min(size, 60) });
                if (scrollRef.current) scrollRef.current.scrollTop = 0;
                return;
            }
            const opts = kafka.ConsumeOptions.createFrom({
                topic,
                mode,
                offset: mode === "offsetAfter" || mode === "offsetBefore" ? Number(offset) || 0 : 0,
                timestampMs: 0,
                maxMessages,
                timeoutMs,
            });
            const out = await Consume(profileId, opts);
            setMessages(out);
            setSelected(out.length > 0 ? out[0] : null);
            setPageCursors([]);
            setPageSizes([]);
            setPageIdx(0);
            setCurrentPageStart(0);
            setTotalCount(null);
            setNextCursor(null);
            setViewport({ start: 0, end: Math.min(out.length, 60) });
            if (scrollRef.current) scrollRef.current.scrollTop = 0;
        } catch (e) {
            setError(errString(e));
        } finally {
            setLoading(false);
        }
    };

    const handleNextPage = async () => {
        if (!nextCursor || loading) return;
        const currentSize = pageSizes[pageIdx] ?? messages.length;
        setLoading(true);
        setError(null);
        try {
            const page = await fetchRangePage(nextCursor);
            const size = page.messages?.length || 0;
            setMessages(page.messages || []);
            setSelected(size > 0 ? page.messages[0] : null);
            setPageCursors((prev) => {
                const next = prev.slice(0, pageIdx + 1);
                next.push(nextCursor);
                return next;
            });
            setPageSizes((prev) => {
                const next = prev.slice(0, pageIdx + 1);
                next.push(size);
                return next;
            });
            setPageIdx((i) => i + 1);
            setCurrentPageStart((s) => s + currentSize);
            setNextCursor(page.done ? null : page.cursor);
            setViewport({ start: 0, end: Math.min(size, 60) });
            if (scrollRef.current) scrollRef.current.scrollTop = 0;
        } catch (e) {
            setError(errString(e));
        } finally {
            setLoading(false);
        }
    };

    const handlePrevPage = async () => {
        if (pageIdx === 0 || loading) return;
        setLoading(true);
        setError(null);
        try {
            const prevIdx = pageIdx - 1;
            const cursor = pageCursors[prevIdx] || [];
            const prevSize = pageSizes[prevIdx] ?? 0;
            const page = await fetchRangePage(cursor);
            const size = page.messages?.length || 0;
            setMessages(page.messages || []);
            setSelected(size > 0 ? page.messages[0] : null);
            setPageSizes((prev) => {
                const next = prev.slice();
                next[prevIdx] = size;
                return next;
            });
            setPageIdx(prevIdx);
            setCurrentPageStart((s) => Math.max(0, s - (prevSize || size)));
            setNextCursor(page.done ? null : page.cursor);
            setViewport({ start: 0, end: Math.min(size, 60) });
            if (scrollRef.current) scrollRef.current.scrollTop = 0;
        } catch (e) {
            setError(errString(e));
        } finally {
            setLoading(false);
        }
    };

    const handleFirstPage = async () => {
        if (pageIdx === 0 || loading) return;
        setLoading(true);
        setError(null);
        try {
            const page = await fetchRangePage([]);
            const size = page.messages?.length || 0;
            setMessages(page.messages || []);
            setSelected(size > 0 ? page.messages[0] : null);
            setPageCursors([[]]);
            setPageSizes([size]);
            setPageIdx(0);
            setCurrentPageStart(0);
            if (page.totalCount >= 0) setTotalCount(page.totalCount);
            setNextCursor(page.done ? null : page.cursor);
            setViewport({ start: 0, end: Math.min(size, 60) });
            if (scrollRef.current) scrollRef.current.scrollTop = 0;
        } catch (e) {
            setError(errString(e));
        } finally {
            setLoading(false);
        }
    };

    const handleLastPage = async () => {
        if (loading) return;
        if (totalPages !== null && pageIdx === totalPages - 1) return;
        setLoading(true);
        setError(null);
        try {
            const page = await fetchRangePage([], true);
            const size = page.messages?.length || 0;
            const total = page.totalCount >= 0 ? page.totalCount : totalCount ?? size;
            const lastIdx = maxMessages > 0 ? Math.max(0, Math.ceil(total / maxMessages) - 1) : 0;
            setMessages(page.messages || []);
            setSelected(size > 0 ? page.messages[0] : null);
            // We don't have cursors for the intermediate pages, so the
            // history sequence after a last-page jump is no longer walkable.
            // pageCursors keeps just the marker for page 0 (initial); pageSizes
            // gets a sparse entry at lastIdx so backward navigation falls
            // back to firstPage via the « 처음 button.
            setPageCursors([[]]);
            const sparseSizes: number[] = new Array(lastIdx + 1).fill(0);
            sparseSizes[0] = pageSizes[0] || 0;
            sparseSizes[lastIdx] = size;
            setPageSizes(sparseSizes);
            setPageIdx(lastIdx);
            setCurrentPageStart(Math.max(0, total - size));
            if (page.totalCount >= 0) setTotalCount(page.totalCount);
            // Done is implied — this is the last page.
            setNextCursor(null);
            setViewport({ start: 0, end: Math.min(size, 60) });
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
                <select
                    value={topic}
                    onChange={(e) => onTopicChange(e.target.value)}
                    style={{ width: 260 }}
                    disabled={tailing}
                >
                    {topics.map((tn) => (
                        <option key={tn} value={tn}>{tn}</option>
                    ))}
                </select>
                <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value as Mode)}
                    style={{ width: 140 }}
                    disabled={tailing}
                >
                    <option value="beginning">{t(lang, "consume.mode.beginning")}</option>
                    <option value="end">{t(lang, "consume.mode.end")}</option>
                    <option value="offsetAfter">{t(lang, "consume.mode.offsetAfter")}</option>
                    <option value="offsetBefore">{t(lang, "consume.mode.offsetBefore")}</option>
                    <option value="timestamp">{t(lang, "consume.mode.timestamp")}</option>
                    <option value="tail">{t(lang, "consume.mode.tail")}</option>
                </select>
                {(mode === "offsetAfter" || mode === "offsetBefore") && (
                    <input
                        style={{ width: 120 }}
                        placeholder={t(lang, "consume.offset")}
                        value={offset}
                        onChange={(e) => setOffset(e.target.value)}
                    />
                )}
                {mode === "timestamp" && (
                    <>
                        <input
                            style={{ width: 220 }}
                            placeholder={t(lang, "consume.timestamp.start")}
                            value={timestampStart}
                            onChange={(e) => setTimestampStart(e.target.value)}
                        />
                        <input
                            style={{ width: 220 }}
                            placeholder={t(lang, "consume.timestamp.end")}
                            value={timestampEnd}
                            onChange={(e) => setTimestampEnd(e.target.value)}
                        />
                    </>
                )}
                <input
                    type="number"
                    title={t(lang, "consume.max")}
                    style={{ width: 90 }}
                    value={maxMessages}
                    onChange={(e) => setMaxMessages(Number(e.target.value) || 0)}
                    disabled={mode === "tail"}
                />
                <input
                    type="number"
                    title={t(lang, "consume.timeout")}
                    style={{ width: 90 }}
                    value={timeoutMs}
                    onChange={(e) => setTimeoutMs(Number(e.target.value) || 0)}
                    disabled={mode === "tail"}
                />
                <button
                    className={loading || tailing ? "danger" : "primary"}
                    onClick={loading || tailing ? () => { void CancelConsume(profileId); } : handleFetch}
                    disabled={!topic}
                >
                    {tailing
                        ? t(lang, "consume.stop")
                        : loading
                        ? t(lang, "consume.cancel")
                        : t(lang, "consume.fetch")}
                </button>
                <span className="count-pill">
                    {t(lang, "consume.shownOf", { shown: filtered.length, total: messages.length })}
                </span>
                {mode === "timestamp" && pageCursors.length > 0 && (
                    <>
                        <button onClick={handleFirstPage} disabled={pageIdx === 0 || loading}>
                            {t(lang, "consume.page.first")}
                        </button>
                        <button onClick={handlePrevPage} disabled={pageIdx === 0 || loading}>
                            {t(lang, "consume.page.prev")}
                        </button>
                        <span className="count-pill">
                            {totalPages !== null
                                ? t(lang, "consume.page.labelOf", { n: pageIdx + 1, total: totalPages })
                                : t(lang, "consume.page.label", { n: pageIdx + 1 })}
                        </span>
                        <button onClick={handleNextPage} disabled={!nextCursor || loading}>
                            {t(lang, "consume.page.next")}
                        </button>
                        <button
                            onClick={handleLastPage}
                            disabled={loading || (totalPages !== null && pageIdx === totalPages - 1)}
                        >
                            {t(lang, "consume.page.last")}
                        </button>
                        {totalCount !== null && (
                            <span className="muted" style={{ fontSize: 11 }}>
                                {t(lang, "consume.page.totalCount", { n: totalCount.toLocaleString() })}
                            </span>
                        )}
                    </>
                )}
                <div className="grow" />
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
                                {COLUMNS.map((c) => {
                                    const sortable = c.key === "timestamp" || c.key === "offset";
                                    return (
                                        <ResizableTh
                                            key={c.key}
                                            column={c}
                                            width={widths[c.key]}
                                            onResize={(w) => setWidth(c.key, w)}
                                            onReset={() => resetWidth(c.key)}
                                            onContextMenu={c.key === "timestamp" ? openTsCtxMenu : undefined}
                                            onClick={sortable ? () => cycleSort(c.key as SortKey) : undefined}
                                        >
                                            {sortable ? `${c.label}${sortArrow(c.key as SortKey)}` : c.label}
                                        </ResizableTh>
                                    );
                                })}
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
                                                <td className="mono muted" style={cellStyle}>{currentPageStart + viewport.start + i + 1}</td>
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

