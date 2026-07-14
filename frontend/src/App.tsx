import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "./App.css";
import { Lang, t } from "./lib/i18n";
import { errString } from "./lib/errors";
import { profile } from "../wailsjs/go/models";
import {
    Connect,
    DeleteProfile,
    Disconnect,
    GetClusterInfo,
    IsConnected,
    ListProfiles,
    AutoUpdate,
    CheckForUpdate,
    ApplyUpdate,
    GetPendingReleaseNotes,
    MarkReleaseNotesSeen,
    ShowUpdateModeNoticeOnce,
} from "../wailsjs/go/main/App";
import { kafka, updater } from "../wailsjs/go/models";
import {
    WindowSetSize,
    WindowCenter,
    WindowSetAlwaysOnTop,
} from "../wailsjs/runtime";
import { ContextMenu, ContextMenuItem } from "./components/ContextMenu";
import { VerticalSplitter, useResizableWidth } from "./components/ResizableColumns";
import { ProfileDialog } from "./components/ProfileDialog";
import { TimestampConverter } from "./components/TimestampConverter";
import { HelpDialog } from "./components/HelpDialog";
import { UpdatePromptDialog } from "./components/UpdatePromptDialog";
import { ReleaseNotesDialog } from "./components/ReleaseNotesDialog";
import { TopicsPage } from "./pages/TopicsPage";
import { ConsumePage } from "./pages/ConsumePage";
import { ProducePage } from "./pages/ProducePage";
import { SettingsPage } from "./pages/SettingsPage";

type TabKey = "topics" | "consume" | "produce" | "settings";

// Window dimensions for the two modes. Full app matches main.go's startup
// size; calc mode shrinks the OS window to wrap the compact converter card.
const APP_WIN = { w: 1280, h: 820 };
const CALC_WIN = { w: 420, h: 300 };
export type ThemePref = "light" | "dark" | "onion" | "dark-onion" | "system";
const THEME_KEY = "kfc.theme";

import onionLogoColor from "./assets/onion/logo-color.png";
import onionLogoWhite from "./assets/onion/logo-white.png";
import onionLogoOrange from "./assets/onion/logo-orange.png";

type ResolvedTheme = "light" | "dark" | "onion" | "dark-onion";

// Wraps a tab's page so it can be hidden without unmounting. Keeping the page
// mounted is what preserves its internal state (tail -f stream, fetched
// messages, produce form) when the user switches tabs and comes back. When
// active it fills the content area like a normal flex child; when hidden it's
// display:none so it occupies no space and triggers no layout.
function TabPanel({ active, children }: { active: boolean; children: ReactNode }) {
    return (
        <div
            style={
                active
                    ? { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }
                    : { display: "none" }
            }
        >
            {children}
        </div>
    );
}

// Guards the silent startup auto-update so it fires exactly once per process,
// even across React 18 StrictMode double-invokes of the mount effect. A second
// AutoUpdate() call would re-check GitHub and could double-trigger the swap.
let autoApplyFired = false;

