import { useState } from "react";
import { Lang, t } from "../lib/i18n";

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MIN = 60_000;

type Unit = "days" | "hours" | "minutes";

interface Props {
    lang: Lang;
    onApply: (ms: number) => void;
    onClose?: () => void;
}

// Inline "duration → ms" helper for topic configs measured in milliseconds
// (retention.ms, segment.ms, ...). Each unit accumulates independently and is
// clamped at 0, so there is NO borrow across units: you cannot land on 23h59m
// by doing days+1 then minutes-1. The result is purely the sum of the three
// non-negative counters. Seconds and milliseconds are intentionally omitted to
// keep the input unambiguous.
export function DurationCalculator({ lang, onApply, onClose }: Props) {
    const [days, setDays] = useState(0);
    const [hours, setHours] = useState(0);
    const [minutes, setMinutes] = useState(0);

    const totalMs = days * MS_PER_DAY + hours * MS_PER_HOUR + minutes * MS_PER_MIN;

    const units: {
        key: Unit;
        value: number;
        set: React.Dispatch<React.SetStateAction<number>>;
        label: string;
    }[] = [
        { key: "days", value: days, set: setDays, label: t(lang, "dur.days") },
        { key: "hours", value: hours, set: setHours, label: t(lang, "dur.hours") },
        { key: "minutes", value: minutes, set: setMinutes, label: t(lang, "dur.minutes") },
    ];

    const reset = () => {
        setDays(0);
        setHours(0);
        setMinutes(0);
    };

    // Human-readable echo of the result; zero units are dropped, all-zero → "0".
    const parts: string[] = [];
    if (days) parts.push(`${days}${t(lang, "dur.days")}`);
    if (hours) parts.push(`${hours}${t(lang, "dur.hours")}`);
    if (minutes) parts.push(`${minutes}${t(lang, "dur.minutes")}`);
    const human = parts.length ? parts.join(" ") : "0";

    return (
        <div style={{ padding: "12px 6px" }}>
            <div className="row" style={{ marginBottom: 10 }}>
                <div className="group-section-title" style={{ flex: 1 }}>
                    {t(lang, "dur.title")}
                </div>
                {onClose && (
                    <button className="small" onClick={onClose} title={t(lang, "dur.close")}>
                        ×
                    </button>
                )}
            </div>

            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                {units.map(({ key, value, set, label }) => (
                    <div key={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{label}</span>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <button
                                className="small"
                                onClick={() => set((v) => Math.max(0, v - 1))}
                                disabled={value <= 0}
                                title="-1"
                            >
                                −
                            </button>
                            <input
                                type="number"
                                min={0}
                                value={value}
                                onChange={(e) => {
                                    const n = Math.floor(Number(e.target.value));
                                    set(Number.isFinite(n) && n > 0 ? n : 0);
                                }}
                                style={{ width: 60, textAlign: "center" }}
                            />
                            <button className="small" onClick={() => set((v) => v + 1)} title="+1">
                                +
                            </button>
                        </div>
                    </div>
                ))}
            </div>

            <div
                style={{
                    marginTop: 12,
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    flexWrap: "wrap",
                }}
            >
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t(lang, "dur.result")}</span>
                <span className="mono" style={{ fontSize: 15, fontWeight: 600 }}>
                    {totalMs.toLocaleString()}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>ms</span>
                <span className="muted" style={{ fontSize: 12 }}>= {human}</span>
            </div>

            <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
                <button className="small" onClick={reset}>
                    {t(lang, "dur.reset")}
                </button>
                <button className="small primary" onClick={() => onApply(totalMs)}>
                    {t(lang, "dur.apply")}
                </button>
            </div>
        </div>
    );
}
