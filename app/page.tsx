"use client";
/* eslint-disable jsx-a11y/no-autofocus, jsx-a11y/label-has-associated-control */

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { slashShortcuts } from "./slash-shortcuts.mjs";
import { isNearBottom, nextFollowState } from "./terminal-follow.mjs";

type Terminal = { id: string; title: string; current_directory?: string | null; is_focused?: boolean; is_ready?: boolean };
type WorkspaceStatus = { effective?: string; inferred?: string; signals?: Record<string, boolean> };
type Workspace = { id: string; title: string; current_directory?: string | null; has_unread?: boolean; is_selected?: boolean; last_activity_at?: number; preview?: string | null; terminals: Terminal[]; status?: WorkspaceStatus | null };
type Bootstrap = { connected: boolean; host: { mac_display_name?: string; workspace_count?: number } | null; workspaces: Workspace[]; error: string | null; refreshedAt: string };
type Repo = { id: string; name: string; root: string; path: string; branch: string; ahead: number; behind: number; changedFiles: number; dirty: boolean; lastActivity: number; scripts: string[] };
type InboxItem = { id: string; requestId?: string; type: "request" | "notification"; kind: string; workspaceId?: string | null; surfaceId?: string | null; title: string; subtitle?: string | null; body?: string; toolName?: string | null; toolInput?: unknown; questionOptions?: Array<string | { label?: string; value?: string }> };
type Inbox = { items: InboxItem[]; actionableCount: number; unreadCount: number };
type Todo = { id: string; text: string; state: string; origin?: string };
type Overview = { status: WorkspaceStatus; todos: { items: Todo[]; progress: { completed: number; total: number; first_unchecked_text?: string | null } }; metrics: { cpuPercent: number; memoryBytes: number; processCount: number } | null; surfaceHealth: { surfaces?: Array<{ id: string; type: string; in_window: boolean }> } | null };
type ChangedFile = { path: string; status: string; area: string; areas: string[] };
type Changes = { repo: Repo; files: ChangedFile[]; summary: { staged: string; unstaged: string }; recentCommit?: { hash: string; subject: string } | null };
type PullRequest = { number: number; title: string; url: string; state: string; isDraft: boolean; reviewDecision: string; mergeState: string; headBranch: string; baseBranch: string; updatedAt?: string | null; author?: string | null; checks: { passed: number; failed: number; pending: number; total: number } };
type View = "sessions" | "inbox" | "launch" | "settings";
type DetailTab = "terminal" | "tasks" | "changes";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

