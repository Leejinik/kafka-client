import { useRef, useState } from "react";
import { Lang, t } from "../lib/i18n";
import { errString } from "../lib/errors";
import { SaveProfile, TestConnectionInfo, RemoteListDir, RemoteReadFile, ParseCert } from "../../wailsjs/go/main/App";
import { profile } from "../../wailsjs/go/models";
import { Modal } from "./Modal";

interface Props {
    lang: Lang;
    editing?: profile.Profile;
    onClose: () => void;
    onSaved: () => void;
}

// A broker row is the structured form of one seed: an advertised hostname (the
// cert CN under SSL), an optional IP it resolves to, and a port. Bootstrap
// servers and host aliases are derived from these on save.
interface BrokerRow {
    host: string;
    ip: string;
    port: string;
}

function splitHostPort(s: string): { host: string; port: string } {
    const i = s.lastIndexOf(":");
    if (i < 0) return { host: s.trim(), port: "" };
    return { host: s.slice(0, i).trim(), port: s.slice(i + 1).trim() };
}

function rowsFromProfile(servers?: string[], aliases?: Record<string, string>): BrokerRow[] {
    const al = aliases ?? {};
    const valueToKey: Record<string, string> = {};
    for (const [k, v] of Object.entries(al)) valueToKey[v] = k;
    const used = new Set<string>();
    const rows: BrokerRow[] = [];
    for (const s of servers ?? []) {
        const { host, port } = splitHostPort(s);
        if (al[host] !== undefined) {
            rows.push({ host, ip: al[host], port });
            used.add(host);
        } else if (valueToKey[host] !== undefined) {
            const key = valueToKey[host];
            rows.push({ host: key, ip: host, port });
            used.add(key);
        } else {
            rows.push({ host, ip: "", port });
        }
    }
    for (const [k, v] of Object.entries(al)) {
        if (!used.has(k)) rows.push({ host: k, ip: v, port: "" });
    }
    if (rows.length === 0) rows.push({ host: "", ip: "", port: "" });
    return rows;
}

function buildServersAliases(rows: BrokerRow[]) {
    const servers: string[] = [];
    const aliases: Record<string, string> = {};
    for (const r of rows) {
        const host = r.host.trim();
        const ip = r.ip.trim();
        const port = r.port.trim();
        if (host && port) servers.push(`${host}:${port}`);
        if (host && ip) aliases[host] = ip;
    }
    return { servers, aliases };
}

type ClusterInfo = {
    clusterId: string;
    controller: number;
    brokers: { nodeId: number; host: string; port: number; rack?: string }[];
};
type CertInfo = { commonName: string; dnsNames?: string[]; isCA: boolean; selfSigned: boolean; notAfter: string; count: number; hasCA: boolean; hasLeaf: boolean };

