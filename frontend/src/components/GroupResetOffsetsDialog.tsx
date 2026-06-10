import { useMemo, useState } from "react";
import { Lang, t } from "../lib/i18n";
import { errString } from "../lib/errors";
import { ResetGroupOffsetsForTopic } from "../../wailsjs/go/main/App";
import { kafka } from "../../wailsjs/go/models";
import { Modal } from "./Modal";

type Mode = "earliest" | "latest" | "timestamp" | "explicit";

interface Props {
    lang: Lang;
    profileId: string;
    group: kafka.GroupView;
    topic: string;
    onClose: () => void;
    onSubmitted: () => void;
}

export function GroupResetOffsetsDialog({
    lang,
    profileId,
    group,
    topic,
    onClose,
    onSubmitted,
}: Props) {
    const [mode, setMode] = useState<Mode>("latest");
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [timestamp, setTimestamp] = useState("");
    // Explicit offsets keyed by partition (string for empty-input UX).
    const [explicit, setExplicit] = useState<Record<number, string>>(() => {
        const init: Record<number, string> = {};
        group.partitions.forEach((p) => {
            init[p.partition] = p.committedOffset >= 0 ? String(p.committedOffset) : "0";
        });
        return init;
    });

    const isActive = group.state === "Stable" || group.state === "PreparingRebalance" || group.state === "CompletingRebalance";
    const stateColor =
        group.state === "Stable" ? "var(--ok)" :
            group.state === "Empty" ? "var(--warn)" :
                group.state === "Dead" ? "var(--danger)" : "var(--text-dim)";

    const partitionsSorted = useMemo(
        () => [...group.partitions].sort((a, b) => a.partition - b.partition),
        [group.partitions],
    );

    const parseTimestampMs = (s: string): number | null => {
        const trimmed = s.trim();
        if (!trimmed) return null;
        if (/^\d+$/.test(trimmed)) {
            const n = Number(trimmed);
            return Number.isFinite(n) ? n : null;
        }
        const ms = Date.parse(trimmed);
        return Number.isNaN(ms) ? null : ms;
    };

    const handleExecute = async () => {
        setBusy(true);
        setErr(null);
        try {
            let timestampMs = 0;
            let explicitPayload: kafka.ExplicitOffset[] = [];
            if (mode === "timestamp") {
                const ms = parseTimestampMs(timestamp);
                if (ms === null) {
                    throw new Error(t(lang, "group.reset.invalidTimestamp"));
                }
                timestampMs = ms;
            } else if (mode === "explicit") {
                explicitPayload = partitionsSorted.map((p) => {
                    const raw = explicit[p.partition] ?? "";
                    const n = Number(raw);
                    if (!Number.isFinite(n) || n < 0) {
                        throw new Error(`partition ${p.partition}: ${raw || "(empty)"}`);
                    }
                    return { partition: p.partition, offset: n };
                });
            }
            await ResetGroupOffsetsForTopic(
                profileId,
                group.groupId,
                topic,
                mode,
                timestampMs,
                explicitPayload as any,
            );
            onSubmitted();
        } catch (e) {
            setErr(errString(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            title={
                <>
                    {t(lang, "group.reset.title")}
                    <span className="mono muted" style={{ marginLeft: 8 }}>{group.groupId}</span>
                </>
            }
            width={640}
            maxHeight="90vh"
            bodyStyle={{ display: "flex", flexDirection: "column", gap: 12 }}
            onClose={busy ? undefined : onClose}
            footer={
                <>
                    <button onClick={onClose} disabled={busy}>{t(lang, "profile.cancel")}</button>
                    <button
                        className="primary"
                        onClick={handleExecute}
                        disabled={busy || isActive}
                    >
                        {busy ? t(lang, "reassign.executing") : t(lang, "group.reset.submit")}
                    </button>
                </>
            }
        >
            <div className="row" style={{ gap: 14, alignItems: "center", fontSize: 12 }}>
                        <span className="muted">{t(lang, "group.reset.topic")}: <span className="mono">{topic}</span></span>
                        <span className="muted">
                            {t(lang, "group.reset.state")}:{" "}
                            <span style={{ color: stateColor, fontWeight: 600 }}>{group.state}</span>
                        </span>
                    </div>

                    {isActive && (
                        <div style={{ color: "var(--warn)", fontSize: 12, padding: "8px 10px", border: "1px solid var(--warn)", borderRadius: 6, background: "var(--warn-soft-bg)" }}>
                            ⚠ {t(lang, "group.activeBlocked")}
                        </div>
                    )}

                    <div className="form-row">
                        <label>{t(lang, "group.reset.mode")}</label>
                        <div className="col" style={{ gap: 6 }}>
                            {(["earliest", "latest", "timestamp", "explicit"] as Mode[]).map((m) => (
                                <label key={m} className="checkbox" style={{ cursor: "pointer" }}>
                                    <input
                                        type="radio"
                                        name="reset-mode"
                                        checked={mode === m}
                                        onChange={() => setMode(m)}
                                    />
                                    {t(lang, `group.reset.mode.${m}`)}
                                </label>
                            ))}
                        </div>
                    </div>

                    {mode === "timestamp" && (
                        <div className="form-row">
                            <label>{t(lang, "group.reset.timestamp")}</label>
                            <input
                                value={timestamp}
                                onChange={(e) => setTimestamp(e.target.value)}
                                placeholder="2026-05-19T09:00:00Z"
                                autoFocus
                            />
                            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                                {t(lang, "group.reset.timestamp.hint")}
                            </div>
                        </div>
                    )}

                    {mode === "explicit" && (
                        <div className="form-row">
                            <label>{t(lang, "group.reset.partitionTable")}</label>
                            <div style={{ maxHeight: 280, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
                                <table className="inner-table">
                                    <thead>
                                        <tr>
                                            <th style={{ width: 50 }}>{t(lang, "group.reset.col.partition")}</th>
                                            <th>{t(lang, "group.reset.col.committed")}</th>
                                            <th>{t(lang, "group.reset.col.end")}</th>
                                            <th>{t(lang, "group.reset.col.new")}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {partitionsSorted.map((p) => (
                                            <tr key={p.partition}>
                                                <td className="mono">{p.partition}</td>
                                                <td className="mono">{p.committedOffset < 0 ? "—" : p.committedOffset.toLocaleString()}</td>
                                                <td className="mono">{p.endOffset < 0 ? "—" : p.endOffset.toLocaleString()}</td>
                                                <td>
                                                    <input
                                                        className="mono"
                                                        type="number"
                                                        min={0}
                                                        value={explicit[p.partition] ?? ""}
                                                        onChange={(e) =>
                                                            setExplicit((prev) => ({ ...prev, [p.partition]: e.target.value }))
                                                        }
                                                        style={{ width: "100%" }}
                                                    />
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

            {err && <div style={{ color: "var(--danger)", fontSize: 12 }}>{err}</div>}
        </Modal>
    );
}
