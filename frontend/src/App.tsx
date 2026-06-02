import { useCallback, useEffect, useState, type ReactNode } from "react";
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
    CheckForUpdate,
    GetPendingReleaseNotes,
    MarkReleaseNotesSeen,
} from "../wailsjs/go/main/App";
import { kafka, updater } from "../wailsjs/go/models";
import { ContextMenu, ContextMenuItem } from "./components/ContextMenu";
import { VerticalSplitter, useResizableWidth } from "./components/ResizableColumns";
import { ProfileDialog } from "./components/ProfileDialog";
import { HelpDialog } from "./components/HelpDialog";
import { UpdatePromptDialog } from "./components/UpdatePromptDialog";
import { ReleaseNotesDialog } from "./components/ReleaseNotesDialog";
import { TopicsPage } from "./pages/TopicsPage";
import { ConsumePage } from "./pages/ConsumePage";
import { ProducePage } from "./pages/ProducePage";
import { SettingsPage } from "./pages/SettingsPage";

type TabKey = "topics" | "consume" | "produce" | "settings";
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
    const [dialog, setDialog] = useState<{ open: boolean; editing?: profile.Profile }>({ open: false });
    const [toast, setToast] = useState<string | null>(null);
    const [clusterInfo, setClusterInfo] = useState<Record<string, kafka.ClusterInfo>>({});

    // Shared topic state between Consume and Produce pages: selecting a topic
    // on one auto-selects on the other.
    const [sharedTopic, setSharedTopic] = useState<string>("");

    // Sidebar context menu.
    const [sidebarCtx, setSidebarCtx] = useState<{ x: number; y: number; profile: profile.Profile } | null>(null);
    const [helpOpen, setHelpOpen] = useState(false);

    // Auto-update flow. updateInfo is set after a check fires on startup;
    // releaseNotes is set on startup if the previous version stashed notes for
    // us to show exactly once.
    const [updateInfo, setUpdateInfo] = useState<updater.UpdateInfo | null>(null);
    const [releaseNotes, setReleaseNotes] = useState<{ version: string; notes: string } | null>(null);

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

    // Startup: show release notes from the previous update (if any), then
    // check GitHub for a newer release and prompt.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const notes = await GetPendingReleaseNotes();
                if (!cancelled && notes && notes.version) {
                    setReleaseNotes({ version: notes.version, notes: notes.notes ?? "" });
                }
            } catch {
                // Non-fatal — skip the notes popup.
            }
            try {
                const info = await CheckForUpdate();
                if (!cancelled && info?.available) {
                    setUpdateInfo(info);
                }
            } catch {
                // Network error / API hiccup — silently skip; the user can
                // upgrade manually next time.
            }
        })();
        return () => {
            cancelled = true;
        };
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
                        <div className="placeholder muted">
                            {!selected ? t(lang, "status.no_profile") : t(lang, "status.connect_required")}
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

            {toast && <div className="toast">{toast}</div>}
        </div>
    );
}
