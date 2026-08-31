"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AttachmentStrip, composedPrompt, ImagePickerButton, request, useImageAttachments } from "./image-attachments";
import { WorktreePlannerSheet } from "./worktree-planner";

type DeliveryState = { label: string; tone: "attention" | "working" | "done" | "ready" };
type WorktreeSession = { id: string; title: string; preview: string; directory?: string | null; terminalCount: number; lastActivityAt: number; provider: string; state: DeliveryState };
type PullRequest = { number: number; title: string; url: string; isDraft: boolean; reviewDecision: string; mergeState: string; checks: { passed: number; failed: number; pending: number; total: number } };
export type DashboardWorktree = { id: string; repoId: string; path: string; name: string; branch: string; head?: string | null; isPrimary: boolean; detached: boolean; locked?: string | null; prunable?: string | null; ahead: number; behind: number; changedFiles: number; updaterArtifacts?: number; dirty: boolean; lastActivity: number; pullRequest?: PullRequest | null; sessions: WorktreeSession[]; state: DeliveryState };
type DashboardRepository = { id: string; name: string; root: string; path: string; archived?: boolean; pullRequestsAvailable: boolean; summary: { worktrees: number; sessions: number; needsYou: number; working: number; dirty: number }; worktrees: DashboardWorktree[] };
type Dashboard = { generatedAt: string; summary: { repositories: number; worktrees: number; sessions: number; needsYou: number; working: number; dirty: number; pullRequests: number }; repositories: DashboardRepository[]; orphanSessions: WorktreeSession[] };
type BulkRemovalEntry = { id: string; branch: string; path: string; removed: boolean; error: string };
type BulkRemoval = { requested: number; removed: number; failed: number; results: BulkRemovalEntry[] };
type ProjectKey = "karven" | "rekord";
type RepositoryFilter = "active" | "inactive" | "archived";

