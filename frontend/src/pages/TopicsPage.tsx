import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lang, t } from "../lib/i18n";
import { errString } from "../lib/errors";
import {
    GetTopicPartitions,
    ListGroupsForTopic,
    ListPartitionReassignments,
    ListTopics,
    MessageRates,
} from "../../wailsjs/go/main/App";
import { kafka } from "../../wailsjs/go/models";
import { ContextMenu, ContextMenuItem } from "../components/ContextMenu";
import { TopicCreateDialog } from "../components/TopicCreateDialog";
import { TopicEditDialog } from "../components/TopicEditDialog";
import { TopicDeleteDialog } from "../components/TopicDeleteDialog";
import { PartitionReassignDialog } from "../components/PartitionReassignDialog";
import { GroupDeleteDialog } from "../components/GroupDeleteDialog";
import { GroupResetOffsetsDialog } from "../components/GroupResetOffsetsDialog";

interface Props {
    lang: Lang;
    profileId: string;
    onTick?: () => void; // fired every 10s; parent can refresh cluster-level data
}

// Two-tier polling for the Topics tab.
//
// FAST tick refreshes data the user expects to feel "live": per-partition
// leader/ISR state, in-flight reassignment progress, msg/sec throughput.
// These are cheap broker calls (metadata + per-topic ListOffsets).
//
// SLOW tick refreshes data that is expensive to fetch but changes less
// frequently: the topic list itself, and consumer-group lag. Consumer-group
// lag in particular calls `kadm.Lag(all)` which fetches every group's offsets
// from the coordinator; running that every second on a large cluster would be
// abusive.
const FAST_REFRESH_MS = 1000;
const SLOW_REFRESH_MS = 10000;

type GroupsState =
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; data: kafka.GroupView[] }
    | { kind: "err"; message: string };

type PartitionsState =
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; data: kafka.PartitionDetail[] }
    | { kind: "err"; message: string };

// Per-partition rate of change between consecutive SLOW ticks (10s apart).
// null means no prior sample yet (first observation after expand/refresh).
type GroupRate = {
    endRate: number | null;
    committedRate: number | null;
    lagRate: number | null;
};
type GroupSnapshot = Record<string, Record<number, { end: number; committed: number; lag: number }>>;
type GroupRatesByTopic = Record<string, Record<string, Record<number, GroupRate>>>;

function snapshotFromGroups(data: kafka.GroupView[]): GroupSnapshot {
    const out: GroupSnapshot = {};
    for (const g of data) {
        const m: Record<number, { end: number; committed: number; lag: number }> = {};
        for (const p of g.partitions) {
            m[p.partition] = { end: p.endOffset, committed: p.committedOffset, lag: p.lag };
        }
        out[g.groupId] = m;
    }
    return out;
}

function ratesFromDelta(
    prev: GroupSnapshot | undefined,
    curr: GroupSnapshot,
    intervalSec: number,
): Record<string, Record<number, GroupRate>> {
    const out: Record<string, Record<number, GroupRate>> = {};
    const valid = (v: number) => v >= 0;
    for (const gid of Object.keys(curr)) {
        const inner: Record<number, GroupRate> = {};
        for (const partStr of Object.keys(curr[gid])) {
            const part = +partStr;
            const c = curr[gid][part];
            const p = prev?.[gid]?.[part];
            if (!p) {
                inner[part] = { endRate: null, committedRate: null, lagRate: null };
                continue;
            }
            inner[part] = {
                endRate: valid(c.end) && valid(p.end) ? (c.end - p.end) / intervalSec : null,
                committedRate: valid(c.committed) && valid(p.committed) ? (c.committed - p.committed) / intervalSec : null,
                lagRate: valid(c.lag) && valid(p.lag) ? (c.lag - p.lag) / intervalSec : null,
            };
        }
        out[gid] = inner;
    }
    return out;
}

function formatPerSec(r: number | null | undefined, suffix = "/sec"): string | undefined {
    if (r === null || r === undefined || Number.isNaN(r)) return undefined;
    if (r === 0) return `0${suffix}`;
    const sign = r > 0 ? "+" : "-";
    const abs = Math.abs(r);
    const num = abs >= 10 ? Math.round(abs).toString() : (Math.round(abs * 10) / 10).toString();
    return `${sign}${num}${suffix}`;
}

