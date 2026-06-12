import { useState, type ReactNode } from "react";
import { Lang, t } from "../lib/i18n";
import { formatLocalHuman, parseHuman } from "../lib/formatTime";

interface Props {
    lang: Lang;
    // Override the wrapper appearance. Default style matches the Consume
    // detail-panel bottom strip (subtle panel-2 background, top border).
    style?: React.CSSProperties;
    // Extra control rendered in the header row, to the left of the [지금]
    // button. Used by the standalone calculator mode to host the
    // "switch back to Kafka Client" button.
    headerButton?: ReactNode;
    // Extra content rendered below the input rows. Used by calculator mode
    // for the "always on top" checkbox.
    footer?: ReactNode;
}

export function TimestampConverter({ lang, style, headerButton, footer }: Props) {
    const [unix, setUnix] = useState("");
    const [human, setHuman] = useState("");
    const [unixErr, setUnixErr] = useState(false);
    const [humanErr, setHumanErr] = useState(false);

    const onUnixChange = (v: string) => {
        setUnix(v);
        if (!v.trim()) {
            setHuman("");
            setUnixErr(false);
            return;
        }
        const n = Number(v.trim());
        if (Number.isFinite(n) && n >= 0) {
            setHuman(formatLocalHuman(n));
            setUnixErr(false);
        } else {
            setUnixErr(true);
        }
    };

    const onHumanChange = (v: string) => {
        setHuman(v);
        if (!v.trim()) {
            setUnix("");
            setHumanErr(false);
            return;
        }
        const ms = parseHuman(v);
        if (ms !== null) {
            setUnix(String(ms));
            setHumanErr(false);
        } else {
            setHumanErr(true);
        }
    };

    const swapNow = () => {
        const now = Date.now();
        setUnix(String(now));
        setHuman(formatLocalHuman(now));
        setUnixErr(false);
        setHumanErr(false);
    };

    const fieldStyle = (err: boolean): React.CSSProperties => ({
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        width: "100%",
        borderColor: err ? "var(--danger)" : undefined,
    });

    const defaultStyle: React.CSSProperties = {
        borderTop: "1px solid var(--border)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        background: "var(--panel-2)",
        flex: "0 0 auto",
    };

    return (
        <div style={{ ...defaultStyle, ...style }}>
            <div className="row" style={{ alignItems: "center" }}>
                <div className="group-section-title" style={{ flex: 1 }}>
                    {t(lang, "consume.converter.title")}
                </div>
                {headerButton}
                <button className="small" onClick={swapNow} title={t(lang, "consume.converter.now")}>
                    {t(lang, "consume.converter.now")}
                </button>
            </div>
            <div className="form-row" style={{ margin: 0 }}>
                <label style={{ fontSize: 11, color: "var(--text-dim)" }}>{t(lang, "consume.converter.unix")}</label>
                <input
                    value={unix}
                    onChange={(e) => onUnixChange(e.target.value)}
                    placeholder="1747641600000"
                    style={fieldStyle(unixErr)}
                />
            </div>
            <div className="form-row" style={{ margin: 0 }}>
                <label style={{ fontSize: 11, color: "var(--text-dim)" }}>{t(lang, "consume.converter.human")}</label>
                <input
                    value={human}
                    onChange={(e) => onHumanChange(e.target.value)}
                    placeholder="2026-05-19 09:00:00.000"
                    style={fieldStyle(humanErr)}
                />
            </div>
            {footer}
        </div>
    );
}
