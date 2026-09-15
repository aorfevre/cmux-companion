"use client";
import { HomeDestination } from './home-destination';
import { LastUpdateStamp } from './last-update';
export { LastUpdateStamp, updatedAgo } from './last-update';
import { MissionShell } from './mission-shell';
import './sessions.css';
import { sessionState } from "../server/session-state.mjs";
import { relativeTime } from "./relative-time";
/* eslint-disable jsx-a11y/no-autofocus */

import { request as api } from "./api-request";
import { AttachmentStrip, composedPrompt, useImageAttachments, type ImageAttachment } from "./image-attachments";
import { useOwnedRead } from "./use-owned-read";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownViewer } from "./markdown-viewer";
import { slashShortcuts } from "./slash-shortcuts.mjs";
import { isNearBottom, nextFollowState } from "./terminal-follow.mjs";
import { TerminalGrid, type TerminalView } from "./terminal-grid.tsx";
import { terminalViewSignature } from "./terminal-grid.mjs";


type Terminal = { id: string; title: string; current_directory?: string | null; is_focused?: boolean; is_ready?: boolean };
type WorkspaceStatus = { effective?: string; inferred?: string; signals?: Record<string, boolean> };
type Workspace = { id: string; title: string; current_directory?: string | null; has_unread?: boolean; is_selected?: boolean; last_activity_at?: number; preview?: string | null; listening_ports?: number[]; terminals: Terminal[]; status?: WorkspaceStatus | null };
type Bootstrap = { setupRequired?: boolean; connected: boolean; host: { mac_display_name?: string; workspace_count?: number } | null; workspaces: Workspace[]; error: string | null; refreshedAt: string };
type Repo = { id: string; name: string; root: string; path: string; branch: string; ahead: number; behind: number; changedFiles: number; dirty: boolean; lastActivity: number; scripts: string[]; githubRepository?: string };
type Todo = { id: string; text: string; state: string; origin?: string };
type Overview = { status: WorkspaceStatus; todos: { items: Todo[]; progress: { completed: number; total: number; first_unchecked_text?: string | null } }; metrics: { cpuPercent: number; memoryBytes: number; processCount: number } | null; surfaceHealth: { surfaces?: Array<{ id: string; type: string; in_window: boolean }> } | null };
type ChangedFile = { path: string; status: string; area: string; areas: string[] };
type Changes = { repo: Repo; files: ChangedFile[]; summary: { staged: string; unstaged: string }; recentCommit?: { hash: string; subject: string } | null };
type PullRequest = { number: number; title: string; url: string; state: string; isDraft: boolean; reviewDecision: string; mergeState: string; headBranch: string; baseBranch: string; updatedAt?: string | null; author?: string | null; checks: { passed: number; failed: number; pending: number; total: number } };
type View = "sessions" | "launch";
type DetailTab = "terminal" | "tasks" | "changes";



function sameTerminalView(left: TerminalView | null, right: TerminalView | null) { return terminalViewSignature(left) === terminalViewSignature(right); }

function compactPath(path?: string | null) { return path ? path.replace(/^\/Users\/[^/]+/, "~") : "Directory unavailable"; }

function formatBytes(bytes = 0) { if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`; if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`; return `${(bytes / 1024 ** 3).toFixed(1)} GB`; }

export default function Home() { return <HomeDestination sessions={<SessionsHome />} />; }