type Dialog =
    | { kind: "none" }
    | { kind: "create" }
    | { kind: "edit"; topic: string }
    | { kind: "delete"; topic: string }
    | { kind: "reassign"; topic: string }
    | { kind: "groupDelete"; group: string }
    | { kind: "groupReset"; group: kafka.GroupView; topic: string };

export function TopicsPage({ lang, profileId, onTick }: Props) {
    const [topics, setTopics] = useState<kafka.TopicSummary[]>([]);
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [groupCache, setGroupCache] = useState<Record<string, GroupsState>>({});
    const [partCache, setPartCache] = useState<Record<string, PartitionsState>>({});
    const [ctxMenu, setCtxMenu] = useState<{
        x: number;
        y: number;
        topic?: string;
        mode?: "partitions" | "group";
        group?: kafka.GroupView;
    } | null>(null);
    const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
    const [rates, setRates] = useState<Record<string, number>>({});
    // Per-topic count of partitions currently being reassigned; refreshed on tick.
    const [reassignCounts, setReassignCounts] = useState<Record<string, number>>({});
    // Per-group/partition delta-per-second between SLOW ticks. Shown in hover
    // tooltips on the Committed / End Offset / Lag cells.
    const [groupRates, setGroupRates] = useState<GroupRatesByTopic>({});
    const prevGroupsRef = useRef<Record<string, GroupSnapshot>>({});

    const refresh = async () => {
        setLoading(true);
        setError(null);
        try {
            setTopics(await ListTopics(profileId));
            setGroupCache({});
            setPartCache({});
            setExpanded(new Set());
            prevGroupsRef.current = {};
            setGroupRates({});
        } catch (e) {
            setError(errString(e));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { void refresh(); }, [profileId]);

    // Loud variants show "loading" state — used on first expansion / explicit retry.
    const loadGroups = useCallback(async (topic: string) => {
        setGroupCache((c) => ({ ...c, [topic]: { kind: "loading" } }));
        // Drop any prior snapshot so the first sample after reload is treated
        // as a baseline (no rate shown until the next SLOW tick produces a delta).
        delete prevGroupsRef.current[topic];
        setGroupRates((c) => {
            if (!(topic in c)) return c;
            const next = { ...c };
            delete next[topic];
            return next;
        });
        try {
            const data = await ListGroupsForTopic(profileId, topic);
            setGroupCache((c) => ({ ...c, [topic]: { kind: "ok", data } }));
            const curr = snapshotFromGroups(data);
            const rates = ratesFromDelta(prevGroupsRef.current[topic], curr, SLOW_REFRESH_MS / 1000);
            prevGroupsRef.current[topic] = curr;
            setGroupRates((c) => ({ ...c, [topic]: rates }));
        } catch (e) {
            setGroupCache((c) => ({ ...c, [topic]: { kind: "err", message: errString(e) } }));
        }
    }, [profileId]);

    const loadPartitions = useCallback(async (topic: string) => {
        setPartCache((c) => ({ ...c, [topic]: { kind: "loading" } }));
        try {
            const data = await GetTopicPartitions(profileId, topic);
            setPartCache((c) => ({ ...c, [topic]: { kind: "ok", data } }));
        } catch (e) {
            setPartCache((c) => ({ ...c, [topic]: { kind: "err", message: errString(e) } }));
        }
    }, [profileId]);

    // --- Two-tier tick ------------------------------------------------------
    // Refs (not deps) so the intervals don't tear down when topics/expanded
    // change. Intervals live for the lifetime of the mounted TopicsPage; the
    // cleanup below cancels them on tab switch.
    const topicsRef = useRef(topics);
    const expandedRef = useRef(expanded);
    const onTickRef = useRef(onTick);
    useEffect(() => { topicsRef.current = topics; }, [topics]);
    useEffect(() => { expandedRef.current = expanded; }, [expanded]);
    useEffect(() => { onTickRef.current = onTick; }, [onTick]);

    useEffect(() => {
        let cancelled = false;
        let fastRunning = false;
        let slowRunning = false;

        // FAST: per-partition state, reassignment progress, msg/sec, cluster info.
        const fastTick = async () => {
            if (fastRunning) return; // drop if previous tick still in flight
            fastRunning = true;
            try {
                // msg/sec across all current topics.
                const names = topicsRef.current.map((t) => t.name);
                if (names.length > 0) {
                    try {
                        const out = await MessageRates(profileId, names, 60000);
                        if (cancelled) return;
                        const next: Record<string, number> = {};
                        for (const r of out) next[r.topic] = r.msgsPerSec;
                        setRates(next);
                    } catch { /* keep last */ }
                }
                // expanded topics: partitions + reassignment progress.
                for (const topic of expandedRef.current) {
                    try {
                        const data = await GetTopicPartitions(profileId, topic);
                        if (cancelled) return;
                        setPartCache((c) => ({ ...c, [topic]: { kind: "ok", data } }));
                    } catch { /* keep last */ }
                    try {
                        const r = await ListPartitionReassignments(profileId, topic);
                        if (cancelled) return;
                        setReassignCounts((c) => {
                            const next = { ...c };
                            if (r && r.length > 0) next[topic] = r.length;
                            else delete next[topic];
                            return next;
                        });
                    } catch { /* keep last */ }
                }
                // cluster-level info (controller, brokers).
                onTickRef.current?.();
            } finally {
                fastRunning = false;
            }
        };

        // SLOW: full topic list + per-group lag (expensive Lag(all)).
        const slowTick = async () => {
            if (slowRunning) return;
            slowRunning = true;
            try {
                try {
                    const list = await ListTopics(profileId);
                    if (cancelled) return;
                    setTopics(list);
                } catch { /* keep last */ }
                for (const topic of expandedRef.current) {
                    try {
                        const data = await ListGroupsForTopic(profileId, topic);
                        if (cancelled) return;
                        setGroupCache((c) => ({ ...c, [topic]: { kind: "ok", data } }));
                        const curr = snapshotFromGroups(data);
                        const rates = ratesFromDelta(prevGroupsRef.current[topic], curr, SLOW_REFRESH_MS / 1000);
                        prevGroupsRef.current[topic] = curr;
                        setGroupRates((c) => ({ ...c, [topic]: rates }));
                    } catch { /* keep last */ }
                }
            } finally {
                slowRunning = false;
            }
        };

        const fastId = window.setInterval(fastTick, FAST_REFRESH_MS);
        const slowId = window.setInterval(slowTick, SLOW_REFRESH_MS);
        return () => {
            cancelled = true;
            window.clearInterval(fastId);
            window.clearInterval(slowId);
        };
    }, [profileId]);

    const toggleExpand = (topic: string) => {
        const next = new Set(expanded);
        if (next.has(topic)) {
            next.delete(topic);
        } else {
            next.add(topic);
            const gc = groupCache[topic];
            if (!gc || gc.kind === "err") void loadGroups(topic);
            const pc = partCache[topic];
            if (!pc || pc.kind === "err") void loadPartitions(topic);
        }
        setExpanded(next);
    };

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return topics;
        return topics.filter((it) => it.name.toLowerCase().includes(q));
    }, [topics, search]);

    const handleContextMenu = (e: React.MouseEvent, topic?: string, mode?: "partitions") => {
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY, topic, mode });
    };

    const handleGroupContextMenu = (e: React.MouseEvent, group: kafka.GroupView, topic: string) => {
        e.preventDefault();
        e.stopPropagation();
        setCtxMenu({ x: e.clientX, y: e.clientY, topic, mode: "group", group });
    };

    const buildCtxItems = (): ContextMenuItem[] => {
        if (!ctxMenu) return [];
        if (ctxMenu.mode === "group" && ctxMenu.group && ctxMenu.topic) {
            const g = ctxMenu.group;
            const topic = ctxMenu.topic;
            const isActive =
                g.state === "Stable" ||
                g.state === "PreparingRebalance" ||
                g.state === "CompletingRebalance";
            return [
                {
                    label: t(lang, "group.menu.resetOffsets"),
                    onClick: () => setDialog({ kind: "groupReset", group: g, topic }),
                    disabled: isActive,
                },
                {
                    label: t(lang, "group.menu.delete"),
                    danger: true,
                    onClick: () => setDialog({ kind: "groupDelete", group: g.groupId }),
                    disabled: isActive,
                },
            ];
        }
        if (ctxMenu.mode === "partitions" && ctxMenu.topic) {
            return [
                { label: t(lang, "topic.menu.reassign"), onClick: () => setDialog({ kind: "reassign", topic: ctxMenu.topic! }) },
            ];
        }
        if (ctxMenu.topic) {
            return [
                { label: t(lang, "topic.menu.edit"), onClick: () => setDialog({ kind: "edit", topic: ctxMenu.topic! }) },
                { label: t(lang, "topic.menu.reassign"), onClick: () => setDialog({ kind: "reassign", topic: ctxMenu.topic! }) },
                { label: t(lang, "topic.menu.delete"), danger: true, onClick: () => setDialog({ kind: "delete", topic: ctxMenu.topic! }) },
            ];
        }
        return [
            { label: t(lang, "topic.menu.create"), onClick: () => setDialog({ kind: "create" }) },
        ];
    };
    const ctxItems: ContextMenuItem[] = buildCtxItems();

    return (
        <div className="page" onContextMenu={(e) => handleContextMenu(e)}>
            <div className="page-toolbar">
                <input
                    className="grow"
                    placeholder={t(lang, "topics.search")}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
                <button onClick={refresh} disabled={loading}>
                    {loading ? t(lang, "common.loading") : t(lang, "common.refresh")}
                </button>
                <button className="primary" onClick={() => setDialog({ kind: "create" })}>
                    + {t(lang, "topic.menu.create")}
                </button>
                <span className="count-pill">{filtered.length}</span>
            </div>
            {error && <div style={{ color: "var(--danger)" }}>{error}</div>}
            <div className="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th style={{ width: 28 }}></th>
                            <th>{t(lang, "topics.name")}</th>
                            <th style={{ width: 100 }}>{t(lang, "topics.partitions")}</th>
                            <th style={{ width: 100 }}>{t(lang, "topics.replication")}</th>
                            <th style={{ width: 80 }}>{t(lang, "topics.internal")}</th>
                            <th style={{ width: 110 }}>{t(lang, "topics.groups")}</th>
                            <th style={{ width: 100 }} title={t(lang, "topics.msgsPerSec.tip")}>
                                {t(lang, "topics.msgsPerSec")}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.map((it) => {
                            const isOpen = expanded.has(it.name);
                            return (
                                <RowGroup
                                    key={it.name}
                                    lang={lang}
                                    topic={it}
                                    open={isOpen}
                                    groupsState={groupCache[it.name]}
                                    partitionsState={partCache[it.name]}
                                    rate={rates[it.name]}
                                    groupRates={groupRates[it.name]}
                                    reassignCount={reassignCounts[it.name] ?? 0}
                                    onToggle={() => toggleExpand(it.name)}
                                    onReloadGroups={() => loadGroups(it.name)}
                                    onReloadPartitions={() => loadPartitions(it.name)}
                                    onContextMenu={(e) => { e.stopPropagation(); handleContextMenu(e, it.name); }}
                                    onPartitionsContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleContextMenu(e, it.name, "partitions"); }}
                                    onGroupContextMenu={(e, g) => handleGroupContextMenu(e, g, it.name)}
                                />
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {ctxMenu && (
                <ContextMenu
                    x={ctxMenu.x}
                    y={ctxMenu.y}
                    items={ctxItems}
                    onClose={() => setCtxMenu(null)}
                />
            )}

            {dialog.kind === "create" && (
                <TopicCreateDialog
                    lang={lang}
                    profileId={profileId}
                    onClose={() => setDialog({ kind: "none" })}
                    onCreated={() => { setDialog({ kind: "none" }); void refresh(); }}
                />
            )}
            {dialog.kind === "edit" && (
                <TopicEditDialog
                    lang={lang}
                    profileId={profileId}
                    topic={dialog.topic}
                    onClose={() => setDialog({ kind: "none" })}
                    onSaved={() => { setDialog({ kind: "none" }); void refresh(); }}
                />
            )}
            {dialog.kind === "delete" && (
                <TopicDeleteDialog
                    lang={lang}
                    profileId={profileId}
                    topic={dialog.topic}
                    onClose={() => setDialog({ kind: "none" })}
                    onDeleted={() => { setDialog({ kind: "none" }); void refresh(); }}
                />
            )}
            {dialog.kind === "reassign" && (
                <PartitionReassignDialog
                    lang={lang}
                    profileId={profileId}
                    topic={dialog.topic}
                    onClose={() => setDialog({ kind: "none" })}
                    onSubmitted={() => { setDialog({ kind: "none" }); }}
                />
            )}
            {dialog.kind === "groupDelete" && (
                <GroupDeleteDialog
                    lang={lang}
                    profileId={profileId}
                    group={dialog.group}
                    onClose={() => setDialog({ kind: "none" })}
                    onDeleted={() => { setDialog({ kind: "none" }); }}
                />
            )}
            {dialog.kind === "groupReset" && (
                <GroupResetOffsetsDialog
                    lang={lang}
                    profileId={profileId}
                    group={dialog.group}
                    topic={dialog.topic}
                    onClose={() => setDialog({ kind: "none" })}
                    onSubmitted={() => { setDialog({ kind: "none" }); }}
                />
            )}
        </div>
    );
}

