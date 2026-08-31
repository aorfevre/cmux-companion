"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

type DeliveryState = { label: string; tone: "attention" | "working" | "done" | "ready" };
type WorktreeSession = { id: string; title: string; preview: string; directory?: string | null; terminalCount: number; lastActivityAt: number; provider: string; state: DeliveryState };
type PullRequest = { number: number; title: string; url: string; isDraft: boolean; reviewDecision: string; mergeState: string; checks: { passed: number; failed: number; pending: number; total: number } };
export type DashboardWorktree = { id: string; repoId: string; path: string; name: string; branch: string; head?: string | null; isPrimary: boolean; detached: boolean; locked?: string | null; prunable?: string | null; ahead: number; behind: number; changedFiles: number; dirty: boolean; lastActivity: number; pullRequest?: PullRequest | null; sessions: WorktreeSession[]; state: DeliveryState };
type DashboardRepository = { id: string; name: string; root: string; path: string; pullRequestsAvailable: boolean; summary: { worktrees: number; sessions: number; needsYou: number; working: number; dirty: number }; worktrees: DashboardWorktree[] };
type Dashboard = { generatedAt: string; summary: { repositories: number; worktrees: number; sessions: number; needsYou: number; working: number; dirty: number; pullRequests: number }; repositories: DashboardRepository[]; orphanSessions: WorktreeSession[] };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

