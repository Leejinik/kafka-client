import { useState } from "react";
import { Lang, t } from "../lib/i18n";
import { errString } from "../lib/errors";
import { DeleteGroup } from "../../wailsjs/go/main/App";
import { useBackdropClose } from "../lib/useBackdropClose";

interface Props {
    lang: Lang;
    profileId: string;
    group: string;
    onClose: () => void;
    onDeleted: () => void;
}

export function GroupDeleteDialog({ lang, profileId, group, onClose, onDeleted }: Props) {
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const backdrop = useBackdropClose(busy ? undefined : onClose);

    const handleDelete = async () => {
        setBusy(true);
        setErr(null);
        try {
            await DeleteGroup(profileId, group);
            onDeleted();
        } catch (e) {
            setErr(errString(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="modal-backdrop" {...backdrop}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">{t(lang, "group.delete.title")}</div>
                <div className="modal-body">
                    <div style={{ fontSize: 13, marginBottom: 8 }}>{t(lang, "group.delete.body")}</div>
                    <div className="mono" style={{ fontWeight: 600, marginBottom: 12 }}>{group}</div>
                    <div style={{ color: "var(--danger)", fontSize: 12 }}>
                        {t(lang, "group.delete.warning")}
                    </div>
                    {err && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 8 }}>{err}</div>}
                </div>
                <div className="modal-footer">
                    <button onClick={onClose} disabled={busy}>{t(lang, "profile.cancel")}</button>
                    <button className="danger" onClick={handleDelete} disabled={busy}>
                        {busy ? t(lang, "common.loading") : t(lang, "group.delete.confirm")}
                    </button>
                </div>
            </div>
        </div>
    );
}
