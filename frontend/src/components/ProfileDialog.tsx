import { useRef, useState } from "react";
import { Lang, t } from "../lib/i18n";
import { errString } from "../lib/errors";
import { SaveProfile, TestConnection, RemoteListDir, RemoteReadFile } from "../../wailsjs/go/main/App";
import { profile } from "../../wailsjs/go/models";
import { Modal } from "./Modal";

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

    // --- SSL / TLS state ---
    const editTls = editing?.tls;
    const [tlsEnabled, setTlsEnabled] = useState(editTls?.enabled ?? false);
    const [caCert, setCaCert] = useState(editTls?.caCert ?? "");
    const [serverName, setServerName] = useState(editTls?.serverName ?? "");
    const [clientCert, setClientCert] = useState(editTls?.clientCert ?? "");
    const [clientKey, setClientKey] = useState(editTls?.clientKey ?? "");
    const [insecure, setInsecure] = useState(editTls?.insecureSkipVerify ?? false);
    const [showAdvanced, setShowAdvanced] = useState(
        !!(editTls?.serverName || editTls?.clientCert || editTls?.clientKey || editTls?.insecureSkipVerify)
    );

    // --- Remote CA fetch over SSH (FTP-style browser) ---
    const rf = editTls?.remote;
    const [rHost, setRHost] = useState(rf?.host ?? "");
    const [rPort, setRPort] = useState<number>(rf?.port ?? 22);
    const [rUser, setRUser] = useState(rf?.user ?? "");
    const [rPass, setRPass] = useState(rf?.password ?? "");
    const [rPath, setRPath] = useState(rf?.dir ?? "");
    const [rEntries, setREntries] = useState<{ name: string; isDir: boolean }[]>([]);
    const [rListed, setRListed] = useState(false);
    const [rBusy, setRBusy] = useState(false);
    const [rMsg, setRMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
    const [showRemote, setShowRemote] = useState(!!(rf?.host || rf?.user));

    const normDir = (p: string) => {
        const t = p.trim().replace(/\/+$/, "");
        return t === "" ? "/" : t;
    };
    const parentOf = (p: string) => {
        const t = normDir(p);
        const i = t.lastIndexOf("/");
        return i <= 0 ? "/" : t.slice(0, i);
    };
    const joinPath = (p: string, name: string) => (normDir(p) === "/" ? "" : normDir(p)) + "/" + name;

    // Browse a remote directory (SSH connect + ls).
    const browseRemote = async (path: string) => {
        setRBusy(true);
        setRMsg(null);
        try {
            const entries = await RemoteListDir(rHost.trim(), rPort || 22, rUser.trim(), rPass, normDir(path));
            setREntries(entries || []);
            setRPath(normDir(path));
            setRListed(true);
        } catch (e) {
            setRMsg({ kind: "err", text: errString(e) });
        } finally {
            setRBusy(false);
        }
    };

    // Pull a file at the current path into the CA field.
    const pickRemote = async (name: string) => {
        setRBusy(true);
        setRMsg(null);
        try {
            const content = await RemoteReadFile(rHost.trim(), rPort || 22, rUser.trim(), rPass, joinPath(rPath, name));
            setCaCert(content);
            setRMsg({ kind: "ok", text: `${t(lang, "profile.ssl.remote.loaded")} ${name}` });
        } catch (e) {
            setRMsg({ kind: "err", text: errString(e) });
        } finally {
            setRBusy(false);
        }
    };

    const isCertFile = (n: string) => /\.(crt|pem|cer|cert)$/i.test(n);

    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

    // Wire a hidden <input type=file> to a text setter (reads the file as text).
    const fileTargetRef = useRef<((text: string) => void) | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const pickFile = (setter: (text: string) => void) => {
        fileTargetRef.current = setter;
        fileInputRef.current?.click();
    };
    const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0];
        e.target.value = ""; // allow re-picking the same file
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
            const text = typeof reader.result === "string" ? reader.result : "";
            fileTargetRef.current?.(text);
        };
        reader.readAsText(f);
    };

    // Build the TLS payload sent to the backend. Always returns an object so the
    // Go side receives a value (disabled -> treated as PLAINTEXT).
    const buildTls = () => ({
        enabled: tlsEnabled,
        caCert: tlsEnabled ? caCert.trim() || undefined : undefined,
        clientCert: tlsEnabled ? clientCert.trim() || undefined : undefined,
        clientKey: tlsEnabled ? clientKey.trim() || undefined : undefined,
        insecureSkipVerify: tlsEnabled ? insecure || undefined : undefined,
        serverName: tlsEnabled ? serverName.trim() || undefined : undefined,
        remote:
            tlsEnabled && (rHost.trim() || rUser.trim())
                ? {
                      host: rHost.trim() || undefined,
                      port: rPort || undefined,
                      user: rUser.trim() || undefined,
                      password: rPass || undefined,
                      dir: rPath.trim() || undefined,
                  }
                : undefined,
    });

    const handleTest = async () => {
        const list = parseServers(servers);
        const aliases = parseAliases(hostAliasesText);
        if (list.length === 0) return;
        setBusy(true);
        setMsg(null);
        try {
            await TestConnection(list, aliases, buildTls() as any);
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
                tls: tlsEnabled ? buildTls() : undefined,
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
        <Modal
            title={editing ? t(lang, "profile.dialog.title.edit") : t(lang, "profile.dialog.title.new")}
            onClose={busy ? undefined : onClose}
            footer={
                <>
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
                </>
            }
        >
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".crt,.pem,.cer,.cert,.key,.txt"
                        style={{ display: "none" }}
                        onChange={onFilePicked}
                    />
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

                    {/* --- SSL / TLS --- */}
                    <div className="form-row">
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                            <input
                                type="checkbox"
                                checked={tlsEnabled}
                                onChange={(e) => setTlsEnabled(e.target.checked)}
                                style={{ width: "auto" }}
                            />
                            <span>{t(lang, "profile.ssl")}</span>
                        </label>
                        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                            {t(lang, "profile.ssl.hint")}
                        </div>
                    </div>
                    {tlsEnabled && (
                        <>
                            <div className="form-row">
                                <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <span>{t(lang, "profile.ssl.caCert")}</span>
                                    <button
                                        type="button"
                                        onClick={() => pickFile(setCaCert)}
                                        style={{ fontSize: 11, padding: "2px 8px" }}
                                    >
                                        {t(lang, "profile.ssl.loadFile")}
                                    </button>
                                </label>
                                <textarea
                                    value={caCert}
                                    onChange={(e) => setCaCert(e.target.value)}
                                    placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
                                    style={{ minHeight: 90, fontFamily: "monospace", fontSize: 11 }}
                                />
                                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                                    {t(lang, "profile.ssl.caCert.hint")}
                                </div>
                            </div>

                            {/* --- Remote CA fetch over SSH --- */}
                            <div className="form-row">
                                <button
                                    type="button"
                                    onClick={() => setShowRemote((v) => !v)}
                                    style={{ fontSize: 12, padding: "3px 10px", alignSelf: "flex-start" }}
                                >
                                    {showRemote ? "▾ " : "▸ "}
                                    {t(lang, "profile.ssl.remote")}
                                </button>
                                {showRemote && (
                                    <div
                                        style={{
                                            border: "1px solid var(--border)",
                                            borderRadius: 6,
                                            padding: 10,
                                            marginTop: 6,
                                            display: "flex",
                                            flexDirection: "column",
                                            gap: 8,
                                        }}
                                    >
                                        <div style={{ display: "flex", gap: 8 }}>
                                            <input
                                                placeholder="host (예: 192.168.1.171)"
                                                value={rHost}
                                                onChange={(e) => setRHost(e.target.value)}
                                                style={{ flex: 3 }}
                                            />
                                            <input
                                                placeholder="22"
                                                value={rPort}
                                                onChange={(e) => setRPort(parseInt(e.target.value, 10) || 0)}
                                                style={{ width: 64 }}
                                            />
                                        </div>
                                        <div style={{ display: "flex", gap: 8 }}>
                                            <input
                                                placeholder="user"
                                                value={rUser}
                                                onChange={(e) => setRUser(e.target.value)}
                                                style={{ flex: 1 }}
                                            />
                                            <input
                                                type="password"
                                                placeholder="password"
                                                value={rPass}
                                                onChange={(e) => setRPass(e.target.value)}
                                                style={{ flex: 1 }}
                                            />
                                        </div>
                                        {/* Path bar: editable + Go */}
                                        <div style={{ display: "flex", gap: 8 }}>
                                            <input
                                                placeholder="/"
                                                value={rPath}
                                                onChange={(e) => setRPath(e.target.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key === "Enter" && !rBusy) browseRemote(rPath);
                                                }}
                                                style={{ flex: 1, fontFamily: "monospace", fontSize: 12 }}
                                            />
                                            <button type="button" onClick={() => browseRemote(rPath)} disabled={rBusy}>
                                                {t(lang, "profile.ssl.remote.go")}
                                            </button>
                                        </div>
                                        {/* FTP-style entry browser */}
                                        {rListed && (
                                            <div
                                                style={{
                                                    maxHeight: 190,
                                                    overflowY: "auto",
                                                    border: "1px solid var(--border)",
                                                    borderRadius: 4,
                                                }}
                                            >
                                                {normDir(rPath) !== "/" && (
                                                    <div
                                                        onClick={() => !rBusy && browseRemote(parentOf(rPath))}
                                                        style={{
                                                            padding: "4px 8px",
                                                            cursor: rBusy ? "default" : "pointer",
                                                            fontSize: 12,
                                                            fontFamily: "monospace",
                                                            borderBottom: "1px solid var(--border)",
                                                        }}
                                                        onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(127,127,127,0.15)")}
                                                        onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                                                    >
                                                        📁 ..
                                                    </div>
                                                )}
                                                {rEntries.length === 0 && (
                                                    <div className="muted" style={{ padding: "6px 8px", fontSize: 12 }}>
                                                        {t(lang, "profile.ssl.remote.empty")}
                                                    </div>
                                                )}
                                                {rEntries.map((en) => {
                                                    const cert = !en.isDir && isCertFile(en.name);
                                                    return (
                                                        <div
                                                            key={(en.isDir ? "d:" : "f:") + en.name}
                                                            onClick={() =>
                                                                !rBusy &&
                                                                (en.isDir ? browseRemote(joinPath(rPath, en.name)) : pickRemote(en.name))
                                                            }
                                                            title={en.isDir ? en.name : t(lang, "profile.ssl.remote.pick")}
                                                            style={{
                                                                padding: "4px 8px",
                                                                cursor: rBusy ? "default" : "pointer",
                                                                fontSize: 12,
                                                                fontFamily: "monospace",
                                                                borderBottom: "1px solid var(--border)",
                                                                color: en.isDir ? "var(--text)" : cert ? "var(--ok)" : "var(--muted, #999)",
                                                                fontWeight: cert ? 600 : 400,
                                                            }}
                                                            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(127,127,127,0.15)")}
                                                            onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                                                        >
                                                            {en.isDir ? "📁" : cert ? "📄✓" : "📄"} {en.name}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                        {rMsg && (
                                            <span
                                                style={{
                                                    color: rMsg.kind === "ok" ? "var(--ok)" : "var(--danger)",
                                                    fontSize: 11,
                                                }}
                                            >
                                                {rMsg.text}
                                            </span>
                                        )}
                                        <div className="muted" style={{ fontSize: 11 }}>
                                            {t(lang, "profile.ssl.remote.hint")}
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="form-row">
                                <button
                                    type="button"
                                    onClick={() => setShowAdvanced((v) => !v)}
                                    style={{ fontSize: 12, padding: "3px 10px", alignSelf: "flex-start" }}
                                >
                                    {showAdvanced ? "▾ " : "▸ "}
                                    {t(lang, "profile.ssl.advanced")}
                                </button>
                            </div>

                            {showAdvanced && (
                                <>
                                    <div className="form-row">
                                        <label>{t(lang, "profile.ssl.serverName")}</label>
                                        <input
                                            value={serverName}
                                            onChange={(e) => setServerName(e.target.value)}
                                            placeholder="kafka1.harry1.liz.com"
                                        />
                                        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                                            {t(lang, "profile.ssl.serverName.hint")}
                                        </div>
                                    </div>
                                    <div className="form-row">
                                        <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                            <span>{t(lang, "profile.ssl.clientCert")}</span>
                                            <button
                                                type="button"
                                                onClick={() => pickFile(setClientCert)}
                                                style={{ fontSize: 11, padding: "2px 8px" }}
                                            >
                                                {t(lang, "profile.ssl.loadFile")}
                                            </button>
                                        </label>
                                        <textarea
                                            value={clientCert}
                                            onChange={(e) => setClientCert(e.target.value)}
                                            placeholder={"-----BEGIN CERTIFICATE-----\n..."}
                                            style={{ minHeight: 70, fontFamily: "monospace", fontSize: 11 }}
                                        />
                                    </div>
                                    <div className="form-row">
                                        <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                            <span>{t(lang, "profile.ssl.clientKey")}</span>
                                            <button
                                                type="button"
                                                onClick={() => pickFile(setClientKey)}
                                                style={{ fontSize: 11, padding: "2px 8px" }}
                                            >
                                                {t(lang, "profile.ssl.loadFile")}
                                            </button>
                                        </label>
                                        <textarea
                                            value={clientKey}
                                            onChange={(e) => setClientKey(e.target.value)}
                                            placeholder={"-----BEGIN PRIVATE KEY-----\n..."}
                                            style={{ minHeight: 70, fontFamily: "monospace", fontSize: 11 }}
                                        />
                                    </div>
                                    <div className="form-row">
                                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                                            <input
                                                type="checkbox"
                                                checked={insecure}
                                                onChange={(e) => setInsecure(e.target.checked)}
                                                style={{ width: "auto" }}
                                            />
                                            <span style={{ color: "var(--danger)" }}>{t(lang, "profile.ssl.insecure")}</span>
                                        </label>
                                        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                                            {t(lang, "profile.ssl.insecure.hint")}
                                        </div>
                                    </div>
                                </>
                            )}
                        </>
                    )}

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
        </Modal>
    );
}