function relativeTime(timestamp?: number) { if (!timestamp) return "now"; const seconds = Math.max(0, Math.round(Date.now() / 1000 - timestamp)); if (seconds < 60) return "now"; if (seconds < 3600) return `${Math.floor(seconds / 60)}m`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`; return `${Math.floor(seconds / 86400)}d`; }
function compactPath(path: string) { return path.replace(/^\/Users\/[^/]+/, "~"); }

export function WorktreeDashboardView({ onOpenWorkspace, onLaunched, onNotice }: { onOpenWorkspace: (id: string) => void; onLaunched: (id: string) => Promise<void>; onNotice: (message: string) => void }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [launchTarget, setLaunchTarget] = useState<{ repo: DashboardRepository; worktree: DashboardWorktree } | null>(null);
  const load = useCallback(async (refresh = false) => {
    try { setDashboard(await request<Dashboard>(`/api/worktree-dashboard${refresh ? "?refresh=1" : ""}`)); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Worktree dashboard unavailable"); }
  }, []);
  useEffect(() => { const kickoff = setTimeout(load, 0); const poll = setInterval(() => { if (document.visibilityState === "visible") load(); }, 10_000); return () => { clearTimeout(kickoff); clearInterval(poll); }; }, [load]);

  const summary = dashboard?.summary;
  return <>
    <section className="hero worktree-hero"><p className="eyebrow">BETA · PARALLEL WORK</p><h1>{summary?.needsYou ? `${summary.needsYou} agent${summary.needsYou > 1 ? "s" : ""} need you.` : summary?.working ? "Your workstreams are moving." : "Worktrees at a glance."}</h1><p>Supervise isolated branches, agents, changes, and pull requests without watching every terminal.</p><div className="summary-row"><div><strong>{summary?.worktrees ?? "–"}</strong><span>worktrees</span></div><div><strong className="accent-number">{summary?.needsYou ?? "–"}</strong><span>needs you</span></div><div><strong>{summary?.working ?? "–"}</strong><span>working</span></div></div></section>
    <section className="content-section worktree-content"><div className="section-heading"><div><h2>Workstreams</h2>{summary && <p>{summary.repositories} repos · {summary.dirty} dirty · {summary.pullRequests} PRs</p>}</div><button className="text-button" onClick={() => load(true)}>Refresh</button></div>
      {error && <div className="apps-warning">{error}<button onClick={() => load(true)}>Retry</button></div>}
      {!dashboard && !error && <WorktreeSkeleton />}
      {dashboard && dashboard.repositories.length === 0 && <div className="empty-card"><span>⑂</span><strong>No Git worktrees found</strong><p>Add repositories in the companion settings, then refresh this beta dashboard.</p></div>}
      <div className="worktree-repositories">{dashboard?.repositories.map((repo) => <details className="worktree-repository" open key={repo.id}><summary><span className="repo-icon">{repo.name.slice(0, 1).toUpperCase()}</span><div><strong>{repo.name}</strong><small>{repo.summary.worktrees} worktree{repo.summary.worktrees === 1 ? "" : "s"} · {repo.summary.sessions} session{repo.summary.sessions === 1 ? "" : "s"}</small></div>{repo.summary.needsYou > 0 && <em>{repo.summary.needsYou} need you</em>}<b>⌄</b></summary><div className="worktree-list">{repo.worktrees.map((worktree) => <WorktreeCard worktree={worktree} onOpenWorkspace={onOpenWorkspace} onLaunch={() => setLaunchTarget({ repo, worktree })} key={worktree.id} />)}</div></details>)}</div>
      {dashboard && dashboard.orphanSessions.length > 0 && <section className="orphan-workstreams"><header><strong>Other sessions</strong><span>Not inside a catalogued Git worktree</span></header>{dashboard.orphanSessions.map((session) => <button onClick={() => onOpenWorkspace(session.id)} key={session.id}><span className={`status-orb ${session.state.tone}`} /><div><strong>{session.title}</strong><small>{session.preview}</small></div><b>›</b></button>)}</section>}
    </section>
    {launchTarget && <LaunchWorktreeSheet target={launchTarget} onClose={() => setLaunchTarget(null)} onLaunched={async (id) => { setLaunchTarget(null); await load(true); await onLaunched(id); }} onNotice={onNotice} />}
  </>;
}

function WorktreeCard({ worktree, onOpenWorkspace, onLaunch }: { worktree: DashboardWorktree; onOpenWorkspace: (id: string) => void; onLaunch: () => void }) {
  const pr = worktree.pullRequest;
  return <article className={`worktree-card ${worktree.state.tone}`}><header><span className={`status-orb ${worktree.state.tone}`} /><div><strong>{worktree.branch}</strong><small>{worktree.isPrimary ? "Primary worktree" : worktree.name}</small></div><span className={`state-pill ${worktree.state.tone}`}>{worktree.state.label}</span></header><p className="worktree-path">{compactPath(worktree.path)}</p><div className="worktree-facts"><span className={worktree.dirty ? "dirty" : ""}>{worktree.changedFiles ? `${worktree.changedFiles} changed` : "Clean"}</span>{worktree.ahead > 0 && <span>↑ {worktree.ahead}</span>}{worktree.behind > 0 && <span>↓ {worktree.behind}</span>}<span>{relativeTime(worktree.lastActivity)}</span>{worktree.locked && <span>Locked</span>}</div>{pr && <a className={`worktree-pr ${pr.checks.failed ? "failed" : pr.checks.pending ? "pending" : "passing"}`} href={pr.url} target="_blank" rel="noreferrer"><span>PR #{pr.number}</span><strong>{pr.title}</strong><small>{pr.checks.failed ? `${pr.checks.failed} failed` : pr.checks.pending ? `${pr.checks.pending} pending` : `${pr.checks.passed}/${pr.checks.total} checks`}</small><b>↗</b></a>}<div className="worktree-sessions">{worktree.sessions.map((session) => <button onClick={() => onOpenWorkspace(session.id)} key={session.id}><span className={`status-orb ${session.state.tone}`} /><div><strong>{session.title}</strong><small>{session.provider} · {session.preview}</small></div><time>{relativeTime(session.lastActivityAt)}</time><b>›</b></button>)}</div><footer><span>{worktree.sessions.length ? `${worktree.sessions.length} active session${worktree.sessions.length === 1 ? "" : "s"}` : "No active session"}</span><button onClick={onLaunch}>＋ Agent</button></footer></article>;
}

function LaunchWorktreeSheet({ target, onClose, onLaunched, onNotice }: { target: { repo: DashboardRepository; worktree: DashboardWorktree }; onClose: () => void; onLaunched: (id: string) => Promise<void>; onNotice: (message: string) => void }) {
  const [agent, setAgent] = useState("codex"); const [prompt, setPrompt] = useState(""); const [busy, setBusy] = useState(false);
  async function launch(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const result = await request<{ workspace: { workspace_id: string } }>(`/api/worktree-dashboard/${target.worktree.id}/launch`, { method: "POST", body: JSON.stringify({ agent, prompt, title: `${target.repo.name}: ${target.worktree.branch}` }) });
      onNotice(`${agent === "claude" ? "Claude" : "Codex"} launched in ${target.worktree.branch}`);
      await onLaunched(result.workspace.workspace_id);
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "Could not launch worktree agent"); }
    finally { setBusy(false); }
  }
  return <><button className="session-menu-backdrop" aria-label="Close worktree launcher" onClick={onClose} /><form className="worktree-launcher" role="dialog" aria-modal="true" aria-label="Launch worktree agent" onSubmit={launch}><header><div><strong>Launch isolated agent</strong><span>{target.repo.name} · {target.worktree.branch}</span></div><button type="button" onClick={onClose}>×</button></header><p>{compactPath(target.worktree.path)}</p><fieldset><legend>Agent</legend><button type="button" aria-label="Codex (xcodex)" className={agent === "codex" ? "selected" : ""} onClick={() => setAgent("codex")}>Codex<small>xcodex</small></button><button type="button" aria-label="Claude (xclaude)" className={agent === "claude" ? "selected" : ""} onClick={() => setAgent("claude")}>Claude<small>xclaude</small></button></fieldset><label><span>Initial task</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} maxLength={8_000} placeholder="Describe the outcome for this workstream…" /></label><button className="primary-button" disabled={busy}>{busy ? "Launching…" : `Launch ${agent === "claude" ? "Claude" : "Codex"}`}</button></form></>;
}

function WorktreeSkeleton() { return <div className="worktree-skeleton"><i /><i /><i /></div>; }