function RowGroup({
    lang,
    topic,
    open,
    groupsState,
    partitionsState,
    rate,
    groupRates,
    reassignCount,
    onToggle,
    onReloadGroups,
    onReloadPartitions,
    onContextMenu,
    onPartitionsContextMenu,
    onGroupContextMenu,
}: {
    lang: Lang;
    topic: kafka.TopicSummary;
    open: boolean;
    groupsState: GroupsState | undefined;
    partitionsState: PartitionsState | undefined;
    rate: number | undefined;
    groupRates: Record<string, Record<number, GroupRate>> | undefined;
    reassignCount: number;
    onToggle: () => void;
    onReloadGroups: () => void;
    onReloadPartitions: () => void;
    onContextMenu: (e: React.MouseEvent) => void;
    onPartitionsContextMenu: (e: React.MouseEvent) => void;
    onGroupContextMenu: (e: React.MouseEvent, group: kafka.GroupView) => void;
}) {
    const groupCount =
        groupsState?.kind === "ok" ? groupsState.data.length :
            groupsState?.kind === "loading" ? "…" :
                groupsState?.kind === "err" ? "!" :
                    "";
    return (
        <>
            <tr onClick={onToggle} onContextMenu={onContextMenu}>
                <td style={{ textAlign: "center", color: "var(--text-dim)" }}>{open ? "▾" : "▸"}</td>
                <td className="mono">
                    {topic.name}
                    {reassignCount > 0 && (
                        <span
                            title={t(lang, "reassign.inflight")}
                            style={{
                                marginLeft: 8,
                                padding: "1px 7px",
                                borderRadius: 999,
                                fontSize: 10,
                                color: "var(--warn)",
                                border: "1px solid var(--warn)",
                                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                            }}
                        >
                            ⟳ {reassignCount}
                        </span>
                    )}
                </td>
                <td>{topic.partitions}</td>
                <td>{topic.replicationFactor}</td>
                <td>{topic.internal ? "✓" : ""}</td>
                <td>{groupCount}</td>
                <td className="mono" style={{ textAlign: "right" }}>{formatRate(rate)}</td>
            </tr>
            {open && (
                <tr className="expand-row">
                    <td></td>
                    <td colSpan={6} style={{ background: "var(--panel-2)", padding: 12 }}>
                        <ExpandedTopic
                            lang={lang}
                            groupsState={groupsState}
                            partitionsState={partitionsState}
                            groupRates={groupRates}
                            onReloadGroups={onReloadGroups}
                            onReloadPartitions={onReloadPartitions}
                            onPartitionsContextMenu={onPartitionsContextMenu}
                            onGroupContextMenu={onGroupContextMenu}
                        />
                    </td>
                </tr>
            )}
        </>
    );
}

