import { Fragment, useEffect, useState } from "react";
import { Lang, t } from "../lib/i18n";
import { errString } from "../lib/errors";
import {
    AlterTopicConfigs,
    DescribeTopic,
    UpdateTopicPartitions,
} from "../../wailsjs/go/main/App";
import { kafka } from "../../wailsjs/go/models";
import { useBackdropClose } from "../lib/useBackdropClose";
import { DurationCalculator } from "./DurationCalculator";

interface Props {
    lang: Lang;
    profileId: string;
    topic: string;
    onClose: () => void;
    onSaved: () => void;
}

interface ConfigRow {
    key: string;
    value: string;
    original: string;
    source: string;
    sensitive: boolean;
}

export function TopicEditDialog({ lang, profileId, topic, onClose, onSaved }: Props) {
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [origPartitions, setOrigPartitions] = useState(0);
    const [partitions, setPartitions] = useState(0);
    const [replication, setReplication] = useState(0);
    const [rows, setRows] = useState<ConfigRow[]>([]);
    const [calcRow, setCalcRow] = useState<number | null>(null);
    const backdrop = useBackdropClose(busy ? undefined : onClose);

    // Topic configs whose key ends in ".ms" are durations; offer the ms calculator.
    const isMsKey = (key: string) => key.trim().toLowerCase().endsWith(".ms");

    useEffect(() => {
        let alive = true;
        (async () => {
            setLoading(true);
            setErr(null);
            try {
                const desc = await DescribeTopic(profileId, topic);
                if (!alive) return;
                setOrigPartitions(desc.partitions);
                setPartitions(desc.partitions);
                setReplication(desc.replicationFactor);
                const cfgs: ConfigRow[] = (desc.configs || []).map((c: kafka.TopicConfigEntry) => ({
                    key: c.key,
                    value: c.value,
                    original: c.value,
                    source: c.source,
                    sensitive: c.sensitive,
                }));
                setRows(cfgs);
            } catch (e) {
                if (alive) setErr(errString(e));
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => { alive = false; };
    }, [profileId, topic]);

    const updateRow = (i: number, value: string) => {
        setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, value } : r)));
    };
    const addCustomRow = () => {
        setRows((rs) => [...rs, { key: "", value: "", original: "", source: "USER", sensitive: false }]);
    };

    const handleSave = async () => {
        setBusy(true);
        setErr(null);
        try {
            if (partitions !== origPartitions) {
                if (partitions < origPartitions) {
                    throw new Error(t(lang, "topic.edit.partitionsOnlyIncrease"));
                }
                await UpdateTopicPartitions(profileId, topic, partitions);
            }
            const setConfigs: Record<string, string> = {};
            for (const r of rows) {
                const k = r.key.trim();
                if (!k) continue;
                if (r.value !== r.original) {
                    setConfigs[k] = r.value;
                }
            }
            if (Object.keys(setConfigs).length > 0) {
                await AlterTopicConfigs(profileId, topic, setConfigs, []);
            }
            onSaved();
        } catch (e) {
            setErr(errString(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="modal-backdrop" {...backdrop}>
            <div className="modal" style={{ width: 680, maxHeight: "85vh" }} onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    {t(lang, "topic.edit.title")} <span className="mono muted" style={{ marginLeft: 6 }}>{topic}</span>
                </div>
                <div className="modal-body">
                    {loading ? (
                        <div className="muted">{t(lang, "common.loading")}</div>
                    ) : (
                        <>
                            <div className="row" style={{ gap: 12 }}>
                                <div className="form-row" style={{ flex: 1 }}>
                                    <label>{t(lang, "topic.partitions")}</label>
                                    <input
                                        type="number"
                                        min={origPartitions}
                                        value={partitions}
                                        onChange={(e) => setPartitions(Number(e.target.value) || 0)}
                                    />
                                    <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                                        {t(lang, "topic.edit.partitionsHint", { current: origPartitions })}
                                    </div>
                                </div>
                                <div className="form-row" style={{ flex: 1 }}>
                                    <label>{t(lang, "topic.replication")}</label>
                                    <input type="number" value={replication} readOnly />
                                    <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                                        {t(lang, "topic.edit.replicationReadOnly")}
                                    </div>
                                </div>
                            </div>

                            <div className="form-row">
                                <label>{t(lang, "topic.configs")}</label>
                                <div style={{ maxHeight: 360, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
                                    <table className="inner-table">
                                        <thead>
                                            <tr>
                                                <th style={{ width: "40%" }}>{t(lang, "topic.cfg.key")}</th>
                                                <th>{t(lang, "topic.cfg.value")}</th>
                                                <th style={{ width: 110 }}>{t(lang, "topic.cfg.source")}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {rows.map((r, i) => {
                                                const changed = r.value !== r.original;
                                                const sensitiveLocked = r.sensitive && r.value === "";
                                                const showCalc = isMsKey(r.key) && !sensitiveLocked;
                                                return (
                                                    <Fragment key={i + r.key}>
                                                        <tr>
                                                            <td className="mono">{r.key || (
                                                                <input
                                                                    placeholder="key"
                                                                    onChange={(e) => {
                                                                        const v = e.target.value;
                                                                        setRows((rs) => rs.map((rr, idx) => idx === i ? { ...rr, key: v } : rr));
                                                                    }}
                                                                />
                                                            )}</td>
                                                            <td>
                                                                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                                                    <input
                                                                        value={sensitiveLocked ? "(sensitive)" : r.value}
                                                                        disabled={sensitiveLocked}
                                                                        onChange={(e) => updateRow(i, e.target.value)}
                                                                        style={{ flex: 1, ...(changed ? { borderColor: "var(--accent)", background: "var(--accent-soft-bg)" } : {}) }}
                                                                    />
                                                                    {showCalc && (
                                                                        <button
                                                                            className="small"
                                                                            title={t(lang, "dur.open")}
                                                                            onClick={() => setCalcRow(calcRow === i ? null : i)}
                                                                            style={{ flex: "0 0 auto", ...(calcRow === i ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}) }}
                                                                        >
                                                                            🧮
                                                                        </button>
                                                                    )}
                                                                </div>
                                                            </td>
                                                            <td className="muted" style={{ fontSize: 11 }}>{r.source.replace(/_CONFIG$/, "")}</td>
                                                        </tr>
                                                        {calcRow === i && showCalc && (
                                                            <tr>
                                                                <td colSpan={3} style={{ background: "var(--panel-2)" }}>
                                                                    <DurationCalculator
                                                                        lang={lang}
                                                                        onApply={(ms) => { updateRow(i, String(ms)); setCalcRow(null); }}
                                                                        onClose={() => setCalcRow(null)}
                                                                    />
                                                                </td>
                                                            </tr>
                                                        )}
                                                    </Fragment>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                                <button className="small" style={{ marginTop: 6 }} onClick={addCustomRow}>
                                    + {t(lang, "topic.cfg.add")}
                                </button>
                            </div>
                        </>
                    )}

                    {err && <div style={{ color: "var(--danger)", fontSize: 12 }}>{err}</div>}
                </div>
                <div className="modal-footer">
                    <button onClick={onClose} disabled={busy}>{t(lang, "profile.cancel")}</button>
                    <button className="primary" onClick={handleSave} disabled={busy || loading}>
                        {busy ? t(lang, "common.loading") : t(lang, "topic.edit.submit")}
                    </button>
                </div>
            </div>
        </div>
    );
}
