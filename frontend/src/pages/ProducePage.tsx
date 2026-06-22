import { useEffect, useState } from "react";
import { Lang, t } from "../lib/i18n";
import { errString } from "../lib/errors";
import { ListTopics, Produce } from "../../wailsjs/go/main/App";
import { kafka } from "../../wailsjs/go/models";
import { LoadMessageDialog } from "../components/LoadMessageDialog";
import { SavedMessage, headersToText } from "../lib/savedMessages";
import { TimestampConverter } from "../components/TimestampConverter";
import { LoopProduceDialog } from "../components/LoopProduceDialog";

interface Props {
    lang: Lang;
    profileId: string;
    defaultTopic?: string;
    topic: string;
    onTopicChange: (topic: string) => void;
    // Bumped by the parent whenever topics are created/edited/deleted in the
    // Topics tab, so the topic list here refreshes without a reconnect.
    topicsRev?: number;
}

function prettifyJson(s: string): string {
    try {
        const obj = JSON.parse(s);
        // Only re-format if the parse produced an object/array; primitives
        // like "1234" should stay as-is.
        if (obj !== null && typeof obj === "object") {
            return JSON.stringify(obj, null, 2);
        }
    } catch { /* not JSON — leave untouched */ }
    return s;
}

function parseHeaders(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const idx = trimmed.indexOf("=");
        if (idx <= 0) continue;
        out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1);
    }
    return out;
}

export function ProducePage({ lang, profileId, defaultTopic, topic, onTopicChange, topicsRev }: Props) {
    const [topics, setTopics] = useState<string[]>([]);
    const [partition, setPartition] = useState<number>(-1);
    const [key, setKey] = useState("");
    const [value, setValue] = useState("");
    const [headersText, setHeadersText] = useState("");
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
    const [loadDialog, setLoadDialog] = useState(false);
    const [loopDialog, setLoopDialog] = useState(false);

    const handleLoad = (m: SavedMessage) => {
        // If the saved topic doesn't exist in the current cluster's list,
        // still surface it in the dropdown so the user can see what was set.
        if (!topics.includes(m.topic)) {
            setTopics((prev) => [...prev, m.topic].sort());
        }
        onTopicChange(m.topic);
        setPartition(m.partition);
        setKey(m.key);
        setValue(prettifyJson(m.value));
        setHeadersText(headersToText(m.headers));
        setLoadDialog(false);
        setResult(null);
    };

    useEffect(() => {
        (async () => {
            try {
                const list = await ListTopics(profileId);
                setTopics(list.map((t) => t.name));
                if (!topic && defaultTopic && list.find((t) => t.name === defaultTopic)) {
                    onTopicChange(defaultTopic);
                } else if (!topic && list.length > 0) {
                    onTopicChange(list[0].name);
                }
            } catch (e) {
                setResult({ kind: "err", text: errString(e) });
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [profileId, topicsRev]);

    const handleSend = async () => {
        if (!topic) return;
        setBusy(true);
        setResult(null);
        try {
            const req = kafka.ProduceRequest.createFrom({
                topic,
                key,
                value,
                headers: parseHeaders(headersText),
                partition,
            });
            const res = await Produce(profileId, req);
            setResult({
                kind: "ok",
                text: t(lang, "produce.result.ok", { partition: res.partition, offset: res.offset }),
            });
        } catch (e) {
            setResult({ kind: "err", text: t(lang, "produce.result.err", { err: errString(e) }) });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="page">
            <div className="page-toolbar">
                <select value={topic} onChange={(e) => onTopicChange(e.target.value)} style={{ width: 260 }}>
                    {topics.map((tn) => (
                        <option key={tn} value={tn}>{tn}</option>
                    ))}
                </select>
                <label className="toolbar-field">
                    <span className="toolbar-field-label">{t(lang, "produce.partition")}</span>
                    <input
                        type="number"
                        style={{ width: 100 }}
                        value={partition}
                        onChange={(e) => setPartition(Number(e.target.value))}
                    />
                </label>
                <button onClick={() => setLoadDialog(true)} title={t(lang, "saved.load.title")}>
                    {t(lang, "saved.load.button")}
                </button>
                <button onClick={() => setLoopDialog(true)} disabled={!topic} title={t(lang, "loop.title")}>
                    {t(lang, "loop.button")}
                </button>
                <button className="primary" onClick={handleSend} disabled={busy || !topic}>
                    {busy ? t(lang, "produce.sending") : t(lang, "produce.send")}
                </button>
                <div className="grow" />
            </div>

            {loadDialog && (
                <LoadMessageDialog
                    lang={lang}
                    onClose={() => setLoadDialog(false)}
                    onLoad={handleLoad}
                />
            )}

            {loopDialog && (
                <LoopProduceDialog
                    lang={lang}
                    profileId={profileId}
                    topic={topic}
                    partition={partition}
                    keyStr={key}
                    value={value}
                    headers={parseHeaders(headersText)}
                    onClose={() => setLoopDialog(false)}
                />
            )}

            <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="form-row">
                <label>{t(lang, "produce.key")}</label>
                <input value={key} onChange={(e) => setKey(e.target.value)} />
            </div>
            <div className="form-row">
                <label>{t(lang, "produce.value")}</label>
                <textarea
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    style={{ minHeight: 220 }}
                    placeholder='{"example": "payload"}'
                />
            </div>
            <div className="form-row">
                <label>{t(lang, "produce.headers")}</label>
                <textarea
                    value={headersText}
                    onChange={(e) => setHeadersText(e.target.value)}
                    placeholder="trace-id=abc-123&#10;source=manual"
                />
            </div>

            {result && (
                <div style={{ color: result.kind === "ok" ? "var(--ok)" : "var(--danger)" }}>{result.text}</div>
            )}

            <TimestampConverter
                lang={lang}
                style={{
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    marginTop: 8,
                    flex: "0 0 auto",
                }}
            />
            </div>
        </div>
    );
}
