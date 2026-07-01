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
import { AdvancedSearchDialog } from "../components/AdvancedSearchDialog";
import { ContextMenu } from "../components/ContextMenu";
import { SaveMessageDialog } from "../components/SaveMessageDialog";
import { TimestampConverter } from "../components/TimestampConverter";
import { formatLocalHuman, withMsTooltips } from "../lib/formatTime";
import { LizFilterPanel } from "../components/LizFilterPanel";
import {
    computeFacetCounts,
    emptyLizFilterState,
    FacetCounts,
    filterCatalogFor,
    isLizFilterActive,
    LIZ_FIELDS,
    LizFields,
    LizFilterState,
    matchLizFilter,
    normalizeLizFilterState,
    parseLizFields,
} from "../lib/lizPipeline";

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
    // Bumped by the parent whenever topics are created/edited/deleted in the
    // Topics tab, so the topic list here refreshes without a reconnect.
    topicsRev?: number;
}

type Mode = "beginning" | "end" | "offsetAfter" | "offsetBefore" | "timestamp" | "tail";

// Defaults the form returns to after a tail session stops.
const DEFAULT_MODE: Mode = "end";
const DEFAULT_MAX = 1000;
const DEFAULT_TIMEOUT = 8000;

// Reconciles whatever the user typed in the "max messages" box back to a
// number the backend understands. Rules (mirrors the bug report):
//   - empty / 0 / NaN / < -1  → 1000 (default)
//   - -1 + non-timestamp mode → -1 (unlimited; backend reads until timeout)
//   - -1 + timestamp mode     → 1000 (pagination needs a real page size)
//   - any positive            → as-is
function normalizeMax(text: string, mode: Mode): number {
    const trimmed = text.trim();
    if (trimmed === "") return DEFAULT_MAX;
    const n = parseInt(trimmed, 10);
    if (Number.isNaN(n)) return DEFAULT_MAX;
    if (n === -1) return mode === "timestamp" ? DEFAULT_MAX : -1;
    if (n <= 0) return DEFAULT_MAX;
    return n;
}
type Target = "value" | "key" | "headers";
type TsFormat = "local" | "unix";

const ROW_HEIGHT = 28;
const TS_FORMAT_KEY = "consume.tsFormat";
const LIZ_FILTER_KEY = "kfc.consume.lizFilter";
const LIZ_FILTER_OPEN_KEY = "kfc.consume.lizFilterOpen";

// Discrete pagination unit. Used by both the timestamp ConsumeRange path and
// the cursor-based Consume path so the user can pre-size each page for
// advanced-search/grep purposes (larger page = more rows searched in one go).
// Kept small + closed for now — three values cover the practical range
// (1k for snappy browsing, 50k for "search a big window").
const PAGE_SIZE_KEY = "consume.pageSize";
const PAGE_SIZES = [1000, 10000, 50000] as const;
type PageSize = typeof PAGE_SIZES[number];

// Per-card highlight colors. Index 0 uses the active theme's default chip/row
// look (null sentinel); 1..4 are fixed brand-agnostic hues so cards remain
// distinguishable across light/dark/onion themes.
type CardColor = {
    chipBg: string;
    chipBorder: string;
    chipFg: string;
    rowBg: string;
} | null;

const CARD_COLORS: CardColor[] = [
    null,
    { chipBg: "rgba(220, 38, 38, 0.16)",  chipBorder: "rgba(220, 38, 38, 0.55)",  chipFg: "#dc2626", rowBg: "rgba(220, 38, 38, 0.12)"  },
    { chipBg: "rgba(37, 99, 235, 0.16)",  chipBorder: "rgba(37, 99, 235, 0.55)",  chipFg: "#2563eb", rowBg: "rgba(37, 99, 235, 0.12)"  },
    { chipBg: "rgba(22, 163, 74, 0.16)",  chipBorder: "rgba(22, 163, 74, 0.55)",  chipFg: "#16a34a", rowBg: "rgba(22, 163, 74, 0.12)"  },
    { chipBg: "rgba(147, 51, 234, 0.16)", chipBorder: "rgba(147, 51, 234, 0.55)", chipFg: "#9333ea", rowBg: "rgba(147, 51, 234, 0.12)" },
];