function compactPath(path?: string | null) { return path ? path.replace(/^\/Users\/[^/]+/, "~") : "Directory unavailable"; }
function relativeTime(timestamp?: number) { if (!timestamp) return "now"; const seconds = Math.max(0, Math.round(Date.now() / 1000 - timestamp)); if (seconds < 60) return "now"; if (seconds < 3600) return `${Math.floor(seconds / 60)}m`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`; return `${Math.floor(seconds / 86400)}d`; }
function sessionState(workspace: Workspace) { if (workspace.has_unread || workspace.status?.signals?.any_agent_needs_input) return { label: "Needs you", tone: "attention" }; if (workspace.status?.effective === "working" || workspace.status?.signals?.any_agent_running) return { label: "Working", tone: "working" }; if (workspace.status?.effective === "done") return { label: "Done", tone: "done" }; return { label: "Ready", tone: "ready" }; }
function formatBytes(bytes = 0) { if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`; if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`; return `${(bytes / 1024 ** 3).toFixed(1)} GB`; }

export default function Home() {
  const [auth, setAuth] = useState<"loading" | "paired" | "unpaired" | "offline">("loading");
  const [pairingToken, setPairingToken] = useState(""); const [pairingError, setPairingError] = useState("");
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null); const [inbox, setInbox] = useState<Inbox>({ items: [], actionableCount: 0, unreadCount: 0 }); const [repos, setRepos] = useState<Repo[]>([]);
  const [view, setView] = useState<View>(() => { if (typeof window === "undefined") return "sessions"; const value = new URLSearchParams(location.search).get("view"); return value === "inbox" || value === "launch" || value === "settings" ? value : "sessions"; }); const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(() => typeof window === "undefined" ? null : new URLSearchParams(location.search).get("workspace")); const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(null); const [detailTab, setDetailTab] = useState<DetailTab>("terminal");
  const [screen, setScreen] = useState(""); const [screenError, setScreenError] = useState(""); const [draft, setDraft] = useState(""); const [sending, setSending] = useState(false); const [live, setLive] = useState(false); const [notice, setNotice] = useState("");
  const [readOnly, setReadOnly] = useState(() => typeof window === "undefined" || localStorage.getItem("cmux-companion-read-only") !== "false");
  const [installPrompt, setInstallPrompt] = useState<(Event & { prompt?: () => Promise<void> }) | null>(null); const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedWorkspace = useMemo(() => bootstrap?.workspaces.find((workspace) => workspace.id === selectedWorkspaceId) || null, [bootstrap, selectedWorkspaceId]);
  const selectedTerminal = selectedWorkspace?.terminals.find((terminal) => terminal.id === selectedTerminalId) || selectedWorkspace?.terminals[0] || null;
  const selectedRepo = useMemo(() => { const directory = selectedWorkspace?.current_directory || selectedTerminal?.current_directory; if (!directory) return null; return repos.find((repo) => directory === repo.path || directory.startsWith(`${repo.path}/`)) || null; }, [repos, selectedTerminal, selectedWorkspace]);

  const loadBootstrap = useCallback(async () => { try { const data = await api<Bootstrap>("/api/bootstrap"); setBootstrap(data); setAuth("paired"); return data; } catch (error) { if (error instanceof Error && error.message.includes("Pair")) setAuth("unpaired"); setBootstrap((current) => current ? { ...current, connected: false, error: "Waiting for cmux" } : null); return null; } }, []);
  const loadInbox = useCallback(async () => { try { setInbox(await api<Inbox>("/api/inbox")); } catch { /* cmux reconnects independently */ } }, []);
  const loadRepos = useCallback(async () => { try { setRepos((await api<{ repos: Repo[] }>("/api/repos")).repos); } catch { /* retry later */ } }, []);

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    const onInstall = (event: Event) => { event.preventDefault(); setInstallPrompt(event as Event & { prompt?: () => Promise<void> }); };
    window.addEventListener("beforeinstallprompt", onInstall);
    api<{ paired: boolean }>("/api/auth/status").then((status) => setAuth(status.paired ? "paired" : "unpaired")).catch(() => setAuth("offline"));
    return () => window.removeEventListener("beforeinstallprompt", onInstall);
  }, []);

  useEffect(() => {
    if (auth !== "paired") return;
    let stopped = false; let socket: WebSocket | null = null; let retry: ReturnType<typeof setTimeout> | null = null; let attempt = 0;
    const refresh = () => { loadBootstrap(); loadInbox(); };
    const connect = () => { if (stopped) return; const protocol = location.protocol === "https:" ? "wss:" : "ws:"; socket = new WebSocket(`${protocol}//${location.host}/api/events`); socket.onopen = () => { attempt = 0; setLive(true); }; socket.onmessage = (message) => { try { const event = JSON.parse(message.data); if (event.type === "cmux:event") { if (refreshTimer.current) clearTimeout(refreshTimer.current); refreshTimer.current = setTimeout(refresh, 300); } } catch { /* malformed event */ } }; socket.onclose = () => { setLive(false); if (!stopped) retry = setTimeout(connect, Math.min(30_000, 800 * (2 ** attempt++))); }; };
    const kickoff = setTimeout(() => { refresh(); loadRepos(); connect(); }, 0); const poll = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 8_000);
    return () => { stopped = true; clearTimeout(kickoff); clearInterval(poll); if (retry) clearTimeout(retry); if (refreshTimer.current) clearTimeout(refreshTimer.current); socket?.close(); };
  }, [auth, loadBootstrap, loadInbox, loadRepos]);

  const loadScreen = useCallback(async () => { if (!selectedTerminal) return; try { const result = await api<{ text: string }>(`/api/terminals/${selectedTerminal.id}/screen?lines=600`); setScreen(result.text || "No terminal output yet."); setScreenError(""); } catch (error) { setScreenError(error instanceof Error ? error.message : "Unable to read this terminal"); } }, [selectedTerminal]);
  useEffect(() => { if (!selectedTerminal || detailTab !== "terminal") return; const kickoff = setTimeout(loadScreen, 0); const poll = setInterval(() => { if (document.visibilityState === "visible") loadScreen(); }, 1_500); return () => { clearTimeout(kickoff); clearInterval(poll); }; }, [selectedTerminal, detailTab, loadScreen]);

  async function pair(event: FormEvent) { event.preventDefault(); setPairingError(""); try { await api("/api/auth/pair", { method: "POST", body: JSON.stringify({ token: pairingToken.trim() }) }); setPairingToken(""); setAuth("paired"); } catch (error) { setPairingError(error instanceof Error ? error.message : "Pairing failed"); } }
  function openWorkspace(workspace: Workspace, tab: DetailTab = "terminal") { setSelectedWorkspaceId(workspace.id); setSelectedTerminalId(workspace.terminals.find((terminal) => terminal.is_focused)?.id || workspace.terminals[0]?.id || null); setDetailTab(tab); history.replaceState(null, "", `/?workspace=${encodeURIComponent(workspace.id)}`); }
  function closeWorkspaceView() { setSelectedWorkspaceId(null); setSelectedTerminalId(null); setScreen(""); history.replaceState(null, "", `/?view=${view}`); }
  async function sendPrompt(event: FormEvent) { event.preventDefault(); if (!selectedTerminal || !draft.trim() || readOnly) return; setSending(true); try { await api(`/api/terminals/${selectedTerminal.id}/input`, { method: "POST", body: JSON.stringify({ text: draft, enter: true }) }); setDraft(""); setTimeout(loadScreen, 200); } catch (error) { setNotice(error instanceof Error ? error.message : "Could not send input"); } finally { setSending(false); } }
  async function sendKey(key: string) { if (!selectedTerminal || readOnly) return; setSending(true); try { await api(`/api/terminals/${selectedTerminal.id}/key`, { method: "POST", body: JSON.stringify({ key }) }); setTimeout(loadScreen, 150); } catch (error) { setNotice(error instanceof Error ? error.message : "Could not send key"); } finally { setSending(false); } }
  function changeReadOnly(value: boolean) { setReadOnly(value); localStorage.setItem("cmux-companion-read-only", String(value)); }
  function changeView(next: View) { setView(next); history.replaceState(null, "", `/?view=${next}`); }

  if (auth === "loading") return <LoadingScreen />;
  if (auth === "unpaired" || auth === "offline") return <PairScreen offline={auth === "offline"} token={pairingToken} error={pairingError} onToken={setPairingToken} onPair={pair} />;
  if (selectedWorkspace && selectedTerminal) return <WorkspaceDetail workspace={selectedWorkspace} terminal={selectedTerminal} repo={selectedRepo} tab={detailTab} screen={screen} screenError={screenError} draft={draft} sending={sending} readOnly={readOnly} onBack={closeWorkspaceView} onTab={setDetailTab} onTerminal={setSelectedTerminalId} onDraft={setDraft} onSubmit={sendPrompt} onKey={sendKey} onReadOnly={() => changeReadOnly(!readOnly)} onRefresh={loadScreen} onChanged={async () => { await loadBootstrap(); }} onNotice={setNotice} />;

  return <main className="app-shell"><AppHeader connected={Boolean(bootstrap?.connected)} live={live} device={bootstrap?.host?.mac_display_name || "Your Mac"} />{notice && <button className="toast" onClick={() => setNotice("")}>{notice}<span>×</span></button>}
    {view === "sessions" && <SessionsView bootstrap={bootstrap} onOpen={openWorkspace} onLaunch={() => changeView("launch")} onRefresh={loadBootstrap} />}
    {view === "inbox" && <InboxView inbox={inbox} workspaces={bootstrap?.workspaces || []} onReload={loadInbox} onOpen={(id) => { const workspace = bootstrap?.workspaces.find((item) => item.id === id); if (workspace) openWorkspace(workspace); }} onNotice={setNotice} />}
    {view === "launch" && <LaunchView repos={repos} onReload={loadRepos} onLaunched={async (id) => { const data = await loadBootstrap(); const workspace = data?.workspaces.find((item) => item.id === id); if (workspace) openWorkspace(workspace); else { setView("sessions"); setNotice("Workspace launched. It will appear in a moment."); } }} />}
    {view === "settings" && <SettingsView bootstrap={bootstrap} readOnly={readOnly} installable={Boolean(installPrompt)} onReadOnly={changeReadOnly} onInstall={() => installPrompt?.prompt?.()} onNotice={setNotice} onLogout={async () => { await api("/api/auth/logout", { method: "POST", body: "{}" }); setAuth("unpaired"); }} />}
    <BottomNav view={view} onView={changeView} attention={inbox.actionableCount + inbox.unreadCount} /></main>;
}

