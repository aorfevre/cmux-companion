"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AttachmentStrip, composedPrompt, ImagePickerButton, request, useImageAttachments } from "./image-attachments";
import { PlanSummary, WorktreePlannerSheet } from "./worktree-planner";
import { GitHubIssuePlannerSheet } from "./github-issue-planner";

type DeliveryState = { label: string; tone: "attention" | "working" | "done" | "ready" };
type WorktreeSession = { id: string; title: string; preview: string; directory?: string | null; terminalCount: number; lastActivityAt: number; provider: string; state: DeliveryState };
type PullRequest = { number: number; title: string; url: string; isDraft: boolean; reviewDecision: string; mergeState: string; checks: { passed: number; failed: number; pending: number; total: number } };
export type DashboardWorktree = { id: string; repoId: string; path: string; name: string; branch: string; head?: string | null; shortSha?: string; isPrimary: boolean; managedRelease?: boolean; detached: boolean; locked?: string | null; prunable?: string | null; ahead: number; behind: number; changedFiles: number; updaterArtifacts?: number; dirty: boolean; lastActivity: number; pullRequest?: PullRequest | null; sessions: WorktreeSession[]; state: DeliveryState };
type DashboardRepository = { id: string; name: string; root: string; path: string; archived?: boolean; favorite?: boolean; pullRequestsAvailable: boolean; summary: { worktrees: number; releases: number; sessions: number; needsYou: number; working: number; dirty: number }; worktrees: DashboardWorktree[]; releases: DashboardWorktree[] };
type Dashboard = { generatedAt: string; github?: { checkedAt: string | null; status: "not-loaded" | "ready" | "partial" }; summary: { repositories: number; worktrees: number; releases: number; sessions: number; needsYou: number; working: number; dirty: number; pullRequests: number }; repositories: DashboardRepository[]; orphanSessions: WorktreeSession[] };
type BulkRemovalEntry = { id: string; branch: string; path: string; removed: boolean; error: string };
type BulkRemoval = { requested: number; removed: number; failed: number; results: BulkRemovalEntry[] };
type ProjectKey = "karven" | "rekord";
type DashboardFilter = "active" | "inactive" | "archived" | "draft-goals" | "launched-goals";

