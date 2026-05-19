import { useEffect, useRef, useState } from "react";
import { Lang, t } from "../lib/i18n";
import { errString } from "../lib/errors";
import { ConfigDir, ExportProfiles, ImportProfiles } from "../../wailsjs/go/main/App";

interface Props {
    lang: Lang;
    setLang: (l: Lang) => void;
    onProfilesChanged: () => Promise<void> | void;
}

export function SettingsPage({ lang, setLang, onProfilesChanged }: Props) {
    const [configDir, setConfigDir] = useState("");
    const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { ConfigDir().then(setConfigDir).catch(() => {}); }, []);

    const handleExport = async () => {
        try {
            const text = await ExportProfiles();
            const blob = new Blob([text], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `kafka-client-profiles_${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            setMsg({ kind: "ok", text: "OK" });
        } catch (e) {
            setMsg({ kind: "err", text: errString(e) });
        }
    };

    const handleImport = async (file: File) => {
        try {
            const text = await file.text();
            const n = await ImportProfiles(text);
            await onProfilesChanged();
            setMsg({ kind: "ok", text: `Imported ${n}` });
        } catch (e) {
            setMsg({ kind: "err", text: errString(e) });
        }
    };

    return (
        <div className="page" style={{ maxWidth: 640 }}>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="form-row">
                <label>{t(lang, "settings.lang")}</label>
                <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} style={{ width: 220 }}>
                    <option value="ko">{t(lang, "settings.lang.ko")}</option>
                    <option value="en">{t(lang, "settings.lang.en")}</option>
                </select>
            </div>

            <div className="form-row">
                <label>{t(lang, "settings.configDir")}</label>
                <input value={configDir} readOnly />
            </div>

            <div className="form-row">
                <label>&nbsp;</label>
                <div className="row">
                    <button onClick={handleExport}>{t(lang, "settings.export")}</button>
                    <button onClick={() => fileInputRef.current?.click()}>{t(lang, "settings.import")}</button>
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
            </div>

            {msg && (
                <div style={{ color: msg.kind === "ok" ? "var(--ok)" : "var(--danger)" }}>{msg.text}</div>
            )}

            <div className="form-row">
                <label>{t(lang, "settings.about")}</label>
                <div className="muted">{t(lang, "settings.about.body")}</div>
            </div>
        </div>
        </div>
    );
}
