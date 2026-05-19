import { useMemo, useRef, useState } from "react";
import { Lang, t } from "../lib/i18n";
import { errString } from "../lib/errors";
import {
    SavedMessage,
    deleteSaved,
    exportSaved,
    importSaved,
    listSaved,
} from "../lib/savedMessages";
import { useBackdropClose } from "../lib/useBackdropClose";

interface Props {
    lang: Lang;
    onClose: () => void;
    onLoad: (m: SavedMessage) => void;
}

export function LoadMessageDialog({ lang, onClose, onLoad }: Props) {
    const [version, setVersion] = useState(0);
    const [search, setSearch] = useState("");
    const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const backdrop = useBackdropClose(onClose);

    const handleExport = () => {
        try {
            const text = exportSaved();
            const blob = new Blob([text], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `kafka-client-saved-messages_${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            setMsg({ kind: "ok", text: t(lang, "saved.io.exported") });
        } catch (e) {
            setMsg({ kind: "err", text: errString(e) });
        }
    };

    const handleImport = async (file: File) => {
        try {
            const text = await file.text();
            const n = importSaved(text);
            setVersion((v) => v + 1);
            setMsg({ kind: "ok", text: t(lang, "saved.io.imported", { n }) });
        } catch (e) {
            setMsg({ kind: "err", text: errString(e) });
        }
    };

    const all = useMemo(() => {
        const list = listSaved();
        list.sort((a, b) => a.name.localeCompare(b.name));
        return list;
        // version is intentional re-trigger after delete
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [version]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return all;
        return all.filter(
            (m) =>
                m.name.toLowerCase().includes(q) ||
                m.topic.toLowerCase().includes(q) ||
                (m.key || "").toLowerCase().includes(q),
        );
    }, [all, search]);

    const onDelete = (id: string) => {
        deleteSaved(id);
        setVersion((v) => v + 1);
    };

    return (
        <div className="modal-backdrop" {...backdrop}>
            <div
                className="modal"
                style={{ width: 720, maxWidth: "96vw", maxHeight: "90vh" }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="modal-header" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span>{t(lang, "saved.load.title")}</span>
                    <span className="count-pill">{all.length}</span>
                    <div style={{ flex: 1 }} />
                    <button className="small" onClick={handleExport} disabled={all.length === 0}>
                        {t(lang, "saved.io.export")}
                    </button>
                    <button className="small" onClick={() => fileInputRef.current?.click()}>
                        {t(lang, "saved.io.import")}
                    </button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="application/json,.json"
                        style={{ display: "none" }}
                        onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void handleImport(f);
                            e.target.value = "";
                        }}
                    />
                </div>
                <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {msg && (
                        <div style={{ color: msg.kind === "ok" ? "var(--ok)" : "var(--danger)", fontSize: 12 }}>
                            {msg.text}
                        </div>
                    )}
                    <input
                        placeholder={t(lang, "saved.load.search")}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        autoFocus
                    />

                    {all.length === 0 ? (
                        <div className="muted" style={{ padding: 14, textAlign: "center" }}>
                            {t(lang, "saved.load.empty")}
                        </div>
                    ) : (
                        <div style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "auto", maxHeight: "60vh" }}>
                            <table className="inner-table">
                                <thead>
                                    <tr>
                                        <th>{t(lang, "saved.col.name")}</th>
                                        <th style={{ width: 220 }}>{t(lang, "saved.col.topic")}</th>
                                        <th style={{ width: 50 }}>P</th>
                                        <th style={{ width: 130 }}>{t(lang, "saved.col.savedAt")}</th>
                                        <th style={{ width: 130 }}></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filtered.map((m) => (
                                        <tr key={m.id}>
                                            <td>{m.name}</td>
                                            <td className="mono">{m.topic}</td>
                                            <td className="mono">{m.partition}</td>
                                            <td className="muted" style={{ fontSize: 11 }}>
                                                {new Date(m.savedAt).toLocaleString()}
                                            </td>
                                            <td>
                                                <div className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
                                                    <button
                                                        className="small primary"
                                                        onClick={() => onLoad(m)}
                                                    >
                                                        {t(lang, "saved.load.pick")}
                                                    </button>
                                                    <button
                                                        className="small danger"
                                                        onClick={() => onDelete(m.id)}
                                                        title={t(lang, "saved.load.delete")}
                                                    >
                                                        ✕
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
                <div className="modal-footer">
                    <button onClick={onClose}>{t(lang, "help.close")}</button>
                </div>
            </div>
        </div>
    );
}
