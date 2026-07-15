import { useEffect, useMemo, useRef, useState } from "react";
import { Lang, t } from "../lib/i18n";
import { errString } from "../lib/errors";
import {
    ListTopics,
    PublishMonitorTogglePair,
    PreviewMonitorTogglePair,
} from "../../wailsjs/go/main/App";
import { LIZ_PIPELINE_TOPIC, SENDER_TYPES } from "../lib/lizPipeline";

interface Props {
    lang: Lang;
    profileId: string;
    defaultTopic?: string;
    topicsRev?: number;
}

// One published (or attempted) pair (or single message when SPECIFY_RULE is off).
interface BatchLog {
    no: number;
    ids: number[];
    restartService: boolean;
    hasSpec: boolean; // whether the SPECIFY_RULE message was part of this send
    timeMs: number;
    devUuid: string;
    devPart: number;
    devOff: number;
    specUuid: string;
    specPart: number;
    specOff: number;
    ok: boolean;
    error?: string;
}

interface ParsedIds {
    ids: number[];
    invalid: string[];
    dupes: number;
}

// liz device ids are a Java Integer → they must fit a signed int32. Anything
// larger cannot be a real device id and is rejected as invalid.
const INT32_MAX = 2147483647;

// Removes zero-width space/joiner (U+200B..U+200D) and BOM (U+FEFF), which ride
// along on copy/paste and are invisible in the textarea.
function stripInvisible(s: string): string {
    let out = "";
    for (const ch of s) {
        const c = ch.charCodeAt(0);
        if (c === 0x200b || c === 0x200c || c === 0x200d || c === 0xfeff) continue;
        out += ch;
    }
    return out;
}

// Splits pasted text on any run of comma / semicolon / whitespace and keeps the
// valid int32 device ids, in first-seen order. Zero-width/BOM characters are
// stripped first (they survive Ctrl+C/V and would otherwise corrupt a token).
// Non-numeric, out-of-range, or unsafe tokens go to `invalid`; exact duplicates
// are dropped (and counted) when dedupe is on.
function parseIds(text: string, dedupe: boolean): ParsedIds {
    const ids: number[] = [];
    const invalid: string[] = [];
    const seen = new Set<number>();
    let dupes = 0;
    for (const raw of text.split(/[\s,;]+/)) {
        // Strip zero-width / BOM chars (U+200B..U+200D, U+FEFF) that survive
        // copy/paste and would otherwise corrupt a token.
        const tok = stripInvisible(raw).trim();
        if (!tok) continue;
        // ^\d+$ matches only ASCII 0-9, so full-width digits / signs are rejected.
        if (!/^\d+$/.test(tok)) { invalid.push(tok); continue; }
        const n = Number(tok);
        if (!Number.isSafeInteger(n) || n > INT32_MAX) { invalid.push(tok); continue; }
        if (dedupe) {
            if (seen.has(n)) { dupes++; continue; }
            seen.add(n);
        }
        ids.push(n);
    }
    return { ids, invalid, dupes };
}