function formatRate(r: number | undefined): string {
    if (r === undefined || Number.isNaN(r)) return "—";
    if (r === 0) return "0";
    if (r < 1) return r.toFixed(2);
    if (r < 100) return r.toFixed(1);
    return Math.round(r).toLocaleString();
}

function ExpandedTopic({
    lang,
    groupsState,
    partitionsState,
    groupRates,
    onReloadGroups,
    onReloadPartitions,
    onPartitionsContextMenu,
    onGroupContextMenu,
}: {
    lang: Lang;
    groupsState: GroupsState | undefined;
    partitionsState: PartitionsState | undefined;
    groupRates: Record<string, Record<number, GroupRate>> | undefined;
    onReloadGroups: () => void;
    onReloadPartitions: () => void;
    onPartitionsContextMenu: (e: React.MouseEvent) => void;
    onGroupContextMenu: (e: React.MouseEvent, group: kafka.GroupView) => void;
}) {
    return (
        <div className="col" style={{ gap: 16 }}>
            <PartitionsCard
                lang={lang}
                state={partitionsState}
                onReload={onReloadPartitions}
                onContextMenu={onPartitionsContextMenu}
            />
            <GroupsCard
                lang={lang}
                state={groupsState}
                groupRates={groupRates}
                onReload={onReloadGroups}
                onGroupContextMenu={onGroupContextMenu}
            />
        </div>
    );
}