function relativeTime(timestamp?: number) { if (!timestamp) return "now"; const seconds = Math.max(0, Math.round(Date.now() / 1000 - timestamp)); if (seconds < 60) return "now"; if (seconds < 3600) return `${Math.floor(seconds / 60)}m`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`; return `${Math.floor(seconds / 86400)}d`; }
function compactPath(path: string) { return path.replace(/^\/Users\/[^/]+/, "~"); }
function projectFor(rootOrPath: string): ProjectKey | null { const value = rootOrPath.toLowerCase(); if (value === "karven" || /\/karven(?:\/|$)/.test(value)) return "karven"; if (value === "rekord" || /\/rekord(?:\/|$)/.test(value)) return "rekord"; return null; }

export function bulkRemovableWorktrees(repo: DashboardRepository) {
  return repo.worktrees.filter((worktree) => !worktree.isPrimary && worktree.changedFiles === 0 && !worktree.locked && worktree.sessions.length === 0);
}

export function WorktreeDashboardView({ onOpenWorkspace, onLaunched, onNotice }: { onOpenWorkspace: (id: string) => void; onLaunched: (id: string) => Promise<void>; onNotice: (message: string) => void }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [project, setProject] = useState<ProjectKey>("karven");
  const [repositoryFilter, setRepositoryFilter] = useState<RepositoryFilter>("active");
  const [confirmRemoval, setConfirmRemoval] = useState<{ id: string; stage: "remove" | "discard" } | null>(null);
  const [bulkTarget, setBulkTarget] = useState<DashboardRepository | null>(null);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const [launchTarget, setLaunchTarget] = useState<{ repo: DashboardRepository; worktree: DashboardWorktree } | null>(null);
  const [createTarget, setCreateTarget] = useState<DashboardRepository | null>(null);
  const [planTarget, setPlanTarget] = useState<DashboardRepository | null>(null);
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

  async function removeWorktree(worktree: DashboardWorktree, discardChanges = false) {
    setBusy(`worktree:${worktree.id}`);
    setActionError(null);
    const query = discardChanges ? "?discardChanges=1" : "";
    try {
      await request(`/api/worktree-dashboard/${worktree.id}${query}`, { method: "DELETE" });
      setConfirmRemoval(null);
      await load(true);
      onNotice(discardChanges
        ? `Removed worktree and discarded its files. Branch ${worktree.branch} was kept.`
        : `Removed worktree. Branch ${worktree.branch} was kept.`);
    }
    catch (cause) { const message = cause instanceof Error ? cause.message : "Could not remove worktree"; setActionError({ id: worktree.id, message }); onNotice(message); }
    finally { setBusy(""); }
  }

  // One request removes every clean worktree. The server keeps going after a
  // failure, so the notice names each worktree that Git refused.
  async function removeCleanWorktrees(repo: DashboardRepository) {
    setBusy(`repo:${repo.id}`);
    setBulkTarget(null);
    try {
      const result = await request<BulkRemoval>(`/api/worktree-dashboard/repositories/${repo.id}/remove-clean`, { method: "POST", body: "{}" });
      await load(true);
      const failures = result.results.filter((entry) => !entry.removed);
      onNotice(failures.length
        ? `Removed ${result.removed} of ${result.requested} worktrees. Failed: ${failures.map((entry) => `${entry.branch} (${entry.error})`).join("; ")}`
        : `Removed ${result.removed} clean worktree${result.removed === 1 ? "" : "s"} from ${repo.name}. Branches were kept.`);
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : `Could not remove clean worktrees from ${repo.name}`); }
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
      <div className="worktree-repositories">{visibleRepositories.map((repo) => <details className="worktree-repository" open key={repo.id}><summary><span className="repo-icon">{repo.name.slice(0, 1).toUpperCase()}</span><div><strong>{repo.name}</strong><small>{repo.summary.worktrees} worktree{repo.summary.worktrees === 1 ? "" : "s"} · {repo.summary.sessions} session{repo.summary.sessions === 1 ? "" : "s"}</small></div>{repo.summary.needsYou > 0 && <em>{repo.summary.needsYou} need you</em>}{!repo.archived && <button type="button" className="repo-create-worktree" aria-label={`Create worktree for ${repo.name}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setCreateTarget(repo); }}>＋ Worktree</button>}{!repo.archived && <button type="button" className="repo-plan-goal" aria-label={`Plan a goal for ${repo.name}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setPlanTarget(repo); }}>Plan a goal</button>}{!repo.archived && <button type="button" className="repo-remove-clean" aria-label={`Remove clean worktrees in ${repo.name}`} disabled={bulkRemovableWorktrees(repo).length === 0 || busy === `repo:${repo.id}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setBulkTarget(repo); }}>Remove clean ({bulkRemovableWorktrees(repo).length})</button>}<button type="button" className="repo-archive-button" aria-label={`${repo.archived ? "Unarchive" : "Archive"} ${repo.name}`} disabled={busy === `repo:${repo.id}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void setArchived(repo, !repo.archived); }}>{busy === `repo:${repo.id}` ? "…" : repo.archived ? "Unarchive" : "Archive"}</button><b>⌄</b></summary><div className="worktree-list">{repo.worktrees.map((worktree) => <WorktreeCard worktree={worktree} busy={busy} confirming={confirmRemoval?.id === worktree.id ? confirmRemoval.stage : null} error={actionError?.id === worktree.id ? actionError.message : ""} onOpenWorkspace={onOpenWorkspace} onCloseSession={closeSession} onRequestRemove={(stage) => { setActionError(null); setConfirmRemoval({ id: worktree.id, stage }); }} onCancelRemove={() => setConfirmRemoval(null)} onRemoveWorktree={removeWorktree} onLaunch={() => setLaunchTarget({ repo, worktree })} key={worktree.id} />)}</div></details>)}</div>
      {visibleOrphans.length > 0 && <section className="orphan-workstreams"><header><strong>Other sessions</strong><span>Not inside a catalogued Git worktree</span></header>{visibleOrphans.map((session) => <div className="orphan-session" key={session.id}><button className="session-open" onClick={() => onOpenWorkspace(session.id)}><span className={`status-orb ${session.state.tone}`} /><div><strong>{session.title}</strong><small>{session.preview}</small></div><b>›</b></button><button className="session-close" aria-label={`Close session ${session.title}`} disabled={busy === `session:${session.id}`} onClick={() => closeSession(session)}>×</button></div>)}</section>}
    </section>
    {bulkTarget && <BulkRemoveSheet repo={bulkTarget} onClose={() => setBulkTarget(null)} onConfirm={() => removeCleanWorktrees(bulkTarget)} />}
    {launchTarget && <LaunchWorktreeSheet target={launchTarget} onClose={() => setLaunchTarget(null)} onLaunched={async (id) => { setLaunchTarget(null); await load(true); await onLaunched(id); }} onNotice={onNotice} />}
    {createTarget && <CreateWorktreeSheet repo={createTarget} onClose={() => setCreateTarget(null)} onCreated={async (workspaceId) => { setCreateTarget(null); await load(true); if (workspaceId) await onLaunched(workspaceId); }} onNotice={onNotice} />}
    {planTarget && <WorktreePlannerSheet repository={planTarget} onClose={() => setPlanTarget(null)} onLaunched={() => load(true)} onNotice={onNotice} />}
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

type RemovalStage = "remove" | "discard";

function BulkRemoveSheet({ repo, onClose, onConfirm }: { repo: DashboardRepository; onClose: () => void; onConfirm: () => void }) {
  const candidates = bulkRemovableWorktrees(repo);
  return <><button className="session-menu-backdrop" aria-label="Close bulk removal dialog" onClick={onClose} /><div className="worktree-launcher bulk-remove-sheet" role="dialog" aria-modal="true" aria-label="Remove clean worktrees"><header><div><strong>Remove {candidates.length} clean worktree{candidates.length === 1 ? "" : "s"}?</strong><span>{repo.name}</span></div><button type="button" onClick={onClose}>×</button></header><p>Their folders and ignored build output are deleted. Every Git branch is kept.</p><ul className="bulk-remove-list">{candidates.map((worktree) => <li key={worktree.id}><strong>{worktree.branch}</strong><small>{compactPath(worktree.path)}</small></li>)}</ul><div className="bulk-remove-actions"><button type="button" onClick={onClose}>Cancel</button><button type="button" className="confirm-remove" onClick={onConfirm}>Remove {candidates.length} worktree{candidates.length === 1 ? "" : "s"}</button></div></div></>;
}

function WorktreeCard({ worktree, busy, confirming, error, onOpenWorkspace, onCloseSession, onRequestRemove, onCancelRemove, onRemoveWorktree, onLaunch }: { worktree: DashboardWorktree; busy: string; confirming: RemovalStage | null; error: string; onOpenWorkspace: (id: string) => void; onCloseSession: (session: WorktreeSession) => Promise<void>; onRequestRemove: (stage: RemovalStage) => void; onCancelRemove: () => void; onRemoveWorktree: (worktree: DashboardWorktree, discardChanges?: boolean) => Promise<void>; onLaunch: () => void }) {
  const pr = worktree.pullRequest;
  // A detached checkout carries no branch, so its files are a build artifact,
  // not work. It gets a second, explicit confirmation instead of a hard block.
  const discardable = worktree.dirty && worktree.detached && !worktree.sessions.length && !worktree.locked;
  const removalBlock = worktree.sessions.length ? "Close active sessions first" : worktree.locked ? "Unlock the worktree first" : worktree.dirty && !discardable ? "Commit or stash changes first" : "";
  const removing = busy === `worktree:${worktree.id}`;
  return <article className={`worktree-card ${worktree.state.tone}`}><header><span className={`status-orb ${worktree.state.tone}`} /><div><strong>{worktree.branch}</strong><small>{worktree.isPrimary ? "Primary worktree" : worktree.name}</small></div><span className={`state-pill ${worktree.state.tone}`}>{worktree.state.label}</span></header><p className="worktree-path">{compactPath(worktree.path)}</p><div className="worktree-facts"><span className={worktree.dirty ? "dirty" : ""}>{worktree.changedFiles ? `${worktree.changedFiles} changed` : "Clean"}</span>{worktree.ahead > 0 && <span>↑ {worktree.ahead}</span>}{worktree.behind > 0 && <span>↓ {worktree.behind}</span>}<span>{relativeTime(worktree.lastActivity)}</span>{worktree.locked && <span>Locked</span>}</div>{pr && <a className={`worktree-pr ${pr.checks.failed ? "failed" : pr.checks.pending ? "pending" : "passing"}`} href={pr.url} target="_blank" rel="noreferrer"><span>PR #{pr.number}</span><strong>{pr.title}</strong><small>{pr.checks.failed ? `${pr.checks.failed} failed` : pr.checks.pending ? `${pr.checks.pending} pending` : `${pr.checks.passed}/${pr.checks.total} checks`}</small><b>↗</b></a>}<div className="worktree-sessions">{worktree.sessions.map((session) => <div className="worktree-session-row" key={session.id}><button className="session-open" onClick={() => onOpenWorkspace(session.id)}><span className={`status-orb ${session.state.tone}`} /><div><strong>{session.title}</strong><small>{session.provider} · {session.preview}</small></div><time>{relativeTime(session.lastActivityAt)}</time><b>›</b></button><button className="session-close" aria-label={`Close session ${session.title}`} disabled={busy === `session:${session.id}`} onClick={() => onCloseSession(session)}>×</button></div>)}</div>{confirming === "remove" && <div className="worktree-remove-confirm"><strong>Remove local worktree?</strong><span>Generated and ignored files will be deleted. The Git branch is kept.</span><div><button onClick={onCancelRemove}>Cancel</button><button className="confirm-remove" disabled={removing} onClick={() => onRemoveWorktree(worktree)}>{removing ? "Removing files…" : "Confirm remove"}</button></div></div>}{confirming === "discard" && <div className="worktree-remove-confirm discard-confirm"><strong>Discard {worktree.changedFiles} uncommitted change{worktree.changedFiles === 1 ? "" : "s"}?</strong><span>This detached checkout has no branch. Removing it deletes {compactPath(worktree.path)} and its {worktree.changedFiles} uncommitted file{worktree.changedFiles === 1 ? "" : "s"} permanently. Nothing is committed or stashed first.</span><div><button onClick={onCancelRemove}>Cancel</button><button className="confirm-remove" disabled={removing} onClick={() => onRemoveWorktree(worktree, true)}>{removing ? "Discarding…" : "Discard and remove"}</button></div></div>}{error && <p className="worktree-action-error">{error}</p>}<footer><span>{worktree.sessions.length ? `${worktree.sessions.length} active session${worktree.sessions.length === 1 ? "" : "s"}` : "No active session"}</span>{!worktree.isPrimary && !removalBlock && !worktree.dirty && !confirming && <button className="quick-remove-worktree" onClick={() => onRequestRemove("remove")}>Remove</button>}{!worktree.isPrimary && discardable && !confirming && <button className="quick-remove-worktree force-remove" onClick={() => onRequestRemove("discard")}>Remove…</button>}{!worktree.isPrimary && removalBlock && <details className="worktree-actions"><summary aria-label={`Actions for ${worktree.branch}`}>•••</summary><div><button className="remove-worktree" disabled>Remove worktree</button><small>{removalBlock}</small><small>Git branch will be kept</small></div></details>}<button onClick={onLaunch}>＋ Session</button></footer></article>;
}

function LaunchWorktreeSheet({ target, onClose, onLaunched, onNotice }: { target: { repo: DashboardRepository; worktree: DashboardWorktree }; onClose: () => void; onLaunched: (id: string) => Promise<void>; onNotice: (message: string) => void }) {
  const [agent, setAgent] = useState("codex"); const [prompt, setPrompt] = useState(""); const [busy, setBusy] = useState(false);
  const { attachments, uploading, inputRef, addImages, pasteImages, removeImage } = useImageAttachments(onNotice);

  async function launch(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const result = await request<{ workspace: { workspace_id: string } }>(`/api/worktree-dashboard/${target.worktree.id}/launch`, { method: "POST", body: JSON.stringify({ agent, prompt: composedPrompt(prompt, attachments), title: `${target.repo.name}: ${target.worktree.branch}` }) });
      onNotice(`${agent === "claude" ? "Claude" : "Codex"} launched in ${target.worktree.branch}`);
      await onLaunched(result.workspace.workspace_id);
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "Could not launch worktree agent"); }
    finally { setBusy(false); }
  }
  return <><button className="session-menu-backdrop" aria-label="Close worktree launcher" onClick={onClose} /><form className="worktree-launcher" role="dialog" aria-modal="true" aria-label="Launch worktree session" onSubmit={launch}><header><div><strong>Start session in worktree</strong><span>{target.repo.name} · {target.worktree.branch}</span></div><button type="button" onClick={onClose}>×</button></header><p>{compactPath(target.worktree.path)}</p><fieldset><legend>Agent</legend><button type="button" aria-label="Codex (xcodex)" className={agent === "codex" ? "selected" : ""} onClick={() => setAgent("codex")}>Codex<small>xcodex</small></button><button type="button" aria-label="Claude (xclaude)" className={agent === "claude" ? "selected" : ""} onClick={() => setAgent("claude")}>Claude<small>xclaude</small></button></fieldset><label className="worktree-task"><span>Initial task</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onPaste={pasteImages} rows={6} maxLength={8_000} placeholder="Describe the outcome for this workstream…" /></label><AttachmentStrip attachments={attachments} onRemove={removeImage} /><div className="worktree-launch-actions"><ImagePickerButton attachments={attachments} disabled={busy || uploading > 0} inputRef={inputRef} onFiles={(files) => { void addImages(files); }} /><button className="primary-button" disabled={busy || uploading > 0}>{busy ? "Launching…" : uploading ? `Uploading ${uploading}…` : `Launch ${agent === "claude" ? "Claude" : "Codex"}`}</button></div></form></>;
}

function WorktreeSkeleton() { return <div className="worktree-skeleton"><i /><i /><i /></div>; }