function prettifyJson(s: string): string {
    try {
        const obj = JSON.parse(s);
        if (obj !== null && typeof obj === "object") return JSON.stringify(obj, null, 2);
    } catch { /* leave as-is */ }
    return s;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const MAX_LOG_ROWS = 200; // cap rendered rows; full history stays in state

export function SpecialPublishPage({ lang, profileId, defaultTopic, topicsRev }: Props) {
    const [topics, setTopics] = useState<string[]>([]);
    const [topic, setTopic] = useState<string>("");

    // restartService is the actual field on the wire: true = monitoring ON
    // (collector service restarts), false = monitoring OFF (source-confirmed).
    const [restartService, setRestartService] = useState(false);
    const [includeSpecifyRule, setIncludeSpecifyRule] = useState(true);
    const [senderType, setSenderType] = useState<string>("ADMIN_CONSOLE");
    const [showAdvanced, setShowAdvanced] = useState(false);

    const [idsText, setIdsText] = useState("");
    const [dedupe, setDedupe] = useState(true);

    const [chunkSize, setChunkSize] = useState("1");
    const [useAllRemaining, setUseAllRemaining] = useState(false);
    const [delayMs, setDelayMs] = useState("500");
    const [stopOnError, setStopOnError] = useState(true);

    const [cursor, setCursor] = useState(0); // number of ids consumed so far
    const [log, setLog] = useState<BatchLog[]>([]);
    const [preview, setPreview] = useState<{ dev: string; spec: string } | null>(null);

    const [busy, setBusy] = useState(false);   // a single manual send in flight
    const [running, setRunning] = useState(false); // auto-run active
    const [error, setError] = useState<string | null>(null);

    const runningRef = useRef(false);
    const cursorRef = useRef(0);
    const batchNoRef = useRef(0);

    const setCursorBoth = (n: number) => { cursorRef.current = n; setCursor(n); };

    // Load the cluster's topics; default to the liz pipeline topic when present.
    useEffect(() => {
        (async () => {
            try {
                const list = await ListTopics(profileId);
                const names = list.map((tp) => tp.name);
                setTopics(names);
                setTopic((cur) => {
                    if (cur && names.includes(cur)) return cur;
                    if (names.includes(LIZ_PIPELINE_TOPIC)) return LIZ_PIPELINE_TOPIC;
                    if (defaultTopic && names.includes(defaultTopic)) return defaultTopic;
                    return names[0] ?? "";
                });
            } catch (e) {
                setError(errString(e));
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [profileId, topicsRev]);

    // Stop any auto-run if the page unmounts (e.g. switching profiles), so the
    // loop can't keep producing / setState after teardown.
    useEffect(() => () => { runningRef.current = false; }, []);

    const parsed = useMemo(() => parseIds(idsText, dedupe), [idsText, dedupe]);
    const total = parsed.ids.length;
    const remaining = Math.max(0, total - cursor);

    // Editing the id set (or dedupe) invalidates the progress + history.
    useEffect(() => {
        setCursorBoth(0);
        setLog([]);
        setError(null);
        batchNoRef.current = 0;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [idsText, dedupe]);

    const chunkN = Math.max(1, Number(chunkSize) || 1);
    const nextIds = useMemo(() => {
        if (remaining <= 0) return [] as number[];
        const n = useAllRemaining ? remaining : Math.min(chunkN, remaining);
        return parsed.ids.slice(cursor, cursor + n);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [parsed.ids, cursor, chunkN, useAllRemaining, remaining]);

    const previewSig = useMemo(
        () => `${nextIds.join(",")}|${restartService}|${senderType}|${includeSpecifyRule}`,
        [nextIds, restartService, senderType, includeSpecifyRule],
    );

    // Debounced preview of the NEXT pair (built server-side so it matches the
    // real wire shape; uuid/time regenerate at actual send).
    useEffect(() => {
        if (nextIds.length === 0) { setPreview(null); return; }
        let alive = true;
        const id = window.setTimeout(async () => {
            try {
                const res = await PreviewMonitorTogglePair({
                    topic, deviceIds: nextIds, restartService, senderType, partition: -1,
                    omitSpecifyRule: !includeSpecifyRule,
                } as any);
                if (alive) {
                    setPreview({
                        dev: prettifyJson(res.deviceUpdated.value),
                        spec: includeSpecifyRule ? prettifyJson(res.specifyRule?.value ?? "") : "",
                    });
                }
            } catch {
                if (alive) setPreview(null);
            }
        }, 250);
        return () => { alive = false; window.clearTimeout(id); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [previewSig]);

    const appendLog = (e: BatchLog) => setLog((prev) => [...prev, e]);

    const doPublish = async (ids: number[], restart: boolean, sender: string, top: string, withSpec: boolean): Promise<BatchLog> => {
        const no = ++batchNoRef.current;
        try {
            const res = await PublishMonitorTogglePair(profileId, {
                topic: top, deviceIds: ids, restartService: restart, senderType: sender, partition: -1,
                omitSpecifyRule: !withSpec,
            } as any);
            return {
                no, ids, restartService: restart, hasSpec: withSpec, timeMs: res.timeMs,
                devUuid: res.deviceUpdated?.uuid ?? "", devPart: res.deviceUpdated?.partition ?? -1, devOff: res.deviceUpdated?.offset ?? -1,
                specUuid: res.specifyRule?.uuid ?? "", specPart: res.specifyRule?.partition ?? -1, specOff: res.specifyRule?.offset ?? -1,
                ok: true,
            };
        } catch (e) {
            return {
                no, ids, restartService: restart, hasSpec: withSpec, timeMs: 0,
                devUuid: "", devPart: -1, devOff: -1, specUuid: "", specPart: -1, specOff: -1,
                ok: false, error: errString(e),
            };
        }
    };

    const handleSendNext = async () => {
        if (busy || running || !topic) return;
        const ids = nextIds;
        if (ids.length === 0) return;
        setBusy(true);
        setError(null);
        const entry = await doPublish(ids, restartService, senderType, topic, includeSpecifyRule);
        appendLog(entry);
        if (entry.ok) {
            setCursorBoth(cursorRef.current + ids.length); // advance only on success → failed batch can be retried
        } else {
            setError(entry.error ?? t(lang, "special.err.generic"));
        }
        setBusy(false);
    };

    const handleAutoRun = async () => {
        if (running || busy || !topic || remaining <= 0) return;
        // Snapshot settings so mid-run edits (inputs are disabled anyway) can't
        // change the run.
        const snapAll = useAllRemaining;
        const snapChunk = chunkN;
        const snapDelay = Math.max(0, Number(delayMs) || 0);
        const snapStopOnError = stopOnError;
        const snapRestart = restartService;
        const snapSender = senderType;
        const snapTopic = topic;
        const snapSpec = includeSpecifyRule;
        const ids = parsed.ids;

        // Auto-run fires many sends unattended — confirm the scope first. This is
        // the one place worth a speed bump: restartService=true triggers real
        // device-service restarts.
        const pairs = snapAll ? 1 : Math.ceil(remaining / snapChunk);
        const summary = t(lang, "special.confirm.autoRun", {
            topic: snapTopic,
            remaining,
            pairs,
            restart: String(snapRestart),
        });
        if (!window.confirm(summary)) return;

        runningRef.current = true;
        setRunning(true);
        setError(null);
        try {
            let cur = cursorRef.current;
            while (runningRef.current && cur < ids.length) {
                const n = snapAll ? ids.length - cur : Math.min(snapChunk, ids.length - cur);
                const batch = ids.slice(cur, cur + n);
                const entry = await doPublish(batch, snapRestart, snapSender, snapTopic, snapSpec);
                appendLog(entry);
                if (entry.ok) {
                    cur += batch.length;
                    setCursorBoth(cur);
                } else {
                    setError(entry.error ?? t(lang, "special.err.generic"));
                    if (snapStopOnError) break;
                    // continue-on-error: skip the failed batch so we don't loop forever
                    cur += batch.length;
                    setCursorBoth(cur);
                }
                if (snapAll) break; // "all remaining" is a single pair
                if (cur < ids.length && runningRef.current && snapDelay > 0) {
                    await sleep(snapDelay);
                }
            }
        } finally {
            runningRef.current = false;
            setRunning(false);
        }
    };

    const handleStop = () => { runningRef.current = false; setRunning(false); };

    const handleReset = () => {
        if (running) return;
        setCursorBoth(0);
        setLog([]);
        setError(null);
        batchNoRef.current = 0;
    };

    const okPairs = useMemo(() => log.filter((e) => e.ok).length, [log]);
    const failedPairs = log.length - okPairs;
    const okIds = useMemo(() => log.filter((e) => e.ok).reduce((a, e) => a + e.ids.length, 0), [log]);
    const okRecords = useMemo(() => log.filter((e) => e.ok).reduce((a, e) => a + (e.hasSpec ? 2 : 1), 0), [log]);
    const locked = busy || running;
    const shownLog = log.length > MAX_LOG_ROWS ? log.slice(log.length - MAX_LOG_ROWS) : log;
    const hiddenRows = log.length - shownLog.length;

    const sendNextLabel = useAllRemaining
        ? t(lang, "special.sendAll", { n: nextIds.length })
        : t(lang, "special.sendNext", { n: nextIds.length });

    return (
        <div className="page">
            <div className="page-toolbar">
                <label className="toolbar-field">
                    <span className="toolbar-field-label">{t(lang, "special.op")}</span>
                    <select value="monitorToggle" disabled style={{ width: 220 }}>
                        <option value="monitorToggle">{t(lang, "special.op.monitorToggle")}</option>
                    </select>
                </label>
                <label className="toolbar-field">
                    <span className="toolbar-field-label">{t(lang, "special.topic")}</span>
                    <select value={topic} onChange={(e) => setTopic(e.target.value)} disabled={locked} style={{ width: 240 }}>
                        {!topics.includes(topic) && topic && <option value={topic}>{topic}</option>}
                        {topics.map((tn) => (
                            <option key={tn} value={tn}>{tn}</option>
                        ))}
                    </select>
                </label>
                <div className="grow" />
            </div>

            <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 14, paddingRight: 4 }}>
                <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                    {t(lang, "special.op.desc")}
                </div>

                {/* 모니터링 재시작 (restartService) */}
                <div className="form-row">
                    <label title={t(lang, "special.restart.hint")}>{t(lang, "special.restart")}</label>
                    <div className="row" style={{ gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                        <label className="checkbox" style={{ cursor: "pointer" }}>
                            <input type="radio" name="mtrestart" checked={!restartService} onChange={() => setRestartService(false)} disabled={locked} />
                            <span className="mono">restartService = false</span>
                        </label>
                        <label className="checkbox" style={{ cursor: "pointer" }}>
                            <input type="radio" name="mtrestart" checked={restartService} onChange={() => setRestartService(true)} disabled={locked} />
                            <span className="mono" style={{ color: restartService ? "var(--danger)" : undefined, fontWeight: restartService ? 600 : 400 }}>restartService = true</span>
                        </label>
                    </div>
                    <div className="row" style={{ gap: 16, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                        <label className="checkbox" style={{ cursor: "pointer" }} title={t(lang, "special.specifyRule.hint")}>
                            <input type="checkbox" checked={includeSpecifyRule} onChange={(e) => setIncludeSpecifyRule(e.target.checked)} disabled={locked} />
                            {t(lang, "special.specifyRule")}
                        </label>
                    </div>
                    <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{t(lang, "special.mode.hint")}</div>
                    {restartService && (
                        <div style={{
                            marginTop: 8, padding: "6px 10px", fontSize: 12,
                            border: "1px solid var(--danger)", borderRadius: 6,
                            color: "var(--danger)", background: "color-mix(in srgb, var(--danger) 8%, transparent)",
                        }}>
                            ⚠ {t(lang, "special.restart.warn")}
                        </div>
                    )}
                </div>

                {/* Device IDs */}
                <div className="form-row">
                    <label>{t(lang, "special.deviceIds")}</label>
                    <textarea
                        value={idsText}
                        onChange={(e) => setIdsText(e.target.value)}
                        disabled={locked}
                        style={{ minHeight: 120, fontFamily: "var(--mono, monospace)", fontSize: 12 }}
                        placeholder={t(lang, "special.deviceIds.placeholder")}
                    />
                    <div className="row" style={{ gap: 14, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                        <label className="checkbox" style={{ cursor: "pointer" }}>
                            <input type="checkbox" checked={dedupe} onChange={(e) => setDedupe(e.target.checked)} disabled={locked} />
                            {t(lang, "special.dedupe")}
                        </label>
                        <span className="muted" style={{ fontSize: 12 }}>
                            {t(lang, "special.parsed", { total })}
                            {parsed.dupes > 0 && <> · {t(lang, "special.dupes", { n: parsed.dupes })}</>}
                        </span>
                    </div>
                    {parsed.invalid.length > 0 && (
                        <div style={{ color: "var(--danger)", fontSize: 11, marginTop: 4, wordBreak: "break-all" }}>
                            {t(lang, "special.invalid", { n: parsed.invalid.length })}: {parsed.invalid.slice(0, 10).join(", ")}
                            {parsed.invalid.length > 10 && " …"}
                        </div>
                    )}
                </div>

                {/* Batch controls */}
                <div className="form-row">
                    <label>{t(lang, "special.batch")}</label>
                    <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                        <span className="muted" style={{ fontSize: 12 }}>{t(lang, "special.chunk")}</span>
                        <input
                            type="number" min={1} value={chunkSize}
                            onChange={(e) => setChunkSize(e.target.value)}
                            disabled={locked || useAllRemaining}
                            style={{ width: 90 }}
                        />
                        <label className="checkbox" style={{ cursor: "pointer" }}>
                            <input type="checkbox" checked={useAllRemaining} onChange={(e) => setUseAllRemaining(e.target.checked)} disabled={locked} />
                            {t(lang, "special.allRemaining")}
                        </label>
                        <span className="muted" style={{ fontSize: 11 }}>·</span>
                        <span className="muted" style={{ fontSize: 12 }}>{t(lang, "special.delay")}</span>
                        <input
                            type="number" min={0} value={delayMs}
                            onChange={(e) => setDelayMs(e.target.value)}
                            disabled={locked}
                            style={{ width: 90 }}
                        />
                        <span className="muted" style={{ fontSize: 11 }}>ms</span>
                        <label className="checkbox" style={{ cursor: "pointer", marginLeft: 6 }}>
                            <input type="checkbox" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} disabled={locked} />
                            {t(lang, "special.stopOnError")}
                        </label>
                    </div>
                    <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{t(lang, "special.batch.hint")}</div>
                </div>

                {/* Advanced (senderType) */}
                <div className="form-row">
                    <label className="checkbox" style={{ cursor: "pointer" }}>
                        <input type="checkbox" checked={showAdvanced} onChange={(e) => setShowAdvanced(e.target.checked)} />
                        {t(lang, "special.advanced")}
                    </label>
                    {showAdvanced && (
                        <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 8 }}>
                            <span className="muted" style={{ fontSize: 12 }}>senderType</span>
                            <select value={senderType} onChange={(e) => setSenderType(e.target.value)} disabled={locked} style={{ width: 200 }}>
                                {SENDER_TYPES.map((s) => (
                                    <option key={s} value={s}>{s}</option>
                                ))}
                            </select>
                        </div>
                    )}
                </div>

                {/* Progress + actions */}
                <div
                    style={{
                        background: "var(--panel-2)", borderRadius: 8, padding: 12,
                        display: "flex", flexDirection: "column", gap: 10,
                    }}
                >
                    <div className="row" style={{ gap: 16, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
                        <span><span className="muted">{t(lang, "special.stat.total")}</span> <b className="mono">{total.toLocaleString()}</b></span>
                        <span><span className="muted">{t(lang, "special.stat.sent")}</span> <b className="mono">{okPairs.toLocaleString()}</b> <span className="muted" style={{ fontSize: 11 }}>({okIds.toLocaleString()} dev · {okRecords.toLocaleString()} rec)</span></span>
                        {failedPairs > 0 && <span style={{ color: "var(--danger)" }}><span className="muted">{t(lang, "special.stat.failed")}</span> <b className="mono">{failedPairs.toLocaleString()}</b></span>}
                        <span><span className="muted">{t(lang, "special.stat.remaining")}</span> <b className="mono">{remaining.toLocaleString()}</b></span>
                        {running && <span style={{ color: "var(--accent, #2d7ff9)" }}>● {t(lang, "special.running")}</span>}
                        {!running && remaining === 0 && total > 0 && <span style={{ color: "var(--ok)" }}>✓ {t(lang, "special.allDone")}</span>}
                    </div>
                    <div style={{ height: 6, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${total > 0 ? (cursor / total) * 100 : 0}%`, background: "var(--accent, #2d7ff9)", transition: "width .15s" }} />
                    </div>
                    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                        <button className="primary" onClick={handleSendNext} disabled={locked || remaining <= 0 || !topic}>
                            {busy ? t(lang, "special.sending") : sendNextLabel}
                        </button>
                        {running ? (
                            <button className="danger" onClick={handleStop}>{t(lang, "special.stop")}</button>
                        ) : (
                            <button onClick={handleAutoRun} disabled={locked || remaining <= 0 || !topic}>
                                {t(lang, "special.autoRun")}
                            </button>
                        )}
                        <button onClick={handleReset} disabled={running || (cursor === 0 && log.length === 0)}>
                            {t(lang, "special.reset")}
                        </button>
                    </div>
                    {error && <div style={{ color: "var(--danger)", fontSize: 12, wordBreak: "break-all" }}>{error}</div>}
                </div>

                {/* Preview of the next pair */}
                <div>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                        {t(lang, "special.preview")} {preview && <span style={{ fontSize: 11 }}>— {t(lang, "special.preview.note")}</span>}
                    </div>
                    {preview ? (
                        <div style={{ display: "grid", gridTemplateColumns: preview.spec ? "1fr 1fr" : "1fr", gap: 10 }}>
                            <div>
                                <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 3 }}>① DEVICE_UPDATED_NOTIFICATION</div>
                                <pre style={preStyle}>{preview.dev}</pre>
                            </div>
                            {preview.spec && (
                                <div>
                                    <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 3 }}>② SPECIFY_RULE_UPDATED_NOTIFICATION</div>
                                    <pre style={preStyle}>{preview.spec}</pre>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="muted" style={{ fontSize: 12 }}>{t(lang, "special.preview.none")}</div>
                    )}
                </div>

                {/* Batch log */}
                <div>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                        {t(lang, "special.log")} ({log.length.toLocaleString()})
                    </div>
                    {log.length === 0 ? (
                        <div className="muted" style={{ fontSize: 12 }}>{t(lang, "special.log.empty")}</div>
                    ) : (
                        <div style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "auto", maxHeight: 240 }}>
                            {hiddenRows > 0 && (
                                <div className="muted" style={{ fontSize: 11, padding: "4px 8px" }}>{t(lang, "special.log.more", { n: hiddenRows })}</div>
                            )}
                            <table className="mono" style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                                <tbody>
                                    {shownLog.map((e) => (
                                        <tr key={e.no} style={{ borderTop: "1px solid var(--border)" }}>
                                            <td style={{ padding: "3px 8px", color: "var(--text-dim)", whiteSpace: "nowrap" }}>#{e.no}</td>
                                            <td style={{ padding: "3px 8px", whiteSpace: "nowrap" }}>
                                                {e.ok
                                                    ? <span style={{ color: "var(--ok)" }}>✓</span>
                                                    : <span style={{ color: "var(--danger)" }}>✗</span>}
                                                {" "}
                                                <span>{t(lang, "special.log.ids", { n: e.ids.length })}</span>
                                            </td>
                                            <td style={{ padding: "3px 8px", color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                                                restart={String(e.restartService)}
                                            </td>
                                            <td style={{ padding: "3px 8px", color: "var(--text-dim)", maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                                title={e.ids.join(", ")}>
                                                [{e.ids.slice(0, 12).join(", ")}{e.ids.length > 12 ? ", …" : ""}]
                                            </td>
                                            <td style={{ padding: "3px 8px", color: e.ok ? "var(--text-dim)" : "var(--danger)", whiteSpace: "nowrap" }}>
                                                {e.ok
                                                    ? (e.hasSpec
                                                        ? `p${e.devPart}@${e.devOff} · p${e.specPart}@${e.specOff}`
                                                        : `p${e.devPart}@${e.devOff}`)
                                                    : (e.error ?? "실패")}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

const preStyle: React.CSSProperties = {
    margin: 0,
    padding: 8,
    background: "var(--panel-2)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    fontSize: 11,
    lineHeight: 1.4,
    maxHeight: 260,
    overflow: "auto",
    whiteSpace: "pre",
};
