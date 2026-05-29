import { useState } from "react";
import { Lang, t } from "../lib/i18n";
import { errString } from "../lib/errors";
import { ApplyUpdate } from "../../wailsjs/go/main/App";
import { updater } from "../../wailsjs/go/models";
import { useBackdropClose } from "../lib/useBackdropClose";

interface Props {
    lang: Lang;
    info: updater.UpdateInfo;
    onClose: () => void;
}

export function UpdatePromptDialog({ lang, info, onClose }: Props) {
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const backdrop = useBackdropClose(busy ? undefined : onClose);

    const handleYes = async () => {
        setBusy(true);
        setErr(null);
        try {
            await ApplyUpdate(info);
            // ApplyUpdate triggers wailsruntime.Quit asynchronously; the
            // window will close on its own. Leave the dialog showing the
            // "applying" copy until then.
        } catch (e) {
            setErr(errString(e));
            setBusy(false);
        }
    };

    return (
        <div className="modal-backdrop" {...backdrop}>
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
                <div className="modal-header">
                    {busy ? t(lang, "update.applying.title") : t(lang, "update.prompt.title")}
                </div>
                <div className="modal-body">
                    {busy ? (
                        <div style={{ fontSize: 13 }}>{t(lang, "update.applying.body")}</div>
                    ) : (
                        <div style={{ fontSize: 13 }}>
                            {t(lang, "update.prompt.body", {
                                latest: info.latestVersion,
                                current: info.currentVersion,
                            })}
                        </div>
                    )}
                    {err && (
                        <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 10 }}>
                            {t(lang, "update.failed", { err })}
                        </div>
                    )}
                </div>
                <div className="modal-footer">
                    <button onClick={onClose} disabled={busy}>
                        {t(lang, "update.prompt.no")}
                    </button>
                    <button className="primary" onClick={handleYes} disabled={busy}>
                        {busy ? t(lang, "common.loading") : t(lang, "update.prompt.yes")}
                    </button>
                </div>
            </div>
        </div>
    );
}
