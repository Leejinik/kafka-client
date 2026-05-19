import { useEffect, useRef, useState } from "react";

export interface ColumnDef {
    key: string;
    label: string;
    defaultWidth: number;  // px (used as min width when grow=true)
    minWidth?: number;
    grow?: boolean;        // if true, this column fills remaining space and has no resize handle
}

const MIN_DEFAULT = 40;

export function useColumnWidths(storageKey: string, columns: ColumnDef[]) {
    const defaults = (): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const c of columns) out[c.key] = c.defaultWidth;
        return out;
    };

    const [widths, setWidths] = useState<Record<string, number>>(() => {
        try {
            const raw = localStorage.getItem(storageKey);
            if (raw) {
                const parsed = JSON.parse(raw) as Record<string, number>;
                const out = defaults();
                for (const c of columns) {
                    if (typeof parsed[c.key] === "number" && parsed[c.key] > 0) {
                        out[c.key] = parsed[c.key];
                    }
                }
                return out;
            }
        } catch { /* fall through */ }
        return defaults();
    });

    useEffect(() => {
        try { localStorage.setItem(storageKey, JSON.stringify(widths)); } catch { /* ignore */ }
    }, [storageKey, widths]);

    const setWidth = (key: string, w: number) => setWidths((cur) => ({ ...cur, [key]: w }));
    const resetWidth = (key: string) => {
        const col = columns.find((c) => c.key === key);
        if (!col) return;
        setWidths((cur) => ({ ...cur, [key]: col.defaultWidth }));
    };

    return { widths, setWidth, resetWidth };
}

interface HeaderProps {
    column: ColumnDef;
    width: number;
    onResize: (w: number) => void;
    onReset: () => void;
    onContextMenu?: (e: React.MouseEvent) => void;
    children?: React.ReactNode;
}

export function ResizableTh({ column, width, onResize, onReset, onContextMenu, children }: HeaderProps) {
    const dragging = useRef<{ startX: number; startW: number } | null>(null);
    const [active, setActive] = useState(false);

    useEffect(() => {
        const move = (e: MouseEvent) => {
            if (!dragging.current) return;
            const min = column.minWidth ?? MIN_DEFAULT;
            const next = Math.max(min, dragging.current.startW + (e.clientX - dragging.current.startX));
            onResize(next);
        };
        const up = () => {
            if (!dragging.current) return;
            dragging.current = null;
            setActive(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        return () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
        };
    }, [column.minWidth, onResize]);

    const onMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragging.current = { startX: e.clientX, startW: width };
        setActive(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    };

    const onDoubleClick = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onReset();
    };

    // For "grow" columns we do not render a resize handle: there is no
    // boundary on their right side, and they auto-fill remaining width.
    const showHandle = !column.grow;

    return (
        <th style={{ position: "relative", overflow: "hidden" }} onContextMenu={onContextMenu}>
            <span style={{ display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "calc(100% - 8px)" }}>
                {children ?? column.label}
            </span>
            {showHandle && (
                <span
                    className={"col-resizer" + (active ? " active" : "")}
                    onMouseDown={onMouseDown}
                    onDoubleClick={onDoubleClick}
                    title="드래그하여 너비 조정 · 더블클릭으로 기본값"
                />
            )}
        </th>
    );
}

// --- General purpose px-width hook + vertical splitter ----------------------

export function useResizableWidth(storageKey: string, defaultPx: number) {
    const [width, setWidthRaw] = useState<number>(() => {
        try {
            const raw = localStorage.getItem(storageKey);
            if (raw) {
                const n = parseInt(raw, 10);
                if (Number.isFinite(n) && n > 0) return n;
            }
        } catch { /* ignore */ }
        return defaultPx;
    });

    useEffect(() => {
        try { localStorage.setItem(storageKey, String(width)); } catch { /* ignore */ }
    }, [storageKey, width]);

    const reset = () => setWidthRaw(defaultPx);
    return { width, setWidth: setWidthRaw, reset } as const;
}

interface SplitterProps {
    value: number;
    onChange: (next: number) => void;
    min?: number;
    max?: number;
    direction?: "ltr" | "rtl"; // ltr = drag right ↑ value (sidebar); rtl = drag right ↓ value (right panel)
    onReset?: () => void;
    className?: string;
}

export function VerticalSplitter({
    value,
    onChange,
    min = 120,
    max,
    direction = "ltr",
    onReset,
    className,
}: SplitterProps) {
    const dragging = useRef<{ startX: number; startVal: number } | null>(null);
    const [active, setActive] = useState(false);

    useEffect(() => {
        const move = (e: MouseEvent) => {
            if (!dragging.current) return;
            let delta = e.clientX - dragging.current.startX;
            if (direction === "rtl") delta = -delta;
            let next = dragging.current.startVal + delta;
            if (next < min) next = min;
            if (max != null && next > max) next = max;
            onChange(next);
        };
        const up = () => {
            if (!dragging.current) return;
            dragging.current = null;
            setActive(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        return () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
        };
    }, [direction, max, min, onChange]);

    const onMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        dragging.current = { startX: e.clientX, startVal: value };
        setActive(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    };

    return (
        <div
            className={"v-splitter" + (active ? " active" : "") + (className ? " " + className : "")}
            onMouseDown={onMouseDown}
            onDoubleClick={(e) => { e.preventDefault(); onReset?.(); }}
            title="드래그하여 크기 조정 · 더블클릭으로 기본값"
        />
    );
}
