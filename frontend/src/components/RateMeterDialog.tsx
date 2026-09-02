import { useEffect, useMemo, useRef, useState } from "react";
import { Lang, t } from "../lib/i18n";
import { errString } from "../lib/errors";
import { TopicEndOffsets } from "../../wailsjs/go/main/App";
import { kafka } from "../../wailsjs/go/models";
import { Modal } from "./Modal";

interface Props {
    lang: Lang;
    profileId: string;
    topic: string;
    // All topics of the cluster, so the meter can be re-pointed without
    // closing the dialog.
    topics: string[];
    onClose: () => void;
}

// One tick of the meter: the snapshot the broker returned plus the ingress
// rate derived from the previous snapshot.
interface Sample {
    atMs: number;
    total: number; // sum of end offsets across partitions
    perPartition: Record<number, number>;
    rate: number | null; // msg/s since previous sample; null for the baseline
    perPartitionRate: Record<number, number>;
    perPartitionDelta: Record<number, number>;
}

const HISTORY = 120; // samples kept for the sparkline (2 min at 1s)
const INTERVALS = [1, 2, 5, 10];

// Ingress rate meter. Answers "how many messages/sec are landing on this
// topic right now?" WITHOUT consuming anything: each tick is a single
// ListOffsets request (end offsets per partition) and the rate is
// Δoffset / Δtime. tail -f, by contrast, has to pull every record through the
// UI and falls over on busy topics — this dialog is the zero-load substitute.
export function RateMeterDialog({ lang, profileId, topic: initialTopic, topics, onClose }: Props) {
    const [topic, setTopic] = useState(initialTopic);
    const [intervalSec, setIntervalSec] = useState(1);
    const [running, setRunning] = useState(true);
    const [samples, setSamples] = useState<Sample[]>([]);
    const [err, setErr] = useState<string | null>(null);
    const [partErrs, setPartErrs] = useState<Record<number, string>>({});
    // Session accumulators (survive the sparkline window being trimmed).
    const [baseline, setBaseline] = useState<{ atMs: number; total: number } | null>(null);
    const [peak, setPeak] = useState(0);

    const prevRef = useRef<Sample | null>(null);
    const intervalRef = useRef(intervalSec);
    useEffect(() => { intervalRef.current = intervalSec; }, [intervalSec]);

    const reset = () => {
        prevRef.current = null;
        setSamples([]);
        setBaseline(null);
        setPeak(0);
        setErr(null);
        setPartErrs({});
    };

    // Re-pointing the meter at another topic starts a fresh session.
    useEffect(() => { reset(); }, [topic]);

    // Sampling loop. setTimeout chain (not setInterval) so a slow broker
    // reply never piles up overlapping requests.
    useEffect(() => {
        if (!running || !topic) return;
        let alive = true;
        let timer = 0;

        const tick = async () => {
            const started = Date.now();
            try {
                const snap: kafka.EndOffsetsSnapshot = await TopicEndOffsets(profileId, topic);
                if (!alive) return;
                const perPartition: Record<number, number> = {};
                const errs: Record<number, string> = {};
                let total = 0;
                for (const p of snap.partitions ?? []) {
                    if (p.err) { errs[p.partition] = p.err; continue; }
                    if (p.endOffset < 0) continue;
                    perPartition[p.partition] = p.endOffset;
                    total += p.endOffset;
                }
                const prev = prevRef.current;
                const s: Sample = {
                    atMs: snap.sampledAtMs,
                    total,
                    perPartition,
                    rate: null,
                    perPartitionRate: {},
                    perPartitionDelta: {},
                };
                if (prev) {
                    const dt = (snap.sampledAtMs - prev.atMs) / 1000;
                    if (dt > 0) {
                        // A partition that vanished/was added mid-session contributes 0.
                        let delta = 0;
                        for (const [pidStr, end] of Object.entries(perPartition)) {
                            const pid = Number(pidStr);
                            const before = prev.perPartition[pid];
                            const d = before === undefined ? 0 : Math.max(0, end - before);
                            s.perPartitionDelta[pid] = d;
                            s.perPartitionRate[pid] = d / dt;
                            delta += d;
                        }
                        s.rate = delta / dt;
                    }
                }
                prevRef.current = s;
                setPartErrs(errs);
                setErr(null);
                setBaseline((b) => b ?? { atMs: snap.sampledAtMs, total });
                if (s.rate !== null) setPeak((p) => Math.max(p, s.rate as number));
                setSamples((arr) => {
                    const next = arr.length >= HISTORY ? arr.slice(arr.length - HISTORY + 1) : arr.slice();
                    next.push(s);
                    return next;
                });
            } catch (e) {
                if (!alive) return;
                setErr(errString(e));
            } finally {
                if (alive) {
                    // Keep the cadence anchored to the tick start so the
                    // broker round-trip doesn't stretch the interval.
                    const wait = Math.max(100, intervalRef.current * 1000 - (Date.now() - started));
                    timer = window.setTimeout(tick, wait);
                }
            }
        };
        void tick();
        return () => {
            alive = false;
            window.clearTimeout(timer);
        };
    }, [running, topic, profileId]);

    const last = samples.length > 0 ? samples[samples.length - 1] : null;
    const current = last?.rate ?? null;
    const elapsedSec = baseline && last ? (last.atMs - baseline.atMs) / 1000 : 0;
    const totalDelta = baseline && last ? Math.max(0, last.total - baseline.total) : 0;
    const avg = elapsedSec > 0 ? totalDelta / elapsedSec : null;

    const partitionRows = useMemo(() => {
        if (!last) return [];
        const pids = Object.keys(last.perPartition).map(Number).sort((a, b) => a - b);
        const sumRate = pids.reduce((acc, pid) => acc + (last.perPartitionRate[pid] ?? 0), 0);
        return pids.map((pid) => ({
            pid,
            endOffset: last.perPartition[pid],
            delta: last.perPartitionDelta[pid],
            rate: last.perPartitionRate[pid],
            share: sumRate > 0 ? ((last.perPartitionRate[pid] ?? 0) / sumRate) * 100 : 0,
        }));
    }, [last]);

    const errPids = Object.keys(partErrs).map(Number).sort((a, b) => a - b);

    return (
        <Modal
            title={`📈 ${t(lang, "rate.title")}`}
            width={680}
            onClose={onClose}
            footer={
                <div className="row" style={{ justifyContent: "space-between", width: "100%" }}>
                    <div className="row">
                        <button className="small" onClick={() => setRunning((r) => !r)}>
                            {running ? t(lang, "rate.pause") : t(lang, "rate.resume")}
                        </button>
                        <button className="small" onClick={reset}>{t(lang, "rate.reset")}</button>
                    </div>
                    <button onClick={onClose}>{t(lang, "common.close")}</button>
                </div>
            }
        >
            <div className="col" style={{ gap: 12 }}>
                <div className="row" style={{ flexWrap: "wrap" }}>
                    <span className="toolbar-field">
                        <span className="toolbar-field-label">{t(lang, "rate.topic")}</span>
                        <select value={topic} onChange={(e) => setTopic(e.target.value)} style={{ width: 280 }}>
                            {(topics.includes(topic) ? topics : [topic, ...topics]).map((tn) => (
                                <option key={tn} value={tn}>{tn}</option>
                            ))}
                        </select>
                    </span>
                    <span className="toolbar-field">
                        <span className="toolbar-field-label">{t(lang, "rate.interval")}</span>
                        <select value={intervalSec} onChange={(e) => setIntervalSec(Number(e.target.value))} style={{ width: 80 }}>
                            {INTERVALS.map((s) => <option key={s} value={s}>{s}s</option>)}
                        </select>
                    </span>
                    <span
                        className="count-pill"
                        style={{ color: running ? "var(--ok)" : "var(--text-dim)" }}
                        title={t(lang, "rate.desc")}
                    >
                        {running ? "● " + t(lang, "rate.state.running") : "‖ " + t(lang, "rate.state.paused")}
                    </span>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>{t(lang, "rate.desc")}</div>

                {err && <div style={{ color: "var(--danger)" }}>{err}</div>}

                {/* Headline stats */}
                <div
                    style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(5, 1fr)",
                        gap: 8,
                    }}
                >
                    <Stat label={t(lang, "rate.stat.current")} value={current === null ? "—" : fmtRate(current)} unit="msg/s" big />
                    <Stat label={t(lang, "rate.stat.avg")} value={avg === null ? "—" : fmtRate(avg)} unit="msg/s" />
                    <Stat label={t(lang, "rate.stat.peak")} value={samples.length < 2 ? "—" : fmtRate(peak)} unit="msg/s" />
                    <Stat label={t(lang, "rate.stat.total")} value={totalDelta.toLocaleString()} unit="msg" />
                    <Stat label={t(lang, "rate.stat.elapsed")} value={fmtElapsed(elapsedSec)} unit="" />
                </div>

                <Sparkline samples={samples} peak={peak} />

                {samples.length < 2 && !err && (
                    <div className="muted" style={{ fontSize: 12 }}>{t(lang, "rate.waiting")}</div>
                )}

                {/* Per-partition breakdown */}
                {partitionRows.length > 0 && (
                    <div className="group-card" style={{ maxHeight: 260, overflow: "auto" }}>
                        <table className="inner-table">
                            <thead>
                                <tr>
                                    <th style={{ width: 70 }}>{t(lang, "rate.col.partition")}</th>
                                    <th style={{ textAlign: "right" }}>{t(lang, "rate.col.endOffset")}</th>
                                    <th style={{ textAlign: "right", width: 110 }}>{t(lang, "rate.col.delta")}</th>
                                    <th style={{ textAlign: "right", width: 100 }}>msg/s</th>
                                    <th style={{ width: 140 }}>{t(lang, "rate.col.share")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {partitionRows.map((r) => (
                                    <tr key={r.pid}>
                                        <td className="mono">{r.pid}</td>
                                        <td className="mono" style={{ textAlign: "right" }}>{r.endOffset.toLocaleString()}</td>
                                        <td className="mono" style={{ textAlign: "right" }}>
                                            {r.delta === undefined ? "—" : r.delta > 0 ? `+${r.delta.toLocaleString()}` : "0"}
                                        </td>
                                        <td className="mono" style={{ textAlign: "right", fontWeight: 600 }}>
                                            {r.rate === undefined ? "—" : fmtRate(r.rate)}
                                        </td>
                                        <td>
                                            <div className="row" style={{ gap: 6 }}>
                                                <div style={{ flex: 1, height: 6, background: "var(--panel-2)", borderRadius: 3, overflow: "hidden" }}>
                                                    <div style={{ width: `${r.share}%`, height: "100%", background: "var(--accent, #4c8bf5)" }} />
                                                </div>
                                                <span className="mono muted" style={{ fontSize: 11, width: 38, textAlign: "right" }}>
                                                    {r.share.toFixed(0)}%
                                                </span>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {errPids.length > 0 && (
                    <div style={{ color: "var(--warn)", fontSize: 12 }}>
                        {errPids.map((pid) => <div key={pid} className="mono">p{pid}: {partErrs[pid]}</div>)}
                    </div>
                )}
            </div>
        </Modal>
    );
}

function Stat({ label, value, unit, big }: { label: string; value: string; unit: string; big?: boolean }) {
    return (
        <div className="group-card" style={{ padding: "8px 10px" }}>
            <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.03em" }}>{label}</div>
            <div className="mono" style={{ fontSize: big ? 22 : 16, fontWeight: 600, lineHeight: 1.3 }}>
                {value}
                {unit && <span className="muted" style={{ fontSize: 11, fontWeight: 400, marginLeft: 4 }}>{unit}</span>}
            </div>
        </div>
    );
}

// Bar sparkline of the recent ingress rates. Pure inline SVG — no chart lib.
function Sparkline({ samples, peak }: { samples: Sample[]; peak: number }) {
    const W = 640;
    const H = 64;
    const rates = samples.map((s) => s.rate).filter((r): r is number => r !== null);
    const max = Math.max(peak, ...rates, 1);
    const n = HISTORY;
    const slot = W / n;
    const barW = Math.max(1, slot - 1);
    // Right-align: newest sample at the right edge.
    const offset = n - rates.length;
    return (
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block", background: "var(--panel-2)", borderRadius: 4, height: H }}>
            {rates.map((r, i) => {
                const h = Math.max(1, (r / max) * (H - 4));
                return (
                    <rect
                        key={i}
                        x={(offset + i) * slot}
                        y={H - h - 2}
                        width={barW}
                        height={h}
                        fill={i === rates.length - 1 ? "var(--accent, #4c8bf5)" : "var(--text-dim)"}
                        opacity={i === rates.length - 1 ? 1 : 0.55}
                    />
                );
            })}
        </svg>
    );
}

function fmtRate(r: number): string {
    if (Number.isNaN(r)) return "—";
    if (r === 0) return "0";
    if (r < 1) return r.toFixed(2);
    if (r < 100) return r.toFixed(1);
    return Math.round(r).toLocaleString();
}

function fmtElapsed(sec: number): string {
    if (sec < 60) return `${sec.toFixed(0)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    if (m < 60) return `${m}m ${s}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}
