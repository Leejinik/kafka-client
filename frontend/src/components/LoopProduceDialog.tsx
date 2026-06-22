import { useEffect, useRef, useState } from "react";
import { Lang, t } from "../lib/i18n";
import { errString } from "../lib/errors";
import {
    GetLoopProduceStatus,
    StartLoopProduce,
    StopLoopProduce,
} from "../../wailsjs/go/main/App";
import { kafka } from "../../wailsjs/go/models";
import { Modal } from "./Modal";

type Mode = "max" | "interval";
type MaxStop = "count" | "duration";

interface Props {
    lang: Lang;
    profileId: string;
    topic: string;
    partition: number;
    keyStr: string;
    value: string;
    headers: Record<string, string>;
    onClose: () => void;
}

export function LoopProduceDialog({
    lang,
    profileId,
    topic,
    partition,
    keyStr,
    value,
    headers,
    onClose,
}: Props) {
    const [mode, setMode] = useState<Mode>("interval");
    const [maxStop, setMaxStop] = useState<MaxStop>("count");
    const [maxCount, setMaxCount] = useState("10000");
    const [maxDurationSec, setMaxDurationSec] = useState("10");
    const [intervalValue, setIntervalValue] = useState("1");
    const [intervalUnit, setIntervalUnit] = useState<"ms" | "s">("s");
    const [intervalCount, setIntervalCount] = useState("0"); // 0 = unlimited

    // Producer tuning (load test). Off by default → uses the shared client.
    const [useTuning, setUseTuning] = useState(false);
    const [tnCompression, setTnCompression] = useState<"none" | "gzip" | "snappy" | "lz4" | "zstd">("zstd");
    const [tnAcks, setTnAcks] = useState<"leader" | "all" | "none">("leader");
    const [tnBatchKB, setTnBatchKB] = useState("128"); // batch.size in KB
    const [tnLingerMs, setTnLingerMs] = useState("10"); // linger.ms
    const [tnBufferMB, setTnBufferMB] = useState("256"); // buffer.memory in MB

    const [status, setStatus] = useState<kafka.LoopProduceStatus | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const startedHereRef = useRef(false);

    // Poll status every 200ms.
    useEffect(() => {
        let alive = true;
        const tick = async () => {
            try {
                const s = await GetLoopProduceStatus(profileId);
                if (alive) setStatus(s);
            } catch { /* ignore */ }
        };
        void tick();
        const id = window.setInterval(tick, 200);
        return () => { alive = false; window.clearInterval(id); };
    }, [profileId]);

    // Auto-stop on dialog close, but only if WE started this loop.
    useEffect(() => {
        return () => {
            if (startedHereRef.current) {
                void StopLoopProduce(profileId).catch(() => {});
            }
        };
    }, [profileId]);

    const isRunning = !!status?.running;
    const sent = status?.sent ?? 0;
    const failed = status?.failed ?? 0;
    const elapsedMs = status?.elapsedMs ?? 0;
    const rate = status?.msgsPerSec ?? 0;
    const lastErr = status?.lastError ?? "";

    const handleStart = async () => {
        setErr(null);
        setBusy(true);
        try {
            const opts = {
                topic,
                key: keyStr,
                value,
                headers,
                partition,
                mode,
                intervalMs:
                    mode === "interval"
                        ? Math.max(1, Number(intervalValue) || 1) * (intervalUnit === "s" ? 1000 : 1)
                        : 0,
                count:
                    mode === "max"
                        ? maxStop === "count" ? Math.max(0, Number(maxCount) || 0) : 0
                        : Math.max(0, Number(intervalCount) || 0),
                durationMs:
                    mode === "max" && maxStop === "duration"
                        ? Math.max(0, Number(maxDurationSec) || 0) * 1000
                        : 0,
                tuning: useTuning
                    ? {
                          batchMaxBytes: Math.max(0, Number(tnBatchKB) || 0) * 1024,
                          lingerMs: Math.max(0, Number(tnLingerMs) || 0),
                          compression: tnCompression,
                          acks: tnAcks,
                          maxBufferedBytes: Math.max(0, Number(tnBufferMB) || 0) * 1024 * 1024,
                      }
                    : undefined,
            };

            await StartLoopProduce(profileId, opts as any);
            startedHereRef.current = true;
        } catch (e) {
            setErr(errString(e));
        } finally {
            setBusy(false);
        }
    };

    const handleStop = async () => {
        try {
            await StopLoopProduce(profileId);
        } catch (e) {
            setErr(errString(e));
        }
    };

    return (
        <Modal
            title={t(lang, "loop.title")}
            width={560}
            onClose={onClose}
            bodyStyle={{ display: "flex", flexDirection: "column", gap: 12 }}
            footer={
                <>
                    <button onClick={onClose}>{t(lang, "help.close")}</button>
                    {isRunning ? (
                        <button className="danger" onClick={handleStop}>{t(lang, "loop.stop")}</button>
                    ) : (
                        <button
                            className="primary"
                            onClick={handleStart}
                            disabled={busy || !topic}
                        >
                            {t(lang, "loop.start")}
                        </button>
                    )}
                </>
            }
        >
            <div className="muted" style={{ fontSize: 12 }}>
                        {t(lang, "loop.source")}: <span className="mono">{topic || "—"}</span>
                        {" · "}P{partition}
                        {keyStr && <> · key=<span className="mono">{keyStr}</span></>}
                        {" · "}value {value.length} bytes
                    </div>

                    <div className="form-row">
                        <label>{t(lang, "loop.mode")}</label>
                        <div className="row" style={{ gap: 14 }}>
                            <label className="checkbox" style={{ cursor: "pointer" }}>
                                <input
                                    type="radio"
                                    name="mode"
                                    checked={mode === "max"}
                                    onChange={() => setMode("max")}
                                    disabled={isRunning}
                                />
                                {t(lang, "loop.mode.max")}
                            </label>
                            <label className="checkbox" style={{ cursor: "pointer" }}>
                                <input
                                    type="radio"
                                    name="mode"
                                    checked={mode === "interval"}
                                    onChange={() => setMode("interval")}
                                    disabled={isRunning}
                                />
                                {t(lang, "loop.mode.interval")}
                            </label>
                        </div>
                    </div>

                    {mode === "max" && (
                        <div className="form-row">
                            <label>{t(lang, "loop.stopBy")}</label>
                            <div className="row" style={{ gap: 8, alignItems: "center" }}>
                                <label className="checkbox" style={{ cursor: "pointer" }}>
                                    <input
                                        type="radio"
                                        name="maxStop"
                                        checked={maxStop === "count"}
                                        onChange={() => setMaxStop("count")}
                                        disabled={isRunning}
                                    />
                                    {t(lang, "loop.stopBy.count")}
                                </label>
                                <input
                                    type="number"
                                    min={1}
                                    value={maxCount}
                                    onChange={(e) => setMaxCount(e.target.value)}
                                    disabled={maxStop !== "count" || isRunning}
                                    style={{ width: 120 }}
                                />
                            </div>
                            <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 6 }}>
                                <label className="checkbox" style={{ cursor: "pointer" }}>
                                    <input
                                        type="radio"
                                        name="maxStop"
                                        checked={maxStop === "duration"}
                                        onChange={() => setMaxStop("duration")}
                                        disabled={isRunning}
                                    />
                                    {t(lang, "loop.stopBy.duration")}
                                </label>
                                <input
                                    type="number"
                                    min={1}
                                    value={maxDurationSec}
                                    onChange={(e) => setMaxDurationSec(e.target.value)}
                                    disabled={maxStop !== "duration" || isRunning}
                                    style={{ width: 120 }}
                                />
                                <span className="muted" style={{ fontSize: 11 }}>{t(lang, "loop.seconds")}</span>
                            </div>
                        </div>
                    )}

                    {mode === "interval" && (
                        <div className="form-row">
                            <label>{t(lang, "loop.interval")}</label>
                            <div className="row" style={{ gap: 8, alignItems: "center" }}>
                                <input
                                    type="number"
                                    min={1}
                                    value={intervalValue}
                                    onChange={(e) => setIntervalValue(e.target.value)}
                                    disabled={isRunning}
                                    style={{ width: 100 }}
                                />
                                <select
                                    value={intervalUnit}
                                    onChange={(e) => setIntervalUnit(e.target.value as "ms" | "s")}
                                    disabled={isRunning}
                                    style={{ width: 80 }}
                                >
                                    <option value="ms">ms</option>
                                    <option value="s">{t(lang, "loop.seconds")}</option>
                                </select>
                                <span className="muted" style={{ fontSize: 11 }}>·</span>
                                <label className="checkbox" style={{ marginLeft: 8 }}>{t(lang, "loop.totalCount")}</label>
                                <input
                                    type="number"
                                    min={0}
                                    value={intervalCount}
                                    onChange={(e) => setIntervalCount(e.target.value)}
                                    disabled={isRunning}
                                    style={{ width: 100 }}
                                />
                                <span className="muted" style={{ fontSize: 11 }}>{t(lang, "loop.zeroUnlimited")}</span>
                            </div>
                        </div>
                    )}

                    <div className="form-row">
                        <label className="checkbox" style={{ cursor: "pointer" }}>
                            <input
                                type="checkbox"
                                checked={useTuning}
                                onChange={(e) => setUseTuning(e.target.checked)}
                                disabled={isRunning}
                            />
                            {t(lang, "loop.tuning")}
                        </label>
                        {useTuning && (
                            <div
                                style={{
                                    marginTop: 8,
                                    padding: 12,
                                    border: "1px solid var(--border)",
                                    borderRadius: 6,
                                    display: "grid",
                                    gridTemplateColumns: "auto 1fr",
                                    gap: "8px 10px",
                                    alignItems: "center",
                                }}
                            >
                                <label className="muted" style={{ fontSize: 12 }}>compression.type</label>
                                <select
                                    value={tnCompression}
                                    onChange={(e) => setTnCompression(e.target.value as any)}
                                    disabled={isRunning}
                                >
                                    <option value="none">none</option>
                                    <option value="gzip">gzip</option>
                                    <option value="snappy">snappy</option>
                                    <option value="lz4">lz4</option>
                                    <option value="zstd">zstd</option>
                                </select>

                                <label className="muted" style={{ fontSize: 12 }}>acks</label>
                                <select
                                    value={tnAcks}
                                    onChange={(e) => setTnAcks(e.target.value as any)}
                                    disabled={isRunning}
                                >
                                    <option value="leader">1 (leader)</option>
                                    <option value="all">all (-1)</option>
                                    <option value="none">0 (none)</option>
                                </select>

                                <label className="muted" style={{ fontSize: 12 }}>batch.size (KB)</label>
                                <input
                                    type="number"
                                    min={0}
                                    value={tnBatchKB}
                                    onChange={(e) => setTnBatchKB(e.target.value)}
                                    disabled={isRunning}
                                    style={{ width: 120 }}
                                />

                                <label className="muted" style={{ fontSize: 12 }}>linger.ms</label>
                                <input
                                    type="number"
                                    min={0}
                                    value={tnLingerMs}
                                    onChange={(e) => setTnLingerMs(e.target.value)}
                                    disabled={isRunning}
                                    style={{ width: 120 }}
                                />

                                <label className="muted" style={{ fontSize: 12 }}>buffer.memory (MB)</label>
                                <input
                                    type="number"
                                    min={0}
                                    value={tnBufferMB}
                                    onChange={(e) => setTnBufferMB(e.target.value)}
                                    disabled={isRunning}
                                    style={{ width: 120 }}
                                />

                                <span className="muted" style={{ gridColumn: "1 / -1", fontSize: 11 }}>
                                    {t(lang, "loop.tuning.hint")}
                                </span>
                            </div>
                        )}
                    </div>

                    <div
                        style={{
                            background: "var(--panel-2)",
                            borderRadius: 6,
                            padding: 12,
                            display: "grid",
                            gridTemplateColumns: "auto 1fr auto 1fr",
                            gap: "6px 14px",
                            alignItems: "center",
                            fontSize: 13,
                        }}
                    >
                        <span className="muted">{t(lang, "loop.stat.sent")}</span>
                        <span className="mono" style={{ fontWeight: 600 }}>{sent.toLocaleString()}</span>
                        <span className="muted">{t(lang, "loop.stat.failed")}</span>
                        <span
                            className="mono"
                            style={{ fontWeight: 600, color: failed > 0 ? "var(--danger)" : undefined }}
                        >
                            {failed.toLocaleString()}
                        </span>
                        <span className="muted">{t(lang, "loop.stat.rate")}</span>
                        <span className="mono" style={{ fontWeight: 600 }}>{rate.toFixed(1)} msg/s</span>
                        <span className="muted">{t(lang, "loop.stat.elapsed")}</span>
                        <span className="mono">{(elapsedMs / 1000).toFixed(2)} s</span>
                    </div>

                    {lastErr && (
                        <div style={{ color: "var(--danger)", fontSize: 12, wordBreak: "break-all" }}>
                            {t(lang, "loop.lastError")}: {lastErr}
                        </div>
                    )}
                    {err && <div style={{ color: "var(--danger)", fontSize: 12 }}>{err}</div>}
        </Modal>
    );
}
