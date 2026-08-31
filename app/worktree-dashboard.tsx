"use client";
/* eslint-disable @next/next/no-img-element */

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

type DeliveryState = { label: string; tone: "attention" | "working" | "done" | "ready" };
type WorktreeSession = { id: string; title: string; preview: string; directory?: string | null; terminalCount: number; lastActivityAt: number; provider: string; state: DeliveryState };
type PullRequest = { number: number; title: string; url: string; isDraft: boolean; reviewDecision: string; mergeState: string; checks: { passed: number; failed: number; pending: number; total: number } };
export type DashboardWorktree = { id: string; repoId: string; path: string; name: string; branch: string; head?: string | null; isPrimary: boolean; detached: boolean; locked?: string | null; prunable?: string | null; ahead: number; behind: number; changedFiles: number; dirty: boolean; lastActivity: number; pullRequest?: PullRequest | null; sessions: WorktreeSession[]; state: DeliveryState };
type DashboardRepository = { id: string; name: string; root: string; path: string; archived?: boolean; pullRequestsAvailable: boolean; summary: { worktrees: number; sessions: number; needsYou: number; working: number; dirty: number }; worktrees: DashboardWorktree[] };
type Dashboard = { generatedAt: string; summary: { repositories: number; worktrees: number; sessions: number; needsYou: number; working: number; dirty: number; pullRequests: number }; repositories: DashboardRepository[]; orphanSessions: WorktreeSession[] };
type ImageAttachment = { path: string; name: string; mime: string; size: number; preview: string };
type ProjectKey = "karven" | "rekord";
type RepositoryFilter = "active" | "inactive" | "archived";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function imageDataUrl(file: File) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Could not read that image")); reader.readAsDataURL(file); }); }
function composedPrompt(draft: string, attachments: ImageAttachment[]) { const imageLines = attachments.map((image) => `- ${image.path}`); return [draft.trim(), imageLines.length ? `Attached image${imageLines.length > 1 ? "s" : ""}:\n${imageLines.join("\n")}` : ""].filter(Boolean).join("\n\n"); }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(init?.body != null ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

function relativeTime(timestamp?: number) { if (!timestamp) return "now"; const seconds = Math.max(0, Math.round(Date.now() / 1000 - timestamp)); if (seconds < 60) return "now"; if (seconds < 3600) return `${Math.floor(seconds / 60)}m`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`; return `${Math.floor(seconds / 86400)}d`; }
function compactPath(path: string) { return path.replace(/^\/Users\/[^/]+/, "~"); }
function projectFor(rootOrPath: string): ProjectKey | null { const value = rootOrPath.toLowerCase(); if (value === "karven" || /\/karven(?:\/|$)/.test(value)) return "karven"; if (value === "rekord" || /\/rekord(?:\/|$)/.test(value)) return "rekord"; return null; }

export function WorktreeDashboardView({ onOpenWorkspace, onLaunched, onNotice }: { onOpenWorkspace: (id: string) => void; onLaunched: (id: string) => Promise<void>; onNotice: (message: string) => void }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [project, setProject] = useState<ProjectKey>("karven");
  const [repositoryFilter, setRepositoryFilter] = useState<RepositoryFilter>("active");
  const [confirmRemoval, setConfirmRemoval] = useState("");
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const [launchTarget, setLaunchTarget] = useState<{ repo: DashboardRepository; worktree: DashboardWorktree } | null>(null);
  const [createTarget, setCreateTarget] = useState<DashboardRepository | null>(null);
  const load = useCallback(async (refresh = false) => {
    try { setDashboard(await request<Dashboard>(`/api/worktree-dashboard${refresh ? "?refresh=1" : ""}`)); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Worktree dashboard unavailable"); }
  }, []);
  useEffect(() => { const kickoff = setTimeout(load, 0); const poll = setInterval(() => { if (document.visibilityState === "visible") load(); }, 10_000); return () => { clearTimeout(kickoff); clearInterval(poll); }; }, [load]);

  async function closeSession(session: WorktreeSession) {
    if (!confirm(`Close cmux session “${session.title}”?`)) return;
    setBusy(`session:${session.id}`);
    try { await request(`/api/workspaces/${session.id}/close`, { method: "POST", body: "{}" }); await load(true); onNotice(`Closed ${session.title}`); }
    catch (cause) { onNotice(cause instanceof Error ? cause.message : "Could not close session"); }
    finally { setBusy(""); }
  }

  async function removeWorktree(worktree: DashboardWorktree) {
    setBusy(`worktree:${worktree.id}`);
    setActionError(null);
    try { await request(`/api/worktree-dashboard/${worktree.id}`, { method: "DELETE" }); setConfirmRemoval(""); await load(true); onNotice(`Removed worktree. Branch ${worktree.branch} was kept.`); }
    catch (cause) { const message = cause instanceof Error ? cause.message : "Could not remove worktree"; setActionError({ id: worktree.id, message }); onNotice(message); }
    finally { setBusy(""); }
  }

  async function setArchived(repo: DashboardRepository, archived: boolean) {
    setBusy(`repo:${repo.id}`);
    try {
      await request(`/api/worktree-dashboard/repositories/${repo.id}/archive`, { method: "PATCH", body: JSON.stringify({ archived }) });
      setDashboard((current) => current ? { ...current, repositories: current.repositories.map((item) => item.id === repo.id ? { ...item, archived } : item) } : current);
      onNotice(`${repo.name} ${archived ? "archived" : "restored"}`);
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : `Could not ${archived ? "archive" : "restore"} ${repo.name}`); }
    finally { setBusy(""); }
  }

  const projectRepositories = dashboard?.repositories.filter((repo) => (projectFor(repo.root) || projectFor(repo.path)) === project) || [];
  const repositoryCounts = {
    active: projectRepositories.filter((repo) => !repo.archived && repo.summary.sessions > 0).length,
    inactive: projectRepositories.filter((repo) => !repo.archived && repo.summary.sessions === 0).length,
    archived: projectRepositories.filter((repo) => repo.archived).length,
  };
  const visibleRepositories = projectRepositories.filter((repo) => repositoryFilter === "archived" ? repo.archived : !repo.archived && (repositoryFilter === "active" ? repo.summary.sessions > 0 : repo.summary.sessions === 0));
  const visibleWorktrees = visibleRepositories.flatMap((repo) => repo.worktrees);
  const visibleSessions = visibleWorktrees.flatMap((worktree) => worktree.sessions);
  const visibleNeedsYou = visibleSessions.filter((session) => session.state.tone === "attention").length;
  const visibleWorking = visibleSessions.filter((session) => session.state.tone === "working").length;
  const visibleOrphans = repositoryFilter === "active" ? dashboard?.orphanSessions.filter((session) => projectFor(session.directory || "") === project) || [] : [];
  return <>
    <section className="hero worktree-hero"><p className="eyebrow">BETA · PARALLEL WORK</p><h1>{visibleNeedsYou ? `${visibleNeedsYou} agent${visibleNeedsYou > 1 ? "s" : ""} need you.` : visibleWorking ? "Your workstreams are moving." : "Worktrees at a glance."}</h1><p>Supervise isolated branches, agents, changes, and pull requests without watching every terminal.</p><div className="summary-row"><div><strong>{dashboard ? visibleWorktrees.length : "–"}</strong><span>worktrees</span></div><div><strong className="accent-number">{dashboard ? visibleNeedsYou : "–"}</strong><span>needs you</span></div><div><strong>{dashboard ? visibleWorking : "–"}</strong><span>working</span></div></div></section>
    <section className="content-section worktree-content">
      <div className="worktree-project-tabs" role="tablist" aria-label="Project"><button role="tab" aria-selected={project === "karven"} className={project === "karven" ? "active" : ""} onClick={() => setProject("karven")}><span>K</span>Karven</button><button role="tab" aria-selected={project === "rekord"} className={project === "rekord" ? "active" : ""} onClick={() => setProject("rekord")}><span>R</span>Rekord</button></div>
      <div className="worktree-filter-tabs" role="tablist" aria-label="Project status">{(["active", "inactive", "archived"] as RepositoryFilter[]).map((filter) => <button role="tab" aria-selected={repositoryFilter === filter} className={repositoryFilter === filter ? "active" : ""} onClick={() => setRepositoryFilter(filter)} key={filter}>{filter[0].toUpperCase() + filter.slice(1)} <b>{repositoryCounts[filter]}</b></button>)}</div>
      <div className="section-heading"><div><h2>{project === "karven" ? "Karven" : "Rekord"} projects</h2>{dashboard && <p>{visibleRepositories.length} shown · {projectRepositories.length} total</p>}</div><button className="text-button" onClick={() => load(true)}>Refresh</button></div>
      {error && <div className="apps-warning">{error}<button onClick={() => load(true)}>Retry</button></div>}
      {!dashboard && !error && <WorktreeSkeleton />}
      {dashboard && dashboard.repositories.length === 0 && <div className="empty-card"><span>⑂</span><strong>No Git worktrees found</strong><p>Add repositories in the companion settings, then refresh this beta dashboard.</p></div>}
      {dashboard && dashboard.repositories.length > 0 && visibleRepositories.length === 0 && visibleOrphans.length === 0 && <div className="empty-card filtered-empty"><span>{repositoryFilter === "archived" ? "□" : repositoryFilter === "active" ? "◌" : "✓"}</span><strong>No {repositoryFilter} {project === "karven" ? "Karven" : "Rekord"} projects</strong><p>{repositoryFilter === "archived" ? "Projects you archive will appear here." : repositoryFilter === "active" ? "Projects appear here as soon as they have a cmux session." : "Every non-archived project currently has a session."}</p></div>}
      <div className="worktree-repositories">{visibleRepositories.map((repo) => <details className="worktree-repository" open key={repo.id}><summary><span className="repo-icon">{repo.name.slice(0, 1).toUpperCase()}</span><div><strong>{repo.name}</strong><small>{repo.summary.worktrees} worktree{repo.summary.worktrees === 1 ? "" : "s"} · {repo.summary.sessions} session{repo.summary.sessions === 1 ? "" : "s"}</small></div>{repo.summary.needsYou > 0 && <em>{repo.summary.needsYou} need you</em>}{!repo.archived && <button type="button" className="repo-create-worktree" aria-label={`Create worktree for ${repo.name}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setCreateTarget(repo); }}>＋ Worktree</button>}<button type="button" className="repo-archive-button" aria-label={`${repo.archived ? "Unarchive" : "Archive"} ${repo.name}`} disabled={busy === `repo:${repo.id}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void setArchived(repo, !repo.archived); }}>{busy === `repo:${repo.id}` ? "…" : repo.archived ? "Unarchive" : "Archive"}</button><b>⌄</b></summary><div className="worktree-list">{repo.worktrees.map((worktree) => <WorktreeCard worktree={worktree} busy={busy} confirming={confirmRemoval === worktree.id} error={actionError?.id === worktree.id ? actionError.message : ""} onOpenWorkspace={onOpenWorkspace} onCloseSession={closeSession} onRequestRemove={() => { setActionError(null); setConfirmRemoval(worktree.id); }} onCancelRemove={() => setConfirmRemoval("")} onRemoveWorktree={removeWorktree} onLaunch={() => setLaunchTarget({ repo, worktree })} key={worktree.id} />)}</div></details>)}</div>
      {visibleOrphans.length > 0 && <section className="orphan-workstreams"><header><strong>Other sessions</strong><span>Not inside a catalogued Git worktree</span></header>{visibleOrphans.map((session) => <div className="orphan-session" key={session.id}><button className="session-open" onClick={() => onOpenWorkspace(session.id)}><span className={`status-orb ${session.state.tone}`} /><div><strong>{session.title}</strong><small>{session.preview}</small></div><b>›</b></button><button className="session-close" aria-label={`Close session ${session.title}`} disabled={busy === `session:${session.id}`} onClick={() => closeSession(session)}>×</button></div>)}</section>}
    </section>
    {launchTarget && <LaunchWorktreeSheet target={launchTarget} onClose={() => setLaunchTarget(null)} onLaunched={async (id) => { setLaunchTarget(null); await load(true); await onLaunched(id); }} onNotice={onNotice} />}
    {createTarget && <CreateWorktreeSheet repo={createTarget} onClose={() => setCreateTarget(null)} onCreated={async (workspaceId) => { setCreateTarget(null); await load(true); if (workspaceId) await onLaunched(workspaceId); }} onNotice={onNotice} />}
  </>;
}

function CreateWorktreeSheet({ repo, onClose, onCreated, onNotice }: { repo: DashboardRepository; onClose: () => void; onCreated: (workspaceId?: string) => Promise<void>; onNotice: (message: string) => void }) {
  const primary = repo.worktrees.find((worktree) => worktree.isPrimary) || repo.worktrees[0];
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState(primary?.branch || "main");
  const [startSession, setStartSession] = useState(true);
  const [agent, setAgent] = useState("codex");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const result = await request<{ worktree: DashboardWorktree; branchCreated: boolean }>(`/api/worktree-dashboard/repositories/${repo.id}/worktrees`, { method: "POST", body: JSON.stringify({ branch, base }) });
      onNotice(`${result.branchCreated ? "Created" : "Opened"} worktree ${result.worktree.branch}`);
      if (!startSession) { await onCreated(); return; }
      try {
        const launched = await request<{ workspace: { workspace_id: string } }>(`/api/worktree-dashboard/${result.worktree.id}/launch`, { method: "POST", body: JSON.stringify({ agent, prompt: prompt.trim(), title: `${repo.name}: ${result.worktree.branch}` }) });
        onNotice(`${agent === "claude" ? "Claude" : "Codex"} launched in ${result.worktree.branch}`);
        await onCreated(launched.workspace.workspace_id);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Could not start the session";
        onNotice(`Worktree created, but the session could not start: ${message}`);
        await onCreated();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create worktree"); }
    finally { setBusy(false); }
  }

  return <><button className="session-menu-backdrop" aria-label="Close new worktree dialog" onClick={onClose} /><form className="worktree-launcher new-worktree-sheet" role="dialog" aria-modal="true" aria-label="Create Git worktree" onSubmit={create}><header><div><strong>Create worktree</strong><span>{repo.name}</span></div><button type="button" onClick={onClose}>×</button></header><p>Creates a sibling folder next to {compactPath(repo.path)}</p><label><span>Branch name</span><input aria-label="Branch name" value={branch} onChange={(event) => setBranch(event.target.value)} maxLength={200} placeholder="feature/my-change" required /></label><label><span>Base revision</span><input aria-label="Base revision" value={base} onChange={(event) => setBase(event.target.value)} maxLength={200} placeholder={primary?.branch || "main"} required /><small>Used only when the branch does not already exist.</small></label><label className="worktree-start-session"><input type="checkbox" checked={startSession} onChange={(event) => setStartSession(event.target.checked)} /><span>Start a session<small>Open an agent in the new worktree after creation.</small></span></label>{startSession && <><fieldset><legend>Agent</legend><button type="button" aria-label="New worktree Codex (xcodex)" className={agent === "codex" ? "selected" : ""} onClick={() => setAgent("codex")}>Codex<small>xcodex</small></button><button type="button" aria-label="New worktree Claude (xclaude)" className={agent === "claude" ? "selected" : ""} onClick={() => setAgent("claude")}>Claude<small>xclaude</small></button></fieldset><label><span>Initial task <small>optional</small></span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} maxLength={8_000} placeholder="Describe the outcome for this workstream…" /></label></>}{error && <p className="worktree-action-error">{error}</p>}<button className="primary-button" disabled={busy || !branch.trim() || !base.trim()}>{busy ? "Creating…" : startSession ? "Create & start session" : "Create worktree"}</button></form></>;
}

function WorktreeCard({ worktree, busy, confirming, error, onOpenWorkspace, onCloseSession, onRequestRemove, onCancelRemove, onRemoveWorktree, onLaunch }: { worktree: DashboardWorktree; busy: string; confirming: boolean; error: string; onOpenWorkspace: (id: string) => void; onCloseSession: (session: WorktreeSession) => Promise<void>; onRequestRemove: () => void; onCancelRemove: () => void; onRemoveWorktree: (worktree: DashboardWorktree) => Promise<void>; onLaunch: () => void }) {
  const pr = worktree.pullRequest;
  const removalBlock = worktree.sessions.length ? "Close active sessions first" : worktree.dirty ? "Commit or stash changes first" : worktree.locked ? "Unlock the worktree first" : "";
  return <article className={`worktree-card ${worktree.state.tone}`}><header><span className={`status-orb ${worktree.state.tone}`} /><div><strong>{worktree.branch}</strong><small>{worktree.isPrimary ? "Primary worktree" : worktree.name}</small></div><span className={`state-pill ${worktree.state.tone}`}>{worktree.state.label}</span></header><p className="worktree-path">{compactPath(worktree.path)}</p><div className="worktree-facts"><span className={worktree.dirty ? "dirty" : ""}>{worktree.changedFiles ? `${worktree.changedFiles} changed` : "Clean"}</span>{worktree.ahead > 0 && <span>↑ {worktree.ahead}</span>}{worktree.behind > 0 && <span>↓ {worktree.behind}</span>}<span>{relativeTime(worktree.lastActivity)}</span>{worktree.locked && <span>Locked</span>}</div>{pr && <a className={`worktree-pr ${pr.checks.failed ? "failed" : pr.checks.pending ? "pending" : "passing"}`} href={pr.url} target="_blank" rel="noreferrer"><span>PR #{pr.number}</span><strong>{pr.title}</strong><small>{pr.checks.failed ? `${pr.checks.failed} failed` : pr.checks.pending ? `${pr.checks.pending} pending` : `${pr.checks.passed}/${pr.checks.total} checks`}</small><b>↗</b></a>}<div className="worktree-sessions">{worktree.sessions.map((session) => <div className="worktree-session-row" key={session.id}><button className="session-open" onClick={() => onOpenWorkspace(session.id)}><span className={`status-orb ${session.state.tone}`} /><div><strong>{session.title}</strong><small>{session.provider} · {session.preview}</small></div><time>{relativeTime(session.lastActivityAt)}</time><b>›</b></button><button className="session-close" aria-label={`Close session ${session.title}`} disabled={busy === `session:${session.id}`} onClick={() => onCloseSession(session)}>×</button></div>)}</div>{confirming && <div className="worktree-remove-confirm"><strong>Remove local worktree?</strong><span>Generated and ignored files will be deleted. The Git branch is kept.</span><div><button onClick={onCancelRemove}>Cancel</button><button className="confirm-remove" disabled={busy === `worktree:${worktree.id}`} onClick={() => onRemoveWorktree(worktree)}>{busy === `worktree:${worktree.id}` ? "Removing files…" : "Confirm remove"}</button></div></div>}{error && <p className="worktree-action-error">{error}</p>}<footer><span>{worktree.sessions.length ? `${worktree.sessions.length} active session${worktree.sessions.length === 1 ? "" : "s"}` : "No active session"}</span>{!worktree.isPrimary && !removalBlock && !confirming && <button className="quick-remove-worktree" onClick={onRequestRemove}>Remove</button>}{!worktree.isPrimary && removalBlock && <details className="worktree-actions"><summary aria-label={`Actions for ${worktree.branch}`}>•••</summary><div><button className="remove-worktree" disabled>Remove worktree</button><small>{removalBlock}</small><small>Git branch will be kept</small></div></details>}<button onClick={onLaunch}>＋ Session</button></footer></article>;
}

function LaunchWorktreeSheet({ target, onClose, onLaunched, onNotice }: { target: { repo: DashboardRepository; worktree: DashboardWorktree }; onClose: () => void; onLaunched: (id: string) => Promise<void>; onNotice: (message: string) => void }) {
  const [agent, setAgent] = useState("codex"); const [prompt, setPrompt] = useState(""); const [busy, setBusy] = useState(false); const [uploading, setUploading] = useState(0); const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);

  async function addImages(files: File[]) {
    const available = 4 - attachments.length;
    if (available <= 0) { onNotice("You can attach up to four images at a time"); return; }
    if (files.length > available) onNotice("Only the first four images were added");
    const selected = files.slice(0, available);
    const valid = selected.filter((file) => {
      if (!IMAGE_TYPES.has(file.type)) { onNotice(`${file.name || "That file"} is not a supported image`); return false; }
      if (file.size > MAX_IMAGE_BYTES) { onNotice(`${file.name || "That image"} must be 8 MB or smaller`); return false; }
      return true;
    });
    if (!valid.length) return;
    setUploading((count) => count + valid.length);
    const uploaded = await Promise.all(valid.map(async (file) => {
      try {
        const dataUrl = await imageDataUrl(file);
        const result = await request<{ image: Omit<ImageAttachment, "preview"> }>("/api/attachments/images", { method: "POST", body: JSON.stringify({ dataUrl, name: file.name || "pasted image" }) });
        return { ...result.image, preview: dataUrl };
      } catch (cause) { onNotice(cause instanceof Error ? cause.message : "Could not attach image"); return null; }
      finally { setUploading((count) => Math.max(0, count - 1)); }
    }));
    setAttachments((current) => [...current, ...uploaded.filter((image): image is ImageAttachment => image != null)].slice(0, 4));
  }

  function pastedImages(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const images = [...event.clipboardData.items].filter((item) => item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (!images.length) return;
    event.preventDefault();
    void addImages(images);
  }

  async function launch(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const result = await request<{ workspace: { workspace_id: string } }>(`/api/worktree-dashboard/${target.worktree.id}/launch`, { method: "POST", body: JSON.stringify({ agent, prompt: composedPrompt(prompt, attachments), title: `${target.repo.name}: ${target.worktree.branch}` }) });
      onNotice(`${agent === "claude" ? "Claude" : "Codex"} launched in ${target.worktree.branch}`);
      await onLaunched(result.workspace.workspace_id);
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "Could not launch worktree agent"); }
    finally { setBusy(false); }
  }
  return <><button className="session-menu-backdrop" aria-label="Close worktree launcher" onClick={onClose} /><form className="worktree-launcher" role="dialog" aria-modal="true" aria-label="Launch worktree session" onSubmit={launch}><header><div><strong>Start session in worktree</strong><span>{target.repo.name} · {target.worktree.branch}</span></div><button type="button" onClick={onClose}>×</button></header><p>{compactPath(target.worktree.path)}</p><fieldset><legend>Agent</legend><button type="button" aria-label="Codex (xcodex)" className={agent === "codex" ? "selected" : ""} onClick={() => setAgent("codex")}>Codex<small>xcodex</small></button><button type="button" aria-label="Claude (xclaude)" className={agent === "claude" ? "selected" : ""} onClick={() => setAgent("claude")}>Claude<small>xclaude</small></button></fieldset><label className="worktree-task"><span>Initial task</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onPaste={pastedImages} rows={6} maxLength={8_000} placeholder="Describe the outcome for this workstream…" /></label>{attachments.length > 0 && <div className="attachment-strip worktree-attachments">{attachments.map((image) => <div key={image.path}><img src={image.preview} alt={image.name} /><span>{image.name}</span><button type="button" aria-label={`Remove ${image.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.path !== image.path))}>×</button></div>)}</div>}<div className="worktree-launch-actions"><input ref={imageInputRef} className="image-input" aria-label="Choose images" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={(event) => { void addImages([...(event.currentTarget.files || [])]); event.currentTarget.value = ""; }} /><button type="button" className="worktree-add-images" disabled={busy || uploading > 0 || attachments.length >= 4} onClick={() => imageInputRef.current?.click()}>＋ Image{attachments.length ? ` · ${attachments.length}/4` : ""}</button><button className="primary-button" disabled={busy || uploading > 0}>{busy ? "Launching…" : uploading ? `Uploading ${uploading}…` : `Launch ${agent === "claude" ? "Claude" : "Codex"}`}</button></div></form></>;
}

function WorktreeSkeleton() { return <div className="worktree-skeleton"><i /><i /><i /></div>; }
