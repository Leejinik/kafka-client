import { useState } from "react";
import { Lang, t } from "../lib/i18n";
import { Modal } from "./Modal";

interface Props {
    lang: Lang;
    initialTokens: string[];
    onClose: () => void;
    onSave: (tokens: string[]) => void;
}

// Splits a CSV string into trimmed, non-empty tokens.
function parseCsv(raw: string): string[] {
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

export function AdvancedSearchDialog({ lang, initialTokens, onClose, onSave }: Props) {
    const [text, setText] = useState(initialTokens.join(", "));

    const submit = () => {
        onSave(parseCsv(text));
    };

    return (
        <Modal
            title={t(lang, "consume.advanced.dialog.title")}
            width={480}
            onClose={onClose}
            footer={
                <>
                    <button onClick={() => setText("")}>{t(lang, "consume.advanced.dialog.clear")}</button>
                    <div style={{ flex: 1 }} />
                    <button onClick={onClose}>{t(lang, "consume.advanced.dialog.cancel")}</button>
                    <button className="primary" onClick={submit}>{t(lang, "consume.advanced.dialog.ok")}</button>
                </>
            }
        >
            <div className="form-row">
                <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={t(lang, "consume.advanced.dialog.placeholder")}
                    autoFocus
                    rows={3}
                    style={{ width: "100%", resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
                    }}
                />
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                {t(lang, "consume.advanced.dialog.hint")}
            </div>
        </Modal>
    );
}
