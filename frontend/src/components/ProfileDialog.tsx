import { useState } from "react";
import { Lang, t } from "../lib/i18n";
import { errString } from "../lib/errors";
import { SaveProfile, TestConnection } from "../../wailsjs/go/main/App";
import { profile } from "../../wailsjs/go/models";
import { useBackdropClose } from "../lib/useBackdropClose";

interface Props {
    lang: Lang;
    editing?: profile.Profile;
    onClose: () => void;
    onSaved: () => void;
}

function parseServers(text: string): string[] {
    return text
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function parseAliases(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const idx = line.indexOf("=");
        if (idx <= 0) continue;
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k && v) out[k] = v;
    }
    return out;
}

function aliasesToText(aliases?: Record<string, string>): string {
    if (!aliases) return "";
    return Object.entries(aliases).map(([k, v]) => `${k}=${v}`).join("\n");
}

export function ProfileDialog({ lang, editing, onClose, onSaved }: Props) {
    const [name, setName] = useState(editing?.name ?? "");
    const [servers, setServers] = useState((editing?.bootstrapServers ?? []).join("\n"));
    const [schemaReg, setSchemaReg] = useState(editing?.schemaRegistryUrl ?? "");
    const [defaultTopic, setDefaultTopic] = useState(editing?.defaultTopic ?? "");
    const [hostAliasesText, setHostAliasesText] = useState(aliasesToText(editing?.hostAliases));
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
    const backdrop = useBackdropClose(busy ? undefined : onClose);

    const handleTest = async () => {
        const list = parseServers(servers);
        const aliases = parseAliases(hostAliasesText);
        if (list.length === 0) return;
        setBusy(true);
        setMsg(null);
        try {
            await TestConnection(list, aliases);
            setMsg({ kind: "ok", text: "OK" });
        } catch (e) {
            setMsg({ kind: "err", text: errString(e) });
        } finally {
            setBusy(false);
        }
    };

    const handleSave = async () => {
        const list = parseServers(servers);
        if (!name.trim() || list.length === 0) {
            setMsg({ kind: "err", text: t(lang, "profile.bootstrap") });
            return;
        }
        setBusy(true);
        setMsg(null);
        try {
            const aliases = parseAliases(hostAliasesText);
            const payload = profile.Profile.createFrom({
                id: editing?.id ?? "",
                name: name.trim(),
                bootstrapServers: list,
                schemaRegistryUrl: schemaReg.trim() || undefined,
                defaultTopic: defaultTopic.trim() || undefined,
                hostAliases: Object.keys(aliases).length > 0 ? aliases : undefined,
            });
            await SaveProfile(payload);
            onSaved();
        } catch (e) {
            setMsg({ kind: "err", text: errString(e) });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="modal-backdrop" {...backdrop}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    {editing ? t(lang, "profile.dialog.title.edit") : t(lang, "profile.dialog.title.new")}
                </div>
                <div className="modal-body">
                    <div className="form-row">
                        <label>{t(lang, "profile.name")}</label>
                        <input value={name} onChange={(e) => setName(e.target.value)} />
                    </div>
                    <div className="form-row">
                        <label>{t(lang, "profile.bootstrap")}</label>
                        <textarea
                            value={servers}
                            onChange={(e) => setServers(e.target.value)}
                            placeholder="broker-1:9092&#10;broker-2:9092"
                        />
                    </div>
                    <div className="form-row">
                        <label>{t(lang, "profile.hostAliases")}</label>
                        <textarea
                            value={hostAliasesText}
                            onChange={(e) => setHostAliasesText(e.target.value)}
                            placeholder="broker-1=192.0.2.10&#10;broker-2=192.0.2.20&#10;broker-3=192.0.2.30"
                            style={{ minHeight: 90 }}
                        />
                        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                            {t(lang, "profile.hostAliases.hint")}
                        </div>
                    </div>
                    <div className="form-row">
                        <label>{t(lang, "profile.schemaRegistry")}</label>
                        <input value={schemaReg} onChange={(e) => setSchemaReg(e.target.value)} placeholder="http://..." />
                    </div>
                    <div className="form-row">
                        <label>{t(lang, "profile.defaultTopic")}</label>
                        <input value={defaultTopic} onChange={(e) => setDefaultTopic(e.target.value)} />
                    </div>
                    {msg && (
                        <div style={{ color: msg.kind === "ok" ? "var(--ok)" : "var(--danger)", fontSize: 12 }}>
                            {msg.text}
                        </div>
                    )}
                </div>
                <div className="modal-footer">
                    <button onClick={handleTest} disabled={busy}>
                        {t(lang, "profile.test")}
                    </button>
                    <div style={{ flex: 1 }} />
                    <button onClick={onClose} disabled={busy}>
                        {t(lang, "profile.cancel")}
                    </button>
                    <button className="primary" onClick={handleSave} disabled={busy}>
                        {t(lang, "profile.save")}
                    </button>
                </div>
            </div>
        </div>
    );
}