function AppHeader({ connected, live, device }: { connected: boolean; live: boolean; device: string }) { return <header className="topbar"><div className="brand-mark">c</div><div className="brand-copy"><strong>cmux companion</strong><span><i className={`connection-dot ${connected ? "" : "offline"}`} />{connected ? device : "Waiting for cmux"}</span></div><span className={`live-badge ${live ? "" : "sync"}`}>{live ? "LIVE" : "SYNC"}</span></header>; }

function SessionsView({ bootstrap, onOpen, onLaunch, onRefresh }: { bootstrap: Bootstrap | null; onOpen: (workspace: Workspace) => void; onLaunch: () => void; onRefresh: () => void }) {
  const workspaces = bootstrap?.workspaces || []; const needsYou = workspaces.filter((item) => sessionState(item).tone === "attention").length; const working = workspaces.filter((item) => sessionState(item).tone === "working").length;
  return <><section className="hero"><p className="eyebrow">PRIVATE · TAILSCALE</p><h1>{needsYou ? `${needsYou} session${needsYou > 1 ? "s" : ""} need you.` : working ? "Your agents are moving." : "Ready when you are."}</h1><p>Review, unblock, and launch coding work from anywhere on your private network.</p><div className="summary-row"><div><strong>{workspaces.length}</strong><span>sessions</span></div><div><strong className="accent-number">{needsYou}</strong><span>needs you</span></div><div><strong>{working}</strong><span>working</span></div></div></section><section className="content-section"><div className="section-heading"><h2>Sessions</h2><div><button className="text-button" onClick={onRefresh}>Refresh</button><button className="primary-small" onClick={onLaunch}>＋ New</button></div></div>{!bootstrap && <WorkspaceSkeleton />}{bootstrap && workspaces.length === 0 && <Empty icon="⌁" title="No sessions yet" body="Launch a repository here or open a workspace on your Mac." action={<button className="primary-button" onClick={onLaunch}>Launch a workspace</button>} />}<div className="workspace-list">{workspaces.map((workspace) => { const state = sessionState(workspace); const terminal = workspace.terminals.find((item) => item.is_focused) || workspace.terminals[0]; return <button className="workspace-card" key={workspace.id} onClick={() => onOpen(workspace)}><div className="workspace-card-head"><span className={`status-orb ${state.tone}`} /><div><strong>{workspace.title || "Untitled workspace"}</strong><span>{compactPath(workspace.current_directory || terminal?.current_directory)}</span></div><time>{relativeTime(workspace.last_activity_at)}</time></div><p>{workspace.preview || terminal?.title || "Terminal ready"}</p><div className="card-foot"><span className={`state-pill ${state.tone}`}>{state.label}</span><span>{workspace.terminals.length} terminal{workspace.terminals.length === 1 ? "" : "s"}</span><b>Open ›</b></div></button>; })}</div></section></>;
}

