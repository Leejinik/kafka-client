import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Lang, t } from "../lib/i18n";
import { getTopicConfigDoc, TopicConfigDoc } from "../lib/topicConfigDocs";

interface Props {
    lang: Lang;
    configKey: string;
}

// "?" button for a topic config key. Hidden until its table row is hovered
// (see .cfg-help-btn); clicking opens a popover with the official description,
// type, default, valid range and what each selectable value means. Renders
// nothing for keys the reference data doesn't know.
export function TopicConfigHelp({ lang, configKey }: Props) {
    const doc = getTopicConfigDoc(configKey);
    const btnRef = useRef<HTMLButtonElement>(null);
    const [anchor, setAnchor] = useState<DOMRect | null>(null);

    // The key of a newly added row is editable; a popover left open would
    // otherwise keep describing whatever key it was opened for.
    useEffect(() => setAnchor(null), [configKey]);

    if (!doc) return null;
    return (
        <>
            <button
                ref={btnRef}
                type="button"
                className={"cfg-help-btn" + (anchor ? " open" : "")}
                title={t(lang, "cfgdoc.open")}
                aria-label={t(lang, "cfgdoc.open")}
                onClick={() => setAnchor(anchor ? null : btnRef.current!.getBoundingClientRect())}
            >
                ?
            </button>
            {anchor && (
                <HelpPopover
                    lang={lang}
                    configKey={configKey.trim()}
                    doc={doc}
                    anchor={anchor}
                    anchorEl={btnRef.current}
                    onClose={() => setAnchor(null)}
                />
            )}
        </>
    );
}

const POP_WIDTH = 440;
const EDGE = 8; // min distance from the viewport edge
const GAP = 6; // distance from the button

function HelpPopover({
    lang,
    configKey,
    doc,
    anchor,
    anchorEl,
    onClose,
}: {
    lang: Lang;
    configKey: string;
    doc: TopicConfigDoc;
    anchor: DOMRect;
    anchorEl: HTMLElement | null;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ top: number; left: number; maxHeight?: number } | null>(null);

    // Open below the button; flip above when there isn't room. If neither side
    // fits, take the roomier one and let the body scroll, so the popover never
    // covers the row it describes. Measured after render because the height
    // depends on the description length.
    useLayoutEffect(() => {
        const h = ref.current?.offsetHeight ?? 0;
        const w = ref.current?.offsetWidth ?? POP_WIDTH;
        const roomBelow = window.innerHeight - EDGE - (anchor.bottom + GAP);
        const roomAbove = anchor.top - GAP - EDGE;
        const below = h <= roomBelow || roomBelow >= roomAbove;
        const shown = Math.min(h, below ? roomBelow : roomAbove);
        setPos({
            top: below ? anchor.bottom + GAP : anchor.top - GAP - shown,
            left: Math.max(EDGE, Math.min(anchor.left, window.innerWidth - w - EDGE)),
            maxHeight: shown < h ? shown : undefined,
        });
    }, [anchor, lang]);

    useEffect(() => {
        const inside = (target: EventTarget | null) =>
            target instanceof Node && !!ref.current && ref.current.contains(target);
        const onMouseDown = (e: MouseEvent) => {
            // The button toggles the popover itself; closing here too would
            // just reopen it on the click that follows.
            if (inside(e.target) || (anchorEl && e.target instanceof Node && anchorEl.contains(e.target))) return;
            onClose();
        };
        // Capture phase + stopPropagation so ESC closes only the popover, not
        // the modal underneath (Modal listens on document).
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            onClose();
        };
        // The popover is position:fixed, so it would drift away from its row
        // when the config table scrolls.
        const onScroll = (e: Event) => {
            if (!inside(e.target)) onClose();
        };
        window.addEventListener("mousedown", onMouseDown);
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("scroll", onScroll, true);
        window.addEventListener("resize", onClose);
        return () => {
            window.removeEventListener("mousedown", onMouseDown);
            window.removeEventListener("keydown", onKey, true);
            window.removeEventListener("scroll", onScroll, true);
            window.removeEventListener("resize", onClose);
        };
    }, [anchorEl, onClose]);

    // Portalled to <body>: the modal has a CSS transform (drag-to-move), which
    // would make it — not the viewport — the containing block for position:fixed.
    return createPortal(
        <div
            ref={ref}
            className="cfg-help-pop"
            style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, maxHeight: pos?.maxHeight, visibility: pos ? "visible" : "hidden" }}
        >
            <div className="cfg-help-head">
                <span className="mono" style={{ fontWeight: 600, flex: 1, minWidth: 0, wordBreak: "break-all" }}>
                    {configKey}
                </span>
                {doc.deprecated && <span className="cfg-help-badge">{t(lang, "cfgdoc.deprecated")}</span>}
                <button className="modal-close" onClick={onClose} title={t(lang, "dur.close")}>×</button>
            </div>

            <div className="cfg-help-body">
                <p style={{ margin: 0, lineHeight: 1.55 }}>{doc.desc[lang]}</p>

                <table className="cfg-help-facts">
                    <tbody>
                        <tr><th>{t(lang, "cfgdoc.type")}</th><td className="mono">{doc.type}</td></tr>
                        <tr><th>{t(lang, "cfgdoc.default")}</th><td className="mono">{doc.def}</td></tr>
                        <tr><th>{t(lang, "cfgdoc.range")}</th><td className="mono">{doc.range[lang]}</td></tr>
                        <tr>
                            <th>{t(lang, "cfgdoc.serverDefault")}</th>
                            <td className="mono">{doc.serverDefault || <span className="muted">{t(lang, "cfgdoc.serverDefault.none")}</span>}</td>
                        </tr>
                    </tbody>
                </table>

                {doc.values && (
                    <div>
                        <div className="group-section-title">{t(lang, "cfgdoc.values")}</div>
                        <table className="cfg-help-values">
                            <tbody>
                                {doc.values.map((v) => (
                                    <tr key={v.value}>
                                        <th className="mono">{v.value}</th>
                                        <td>{v.meaning[lang]}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {doc.note && (
                    <div className="cfg-help-note">
                        <b>{t(lang, "cfgdoc.note")}</b> — {doc.note[lang]}
                    </div>
                )}

                <div className="muted" style={{ fontSize: 11 }}>{t(lang, "cfgdoc.source")}</div>
            </div>
        </div>,
        document.body,
    );
}