export function ProfileDialog({ lang, editing, onClose, onSaved }: Props) {
    const [name, setName] = useState(editing?.name ?? "");
    const [brokers, setBrokers] = useState<BrokerRow[]>(rowsFromProfile(editing?.bootstrapServers, editing?.hostAliases));
    const [schemaReg, setSchemaReg] = useState(editing?.schemaRegistryUrl ?? "");
    const [defaultTopic, setDefaultTopic] = useState(editing?.defaultTopic ?? "");

    const setRow = (i: number, patch: Partial<BrokerRow>) =>
        setBrokers((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    const addRow = () => setBrokers((prev) => [...prev, { host: "", ip: "", port: "" }]);
    const removeRow = (i: number) => setBrokers((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)));

    // Fill a broker's hostname from a parsed broker cert — conservatively, so a
    // cert is never assigned to the wrong broker:
    //  - if it's already some row's host, do nothing;
    //  - if sourceHost is given (SSH), fill only the row matching that IP/host,
    //    never an arbitrary fallback row;
    //  - if there's no sourceHost (file/paste), fill only when exactly one row
    //    still has an empty host (otherwise it's ambiguous — leave it to the user).
    const applyHostname = (cn: string, sourceHost?: string) => {
        setBrokers((prev) => {
            if (prev.some((b) => b.host.trim().toLowerCase() === cn.toLowerCase())) return prev;
            let idx = -1;
            if (sourceHost) {
                idx = prev.findIndex((b) => b.ip.trim() === sourceHost || b.host.trim() === sourceHost);
            } else {
                const empties = prev.map((b, i) => [b, i] as const).filter(([b]) => !b.host.trim());
                if (empties.length === 1) idx = empties[0][1];
            }
            if (idx < 0) return prev;
            return prev.map((b, i) => (i === idx ? { ...b, host: cn } : b));
        });
    };

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
    const [showCertPopup, setShowCertPopup] = useState(false);
    const [certInfo, setCertInfo] = useState<CertInfo | null>(null);
    const [certMsg, setCertMsg] = useState<string | null>(null);

    // Add a certificate to the trust bundle (append + dedupe), parse it, and —
    // only if it's genuinely a broker leaf (not self-signed, not a CA) with a
    // hostname — auto-fill the matching broker row's hostname.
    const lastParsedRef = useRef<string>("");
    const addCert = async (pem: string, sourceHost?: string) => {
        const trimmed = pem.trim();
        if (!trimmed) return;
        setCaCert((prev) => (prev.includes(trimmed) ? prev : prev.trim() ? prev.trim() + "\n" + trimmed : trimmed));
        // Skip redundant re-parsing (e.g. the textarea onBlur firing with unchanged text).
        if (!sourceHost && trimmed === lastParsedRef.current) return;
        lastParsedRef.current = trimmed;
        try {
            const info = (await ParseCert(trimmed)) as CertInfo;
            setCertInfo(info);
            const hostname = info.commonName || info.dnsNames?.[0] || "";
            if (!info.selfSigned && !info.isCA && hostname) {
                applyHostname(hostname, sourceHost);
                setCertMsg(`${t(lang, "profile.ssl.cert.leaf")} (${hostname})`);
            } else {
                setCertMsg(`${t(lang, "profile.ssl.cert.ca")} (${info.commonName || hostname || "?"})`);
            }
        } catch (e) {
            setCertMsg(errString(e));
        }
    };

    // --- Remote cert fetch over SSH (per-broker FTP-style browser) ---
    type SshCreds = { port: number; user: string; password: string; dir: string };
    const initRemotes = (): Record<string, SshCreds> => {
        const out: Record<string, SshCreds> = {};
        const list = editTls?.remotes ?? (editTls?.remote ? [editTls.remote] : []);
        for (const r of list) {
            const key = (r.host ?? "").trim();
            if (!key) continue;
            out[key] = { port: r.port ?? 22, user: r.user ?? "", password: r.password ?? "", dir: r.dir ?? "" };
        }
        return out;
    };
    const [remotesByHost, setRemotesByHost] = useState<Record<string, SshCreds>>(initRemotes);
    const savedHosts = Object.keys(remotesByHost);
    const brokerTargets = Array.from(new Set(brokers.map((b) => b.ip.trim() || b.host.trim()).filter(Boolean)));
    const sshTargets = Array.from(new Set([...brokerTargets, ...savedHosts])).filter(Boolean);
    const [rHost, setRHost] = useState<string>(savedHosts[0] ?? brokerTargets[0] ?? "");
    const [rEntries, setREntries] = useState<{ name: string; isDir: boolean }[]>([]);
    const [rListed, setRListed] = useState(false);
    const [rBusy, setRBusy] = useState(false);
    const [rMsg, setRMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
    const [showRemote, setShowRemote] = useState((editTls?.remotes?.length ?? 0) > 0 || !!editTls?.remote);

    const emptyCreds: SshCreds = { port: 22, user: "", password: "", dir: "" };
    const cur: SshCreds = remotesByHost[rHost] ?? emptyCreds;
    const setCur = (patch: Partial<SshCreds>) =>
        setRemotesByHost((prev) => ({ ...prev, [rHost]: { ...(prev[rHost] ?? emptyCreds), ...patch } }));
    const selectHost = (h: string) => {
        setRHost(h);
        setREntries([]);
        setRListed(false);
        setRMsg(null);
    };
    const hostConfigured = (h: string) => {
        const c = remotesByHost[h];
        return !!c && (c.user.trim() !== "" || c.password !== "");
    };
    const targetLabel = (target: string) => {
        const b = brokers.find((br) => (br.ip.trim() || br.host.trim()) === target);
        if (b && b.host.trim() && b.ip.trim()) return `${b.host.trim()} (${b.ip.trim()})`;
        return target;
    };
    const normDir = (p: string) => {
        const s = p.trim().replace(/\/+$/, "");
        return s === "" ? "/" : s;
    };
    const parentOf = (p: string) => {
        const s = normDir(p);
        const i = s.lastIndexOf("/");
        return i <= 0 ? "/" : s.slice(0, i);
    };
    const joinPath = (p: string, n: string) => (normDir(p) === "/" ? "" : normDir(p)) + "/" + n;

    const browseRemote = async (path: string) => {
        if (!rHost.trim()) {
            setRMsg({ kind: "err", text: t(lang, "profile.ssl.remote.nohost") });
            return;
        }
        setRBusy(true);
        setRMsg(null);
        try {
            const entries = await RemoteListDir(rHost.trim(), cur.port || 22, cur.user.trim(), cur.password, normDir(path));
            setREntries(entries || []);
            setCur({ dir: normDir(path) });
            setRListed(true);
        } catch (e) {
            setRMsg({ kind: "err", text: errString(e) });
        } finally {
            setRBusy(false);
        }
    };
    const pickRemote = async (fileName: string) => {
        setRBusy(true);
        setRMsg(null);
        try {
            const content = await RemoteReadFile(rHost.trim(), cur.port || 22, cur.user.trim(), cur.password, joinPath(cur.dir, fileName));
            await addCert(content, rHost.trim());
            setRMsg({ kind: "ok", text: `${t(lang, "profile.ssl.remote.loaded")} ${fileName}` });
        } catch (e) {
            setRMsg({ kind: "err", text: errString(e) });
        } finally {
            setRBusy(false);
        }
    };
    const isCertFile = (n: string) => /\.(crt|pem|cer|cert)$/i.test(n);

    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
    const [testInfo, setTestInfo] = useState<ClusterInfo | null>(null);

    // Hidden <input type=file> wired to whichever handler asked for it.
    const fileTargetRef = useRef<((text: string) => void) | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const pickFile = (setter: (text: string) => void) => {
        fileTargetRef.current = setter;
        fileInputRef.current?.click();
    };
    const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => fileTargetRef.current?.(typeof reader.result === "string" ? reader.result : "");
        reader.readAsText(f);
    };

    const buildRemotes = () => {
        const list = Object.entries(remotesByHost)
            .filter(([h, c]) => h.trim() && (c.user.trim() || c.password || c.dir.trim()))
            .map(([h, c]) => ({
                host: h.trim(),
                port: c.port || undefined,
                user: c.user.trim() || undefined,
                password: c.password || undefined,
                dir: c.dir.trim() || undefined,
            }));
        return list.length ? list : undefined;
    };
    const buildTls = () => ({
        enabled: tlsEnabled,
        caCert: tlsEnabled ? caCert.trim() || undefined : undefined,
        clientCert: tlsEnabled ? clientCert.trim() || undefined : undefined,
        clientKey: tlsEnabled ? clientKey.trim() || undefined : undefined,
        insecureSkipVerify: tlsEnabled ? insecure || undefined : undefined,
        serverName: tlsEnabled ? serverName.trim() || undefined : undefined,
        remotes: tlsEnabled ? buildRemotes() : undefined,
    });

    const handleTest = async () => {
        const { servers, aliases } = buildServersAliases(brokers);
        if (servers.length === 0) {
            setMsg({ kind: "err", text: t(lang, "profile.brokers.required") });
            return;
        }
        setBusy(true);
        setMsg(null);
        setTestInfo(null);
        try {
            const info = await TestConnectionInfo(servers, aliases, buildTls() as any);
            setTestInfo(info as ClusterInfo);
            setMsg({ kind: "ok", text: "OK" });
        } catch (e) {
            setMsg({ kind: "err", text: errString(e) });
        } finally {
            setBusy(false);
        }
    };

    const handleSave = async () => {
        const { servers, aliases } = buildServersAliases(brokers);
        if (!name.trim() || servers.length === 0) {
            setMsg({ kind: "err", text: t(lang, "profile.brokers.required") });
            return;
        }
        setBusy(true);
        setMsg(null);
        try {
            const payload = profile.Profile.createFrom({
                id: editing?.id ?? "",
                name: name.trim(),
                bootstrapServers: servers,
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
        <>
            <input ref={fileInputRef} type="file" accept=".crt,.pem,.cer,.cert,.key,.txt" style={{ display: "none" }} onChange={onFilePicked} />

            <Modal
                title={editing ? t(lang, "profile.dialog.title.edit") : t(lang, "profile.dialog.title.new")}
                onClose={busy || showCertPopup ? undefined : onClose}
                closeOnEsc={!showCertPopup}
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
                <div className="form-row">
                    <label>{t(lang, "profile.name")}</label>
                    <input value={name} onChange={(e) => setName(e.target.value)} />
                </div>

                <div className="form-row">
                    <label>{t(lang, "profile.brokers")}</label>
                    <div style={{ display: "flex", gap: 6, fontSize: 11, color: "var(--muted, #999)", padding: "0 2px 2px" }}>
                        <span style={{ flex: 3 }}>{t(lang, "profile.brokers.host")}</span>
                        <span style={{ flex: 3 }}>{t(lang, "profile.brokers.ip")}</span>
                        <span style={{ width: 70 }}>{t(lang, "profile.brokers.port")}</span>
                        <span style={{ width: 24 }} />
                    </div>
                    {brokers.map((b, i) => (
                        <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                            <input placeholder="kafka1.example.com" value={b.host} onChange={(e) => setRow(i, { host: e.target.value })} style={{ flex: 3, fontFamily: "monospace", fontSize: 12 }} />
                            <input placeholder="192.0.2.10" value={b.ip} onChange={(e) => setRow(i, { ip: e.target.value })} style={{ flex: 3, fontFamily: "monospace", fontSize: 12 }} />
                            <input placeholder="9092" inputMode="numeric" value={b.port} onChange={(e) => setRow(i, { port: e.target.value.replace(/[^0-9]/g, "") })} style={{ width: 70, fontFamily: "monospace", fontSize: 12 }} />
                            <button type="button" onClick={() => removeRow(i)} disabled={brokers.length <= 1} title={t(lang, "profile.brokers.remove")} style={{ width: 24, padding: 0 }}>
                                ✕
                            </button>
                        </div>
                    ))}
                    <button type="button" onClick={addRow} style={{ fontSize: 12, alignSelf: "flex-start", marginTop: 2 }}>
                        {t(lang, "profile.brokers.add")}
                    </button>
                    <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                        {t(lang, "profile.brokers.hint")}
                    </div>
                </div>

                {/* SSL toggle + cert popup launcher */}
                <div className="form-row">
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                        <input
                            type="checkbox"
                            checked={tlsEnabled}
                            onChange={(e) => {
                                const on = e.target.checked;
                                setTlsEnabled(on);
                                if (on && !caCert.trim()) setShowCertPopup(true);
                            }}
                            style={{ width: "auto" }}
                        />
                        <span>{t(lang, "profile.ssl")}</span>
                    </label>
                    {tlsEnabled && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                            <button type="button" onClick={() => setShowCertPopup(true)}>
                                {t(lang, "profile.ssl.configure")}
                            </button>
                            <span className="muted" style={{ fontSize: 12, color: caCert.trim() ? "var(--ok)" : undefined }}>
                                {caCert.trim() ? t(lang, "profile.ssl.certSet") : t(lang, "profile.ssl.certUnset")}
                            </span>
                        </div>
                    )}
                </div>

                <div className="form-row">
                    <label>{t(lang, "profile.defaultTopic")}</label>
                    <input value={defaultTopic} onChange={(e) => setDefaultTopic(e.target.value)} />
                </div>
                <div className="form-row">
                    <label>{t(lang, "profile.schemaRegistry")}</label>
                    <input value={schemaReg} onChange={(e) => setSchemaReg(e.target.value)} placeholder="http://..." />
                </div>

                {testInfo && (
                    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, marginTop: 8, fontSize: 12 }}>
                        <div style={{ marginBottom: 4 }}>
                            <b>{t(lang, "profile.test.brokers")}</b>
                            {" — "}
                            {t(lang, "profile.test.controller")} <b>B{testInfo.controller}</b>
                            {testInfo.clusterId ? `  ·  ${testInfo.clusterId}` : ""}
                        </div>
                        {testInfo.brokers.map((b) => (
                            <div key={b.nodeId} style={{ fontFamily: "monospace", color: b.nodeId === testInfo.controller ? "var(--ok)" : undefined }}>
                                B{b.nodeId} — {b.host}:{b.port}
                                {b.nodeId === testInfo.controller ? "  ★" : ""}
                            </div>
                        ))}
                    </div>
                )}
                {msg && <div style={{ color: msg.kind === "ok" ? "var(--ok)" : "var(--danger)", fontSize: 12, marginTop: 6 }}>{msg.text}</div>}
            </Modal>

            {/* ---- Certificate popup ---- */}
            {showCertPopup && (
                <Modal
                    title={t(lang, "profile.ssl.popup.title")}
                    onClose={() => setShowCertPopup(false)}
                    width={560}
                    footer={
                        <>
                            <div style={{ flex: 1 }} />
                            <button className="primary" onClick={() => setShowCertPopup(false)}>
                                {t(lang, "profile.ssl.close")}
                            </button>
                        </>
                    }
                >
                    <div className="form-row">
                        <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span>{t(lang, "profile.ssl.cert")}</span>
                            <button type="button" onClick={() => pickFile((txt) => addCert(txt))} style={{ fontSize: 11, padding: "2px 8px" }}>
                                {t(lang, "profile.ssl.cert.add")}
                            </button>
                        </label>
                        <textarea
                            value={caCert}
                            onChange={(e) => setCaCert(e.target.value)}
                            onBlur={() => caCert.trim() && addCert(caCert)}
                            placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
                            style={{ minHeight: 90, fontFamily: "monospace", fontSize: 11 }}
                        />
                        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                            {t(lang, "profile.ssl.cert.hint")}
                        </div>
                        {certMsg && <div style={{ fontSize: 11, marginTop: 4, color: "var(--ok)" }}>{certMsg}</div>}
                    </div>

                    {/* Remote cert browser (per broker) */}
                    <div className="form-row">
                        <button type="button" onClick={() => setShowRemote((v) => !v)} style={{ fontSize: 12, padding: "3px 10px", alignSelf: "flex-start" }}>
                            {showRemote ? "▾ " : "▸ "}
                            {t(lang, "profile.ssl.remote")}
                        </button>
                        {showRemote && (
                            <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, marginTop: 6, display: "flex", flexDirection: "column", gap: 8 }}>
                                <div style={{ display: "flex", gap: 8 }}>
                                    <select value={rHost} onChange={(e) => selectHost(e.target.value)} style={{ flex: 3 }}>
                                        <option value="">{t(lang, "profile.ssl.remote.selectHost")}</option>
                                        {sshTargets.map((h) => (
                                            <option key={h} value={h}>
                                                {hostConfigured(h) ? "✓ " : ""}
                                                {targetLabel(h)}
                                            </option>
                                        ))}
                                    </select>
                                    <input placeholder="22" value={cur.port} onChange={(e) => setCur({ port: parseInt(e.target.value, 10) || 0 })} style={{ width: 64 }} />
                                </div>
                                <div style={{ display: "flex", gap: 8 }}>
                                    <input placeholder="user" value={cur.user} onChange={(e) => setCur({ user: e.target.value })} style={{ flex: 1 }} />
                                    <input type="password" placeholder="password" value={cur.password} onChange={(e) => setCur({ password: e.target.value })} style={{ flex: 1 }} />
                                </div>
                                <div className="muted" style={{ fontSize: 11 }}>
                                    {t(lang, "profile.ssl.remote.perhost")}
                                </div>
                                <div style={{ display: "flex", gap: 8 }}>
                                    <input
                                        placeholder="/"
                                        value={cur.dir}
                                        onChange={(e) => setCur({ dir: e.target.value })}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter" && !rBusy) browseRemote(cur.dir);
                                        }}
                                        style={{ flex: 1, fontFamily: "monospace", fontSize: 12 }}
                                    />
                                    <button type="button" onClick={() => browseRemote(cur.dir)} disabled={rBusy || !rHost}>
                                        {t(lang, "profile.ssl.remote.go")}
                                    </button>
                                </div>
                                {rListed && (
                                    <div style={{ maxHeight: 190, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 4 }}>
                                        {normDir(cur.dir) !== "/" && (
                                            <div
                                                onClick={() => !rBusy && browseRemote(parentOf(cur.dir))}
                                                style={{ padding: "4px 8px", cursor: rBusy ? "default" : "pointer", fontSize: 12, fontFamily: "monospace", borderBottom: "1px solid var(--border)" }}
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
                                                    onClick={() => !rBusy && (en.isDir ? browseRemote(joinPath(cur.dir, en.name)) : pickRemote(en.name))}
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
                                {rMsg && <span style={{ color: rMsg.kind === "ok" ? "var(--ok)" : "var(--danger)", fontSize: 11 }}>{rMsg.text}</span>}
                            </div>
                        )}
                    </div>

                    {/* SSL advanced (2-way / verify) */}
                    <div className="form-row">
                        <button type="button" onClick={() => setShowAdvanced((v) => !v)} style={{ fontSize: 12, padding: "3px 10px", alignSelf: "flex-start" }}>
                            {showAdvanced ? "▾ " : "▸ "}
                            {t(lang, "profile.ssl.advanced")}
                        </button>
                    </div>
                    {showAdvanced && (
                        <>
                            <div className="form-row">
                                <label>{t(lang, "profile.ssl.serverName")}</label>
                                <input value={serverName} onChange={(e) => setServerName(e.target.value)} placeholder="kafka1.harry1.liz.com" />
                                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                                    {t(lang, "profile.ssl.serverName.hint")}
                                </div>
                            </div>
                            <div className="form-row">
                                <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <span>{t(lang, "profile.ssl.clientCert")}</span>
                                    <button type="button" onClick={() => pickFile(setClientCert)} style={{ fontSize: 11, padding: "2px 8px" }}>
                                        {t(lang, "profile.ssl.loadFile")}
                                    </button>
                                </label>
                                <textarea value={clientCert} onChange={(e) => setClientCert(e.target.value)} placeholder={"-----BEGIN CERTIFICATE-----\n..."} style={{ minHeight: 70, fontFamily: "monospace", fontSize: 11 }} />
                            </div>
                            <div className="form-row">
                                <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <span>{t(lang, "profile.ssl.clientKey")}</span>
                                    <button type="button" onClick={() => pickFile(setClientKey)} style={{ fontSize: 11, padding: "2px 8px" }}>
                                        {t(lang, "profile.ssl.loadFile")}
                                    </button>
                                </label>
                                <textarea value={clientKey} onChange={(e) => setClientKey(e.target.value)} placeholder={"-----BEGIN PRIVATE KEY-----\n..."} style={{ minHeight: 70, fontFamily: "monospace", fontSize: 11 }} />
                            </div>
                            <div className="form-row">
                                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                                    <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} style={{ width: "auto" }} />
                                    <span style={{ color: "var(--danger)" }}>{t(lang, "profile.ssl.insecure")}</span>
                                </label>
                                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                                    {t(lang, "profile.ssl.insecure.hint")}
                                </div>
                            </div>
                        </>
                    )}
                </Modal>
            )}
        </>
    );
}
