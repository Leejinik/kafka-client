import { useState } from "react";
import { Lang, t } from "../lib/i18n";
import { errString } from "../lib/errors";
import { DeleteTopic } from "../../wailsjs/go/main/App";
import { useBackdropClose } from "../lib/useBackdropClose";

interface Props {
    lang: Lang;
    profileId: string;
    topic: string;
    onClose: () => void;
    onDeleted: () => void;
}

export function TopicDeleteDialog({ lang, profileId, topic, onClose, onDeleted }: Props) {
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const backdrop = useBackdropClose(busy ? undefined : onClose);

    const handleDelete = async () => {
        setBusy(true);
        setErr(null);
        try {
            await DeleteTopic(profileId, topic);
            onDeleted();
        } catch (e) {
            setErr(errString(e));
            setBusy(false);
        }
    };

    return (
        <div className="modal-backdrop" {...backdrop}>
            <div className="modal" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
                <div className="modal-header" style={{ color: "var(--danger)" }}>
                    {t(lang, "topic.delete.title")}
                </div>
                <div className="modal-body">
                    <div style={{ fontSize: 13 }}>
                        {t(lang, "topic.delete.body1")}
                    </div>
                    <div className="mono" style={{ background: "var(--panel-2)", padding: 10, borderRadius: 6, margin: "10px 0", wordBreak: "break-all" }}>
                        {topic}
                    </div>
                    <div style={{ color: "var(--danger)", fontWeight: 600, fontSize: 13 }}>
                        {t(lang, "topic.delete.warning")}
                    </div>
                    {err && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 8 }}>{err}</div>}
                </div>
                <div className="modal-footer">
                    <button onClick={onClose} disabled={busy}>{t(lang, "profile.cancel")}</button>
                    <button className="danger" onClick={handleDelete} disabled={busy}>
                        {busy ? t(lang, "common.loading") : t(lang, "topic.delete.confirm")}
                    </button>
                </div>
            </div>
        </div>
    );
}