function relativeTime(timestamp?: number) { if (!timestamp) return "now"; const seconds = Math.max(0, Math.round(Date.now() / 1000 - timestamp)); if (seconds < 60) return "now"; if (seconds < 3600) return `${Math.floor(seconds / 60)}m`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`; return `${Math.floor(seconds / 86400)}d`; }
function relativePlanTime(timestamp?: string) { const value = timestamp ? Date.parse(timestamp) : NaN; return relativeTime(Number.isFinite(value) ? Math.round(value / 1000) : undefined); }
function githubCheckedTime(timestamp: string) { const value = relativePlanTime(timestamp); return value === "now" ? "just now" : `${value} ago`; }
function compactPath(path: string) { return path.replace(/^\/Users\/[^/]+/, "~"); }
function projectFor(rootOrPath: string): ProjectKey | null { const value = rootOrPath.toLowerCase(); if (value === "karven" || /\/karven(?:\/|$)/.test(value)) return "karven"; if (value === "rekord" || /\/rekord(?:\/|$)/.test(value)) return "rekord"; return null; }
function normalizeDashboard(dashboard: Dashboard): Dashboard {
  return {
    ...dashboard,
    summary: { ...dashboard.summary, releases: dashboard.summary.releases ?? 0 },
    repositories: dashboard.repositories.map((repository) => ({
      ...repository,
      releases: Array.isArray(repository.releases) ? repository.releases : [],
      summary: { ...repository.summary, releases: repository.summary.releases ?? 0 },
    })),
  };
}

export function bulkRemovableWorktrees(repo: DashboardRepository) {
  return repo.worktrees.filter((worktree) => !worktree.managedRelease && !worktree.isPrimary && worktree.changedFiles === 0 && !worktree.locked && worktree.sessions.length === 0);
}

export function WorktreeDashboardView({ onOpenWorkspace, onLaunched, onNotice, initialPlanId = "", onPlanOpened }: { onOpenWorkspace: (id: string) => void; onLaunched: (id: string) => Promise<void>; onNotice: (message: string) => void; initialPlanId?: string; onPlanOpened?: () => void }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [goalError, setGoalError] = useState("");
  const [busy, setBusy] = useState("");
  const [project, setProject] = useState<ProjectKey>("karven");
  const [dashboardFilter, setDashboardFilter] = useState<DashboardFilter>("active");
  const [goalPlans, setGoalPlans] = useState<PlanSummary[]>([]);
  const [confirmDeleteGoalId, setConfirmDeleteGoalId] = useState("");
  const [deletingGoalId, setDeletingGoalId] = useState("");
  const [confirmRemoval, setConfirmRemoval] = useState<{ id: string; stage: "remove" | "discard" } | null>(null);
  const [bulkTarget, setBulkTarget] = useState<DashboardRepository | null>(null);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const [launchTarget, setLaunchTarget] = useState<{ repo: DashboardRepository; worktree: DashboardWorktree } | null>(null);
  const [createTarget, setCreateTarget] = useState<DashboardRepository | null>(null);
  const [planTarget, setPlanTarget] = useState<{ repository: DashboardRepository; planId?: string } | null>(null);
  const [issuePlanTarget, setIssuePlanTarget] = useState<DashboardRepository | null>(null);
  const [search, setSearch] = useState("");
  const load = useCallback(async (refresh = false, refreshGitHub = false) => {
    const query = [refresh && "refresh=1", refreshGitHub && "github=1"].filter(Boolean).join("&");
    try { setDashboard(normalizeDashboard(await request<Dashboard>(`/api/worktree-dashboard${query ? `?${query}` : ""}`))); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Worktree dashboard unavailable"); }
  }, []);
  const loadGoalPlans = useCallback(async () => {
    try {
      const response = await request<{ plans: PlanSummary[] }>("/api/worktree-plans?status=all&limit=200");
      setGoalPlans(Array.isArray(response.plans) ? response.plans : []);
      setGoalError("");
    } catch (cause) { setGoalError(cause instanceof Error ? cause.message : "Saved goals unavailable"); }
  }, []);
  useEffect(() => {
    const kickoff = setTimeout(() => { void load(); void loadGoalPlans(); }, 0);
    const poll = setInterval(() => { if (document.visibilityState === "visible") { void load(); void loadGoalPlans(); } }, 10_000);
    return () => { clearTimeout(kickoff); clearInterval(poll); };
  }, [load, loadGoalPlans]);
  // A running round advances every few seconds, so its card needs a faster
  // clock than the dashboard's. The goal list alone is cheap enough to poll.
  const anyPlanning = goalPlans.some((plan) => plan.running);
  useEffect(() => {
    if (!anyPlanning) return;
    const poll = setInterval(() => { if (document.visibilityState === "visible") void loadGoalPlans(); }, 3_000);
    return () => clearInterval(poll);
  }, [anyPlanning, loadGoalPlans]);
  // A notification about a finished round links straight to its goal. The sheet
  // needs the repository, which arrives with the dashboard, so this waits for
  // both and then opens the plan once.
  const openedPlanRef = useRef("");
  useEffect(() => {
    if (!initialPlanId || openedPlanRef.current === initialPlanId || !dashboard) return;
    const plan = goalPlans.find((item) => item.planId === initialPlanId);
    const repo = plan && dashboard.repositories.find((item) => item.id === plan.repositoryId);
    if (!repo) return;
    openedPlanRef.current = initialPlanId;
    // Deferred by one tick, like the loading kickoff above, so three related
    // state writes land in one render instead of cascading through the effect.
    const open = setTimeout(() => {
      setProject(projectFor(repo.root) || projectFor(repo.path) || "karven");
      setDashboardFilter(plan.status === "launched" ? "launched-goals" : "draft-goals");
      setPlanTarget({ repository: repo, planId: initialPlanId });
      onPlanOpened?.();
    }, 0);
    return () => clearTimeout(open);
  }, [initialPlanId, dashboard, goalPlans, onPlanOpened]);

  async function closeSession(session: WorktreeSession) {
    if (!confirm(`Close cmux session “${session.title}”?`)) return;
    setBusy(`session:${session.id}`);
    try { await request(`/api/workspaces/${session.id}/close`, { method: "POST", body: "{}" }); await load(true); onNotice(`Closed ${session.title}`); }
    catch (cause) { onNotice(cause instanceof Error ? cause.message : "Could not close session"); }
    finally { setBusy(""); }
  }

  async function refreshGitHub() {
    setBusy("github");
    try { await Promise.all([load(true, true), loadGoalPlans()]); }
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

  async function setFavorite(repo: DashboardRepository, favorite: boolean) {
    setBusy(`repo:${repo.id}`);
    try {
      await request(`/api/worktree-dashboard/repositories/${repo.id}/favorite`, { method: "PATCH", body: JSON.stringify({ favorite }) });
      setDashboard((current) => current ? { ...current, repositories: current.repositories.map((item) => item.id === repo.id ? { ...item, favorite } : item) } : current);
      onNotice(`${repo.name} ${favorite ? "favorited" : "unfavorited"}`);
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : `Could not ${favorite ? "favorite" : "unfavorite"} ${repo.name}`); }
    finally { setBusy(""); }
  }

  async function deleteGoal(plan: PlanSummary) {
    setDeletingGoalId(plan.planId); setGoalError("");
    try {
      await request<{ deleted: true }>(`/api/worktree-plans/${encodeURIComponent(plan.planId)}`, { method: "DELETE" });
      setGoalPlans((current) => current.filter((item) => item.planId !== plan.planId));
      setConfirmDeleteGoalId("");
      onNotice(`Deleted goal from ${plan.repositoryName}`);
    } catch (cause) { setGoalError(cause instanceof Error ? cause.message : "Could not delete this goal"); }
    finally { setDeletingGoalId(""); }
  }

  const projectRepositories = dashboard?.repositories.filter((repo) => (projectFor(repo.root) || projectFor(repo.path)) === project) || [];
  const projectRepositoryIds = new Set(projectRepositories.map((repo) => repo.id));
  const projectPlans = goalPlans.filter((plan) => projectRepositoryIds.has(plan.repositoryId));
  // A favorite stays in Active even with no session, so both the tab badge and
  // the list read the same rule.
  const isActiveRepository = (repo: DashboardRepository) => !repo.archived && (repo.favorite === true || repo.summary.sessions > 0);
  const repositoryCounts = {
    active: projectRepositories.filter(isActiveRepository).length,
    inactive: projectRepositories.filter((repo) => !repo.archived && repo.favorite !== true && repo.summary.sessions === 0).length,
    archived: projectRepositories.filter((repo) => repo.archived).length,
  };
  const goalCounts = {
    "draft-goals": projectPlans.filter((plan) => plan.status === "draft").length,
    "launched-goals": projectPlans.filter((plan) => plan.status === "launched").length,
  };
  // A goal keeps planning after its sheet closes, so the tab carries the count
  // of rounds running right now across every repository in this project.
  const planningCount = projectPlans.filter((plan) => plan.running).length;
  const isGoalView = dashboardFilter === "draft-goals" || dashboardFilter === "launched-goals";
  // The search box sits in the shared header, so one query narrows whichever
  // list the current tab shows.
  const query = search.trim().toLowerCase();
  const repositoryMatchesQuery = (repo: DashboardRepository) => !query || repo.name.toLowerCase().includes(query) || compactPath(repo.path).toLowerCase().includes(query);
  const visiblePlans = isGoalView
    ? projectPlans.filter((plan) => plan.status === (dashboardFilter === "draft-goals" ? "draft" : "launched"))
      .filter((plan) => !query || plan.goal.toLowerCase().includes(query) || plan.repositoryName.toLowerCase().includes(query))
    : [];
  const visibleRepositories = isGoalView ? [] : projectRepositories
    .filter((repo) => dashboardFilter === "archived" ? repo.archived : dashboardFilter === "active" ? isActiveRepository(repo) : !repo.archived && repo.favorite !== true && repo.summary.sessions === 0)
    .filter(repositoryMatchesQuery)
    .sort((left, right) => Number(right.favorite === true) - Number(left.favorite === true));
  const visibleWorktrees = visibleRepositories.flatMap((repo) => repo.worktrees);
  const visibleReleases = visibleRepositories.flatMap((repo) => repo.releases);
  const visibleSessions = visibleWorktrees.flatMap((worktree) => worktree.sessions);
  const visibleNeedsYou = visibleSessions.filter((session) => session.state.tone === "attention").length;
  const visibleWorking = visibleSessions.filter((session) => session.state.tone === "working").length;
  const visibleOrphans = dashboardFilter === "active" ? dashboard?.orphanSessions.filter((session) => projectFor(session.directory || "") === project).filter((session) => !query || session.title.toLowerCase().includes(query)) || [] : [];
  const goalTaskCount = visiblePlans.reduce((total, plan) => total + plan.taskCount, 0);
  const goalRepositoryCount = new Set(visiblePlans.map((plan) => plan.repositoryId)).size;
  const filterTabs: { id: DashboardFilter; label: string; count: number; planning?: number }[] = [
    { id: "active", label: "Active", count: repositoryCounts.active },
    { id: "inactive", label: "Inactive", count: repositoryCounts.inactive },
    { id: "archived", label: "Archived", count: repositoryCounts.archived },
    { id: "draft-goals", label: "Draft Goals", count: goalCounts["draft-goals"], planning: planningCount },
    { id: "launched-goals", label: "Launched Goals", count: goalCounts["launched-goals"] },
  ];
  return <>
    <section className="hero worktree-hero"><p className="eyebrow">BETA · PARALLEL WORK</p><h1>{isGoalView ? visiblePlans.length ? `${visiblePlans.length} ${dashboardFilter === "draft-goals" ? "goal" : "launch"}${visiblePlans.length === 1 ? "" : "es"} ${dashboardFilter === "draft-goals" ? "ready to resume." : "on record."}` : `No ${dashboardFilter === "draft-goals" ? "draft" : "launched"} goals yet.` : visibleNeedsYou ? `${visibleNeedsYou} agent${visibleNeedsYou > 1 ? "s" : ""} need you.` : visibleWorking ? "Your workstreams are moving." : "Worktrees at a glance."}</h1><p>{isGoalView ? "Resume plans and inspect launches across every repository in this project." : "Supervise isolated branches, agents, changes, and pull requests without watching every terminal."}</p><div className="summary-row">{isGoalView ? <><div><strong>{dashboard ? visiblePlans.length : "–"}</strong><span>goals</span></div><div><strong className="accent-number">{dashboard ? goalTaskCount : "–"}</strong><span>tasks</span></div><div><strong>{dashboard ? goalRepositoryCount : "–"}</strong><span>repositories</span></div></> : <><div><strong>{dashboard ? visibleWorktrees.length : "–"}</strong><span>worktrees</span></div><div><strong>{dashboard ? visibleReleases.length : "–"}</strong><span>releases</span></div><div><strong className="accent-number">{dashboard ? visibleNeedsYou : "–"}</strong><span>needs you</span></div><div><strong>{dashboard ? visibleWorking : "–"}</strong><span>working</span></div></>}</div></section>
    <section className="content-section worktree-content">
      <div className="worktree-project-tabs" role="tablist" aria-label="Project"><button role="tab" aria-selected={project === "karven"} className={project === "karven" ? "active" : ""} onClick={() => setProject("karven")}><span>K</span>Karven</button><button role="tab" aria-selected={project === "rekord"} className={project === "rekord" ? "active" : ""} onClick={() => setProject("rekord")}><span>R</span>Rekord</button></div>
      <div className="worktree-filter-tabs" role="tablist" aria-label="Project status">{filterTabs.map((filter) => <button role="tab" aria-selected={dashboardFilter === filter.id} className={dashboardFilter === filter.id ? "active" : ""} onClick={() => setDashboardFilter(filter.id)} key={filter.id}>{filter.label} <b>{filter.count}</b>{filter.planning ? <i className="tab-planning" aria-label={`${filter.planning} planning`}>{filter.planning} planning</i> : null}</button>)}</div>
      <div className="section-heading"><div><h2>{project === "karven" ? "Karven" : "Rekord"} {isGoalView ? dashboardFilter === "draft-goals" ? "draft goals" : "launched goals" : "projects"}</h2>{dashboard && <p>{isGoalView ? `${visiblePlans.length} shown · ${projectPlans.length} total goals` : `${visibleRepositories.length} shown · ${projectRepositories.length} total`} · {dashboard.github?.checkedAt ? `GitHub checked ${githubCheckedTime(dashboard.github.checkedAt)}${dashboard.github.status === "partial" ? " · partial" : ""}` : "GitHub refresh is manual"}</p>}</div><div className="dashboard-search"><input type="search" aria-label="Search projects" placeholder="Search projects" value={search} onChange={(event) => setSearch(event.target.value)} />{search !== "" && <button type="button" className="dashboard-search-clear" aria-label="Clear the project search" onClick={() => setSearch("")}>×</button>}</div><button className="text-button" disabled={busy !== ""} onClick={() => { void refreshGitHub(); }}>{busy === "github" ? "Refreshing GitHub…" : "Refresh GitHub"}</button></div>
      {error && <div className="apps-warning">{error}<button onClick={() => load(true)}>Retry</button></div>}
      {isGoalView && goalError && <div className="apps-warning">{goalError}<button onClick={loadGoalPlans}>Retry</button></div>}
      {!dashboard && !error && <WorktreeSkeleton />}
      {!isGoalView && dashboard && dashboard.repositories.length === 0 && <div className="empty-card"><span>⑂</span><strong>No Git worktrees found</strong><p>Add repositories in the companion settings, then refresh this beta dashboard.</p></div>}
      {!isGoalView && dashboard && dashboard.repositories.length > 0 && visibleRepositories.length === 0 && visibleOrphans.length === 0 && (query
        ? <div className="empty-card filtered-empty"><span>⌕</span><strong>No project matches “{search.trim()}”</strong><p>Clear the search to see every {dashboardFilter} project again.</p><button type="button" className="text-button" onClick={() => setSearch("")}>Clear search</button></div>
        : <div className="empty-card filtered-empty"><span>{dashboardFilter === "archived" ? "□" : dashboardFilter === "active" ? "◌" : "✓"}</span><strong>No {dashboardFilter} {project === "karven" ? "Karven" : "Rekord"} projects</strong><p>{dashboardFilter === "archived" ? "Projects you archive will appear here." : dashboardFilter === "active" ? "Projects appear here as soon as they have a cmux session or you favorite them." : "Every non-archived project currently has a session or is favorited."}</p></div>)}
      {!isGoalView && <div className="worktree-repositories">{visibleRepositories.map((repo) => <details className="worktree-repository" open key={repo.id}><summary><span className="repo-icon">{repo.name.slice(0, 1).toUpperCase()}</span><div><strong>{repo.name}</strong><small>{repo.summary.worktrees} worktree{repo.summary.worktrees === 1 ? "" : "s"} · {repo.summary.sessions} session{repo.summary.sessions === 1 ? "" : "s"}{repo.summary.releases > 0 ? ` · ${repo.summary.releases} release${repo.summary.releases === 1 ? "" : "s"}` : ""}</small></div>{repo.summary.needsYou > 0 && <em>{repo.summary.needsYou} need you</em>}{!repo.archived && <button type="button" className="repo-create-worktree" aria-label={`Create worktree for ${repo.name}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setCreateTarget(repo); }}>＋ Worktree</button>}{!repo.archived && <button type="button" className="repo-plan-issues" aria-label={`Plan GitHub issues for ${repo.name}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setIssuePlanTarget(repo); }}>GitHub Issues</button>}{!repo.archived && <button type="button" className="repo-plan-goal" aria-label={`Plan a goal for ${repo.name}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setPlanTarget({ repository: repo }); }}>Plan a goal</button>}{!repo.archived && <button type="button" className="repo-remove-clean" aria-label={`Remove clean worktrees in ${repo.name}`} disabled={bulkRemovableWorktrees(repo).length === 0 || busy === `repo:${repo.id}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setBulkTarget(repo); }}>Remove clean ({bulkRemovableWorktrees(repo).length})</button>}<button type="button" className={`repo-favorite-button${repo.favorite ? " favorited" : ""}`} aria-label={`${repo.favorite ? "Unfavorite" : "Favorite"} ${repo.name}`} aria-pressed={repo.favorite === true} disabled={busy === `repo:${repo.id}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void setFavorite(repo, repo.favorite !== true); }}>{repo.favorite ? "★" : "☆"}</button><button type="button" className="repo-archive-button" aria-label={`${repo.archived ? "Unarchive" : "Archive"} ${repo.name}`} disabled={busy === `repo:${repo.id}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void setArchived(repo, !repo.archived); }}>{busy === `repo:${repo.id}` ? "…" : repo.archived ? "Unarchive" : "Archive"}</button><b>⌄</b></summary><div className="worktree-list">{repo.worktrees.map((worktree) => <WorktreeCard worktree={worktree} busy={busy} confirming={confirmRemoval?.id === worktree.id ? confirmRemoval.stage : null} error={actionError?.id === worktree.id ? actionError.message : ""} onOpenWorkspace={onOpenWorkspace} onCloseSession={closeSession} onRequestRemove={(stage) => { setActionError(null); setConfirmRemoval({ id: worktree.id, stage }); }} onCancelRemove={() => setConfirmRemoval(null)} onRemoveWorktree={removeWorktree} onLaunch={() => setLaunchTarget({ repo, worktree })} key={worktree.id} />)}</div>{repo.releases.length > 0 && <DeploymentReleases releases={repo.releases} />}</details>)}</div>}
      {isGoalView && dashboard && visiblePlans.length === 0 && !goalError && query && <div className="empty-card filtered-empty"><span>⌕</span><strong>No goal matches “{search.trim()}”</strong><p>Clear the search to see every goal again.</p><button type="button" className="text-button" onClick={() => setSearch("")}>Clear search</button></div>}
      {isGoalView && dashboard && visiblePlans.length === 0 && !goalError && !query && <div className="empty-card filtered-empty"><span>{dashboardFilter === "draft-goals" ? "◇" : "✓"}</span><strong>No {dashboardFilter === "draft-goals" ? "draft" : "launched"} {project === "karven" ? "Karven" : "Rekord"} goals</strong><p>{dashboardFilter === "draft-goals" ? "New and interrupted plans will appear here." : "Goals appear here after their worktree sessions are launched."}</p></div>}
      {isGoalView && <section className="worktree-goals" aria-label={dashboardFilter === "draft-goals" ? "Draft goals" : "Launched goals"}>{visiblePlans.map((plan) => { const repo = projectRepositories.find((item) => item.id === plan.repositoryId); if (!repo) return null; return <article className={`worktree-goal-card ${plan.running ? "planning" : plan.status}`} key={plan.planId}><header><span className="repo-icon">{repo.name.slice(0, 1).toUpperCase()}</span><div><strong>{plan.goal}</strong><small>{repo.name}</small></div><em>{plan.running ? "Planning…" : plan.status === "draft" ? "Draft" : "Launched"}</em></header><div className="worktree-goal-meta"><span>{plan.running ? plan.runStep || "Reading the repository…" : plan.runPhase === "failed" ? plan.runError || "The last round failed" : plan.round === 0 ? "Planning stopped before it produced anything" : plan.stage === "questions" ? `Round ${plan.round} · waiting for answers` : `${plan.taskCount} task${plan.taskCount === 1 ? "" : "s"}`}</span><span>Updated {relativePlanTime(plan.updatedAt)}</span></div>{confirmDeleteGoalId === plan.planId ? <footer className="worktree-goal-delete"><span>Delete this saved goal?</span><button type="button" aria-label={`Cancel deleting ${plan.goal}`} disabled={deletingGoalId === plan.planId} onClick={() => setConfirmDeleteGoalId("")}>Cancel</button><button type="button" className="confirm-delete" aria-label={`Confirm delete ${plan.goal}`} disabled={deletingGoalId === plan.planId} onClick={() => { void deleteGoal(plan); }}>{deletingGoalId === plan.planId ? "Deleting…" : "Confirm delete"}</button></footer> : <footer><button type="button" className="worktree-goal-open" aria-label={`${plan.running ? "Watch" : plan.status === "draft" ? "Resume" : "View"} ${plan.goal}`} onClick={() => setPlanTarget({ repository: repo, planId: plan.planId })}>{plan.running ? "Watch" : plan.status === "draft" ? "Resume" : "View"}</button><button type="button" className="worktree-goal-delete-button" aria-label={`Delete ${plan.goal}`} disabled={plan.running === true} onClick={() => setConfirmDeleteGoalId(plan.planId)}>Delete</button></footer>}</article>; })}</section>}
      {visibleOrphans.length > 0 && <section className="orphan-workstreams"><header><strong>Other sessions</strong><span>Not inside a catalogued Git worktree</span></header>{visibleOrphans.map((session) => <div className="orphan-session" key={session.id}><button className="session-open" onClick={() => onOpenWorkspace(session.id)}><span className={`status-orb ${session.state.tone}`} /><div><strong>{session.title}</strong><small>{session.preview}</small></div><b>›</b></button><button className="session-close" aria-label={`Close session ${session.title}`} disabled={busy === `session:${session.id}`} onClick={() => closeSession(session)}>×</button></div>)}</section>}
    </section>
    {bulkTarget && <BulkRemoveSheet repo={bulkTarget} onClose={() => setBulkTarget(null)} onConfirm={() => removeCleanWorktrees(bulkTarget)} />}
    {launchTarget && <LaunchWorktreeSheet target={launchTarget} onClose={() => setLaunchTarget(null)} onLaunched={async (id) => { setLaunchTarget(null); await load(true); await onLaunched(id); }} onNotice={onNotice} />}
    {createTarget && <CreateWorktreeSheet repo={createTarget} onClose={() => setCreateTarget(null)} onCreated={async (workspaceId) => { setCreateTarget(null); await load(true); if (workspaceId) await onLaunched(workspaceId); }} onNotice={onNotice} />}
    {planTarget && <WorktreePlannerSheet repository={planTarget.repository} initialPlanId={planTarget.planId} onClose={() => { setPlanTarget(null); void loadGoalPlans(); }} onLaunched={async () => { await load(true); await loadGoalPlans(); }} onNotice={onNotice} />}
    {issuePlanTarget && <GitHubIssuePlannerSheet repository={issuePlanTarget} onClose={() => { setIssuePlanTarget(null); void loadGoalPlans(); }} onLaunched={async () => { await load(true); await loadGoalPlans(); }} onNotice={onNotice} />}
  </>;
}

function DeploymentReleases({ releases }: { releases: DashboardWorktree[] }) {
  return <details className="deployment-releases"><summary><strong>Deployment releases ({releases.length})</strong><span>Updater-owned infrastructure</span><b>⌄</b></summary><p>The local updater owns these checkouts; Companion will not remove them.</p><div className="deployment-release-list">{releases.map((release) => <div className="deployment-release" key={release.id}><strong>{release.shortSha || release.name.slice(0, 7)}</strong><time>{relativeTime(release.lastActivity)}</time><span>{compactPath(release.path)}</span>{release.locked && <em>Locked</em>}</div>)}</div></details>;
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
  const discardable = !worktree.managedRelease && worktree.dirty && worktree.detached && !worktree.sessions.length && !worktree.locked;
  const removalBlock = worktree.managedRelease ? "Managed deployment releases are protected" : worktree.sessions.length ? "Close active sessions first" : worktree.locked ? "Unlock the worktree first" : worktree.dirty && !discardable ? "Commit or stash changes first" : "";
  const removing = busy === `worktree:${worktree.id}`;
  return <article className={`worktree-card ${worktree.state.tone}`}><header><span className={`status-orb ${worktree.state.tone}`} /><div><strong>{worktree.branch}</strong><small>{worktree.isPrimary ? "Primary worktree" : worktree.name}</small></div><span className={`state-pill ${worktree.state.tone}`}>{worktree.state.label}</span></header><p className="worktree-path">{compactPath(worktree.path)}</p><div className="worktree-facts"><span className={worktree.dirty ? "dirty" : ""}>{worktree.changedFiles ? `${worktree.changedFiles} changed` : "Clean"}</span>{worktree.managedRelease && <span>Managed</span>}{worktree.ahead > 0 && <span>↑ {worktree.ahead}</span>}{worktree.behind > 0 && <span>↓ {worktree.behind}</span>}<span>{relativeTime(worktree.lastActivity)}</span>{worktree.locked && <span>Locked</span>}</div>{pr && <a className={`worktree-pr ${pr.checks.failed ? "failed" : pr.checks.pending ? "pending" : "passing"}`} href={pr.url} target="_blank" rel="noreferrer"><span>PR #{pr.number}</span><strong>{pr.title}</strong><small>{pr.checks.failed ? `${pr.checks.failed} failed` : pr.checks.pending ? `${pr.checks.pending} pending` : `${pr.checks.passed}/${pr.checks.total} checks`}</small><b>↗</b></a>}<div className="worktree-sessions">{worktree.sessions.map((session) => <div className="worktree-session-row" key={session.id}><button className="session-open" onClick={() => onOpenWorkspace(session.id)}><span className={`status-orb ${session.state.tone}`} /><div><strong>{session.title}</strong><small>{session.provider} · {session.preview}</small></div><time>{relativeTime(session.lastActivityAt)}</time><b>›</b></button><button className="session-close" aria-label={`Close session ${session.title}`} disabled={busy === `session:${session.id}`} onClick={() => onCloseSession(session)}>×</button></div>)}</div>{confirming === "remove" && <div className="worktree-remove-confirm"><strong>Remove local worktree?</strong><span>Generated and ignored files will be deleted. The Git branch is kept.</span><div><button onClick={onCancelRemove}>Cancel</button><button className="confirm-remove" disabled={removing} onClick={() => onRemoveWorktree(worktree)}>{removing ? "Removing files…" : "Confirm remove"}</button></div></div>}{confirming === "discard" && <div className="worktree-remove-confirm discard-confirm"><strong>Discard {worktree.changedFiles} uncommitted change{worktree.changedFiles === 1 ? "" : "s"}?</strong><span>This detached checkout has no branch. Removing it deletes {compactPath(worktree.path)} and its {worktree.changedFiles} uncommitted file{worktree.changedFiles === 1 ? "" : "s"} permanently. Nothing is committed or stashed first.</span><div><button onClick={onCancelRemove}>Cancel</button><button className="confirm-remove" disabled={removing} onClick={() => onRemoveWorktree(worktree, true)}>{removing ? "Discarding…" : "Discard and remove"}</button></div></div>}{error && <p className="worktree-action-error">{error}</p>}<footer><span>{worktree.sessions.length ? `${worktree.sessions.length} active session${worktree.sessions.length === 1 ? "" : "s"}` : "No active session"}</span>{!worktree.isPrimary && !removalBlock && !worktree.dirty && !confirming && <button className="quick-remove-worktree" onClick={() => onRequestRemove("remove")}>Remove</button>}{!worktree.isPrimary && discardable && !confirming && <button className="quick-remove-worktree force-remove" onClick={() => onRequestRemove("discard")}>Remove…</button>}{!worktree.isPrimary && removalBlock && <details className="worktree-actions"><summary aria-label={`Actions for ${worktree.branch}`}>•••</summary><div><button className="remove-worktree" disabled>Remove worktree</button><small>{removalBlock}</small><small>Git branch will be kept</small></div></details>}<button onClick={onLaunch}>＋ Session</button></footer></article>;
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
