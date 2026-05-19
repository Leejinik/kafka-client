import { useEffect, useRef } from "react";

export interface ContextMenuItem {
    label: string;
    onClick: () => void;
    danger?: boolean;
    disabled?: boolean;
}

interface Props {
    x: number;
    y: number;
    items: ContextMenuItem[];
    onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                onClose();
            }
        };
        const esc = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("mousedown", handler);
        document.addEventListener("keydown", esc);
        return () => {
            document.removeEventListener("mousedown", handler);
            document.removeEventListener("keydown", esc);
        };
    }, [onClose]);

    // Clamp to viewport so the menu never overflows.
    const vw = window.innerWidth, vh = window.innerHeight;
    const width = 180, height = items.length * 30 + 8;
    const left = Math.min(x, vw - width - 6);
    const top = Math.min(y, vh - height - 6);

    return (
        <div ref={ref} className="ctx-menu" style={{ left, top }}>
            {items.map((it, i) => (
                <div
                    key={i}
                    className={"ctx-item" + (it.danger ? " danger" : "") + (it.disabled ? " disabled" : "")}
                    onClick={() => {
                        if (it.disabled) return;
                        it.onClick();
                        onClose();
                    }}
                >
                    {it.label}
                </div>
            ))}
        </div>
    );
}