function InboxView({ inbox, workspaces, onReload, onOpen, onNotice }: { inbox: Inbox; workspaces: Workspace[]; onReload: () => void; onOpen: (id: string) => void; onNotice: (message: string) => void }) {
  const [busy, setBusy] = useState("");
  async function reply(item: InboxItem, body: Record<string, unknown>) {
    if (item.kind === "question" && Array.isArray(body.selections) && body.selections[0] === "Write reply…") {
      const answer = window.prompt("Reply to the agent");
      if (!answer?.trim()) return;
      body = { selections: [answer.trim()] };
    }
    if (item.kind === "exitPlan" && body.mode === "deny") {
      body = { ...body, feedback: window.prompt("Optional feedback for the agent")?.trim() || "" };
    }
    setBusy(item.id);
    try { await api(`/api/inbox/${item.requestId}/reply`, { method: "POST", body: JSON.stringify({ kind: item.kind, ...body }) }); await onReload(); }
    catch (error) { onNotice(error instanceof Error ? error.message : "Could not reply"); }
    finally { setBusy(""); }
  }
  async function markRead(item: InboxItem) { setBusy(item.id); try { await api(`/api/notifications/${item.id}/read`, { method: "POST", body: "{}" }); await onReload(); } catch (error) { onNotice(error instanceof Error ? error.message : "Could not mark as read"); } finally { setBusy(""); } }
  return <section className="subpage"><div className="page-kicker"><div><p className="eyebrow">ACTION QUEUE</p><h1>Inbox</h1></div><button className="text-button" onClick={onReload}>Refresh</button></div><p className="subpage-intro">Only decisions and meaningful agent notifications—no tool-call noise.</p>{inbox.items.length === 0 && <Empty icon="✓" title="All clear" body="Your agents are not waiting on anything." />}<div className="inbox-list">{inbox.items.map((item) => <article className="inbox-card" key={item.id}><div className="inbox-head"><span className={`inbox-kind ${item.kind}`}>{item.kind === "permissionRequest" ? "Permission" : item.kind === "question" ? "Question" : item.kind === "exitPlan" ? "Plan" : "Update"}</span>{item.workspaceId && <button onClick={() => onOpen(item.workspaceId!)}>{workspaces.find((workspace) => workspace.id === item.workspaceId)?.title || "Open session"} ›</button>}</div><h2>{item.title}</h2>{item.subtitle && <p className="muted">{item.subtitle}</p>}{item.body && <p>{item.body}</p>}{item.toolName && <div className="tool-preview"><strong>{item.toolName}</strong>{item.toolInput && <pre>{typeof item.toolInput === "string" ? item.toolInput : JSON.stringify(item.toolInput, null, 2)}</pre>}</div>}<div className="action-row">{item.kind === "permissionRequest" && <><button className="approve" disabled={busy === item.id} onClick={() => reply(item, { mode: "once" })}>Approve once</button><button className="deny" disabled={busy === item.id} onClick={() => reply(item, { mode: "deny" })}>Deny</button></>}{item.kind === "question" && questionLabels(item).map((label) => <button className="approve" disabled={busy === item.id} key={label} onClick={() => reply(item, { selections: [label] })}>{label}</button>)}{item.kind === "exitPlan" && <><button className="approve" disabled={busy === item.id} onClick={() => reply(item, { mode: "manual" })}>Approve</button><button disabled={busy === item.id} onClick={() => reply(item, { mode: "autoAccept" })}>Auto accept</button><button className="deny" disabled={busy === item.id} onClick={() => reply(item, { mode: "deny" })}>Deny</button></>}{item.type === "notification" && <button disabled={busy === item.id} onClick={() => markRead(item)}>Mark read</button>}</div></article>)}</div></section>;
}
function questionLabels(item: InboxItem) { const labels = (item.questionOptions || []).map((option) => typeof option === "string" ? option : option.label || option.value || "").filter(Boolean).slice(0, 8); return labels.length ? labels : ["Write reply…"]; }

