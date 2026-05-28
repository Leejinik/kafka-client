import { useState } from "react";
import { Lang, t } from "../lib/i18n";
import { useBackdropClose } from "../lib/useBackdropClose";

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
    const backdrop = useBackdropClose(onClose);

    const submit = () => {
        onSave(parseCsv(text));
    };

    return (
        <div className="modal-backdrop" {...backdrop}>
            <div className="modal" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">{t(lang, "consume.advanced.dialog.title")}</div>
                <div className="modal-body">
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
                </div>
                <div className="modal-footer">
                    <button onClick={() => setText("")}>{t(lang, "consume.advanced.dialog.clear")}</button>
                    <div style={{ flex: 1 }} />
                    <button onClick={onClose}>{t(lang, "consume.advanced.dialog.cancel")}</button>
                    <button className="primary" onClick={submit}>{t(lang, "consume.advanced.dialog.ok")}</button>
                </div>
            </div>
        </div>
    );
}
