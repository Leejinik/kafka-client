import { Lang, t } from "../lib/i18n";
import { useBackdropClose } from "../lib/useBackdropClose";

interface Props {
    lang: Lang;
    version: string;
    notes: string;
    onClose: () => void;
}

export function ReleaseNotesDialog({ lang, version, notes, onClose }: Props) {
    const backdrop = useBackdropClose(onClose);
    const trimmed = (notes ?? "").trim();
    return (
        <div className="modal-backdrop" {...backdrop}>
            <div
                className="modal"
                onClick={(e) => e.stopPropagation()}
                style={{ width: 640, maxWidth: "94vw", maxHeight: "80vh", display: "flex", flexDirection: "column" }}
            >
                <div className="modal-header">
                    {t(lang, "update.notes.title", { version })}
                </div>
                <div
                    className="modal-body"
                    style={{ overflow: "auto", flex: 1, fontSize: 13, lineHeight: 1.65 }}
                >
                    {trimmed === "" ? (
                        <div className="muted">{t(lang, "update.notes.empty")}</div>
                    ) : (
                        <pre
                            style={{
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                fontFamily:
                                    "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                                margin: 0,
                            }}
                        >
                            {trimmed}
                        </pre>
                    )}
                </div>
                <div className="modal-footer">
                    <button className="primary" onClick={onClose}>
                        {t(lang, "update.notes.close")}
                    </button>
                </div>
            </div>
        </div>
    );
}