export function ConsumePage({ lang, profileId, defaultTopic, topic, onTopicChange, topicsRev }: Props) {
    const [topics, setTopics] = useState<string[]>([]);
    const [mode, setMode] = useState<Mode>(DEFAULT_MODE);
    const [offset, setOffset] = useState<string>("0");
    const [timestampStart, setTimestampStart] = useState<string>("");
    const [timestampEnd, setTimestampEnd] = useState<string>("");
    const [maxMessages, setMaxMessages] = useState<number>(DEFAULT_MAX);
    // Mirrors maxMessages while the user is editing. The text state lets the
    // input be momentarily empty (otherwise backspace-to-clear gets stuck at
    // "0", which is awful UX). The number state is what handleFetch /
    // pagination actually consume; the two are reconciled on blur and on
    // fetch via normalizeMax().
    const [maxMessagesInput, setMaxMessagesInput] = useState<string>(String(DEFAULT_MAX));
    const [timeoutMs, setTimeoutMs] = useState<number>(DEFAULT_TIMEOUT);
    const [pageSize, setPageSize] = useState<PageSize>(() => {
        const v = parseInt(localStorage.getItem(PAGE_SIZE_KEY) || "", 10);
        return (PAGE_SIZES as readonly number[]).includes(v) ? (v as PageSize) : 1000;
    });
    useEffect(() => { localStorage.setItem(PAGE_SIZE_KEY, String(pageSize)); }, [pageSize]);

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
    const totalPages = totalCount !== null && pageSize > 0
        ? Math.max(1, Math.ceil(totalCount / pageSize))
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

    // Advanced search: each card holds a list of CSV-parsed tokens. A message
    // matches a card iff its target field contains every token as a
    // case-insensitive substring (AND within a card). The grid is filtered to
    // the OR-union of all non-empty cards; matched rows are tinted with that
    // card's color. If no cards exist or every card has zero tokens, the grid
    // shows the full Fetch result. Max 5 cards.
    type SearchCard = { id: number; tokens: string[] };
    const [advancedSearch, setAdvancedSearch] = useState(false);
    const [searchCards, setSearchCards] = useState<SearchCard[]>([{ id: 1, tokens: [] }]);
    const [editingCardId, setEditingCardId] = useState<number | null>(null);
    const nextCardIdRef = useRef(2);
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

    // --- liz.message.pipeline structured filter (whitelist/blacklist) --------
    // A field-aware include/exclude filter shown only for topics that have a
    // registered catalog (currently only liz.message.pipeline). It composes
    // (AND) with the free-text search below and applies at the view layer, so
    // the full tail buffer is retained and filter changes re-evaluate history.
    const [lizFilter, setLizFilter] = useState<LizFilterState>(() => {
        try {
            const raw = localStorage.getItem(LIZ_FILTER_KEY);
            return normalizeLizFilterState(raw ? JSON.parse(raw) : null, LIZ_FIELDS);
        } catch {
            return emptyLizFilterState(LIZ_FIELDS);
        }
    });
    useEffect(() => {
        localStorage.setItem(LIZ_FILTER_KEY, JSON.stringify(lizFilter));
    }, [lizFilter]);
    const [lizFilterOpen, setLizFilterOpen] = useState<boolean>(
        () => localStorage.getItem(LIZ_FILTER_OPEN_KEY) !== "0",
    );
    useEffect(() => {
        localStorage.setItem(LIZ_FILTER_OPEN_KEY, lizFilterOpen ? "1" : "0");
    }, [lizFilterOpen]);

    // Structured-filter catalog for the current topic (null → hide the panel).
    const lizCatalog = useMemo(() => filterCatalogFor(topic), [topic]);
    // Per-message parsed-field cache keyed by partition-offset identity, reset
    // whenever the topic changes. Keeps JSON.parse to once-per-message even as
    // the tail buffer grows (facets/filter re-run are then plain O(n) lookups).
    const lizCacheRef = useRef<{ topic: string; cache: Map<string, LizFields | null> }>({ topic: "", cache: new Map() });
    if (lizCacheRef.current.topic !== topic) {
        lizCacheRef.current = { topic, cache: new Map() };
    }
    const getLizFields = (m: kafka.Message): LizFields | null => {
        if (!lizCatalog) return null;
        const k = `${m.partition}-${m.offset}`;
        const c = lizCacheRef.current.cache;
        const hit = c.get(k);
        if (hit !== undefined) return hit;
        const parsed = parseLizFields(m.value, lizCatalog.fields);
        c.set(k, parsed);
        return parsed;
    };

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
            setMaxMessagesInput(String(DEFAULT_MAX));
            setTimeoutMs(DEFAULT_TIMEOUT);
        });
        return () => {
            EventsOff(batchEvent);
            EventsOff(stopEvent);
        };
    }, [profileId]);

    // Auto-start tail the moment the user picks the tail mode.
    //
    // The `tailing` guard keeps a live tail bound to the topic it started on:
    // because the Consume and Produce pages now stay mounted together and share
    // the selected topic, changing the topic on the Produce tab must NOT
    // silently clobber a running tail over here. A new tail only starts when
    // the user explicitly (re)selects the tail mode.
    useEffect(() => {
        if (mode !== "tail" || !topic || !profileId) return;
        if (tailing) return;
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
    }, [mode, topic, profileId, tailing]);

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
    }, [profileId, topicsRev]);

    // Pagination kind for this render. "timestamp" uses ConsumeRange + a real
    // total count; "cursor" uses Consume + per-partition cursors and is what
    // maxMessages === -1 maps to for the four non-timestamp finite modes; null
    // means no pagination (single shot fetch).
    type PagingKind = "timestamp" | "cursor" | null;
    const pagingKind: PagingKind = useMemo(() => {
        if (mode === "timestamp") return "timestamp";
        if (mode === "tail") return null;
        if (maxMessages === -1) return "cursor";
        return null;
    }, [mode, maxMessages]);

    // The direction the current mode reads in. Used by cursor pagination to
    // decide whether the "next" cursor is max(offset)+1 (forward) or
    // min(offset)-1 (backward).
    const isForwardMode = mode === "beginning" || mode === "offsetAfter";

    // Compute the cursor (per-partition next-offset-to-read) from a returned
    // page of messages, given the read direction. Empty array means "no
    // continuation — we've reached the boundary of the log".
    const computeCursor = (msgs: kafka.Message[]): kafka.CursorEntry[] => {
        if (msgs.length === 0) return [];
        const acc = new Map<number, number>();
        for (const msg of msgs) {
            const cur = acc.get(msg.partition);
            const off = msg.offset as unknown as number;
            if (cur === undefined) acc.set(msg.partition, off);
            else if (isForwardMode && off > cur) acc.set(msg.partition, off);
            else if (!isForwardMode && off < cur) acc.set(msg.partition, off);
        }
        const out: kafka.CursorEntry[] = [];
        acc.forEach((off, p) => {
            out.push(kafka.CursorEntry.createFrom({
                partition: p,
                offset: isForwardMode ? off + 1 : off - 1,
            }));
        });
        return out;
    };

    // Reset pagination state whenever the seek mode or page size changes —
    // captured cursors are tied to those values and aren't comparable across
    // a resize.
    useEffect(() => {
        setPageCursors([]);
        setPageSizes([]);
        setPageIdx(0);
        setCurrentPageStart(0);
        setTotalCount(null);
        setNextCursor(null);
    }, [mode, pageSize]);

    // Page-size change auto-refetches the first page so the user sees the
    // resized result immediately instead of having to click 가져오기 again.
    // The initial render is suppressed by the `messages.length === 0` guard
    // (no prior result to refresh). Mode changes deliberately do NOT trigger
    // this — switching to e.g. timestamp requires the user to enter the
    // range first.
    useEffect(() => {
        if (messages.length === 0) return;
        if (!topic || tailing || loading) return;
        if (mode === "tail") return;
        void handleFetch();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pageSize]);

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

    // Extract the haystack string for the current target. Headers are
    // joined into a single "k=v\nk=v" blob so token containment naturally
    // works the same way as for value/key.
    const haystackOf = (m: kafka.Message): string => {
        if (target === "value") return m.value;
        if (target === "key") return m.key;
        return Object.entries(m.headers).map(([k, v]) => `${k}=${v}`).join("\n");
    };

    // Lowercased tokens per card, memoized so per-row matching during render
    // doesn't keep re-lowercasing the same strings.
    const lowerCardTokens = useMemo(
        () => searchCards.map((c) => c.tokens.map((t) => t.toLowerCase())),
        [searchCards],
    );

    // Live per-field value → count over the current buffer, feeding the hybrid
    // (static catalog ∪ observed) dropdown in the liz filter panel.
    const lizFacets = useMemo<FacetCounts>(() => {
        if (!lizCatalog) return {};
        return computeFacetCounts(messages.map(getLizFields), lizCatalog.fields);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages, lizCatalog]);

    const filtered = useMemo(() => {
        const lizDefs = lizCatalog?.fields;
        const lizActive = !!lizDefs && isLizFilterActive(lizFilter);
        // Applies the structured liz filter (AND-composed with text search).
        const applyLiz = (arr: kafka.Message[]) =>
            lizActive ? arr.filter((m) => matchLizFilter(getLizFields(m), lizFilter, lizDefs!)) : arr;

        if (advancedSearch) {
            const active = lowerCardTokens.filter((tks) => tks.length > 0);
            // No active card → show full fetch result, same as exiting advanced mode.
            if (active.length === 0) return applyLiz(sortedMessages);
            return applyLiz(sortedMessages.filter((m) => {
                const h = haystackOf(m).toLowerCase();
                return active.some((tokens) => tokens.every((t) => h.includes(t)));
            }));
        }
        const q = search.trim();
        if (!q) return applyLiz(sortedMessages);
        let matcher: (s: string) => boolean;
        if (useRegex) {
            try {
                const re = new RegExp(q, caseSensitive ? "" : "i");
                matcher = (s) => re.test(s);
            } catch {
                return applyLiz(sortedMessages);
            }
        } else {
            const needle = caseSensitive ? q : q.toLowerCase();
            matcher = (s) => (caseSensitive ? s : s.toLowerCase()).includes(needle);
        }
        return applyLiz(sortedMessages.filter((m) => matcher(haystackOf(m))));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [advancedSearch, sortedMessages, search, useRegex, caseSensitive, target, lowerCardTokens, lizCatalog, lizFilter]);

    // Per-card match counts. A card with no tokens reports 0.
    const cardCounts = useMemo(() => {
        if (!advancedSearch) return [];
        const haystacks = messages.map((m) => haystackOf(m).toLowerCase());
        return lowerCardTokens.map((tokens) => {
            if (tokens.length === 0) return 0;
            let n = 0;
            for (const h of haystacks) {
                if (tokens.every((t) => h.includes(t))) n++;
            }
            return n;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [advancedSearch, messages, lowerCardTokens, target]);

    // Returns the color of the first non-empty card that matches the message,
    // or null if advanced search is off / no card matches. Used to tint rows.
    const cardColorOf = (m: kafka.Message): CardColor => {
        if (!advancedSearch) return null;
        const h = haystackOf(m).toLowerCase();
        for (let i = 0; i < lowerCardTokens.length; i++) {
            const tokens = lowerCardTokens[i];
            if (tokens.length === 0) continue;
            if (tokens.every((t) => h.includes(t))) return CARD_COLORS[i] ?? null;
        }
        return null;
    };

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

    // One page of cursor-based non-timestamp consume. Cursor empty = first
    // page; on subsequent pages the FE passes back the cursor returned by the
    // previous call (computed from message offsets).
    const fetchConsumePage = async (cursor: kafka.CursorEntry[]): Promise<kafka.Message[]> => {
        const opts = kafka.ConsumeOptions.createFrom({
            topic,
            mode,
            offset: mode === "offsetAfter" || mode === "offsetBefore" ? Number(offset) || 0 : 0,
            timestampMs: 0,
            maxMessages: pageSize,
            timeoutMs,
            cursor,
        });
        return await Consume(profileId, opts);
    };

    const fetchRangePage = async (cursor: kafka.CursorEntry[], fromEnd = false) => {
        const start = parseTs(timestampStart);
        if (start <= 0) throw new Error(t(lang, "consume.timestamp.start"));
        const end = parseTs(timestampEnd); // 0 means "no end cap"
        const opts = kafka.ConsumeRangeOptions.createFrom({
            topic,
            startMs: start,
            endMs: end,
            maxMessages: pageSize,
            timeoutMs,
            cursor: fromEnd ? [] : cursor,
            fromEnd,
        });
        return await ConsumeRange(profileId, opts);
    };

    // Re-normalize max messages whenever the mode changes. The same -1
    // ("unlimited") that's valid for the offset/end modes must collapse back
    // to 1000 the moment the user switches to timestamp range, otherwise
    // pagination divides by zero.
    useEffect(() => {
        const n = normalizeMax(maxMessagesInput, mode);
        if (n !== maxMessages) setMaxMessages(n);
        const text = String(n);
        if (text !== maxMessagesInput) setMaxMessagesInput(text);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode]);

    const handleFetch = async () => {
        if (!topic || mode === "tail") return;
        // Catch the case where the user pressed Fetch via keyboard while the
        // input still has a transient empty/0 value (onBlur hasn't fired yet).
        const effectiveMax = normalizeMax(maxMessagesInput, mode);
        if (effectiveMax !== maxMessages) {
            setMaxMessages(effectiveMax);
            setMaxMessagesInput(String(effectiveMax));
        }
        // Routing decision must use effectiveMax, not the memoized
        // `pagingKind`. The memo still reflects the previous render's
        // maxMessages because the setMaxMessages above is async — without
        // this, typing -1 + immediate Fetch falls through to the single-shot
        // path on the very first call and pagination controls never appear.
        const effectivePaging: PagingKind =
            mode === "timestamp" ? "timestamp" :
            effectiveMax === -1 ? "cursor" :
            null;
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
            // Cursor pagination path (max=-1, non-timestamp): always ask for
            // one page (1000) and capture the next cursor so the user can
            // walk forward without freezing the UI on a giant single fetch.
            if (effectivePaging === "cursor") {
                const out = await fetchConsumePage([]);
                const size = out.length;
                setMessages(out);
                setSelected(size > 0 ? out[0] : null);
                setPageCursors([[]]);
                setPageSizes([size]);
                setPageIdx(0);
                setCurrentPageStart(0);
                setTotalCount(null);
                setNextCursor(size < pageSize ? null : computeCursor(out));
                setViewport({ start: 0, end: Math.min(size, 60) });
                if (scrollRef.current) scrollRef.current.scrollTop = 0;
                return;
            }
            const opts = kafka.ConsumeOptions.createFrom({
                topic,
                mode,
                offset: mode === "offsetAfter" || mode === "offsetBefore" ? Number(offset) || 0 : 0,
                timestampMs: 0,
                maxMessages: effectiveMax,
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
            if (pagingKind === "cursor") {
                const out = await fetchConsumePage(nextCursor);
                const size = out.length;
                setMessages(out);
                setSelected(size > 0 ? out[0] : null);
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
                setNextCursor(size < pageSize ? null : computeCursor(out));
                setViewport({ start: 0, end: Math.min(size, 60) });
                if (scrollRef.current) scrollRef.current.scrollTop = 0;
                return;
            }
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
            if (pagingKind === "cursor") {
                const out = await fetchConsumePage(cursor);
                const size = out.length;
                setMessages(out);
                setSelected(size > 0 ? out[0] : null);
                setPageSizes((prev) => {
                    const next = prev.slice();
                    next[prevIdx] = size;
                    return next;
                });
                setPageIdx(prevIdx);
                setCurrentPageStart((s) => Math.max(0, s - (prevSize || size)));
                setNextCursor(size < pageSize ? null : computeCursor(out));
                setViewport({ start: 0, end: Math.min(size, 60) });
                if (scrollRef.current) scrollRef.current.scrollTop = 0;
                return;
            }
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
            if (pagingKind === "cursor") {
                const out = await fetchConsumePage([]);
                const size = out.length;
                setMessages(out);
                setSelected(size > 0 ? out[0] : null);
                setPageCursors([[]]);
                setPageSizes([size]);
                setPageIdx(0);
                setCurrentPageStart(0);
                setNextCursor(size < pageSize ? null : computeCursor(out));
                setViewport({ start: 0, end: Math.min(size, 60) });
                if (scrollRef.current) scrollRef.current.scrollTop = 0;
                return;
            }
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

    // Jumps to an arbitrary page in the current pagination context. For pages
    // whose cursor we've already captured (the user has visited or walked
    // past), this is a single fetch. For pages further ahead than we've
    // walked, it sequentially follows `nextCursor` page-by-page from the
    // current position — slow for large jumps but works without backend
    // changes.
    const handleJumpToPage = async (targetIdx: number) => {
        if (loading || tailing) return;
        if (targetIdx < 0 || targetIdx === pageIdx) return;
        setLoading(true);
        setError(null);
        try {
            const cursorsAcc = pageCursors.slice();
            const sizesAcc = pageSizes.slice();
            let walkIdx = pageIdx;
            let walkCursor = nextCursor;
            let pageStartAcc = currentPageStart;
            let lastMessages: kafka.Message[] = messages;
            let totalCountAcc = totalCount;

            // Backward jump: use the cached cursor if present.
            if (targetIdx < pageIdx) {
                const cached = cursorsAcc[targetIdx];
                if (cached === undefined) throw new Error("missing cached cursor for page " + (targetIdx + 1));
                if (pagingKind === "cursor") {
                    lastMessages = await fetchConsumePage(cached);
                    sizesAcc[targetIdx] = lastMessages.length;
                    walkCursor = lastMessages.length < pageSize ? null : computeCursor(lastMessages);
                } else {
                    const page = await fetchRangePage(cached);
                    lastMessages = page.messages || [];
                    sizesAcc[targetIdx] = lastMessages.length;
                    walkCursor = page.done ? null : page.cursor;
                    if (page.totalCount >= 0) totalCountAcc = page.totalCount;
                }
                walkIdx = targetIdx;
                pageStartAcc = 0;
                for (let i = 0; i < targetIdx; i++) pageStartAcc += sizesAcc[i] ?? 0;
            } else {
                // Forward walk from the current page using nextCursor.
                while (walkIdx < targetIdx && walkCursor !== null && walkCursor.length > 0) {
                    const prevSize = sizesAcc[walkIdx] ?? lastMessages.length;
                    const cursorForThisStep = walkCursor;
                    if (pagingKind === "cursor") {
                        lastMessages = await fetchConsumePage(cursorForThisStep);
                        walkIdx++;
                        cursorsAcc[walkIdx] = cursorForThisStep;
                        sizesAcc[walkIdx] = lastMessages.length;
                        pageStartAcc += prevSize;
                        walkCursor = lastMessages.length < pageSize ? null : computeCursor(lastMessages);
                    } else {
                        const page = await fetchRangePage(cursorForThisStep);
                        lastMessages = page.messages || [];
                        walkIdx++;
                        cursorsAcc[walkIdx] = cursorForThisStep;
                        sizesAcc[walkIdx] = lastMessages.length;
                        pageStartAcc += prevSize;
                        walkCursor = page.done ? null : page.cursor;
                        if (page.totalCount >= 0) totalCountAcc = page.totalCount;
                    }
                }
            }

            setMessages(lastMessages);
            setSelected(lastMessages.length > 0 ? lastMessages[0] : null);
            setPageCursors(cursorsAcc);
            setPageSizes(sizesAcc);
            setPageIdx(walkIdx);
            setCurrentPageStart(pageStartAcc);
            setTotalCount(totalCountAcc);
            setNextCursor(walkCursor);
            setViewport({ start: 0, end: Math.min(lastMessages.length, 60) });
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
                {mode !== "tail" && (
                    <>
                        {mode !== "timestamp" && (
                            <label className="toolbar-field">
                                <span className="toolbar-field-label">{t(lang, "consume.max")}</span>
                                <input
                                    type="number"
                                    // -1 toggles cursor pagination for non-timestamp
                                    // modes; positive values are a single-shot cap.
                                    min={-1}
                                    style={{ width: 90 }}
                                    value={maxMessagesInput}
                                    onChange={(e) => setMaxMessagesInput(e.target.value)}
                                    onBlur={() => {
                                        const n = normalizeMax(maxMessagesInput, mode);
                                        setMaxMessages(n);
                                        setMaxMessagesInput(String(n));
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter" && topic && !loading && !tailing) {
                                            e.preventDefault();
                                            void handleFetch();
                                        }
                                    }}
                                />
                            </label>
                        )}
                        {pagingKind !== null && (
                            <select
                                title={t(lang, "consume.pageSize")}
                                style={{ width: 110 }}
                                value={pageSize}
                                onChange={(e) => setPageSize(Number(e.target.value) as PageSize)}
                            >
                                {PAGE_SIZES.map((s) => (
                                    <option key={s} value={s}>
                                        {t(lang, "consume.pageSize.option", { n: s.toLocaleString() })}
                                    </option>
                                ))}
                            </select>
                        )}
                        <label className="toolbar-field">
                            <span className="toolbar-field-label">{t(lang, "consume.timeout")}</span>
                            <input
                                type="number"
                                style={{ width: 90 }}
                                value={timeoutMs}
                                onChange={(e) => setTimeoutMs(Number(e.target.value) || 0)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" && topic && !loading && !tailing) {
                                        e.preventDefault();
                                        void handleFetch();
                                    }
                                }}
                            />
                        </label>
                    </>
                )}
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
                {pagingKind !== null && pageCursors.length > 0 && (
                    <>
                        <button onClick={handleFirstPage} disabled={pageIdx === 0 || loading}>
                            {t(lang, "consume.page.first")}
                        </button>
                        <button onClick={handlePrevPage} disabled={pageIdx === 0 || loading}>
                            {t(lang, "consume.page.prev")}
                        </button>
                        {(() => {
                            // Build the page-jump dropdown. We render at most
                            // max(known, total) options; for cursor mode the
                            // upper bound grows with what we've walked
                            // (+1 if there's a next page to walk into).
                            const visited = pageCursors.length;
                            const upper = totalPages !== null
                                ? totalPages
                                : Math.max(visited, pageIdx + 1) + (nextCursor ? 1 : 0);
                            const opts: number[] = [];
                            for (let i = 0; i < upper; i++) opts.push(i);
                            return (
                                <select
                                    className="page-jump"
                                    value={pageIdx}
                                    onChange={(e) => void handleJumpToPage(Number(e.target.value))}
                                    disabled={loading}
                                    title={t(lang, "consume.page.jump")}
                                >
                                    {opts.map((i) => (
                                        <option key={i} value={i}>
                                            {totalPages !== null
                                                ? t(lang, "consume.page.labelOf", { n: i + 1, total: totalPages })
                                                : t(lang, "consume.page.label", { n: i + 1 })}
                                        </option>
                                    ))}
                                </select>
                            );
                        })()}
                        <button onClick={handleNextPage} disabled={!nextCursor || loading}>
                            {t(lang, "consume.page.next")}
                        </button>
                        {pagingKind === "timestamp" && (
                            <button
                                onClick={handleLastPage}
                                disabled={loading || (totalPages !== null && pageIdx === totalPages - 1)}
                            >
                                {t(lang, "consume.page.last")}
                            </button>
                        )}
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
                {!advancedSearch ? (
                    <>
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
                        <button onClick={() => setAdvancedSearch(true)}>
                            {t(lang, "consume.advanced")}
                        </button>
                    </>
                ) : (
                    <>
                        <select value={target} onChange={(e) => setTarget(e.target.value as Target)} style={{ width: 100 }}>
                            <option value="value">{t(lang, "consume.target.value")}</option>
                            <option value="key">{t(lang, "consume.target.key")}</option>
                            <option value="headers">{t(lang, "consume.target.headers")}</option>
                        </select>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, flex: 1, minWidth: 0 }}>
                            {searchCards.map((card, i) => (
                                <SearchCardChip
                                    key={card.id}
                                    tokens={card.tokens}
                                    count={cardCounts[i] ?? 0}
                                    color={CARD_COLORS[i] ?? null}
                                    lang={lang}
                                    onClick={() => setEditingCardId(card.id)}
                                    onDelete={() => setSearchCards((prev) => prev.filter((c) => c.id !== card.id))}
                                />
                            ))}
                            {searchCards.length < 5 && (
                                <button
                                    className="small"
                                    onClick={() => {
                                        const id = nextCardIdRef.current++;
                                        setSearchCards((prev) => [...prev, { id, tokens: [] }]);
                                        setEditingCardId(id);
                                    }}
                                >
                                    {t(lang, "consume.advanced.add")}
                                </button>
                            )}
                        </div>
                        <button onClick={() => setAdvancedSearch(false)}>
                            {t(lang, "consume.advanced.exit")}
                        </button>
                    </>
                )}
            </div>

            {lizCatalog && (
                <LizFilterPanel
                    fields={lizCatalog.fields}
                    state={lizFilter}
                    onChange={setLizFilter}
                    facets={lizFacets}
                    lang={lang}
                    open={lizFilterOpen}
                    onToggleOpen={() => setLizFilterOpen((o) => !o)}
                />
            )}

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
                                        // Selection wins over card tint so the user can still see which row is selected.
                                        const cc = isSel ? null : cardColorOf(m);
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
                                                style={{ height: ROW_HEIGHT, background: cc?.rowBg }}
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

            {editingCardId !== null && (() => {
                const card = searchCards.find((c) => c.id === editingCardId);
                if (!card) return null;
                return (
                    <AdvancedSearchDialog
                        lang={lang}
                        initialTokens={card.tokens}
                        onClose={() => setEditingCardId(null)}
                        onSave={(tokens) => {
                            setSearchCards((prev) =>
                                prev.map((c) => (c.id === editingCardId ? { ...c, tokens } : c)),
                            );
                            setEditingCardId(null);
                        }}
                    />
                );
            })()}

            {savedToast && <div className="toast">{savedToast}</div>}
        </div>
    );
}

function SearchCardChip({
    tokens,
    count,
    color,
    lang,
    onClick,
    onDelete,
}: {
    tokens: string[];
    count: number;
    color: CardColor;
    lang: Lang;
    onClick: () => void;
    onDelete?: () => void;
}) {
    const empty = tokens.length === 0;
    const preview = empty ? t(lang, "consume.advanced.empty") : tokens.join(", ");
    return (
        <div
            onClick={onClick}
            title={preview}
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 8px 4px 10px",
                background: color?.chipBg ?? "var(--panel-2)",
                border: `1px solid ${color?.chipBorder ?? "var(--border)"}`,
                borderRadius: 14,
                cursor: "pointer",
                fontSize: 12,
                maxWidth: 280,
            }}
        >
            <span
                style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 180,
                    color: empty ? "var(--text-dim)" : undefined,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                }}
            >
                {preview}
            </span>
            <span
                style={{
                    color: empty
                        ? "var(--text-dim)"
                        : color?.chipFg ?? "var(--accent)",
                    fontWeight: 600,
                    fontVariantNumeric: "tabular-nums",
                }}
            >
                {t(lang, "consume.advanced.count", { n: count.toLocaleString() })}
            </span>
            {onDelete && (
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onDelete();
                    }}
                    title={t(lang, "consume.advanced.delete")}
                    style={{
                        padding: "0 6px",
                        margin: 0,
                        border: "none",
                        background: "transparent",
                        color: "var(--text-dim)",
                        cursor: "pointer",
                        fontSize: 14,
                        lineHeight: 1,
                    }}
                >
                    ×
                </button>
            )}
        </div>
    );
}

