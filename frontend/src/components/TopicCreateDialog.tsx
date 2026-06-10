import { Fragment, useState } from "react";
import { Lang, t } from "../lib/i18n";
import { errString } from "../lib/errors";
import { CreateTopic } from "../../wailsjs/go/main/App";
import { Modal } from "./Modal";
import { DurationCalculator } from "./DurationCalculator";

interface Props {
    lang: Lang;
    profileId: string;
    onClose: () => void;
    onCreated: (name: string) => void;
}

interface KV { key: string; value: string }

const DEFAULT_KEYS = [
    "retention.ms",
    "cleanup.policy",
    "compression.type",
    "max.message.bytes",
    "min.insync.replicas",
    "segment.ms",
];

export function TopicCreateDialog({ lang, profileId, onClose, onCreated }: Props) {
    const [name, setName] = useState("");
    const [partitions, setPartitions] = useState(1);
    const [replication, setReplication] = useState(3);
    const [rows, setRows] = useState<KV[]>([{ key: "", value: "" }]);
    const [calcRow, setCalcRow] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const updateRow = (i: number, patch: Partial<KV>) => {
        setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    };
    const addRow = () => setRows((rs) => [...rs, { key: "", value: "" }]);
    const removeRow = (i: number) => {
        setRows((rs) => rs.filter((_, idx) => idx !== i));
        setCalcRow(null); // row indices shift on delete; close the calculator to be safe
    };

    // Topic configs whose key ends in ".ms" are durations; offer the ms calculator.
    const isMsKey = (key: string) => key.trim().toLowerCase().endsWith(".ms");

    const handleCreate = async () => {
        if (!name.trim()) { setErr(t(lang, "topic.create.nameRequired")); return; }
        if (partitions <= 0) { setErr("partitions > 0"); return; }
        if (replication <= 0) { setErr("replication > 0"); return; }
        const configs: Record<string, string> = {};
        for (const r of rows) {
            const k = r.key.trim();
            if (!k) continue;
            configs[k] = r.value;
        }
        setBusy(true);
        setErr(null);
        try {
            await CreateTopic(profileId, name.trim(), partitions, replication, configs);
            onCreated(name.trim());
        } catch (e) {
            setErr(errString(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            title={t(lang, "topic.create.title")}
            width={560}
            onClose={busy ? undefined : onClose}
            footer={
                <>
                    <button onClick={onClose} disabled={busy}>{t(lang, "profile.cancel")}</button>
                    <button className="primary" onClick={handleCreate} disabled={busy}>
                        {busy ? t(lang, "common.loading") : t(lang, "topic.create.submit")}
                    </button>
                </>
            }
        >
                    <div className="form-row">
                        <label>{t(lang, "topic.name")}</label>
                        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my.topic" />
                    </div>
                    <div className="row" style={{ gap: 12 }}>
                        <div className="form-row" style={{ flex: 1 }}>
                            <label>{t(lang, "topic.partitions")}</label>
                            <input
                                type="number"
                                min={1}
                                value={partitions}
                                onChange={(e) => setPartitions(Number(e.target.value) || 0)}
                            />
                        </div>
                        <div className="form-row" style={{ flex: 1 }}>
                            <label>{t(lang, "topic.replication")}</label>
                            <input
                                type="number"
                                min={1}
                                value={replication}
                                onChange={(e) => setReplication(Number(e.target.value) || 0)}
                            />
                        </div>
                    </div>

                    <div className="form-row">
                        <label>{t(lang, "topic.configs")}</label>
                        <table className="inner-table">
                            <thead>
                                <tr>
                                    <th>{t(lang, "topic.cfg.key")}</th>
                                    <th>{t(lang, "topic.cfg.value")}</th>
                                    <th style={{ width: 32 }}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((r, i) => {
                                    const showCalc = isMsKey(r.key);
                                    return (
                                        <Fragment key={i}>
                                            <tr>
                                                <td>
                                                    <input
                                                        list="topic-cfg-keys"
                                                        value={r.key}
                                                        onChange={(e) => updateRow(i, { key: e.target.value })}
                                                        placeholder="retention.ms"
                                                    />
                                                </td>
                                                <td>
                                                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                                        <input
                                                            style={{ flex: 1 }}
                                                            value={r.value}
                                                            onChange={(e) => updateRow(i, { value: e.target.value })}
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
                                                <td>
                                                    <button className="small" onClick={() => removeRow(i)}>×</button>
                                                </td>
                                            </tr>
                                            {calcRow === i && showCalc && (
                                                <tr>
                                                    <td colSpan={3} style={{ background: "var(--panel-2)" }}>
                                                        <DurationCalculator
                                                            lang={lang}
                                                            onApply={(ms) => { updateRow(i, { value: String(ms) }); setCalcRow(null); }}
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
                        <datalist id="topic-cfg-keys">
                            {DEFAULT_KEYS.map((k) => <option key={k} value={k} />)}
                        </datalist>
                        <button className="small" style={{ marginTop: 6 }} onClick={addRow}>
                            + {t(lang, "topic.cfg.add")}
                        </button>
                    </div>

                    {err && <div style={{ color: "var(--danger)", fontSize: 12 }}>{err}</div>}
        </Modal>
    );
}
