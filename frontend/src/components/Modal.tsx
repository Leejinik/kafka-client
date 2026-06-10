import { useEffect, useRef, useState } from "react";

interface Props {
    title?: React.ReactNode;
    children: React.ReactNode;
    footer?: React.ReactNode;
    // undefined disables closing (× becomes disabled, ESC is ignored). Pass
    // `busy ? undefined : onClose` to lock the modal during an in-flight action.
    onClose?: () => void;
    width?: number;
    height?: number | string;
    maxHeight?: string;
    minWidth?: number;
    minHeight?: number;
    closeOnEsc?: boolean;
    headerStyle?: React.CSSProperties;
    bodyStyle?: React.CSSProperties;
}

// Shared modal shell: draggable (from the header), resizable (bottom-right
// grip), and truly modal — the backdrop blocks the main UI and a click on it
// does NOT close the modal (only ×, ESC, or an explicit footer button does).
export function Modal({
    title,
    children,
    footer,
    onClose,
    width = 480,
    height,
    maxHeight = "90vh",
    minWidth = 320,
    minHeight = 140,
    closeOnEsc = true,
    headerStyle,
    bodyStyle,
}: Props) {
    const modalRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ dx: 0, dy: 0 });
    const [size, setSize] = useState<{ w: number; h: number | null }>({
        w: width,
        h: typeof height === "number" ? height : null,
    });

    // ESC to close + lock background scroll while open. The backdrop already
    // swallows pointer events on the main UI; this also stops wheel-scroll
    // behind the modal so nothing moves underneath.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (closeOnEsc && onClose && e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        const prev = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.removeEventListener("keydown", onKey);
            document.body.style.overflow = prev;
        };
    }, [closeOnEsc, onClose]);

    // Drag to move — only from the header. The × button stops propagation on
    // mousedown so clicking it never starts a drag.
    const onDragStart = (e: React.MouseEvent) => {
        if (e.button !== 0) return;
        const base = { ...pos };
        const startX = e.clientX;
        const startY = e.clientY;
        // Capture size once (it doesn't change mid-drag). The modal lives inside
        // the WebView, so it can't leave the window anyway — clamp the offset so
        // the header top never clips off the top and at least KEEP px stays on
        // every edge, otherwise a modal dragged off-screen can't be grabbed back.
        const rect = modalRef.current?.getBoundingClientRect();
        const mw = rect?.width ?? size.w;
        const mh = rect?.height ?? 0;
        const KEEP = 56;
        const move = (ev: MouseEvent) => {
            const centerLeft = (window.innerWidth - mw) / 2;
            const centerTop = (window.innerHeight - mh) / 2;
            const rawDx = base.dx + (ev.clientX - startX);
            const rawDy = base.dy + (ev.clientY - startY);
            const dx = Math.max(KEEP - mw - centerLeft, Math.min(window.innerWidth - KEEP - centerLeft, rawDx));
            const dy = Math.max(-centerTop, Math.min(window.innerHeight - KEEP - centerTop, rawDy));
            setPos({ dx, dy });
        };
        const up = () => {
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    };

    // Resize from the bottom-right grip. Seeds from the live rect so it works
    // even when the initial height is auto (content-sized).
    const onResizeStart = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = modalRef.current?.getBoundingClientRect();
        if (!rect) return;
        const startX = e.clientX;
        const startY = e.clientY;
        const startW = rect.width;
        const startH = rect.height;
        const maxW = window.innerWidth * 0.98;
        const maxH = window.innerHeight * 0.98;
        const move = (ev: MouseEvent) => {
            const w = Math.max(minWidth, Math.min(maxW, startW + (ev.clientX - startX)));
            const h = Math.max(minHeight, Math.min(maxH, startH + (ev.clientY - startY)));
            setSize({ w, h });
        };
        const up = () => {
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    };

    return (
        <div className="modal-backdrop">
            <div
                ref={modalRef}
                className="modal"
                style={{
                    width: size.w,
                    height: size.h ?? height,
                    maxHeight: size.h == null ? maxHeight : undefined,
                    transform: `translate(${pos.dx}px, ${pos.dy}px)`,
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <div
                    className="modal-header modal-drag-handle"
                    style={headerStyle}
                    onMouseDown={onDragStart}
                >
                    <span className="modal-title">{title}</span>
                    <button
                        className="modal-close"
                        onClick={onClose}
                        disabled={!onClose}
                        onMouseDown={(e) => e.stopPropagation()}
                        title="닫기 (ESC)"
                        aria-label="닫기"
                    >
                        ×
                    </button>
                </div>
                <div className="modal-body" style={bodyStyle}>
                    {children}
                </div>
                {footer && <div className="modal-footer">{footer}</div>}
                <div className="modal-resize-handle" onMouseDown={onResizeStart} title="크기 조절" />
            </div>
        </div>
    );
}