function LaunchView({ repos, onReload, onLaunched }: { repos: Repo[]; onReload: () => void; onLaunched: (id: string) => void }) {
  const [query, setQuery] = useState(""); const [selected, setSelected] = useState<Repo | null>(null); const [agent, setAgent] = useState("codex"); const [prompt, setPrompt] = useState(""); const [script, setScript] = useState(""); const [title, setTitle] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const filtered = repos.filter((repo) => `${repo.name} ${repo.root} ${repo.branch}`.toLowerCase().includes(query.toLowerCase())).slice(0, 40);
  async function launch(event: FormEvent) { event.preventDefault(); if (!selected) return; setBusy(true); setError(""); try { const result = await api<{ workspace: { workspace_id: string } }>("/api/workspaces", { method: "POST", body: JSON.stringify({ repoId: selected.id, title: title || selected.name, agent: script ? "shell" : agent, prompt, script: script || null }) }); onLaunched(result.workspace.workspace_id); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not launch workspace"); } finally { setBusy(false); } }
  return <section className="subpage launch-page"><div className="page-kicker"><div><p className="eyebrow">REPO LAUNCHPAD</p><h1>Start work</h1></div><button className="text-button" onClick={onReload}>Rescan</button></div><p className="subpage-intro">Open an approved local repository directly in a fresh cmux workspace.</p>{!selected ? <><label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a repository…" autoFocus /></label><div className="repo-list">{filtered.map((repo) => <button key={repo.id} onClick={() => { setSelected(repo); setTitle(repo.name); }}><span className="repo-icon">{repo.name.slice(0, 1).toUpperCase()}</span><div><strong>{repo.name}</strong><span>{repo.root} · {repo.branch}</span></div>{repo.dirty && <em>{repo.changedFiles} changed</em>}<b>›</b></button>)}</div></> : <form className="launch-form" onSubmit={launch}><button type="button" className="inline-back" onClick={() => setSelected(null)}>‹ Choose another repo</button><div className="selected-repo"><span className="repo-icon">{selected.name.slice(0, 1).toUpperCase()}</span><div><strong>{selected.name}</strong><span>{compactPath(selected.path)} · {selected.branch}</span></div></div><label>Workspace name<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} /></label><fieldset><legend>Start with</legend>{["codex", "claude", "shell"].map((value) => <button type="button" className={agent === value && !script ? "selected" : ""} onClick={() => { setAgent(value); setScript(""); }} key={value}>{value === "codex" ? "Codex" : value === "claude" ? "Claude" : "Shell"}</button>)}</fieldset>{selected.scripts.length > 0 && <label>Or run package script<select value={script} onChange={(event) => setScript(event.target.value)}><option value="">No script</option>{selected.scripts.map((value) => <option key={value} value={value}>npm run {value}</option>)}</select></label>}{!script && agent !== "shell" && <label>Initial task<textarea rows={5} value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={8000} placeholder="Describe the outcome you want…" /></label>}{error && <p className="form-error">{error}</p>}<button className="primary-button" disabled={busy}>{busy ? "Launching…" : `Launch ${script ? "script" : agent}`}</button></form>}</section>;
}

function WorkspaceDetail(props: { workspace: Workspace; terminal: Terminal; repo: Repo | null; tab: DetailTab; screen: string; screenError: string; draft: string; sending: boolean; readOnly: boolean; onBack: () => void; onTab: (tab: DetailTab) => void; onTerminal: (id: string) => void; onDraft: (value: string) => void; onSubmit: (event: FormEvent) => void; onKey: (key: string) => void; onReadOnly: () => void; onRefresh: () => void; onChanged: () => void; onNotice: (message: string) => void }) {
  return (
    <main className="detail-shell">
      <header className="detail-header"><button className="back-button" onClick={props.onBack}>‹ <span>Back</span></button><div><strong>{props.workspace.title}</strong><span>{compactPath(props.workspace.current_directory)}</span></div><span className={`status-orb ${sessionState(props.workspace).tone}`} /></header>
      <nav className="detail-tabs">{(["terminal", "tasks", "changes"] as DetailTab[]).map((tab) => <button className={props.tab === tab ? "active" : ""} onClick={() => props.onTab(tab)} key={tab}>{tab === "tasks" ? "Tasks & health" : tab[0].toUpperCase() + tab.slice(1)}</button>)}</nav>
      <PullRequestBanner repo={props.repo} />
      {props.tab === "terminal" && <TerminalPanel {...props} />}
      {props.tab === "tasks" && <HealthPanel workspace={props.workspace} terminal={props.terminal} onChanged={props.onChanged} onNotice={props.onNotice} />}
      {props.tab === "changes" && <ChangesPanel repo={props.repo} />}
    </main>
  );
}

function PullRequestBanner({ repo }: { repo: Repo | null }) {
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

function TerminalPanel(props: { workspace: Workspace; terminal: Terminal; screen: string; screenError: string; draft: string; sending: boolean; readOnly: boolean; onTerminal: (id: string) => void; onDraft: (value: string) => void; onSubmit: (event: FormEvent) => void; onKey: (key: string) => void; onReadOnly: () => void; onRefresh: () => void }) {
  const screenRef = useRef<HTMLPreElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const initial = useRef(true);
  const following = useRef(true);
  const previous = useRef("");
  const [unseen, setUnseen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const matchingShortcuts = slashShortcuts(props.draft);
  const showShortcuts = !props.readOnly && (shortcutsOpen || props.draft.trimStart().startsWith("/"));
  useEffect(() => { initial.current = true; following.current = true; previous.current = ""; }, [props.terminal.id]);
  useEffect(() => { const changed = props.screen !== previous.current; previous.current = props.screen; const next = nextFollowState({ initial: initial.current, following: following.current, contentChanged: changed }); if (next.scroll) requestAnimationFrame(() => { const element = screenRef.current; if (element) element.scrollTop = element.scrollHeight; }); if (next.unseen) setUnseen(true); else if (next.scroll) setUnseen(false); initial.current = false; }, [props.screen]);
  function jumpLatest() { const element = screenRef.current; if (element) element.scrollTop = element.scrollHeight; following.current = true; setUnseen(false); }
  function chooseShortcut(command: string) {
    props.onDraft(command);
    setShortcutsOpen(false);
    requestAnimationFrame(() => composerRef.current?.focus());
  }
  return (
    <div className="terminal-panel">
      {props.workspace.terminals.length > 1 && <div className="terminal-tabs">{props.workspace.terminals.map((terminal, index) => <button className={terminal.id === props.terminal.id ? "active" : ""} onClick={() => props.onTerminal(terminal.id)} key={terminal.id}>{index + 1}. {terminal.title}</button>)}</div>}
      <section className="terminal-window">
        <div className="terminal-chrome"><div><span /><span /><span /></div><p>{props.terminal.title}</p><button onClick={props.onRefresh}>↻</button></div>
        {props.screenError ? <div className="terminal-error">{props.screenError}</div> : <pre ref={screenRef} onScroll={(event) => { const near = isNearBottom(event.currentTarget); following.current = near; if (near) setUnseen(false); }}>{props.screen || "Reading terminal…"}</pre>}
        {unseen && <button className="jump-latest" onClick={jumpLatest}>↓ Jump to latest</button>}
      </section>
      <div className="terminal-controls">
        <div className="control-head">
          <button className={`lock-button ${props.readOnly ? "" : "unlocked"}`} onClick={props.onReadOnly}>{props.readOnly ? "🔒 Read only" : "🔓 Input enabled"}</button>
          <button className={`shortcut-toggle ${showShortcuts ? "active" : ""}`} disabled={props.readOnly} onClick={() => setShortcutsOpen((current) => !current)} aria-expanded={showShortcuts}>／ Shortcuts</button>
        </div>
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
        <div className="quick-keys">{[["Esc", "escape"], ["Tab", "tab"], ["↑", "up"], ["↓", "down"], ["Ctrl-C", "ctrl+c"], ["Enter", "enter"]].map(([label, key]) => <button disabled={props.readOnly || props.sending} onClick={() => props.onKey(key)} key={key}>{label}</button>)}</div>
        <form className="composer" onSubmit={props.onSubmit}><textarea ref={composerRef} aria-label="Terminal input" placeholder={props.readOnly ? "Unlock input to interact…" : "Reply, or type / for shortcuts…"} value={props.draft} onChange={(event) => props.onDraft(event.target.value)} disabled={props.readOnly || props.sending} rows={2} /><button disabled={props.readOnly || props.sending || !props.draft.trim()}>{props.sending ? "…" : "↑"}</button></form>
      </div>
    </div>
  );
}

function HealthPanel({ workspace, terminal, onChanged, onNotice }: { workspace: Workspace; terminal: Terminal; onChanged: () => void; onNotice: (message: string) => void }) {
  const [overview, setOverview] = useState<Overview | null>(null); const [busy, setBusy] = useState(false); const load = useCallback(async () => { try { setOverview(await api<Overview>(`/api/workspaces/${workspace.id}/overview`)); } catch (error) { onNotice(error instanceof Error ? error.message : "Health unavailable"); } }, [workspace.id, onNotice]);
  useEffect(() => { const kickoff = setTimeout(load, 0); const poll = setInterval(load, 10_000); return () => { clearTimeout(kickoff); clearInterval(poll); }; }, [load]);
  async function mutate(path: string, body = "{}") { setBusy(true); try { await api(path, { method: "POST", body }); await load(); await onChanged(); } catch (error) { onNotice(error instanceof Error ? error.message : "Action failed"); } finally { setBusy(false); } }
  if (!overview) return <div className="detail-loading">Reading session health…</div>; const progress = overview.todos.progress; const state = overview.status.effective || overview.status.inferred || "ready";
  return <section className="health-page"><div className="health-hero"><span className={`status-orb ${state === "working" ? "working" : state === "done" ? "done" : "ready"}`} /><div><p>Session state</p><h2>{state}</h2><span>{overview.status.signals?.any_agent_needs_input ? "Agent is waiting for input" : overview.status.signals?.is_git_dirty ? "Working tree has changes" : "No blockers reported"}</span></div></div><div className="metric-grid"><div><span>CPU</span><strong>{overview.metrics?.cpuPercent.toFixed(1) || "0"}%</strong></div><div><span>Memory</span><strong>{formatBytes(overview.metrics?.memoryBytes)}</strong></div><div><span>Processes</span><strong>{overview.metrics?.processCount || 0}</strong></div></div><div className="health-section"><div className="section-heading"><div><h2>Agent tasks</h2><p>{progress.completed} of {progress.total} complete</p></div><span>{progress.total ? Math.round(progress.completed / progress.total * 100) : 0}%</span></div><div className="progress-track"><i style={{ width: `${progress.total ? progress.completed / progress.total * 100 : 0}%` }} /></div>{overview.todos.items.length === 0 ? <p className="muted empty-line">No structured tasks in this workspace.</p> : <div className="todo-list">{overview.todos.items.map((todo) => <button disabled={busy} key={todo.id} onClick={() => mutate(`/api/workspaces/${workspace.id}/todos/${todo.id}/${todo.state === "completed" ? "uncheck" : "check"}`)}><i className={todo.state}>{todo.state === "completed" ? "✓" : todo.state === "in-progress" ? "◐" : ""}</i><span>{todo.text}</span></button>)}</div>}</div><div className="health-section recovery"><h2>Recovery</h2><p>Restart the current terminal shell if it is stuck. Your workspace and other terminals stay open.</p><button disabled={busy} onClick={() => mutate(`/api/workspaces/${workspace.id}/respawn`, JSON.stringify({ surfaceId: terminal.id }))}>Restart current terminal</button><button className="danger-button" disabled={busy} onClick={() => { if (confirm(`Close “${workspace.title}”?`)) mutate(`/api/workspaces/${workspace.id}/close`); }}>Close workspace</button></div></section>;
}

function ChangesPanel({ repo }: { repo: Repo | null }) {
  const [changes, setChanges] = useState<Changes | null>(null); const [selected, setSelected] = useState<ChangedFile | null>(null); const [patch, setPatch] = useState(""); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const load = useCallback(async () => { if (!repo) return; setLoading(true); try { setChanges(await api<Changes>(`/api/repos/${repo.id}/changes`)); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "Changes unavailable"); } finally { setLoading(false); } }, [repo]);
  useEffect(() => { const timer = setTimeout(load, 0); return () => clearTimeout(timer); }, [load]);
  async function openFile(file: ChangedFile, staged = file.area === "staged") { if (!repo) return; setSelected(file); setLoading(true); try { const result = await api<{ patch: string }>(`/api/repos/${repo.id}/diff?file=${encodeURIComponent(file.path)}&staged=${staged ? "1" : "0"}`); setPatch(result.patch || "No textual diff."); } catch (cause) { setPatch(cause instanceof Error ? cause.message : "Diff unavailable"); } finally { setLoading(false); } }
  if (!repo) return <Empty icon="⌁" title="Repository not catalogued" body="Change review is available for projects inside the approved karven and rekord roots." />; if (error) return <Empty icon="!" title="Could not read changes" body={error} />; if (selected) return <section className="diff-view"><header><button onClick={() => { setSelected(null); setPatch(""); }}>‹ Files</button><div><strong>{selected.path.split("/").pop()}</strong><span>{selected.path}</span></div></header><pre>{loading ? "Loading diff…" : patch}</pre></section>;
  return <section className="changes-page"><div className="changes-summary"><div><p className="eyebrow">{repo.branch}</p><h2>{changes?.files.length || 0} changed files</h2><span>{changes?.recentCommit ? `Latest: ${changes.recentCommit.hash} ${changes.recentCommit.subject}` : "No commits yet"}</span></div><button onClick={load}>↻</button></div>{loading && !changes ? <div className="detail-loading">Reading Git state…</div> : changes?.files.length === 0 ? <Empty icon="✓" title="Working tree clean" body="There are no staged, unstaged, or untracked changes." /> : <div className="file-list">{changes?.files.map((file) => <button key={file.path} onClick={() => openFile(file)}><span className={`file-status s-${file.status.toLowerCase()}`}>{file.status}</span><div><strong>{file.path.split("/").pop()}</strong><span>{file.path}</span></div><em>{file.areas.join(" + ")}</em><b>›</b></button>)}</div>}</section>;
}

function SettingsView({ bootstrap, readOnly, installable, onReadOnly, onInstall, onLogout, onNotice }: { bootstrap: Bootstrap | null; readOnly: boolean; installable: boolean; onReadOnly: (value: boolean) => void; onInstall: () => void; onLogout: () => void; onNotice: (message: string) => void }) { return <section className="subpage"><p className="eyebrow">COMPANION</p><h1>Settings</h1><div className="settings-list"><div className="setting-row"><div><strong>Connection</strong><span>{bootstrap?.connected ? bootstrap.host?.mac_display_name || "Connected to cmux" : "Waiting for cmux"}</span></div><i className={bootstrap?.connected ? "good" : ""}>{bootstrap?.connected ? "Online" : "Offline"}</i></div><label className="setting-row"><div><strong>Read-only protection</strong><span>Prevent accidental terminal input</span></div><input type="checkbox" checked={readOnly} onChange={(event) => onReadOnly(event.target.checked)} /></label></div><PushSettings onNotice={onNotice} />{installable && <button className="primary-button install-button" onClick={onInstall}>Add companion to home screen</button>}<div className="privacy-note"><strong>Private by design</strong><p>The backend listens only on this Mac. Access is encrypted and routed through your Tailscale network; pairing is still required per browser.</p></div><button className="logout-button" onClick={onLogout}>Unpair this device</button></section>; }

function PushSettings({ onNotice }: { onNotice: (message: string) => void }) {
  const [subscription, setSubscription] = useState<PushSubscription | null>(null); const [status, setStatus] = useState<{ supported: boolean; publicKey?: string; subscribed: boolean; settings?: { attention: boolean; completion: boolean; hideContent: boolean } } | null>(null); const [busy, setBusy] = useState(false); const supported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const load = useCallback(async () => { if (!supported) { setStatus({ supported: false, subscribed: false }); return; } const registration = await navigator.serviceWorker.ready; const current = await registration.pushManager.getSubscription(); setSubscription(current); setStatus(await api(`/api/push/status${current ? `?endpoint=${encodeURIComponent(current.endpoint)}` : ""}`)); }, [supported]);
  useEffect(() => { const timer = setTimeout(() => load().catch(() => setStatus({ supported: false, subscribed: false })), 0); return () => clearTimeout(timer); }, [load]);
  async function enable() { setBusy(true); try { const registration = await navigator.serviceWorker.ready; const base = await api<{ publicKey: string }>("/api/push/status"); const permission = await Notification.requestPermission(); if (permission !== "granted") throw new Error("Notification permission was not granted"); const created = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(base.publicKey) }); await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: created.toJSON() }) }); setSubscription(created); await load(); onNotice("Background alerts enabled"); } catch (error) { onNotice(error instanceof Error ? error.message : "Could not enable alerts"); } finally { setBusy(false); } }
  async function disable() { if (!subscription) return; setBusy(true); try { await api("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: subscription.endpoint }) }); await subscription.unsubscribe(); setSubscription(null); await load(); } catch (error) { onNotice(error instanceof Error ? error.message : "Could not disable alerts"); } finally { setBusy(false); } }
  async function update(key: "attention" | "completion" | "hideContent", value: boolean) { if (!subscription || !status?.settings) return; const settings = { ...status.settings, [key]: value }; setStatus({ ...status, settings }); try { await api("/api/push/settings", { method: "POST", body: JSON.stringify({ endpoint: subscription.endpoint, settings }) }); } catch (error) { onNotice(error instanceof Error ? error.message : "Could not save alert settings"); await load(); } }
  const standalone = typeof window !== "undefined" && (matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone);
  return <div className="push-card"><div className="push-title"><div><strong>Background alerts</strong><span>Decisions and agent completions</span></div>{status?.subscribed ? <button disabled={busy} onClick={disable}>Disable</button> : <button className="approve" disabled={busy || !supported} onClick={enable}>Enable</button>}</div>{!supported && <p className="push-guidance">On iPhone, add this web app to your Home Screen first, then open it there to enable push alerts.</p>}{supported && !standalone && /iPhone|iPad/.test(navigator.userAgent) && <p className="push-guidance">Install to your Home Screen for reliable iPhone background alerts.</p>}{status?.subscribed && status.settings && <div className="push-options"><label><span><strong>Needs attention</strong><small>Permissions, questions, plans</small></span><input type="checkbox" checked={status.settings.attention} onChange={(event) => update("attention", event.target.checked)} /></label><label><span><strong>Agent completed</strong><small>Stop and completion events</small></span><input type="checkbox" checked={status.settings.completion} onChange={(event) => update("completion", event.target.checked)} /></label><label><span><strong>Hide details</strong><small>Use discreet notification text</small></span><input type="checkbox" checked={status.settings.hideContent} onChange={(event) => update("hideContent", event.target.checked)} /></label><button className="test-alert" onClick={async () => { const result = await api<{ sent: number }>("/api/push/test", { method: "POST", body: "{}" }); onNotice(result.sent ? "Test alert sent" : "No alert was delivered"); }}>Send test alert</button></div>}</div>;
}

function urlBase64ToBytes(value: string) { const padding = "=".repeat((4 - value.length % 4) % 4); const raw = atob((value + padding).replaceAll("-", "+").replaceAll("_", "/")); return Uint8Array.from([...raw].map((char) => char.charCodeAt(0))); }
function BottomNav({ view, onView, attention }: { view: View; onView: (view: View) => void; attention: number }) { return <nav className="bottom-nav">{[["sessions", "⌂", "Sessions"], ["inbox", "◫", "Inbox"], ["launch", "＋", "Launch"], ["settings", "⚙", "Settings"]].map(([id, icon, label]) => <button className={view === id ? "active" : ""} onClick={() => onView(id as View)} key={id}><span>{icon}{id === "inbox" && attention > 0 && <i>{attention > 9 ? "9+" : attention}</i>}</span><small>{label}</small></button>)}</nav>; }
function Empty({ icon, title, body, action }: { icon: string; title: string; body: string; action?: React.ReactNode }) { return <div className="empty-card"><span>{icon}</span><strong>{title}</strong><p>{body}</p>{action}</div>; }
function WorkspaceSkeleton() { return <div className="workspace-card skeleton"><i /><i /><i /></div>; }
function LoadingScreen() { return <main className="center-screen"><div className="brand-mark large">c</div><p>Opening companion…</p></main>; }
function PairScreen({ offline, token, error, onToken, onPair }: { offline: boolean; token: string; error: string; onToken: (value: string) => void; onPair: (event: FormEvent) => void }) { return <main className="pair-screen"><div className="pair-card"><div className="brand-mark large">c</div><p className="eyebrow">PRIVATE REMOTE ACCESS</p><h1>{offline ? "Your companion is offline." : "Pair this phone."}</h1><p>{offline ? "Connect to Tailscale and reload this page." : "Enter the private pairing code shown by the installer on your Mac."}</p>{offline ? <button className="primary-button" onClick={() => location.reload()}>Try again</button> : <form onSubmit={onPair}><input type="password" autoComplete="one-time-code" value={token} onChange={(event) => onToken(event.target.value)} placeholder="Pairing code" autoFocus /><button className="primary-button" disabled={!token.trim()}>Pair securely</button>{error && <p className="form-error">{error}</p>}</form>}<small>Tailscale connection required</small></div></main>; }