function resolveTheme(pref: ThemePref): ResolvedTheme {
    if (pref === "system") {
        return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return pref;
}

function applyTheme(pref: ThemePref) {
    document.documentElement.dataset.theme = resolveTheme(pref);
}

export default function App() {
    const [lang, setLang] = useState<Lang>("ko");
    const [themePref, setThemePref] = useState<ThemePref>(() => {
        const v = localStorage.getItem(THEME_KEY);
        return v === "light" || v === "dark" || v === "onion" || v === "dark-onion" || v === "system"
            ? v
            : "system";
    });
    const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(themePref));

    // Apply on mount + when pref changes; if "system", also listen for OS changes.
    useEffect(() => {
        applyTheme(themePref);
        setResolvedTheme(resolveTheme(themePref));
        try { localStorage.setItem(THEME_KEY, themePref); } catch {}
        if (themePref !== "system") return;
        const mq = window.matchMedia("(prefers-color-scheme: dark)");
        const onChange = () => {
            applyTheme("system");
            setResolvedTheme(resolveTheme("system"));
        };
        mq.addEventListener?.("change", onChange);
        return () => mq.removeEventListener?.("change", onChange);
    }, [themePref]);

    const logoSrc =
        resolvedTheme === "dark" ? onionLogoWhite :
        resolvedTheme === "dark-onion" ? onionLogoOrange :
        onionLogoColor;
    const [profiles, setProfiles] = useState<profile.Profile[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [connectedSet, setConnectedSet] = useState<Set<string>>(new Set());
    const [tab, setTab] = useState<TabKey>("topics");
    // Standalone Unix-timestamp calculator, offered on the disconnected
    // placeholder so the converter is usable without a cluster connection.
    // Entering it shrinks the OS window to the converter; leaving restores
    // the full app window. `alwaysOnTop` is a calc-mode-only affordance.
    const [calcMode, setCalcMode] = useState(false);
    const [alwaysOnTop, setAlwaysOnTop] = useState(false);

    // Resize / recenter the OS window when the mode flips. On leaving calc
    // mode, also drop always-on-top and reset its checkbox state. Skip the
    // initial mount so we don't recenter the window on every launch.
    const modeInitDone = useRef(false);
    useEffect(() => {
        if (!modeInitDone.current) {
            modeInitDone.current = true;
            return;
        }
        if (calcMode) {
            WindowSetSize(CALC_WIN.w, CALC_WIN.h);
            WindowCenter();
        } else {
            WindowSetAlwaysOnTop(false);
            setAlwaysOnTop(false);
            WindowSetSize(APP_WIN.w, APP_WIN.h);
            WindowCenter();
        }
    }, [calcMode]);

    // Apply the always-on-top toggle while in calc mode.
    useEffect(() => {
        if (calcMode) WindowSetAlwaysOnTop(alwaysOnTop);
    }, [alwaysOnTop, calcMode]);
    const [dialog, setDialog] = useState<{ open: boolean; editing?: profile.Profile }>({ open: false });
    const [toast, setToast] = useState<string | null>(null);
    const [clusterInfo, setClusterInfo] = useState<Record<string, kafka.ClusterInfo>>({});

    // Shared topic state between Consume and Produce pages: selecting a topic
    // on one auto-selects on the other.
    const [sharedTopic, setSharedTopic] = useState<string>("");
    // Bumped whenever topics are created/edited/deleted in the Topics tab so the
    // Consume/Produce topic lists refresh live, without a disconnect/reconnect.
    const [topicsRev, setTopicsRev] = useState(0);

    // Sidebar context menu.
    const [sidebarCtx, setSidebarCtx] = useState<{ x: number; y: number; profile: profile.Profile } | null>(null);
    const [helpOpen, setHelpOpen] = useState(false);

    // Auto-update flow. updateInfo is set after a check fires on startup;
    // releaseNotes is set on startup if the previous version stashed notes for
    // us to show exactly once.
    const [updateInfo, setUpdateInfo] = useState<updater.UpdateInfo | null>(null);
    const [releaseNotes, setReleaseNotes] = useState<{ version: string; notes: string } | null>(null);
    // Set when the silent startup auto-update was BLOCKED by the loop guard
    // (5 non-converging attempts at the same target). We stop auto-applying and
    // surface a small persistent badge instead; clicking it applies manually.
    const [manualUpdate, setManualUpdate] = useState<updater.UpdateInfo | null>(null);

    // Sidebar width — drag the splitter at its right edge to resize.
    const sidebar = useResizableWidth("kfc.sidebar.width", 260);

    const refreshProfiles = useCallback(async () => {
        try {
            const list = await ListProfiles();
            setProfiles(list);
            if (list.length > 0 && !list.find((p) => p.id === selectedId)) {
                setSelectedId(list[0].id);
            }
            const next = new Set<string>();
            for (const p of list) {
                if (await IsConnected(p.id)) next.add(p.id);
            }
            setConnectedSet(next);
        } catch (e) {
            setToast(errString(e));
        }
    }, [selectedId]);

    useEffect(() => { void refreshProfiles(); }, []);

    // Startup: show release notes from the previous update (if any), then run
    // the GUARDED silent auto-update. AutoUpdate() checks GitHub and, if a newer
    // build is available and the loop guard allows it, downloads + swaps in place
    // and quits — the window closes and reopens on the new version on its own.
    // The new binary shows the stashed release notes once on its next launch.
    // If the guard trips (5 non-converging tries at the same target) it returns
    // Blocked and we surface a small manual-update badge instead of looping.
    // The module-level autoApplyFired guard makes this fire exactly once even
    // under StrictMode's double-mount. The manual "check for update" button in
    // Settings still routes through the prompt dialog for explicit checks.
    useEffect(() => {
        if (autoApplyFired) return;
        autoApplyFired = true;
        (async () => {
            // One-time notice: auto-update changed to notify-only due to the
            // corporate EDR policy. Fire-and-forget (native dialog, self-guarded
            // to show once per install).
            ShowUpdateModeNoticeOnce().catch(() => {});
            try {
                const notes = await GetPendingReleaseNotes();
                if (notes?.version) {
                    setReleaseNotes({ version: notes.version, notes: notes.notes ?? "" });
                }
            } catch {
                // Non-fatal — skip the notes popup.
            }
            try {
                // Notify-only update check: if a newer build exists, show a
                // manual "download" pill. We never self-replace the running exe —
                // endpoint security (EDR) quarantines self-updating binaries.
                const r = await AutoUpdate();
                if (r?.info?.available) setManualUpdate(r.info);
            } catch {
                // Network error / API hiccup — silently skip; retry next launch.
            }
        })();
    }, []);

    const dismissReleaseNotes = useCallback(() => {
        setReleaseNotes(null);
        void MarkReleaseNotesSeen();
    }, []);

    // Reset the shared topic when the selected profile changes — topic names
    // are not cross-profile valid.
    useEffect(() => { setSharedTopic(""); }, [selectedId]);

    useEffect(() => {
        if (!toast) return;
        const id = setTimeout(() => setToast(null), 3500);
        return () => clearTimeout(id);
    }, [toast]);

    const fetchClusterInfo = useCallback(async (id: string) => {
        try {
            const info = await GetClusterInfo(id);
            setClusterInfo((m) => ({ ...m, [id]: info }));
        } catch {
            // best-effort
        }
    }, []);

    const handleConnect = async (id: string) => {
        try {
            await Connect(id);
            setConnectedSet((s) => new Set(s).add(id));
            void fetchClusterInfo(id);
        } catch (e) {
            setToast(errString(e));
        }
    };

    const handleDisconnect = async (id: string) => {
        try {
            await Disconnect(id);
            setConnectedSet((s) => {
                const next = new Set(s);
                next.delete(id);
                return next;
            });
            setClusterInfo((m) => {
                const next = { ...m };
                delete next[id];
                return next;
            });
        } catch (e) {
            setToast(errString(e));
        }
    };

    useEffect(() => {
        for (const id of connectedSet) {
            if (!clusterInfo[id]) void fetchClusterInfo(id);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connectedSet]);

    const handleDelete = async (id: string) => {
        if (!confirm(t(lang, "profile.delete.confirm"))) return;
        try {
            await DeleteProfile(id);
            await refreshProfiles();
        } catch (e) {
            setToast(errString(e));
        }
    };

    const selected = profiles.find((p) => p.id === selectedId) ?? null;
    const connected = selected ? connectedSet.has(selected.id) : false;

    const sidebarCtxItems: ContextMenuItem[] = sidebarCtx
        ? [
            {
                label: t(lang, "profile.menu.edit"),
                onClick: () => setDialog({ open: true, editing: sidebarCtx.profile }),
            },
            {
                label: t(lang, "profile.menu.delete"),
                danger: true,
                onClick: () => handleDelete(sidebarCtx.profile.id),
            },
        ]
        : [];

    // Calculator mode: drop the entire Kafka chrome (sidebar / topbar / tabs)
    // and show just the compact timestamp converter, centered full-window.
    // The "Kafka Client 모드로 전환" button in its header restores the app.
    if (calcMode) {
        return (
            <div
                style={{
                    height: "100vh",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "var(--bg)",
                }}
            >
                <TimestampConverter
                    lang={lang}
                    style={{
                        borderTop: "none",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        width: 360,
                        maxWidth: "90%",
                    }}
                    headerButton={
                        <button className="small" onClick={() => setCalcMode(false)}>
                            {t(lang, "status.back_to_kafka")}
                        </button>
                    }
                    footer={
                        <label
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "flex-end",
                                gap: 6,
                                fontSize: 12,
                                color: "var(--text-dim)",
                                cursor: "pointer",
                                whiteSpace: "nowrap",
                            }}
                        >
                            {t(lang, "status.always_on_top")}
                            <input
                                type="checkbox"
                                checked={alwaysOnTop}
                                onChange={(e) => setAlwaysOnTop(e.target.checked)}
                            />
                        </label>
                    }
                />
            </div>
        );
    }

    return (
        <div
            className="app-root"
            style={{ gridTemplateColumns: `${sidebar.width}px 6px 1fr` }}
        >
            <aside className="sidebar">
                <div className="sidebar-header">
                    <img
                        src={logoSrc}
                        alt="ONION"
                        className="brand-logo"
                        title={t(lang, "app.title")}
                    />
                    <button className="primary small" onClick={() => setDialog({ open: true })}>
                        + {t(lang, "sidebar.add")}
                    </button>
                </div>
                <div className="sidebar-tagline">{t(lang, "app.title")}</div>
                <div className="sidebar-section-title">{t(lang, "sidebar.profiles")}</div>
                <div className="profile-list">
                    {profiles.length === 0 ? (
                        <div className="empty muted">{t(lang, "sidebar.empty")}</div>
                    ) : (
                        profiles.map((p) => (
                            <div
                                key={p.id}
                                className={"profile-item" + (p.id === selectedId ? " selected" : "")}
                                onClick={() => setSelectedId(p.id)}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    setSidebarCtx({ x: e.clientX, y: e.clientY, profile: p });
                                }}
                            >
                                <div className="profile-line1">
                                    <span
                                        className={"dot " + (connectedSet.has(p.id) ? "ok" : "off")}
                                        title={
                                            connectedSet.has(p.id)
                                                ? t(lang, "sidebar.connected")
                                                : t(lang, "sidebar.disconnected")
                                        }
                                    />
                                    <span className="profile-name">{p.name}</span>
                                </div>
                                <div className="profile-line2 muted">{p.bootstrapServers.join(", ")}</div>
                            </div>
                        ))
                    )}
                </div>
                <div style={{ padding: "8px 10px", borderTop: "1px solid var(--border)" }}>
                    <button
                        className="small"
                        onClick={() => setHelpOpen(true)}
                        style={{ width: "100%" }}
                    >
                        📖 {t(lang, "help.button")}
                    </button>
                </div>
            </aside>

            <VerticalSplitter
                value={sidebar.width}
                onChange={sidebar.setWidth}
                min={180}
                max={520}
                direction="ltr"
                onReset={sidebar.reset}
            />

            <main className="main">
                <div className="topbar">
                    {selected ? (
                        <>
                            <div className="topbar-title">
                                {selected.name}
                                {connected && clusterInfo[selected.id] && (
                                    <span className="muted" style={{ fontSize: 12, marginLeft: 10, fontWeight: 400 }}>
                                        ({t(lang, "topbar.controller")}: B{clusterInfo[selected.id].controller})
                                    </span>
                                )}
                            </div>
                            <div className="topbar-actions">
                                {connected ? (
                                    <button onClick={() => handleDisconnect(selected.id)}>
                                        {t(lang, "sidebar.disconnect")}
                                    </button>
                                ) : (
                                    <button className="primary" onClick={() => handleConnect(selected.id)}>
                                        {t(lang, "sidebar.connect")}
                                    </button>
                                )}
                            </div>
                        </>
                    ) : (
                        <div className="topbar-title muted">{t(lang, "status.no_profile")}</div>
                    )}
                </div>

                <nav className="tabs">
                    {(["topics", "consume", "produce", "settings"] as TabKey[]).map((k) => (
                        <button
                            key={k}
                            className={"tab" + (tab === k ? " active" : "")}
                            onClick={() => setTab(k)}
                        >
                            {t(lang, `tabs.${k}`)}
                        </button>
                    ))}
                </nav>

                <div className="content">
                    {/* Settings is usable without a connected profile. */}
                    {tab === "settings" && (
                        <SettingsPage
                            lang={lang}
                            setLang={setLang}
                            themePref={themePref}
                            setThemePref={setThemePref}
                            onProfilesChanged={refreshProfiles}
                            onUpdateAvailable={setUpdateInfo}
                        />
                    )}

                    {/* The three data pages need a connected profile. Once
                        mounted they stay mounted across tab switches (hidden,
                        not unmounted) so a running tail -f, the fetched
                        messages, and the produce form all survive flipping
                        between tabs. They're keyed by profile id so switching
                        profiles starts fresh. Settings renders alongside them
                        — being on Settings doesn't tear the tail down. */}
                    {tab !== "settings" && (!selected || !connected) ? (
                        <div
                            className="placeholder muted"
                            style={{ flexDirection: "column", gap: 12 }}
                        >
                            <div>
                                {!selected
                                    ? t(lang, "status.no_profile")
                                    : t(lang, "status.connect_required")}
                            </div>
                            <button className="small" onClick={() => setCalcMode(true)}>
                                {t(lang, "status.open_ts_calc")}
                            </button>
                        </div>
                    ) : selected && connected ? (
                        <>
                            <TabPanel active={tab === "topics"}>
                                <TopicsPage
                                    key={selected.id}
                                    lang={lang}
                                    profileId={selected.id}
                                    active={tab === "topics"}
                                    onTick={() => void fetchClusterInfo(selected.id)}
                                    onTopicsChanged={() => setTopicsRev((v) => v + 1)}
                                />
                            </TabPanel>
                            <TabPanel active={tab === "consume"}>
                                <ConsumePage
                                    key={selected.id}
                                    lang={lang}
                                    profileId={selected.id}
                                    defaultTopic={selected.defaultTopic}
                                    topic={sharedTopic}
                                    onTopicChange={setSharedTopic}
                                    topicsRev={topicsRev}
                                />
                            </TabPanel>
                            <TabPanel active={tab === "produce"}>
                                <ProducePage
                                    key={selected.id}
                                    lang={lang}
                                    profileId={selected.id}
                                    defaultTopic={selected.defaultTopic}
                                    topic={sharedTopic}
                                    onTopicChange={setSharedTopic}
                                    topicsRev={topicsRev}
                                />
                            </TabPanel>
                        </>
                    ) : null}
                </div>
            </main>

            {dialog.open && (
                <ProfileDialog
                    lang={lang}
                    editing={dialog.editing}
                    onClose={() => setDialog({ open: false })}
                    onSaved={async () => {
                        setDialog({ open: false });
                        await refreshProfiles();
                    }}
                />
            )}

            {sidebarCtx && (
                <ContextMenu
                    x={sidebarCtx.x}
                    y={sidebarCtx.y}
                    items={sidebarCtxItems}
                    onClose={() => setSidebarCtx(null)}
                />
            )}

            {helpOpen && <HelpDialog lang={lang} onClose={() => setHelpOpen(false)} />}

            {/* Release notes from the previous version's update — show once,
                then mark seen so the file is cleared. Render before the
                update prompt so notes for *this* version come first. */}
            {releaseNotes && (
                <ReleaseNotesDialog
                    lang={lang}
                    version={releaseNotes.version}
                    notes={releaseNotes.notes}
                    onClose={dismissReleaseNotes}
                />
            )}

            {updateInfo && !releaseNotes && (
                <UpdatePromptDialog
                    lang={lang}
                    info={updateInfo}
                    onClose={() => setUpdateInfo(null)}
                />
            )}

            {/* Manual-update badge: shown only when the silent auto-update was
                blocked by the loop guard. Clicking it applies the update the
                normal (unguarded) way. Persistent until dismissed or applied. */}
            {manualUpdate && (
                <button
                    onClick={async () => {
                        try {
                            setToast("브라우저에서 다운로드 페이지를 엽니다… " + (manualUpdate.latestVersion ?? ""));
                            await ApplyUpdate(manualUpdate); // opens the GitHub release page (no self-replace)
                            setManualUpdate(null);
                        } catch (e) {
                            setToast(errString(e) || "다운로드 페이지 열기 실패");
                        }
                    }}
                    title="브라우저에서 릴리스 페이지를 열어 새 버전을 직접 내려받습니다 (자동 교체 안 함)"
                    style={{
                        position: "fixed",
                        right: 16,
                        bottom: 16,
                        zIndex: 60,
                        padding: "8px 12px",
                        borderRadius: 999,
                        border: "1px solid var(--border)",
                        background: "var(--accent, #2d7ff9)",
                        color: "#fff",
                        fontSize: 12,
                        cursor: "pointer",
                        boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
                    }}
                >
                    ⬆️ 새 버전 {manualUpdate.latestVersion} — 다운로드
                </button>
            )}

            {toast && <div className="toast">{toast}</div>}
        </div>
    );
}