function PartitionsCard({
    lang,
    state,
    onReload,
    onContextMenu,
}: {
    lang: Lang;
    state: PartitionsState | undefined;
    onReload: () => void;
    onContextMenu: (e: React.MouseEvent) => void;
}) {
    return (
        <div className="group-card" onContextMenu={onContextMenu}>
            <div className="group-section-title">{t(lang, "topics.partitionsSection")}</div>
            {(!state || state.kind === "idle" || state.kind === "loading") ? (
                <div className="muted">{t(lang, "common.loading")}</div>
            ) : state.kind === "err" ? (
                <div>
                    <div style={{ color: "var(--danger)" }}>{state.message}</div>
                    <button className="small" style={{ marginTop: 6 }} onClick={onReload}>
                        {t(lang, "common.refresh")}
                    </button>
                </div>
            ) : (
                <table className="inner-table">
                    <thead>
                        <tr>
                            <th style={{ width: 60 }}>{t(lang, "topics.partition")}</th>
                            <th style={{ width: 80 }}>{t(lang, "topics.leader")}</th>
                            <th>{t(lang, "topics.replicas")}</th>
                            <th>{t(lang, "topics.isr")}</th>
                            <th>{t(lang, "topics.offline")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {state.data.map((p: kafka.PartitionDetail) => {
                            const isrSet = new Set(p.isr);
                            const offSet = new Set(p.offlineReplicas || []);
                            const isHealthy = p.replicas.every((r) => isrSet.has(r)) && (p.offlineReplicas?.length ?? 0) === 0;
                            return (
                                <tr key={p.partition}>
                                    <td className="mono">{p.partition}</td>
                                    <td className="mono" style={{ fontWeight: 600 }}>
                                        {p.leader < 0 ? <span style={{ color: "var(--danger)" }}>none</span> : `B${p.leader}`}
                                    </td>
                                    <td className="mono">
                                        {p.replicas.map((r, i) => (
                                            <span key={r}>
                                                {i > 0 && ", "}
                                                <span style={{
                                                    color: !isrSet.has(r) ? "var(--danger)" : offSet.has(r) ? "var(--warn)" : undefined,
                                                    fontWeight: r === p.leader ? 600 : undefined,
                                                    textDecoration: r === p.leader ? "underline" : undefined,
                                                }}>
                                                    B{r}
                                                </span>
                                            </span>
                                        ))}
                                    </td>
                                    <td className="mono" style={{ color: isHealthy ? "var(--ok)" : "var(--warn)" }}>
                                        {p.isr.map((r) => `B${r}`).join(", ")}
                                    </td>
                                    <td className="mono" style={{ color: "var(--danger)" }}>
                                        {p.offlineReplicas && p.offlineReplicas.length > 0
                                            ? p.offlineReplicas.map((r) => `B${r}`).join(", ")
                                            : "—"}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </div>
    );
}

function GroupsCard({
    lang,
    state,
    groupRates,
    onReload,
    onGroupContextMenu,
}: {
    lang: Lang;
    state: GroupsState | undefined;
    groupRates: Record<string, Record<number, GroupRate>> | undefined;
    onReload: () => void;
    onGroupContextMenu: (e: React.MouseEvent, group: kafka.GroupView) => void;
}) {
    return (
        <div>
            <div className="group-section-title" style={{ marginBottom: 8 }}>
                Consumer Groups
            </div>
            {(!state || state.kind === "idle" || state.kind === "loading") ? (
                <div className="muted">{t(lang, "common.loading")}</div>
            ) : state.kind === "err" ? (
                <div>
                    <div style={{ color: "var(--danger)" }}>{state.message}</div>
                    <button className="small" style={{ marginTop: 6 }} onClick={onReload}>
                        {t(lang, "common.refresh")}
                    </button>
                </div>
            ) : state.data.length === 0 ? (
                <div className="muted">{t(lang, "topics.noGroups")}</div>
            ) : (
                <div className="col" style={{ gap: 12 }}>
                    {state.data.map((g: kafka.GroupView) => (
                        <GroupCard
                            key={g.groupId}
                            lang={lang}
                            group={g}
                            rates={groupRates?.[g.groupId]}
                            onContextMenu={(e) => onGroupContextMenu(e, g)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function GroupCard({
    lang,
    group,
    rates,
    onContextMenu,
}: {
    lang: Lang;
    group: kafka.GroupView;
    rates: Record<number, GroupRate> | undefined;
    onContextMenu: (e: React.MouseEvent) => void;
}) {
    const stateColor =
        group.state === "Stable" ? "var(--ok)" :
            group.state === "Empty" ? "var(--warn)" :
                group.state === "Dead" ? "var(--danger)" : "var(--text-dim)";
    return (
        <div className="group-card" onContextMenu={onContextMenu}>
            <div className="group-card-head">
                <span className="group-name mono">{group.groupId}</span>
                <span style={{ color: stateColor, fontWeight: 600 }}>{group.state}</span>
                <span className="muted">{group.protocol || group.protocolType}</span>
                <span className="muted">coord=B{group.coordinator}</span>
                <div style={{ flex: 1 }} />
                <span className="count-pill">{t(lang, "topics.totalLag")}: {group.totalLag.toLocaleString()}</span>
            </div>

            {group.members && group.members.length > 0 && (
                <div className="group-card-section">
                    <div className="group-section-title">{t(lang, "topics.members")}</div>
                    <table className="inner-table">
                        <thead>
                            <tr>
                                <th>Member ID</th>
                                <th>Client</th>
                                <th>Host</th>
                                <th>Partitions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {group.members.map((m) => (
                                <tr key={m.memberId}>
                                    <td className="mono">{m.memberId}</td>
                                    <td className="mono">{m.clientId || "—"}</td>
                                    <td className="mono">{m.clientHost || "—"}</td>
                                    <td className="mono">
                                        {m.partitions.length === 0
                                            ? <span className="muted">{t(lang, "topics.member.standby")}</span>
                                            : m.partitions.join(", ")}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <div className="group-card-section">
                <div className="group-section-title">{t(lang, "topics.partitionLag")}</div>
                <table className="inner-table">
                    <thead>
                        <tr>
                            <th style={{ width: 60 }}>P</th>
                            <th>{t(lang, "topics.committed")}</th>
                            <th>{t(lang, "topics.endOffset")}</th>
                            <th>{t(lang, "topics.lag")}</th>
                            <th>{t(lang, "topics.consumer")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {group.partitions.map((p) => {
                            const lagColor = p.lag < 0 ? "var(--danger)" : p.lag > 1000 ? "var(--warn)" : undefined;
                            const r = rates?.[p.partition];
                            return (
                                <tr key={p.partition}>
                                    <td>{p.partition}</td>
                                    <td className="mono" title={formatPerSec(r?.committedRate)}>{p.committedOffset < 0 ? "—" : p.committedOffset.toLocaleString()}</td>
                                    <td className="mono" title={formatPerSec(r?.endRate, " publish/sec")}>{p.endOffset < 0 ? "—" : p.endOffset.toLocaleString()}</td>
                                    <td className="mono" style={{ color: lagColor, fontWeight: lagColor ? 600 : undefined }} title={formatPerSec(r?.lagRate)}>
                                        {p.lag < 0 ? p.err || "—" : p.lag.toLocaleString()}
                                    </td>
                                    <td className="mono">{p.clientId || p.memberId || "—"}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
