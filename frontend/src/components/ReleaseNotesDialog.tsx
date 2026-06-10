import { Lang, t } from "../lib/i18n";
import { Modal } from "./Modal";

interface Props {
    lang: Lang;
    version: string;
    notes: string;
    onClose: () => void;
}

export function ReleaseNotesDialog({ lang, version, notes, onClose }: Props) {
    const trimmed = (notes ?? "").trim();
    return (
        <Modal
            title={t(lang, "update.notes.title", { version })}
            width={640}
            maxHeight="80vh"
            onClose={onClose}
            bodyStyle={{ overflow: "auto", flex: 1, fontSize: 13, lineHeight: 1.65 }}
            footer={
                <button className="primary" onClick={onClose}>
                    {t(lang, "update.notes.close")}
                </button>
            }
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
        </Modal>
    );
}
