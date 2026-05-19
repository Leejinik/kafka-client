import { useEffect, useMemo, useRef, useState } from "react";
import {
    DndContext,
    DragEndEvent,
    KeyboardSensor,
    PointerSensor,
    closestCenter,
    useSensor,
    useSensors,
} from "@dnd-kit/core";
import {
    SortableContext,
    arrayMove,
    horizontalListSortingStrategy,
    sortableKeyboardCoordinates,
    useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { Lang, t } from "../lib/i18n";
import { errString } from "../lib/errors";
import {
    GetClusterInfo,
    GetTopicPartitions,
    ListPartitionReassignments,
    ReassignPartitions,
} from "../../wailsjs/go/main/App";
import { kafka } from "../../wailsjs/go/models";
import { useBackdropClose } from "../lib/useBackdropClose";

interface Props {
    lang: Lang;
    profileId: string;
    topic: string;
    onClose: () => void;
    onSubmitted: () => void;
}

interface Row {
    partition: number;
    original: number[];   // initial replica list (preferred leader = [0])
    current: number[];    // edited replica list
}

export function PartitionReassignDialog({ lang, profileId, topic, onClose, onSubmitted }: Props) {
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [rows, setRows] = useState<Row[]>([]);
    const [brokers, setBrokers] = useState<number[]>([]);
    const [showChangedOnly, setShowChangedOnly] = useState(false);
    const [inflight, setInflight] = useState<Set<number>>(new Set());

    // chip swap popover state
    const [swapAt, setSwapAt] = useState<{ partition: number; slot: number; x: number; y: number } | null>(null);

    const backdrop = useBackdropClose(busy ? undefined : onClose);

    useEffect(() => {
        let alive = true;
        (async () => {
            setLoading(true);
            setErr(null);
            try {
                const [parts, cluster, infl] = await Promise.all([
                    GetTopicPartitions(profileId, topic),
                    GetClusterInfo(profileId),
                    ListPartitionReassignments(profileId, topic).catch(() => [] as kafka.ReassignmentProgress[]),
                ]);
                if (!alive) return;
                const rs: Row[] = parts
                    .slice()
                    .sort((a, b) => a.partition - b.partition)
                    .map((p) => ({
                        partition: p.partition,
                        original: [...p.replicas],
                        current: [...p.replicas],
                    }));
                setRows(rs);
                setBrokers(cluster.brokers.map((b) => b.nodeId).sort((a, b) => a - b));
                setInflight(new Set(infl.map((r) => r.partition)));
            } catch (e) {
                if (alive) setErr(errString(e));
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => { alive = false; };
    }, [profileId, topic]);

    const changedRows = useMemo(
        () => rows.filter((r) => !arraysEqual(r.current, r.original)),
        [rows],
    );

    const visibleRows = showChangedOnly ? changedRows : rows;

    const rfs = useMemo(() => {
        const s = new Set<number>();
        rows.forEach((r) => s.add(r.original.length));
        return Array.from(s).sort((a, b) => a - b).join(", ");
    }, [rows]);

    const reorderReplicas = (partition: number, from: number, to: number) => {
        setRows((rs) =>
            rs.map((r) =>
                r.partition === partition
                    ? { ...r, current: arrayMove(r.current, from, to) }
                    : r,
            ),
        );
    };

    const replaceReplica = (partition: number, slot: number, newBroker: number) => {
        setRows((rs) =>
            rs.map((r) => {
                if (r.partition !== partition) return r;
                const next = [...r.current];
                next[slot] = newBroker;
                return { ...r, current: next };
            }),
        );
    };

    const resetRow = (partition: number) => {
        setRows((rs) =>
            rs.map((r) =>
                r.partition === partition ? { ...r, current: [...r.original] } : r,
            ),
        );
    };

    const resetAll = () => {
        setRows((rs) => rs.map((r) => ({ ...r, current: [...r.original] })));
    };

    const handleExecute = async () => {
        if (changedRows.length === 0) return;
        setBusy(true);
        setErr(null);
        try {
            const payload = changedRows.map((r) => ({
                partition: r.partition,
                replicas: r.current,
            }));
            await ReassignPartitions(profileId, topic, payload as any);
            onSubmitted();
        } catch (e) {
            setErr(errString(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="modal-backdrop" {...backdrop}>
            <div
                className="modal"
                style={{ width: 820, maxWidth: "96vw", maxHeight: "90vh" }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="modal-header">
                    {t(lang, "reassign.title")}
                    <span className="mono muted" style={{ marginLeft: 8 }}>{topic}</span>
                </div>
                <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {loading ? (
                        <div className="muted">{t(lang, "common.loading")}</div>
                    ) : (
                        <>
                            <div className="row" style={{ gap: 14, alignItems: "center", fontSize: 12 }}>
                                <span className="muted">{t(lang, "reassign.brokers")}: <span className="mono">{brokers.join(", ")}</span></span>
                                <span className="muted">{t(lang, "reassign.rf")}: <span className="mono">{rfs}</span></span>
                                <span className="muted">{t(lang, "reassign.partitions")}: <span className="mono">{rows.length}</span></span>
                                {inflight.size > 0 && (
                                    <span style={{ color: "var(--warn)", fontWeight: 600 }}>
                                        ⟳ {t(lang, "reassign.inflight.count", { n: inflight.size })}
                                    </span>
                                )}
                                <div style={{ flex: 1 }} />
                                <label className="checkbox">
                                    <input
                                        type="checkbox"
                                        checked={showChangedOnly}
                                        onChange={(e) => setShowChangedOnly(e.target.checked)}
                                    />
                                    {t(lang, "reassign.showChangedOnly")}
                                </label>
                                <button className="small" onClick={resetAll} disabled={changedRows.length === 0 || busy}>
                                    {t(lang, "reassign.resetAll")}
                                </button>
                            </div>

                            <div style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "auto", maxHeight: "55vh" }}>
                                <table className="inner-table">
                                    <thead>
                                        <tr>
                                            <th style={{ width: 80 }}>{t(lang, "reassign.partition")}</th>
                                            <th style={{ width: 90 }}>{t(lang, "reassign.leader")}</th>
                                            <th>{t(lang, "reassign.replicas")}</th>
                                            <th style={{ width: 70 }}></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {visibleRows.length === 0 ? (
                                            <tr>
                                                <td colSpan={4} className="muted" style={{ textAlign: "center", padding: 18 }}>
                                                    {t(lang, "reassign.empty")}
                                                </td>
                                            </tr>
                                        ) : (
                                            visibleRows.map((r) => {
                                                const changed = !arraysEqual(r.current, r.original);
                                                const leaderChanged = r.current[0] !== r.original[0];
                                                const isInflight = inflight.has(r.partition);
                                                return (
                                                    <tr
                                                        key={r.partition}
                                                        style={changed ? { boxShadow: "inset 3px 0 0 var(--accent)" } : undefined}
                                                    >
                                                        <td className="mono">
                                                            {r.partition}
                                                            {isInflight && (
                                                                <span title={t(lang, "reassign.inflight")} style={{ marginLeft: 4, color: "var(--warn)" }}>⟳</span>
                                                            )}
                                                        </td>
                                                        <td className="mono" style={{ fontWeight: 600 }}>
                                                            B{r.current[0]}
                                                            {leaderChanged && <span style={{ marginLeft: 4, color: "var(--accent)" }}>✱</span>}
                                                        </td>
                                                        <td>
                                                            <ReplicaChips
                                                                row={r}
                                                                onReorder={(from, to) => reorderReplicas(r.partition, from, to)}
                                                                onClickChip={(slot, ev) => {
                                                                    setSwapAt({
                                                                        partition: r.partition,
                                                                        slot,
                                                                        x: ev.clientX,
                                                                        y: ev.clientY,
                                                                    });
                                                                }}
                                                            />
                                                        </td>
                                                        <td>
                                                            {changed && (
                                                                <button
                                                                    className="small"
                                                                    onClick={() => resetRow(r.partition)}
                                                                    title="reset row"
                                                                >
                                                                    ↺
                                                                </button>
                                                            )}
                                                        </td>
                                                    </tr>
                                                );
                                            })
                                        )}
                                    </tbody>
                                </table>
                            </div>

                            <div className="row" style={{ fontSize: 12 }}>
                                <span style={{ fontWeight: 600, color: changedRows.length > 0 ? "var(--accent)" : "var(--text-dim)" }}>
                                    {t(lang, "reassign.changedCount", { n: changedRows.length })}
                                </span>
                            </div>
                        </>
                    )}

                    {err && <div style={{ color: "var(--danger)", fontSize: 12 }}>{err}</div>}
                </div>
                <div className="modal-footer">
                    <button onClick={onClose} disabled={busy}>{t(lang, "profile.cancel")}</button>
                    <button
                        className="primary"
                        onClick={handleExecute}
                        disabled={busy || loading || changedRows.length === 0}
                    >
                        {busy ? t(lang, "reassign.executing") : t(lang, "reassign.execute")}
                    </button>
                </div>
            </div>

            {swapAt && (
                <SwapPopover
                    lang={lang}
                    x={swapAt.x}
                    y={swapAt.y}
                    candidates={brokers.filter(
                        (b) => !rows.find((r) => r.partition === swapAt.partition)!.current.includes(b),
                    )}
                    onPick={(b) => {
                        replaceReplica(swapAt.partition, swapAt.slot, b);
                        setSwapAt(null);
                    }}
                    onClose={() => setSwapAt(null)}
                />
            )}
        </div>
    );
}

function arraysEqual(a: number[], b: number[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/* --- Replica chips ----------------------------------------------------- */

function ReplicaChips({
    row,
    onReorder,
    onClickChip,
}: {
    row: Row;
    onReorder: (from: number, to: number) => void;
    onClickChip: (slot: number, ev: React.MouseEvent) => void;
}) {
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    // Use stable IDs (slot index) because broker numbers can repeat across rows.
    const items = row.current.map((b, i) => ({ id: `${row.partition}-${i}-${b}`, broker: b, slot: i }));

    const handleDragEnd = (e: DragEndEvent) => {
        if (!e.over) return;
        const from = items.findIndex((it) => it.id === e.active.id);
        const to = items.findIndex((it) => it.id === e.over!.id);
        if (from < 0 || to < 0 || from === to) return;
        onReorder(from, to);
    };

    return (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={items.map((it) => it.id)} strategy={horizontalListSortingStrategy}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {items.map((it) => (
                        <Chip
                            key={it.id}
                            id={it.id}
                            broker={it.broker}
                            isLeader={it.slot === 0}
                            originalBroker={row.original[it.slot]}
                            onClick={(ev) => onClickChip(it.slot, ev)}
                        />
                    ))}
                </div>
            </SortableContext>
        </DndContext>
    );
}

function Chip({
    id,
    broker,
    isLeader,
    originalBroker,
    onClick,
}: {
    id: string;
    broker: number;
    isLeader: boolean;
    originalBroker: number | undefined;
    onClick: (ev: React.MouseEvent) => void;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
    const swapped = originalBroker !== undefined && originalBroker !== broker;
    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "3px 9px",
        borderRadius: 999,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        cursor: isDragging ? "grabbing" : "grab",
        userSelect: "none",
        border: isLeader ? "1.5px solid var(--accent)" : "1px solid var(--border)",
        background: swapped ? "#fff7ed" : isLeader ? "#eef4ff" : "var(--panel)",
        fontWeight: isLeader ? 600 : 400,
        color: swapped ? "var(--warn)" : undefined,
        opacity: isDragging ? 0.6 : 1,
    };

    return (
        <span
            ref={setNodeRef}
            style={style}
            {...attributes}
            {...listeners}
            onClick={(e) => {
                // Click without a drag → open swap popover.
                e.stopPropagation();
                onClick(e);
            }}
            title={isLeader ? "preferred leader" : ""}
        >
            {isLeader && <span style={{ fontSize: 9, lineHeight: 1 }}>★</span>}
            B{broker}
        </span>
    );
}

/* --- Swap popover ------------------------------------------------------ */

function SwapPopover({
    lang,
    x,
    y,
    candidates,
    onPick,
    onClose,
}: {
    lang: Lang;
    x: number;
    y: number;
    candidates: number[];
    onPick: (broker: number) => void;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        };
        window.addEventListener("mousedown", handler);
        return () => window.removeEventListener("mousedown", handler);
    }, [onClose]);

    if (candidates.length === 0) {
        return (
            <div
                ref={ref}
                style={popoverStyle(x, y)}
            >
                <div className="muted" style={{ padding: 6, fontSize: 11 }}>{t(lang, "common.none")}</div>
            </div>
        );
    }
    return (
        <div ref={ref} style={popoverStyle(x, y)}>
            <div className="muted" style={{ fontSize: 10, padding: "2px 4px 6px" }}>
                {t(lang, "reassign.swap")}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {candidates.map((b) => (
                    <button
                        key={b}
                        className="small"
                        onClick={() => onPick(b)}
                        style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                    >
                        B{b}
                    </button>
                ))}
            </div>
        </div>
    );
}

function popoverStyle(x: number, y: number): React.CSSProperties {
    return {
        position: "fixed",
        top: Math.min(y + 8, window.innerHeight - 120),
        left: Math.min(x, window.innerWidth - 220),
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "var(--shadow)",
        padding: 8,
        minWidth: 180,
        zIndex: 300,
    };
}