function SessionsHome() {
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    if (query.get('view') === 'settings') location.replace(`/settings${location.hash}`);
    if (query.get('view') === 'usage') location.replace('/settings#usage');
    if (['worktrees', 'inbox', 'apps'].includes(query.get('view') || '') || query.has('action') || query.has('preview')) location.replace('/orchestration');
  }, []);
  const [auth, setAuth] = useState<"loading" | "paired" | "unpaired" | "offline">("loading");
  const [pairingToken, setPairingToken] = useState(""); const [pairingError, setPairingError] = useState("");
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null); const [repos, setRepos] = useState<Repo[]>([]);
  const [view, setView] = useState<View>(() => typeof window !== 'undefined' && new URLSearchParams(location.search).get('view') === 'launch' ? 'launch' : 'sessions'); const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(() => { if (typeof window === "undefined") return null; const query = new URLSearchParams(location.search); return query.get("workspace"); }); const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(() => typeof window === "undefined" ? null : new URLSearchParams(location.search).get("surface")); const [detailTab, setDetailTab] = useState<DetailTab>(() => { if (typeof window === "undefined") return "terminal"; const tab = new URLSearchParams(location.search).get("tab"); return tab === "changes" || tab === "tasks" ? tab : "terminal"; });
  const [draft, setDraft] = useState(""); const [sending, setSending] = useState(false); const [live, setLive] = useState(false); const [notice, setNotice] = useState("");
  const [documentTarget, setDocumentTarget] = useState<{ repoId: string; path: string } | null>(() => { if (typeof window === "undefined") return null; const query = new URLSearchParams(location.search); const repoId = query.get("repo"); const path = query.get("file"); return repoId && path && !query.has("workspace") && !query.has("action") ? { repoId, path } : null; });
  // Goals always owns the landing page; explicit legacy session links still work.
  const [readOnly, setReadOnly] = useState(() => typeof window === "undefined" || localStorage.getItem("cmux-companion-read-only") !== "false");
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { const back = () => { const query = new URLSearchParams(location.search); setView(query.get('view') === 'launch' ? 'launch' : 'sessions'); setSelectedWorkspaceId(query.get('workspace')); setSelectedTerminalId(query.get('surface')); setDetailTab((query.get('tab') || 'terminal') as DetailTab); }; window.addEventListener('popstate', back); return () => window.removeEventListener('popstate', back); }, []);


  const selectedWorkspace = useMemo(() => bootstrap?.workspaces.find((workspace) => workspace.id === selectedWorkspaceId) || null, [bootstrap, selectedWorkspaceId]);
  const selectedTerminal = selectedWorkspace?.terminals.find((terminal) => terminal.id === selectedTerminalId) || selectedWorkspace?.terminals[0] || null;
  const selectedRepo = useMemo(() => { const directory = selectedWorkspace?.current_directory || selectedTerminal?.current_directory; if (!directory) return null; return repos.find((repo) => directory === repo.path || directory.startsWith(`${repo.path}/`)) || null; }, [repos, selectedTerminal, selectedWorkspace]);
  const workspaceId = selectedWorkspace?.id || null; const surfaceId = selectedTerminal?.id || null;
  const { attachments, addImages, removeImage, clearAttachments } = useImageAttachments(setNotice, `${workspaceId}:${surfaceId}`);
  const addImage = useCallback((file: File) => addImages([file]), [addImages]);

  const loadBootstrap = useCallback(async () => { try { const data = await api<Bootstrap>("/api/bootstrap"); setBootstrap(data); setAuth("paired"); return data; } catch (error) { if (error instanceof Error && error.message.includes("Pair")) setAuth("unpaired"); setBootstrap((current) => current ? { ...current, connected: false, error: "Waiting for cmux" } : null); return null; } }, []);
  const loadRepos = useCallback(async () => { try { setRepos((await api<{ repos: Repo[] }>("/api/repos")).repos); } catch { /* retry later */ } }, []);
  const readIdentity = `${auth}:${workspaceId}:${surfaceId}`;
  const { value: terminalView, error: screenError, refresh: loadTerminal, clear: clearTerminal } = useOwnedRead<TerminalView | null>(selectedTerminal ? `/api/terminals/${selectedTerminal.id}/replay?scrollback=600` : null, null, sameTerminalView, readIdentity);

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    api<{ paired: boolean }>("/api/auth/status").then((status) => setAuth(status.paired ? "paired" : "unpaired")).catch(() => setAuth("offline"));
  }, []);

  useEffect(() => {
    if (auth !== "paired") return;
    let stopped = false; let socket: WebSocket | null = null; let retry: ReturnType<typeof setTimeout> | null = null; let attempt = 0;
    const refresh = () => { loadBootstrap(); };
    const connect = () => { if (stopped) return; const protocol = location.protocol === "https:" ? "wss:" : "ws:"; socket = new WebSocket(`${protocol}//${location.host}/api/events`); socket.onopen = () => { attempt = 0; setLive(true); }; socket.onmessage = (message) => { try { const event = JSON.parse(message.data); if (event.type === "cmux:event") { if (refreshTimer.current) clearTimeout(refreshTimer.current); refreshTimer.current = setTimeout(refresh, 300); } } catch { /* malformed event */ } }; socket.onclose = () => { setLive(false); if (!stopped) retry = setTimeout(connect, Math.min(30_000, 800 * (2 ** attempt++))); }; };
    const kickoff = setTimeout(() => { refresh(); loadRepos(); connect(); }, 0); const poll = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 8_000);
    return () => { stopped = true; clearTimeout(kickoff); clearInterval(poll); if (retry) clearTimeout(retry); if (refreshTimer.current) clearTimeout(refreshTimer.current); socket?.close(); };
  }, [auth, loadBootstrap, loadRepos]);

  useEffect(() => { if (!selectedTerminal || detailTab !== "terminal") return; const kickoff = setTimeout(loadTerminal, 0); const poll = setInterval(() => { if (document.visibilityState === "visible") loadTerminal(); }, 1_500); return () => { clearTimeout(kickoff); clearInterval(poll); }; }, [selectedTerminal, detailTab, loadTerminal]);
  async function pair(event: FormEvent) { event.preventDefault(); setPairingError(""); try { await api("/api/auth/pair", { method: "POST", body: JSON.stringify({ token: pairingToken.trim() }) }); setPairingToken(""); setAuth("paired"); } catch (error) { setPairingError(error instanceof Error ? error.message : "Pairing failed"); } }
  function openWorkspace(workspace: Workspace, tab: DetailTab = "terminal") { setDocumentTarget(null); setSelectedWorkspaceId(workspace.id); setSelectedTerminalId(workspace.terminals.find((terminal) => terminal.is_focused)?.id || workspace.terminals[0]?.id || null); clearTerminal(); clearAttachments(); setDetailTab(tab); history.pushState(null, "", `/?workspace=${encodeURIComponent(workspace.id)}${tab !== "terminal" ? `&tab=${tab}` : ""}`); }
  function closeWorkspaceView() { setSelectedWorkspaceId(null); setSelectedTerminalId(null); clearTerminal(); clearAttachments(); history.replaceState(null, "", `/?view=${view}`); }
  async function sendPrompt(event: FormEvent) { event.preventDefault(); if (!selectedTerminal || (!draft.trim() && attachments.length === 0) || readOnly) return; const text = composedPrompt(draft, attachments); setSending(true); try { await api(`/api/terminals/${selectedTerminal.id}/input`, { method: "POST", body: JSON.stringify({ text, enter: true }) }); setDraft(""); clearAttachments(); setTimeout(loadTerminal, 200); } catch (error) { setNotice(error instanceof Error ? error.message : "Could not send input"); } finally { setSending(false); } }
  async function sendKey(key: string) { if (!selectedTerminal || readOnly) return; setSending(true); try { await api(`/api/terminals/${selectedTerminal.id}/key`, { method: "POST", body: JSON.stringify({ key }) }); setTimeout(loadTerminal, 150); } catch (error) { setNotice(error instanceof Error ? error.message : "Could not send key"); } finally { setSending(false); } }
  function changeReadOnly(value: boolean) { setReadOnly(value); localStorage.setItem("cmux-companion-read-only", String(value)); }
  function changeView(next: View) { setSelectedWorkspaceId(null); setDocumentTarget(null); setView(next); history.pushState(null, "", `/?view=${next}`); }
  function openDocument(repoId: string, path: string) { setDocumentTarget({ repoId, path: path.replace(/^\.\//, "") }); history.replaceState(null, "", `/?repo=${encodeURIComponent(repoId)}&file=${encodeURIComponent(path.replace(/^\.\//, ""))}`); }
  function openRepoWorkspace(repoId: string) { const repo = repos.find((item) => item.id === repoId); const workspace = bootstrap?.workspaces.find((item) => repo && (item.current_directory === repo.path || item.current_directory?.startsWith(`${repo.path}/`))); if (workspace) openWorkspace(workspace); else setNotice("No open cmux session uses this repository"); }

  if (auth === "loading") return <LoadingScreen />;
  if (auth === "unpaired" || auth === "offline") return <PairScreen offline={auth === "offline"} token={pairingToken} error={pairingError} onToken={setPairingToken} onPair={pair} />;
  if (documentTarget) return <MarkdownViewer repoId={documentTarget.repoId} path={documentTarget.path} onClose={() => { setDocumentTarget(null); history.replaceState(null, "", selectedWorkspace ? `/?workspace=${encodeURIComponent(selectedWorkspace.id)}` : "/?view=sessions"); }} onAsk={(file) => { const workspace = bootstrap?.workspaces.find((item) => item.current_directory === file.repo.path || item.current_directory?.startsWith(`${file.repo.path}/`)); if (!workspace) { setNotice("Open a session for this repository first"); return; } setDraft(`Please review ${file.path} and help me with it.`); openWorkspace(workspace); }} onOpenWorkspace={openRepoWorkspace} />;
  if (selectedWorkspace && selectedTerminal) return <MissionShell active="sessions" className="sessions-mission"><Notice message={notice} onDismiss={() => setNotice("")} /><WorkspaceDetail workspace={selectedWorkspace} terminal={selectedTerminal} repo={selectedRepo} tab={detailTab} terminalView={terminalView} screenError={screenError} draft={draft} attachments={attachments} sending={sending} readOnly={readOnly} onBack={closeWorkspaceView} onTab={setDetailTab} onTerminal={(id) => { setSelectedTerminalId(id); clearTerminal(); clearAttachments(); }} onDraft={setDraft} onImage={addImage} onRemoveImage={removeImage} onSubmit={sendPrompt} onKey={sendKey} onReadOnly={() => changeReadOnly(!readOnly)} onRefresh={loadTerminal} onChanged={async () => { await loadBootstrap(); }} onNotice={setNotice} onMarkdown={(path) => selectedRepo ? openDocument(selectedRepo.id, path) : setNotice("That file is outside a catalogued repository")} /></MissionShell>;

  return <MissionShell active="sessions" className="sessions-mission">{bootstrap?.setupRequired && <aside className="privacy-note"><strong>Welcome to Companion</strong><p><a href="/onboarding">Set up your projects and agents</a> to start your first goal.</p></aside>}<AppHeader connected={Boolean(bootstrap?.connected)} live={live} device={bootstrap?.host?.mac_display_name || "Your Mac"} /><Notice message={notice} onDismiss={() => setNotice("")} />
    {view === "sessions" ? <SessionsView bootstrap={bootstrap} onOpen={openWorkspace} onLaunch={() => changeView("launch")} onRefresh={loadBootstrap} /> : <><button className="session-back" onClick={() => changeView('sessions')}>← Sessions</button><LaunchView repos={repos} onReload={loadRepos} onLaunched={async (id) => { const data = await loadBootstrap(); const workspace = data?.workspaces.find((item) => item.id === id); if (workspace) openWorkspace(workspace); else { setView("sessions"); setNotice("Workspace launched. It will appear in a moment."); } }} /></>}
  </MissionShell>;
}

function Notice({ message, onDismiss }: { message: string; onDismiss: () => void }) { return message ? <div className="toast" role="status">{message}<button aria-label="Dismiss notification" onClick={onDismiss}>×</button></div> : null; }

function AppHeader({ connected, live, device }: { connected: boolean; live: boolean; device: string }) { return <header className="topbar"><div className="brand-mark">c</div><div className="brand-copy"><strong>cmux companion</strong><span><i className={`connection-dot ${connected ? "" : "offline"}`} />{connected ? device : "Waiting for cmux"}</span></div><LastUpdateStamp /><span className={`live-badge ${live ? "" : "sync"}`}>{live ? "LIVE" : "SYNC"}</span></header>; }


function SessionsView({ bootstrap, onOpen, onLaunch, onRefresh }: { bootstrap: Bootstrap | null; onOpen: (workspace: Workspace) => void; onLaunch: () => void; onRefresh: () => void }) {
  const [search, setSearch] = useState('');
  const workspaces = bootstrap?.workspaces || [];
  const visible = workspaces.filter(workspace => `${workspace.title} ${workspace.current_directory ?? ''}`.toLowerCase().includes(search.toLowerCase())); const needsYou = workspaces.filter((item) => sessionState(item).tone === "attention").length; const working = workspaces.filter((item) => sessionState(item).tone === "working").length;
  return <><section className="hero"><p className="eyebrow">SESSIONS</p><h1>Sessions</h1><p>Inspect and control the workspaces open on your Mac.</p><div className="summary-row"><div><strong>{workspaces.length}</strong><span>sessions</span></div><div><strong className="accent-number">{needsYou}</strong><span>needs you</span></div><div><strong>{working}</strong><span>working</span></div></div></section><section className="content-section"><div className="section-heading"><h2>Open on your Mac</h2><div><button className="text-button" onClick={onRefresh}>Refresh</button><button className="primary-small" onClick={onLaunch}>＋ New</button></div></div>{!bootstrap && <WorkspaceSkeleton />}{bootstrap && workspaces.length === 0 && <Empty icon="⌁" title="No sessions yet" body="Launch a repository here or open a workspace on your Mac." action={<button className="primary-button" onClick={onLaunch}>Launch a workspace</button>} />}<label className="session-search">Search sessions<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Name or directory" /></label>{bootstrap && workspaces.length > 0 && visible.length === 0 && <p>No sessions match your search.</p>}<div className="workspace-list">{visible.map((workspace) => { const state = sessionState(workspace); const terminal = workspace.terminals.find((item) => item.is_focused) || workspace.terminals[0]; return <button className="workspace-card" key={workspace.id} onClick={() => onOpen(workspace)}><div className="workspace-card-head"><span className={`status-orb ${state.tone}`} /><div><strong>{workspace.title || "Untitled workspace"}</strong><span>{compactPath(workspace.current_directory || terminal?.current_directory)}</span></div><time>{relativeTime(workspace.last_activity_at)}</time></div><p>{workspace.preview || terminal?.title || "Terminal ready"}</p><div className="card-foot"><span className={`state-pill ${state.tone}`}>{state.label}</span><span>{workspace.terminals.length} terminal{workspace.terminals.length === 1 ? "" : "s"}</span><b>Open ›</b></div></button>; })}</div></section></>;
}

function LaunchView({ repos, onReload, onLaunched }: { repos: Repo[]; onReload: () => void; onLaunched: (id: string) => void }) {
  const [query, setQuery] = useState(""); const [selected, setSelected] = useState<Repo | null>(null); const [agent, setAgent] = useState("codex"); const [prompt, setPrompt] = useState(""); const [script, setScript] = useState(""); const [title, setTitle] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const filtered = repos.filter((repo) => `${repo.name} ${repo.root} ${repo.branch} ${repo.githubRepository ?? ""}`.toLowerCase().includes(query.toLowerCase())).slice(0, 40);
  async function launch(event: FormEvent) { event.preventDefault(); if (!selected) return; setBusy(true); setError(""); try { const result = await api<{ workspace: { workspace_id: string } }>("/api/workspaces", { method: "POST", body: JSON.stringify({ repoId: selected.id, title: title || selected.name, agent: script ? "shell" : agent, prompt, script: script || null }) }); onLaunched(result.workspace.workspace_id); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not launch workspace"); } finally { setBusy(false); } }
  return <section className="subpage launch-page"><div className="page-kicker"><div><p className="eyebrow">REPO LAUNCHPAD</p><h1>Start work</h1></div><button className="text-button" onClick={onReload}>Rescan</button></div><p className="subpage-intro">Open an approved local repository directly in a fresh cmux workspace.</p>{!selected ? <><label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a repository…" autoFocus /></label><div className="repo-list">{filtered.map((repo) => <button key={repo.id} onClick={() => { setSelected(repo); setTitle(repo.name); }}><span className="repo-icon">{repo.name.slice(0, 1).toUpperCase()}</span><div><strong>{repo.name}</strong><span>{repo.root} · {repo.branch}</span></div>{repo.dirty && <em>{repo.changedFiles} changed</em>}<b>›</b></button>)}</div></> : <form className="launch-form" onSubmit={launch}><button type="button" className="inline-back" onClick={() => setSelected(null)}>‹ Choose another repo</button><div className="selected-repo"><span className="repo-icon">{selected.name.slice(0, 1).toUpperCase()}</span><div><strong>{selected.name}</strong><span>{compactPath(selected.path)} · {selected.branch}</span></div></div><label>Workspace name<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} /></label><fieldset><legend>Start with</legend>{["codex", "claude", "shell"].map((value) => <button type="button" className={agent === value && !script ? "selected" : ""} onClick={() => { setAgent(value); setScript(""); }} key={value}>{value === "codex" ? "Codex" : value === "claude" ? "Claude" : "Shell"}</button>)}</fieldset>{selected.scripts.length > 0 && <label>Or run package script<select value={script} onChange={(event) => setScript(event.target.value)}><option value="">No script</option>{selected.scripts.map((value) => <option key={value} value={value}>npm run {value}</option>)}</select></label>}{!script && agent !== "shell" && <label>Initial task<textarea rows={5} value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={8000} placeholder="Describe the outcome you want…" /></label>}{error && <p className="form-error">{error}</p>}<button className="primary-button" disabled={busy}>{busy ? "Launching…" : `Launch ${script ? "script" : agent}`}</button></form>}</section>;
}

function WorkspaceDetail(props: { workspace: Workspace; terminal: Terminal; repo: Repo | null; tab: DetailTab; terminalView: TerminalView | null; screenError: string; draft: string; attachments: ImageAttachment[]; sending: boolean; readOnly: boolean; onBack: () => void; onTab: (tab: DetailTab) => void; onTerminal: (id: string) => void; onDraft: (value: string) => void; onImage: (file: File) => void; onRemoveImage: (path: string) => void; onSubmit: (event: FormEvent) => void; onKey: (key: string) => void; onReadOnly: () => void; onRefresh: () => void; onChanged: () => void; onNotice: (message: string) => void; onMarkdown: (path: string) => void; }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [fontSize, setFontSize] = useState(() => typeof window === "undefined" ? 14 : Number(localStorage.getItem("cmux-companion-terminal-font")) || 14);
  const [fitToPhone, setFitToPhone] = useState(() => typeof window === "undefined" || localStorage.getItem("cmux-companion-fit-terminal") !== "false");
  function changeFont(delta: number) { setFontSize((current) => { const next = Math.max(11, Math.min(20, current + delta)); localStorage.setItem("cmux-companion-terminal-font", String(next)); return next; }); }
  function toggleFit() { setFitToPhone((current) => { const next = !current; localStorage.setItem("cmux-companion-fit-terminal", String(next)); return next; }); }
  return (
    <section className="detail-shell">
      <header className="detail-header"><button className="back-button" onClick={props.onBack}>‹ <span>Back</span></button><div><strong>{props.workspace.title}</strong><span>{compactPath(props.workspace.current_directory)}</span></div><button className="session-menu-button" aria-label="Session menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><span className={`status-orb ${sessionState(props.workspace).tone}`} />•••</button></header>
      <div className="session-toolbar"><label>View<select aria-label="Session section" value={props.tab} onChange={event => props.onTab(event.target.value as DetailTab)}><option value="terminal">Terminal</option><option value="tasks">Health</option><option value="changes">Changes</option></select></label><label>Terminal<select aria-label="Active terminal" value={props.terminal.id} onChange={event => props.onTerminal(event.target.value)}>{props.workspace.terminals.map(terminal => <option key={terminal.id} value={terminal.id}>{terminal.title}</option>)}</select></label><button className="input-protection" onClick={props.onReadOnly}>{props.readOnly ? 'Allow terminal input' : 'Protect terminal input'}</button></div>
      {props.tab === "terminal" && <TerminalPanel {...props} fontSize={fontSize} fitToPhone={fitToPhone} shortcutsOpen={shortcutsOpen} onShortcuts={setShortcutsOpen} />}
      {props.tab === "tasks" && <HealthPanel key={props.workspace.id} workspace={props.workspace} terminal={props.terminal} onChanged={props.onChanged} onNotice={props.onNotice} />}
      {props.tab === "changes" && <ChangesPanel key={props.repo?.id} repo={props.repo} onMarkdown={props.onMarkdown} />}
      {menuOpen && <><button className="session-menu-backdrop" aria-label="Close session menu" onClick={() => setMenuOpen(false)} /><section className="session-menu" role="dialog" aria-modal="true" aria-label="Session menu"><header><div><strong>{props.workspace.title}</strong><span>Session controls</span></div><button onClick={() => setMenuOpen(false)}>×</button></header><nav className="session-menu-nav">{(["terminal", "tasks", "changes"] as DetailTab[]).map((tab) => <button className={props.tab === tab ? "active" : ""} onClick={() => { props.onTab(tab); setMenuOpen(false); }} key={tab}>{tab === "tasks" ? "Health" : tab[0].toUpperCase() + tab.slice(1)}</button>)}</nav><PullRequestBanner repo={props.repo} />{props.workspace.terminals.length > 1 && <div className="session-menu-section"><span>Terminals</span><div className="menu-terminal-list">{props.workspace.terminals.map((terminal, index) => <button className={terminal.id === props.terminal.id ? "active" : ""} onClick={() => { props.onTerminal(terminal.id); setMenuOpen(false); }} key={terminal.id}>{index + 1}. {terminal.title}</button>)}</div></div>}<div className="session-menu-section"><span>Display & input</span><div className="menu-action-grid"><button className={fitToPhone ? "active" : ""} onClick={toggleFit}>Fit text <b>{fitToPhone ? "On" : "Off"}</b></button><button onClick={props.onRefresh}>Refresh</button><button onClick={() => changeFont(-1)} disabled={fontSize <= 11}>Text A−</button><button onClick={() => changeFont(1)} disabled={fontSize >= 20}>Text A＋</button><button className={!props.readOnly ? "active" : ""} onClick={props.onReadOnly}>{props.readOnly ? "Enable input" : "Input enabled"}</button><button disabled={props.readOnly} onClick={() => { props.onTab("terminal"); setShortcutsOpen(true); setMenuOpen(false); }}>／ Shortcuts</button></div></div><div className="session-menu-section"><span>Special keys</span><div className="menu-key-grid">{[["Esc", "escape"], ["Tab", "tab"], ["↑", "up"], ["↓", "down"], ["Ctrl-C", "ctrl+c"], ["Enter", "enter"]].map(([label, key]) => <button disabled={props.readOnly || props.sending} onClick={() => props.onKey(key)} key={key}>{label}</button>)}</div></div></section></>}
    </section>
  );
}


export function PullRequestBanner({ repo }: { repo: Repo | null }) {
  const [pullRequest, setPullRequest] = useState<PullRequest | null>(null);
  useEffect(() => {
    if (!repo) return;
    let active = true;
    const timer = setTimeout(() => {
      api<{ pullRequest: PullRequest | null }>(`/api/repos/${repo.id}/pull-request`)
        .then((result) => { if (active) setPullRequest(result.pullRequest); })
        .catch(() => {});
    }, 0);
    return () => { active = false; clearTimeout(timer); };
  }, [repo]);
  if (!pullRequest) return null;
  const review = pullRequest.isDraft ? "Draft" : pullRequest.reviewDecision === "APPROVED" ? "Approved" : pullRequest.reviewDecision === "CHANGES_REQUESTED" ? "Changes requested" : "Review needed";
  const checks = pullRequest.checks.failed ? `${pullRequest.checks.failed} failed` : pullRequest.checks.pending ? `${pullRequest.checks.pending} running` : pullRequest.checks.total ? `${pullRequest.checks.passed}/${pullRequest.checks.total} checks passed` : "No checks";
  const tone = pullRequest.checks.failed || pullRequest.reviewDecision === "CHANGES_REQUESTED" ? "problem" : pullRequest.checks.pending ? "pending" : "good";
  return <a className={`pr-banner ${tone}`} href={pullRequest.url} target="_blank" rel="noreferrer"><span className="pr-icon">PR</span><div><strong>#{pullRequest.number} {pullRequest.title}</strong><small>{pullRequest.headBranch} → {pullRequest.baseBranch}</small></div><span className="pr-state"><b>{review}</b><small>{checks}</small></span><em>↗</em></a>;
}

export function TerminalPanel(props: { workspace: Workspace; terminal: Terminal; terminalView: TerminalView | null; screenError: string; draft: string; attachments: ImageAttachment[]; sending: boolean; readOnly: boolean; fontSize: number; fitToPhone: boolean; shortcutsOpen: boolean; onTerminal: (id: string) => void; onDraft: (value: string) => void; onImage: (file: File) => void; onRemoveImage: (path: string) => void; onSubmit: (event: FormEvent) => void; onKey: (key: string) => void; onReadOnly: () => void; onRefresh: () => void; onShortcuts: (open: boolean) => void; onMarkdown: (path: string) => void }) {
  const screenRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const initial = useRef(true);
  const following = useRef(true);
  const previous = useRef("empty");
  const [unseen, setUnseen] = useState(false);
  const [writingMode, setWritingMode] = useState(false);
  const matchingShortcuts = slashShortcuts(props.draft);
  const showShortcuts = !props.readOnly && (props.shortcutsOpen || props.draft.trimStart().startsWith("/"));
  const contentSignature = terminalViewSignature(props.terminalView);
  useEffect(() => { initial.current = true; following.current = true; previous.current = "empty"; }, [props.terminal.id]);
  useEffect(() => { const changed = contentSignature !== previous.current; previous.current = contentSignature; const next = nextFollowState({ initial: initial.current, following: following.current, contentChanged: changed }); if (next.scroll) requestAnimationFrame(() => { const element = screenRef.current; if (element) element.scrollTop = element.scrollHeight; }); if (next.unseen) setUnseen(true); else if (next.scroll) setUnseen(false); initial.current = false; }, [contentSignature]);
  useEffect(() => { const element = composerRef.current; if (!element || writingMode) return; element.style.height = "0px"; element.style.height = `${Math.min(element.scrollHeight, Math.max(120, window.innerHeight * 0.32))}px`; }, [props.draft, writingMode]);
  function jumpLatest() { const element = screenRef.current; if (element) element.scrollTop = element.scrollHeight; following.current = true; setUnseen(false); }
  function chooseShortcut(command: string) {
    props.onDraft(command);
    props.onShortcuts(false);
    requestAnimationFrame(() => composerRef.current?.focus());
  }
  function pasteImages(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const images = [...event.clipboardData.items].filter((item) => item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file)).slice(0, 4 - props.attachments.length);
    if (images.length) { event.preventDefault(); images.forEach(props.onImage); }
  }

  return (
    <div className="terminal-panel">
      <section className="terminal-window">
        {props.screenError ? <div className="terminal-error">{props.screenError}</div> : <div className={`terminal-scroll${props.fitToPhone ? " fit-phone" : ""}`} ref={screenRef} style={{ "--terminal-font-size": `${props.fontSize}px` } as React.CSSProperties} onTouchStart={() => { following.current = false; }} onScroll={(event) => { const near = isNearBottom(event.currentTarget); following.current = near; if (near) setUnseen(false); }}><TerminalGrid view={props.terminalView} hideNativeComposer={props.fitToPhone} reflow={props.fitToPhone} onMarkdownLink={props.onMarkdown} /></div>}
        {unseen && <button className="jump-latest" onClick={jumpLatest}>↓ Jump to latest</button>}
      </section>
      <div className="terminal-controls">
        {showShortcuts && (
          <div className="shortcut-palette">
            <div className="shortcut-palette-head"><strong>Agent shortcuts</strong><span>Tap to insert · send when ready</span></div>
            {matchingShortcuts.length ? <div className="shortcut-list">{matchingShortcuts.map((shortcut) => (
              <button type="button" onClick={() => chooseShortcut(shortcut.command)} key={shortcut.command}>
                <code>{shortcut.command}</code><span>{shortcut.description}</span><small>{shortcut.agents.join(" · ")}</small>
              </button>
            ))}</div> : <p className="shortcut-empty">No matching shortcut. Use <button type="button" onClick={() => chooseShortcut("/help")}>/help</button> for the active agent&apos;s full list.</p>}
          </div>
        )}
        <AttachmentStrip attachments={props.attachments} className="" onRemove={props.onRemoveImage} />
        <form className="composer compact-composer" onSubmit={props.onSubmit}><input ref={imageInputRef} className="image-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={(event) => { [...(event.currentTarget.files || [])].slice(0, 4 - props.attachments.length).forEach(props.onImage); event.currentTarget.value = ""; }} /><button type="button" className="attach-button" aria-label="Attach an image" disabled={props.readOnly || props.sending || props.attachments.length >= 4} onClick={() => imageInputRef.current?.click()}>＋</button><div className="composer-editor"><textarea ref={composerRef} aria-label="Terminal input" placeholder={props.readOnly ? "Allow input to write a message" : "Message…"} value={props.draft} onChange={(event) => props.onDraft(event.target.value)} onPaste={pasteImages} disabled={props.readOnly || props.sending} rows={1} /><button type="button" className="expand-writer" aria-label="Open large writing area" disabled={props.readOnly} onClick={() => setWritingMode(true)}>↗</button></div><button aria-label="Send now" disabled={props.readOnly || props.sending || (!props.draft.trim() && props.attachments.length === 0)}>{props.sending ? "…" : "↑"}</button></form>
      </div>
      {writingMode && <form className="writing-mode" onSubmit={(event) => { setWritingMode(false); props.onSubmit(event); }}><header><button type="button" onClick={() => setWritingMode(false)}>Done</button><strong>Write message</strong><button disabled={props.sending || (!props.draft.trim() && props.attachments.length === 0)}>{props.sending ? "…" : "Send"}</button></header><textarea autoFocus aria-label="Expanded terminal input" value={props.draft} onChange={(event) => props.onDraft(event.target.value)} onPaste={pasteImages} placeholder="Write your full message…" /><footer><button type="button" onClick={() => imageInputRef.current?.click()}>＋ Image</button><span>{props.draft.length.toLocaleString()} characters</span></footer></form>}
    </div>
  );
}

function HealthPanel({ workspace, terminal, onChanged, onNotice }: { workspace: Workspace; terminal: Terminal; onChanged: () => void; onNotice: (message: string) => void }) {
  const { value: overview, error, refresh: load } = useOwnedRead<Overview | null>(`/api/workspaces/${workspace.id}/overview`, null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { const kickoff = setTimeout(load, 0); const poll = setInterval(load, 10_000); return () => { clearTimeout(kickoff); clearInterval(poll); }; }, [load]);
  async function mutate(path: string, body = "{}") { setBusy(true); try { await api(path, { method: "POST", body }); await load(true); await onChanged(); } catch (error) { onNotice(error instanceof Error ? error.message : "Action failed"); } finally { setBusy(false); } }
  if (error) return <div className="detail-loading" role="alert">{error}</div>;
  if (!overview) return <div className="detail-loading">Reading session health…</div>; const progress = overview.todos.progress; const state = overview.status.effective || overview.status.inferred || "ready";
  return <section className="health-page"><div className="health-hero"><span className={`status-orb ${state === "working" ? "working" : state === "done" ? "done" : "ready"}`} /><div><p>Session state</p><h2>{state}</h2><span>{overview.status.signals?.any_agent_needs_input ? "Agent is waiting for input" : overview.status.signals?.is_git_dirty ? "Working tree has changes" : "No blockers reported"}</span></div></div><div className="metric-grid"><div><span>CPU</span><strong>{overview.metrics?.cpuPercent.toFixed(1) || "0"}%</strong></div><div><span>Memory</span><strong>{formatBytes(overview.metrics?.memoryBytes)}</strong></div><div><span>Processes</span><strong>{overview.metrics?.processCount || 0}</strong></div></div><div className="health-section"><div className="section-heading"><div><h2>Agent tasks</h2><p>{progress.completed} of {progress.total} complete</p></div><span>{progress.total ? Math.round(progress.completed / progress.total * 100) : 0}%</span></div><div className="progress-track"><i style={{ width: `${progress.total ? progress.completed / progress.total * 100 : 0}%` }} /></div>{overview.todos.items.length === 0 ? <p className="muted empty-line">No structured tasks in this workspace.</p> : <div className="todo-list">{overview.todos.items.map((todo) => <button disabled={busy} key={todo.id} onClick={() => mutate(`/api/workspaces/${workspace.id}/todos/${todo.id}/${todo.state === "completed" ? "uncheck" : "check"}`)}><i className={todo.state}>{todo.state === "completed" ? "✓" : todo.state === "in-progress" ? "◐" : ""}</i><span>{todo.text}</span></button>)}</div>}</div><div className="health-section recovery"><h2>Recovery</h2><p>Restart the current terminal shell if it is stuck. Your workspace and other terminals stay open.</p><button disabled={busy} onClick={() => mutate(`/api/workspaces/${workspace.id}/respawn`, JSON.stringify({ surfaceId: terminal.id }))}>Restart current terminal</button><button className="danger-button" disabled={busy} onClick={() => { if (confirm(`Close “${workspace.title}”?`)) mutate(`/api/workspaces/${workspace.id}/close`); }}>Close workspace</button></div></section>;
}

function ChangesPanel({ repo, onMarkdown }: { repo: Repo | null; onMarkdown: (path: string) => void }) {
  const [changes, setChanges] = useState<Changes | null>(null); const [selected, setSelected] = useState<ChangedFile | null>(null); const [patch, setPatch] = useState(""); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const load = useCallback(async () => { if (!repo) return; setLoading(true); try { setChanges(await api<Changes>(`/api/repos/${repo.id}/changes`)); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "Changes unavailable"); } finally { setLoading(false); } }, [repo]);
  useEffect(() => { const timer = setTimeout(load, 0); return () => clearTimeout(timer); }, [load]);
  async function openFile(file: ChangedFile, staged = file.area === "staged") { if (!repo) return; setSelected(file); setLoading(true); try { const result = await api<{ patch: string }>(`/api/repos/${repo.id}/diff?file=${encodeURIComponent(file.path)}&staged=${staged ? "1" : "0"}`); setPatch(result.patch || "No textual diff."); } catch (cause) { setPatch(cause instanceof Error ? cause.message : "Diff unavailable"); } finally { setLoading(false); } }
  if (!repo) return <Empty icon="⌁" title="Repository not catalogued" body="Add this project in Settings to review its changes." />; if (error) return <Empty icon="!" title="Could not read changes" body={error} />; if (selected) return <section className="diff-view"><header><button onClick={() => { setSelected(null); setPatch(""); }}>‹ Files</button><div><strong>{selected.path.split("/").pop()}</strong><span>{selected.path}</span></div>{/\.(md|markdown)$/i.test(selected.path) && <button className="read-file-button" onClick={() => onMarkdown(selected.path)}>Read</button>}</header><pre>{loading ? "Loading diff…" : patch}</pre></section>;
  return <section className="changes-page"><div className="changes-summary"><div><p className="eyebrow">{repo.branch}</p><h2>{changes?.files.length || 0} changed files</h2><span>{changes?.recentCommit ? `Latest: ${changes.recentCommit.hash} ${changes.recentCommit.subject}` : "No commits yet"}</span></div><button onClick={load}>↻</button></div>{loading && !changes ? <div className="detail-loading">Reading Git state…</div> : changes?.files.length === 0 ? <Empty icon="✓" title="Working tree clean" body="There are no staged, unstaged, or untracked changes." /> : <div className="file-list">{changes?.files.map((file) => <button key={file.path} onClick={() => openFile(file)}><span className={`file-status s-${file.status.toLowerCase()}`}>{file.status}</span><div><strong>{file.path.split("/").pop()}</strong><span>{file.path}</span></div><em>{file.areas.join(" + ")}</em><b>›</b></button>)}</div>}</section>;
}

function Empty({ icon, title, body, action }: { icon: string; title: string; body: string; action?: React.ReactNode }) { return <div className="empty-card"><span>{icon}</span><strong>{title}</strong><p>{body}</p>{action}</div>; }
function WorkspaceSkeleton() { return <div className="workspace-card skeleton"><i /><i /><i /></div>; }
function LoadingScreen() { return <main className="center-screen"><div className="brand-mark large">c</div><p>Opening companion…</p></main>; }
function PairScreen({ offline, token, error, onToken, onPair }: { offline: boolean; token: string; error: string; onToken: (value: string) => void; onPair: (event: FormEvent) => void }) { return <main className="pair-screen"><div className="pair-card"><div className="brand-mark large">c</div><p className="eyebrow">PRIVATE REMOTE ACCESS</p><h1>{offline ? "Your companion is offline." : "Pair this device."}</h1><p>{offline ? "Connect to Tailscale and reload this page." : "Enter the private pairing code shown by the installer on your Mac."}</p>{offline ? <button className="primary-button" onClick={() => location.reload()}>Try again</button> : <form onSubmit={onPair}><input type="password" autoComplete="one-time-code" value={token} onChange={(event) => onToken(event.target.value)} aria-label="Pairing code" placeholder="Pairing code" autoFocus /><button className="primary-button" disabled={!token.trim()}>Pair securely</button>{error && <p className="form-error">{error}</p>}</form>}<small>Tailscale connection required</small></div></main>; }
