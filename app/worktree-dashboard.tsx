"use client";

import { canRetryOnFreshBranch } from "../server/worktree-errors.mjs";
import { WorktreeCleanupPanel } from "./worktree-cleanup";
import { FormEvent, RefObject, useCallback, useEffect, useRef, useState } from "react";
import { AttachmentStrip, composedPrompt, ImagePickerButton, request, useImageAttachments } from "./image-attachments";
import { GoalBoardStateId, GoalHealth, goalPrLink, PlanDraft, PlanSummary, TaskRelaunchResult, terminalStatus, WorktreePlannerSheet } from "./worktree-planner";
// The board reads its columns and its placement from the one shared module, so
// the dashboard can never invent a column the server does not know.
import { GOAL_BOARD_COLUMNS, goalBoardState, groupGoalsByBoardState } from "../server/goal-board.mjs";
import { DEFAULT_FOLLOWUP_AGENT, GOAL_FOLLOWUP_ACTIONS, GOAL_FOLLOWUP_AGENTS, MAX_FOLLOWUP_TEXT, normalizeFollowupRequest } from "../server/goal-followup-actions.mjs";
// The GitHub Issues column shares its identity with the server, exactly like
// the goal columns above. One label, one id, one empty hint, in one file.
import { GITHUB_ISSUE_ALL_STARTED_HINT, GITHUB_ISSUE_COLUMN, GITHUB_ISSUE_EMPTY_HINT, GITHUB_ISSUE_SYNC_NO_FAVORITES, githubIssueCardId, visibleGithubIssues } from "../server/github-issue-board.mjs";
import { GitHubIssuePlannerSheet } from "./github-issue-planner";
// The quota countdown already exists on the licence page. Reusing it keeps one
// reset time from reading two different ways on two screens.
import { resetText } from "./account-usage";

type DeliveryState = { label: string; tone: "attention" | "working" | "done" | "ready" };
type WorktreeSession = { id: string; title: string; preview: string; directory?: string | null; terminalCount: number; lastActivityAt: number; provider: string; state: DeliveryState };
type PullRequest = { number: number; title: string; url: string; isDraft: boolean; reviewDecision: string; mergeState: string; checks: { passed: number; failed: number; pending: number; total: number } };
export type DashboardWorktree = { id: string; repoId: string; path: string; name: string; branch: string; head?: string | null; shortSha?: string; isPrimary: boolean; managedRelease?: boolean; detached: boolean; locked?: string | null; prunable?: string | null; ahead: number; behind: number; changedFiles: number; updaterArtifacts?: number; dirty: boolean; lastActivity: number; pullRequest?: PullRequest | null; sessions: WorktreeSession[]; state: DeliveryState };
type DashboardRepository = { id: string; name: string; root: string; path: string; archived?: boolean; favorite?: boolean; pullRequestsAvailable: boolean; summary: { worktrees: number; releases: number; sessions: number; needsYou: number; working: number; dirty: number }; worktrees: DashboardWorktree[]; releases: DashboardWorktree[] };
type Dashboard = { generatedAt: string; github?: { checkedAt: string | null; status: "not-loaded" | "ready" | "partial" }; summary: { repositories: number; worktrees: number; releases: number; sessions: number; needsYou: number; working: number; dirty: number; pullRequests: number }; repositories: DashboardRepository[]; orphanSessions: WorktreeSession[] };
type BulkRemovalEntry = { id: string; branch: string; path: string; removed: boolean; error: string };
type BulkRemoval = { requested: number; removed: number; failed: number; results: BulkRemovalEntry[] };
// The sweep payload from GET /api/goals/health. It is read-only evidence: the
// rail acts through the relaunch and skip routes, never through this shape.
type HealthSession = { id: string; title: string | null; lastActivityAt: number; effective: string | null; inputEvidence?: string | null; workingEvidence?: string | null };
type HealthTask = { id: string; title: string; branch: string; agent: string | null; wave: number; launchStatus: string | null; launchError: string | null; launchReason?: string | null; deliveryStatus: string; workspaceId: string | null; health: GoalHealth; reason: string; session: HealthSession | null };
type HealthMerge = { id: "merge"; kind: "merge"; title: string; workspaceId: string | null; health: GoalHealth; reason: string; session: HealthSession | null; observedHealth?: GoalHealth };
type HealthGoal = { planId: string; goal: string; repositoryId: string; repositoryName: string; health: GoalHealth; stuckCount: number; readyCount: number; launchedCount: number; taskCount: number; deliveryStatus?: string; merge?: HealthMerge | null; tasks: HealthTask[] };
type HealthSummary = { goals: number; tasks: number; stuck: number; needsYou: number; working: number; deadTasks: number; idleTasks: number; failedTasks: number };
// GET /api/goals/capacity. The dispatcher's own verdict, rendered: nothing here
// recomputes which provider is next.
type CapacityWindow = { cadence: "5h" | "weekly"; label: string; remainingPercent: number; resetAt: string | null };
type CapacityAccount = { id: string | null; label: string; status: string; headroom: number | null; windows: CapacityWindow[] };
type CapacityProvider = { id: "claude" | "codex"; label: string; available: boolean; headroom: number | null; bestPercent: number | null; resetAt: string | null; accounts: CapacityAccount[] };
type AgentCapacity = { providers: CapacityProvider[]; next: "claude" | "codex" | null; reason: string; nextReset: string | null; available: boolean };
// POST /api/worktree-plans/:planId/check-merge. `changed` is the only field
// that says the board moved; the rest explains why it did not.
type MergeCheck = { planId: string; changed: boolean; state: "OPEN" | "CLOSED" | "MERGED" | null; boardStatus: "merged" | "aborted" | null; pullRequest: { number: number; url: string } | null; checked: true };
type GoalHealthSweep = { checkedAt: string; sessionsAvailable: boolean; goals: HealthGoal[]; summary: HealthSummary };
// POST /api/goals/sessions/reap and GET /api/goals/sessions/retirable. Both
// answer with this one shape, so the dry run and the real pass are read by the
// same code and can never disagree about what a pass would do.
type SessionReapClosed = { planId: string; workspaceId: string; taskId: string | null; kind: string; title: string; reason: string };
type SessionReapKept = { planId: string; workspaceId: string; kind: string; reason: string };
type SessionReapFailed = { planId: string; workspaceId: string; error: string };
type SessionReapReport = { checkedAt: string; sessionsAvailable: boolean; closed: SessionReapClosed[]; kept: SessionReapKept[]; failed: SessionReapFailed[] };
// GET /api/github-issues and POST /api/github-issues/sync. Every field here is
// repository content that any GitHub user can write, so the column renders it
// as plain text and never as markup or as an instruction.
type GitHubIssueCard = { repositoryId: string; repositoryName: string; number: number; title: string; labels: string[]; url: string; updatedAt: string; syncedAt: string; planId: string | null };
type GitHubIssueColumnPayload = { syncedAt: string | null; issues: GitHubIssueCard[] };
type GitHubIssueSyncRepository = { repositoryId: string; name: string; status: string; issueCount: number; truncated: boolean; error: string | null };
type GitHubIssueSyncResult = { syncedAt: string; status: string; message: string | null; repositories: GitHubIssueSyncRepository[]; issues: GitHubIssueCard[] };
type GitHubIssueGoalResult = { issue: GitHubIssueCard; plan: { planId: string }; created: boolean };
type FollowupAgent = "claude" | "codex";
type FollowupSubmission = { actions: string[]; question?: string; custom?: string; agent: FollowupAgent };
type FollowupResult = { planId: string; workspaceId: string; agent: FollowupAgent; actions: string[]; branch: string; worktreePath: string; pullRequest: { number: number; url: string } | null; title: string };
// The four verdicts that mean a person is needed. Everything else is either
// progress or a state with nothing to act on, so the rail never lists it.
const ATTENTION_HEALTH = new Set<GoalHealth>(["dead", "idle", "failed", "needs_you"]);
const HEALTH_LABELS: Record<string, string> = { failed: "Failed", dead: "Dead", idle: "Idle", needs_you: "Needs you", working: "Working", ready: "Ready", integrated: "Integrated", queued: "Queued", unknown: "Unknown" };
type ProjectKey = "karven" | "rekord";
type BoardProjectKey = ProjectKey | "all";
type DashboardFilter = "active" | "inactive" | "archived" | "draft-goals" | "launched-goals" | "goals-board";
type AbortResult = { planId: string; aborted: boolean; alreadyAborted: boolean; closedSessionIds: string[]; failedSessionIds: string[] };
const GOAL_FILTERS = new Set<DashboardFilter>(["draft-goals", "launched-goals", "goals-board"]);
type GoalBoardColumn = { id: GoalBoardStateId; label: string; description: string; collapsedByDefault?: boolean };
const BOARD_COLUMNS = GOAL_BOARD_COLUMNS as readonly GoalBoardColumn[];
const BOARD_COLUMN_IDS = new Set<string>(BOARD_COLUMNS.map((column) => column.id));
const BOARD_COLUMN_PREFERENCE_KEY = "cmux-companion-goal-board-column-expansion";
const ALL_BOARD_COLUMN_IDS = [GITHUB_ISSUE_COLUMN.id, ...BOARD_COLUMNS.map((column) => column.id)];
const DEFAULT_COLLAPSED_BOARD_COLUMNS = new Set<string>(BOARD_COLUMNS.filter((column) => column.collapsedByDefault).map((column) => column.id));

function initialCollapsedBoardColumns() {
  const collapsed = new Set(DEFAULT_COLLAPSED_BOARD_COLUMNS);
  if (typeof window === "undefined") return collapsed;
  try {
    const stored = JSON.parse(localStorage.getItem(BOARD_COLUMN_PREFERENCE_KEY) || "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return collapsed;
    for (const id of ALL_BOARD_COLUMN_IDS) {
      if (stored[id] === true) collapsed.delete(id);
      if (stored[id] === false) collapsed.add(id);
    }
  } catch { /* An invalid or unavailable preference falls back to the shared defaults. */ }
  return collapsed;
}

// The server derives the state and sends it as `boardState`. An older payload
// or an unknown word falls back to the same derivation running locally, so a
// card always lands in exactly one column.
function boardStateOf(plan: PlanSummary): GoalBoardStateId {
  if (plan.boardState && BOARD_COLUMN_IDS.has(plan.boardState)) return plan.boardState;
  return goalBoardState(plan) as GoalBoardStateId;
}

// A durable workspace id is historical evidence, not proof that cmux can open
// it now. Board focus actions are offered only for sessions the latest health
// sweep actually joined to the live cmux workspace list.
function liveGoalSessionId(state: GoalBoardStateId, goal?: HealthGoal) {
  if (!goal) return null;
  if (state === "blocked" && goal.merge?.session?.id) return goal.merge.session.id;
  return goal.tasks.find((task) => task.session?.id)?.session?.id || goal.merge?.session?.id || null;
}

const LAUNCHING_EVIDENCE = "Creating worktrees and starting sessions…";

// The one line of evidence under a card. Each state shows the structured field
// that explains it, never a label parsed from another one.
function boardEvidence(plan: PlanSummary, state: GoalBoardStateId) {
  if (state === "aborted") return "Stopped. Branches and worktrees were kept.";
  if (state === "merged") return "Its pull request was observed as merged.";
  if (state === "waiting_for_merge") return plan.deliveryError || (plan.deliveryStatus === "assembling" ? "A merge agent is assembling this goal" : "Waiting for the goal pull request to merge");
  if (state === "blocked") return plan.deliveryError || plan.healthReason || "This goal stopped and needs attention";
  if (state === "dev_in_progress") return plan.deliveryError || deliveryEvidence(plan.deliveryStatus);
  // A launch runs on the companion after its request has ended. Until it
  // settles, this goal is neither idle nor launched, so it says so.
  if (plan.launching) return LAUNCHING_EVIDENCE;
  if (state === "waiting_for_dev") return "Ready to launch";
  if (plan.running) return plan.runStep || (state === "review_spec" ? "A reviewer pass is reading the specification…" : "Reading the repository…");
  if (plan.runPhase === "failed") return plan.runError || plan.lastError || "The last round failed";
  if (plan.round === 0) return "Planning stopped before it produced anything";
  return plan.stage === "questions" ? `Round ${plan.round} · waiting for answers` : `Round ${plan.round}`;
}

// What one retirement pass did, in one sentence. An unreachable cmux proves
// nothing about any agent, so it is never reported as "0 finished sessions":
// it says liveness is unknown, exactly as the attention rail already does.
export function sessionReapNotice(report: SessionReapReport) {
  const kept = report.kept.length;
  const kepts = `${kept} kept`;
  if (!report.sessionsAvailable) return "cmux could not be reached, so agent liveness is unknown. No session was closed.";
  const closed = report.closed.length;
  const head = `Closed ${closed} finished session${closed === 1 ? "" : "s"}, ${kepts}.`;
  // A kept session always carries its reason, and the first one is the answer
  // to "why is that session still open?". Naming one beats naming none.
  const why = kept > 0 ? ` ${report.kept[0].reason}.` : "";
  if (!report.failed.length) return `${head}${why}`;
  const names = report.failed.map((entry) => `${entry.workspaceId} (${entry.error || "unknown error"})`).join("; ");
  return `${head}${why} cmux refused to close ${report.failed.length} session${report.failed.length === 1 ? "" : "s"}: ${names}`;
}

function deliveryEvidence(status?: string) {
  if (status === "blocked") return "Combined delivery needs attention";
  if (status === "ready") return "Task branches are ready";
  return "Agents are working on the launched tasks";
}

// A GitHub issue link needs the repository's web root, and no payload carries
// one. A pull request URL the same repository already produced is the only
// reliable source, so a goal without one renders "#12" as plain text.
function issueBaseFrom(urls: (string | null | undefined)[]) {
  for (const url of urls) { const match = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/(?:pull|issues)\/\d+/.exec(url || ""); if (match) return match[1]; }
  return "";
}

// Two repositories must never share a chip colour, and a hardcoded pair would
// break on the third repository. The hue comes from the name itself, so it is
// stable across reloads and needs no list to maintain.
function repoChipStyle(name: string) {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) % 360;
  // The comma form on purpose: the space-and-slash syntax is dropped by some
  // CSSOM parsers, which would leave the chip unstyled rather than coloured.
  return { borderColor: `hsla(${hash}, 52%, 46%, .5)`, background: `hsla(${hash}, 58%, 32%, .2)`, color: `hsl(${hash}, 82%, 78%)` };
}

// The product a goal belongs to, as a label rather than a footnote. The board
// and the rail both lead with it.
function RepoChip({ name }: { name: string }) { return <span className="goal-repo-chip" style={repoChipStyle(name)}>{name}</span>; }

// The generated cmux title carries the stable task identity as one of its
// ` · `-delimited segments: `CC · The goal text (7a2b) · T2-api · Wire the
// sweep`. Showing that same code on the board lets a person match a card to
// cmux's narrow sidebar without comparing two long sentences.
//
// The code no longer leads the title, so the parser reads segments rather than
// a prefix. Two shapes live on one board at the same time, because a session is
// never renamed after it is opened:
//   new     CC · The goal text (7a2b) · T2-api · Wire the sweep
//   legacy  CC-T2-api · Wire the sweep
// A whole segment must match, not a substring, so a goal text that happens to
// read like a code ("Ship T2-api parity") is never mistaken for the code.
const TASK_PART_SEGMENT = /^T\d{1,3}-[a-z0-9]+$/i;
const LEGACY_PART_SEGMENT = /^[A-Z0-9]{2,4}-T\d{1,3}-[a-z0-9]+$/i;
const SESSION_SEPARATOR = " \u00b7 ";

function sessionTaskCode(task: HealthTask) {
  const title = String(task.session?.title || "").trim();
  const segments = title.split(SESSION_SEPARATOR).map((segment) => segment.trim()).filter(Boolean);
  const part = segments.find((segment) => TASK_PART_SEGMENT.test(segment));
  if (part) return part;
  const legacy = segments.find((segment) => LEGACY_PART_SEGMENT.test(segment));
  if (legacy) return legacy;
  // Last resort for a legacy title whose separator did not survive. The
  // segment scans run first, so this never overrides a real segment.
  return /^([A-Z0-9]{2,4}-T\d{1,3}-[a-z0-9]+)\b/i.exec(title)?.[1] || task.id;
}

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
  // The board supervises both repository roots by default. Worktree and goal
  // lists keep their narrower Karven/Rekord selection in `project`.
  const [boardProject, setBoardProject] = useState<BoardProjectKey>("all");
  // The board is the landing view: it is the one screen that answers "what is
  // running, what is stuck, what needs me" across every repository. The other
  // tabs are for looking at one repository's worktrees, which is a narrower
  // question and a deliberate second step. Switching project keeps whichever
  // tab is open, so the board stays put across a Karven/Rekord switch.
  const [dashboardFilter, setDashboardFilter] = useState<DashboardFilter>("goals-board");
  const [goalPlans, setGoalPlans] = useState<PlanSummary[]>([]);
  const [health, setHealth] = useState<GoalHealthSweep | null>(null);
  const [healthError, setHealthError] = useState("");
  // What a retirement pass would close right now, read on the board poll. The
  // button is labelled with this count, so it is honest before it is pressed.
  const [retirable, setRetirable] = useState<SessionReapReport | null>(null);
  const [capacity, setCapacity] = useState<AgentCapacity | null>(null);
  const [capacityError, setCapacityError] = useState("");
  // The board bar carries capacity as one chip. The full strip is still the
  // same component with the same labels; this only says whether it is open.
  const [capacityOpen, setCapacityOpen] = useState(false);
  // The countdown ticks on its own clock: the capacity payload only changes
  // every ten seconds, but "resets in 00:04:12" must move every second.
  const [nowTick, setNowTick] = useState(() => Date.now());
  // Picking a repository for a new goal. The planner sheet needs one, and the
  // board spans every repository in the project, so it cannot guess.
  const [newGoalOpen, setNewGoalOpen] = useState(false);
  const [newGoalQuery, setNewGoalQuery] = useState("");
  // One key per operation. A shared busy string would disable every Continue
  // button on the rail while a single task was relaunching.
  const [relaunchModes, setRelaunchModes] = useState<Record<string, string>>({});
  const [boardBusy, setBoardBusy] = useState<Record<string, boolean>>({});
  // The synced GitHub issue column. It is stored server side, so the board
  // reads it on mount and a reload shows the last sync without a new one.
  const [issueCards, setIssueCards] = useState<GitHubIssueCard[]>([]);
  const [issueSyncing, setIssueSyncing] = useState(false);
  // A sync that read nothing, or read only failures, states the reason on the
  // board through the same warning strip as every other dashboard failure.
  const [issueNotice, setIssueNotice] = useState("");
  const [confirmTaskAction, setConfirmTaskAction] = useState("");
  const [confirmDeleteGoalId, setConfirmDeleteGoalId] = useState("");
  const [deletingGoalId, setDeletingGoalId] = useState("");
  // Abort keeps its own confirmation and busy ids. Sharing the delete state
  // would let one card's confirmation open the other card's footer.
  const [confirmAbortGoalId, setConfirmAbortGoalId] = useState("");
  const [abortingGoalId, setAbortingGoalId] = useState("");
  const [confirmRemoval, setConfirmRemoval] = useState<{ id: string; stage: "remove" | "discard" } | null>(null);
  const [bulkTarget, setBulkTarget] = useState<DashboardRepository | null>(null);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const [launchTarget, setLaunchTarget] = useState<{ repo: DashboardRepository; worktree: DashboardWorktree } | null>(null);
  const [createTarget, setCreateTarget] = useState<DashboardRepository | null>(null);
  const [planTarget, setPlanTarget] = useState<{ repository: DashboardRepository; planId?: string } | null>(null);
  const [issuePlanTarget, setIssuePlanTarget] = useState<DashboardRepository | null>(null);
  const [followupTarget, setFollowupTarget] = useState<PlanSummary | null>(null);
  const [search, setSearch] = useState("");
  const [collapsedBoardColumns, setCollapsedBoardColumns] = useState<Set<string>>(initialCollapsedBoardColumns);
  // The counts line points at the rail rather than repeating its rows, so
  // "3 stuck" is a way to reach the three tasks instead of a second number.
  const attentionRef = useRef<HTMLElement | null>(null);
  const load = useCallback(async (refresh = false, refreshGitHub = false) => {
    const query = [refresh && "refresh=1", refreshGitHub && "github=1"].filter(Boolean).join("&");
    try { setDashboard(normalizeDashboard(await request<Dashboard>(`/api/worktree-dashboard${query ? `?${query}` : ""}`))); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Worktree dashboard unavailable"); }
  }, []);
  const loadGoalPlans = useCallback(async () => {
    try {
      // `health=1` is what carries the sweep verdict on each row. Without it a
      // launched goal whose agents died still reports "Dev in progress".
      const response = await request<{ plans: PlanSummary[] }>("/api/worktree-plans?status=all&limit=200&health=1");
      setGoalPlans(Array.isArray(response.plans) ? response.plans : []);
      setGoalError("");
    } catch (cause) { setGoalError(cause instanceof Error ? cause.message : "Saved goals unavailable"); }
  }, []);
  // The sweep is the only thing that knows a launched agent died. It is read
  // only, so a failure leaves the last verdict on screen rather than clearing
  // the rail and implying that nothing needs a person.
  const loadHealth = useCallback(async () => {
    try {
      const sweep = await request<GoalHealthSweep>("/api/goals/health");
      setHealth({ ...sweep, goals: Array.isArray(sweep.goals) ? sweep.goals : [], summary: sweep.summary || emptyHealthSummary() });
      setHealthError("");
    } catch (cause) { setHealthError(cause instanceof Error ? cause.message : "Goal supervision unavailable"); }
  }, []);
  // The dry run. It closes nothing, so a failure leaves the last count on
  // screen rather than claiming that nothing is finished.
  const loadRetirable = useCallback(async () => {
    try { setRetirable(await request<SessionReapReport>("/api/goals/sessions/retirable")); }
    catch { /* The last honest count stays. A zero here would invite a pass that closes sessions. */ }
  }, []);
  // Which provider takes the next task. `refresh=1` re-reads CCS itself, which
  // is slow, so only the explicit GitHub refresh asks for it.
  const loadCapacity = useCallback(async (refresh = false) => {
    try {
      const snapshot = await request<AgentCapacity>(`/api/goals/capacity${refresh ? "?refresh=1" : ""}`);
      // A payload without providers is not a capacity answer. Showing an empty
      // strip would read as "no quota anywhere", which is the opposite verdict.
      if (!Array.isArray(snapshot?.providers)) throw new Error("Agent capacity is unavailable");
      setCapacity(snapshot);
      setCapacityError("");
    } catch (cause) { setCapacityError(cause instanceof Error ? cause.message : "Agent capacity unavailable"); }
  }, []);
  // The stored issue column. This is a read of the last sync only: it never
  // touches GitHub, so it is safe on mount and stays off the sync's slow path.
  const loadIssues = useCallback(async () => {
    try {
      const payload = await request<GitHubIssueColumnPayload>("/api/github-issues");
      setIssueCards(Array.isArray(payload?.issues) ? payload.issues : []);
    } catch {
      // A failed read leaves the last cards on screen. The column is evidence
      // of the last sync, so emptying it would state something untrue.
    }
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
  // The sweep is only worth its cmux round-trip while the board is on screen,
  // so it follows the board tab rather than the dashboard's own poll.
  const boardView = dashboardFilter === "goals-board";
  useEffect(() => {
    if (!boardView) return;
    // The server now syncs the issue column on its own schedule, so a board
    // left open must re-read it. The source changes about once an hour, so the
    // column keeps a slow clock of its own instead of the ten-second poll.
    const kickoff = setTimeout(() => { void loadHealth(); void loadCapacity(); void loadRetirable(); void loadIssues(); }, 0);
    const poll = setInterval(() => { if (document.visibilityState === "visible") { void loadHealth(); void loadCapacity(); void loadRetirable(); } }, 10_000);
    const issuePoll = setInterval(() => { if (document.visibilityState === "visible") void loadIssues(); }, 60_000);
    return () => { clearTimeout(kickoff); clearInterval(poll); clearInterval(issuePoll); };
  }, [boardView, loadCapacity, loadHealth, loadRetirable, loadIssues]);
  // One second, and only while the strip is on screen. A reset countdown that
  // moves in ten-second jumps reads as broken.
  useEffect(() => {
    if (!boardView) return;
    const tick = setInterval(() => { if (document.visibilityState === "visible") setNowTick(Date.now()); }, 1_000);
    return () => clearInterval(tick);
  }, [boardView]);

  // The shell is capped at 1500px so prose and forms stay readable. A board of
  // parallel work is the opposite problem: it wants every pixel of a wide
  // screen. The flag lives on the document because the shell is an ancestor of
  // this component, so only CSS can reach it from here.
  useEffect(() => {
    document.body.classList.toggle("board-wide", boardView);
    return () => document.body.classList.remove("board-wide");
  }, [boardView]);
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
    // The dashboard request reconciles the goal pull requests on the server.
    // The plan list must be fetched after it, so the cards read the lifecycle
    // the refresh just recorded. A parallel pair would read the old one.
    try { await load(true, true); await loadGoalPlans(); await loadHealth(); await loadCapacity(true); }
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

  // Abort is terminal, so the card is moved by the reloaded list rather than
  // by an optimistic write. A partial failure keeps the goal aborted and names
  // the sessions cmux refused to close.
  async function abortGoal(plan: PlanSummary) {
    setAbortingGoalId(plan.planId); setGoalError("");
    try {
      const result = await request<AbortResult>(`/api/worktree-plans/${encodeURIComponent(plan.planId)}/abort`, { method: "POST", body: "{}" });
      await loadGoalPlans();
      setConfirmAbortGoalId("");
      const failed = Array.isArray(result.failedSessionIds) ? result.failedSessionIds.length : 0;
      // Abort is idempotent on the server, so it is safe to run again. The
      // card itself is terminal now, so the message names the other way in.
      if (failed) setGoalError(`Aborted this goal, but ${failed} cmux session${failed === 1 ? "" : "s"} could not be closed. Abort is safe to retry, and those sessions can also be closed from their worktree cards.`);
      else onNotice(`Aborted goal from ${plan.repositoryName}. Branches and worktrees were kept.`);
    } catch (cause) { setGoalError(cause instanceof Error ? cause.message : "Could not abort this goal"); }
    finally { setAbortingGoalId(""); }
  }

  // Every board action runs through one key: `${verb}:${planId}:${taskId}`.
  // The key is deleted in `finally`, so a failed request never strands a row.
  async function runBoardAction(key: string, work: () => Promise<void>) {
    setBoardBusy((current) => ({ ...current, [key]: true }));
    try { await work(); }
    finally { setBoardBusy((current) => { const next = { ...current }; delete next[key]; return next; }); }
  }

  // The one caller of /api/workspaces/:id/select. It only focuses the cmux
  // desktop app, so a failure is a notice and never blocks the card.
  async function focusWorkspace(workspaceId: string, label: string) {
    await runBoardAction(`focus:${workspaceId}`, async () => {
      try { await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/select`, { method: "POST", body: "{}" }); onNotice(`Focused ${label} in cmux`); }
      catch (cause) { onNotice(cause instanceof Error ? cause.message : `Could not focus ${label} in cmux`); }
    });
  }

  // `continue` keeps the worktree and everything the agent already wrote.
  // `restart` discards the branch and the worktree, so its button confirms.
  async function relaunchTask(goal: HealthGoal, task: HealthTask, mode: "continue" | "restart" | "rebranch") {
    setRelaunchModes((current) => ({ ...current, [`relaunch:${goal.planId}:${task.id}`]: mode }));
    await runBoardAction(`relaunch:${goal.planId}:${task.id}`, async () => {
      try {
        // A crashed agent usually leaves its workspace open at a shell prompt.
        // Closing it here saves the trip to cmux and back, but only for a task
        // the sweep has already judged stuck: a session that is still working
        // must never be killed by a button labelled Continue.
        const closeLive = Boolean(task.session) && task.health !== "working" && task.health !== "needs_you";
        const result = await request<TaskRelaunchResult>(`/api/worktree-plans/${encodeURIComponent(goal.planId)}/tasks/${encodeURIComponent(task.id)}/relaunch`, { method: "POST", body: JSON.stringify({ mode, closeLive }) });
        setConfirmTaskAction("");
        await request<PlanDraft>(`/api/worktree-plans/${encodeURIComponent(goal.planId)}`);
        await loadHealth(); await loadGoalPlans();
        onNotice(mode === "rebranch" ? (result.branch ? `Retried ${task.title} on ${result.branch}` : `Retried ${task.title} on a fresh branch`) : mode === "restart" ? `Restarted ${task.title} from its base branch` : `Continued ${task.title} in its existing worktree`);
      } catch (cause) { onNotice(cause instanceof Error ? cause.message : `Could not relaunch ${task.title}`); }
    });
  }

  // "Is this actually merged?" answered for one goal. The call refreshes GitHub
  // first, so it is slow: only that one button shows a busy label, and the
  // notice distinguishes moved / still open / GitHub knows nothing.
  async function checkMerge(plan: PlanSummary) {
    await runBoardAction(`checkmerge:${plan.planId}`, async () => {
      try {
        const result = await request<MergeCheck>(`/api/worktree-plans/${encodeURIComponent(plan.planId)}/check-merge`, { method: "POST" });
        await loadGoalPlans();
        if (result.changed || result.boardStatus === "merged") onNotice(`${plan.goal} is merged. It moved to Merged.`);
        else if (result.pullRequest) onNotice(`${plan.goal} is still open on GitHub (PR #${result.pullRequest.number}). Nothing moved.`);
        else onNotice(`GitHub knows no pull request for this goal's branch. It may never have been pushed.`);
      } catch (cause) { onNotice(cause instanceof Error ? cause.message : `Could not check ${plan.goal} against GitHub`); }
    });
  }

  async function launchFollowup(plan: PlanSummary, submission: FollowupSubmission) {
    await runBoardAction(`followup:${plan.planId}`, async () => {
      const result = await request<FollowupResult>(`/api/worktree-plans/${encodeURIComponent(plan.planId)}/followups`, { method: "POST", body: JSON.stringify(submission) });
      setFollowupTarget(null);
      await loadGoalPlans();
      const agent = result.agent.slice(0, 1).toUpperCase() + result.agent.slice(1);
      onNotice(`Started ${result.actions.length} follow-up action${result.actions.length === 1 ? "" : "s"} for ${plan.goal} with ${agent}.`);
    });
  }

  // Skipping drops one task so its goal can assemble without it. The reason is
  // recorded, so the plan says later why a task is missing from the merge.
  async function skipTask(goal: HealthGoal, task: HealthTask) {
    await runBoardAction(`skip:${goal.planId}:${task.id}`, async () => {
      try {
        await request(`/api/worktree-plans/${encodeURIComponent(goal.planId)}/tasks/${encodeURIComponent(task.id)}/skip`, { method: "POST", body: JSON.stringify({ reason: task.reason || `Skipped from the attention rail while ${task.health}` }) });
        setConfirmTaskAction("");
        await loadHealth(); await loadGoalPlans();
        onNotice(`Skipped ${task.title}. It no longer blocks this goal's merge.`);
      } catch (cause) { onNotice(cause instanceof Error ? cause.message : `Could not skip ${task.title}`); }
    });
  }

  // "Close the sessions that are finished", forced. The server owns the rule
  // about which session may close; this only runs the pass and reports it. The
  // refresh afterwards matches Refresh GitHub's order, because closing a
  // session changes the dashboard, the plan rows and the sweep alike.
  async function closeFinishedSessions() {
    await runBoardAction("reap", async () => {
      try {
        const report = await request<SessionReapReport>("/api/goals/sessions/reap", { method: "POST", body: "{}" });
        await load(true); await loadGoalPlans(); await loadHealth(); await loadRetirable();
        onNotice(sessionReapNotice(report));
      } catch (cause) { onNotice(cause instanceof Error ? cause.message : "Could not close the finished goal sessions"); }
    });
  }

  // GitHub Sync. It reads every starred repository through `gh`, which is slow,
  // so it is its own button with its own busy label and never joins the
  // ten-second dashboard poll behind Refresh GitHub.
  async function syncGitHubIssues() {
    setIssueSyncing(true);
    try {
      const result = await request<GitHubIssueSyncResult>("/api/github-issues/sync", { method: "POST" });
      setIssueCards(Array.isArray(result?.issues) ? result.issues : []);
      // A sync with nothing to read must say why. Silence would read as a
      // button that does nothing.
      if (result?.status === GITHUB_ISSUE_SYNC_NO_FAVORITES) {
        const message = result.message || "No starred repositories. Star a repository first; GitHub Sync reads starred repositories only.";
        setIssueNotice(message);
        onNotice(message);
        return;
      }
      const failed = (Array.isArray(result?.repositories) ? result.repositories : []).filter((repository) => repository.status !== "ok");
      if (failed.length) {
        const message = `GitHub Sync could not read ${failed.length} starred repositor${failed.length === 1 ? "y" : "ies"}: ${failed.map((repository) => `${repository.name} (${repository.error || "unknown error"})`).join("; ")}`;
        setIssueNotice(message);
        onNotice(message);
        return;
      }
      setIssueNotice("");
      onNotice(`GitHub Sync read ${result.issues.length} open issue${result.issues.length === 1 ? "" : "s"}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "GitHub Sync failed";
      setIssueNotice(message);
      onNotice(message);
    } finally { setIssueSyncing(false); }
  }

  // One issue becomes one goal plan. The plan lands in Writing Spec, so the
  // goal list is re-read after the call rather than guessed at locally.
  async function startIssueGoal(issue: GitHubIssueCard) {
    await runBoardAction(githubIssueCardId(issue), async () => {
      try {
        const result = await request<GitHubIssueGoalResult>(`/api/github-issues/${encodeURIComponent(issue.repositoryId)}/${issue.number}/goal`, { method: "POST" });
        setIssueCards((cards) => cards.map((card) => (
          card.repositoryId === issue.repositoryId && card.number === issue.number ? { ...card, planId: result?.issue?.planId ?? card.planId } : card
        )));
        await loadGoalPlans();
        setIssueNotice("");
        onNotice(result?.created === false
          ? `Issue #${issue.number} already has a goal. Nothing new was created.`
          : `Started a goal for issue #${issue.number}. It is in Writing Spec.`);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : `Could not start a goal for issue #${issue.number}`;
        setIssueNotice(message);
        onNotice(message);
      }
    });
  }

  const isBoardView = dashboardFilter === "goals-board";
  const allRepositories = dashboard?.repositories || [];
  const rootProjectRepositories = allRepositories.filter((repo) => (projectFor(repo.root) || projectFor(repo.path)) === project);
  const boardProjectRepositories = allRepositories.filter((repo) => boardProject === "all" || (projectFor(repo.root) || projectFor(repo.path)) === boardProject);
  const projectRepositories = isBoardView ? boardProjectRepositories : rootProjectRepositories;
  const projectRepositoryIds = new Set(projectRepositories.map((repo) => repo.id));
  const projectPlans = goalPlans.filter((plan) => projectRepositoryIds.has(plan.repositoryId));
  const rootProjectRepositoryIds = new Set(rootProjectRepositories.map((repo) => repo.id));
  const rootProjectPlans = goalPlans.filter((plan) => rootProjectRepositoryIds.has(plan.repositoryId));
  // A favorite stays in Active even with no session, so both the tab badge and
  // the list read the same rule.
  const isActiveRepository = (repo: DashboardRepository) => !repo.archived && (repo.favorite === true || repo.summary.sessions > 0);
  const repositoryCounts = {
    active: projectRepositories.filter(isActiveRepository).length,
    inactive: projectRepositories.filter((repo) => !repo.archived && repo.favorite !== true && repo.summary.sessions === 0).length,
    archived: projectRepositories.filter((repo) => repo.archived).length,
  };
  // Draft and Launched stay exactly as they were: membership and counts read
  // `plan.status`. Only the board reads the lifecycle.
  const goalCounts = {
    "draft-goals": rootProjectPlans.filter((plan) => plan.status === "draft").length,
    "launched-goals": rootProjectPlans.filter((plan) => plan.status === "launched").length,
    "goals-board": projectPlans.length,
  };
  // A goal keeps planning after its sheet closes, so the tab carries the count
  // of rounds running right now across every repository in this project.
  const planningCount = rootProjectPlans.filter((plan) => plan.running).length;
  // An archived repository takes no new goals, so it never reaches the picker.
  const goalRepositories = projectRepositories.filter((repo) => !repo.archived);
  // A flat list of every repository is unusable once there are thirty of them.
  // With no search term the picker offers only the ones the user actually works
  // in — favourites and anything with a live session — and says how many more a
  // search would reach. A search term reaches all of them.
  const newGoalNeedle = newGoalQuery.trim().toLowerCase();
  const newGoalShortlist = goalRepositories.filter((repo) => repo.favorite === true || repo.summary.sessions > 0);
  const newGoalMatches = (newGoalNeedle
    ? goalRepositories.filter((repo) => repo.name.toLowerCase().includes(newGoalNeedle) || compactPath(repo.path).toLowerCase().includes(newGoalNeedle))
    // A project with no favourite and no live session would otherwise open an
    // empty picker, which reads as broken rather than as "start typing".
    : (newGoalShortlist.length ? newGoalShortlist : goalRepositories)
  ).slice(0, 12);
  const isGoalView = dashboardFilter === "draft-goals" || dashboardFilter === "launched-goals" || isBoardView;
  // The search box sits in the shared header, so one query narrows whichever
  // list the current tab shows.
  const query = search.trim().toLowerCase();
  const repositoryMatchesQuery = (repo: DashboardRepository) => !query || repo.name.toLowerCase().includes(query) || compactPath(repo.path).toLowerCase().includes(query);
  const planMatchesQuery = (plan: PlanSummary) => !query || plan.goal.toLowerCase().includes(query) || plan.repositoryName.toLowerCase().includes(query);
  // One query narrows the whole board, so the issue column reads the same
  // `query` as the goal columns. Every field is repository content that can be
  // missing or null, so each access is guarded rather than trusted.
  const issueMatchesQuery = (issue: GitHubIssueCard) => {
    if (!query) return true;
    const text = [issue?.title, issue?.repositoryName, ...(Array.isArray(issue?.labels) ? issue.labels : [])];
    if (text.some((field) => typeof field === "string" && field.toLowerCase().includes(query))) return true;
    const number = Number(issue?.number);
    if (!Number.isInteger(number)) return false;
    // A person types either `42` or `#42`; both name the same issue.
    return String(number).includes(query) || `#${number}`.includes(query);
  };
  // A started issue is already on the board as its goal card, so it leaves the
  // issue column. The plan ids come from the UNSCOPED goal list: picking one
  // project must narrow the goal columns, never make a started issue reappear
  // in the issue column beside them.
  const knownPlanIds = new Set(goalPlans.map((plan) => plan.planId));
  // The goal filter runs first, so a search can only narrow what is already on
  // the board. The header count and the "No issue matches" fallback both read
  // this array, never the raw `issueCards`.
  const unstartedIssueCards = visibleGithubIssues(issueCards, knownPlanIds) as GitHubIssueCard[];
  const visibleIssueCards = unstartedIssueCards.filter(issueMatchesQuery);
  const visiblePlans = !isGoalView ? []
    : isBoardView ? projectPlans.filter(planMatchesQuery)
      : projectPlans.filter((plan) => plan.status === (dashboardFilter === "draft-goals" ? "draft" : "launched")).filter(planMatchesQuery);
  // groupGoalsByBoardState supplies every column, including the empty ones.
  // The cards are then placed by the server's `boardState`, with the shared
  // derivation as the fallback for a payload that carries none.
  const boardGroups = groupGoalsByBoardState([]) as Record<GoalBoardStateId, PlanSummary[]>;
  if (isBoardView) for (const plan of visiblePlans) boardGroups[boardStateOf(plan)].push(plan);
  // The default All scope makes every live goal and attention item visible.
  // Choosing one project narrows the counters and rail with the cards, so the
  // header can never say "2 working" above a board that only contains one.
  const scopedHealthGoals = (health?.goals || []).filter((goal) => projectRepositoryIds.has(goal.repositoryId));
  const healthByPlanId = new Map(scopedHealthGoals.map((goal) => [goal.planId, goal]));
  const attentionRows = scopedHealthGoals.flatMap((goal) => [
    ...goal.tasks.filter((task) => ATTENTION_HEALTH.has(task.health)).map((task) => ({ goal, item: task, kind: "task" as const })),
    ...(goal.merge && ATTENTION_HEALTH.has(goal.merge.health) ? [{ goal, item: goal.merge, kind: "merge" as const }] : []),
  ]);
  const healthSummary = summarizeHealthGoals(scopedHealthGoals);
  // This number describes cmux, so it comes from the live dashboard snapshot,
  // not from durable workspace ids that can outlive a closed session.
  const boardLiveSessions = boardProject === "all"
    ? dashboard?.summary.sessions || 0
    : projectRepositories.reduce((total, repository) => total + repository.summary.sessions, 0);
  // The dry run counts every plan the server supervises, exactly like the pass
  // the button runs. An unreachable cmux closes nothing, so it counts as zero
  // and the button is disabled rather than hidden.
  const retirableCount = retirable?.sessionsAvailable ? retirable.closed.length : 0;
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
    { id: "goals-board", label: "Goals board", count: goalCounts["goals-board"] },
  ];
  // Every goal tab needs its own words. A draft/launched ternary would label
  // the board as launched, so the three views name themselves here once.
  const goalNoun = dashboardFilter === "draft-goals" ? "goal" : "launch";
  const goalHeroHeading = visiblePlans.length
    ? `${visiblePlans.length} ${goalNoun}${visiblePlans.length === 1 ? "" : dashboardFilter === "draft-goals" ? "s" : "es"} ${dashboardFilter === "draft-goals" ? "ready to resume." : "on record."}`
    : `No ${dashboardFilter === "draft-goals" ? "draft " : "launched "}goals yet.`;
  const goalHeadingTitle = dashboardFilter === "draft-goals" ? "draft goals" : "launched goals";
  // A count that names a problem must lead to it. Scrolling the rail into view
  // and focusing its heading works for a mouse and for a screen reader alike.
  const focusAttentionRail = () => { const rail = attentionRef.current; if (!rail) return; rail.scrollIntoView({ behavior: "smooth", block: "start" }); rail.focus(); };
  const toggleBoardColumn = (id: string) => {
    setCollapsedBoardColumns((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      try {
        localStorage.setItem(BOARD_COLUMN_PREFERENCE_KEY, JSON.stringify(Object.fromEntries(ALL_BOARD_COLUMN_IDS.map((columnId) => [columnId, !next.has(columnId)]))));
      } catch { /* The toggle still works when storage is unavailable. */ }
      return next;
    });
  };
  return <>
    <WorktreeCleanupPanel />
    {/* The board is a working screen, not a landing page: its own header is one
        bar, so the first Kanban card is visible without scrolling. Every other
        view keeps the hero it was written for. */}
    {!isBoardView && <section className="hero worktree-hero"><p className="eyebrow">BETA · PARALLEL WORK</p><h1>{isGoalView ? goalHeroHeading : visibleNeedsYou ? `${visibleNeedsYou} agent${visibleNeedsYou > 1 ? "s" : ""} need you.` : visibleWorking ? "Your workstreams are moving." : "Worktrees at a glance."}</h1><p>{isBoardView ? "Follow every goal in this project through its eight lifecycle states." : isGoalView ? "Resume plans and inspect launches across every repository in this project." : "Supervise isolated branches, agents, changes, and pull requests without watching every terminal."}</p><div className="summary-row">{isGoalView ? <><div><strong>{dashboard ? visiblePlans.length : "–"}</strong><span>goals</span></div><div><strong className="accent-number">{dashboard ? goalTaskCount : "–"}</strong><span>tasks</span></div><div><strong>{dashboard ? goalRepositoryCount : "–"}</strong><span>repositories</span></div></> : <><div><strong>{dashboard ? visibleWorktrees.length : "–"}</strong><span>worktrees</span></div><div><strong>{dashboard ? visibleReleases.length : "–"}</strong><span>releases</span></div><div><strong className="accent-number">{dashboard ? visibleNeedsYou : "–"}</strong><span>needs you</span></div><div><strong>{dashboard ? visibleWorking : "–"}</strong><span>working</span></div></>}</div></section>}
    <section className="content-section worktree-content">
      {!isBoardView && <div className="worktree-project-tabs" role="tablist" aria-label="Project"><button role="tab" aria-selected={project === "karven"} className={project === "karven" ? "active" : ""} onClick={() => setProject("karven")}><span>K</span>Karven</button><button role="tab" aria-selected={project === "rekord"} className={project === "rekord" ? "active" : ""} onClick={() => setProject("rekord")}><span>R</span>Rekord</button></div>}
      {isBoardView && <div className="board-bar"><div className="worktree-project-tabs" role="tablist" aria-label="Project"><button role="tab" aria-selected={boardProject === "all"} className={boardProject === "all" ? "active" : ""} onClick={() => setBoardProject("all")}><span aria-hidden="true">∞</span>All</button><button role="tab" aria-selected={boardProject === "karven"} className={boardProject === "karven" ? "active" : ""} onClick={() => setBoardProject("karven")}><span aria-hidden="true">K</span>Karven</button><button role="tab" aria-selected={boardProject === "rekord"} className={boardProject === "rekord" ? "active" : ""} onClick={() => setBoardProject("rekord")}><span aria-hidden="true">R</span>Rekord</button></div><div className="dashboard-search"><input type="search" aria-label="Search projects" placeholder="Search projects" value={search} onChange={(event) => setSearch(event.target.value)} />{search !== "" && <button type="button" className="dashboard-search-clear" aria-label="Clear the project search" onClick={() => setSearch("")}>×</button>}</div><AgentCapacityChip capacity={capacity} error={capacityError} now={nowTick} open={capacityOpen} onToggle={() => setCapacityOpen((open) => !open)} />{goalRepositories.length > 0 && <div className="board-new-goal"><button type="button" className="board-new-goal-button" aria-label={goalRepositories.length === 1 ? `Plan a goal for ${goalRepositories[0].name}` : "Plan a new goal"} aria-expanded={goalRepositories.length === 1 ? undefined : newGoalOpen} aria-haspopup={goalRepositories.length === 1 ? undefined : "menu"} onClick={() => { if (goalRepositories.length === 1) setPlanTarget({ repository: goalRepositories[0] }); else setNewGoalOpen((open) => !open); }}>＋ New goal</button>{newGoalOpen && goalRepositories.length > 1 && <><button type="button" className="board-new-goal-backdrop" aria-label="Close the repository picker" onClick={() => { setNewGoalOpen(false); setNewGoalQuery(""); }} /><div className="board-new-goal-menu" aria-label="Pick a repository for the new goal">{/* eslint-disable-next-line jsx-a11y/no-autofocus -- the picker opens for typing: a search box nobody can type into is the problem this replaced */}
        <input type="search" autoFocus aria-label="Find a repository" placeholder="Find a repository…" value={newGoalQuery} onChange={(event) => setNewGoalQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setNewGoalOpen(false); setNewGoalQuery(""); } if (event.key === "Enter" && newGoalMatches.length > 0) { setNewGoalOpen(false); setNewGoalQuery(""); setPlanTarget({ repository: newGoalMatches[0] }); } }} />{newGoalMatches.length === 0 ? <p className="board-new-goal-empty">No repository matches that.</p> : <div role="menu">{newGoalMatches.map((repo) => <button type="button" role="menuitem" aria-label={`Plan a goal for ${repo.name}`} onClick={() => { setNewGoalOpen(false); setNewGoalQuery(""); setPlanTarget({ repository: repo }); }} key={repo.id}><RepoChip name={repo.name} />{repo.summary.sessions > 0 && <em>{repo.summary.sessions} session{repo.summary.sessions === 1 ? "" : "s"}</em>}</button>)}</div>}{newGoalQuery === "" && goalRepositories.length > newGoalMatches.length && <p className="board-new-goal-empty">Type to reach the other {goalRepositories.length - newGoalMatches.length}.</p>}</div></>}</div>}<button className="text-button" disabled={issueSyncing} onClick={() => { void syncGitHubIssues(); }}>{issueSyncing ? "Syncing GitHub issues…" : "GitHub Sync"}</button><button className="text-button" disabled={busy !== ""} onClick={() => { void refreshGitHub(); }}>{busy === "github" ? "Refreshing GitHub…" : "Refresh GitHub"}</button><button type="button" className="text-button board-reap-button" disabled={boardBusy.reap === true || retirableCount === 0} aria-label={retirableCount === 0 ? "Close finished sessions. No sessions currently qualify for safe cleanup." : `Close ${retirableCount} finished session${retirableCount === 1 ? "" : "s"}`} onClick={() => { void closeFinishedSessions(); }}>{boardBusy.reap === true ? "Closing finished sessions…" : `Close finished sessions (${retirableCount})`}</button></div>}
      {/* Stuck and needs-you are the only two numbers here a person acts on, so
          they are the two that reach the rail. The rest are read-only totals. */}
      {isBoardView && <div className="board-counts">{healthSummary.stuck > 0 ? <button type="button" className="attention" aria-label={`${healthSummary.stuck} stuck goals. Show the tasks that need you`} onClick={focusAttentionRail}><b>{healthSummary.stuck}</b>stuck</button> : <span aria-label="0 stuck goals"><b>0</b>stuck</span>}{healthSummary.needsYou > 0 ? <button type="button" className="attention" aria-label={`${healthSummary.needsYou} goals need you. Show the tasks that need you`} onClick={focusAttentionRail}><b>{healthSummary.needsYou}</b>needs you</button> : <span aria-label="0 goals need you"><b>0</b>needs you</span>}<span aria-label={`${healthSummary.working} goals working`}><b>{healthSummary.working}</b>working</span><span aria-label={`${boardLiveSessions} live cmux sessions`}><b>{boardLiveSessions}</b>sessions</span>{dashboard && <small>{visiblePlans.length} shown · {projectPlans.length} total · {dashboard.github?.checkedAt ? `GitHub checked ${githubCheckedTime(dashboard.github.checkedAt)}${dashboard.github.status === "partial" ? " · partial" : ""}` : "GitHub refresh is manual"}</small>}</div>}
      <div className={`worktree-filter-tabs${isBoardView ? " quiet" : ""}`} role="tablist" aria-label="Project status">{filterTabs.map((filter) => <button role="tab" aria-selected={dashboardFilter === filter.id} className={`${GOAL_FILTERS.has(filter.id) ? "goal-tab" : ""}${dashboardFilter === filter.id ? " active" : ""}`.trim()} onClick={() => setDashboardFilter(filter.id)} key={filter.id}>{filter.label} <b>{filter.count}</b>{filter.planning ? <i className="tab-planning" aria-label={`${filter.planning} planning`}>{filter.planning} planning</i> : null}</button>)}</div>
      {!isBoardView && <div className="section-heading"><div><h2>{project === "karven" ? "Karven" : "Rekord"} {isGoalView ? goalHeadingTitle : "projects"}</h2>{dashboard && <p>{isGoalView ? `${visiblePlans.length} shown · ${projectPlans.length} total goals` : `${visibleRepositories.length} shown · ${projectRepositories.length} total`} · {dashboard.github?.checkedAt ? `GitHub checked ${githubCheckedTime(dashboard.github.checkedAt)}${dashboard.github.status === "partial" ? " · partial" : ""}` : "GitHub refresh is manual"}</p>}</div><div className="dashboard-search"><input type="search" aria-label="Search projects" placeholder="Search projects" value={search} onChange={(event) => setSearch(event.target.value)} />{search !== "" && <button type="button" className="dashboard-search-clear" aria-label="Clear the project search" onClick={() => setSearch("")}>×</button>}</div><button className="text-button" disabled={busy !== ""} onClick={() => { void refreshGitHub(); }}>{busy === "github" ? "Refreshing GitHub…" : "Refresh GitHub"}</button></div>}
      {error && <div className="apps-warning">{error}<button onClick={() => load(true)}>Retry</button></div>}
      {isBoardView && issueNotice && <div className="apps-warning">{issueNotice}<button onClick={() => setIssueNotice("")}>Dismiss</button></div>}
      {isGoalView && goalError && <div className="apps-warning">{goalError}<button onClick={loadGoalPlans}>Retry</button></div>}
      {!dashboard && !error && <WorktreeSkeleton />}
      {!isGoalView && dashboard && dashboard.repositories.length === 0 && <div className="empty-card"><span>⑂</span><strong>No Git worktrees found</strong><p>Add repositories in the companion settings, then refresh this beta dashboard.</p></div>}
      {!isGoalView && dashboard && dashboard.repositories.length > 0 && visibleRepositories.length === 0 && visibleOrphans.length === 0 && (query
        ? <div className="empty-card filtered-empty"><span>⌕</span><strong>No project matches “{search.trim()}”</strong><p>Clear the search to see every {dashboardFilter} project again.</p><button type="button" className="text-button" onClick={() => setSearch("")}>Clear search</button></div>
        : <div className="empty-card filtered-empty"><span>{dashboardFilter === "archived" ? "□" : dashboardFilter === "active" ? "◌" : "✓"}</span><strong>No {dashboardFilter} {project === "karven" ? "Karven" : "Rekord"} projects</strong><p>{dashboardFilter === "archived" ? "Projects you archive will appear here." : dashboardFilter === "active" ? "Projects appear here as soon as they have a cmux session or you favorite them." : "Every non-archived project currently has a session or is favorited."}</p></div>)}
      {!isGoalView && <div className="worktree-repositories">{visibleRepositories.map((repo) => <details className="worktree-repository" open key={repo.id}><summary><span className="repo-icon">{repo.name.slice(0, 1).toUpperCase()}</span><div><strong>{repo.name}</strong><small>{repo.summary.worktrees} worktree{repo.summary.worktrees === 1 ? "" : "s"} · {repo.summary.sessions} session{repo.summary.sessions === 1 ? "" : "s"}{repo.summary.releases > 0 ? ` · ${repo.summary.releases} release${repo.summary.releases === 1 ? "" : "s"}` : ""}</small></div>{repo.summary.needsYou > 0 && <em>{repo.summary.needsYou} need you</em>}{!repo.archived && <button type="button" className="repo-create-worktree" aria-label={`Create worktree for ${repo.name}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setCreateTarget(repo); }}>＋ Worktree</button>}{!repo.archived && <button type="button" className="repo-plan-issues" aria-label={`Plan GitHub issues for ${repo.name}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setIssuePlanTarget(repo); }}>GitHub Issues</button>}{!repo.archived && <button type="button" className="repo-plan-goal" aria-label={`Plan a goal for ${repo.name}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setPlanTarget({ repository: repo }); }}>Plan a goal</button>}{!repo.archived && <button type="button" className="repo-remove-clean" aria-label={`Remove clean worktrees in ${repo.name}`} disabled={bulkRemovableWorktrees(repo).length === 0 || busy === `repo:${repo.id}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setBulkTarget(repo); }}>Remove clean ({bulkRemovableWorktrees(repo).length})</button>}<button type="button" className={`repo-favorite-button${repo.favorite ? " favorited" : ""}`} aria-label={`${repo.favorite ? "Unfavorite" : "Favorite"} ${repo.name}`} aria-pressed={repo.favorite === true} disabled={busy === `repo:${repo.id}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void setFavorite(repo, repo.favorite !== true); }}>{repo.favorite ? "★" : "☆"}</button><button type="button" className="repo-archive-button" aria-label={`${repo.archived ? "Unarchive" : "Archive"} ${repo.name}`} disabled={busy === `repo:${repo.id}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void setArchived(repo, !repo.archived); }}>{busy === `repo:${repo.id}` ? "…" : repo.archived ? "Unarchive" : "Archive"}</button><b>⌄</b></summary><div className="worktree-list">{repo.worktrees.map((worktree) => <WorktreeCard worktree={worktree} busy={busy} confirming={confirmRemoval?.id === worktree.id ? confirmRemoval.stage : null} error={actionError?.id === worktree.id ? actionError.message : ""} onOpenWorkspace={onOpenWorkspace} onCloseSession={closeSession} onRequestRemove={(stage) => { setActionError(null); setConfirmRemoval({ id: worktree.id, stage }); }} onCancelRemove={() => setConfirmRemoval(null)} onRemoveWorktree={removeWorktree} onLaunch={() => setLaunchTarget({ repo, worktree })} key={worktree.id} />)}</div>{repo.releases.length > 0 && <DeploymentReleases releases={repo.releases} />}</details>)}</div>}
      {isGoalView && !isBoardView && dashboard && visiblePlans.length === 0 && !goalError && query && <div className="empty-card filtered-empty"><span>⌕</span><strong>No goal matches “{search.trim()}”</strong><p>Clear the search to see every goal again.</p><button type="button" className="text-button" onClick={() => setSearch("")}>Clear search</button></div>}
      {isGoalView && !isBoardView && dashboard && visiblePlans.length === 0 && !goalError && !query && <div className="empty-card filtered-empty"><span>{dashboardFilter === "draft-goals" ? "◇" : "✓"}</span><strong>No {dashboardFilter === "draft-goals" ? "draft" : "launched"} {project === "karven" ? "Karven" : "Rekord"} goals</strong><p>{dashboardFilter === "draft-goals" ? "New and interrupted plans will appear here." : "Goals appear here after their worktree sessions are launched."}</p></div>}
      {isGoalView && !isBoardView && <section className="worktree-goals" aria-label={dashboardFilter === "draft-goals" ? "Draft goals" : "Launched goals"}>{visiblePlans.map((plan) => { const repo = projectRepositories.find((item) => item.id === plan.repositoryId); if (!repo) return null; const closed = terminalStatus(plan); return <article className={`worktree-goal-card ${closed || (plan.running ? "planning" : plan.status)}`} key={plan.planId}><header><span className="repo-icon">{repo.name.slice(0, 1).toUpperCase()}</span><div><strong>{plan.goal}</strong><small>{repo.name}</small></div><em>{closed === "merged" ? "Merged" : closed === "aborted" ? "Aborted" : plan.running ? "Planning…" : plan.launching ? "Launching…" : plan.status === "draft" ? "Draft" : "Launched"}</em></header><div className="worktree-goal-meta"><span>{closed ? closed === "merged" ? "The goal pull request is merged" : "Stopped. Branches and worktrees were kept." : plan.running ? plan.runStep || "Reading the repository…" : plan.launching ? LAUNCHING_EVIDENCE : plan.runPhase === "failed" ? plan.runError || "The last round failed" : plan.round === 0 ? "Planning stopped before it produced anything" : plan.stage === "questions" ? `Round ${plan.round} · waiting for answers` : `${plan.taskCount} task${plan.taskCount === 1 ? "" : "s"}`}</span><span>Updated {relativePlanTime(plan.updatedAt)}</span></div>{confirmDeleteGoalId === plan.planId ? <footer className="worktree-goal-delete"><span>Delete this saved goal?</span><button type="button" aria-label={`Cancel deleting ${plan.goal}`} disabled={deletingGoalId === plan.planId} onClick={() => setConfirmDeleteGoalId("")}>Cancel</button><button type="button" className="confirm-delete" aria-label={`Confirm delete ${plan.goal}`} disabled={deletingGoalId === plan.planId} onClick={() => { void deleteGoal(plan); }}>{deletingGoalId === plan.planId ? "Deleting…" : "Confirm delete"}</button></footer> : <footer><button type="button" className="worktree-goal-open" aria-label={`${goalOpenLabel(plan)} ${plan.goal}`} onClick={() => setPlanTarget({ repository: repo, planId: plan.planId })}>{goalOpenLabel(plan)}</button><button type="button" className="worktree-goal-delete-button" aria-label={`Delete ${plan.goal}`} disabled={plan.running === true} onClick={() => setConfirmDeleteGoalId(plan.planId)}>Delete</button></footer>}</article>; })}</section>}
      {isBoardView && capacityOpen && <AgentCapacityStrip capacity={capacity} error={capacityError} now={nowTick} onRetry={() => { void loadCapacity(true); }} />}
      {isBoardView && dashboard && <AttentionRail
        railRef={attentionRef}
        rows={attentionRows}
        sessionsAvailable={health ? health.sessionsAvailable : true}
        loaded={health !== null}
        error={healthError}
        busy={boardBusy}
        confirming={confirmTaskAction}
        onRetry={() => { void loadHealth(); }}
        onRequestConfirm={setConfirmTaskAction}
        relaunchModes={relaunchModes}
        onRelaunch={(goal, task, mode) => { void relaunchTask(goal, task, mode); }}
        onSkip={(goal, task) => { void skipTask(goal, task); }}
        onFocus={(workspaceId, label) => { void focusWorkspace(workspaceId, label); }}
      />}
      {isBoardView && dashboard && <section className="goal-board" aria-label="Goals board"><section className={`goal-board-column github-issue-column${collapsedBoardColumns.has(GITHUB_ISSUE_COLUMN.id) ? " collapsed" : ""}`} aria-labelledby={`goal-board-${GITHUB_ISSUE_COLUMN.id}`}>
        {/* The count comes from the same array the list renders, so the header
            number and the cards can never disagree. */}
        <header><h3 id={`goal-board-${GITHUB_ISSUE_COLUMN.id}`}>{GITHUB_ISSUE_COLUMN.label}</h3><button type="button" className="goal-board-column-toggle" aria-label={`${collapsedBoardColumns.has(GITHUB_ISSUE_COLUMN.id) ? "Expand" : "Collapse"} ${GITHUB_ISSUE_COLUMN.label}`} aria-expanded={!collapsedBoardColumns.has(GITHUB_ISSUE_COLUMN.id)} onClick={() => toggleBoardColumn(GITHUB_ISSUE_COLUMN.id)}>{collapsedBoardColumns.has(GITHUB_ISSUE_COLUMN.id) ? "›" : "‹"}</button><b aria-label={`${visibleIssueCards.length} issue${visibleIssueCards.length === 1 ? "" : "s"} in ${GITHUB_ISSUE_COLUMN.label}`}>{visibleIssueCards.length}</b>{!collapsedBoardColumns.has(GITHUB_ISSUE_COLUMN.id) && <p>{GITHUB_ISSUE_COLUMN.description}</p>}</header>
        {!collapsedBoardColumns.has(GITHUB_ISSUE_COLUMN.id) && (visibleIssueCards.length === 0
          ? (unstartedIssueCards.length > 0
            // The column is empty because of the search, not because of the
            // sync. It says which, and offers the way back.
            ? <div className="goal-board-empty filtered-empty"><strong>No issue matches “{search.trim()}”</strong><button type="button" className="text-button" onClick={() => setSearch("")}>Clear search</button></div>
            // Nothing was hidden by the search. Either nothing was synced, or
            // every synced issue already became a goal; those read differently.
            : <p className="goal-board-empty">{issueCards.length > 0 ? GITHUB_ISSUE_ALL_STARTED_HINT : GITHUB_ISSUE_EMPTY_HINT}</p>)
          : <ul className="goal-board-cards" aria-label={`${GITHUB_ISSUE_COLUMN.label} cards`}>{visibleIssueCards.map((issue) => <li key={githubIssueCardId(issue)}><GitHubIssueBoardCard
              issue={issue}
              starting={boardBusy[githubIssueCardId(issue)] === true}
              onStart={() => { void startIssueGoal(issue); }}
            /></li>)}</ul>)}
      </section>{BOARD_COLUMNS.map((column) => { const cards = boardGroups[column.id]; const collapsed = collapsedBoardColumns.has(column.id); return <section className={`goal-board-column${collapsed ? " collapsed" : ""}`} aria-labelledby={`goal-board-${column.id}`} key={column.id}>
        <header><h3 id={`goal-board-${column.id}`}>{column.label}</h3><button type="button" className="goal-board-column-toggle" aria-label={`${collapsed ? "Expand" : "Collapse"} ${column.label}`} aria-expanded={!collapsed} onClick={() => toggleBoardColumn(column.id)}>{collapsed ? "›" : "‹"}</button><b aria-label={`${cards.length} goal${cards.length === 1 ? "" : "s"} in ${column.label}`}>{cards.length}</b>{!collapsed && <p>{column.description}</p>}</header>
        {!collapsed && (cards.length === 0
          ? <p className="goal-board-empty">No goal here yet.</p>
          : <ul className="goal-board-cards" aria-label={`${column.label} goals`}>{cards.map((plan) => { const goalHealth = healthByPlanId.get(plan.planId); const focusSessionId = liveGoalSessionId(column.id, goalHealth); return <li key={plan.planId}><GoalBoardCard
              plan={plan}
              state={column.id}
              repositoryName={projectRepositories.find((item) => item.id === plan.repositoryId)?.name || plan.repositoryName}
              tasks={goalHealth?.tasks || []}
              focusSessionId={focusSessionId}
              confirming={confirmAbortGoalId === plan.planId}
              aborting={abortingGoalId === plan.planId}
              onOpen={() => { const repo = projectRepositories.find((item) => item.id === plan.repositoryId); if (repo) setPlanTarget({ repository: repo, planId: plan.planId }); }}
              onRequestAbort={() => { setGoalError(""); setConfirmAbortGoalId(plan.planId); }}
              onCancelAbort={() => setConfirmAbortGoalId("")}
              onConfirmAbort={() => { void abortGoal(plan); }}
              checking={boardBusy[`checkmerge:${plan.planId}`] === true}
              onCheckMerge={() => { void checkMerge(plan); }}
              followupBusy={boardBusy[`followup:${plan.planId}`] === true}
              onMoreActions={() => setFollowupTarget(plan)}
              focusing={focusSessionId ? boardBusy[`focus:${focusSessionId}`] === true : false}
              onFocusWorkspace={() => { if (focusSessionId) void focusWorkspace(focusSessionId, plan.goal); }}
            /></li>; })}</ul>)}
      </section>; })}</section>}
      {visibleOrphans.length > 0 && <section className="orphan-workstreams"><header><strong>Other sessions</strong><span>Not inside a catalogued Git worktree</span></header>{visibleOrphans.map((session) => <div className="orphan-session" key={session.id}><button className="session-open" onClick={() => onOpenWorkspace(session.id)}><span className={`status-orb ${session.state.tone}`} /><div><strong>{session.title}</strong><small>{session.preview}</small></div><b>›</b></button><button className="session-close" aria-label={`Close session ${session.title}`} disabled={busy === `session:${session.id}`} onClick={() => closeSession(session)}>×</button></div>)}</section>}
    </section>
    {bulkTarget && <BulkRemoveSheet repo={bulkTarget} onClose={() => setBulkTarget(null)} onConfirm={() => removeCleanWorktrees(bulkTarget)} />}
    {launchTarget && <LaunchWorktreeSheet target={launchTarget} onClose={() => setLaunchTarget(null)} onLaunched={async (id) => { setLaunchTarget(null); await load(true); await onLaunched(id); }} onNotice={onNotice} />}
    {createTarget && <CreateWorktreeSheet repo={createTarget} onClose={() => setCreateTarget(null)} onCreated={async (workspaceId) => { setCreateTarget(null); await load(true); if (workspaceId) await onLaunched(workspaceId); }} onNotice={onNotice} />}
    {planTarget && <WorktreePlannerSheet repository={planTarget.repository} initialPlanId={planTarget.planId} onClose={() => { setPlanTarget(null); void loadGoalPlans(); }} onNotice={onNotice} />}
    {issuePlanTarget && <GitHubIssuePlannerSheet repository={issuePlanTarget} onClose={() => { setIssuePlanTarget(null); void loadGoalPlans(); }} onLaunched={async () => { await load(true); await loadGoalPlans(); }} onNotice={onNotice} />}
    {followupTarget && <FollowupSheet plan={followupTarget} busy={boardBusy[`followup:${followupTarget.planId}`] === true} onClose={() => setFollowupTarget(null)} onSubmit={(submission) => launchFollowup(followupTarget, submission)} />}
  </>;
}

// The open label never says Resume for a closed goal, and a closed goal offers
// no Abort. Both the list and the board read this one rule.
function goalOpenLabel(plan: PlanSummary) {
  if (terminalStatus(plan)) return "View";
  return plan.running ? "Watch" : plan.status === "draft" ? "Resume" : "View";
}

// One synced GitHub issue. Every field is repository prose that any GitHub user
// can write, so it is rendered as text children only: never through
// dangerouslySetInnerHTML, and never as an instruction to an agent.
function GitHubIssueBoardCard({ issue, starting, onStart }: { issue: GitHubIssueCard; starting: boolean; onStart: () => void }) {
  return <article className="goal-board-card github-issue-card">
    <div className="github-issue-head"><span className="github-issue-repository">{issue.repositoryName}</span><b className="github-issue-number">#{issue.number}</b></div>
    <strong>{issue.title}</strong>
    {issue.labels.length > 0 && <p className="github-issue-labels" aria-label={`Labels for issue #${issue.number}`}>{issue.labels.map((label) => <span key={label}>{label}</span>)}</p>}
    {issue.url && <a className="github-issue-link" href={issue.url} target="_blank" rel="noreferrer">{`Open #${issue.number} on GitHub`}</a>}
    {/* Only an issue with no goal on the board reaches this card, so the card
        always offers a start. A started issue is filtered out of the column
        upstream, not shown here in a second state. */}
    <footer><button type="button" className="github-issue-start" aria-label={`Start a goal for #${issue.number} ${issue.title}`} disabled={starting} onClick={onStart}>{starting ? "Starting a goal…" : "Start a goal"}</button></footer>
  </article>;
}

function GoalBoardCard({ plan, state, repositoryName, tasks, focusSessionId, confirming, aborting, focusing, checking, followupBusy, onOpen, onRequestAbort, onCancelAbort, onConfirmAbort, onFocusWorkspace, onCheckMerge, onMoreActions }: { plan: PlanSummary; state: GoalBoardStateId; repositoryName: string; tasks: HealthTask[]; focusSessionId: string | null; confirming: boolean; aborting: boolean; focusing: boolean; checking: boolean; followupBusy: boolean; onOpen: () => void; onRequestAbort: () => void; onCancelAbort: () => void; onConfirmAbort: () => void; onFocusWorkspace: () => void; onCheckMerge: () => void; onMoreActions: () => void }) {
  const closed = state === "merged" || state === "aborted";
  const link = goalPrLink(plan);
  const openLabel = goalOpenLabel(plan);
  // Only the four verdicts a person can act on earn a badge. Badging "working"
  // would put a coloured pill on every healthy card and mean nothing.
  const health = plan.health && ATTENTION_HEALTH.has(plan.health) ? plan.health : null;
  const launched = plan.launchedCount || 0;
  const split = plan.agentSplit;
  const liveTasks = tasks.filter((task) => task.session?.id);
  // Only a URL this same repository already produced can build an issue link.
  const issueBase = issueBaseFrom([plan.boardPrUrl, plan.finalPrUrl]);
  // A goal that says "Waiting for merge" while its pull request is already
  // merged is the one wrong answer this board can give, so those two columns
  // carry the on-demand check.
  const checkable = state === "waiting_for_merge" || state === "blocked";
  return <article className={`goal-board-card ${state}`}>
    <RepoChip name={repositoryName} />
    <strong>{plan.goal}</strong>
    <div className="goal-board-card-meta"><span>{plan.taskCount} task{plan.taskCount === 1 ? "" : "s"}</span><span>Updated {relativePlanTime(plan.updatedAt)}</span></div>
    {liveTasks.length > 0 && <p className="goal-board-task-codes" aria-label="Live task sessions">{liveTasks.map((task) => <code title={task.title} aria-label={`${sessionTaskCode(task)}: ${task.title}`} key={task.id}>{sessionTaskCode(task)}</code>)}</p>}
    {health && <p className={`goal-board-health ${health}`}><b>{HEALTH_LABELS[health]}</b><span>{plan.healthReason || "This goal needs a person"}</span></p>}
    {launched > 0 && <p className="goal-board-ready" aria-label={`${plan.readyCount || 0} of ${launched} launched tasks ready`}><i style={{ width: `${Math.round(Math.min(1, (plan.readyCount || 0) / launched) * 100)}%` }} /><span>{plan.readyCount || 0}/{launched} ready</span></p>}
    {split && (split.claude > 0 || split.codex > 0) && <p className="goal-board-agents">{[split.claude ? `${split.claude} Claude` : "", split.codex ? `${split.codex} Codex` : ""].filter(Boolean).join(" · ")}</p>}
    {typeof plan.followupCount === "number" && plan.followupCount > 0 && <p className="goal-board-followups">{plan.followupCount} follow-up{plan.followupCount === 1 ? "" : "s"}</p>}
    {plan.issueNumbers && plan.issueNumbers.length > 0 && <p className="goal-board-issues">{plan.issueNumbers.map((number) => issueBase
      ? <a key={number} href={`${issueBase}/issues/${number}`} target="_blank" rel="noreferrer" aria-label={`Open issue #${number} on GitHub`}>#{number}</a>
      : <span key={number}>#{number}</span>)}</p>}
    <p className="goal-board-card-evidence">{boardEvidence(plan, state)}</p>
    {link && (state === "waiting_for_merge" || state === "merged") && <a className="goal-board-pr" href={link.url} target="_blank" rel="noreferrer">{link.label}</a>}
    {confirming
      ? <footer className="goal-board-abort-confirm"><span>Abort this goal? Active specification work and live cmux sessions are cancelled. Its worktrees and branches are kept.</span><div><button type="button" aria-label={`Cancel aborting ${plan.goal}`} disabled={aborting} onClick={onCancelAbort}>Cancel</button><button type="button" className="confirm-abort" aria-label={`Confirm abort ${plan.goal}`} disabled={aborting} onClick={onConfirmAbort}>{aborting ? "Aborting…" : "Confirm abort"}</button></div></footer>
      : <footer><button type="button" className="goal-board-open" aria-label={`${openLabel} ${plan.goal}`} onClick={onOpen}>{openLabel}</button>{!closed && <button type="button" className="goal-board-abort" aria-label={`Abort ${plan.goal}`} onClick={onRequestAbort}>Abort</button>}{state === "waiting_for_merge" && <button type="button" className="goal-board-more" aria-label={`More actions for ${plan.goal}`} disabled={followupBusy} onClick={onMoreActions}>{followupBusy ? "Starting follow-up…" : "More actions"}</button>}{checkable && <button type="button" className="goal-board-check" aria-label={`Check if ${plan.goal} is merged`} disabled={checking} onClick={onCheckMerge}>{checking ? "Checking GitHub…" : "Check if merged"}</button>}{focusSessionId && <button type="button" className="goal-board-focus" aria-label={`Open ${plan.goal} in cmux`} disabled={focusing} onClick={onFocusWorkspace}>{focusing ? "Opening…" : "Open in cmux"}</button>}</footer>}
  </article>;
}

function FollowupSheet({ plan, busy, onClose, onSubmit }: { plan: PlanSummary; busy: boolean; onClose: () => void; onSubmit: (submission: FollowupSubmission) => Promise<void> }) {
  const [actions, setActions] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [custom, setCustom] = useState("");
  const [agent, setAgent] = useState<FollowupAgent>(DEFAULT_FOLLOWUP_AGENT as FollowupAgent);
  const [error, setError] = useState("");

  function toggleAction(id: string, checked: boolean) {
    setActions((current) => checked ? [...current, id] : current.filter((action) => action !== id));
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const normalized = normalizeFollowupRequest({ actions, question, custom, agent }) as { actions: string[]; question: string; custom: string; agent: FollowupAgent };
      await onSubmit({ actions: normalized.actions, ...(normalized.question ? { question: normalized.question } : {}), ...(normalized.custom ? { custom: normalized.custom } : {}), agent: normalized.agent });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start this follow-up");
    }
  }

  return <><button type="button" className="session-menu-backdrop" aria-label="Close follow-up actions" disabled={busy} onClick={onClose} /><form className="worktree-launcher goal-followup-sheet" role="dialog" aria-modal="true" aria-label={`More actions for ${plan.goal}`} onSubmit={submit}>
    <header><div><strong>More actions</strong><span>{plan.goal}</span></div><button type="button" aria-label="Close follow-up actions" disabled={busy} onClick={onClose}>×</button></header>
    <div className="goal-followup-options">{GOAL_FOLLOWUP_ACTIONS.map((action) => {
      const checked = actions.includes(action.id);
      return <div className={checked ? "selected" : ""} key={action.id}>
        <label className="goal-followup-option" aria-label={`${action.label}: ${action.description}`}><input type="checkbox" checked={checked} onChange={(event) => toggleAction(action.id, event.target.checked)} /><span><strong>{action.label}</strong><small>{action.description}</small></span></label>
        {checked && action.requiresText && <label className="goal-followup-text"><span>{action.label}</span><textarea aria-label={`${action.label} details`} value={action.textKey === "question" ? question : custom} maxLength={MAX_FOLLOWUP_TEXT} rows={4} onChange={(event) => { if (action.textKey === "question") setQuestion(event.target.value); else setCustom(event.target.value); setError(""); }} /></label>}
      </div>;
    })}</div>
    <fieldset className="goal-followup-agents"><legend>Agent</legend>{GOAL_FOLLOWUP_AGENTS.map((option) => <label className={agent === option ? "selected" : ""} key={option}><input type="radio" name="followup-agent" value={option} checked={agent === option} onChange={() => { setAgent(option as FollowupAgent); setError(""); }} /><span>{option.slice(0, 1).toUpperCase() + option.slice(1)}</span></label>)}</fieldset>
    {error && <p className="worktree-action-error" role="alert">{error}</p>}
    <div className="goal-followup-submit"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={busy}>{busy ? "Starting follow-up…" : "Submit follow-up"}</button></div>
  </form></>;
}

// Which provider takes the next task, and what would change that answer. The
// verdict is the server's; this renders it and never recomputes it.
function AgentCapacityStrip({ capacity, error, now, onRetry }: { capacity: AgentCapacity | null; error: string; now: number; onRetry: () => void }) {
  return <section className="agent-capacity" aria-label="Agent capacity">
    <header><h3>Agent capacity</h3>{capacity && <span className={`agent-capacity-verdict${capacity.available ? "" : " exhausted"}`}>{capacity.available ? capacity.next ? `${labelOf(capacity, capacity.next)} takes the next task` : "No provider chosen" : `Both exhausted · ${resetText(capacity.nextReset, now)}`}</span>}{error && <button type="button" className="text-button" aria-label="Retry the agent capacity check" onClick={onRetry}>Retry</button>}</header>
    {error && <p className="agent-capacity-note">{error}</p>}
    {/* The reason is written to be read as one sentence. It is the only line
        that explains an alternation between two near-equal providers. */}
    {capacity?.reason && <p className="agent-capacity-reason">{capacity.reason}</p>}
    {!capacity && !error && <p className="agent-capacity-note">Reading agent quota…</p>}
    {capacity && <div className="agent-capacity-providers">{capacity.providers.map((provider) => <ProviderCapacity provider={provider} next={capacity.next === provider.id} now={now} key={provider.id} />)}</div>}
  </section>;
}

function labelOf(capacity: AgentCapacity, id: "claude" | "codex") { return capacity.providers.find((provider) => provider.id === id)?.label || id; }

function ProviderCapacity({ provider, next, now }: { provider: CapacityProvider; next: boolean; now: number }) {
  // `headroom` is null for a provider the dispatcher will not offer work to.
  // `bestPercent` still carries its real number, so a provider at 3% reads as
  // three percent rather than as no data at all.
  const percent = provider.headroom ?? provider.bestPercent;
  const windows = provider.accounts.flatMap((account) => account.windows);
  const attention = provider.accounts.filter((account) => account.status !== "ready");
  return <article className={`agent-capacity-provider${next ? " next" : ""}${provider.headroom === null ? " blocked" : ""}`}>
    <header><strong>{provider.label}</strong>{next && <em>Next task</em>}<b>{percent === null ? "—" : `${percent}%`}</b></header>
    <p className="agent-capacity-bar" aria-label={`${provider.label} headroom ${percent === null ? "unknown" : `${percent} percent`}`}><i style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }} /></p>
    {windows.length === 0
      ? <p className="agent-capacity-window-empty">No deciding window reported.</p>
      : <ul className="agent-capacity-windows">{windows.map((window, index) => <li key={`${window.cadence}:${index}`}><span>{window.label}</span><b>{window.remainingPercent}%</b><small>{resetText(window.resetAt, now)}</small></li>)}</ul>}
    {attention.map((account) => <p className={`agent-capacity-account ${account.status}`} key={account.id || account.label}><span>{account.label}</span><b>{account.status}</b></p>)}
  </article>;
}

function emptyHealthSummary(): HealthSummary {
  return { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0, deadTasks: 0, idleTasks: 0, failedTasks: 0 };
}

function summarizeHealthGoals(goals: HealthGoal[]): HealthSummary {
  const summary = emptyHealthSummary();
  for (const goal of goals) {
    summary.goals += 1;
    if (goal.health === "dead" || goal.health === "idle" || goal.health === "failed") summary.stuck += 1;
    if (goal.health === "needs_you") summary.needsYou += 1;
    if (goal.health === "working") summary.working += 1;
    for (const task of goal.tasks) {
      summary.tasks += 1;
      if (task.health === "dead") summary.deadTasks += 1;
      if (task.health === "idle") summary.idleTasks += 1;
      if (task.health === "failed") summary.failedTasks += 1;
    }
  }
  return summary;
}

// The strip's verdict as one chip, so the board bar answers "who takes the next
// task and is there room" without the panel. Clicking it opens the same strip.
function AgentCapacityChip({ capacity, error, now, open, onToggle }: { capacity: AgentCapacity | null; error: string; now: number; open: boolean; onToggle: () => void }) {
  const next = capacity?.next ? capacity.providers.find((provider) => provider.id === capacity.next) : null;
  // `headroom` is null for a provider the dispatcher will not offer work to;
  // `bestPercent` still carries the real number, exactly as the strip reads it.
  const percent = next ? next.headroom ?? next.bestPercent : null;
  // Low is the same threshold the strip's bar makes visible: a fifth left is
  // where the next wave starts queueing rather than launching.
  const low = capacity ? !capacity.available || capacity.providers.some((provider) => provider.headroom === null) || (percent !== null && percent <= 20) : false;
  const label = error ? "Agent capacity unavailable"
    : !capacity ? "Reading agent quota…"
      : !capacity.available ? `Both exhausted · ${resetText(capacity.nextReset, now)}`
        : next ? `${next.label} ${percent === null ? "—" : `${percent}%`}` : "No provider chosen";
  return <button type="button" className={`agent-capacity-chip${low ? " warn" : ""}${open ? " open" : ""}`} aria-label={`${label}. ${open ? "Hide" : "Show"} agent capacity`} aria-expanded={open} onClick={onToggle}><span aria-hidden="true">⚡</span>{label}<b aria-hidden="true">⌄</b></button>;
}

// Every task a person must answer for, across every repository, on one screen.
// Restart and Skip both destroy something, so each confirms inline first.
function AttentionRail({ relaunchModes, railRef, rows, sessionsAvailable, loaded, error, busy, confirming, onRetry, onRequestConfirm, onRelaunch, onSkip, onFocus }: { relaunchModes: Record<string, string>; railRef: RefObject<HTMLElement | null>; rows: { goal: HealthGoal; item: HealthTask | HealthMerge; kind: "task" | "merge" }[]; sessionsAvailable: boolean; loaded: boolean; error: string; busy: Record<string, boolean>; confirming: string; onRetry: () => void; onRequestConfirm: (key: string) => void; onRelaunch: (goal: HealthGoal, task: HealthTask, mode: "continue" | "restart" | "rebranch") => void; onSkip: (goal: HealthGoal, task: HealthTask) => void; onFocus: (workspaceId: string, label: string) => void }) {
  return <section className="goal-attention" ref={railRef} tabIndex={-1} aria-label="Goals needing attention">
    <header><h3>Needs you</h3><b aria-label={`${rows.length} task${rows.length === 1 ? "" : "s"} need you`}>{rows.length}</b>{error && <button type="button" className="text-button" aria-label="Retry the goal health check" onClick={onRetry}>Retry</button>}</header>
    {error && <p className="goal-attention-note">{error}</p>}
    {/* An unreachable cmux proves nothing about the agents. Saying "dead" here
        would send the user to relaunch work that is still running. */}
    {loaded && !sessionsAvailable && <p className="goal-attention-note">cmux could not be reached, so agent liveness is unknown. Nothing below is reported as dead.</p>}
    {rows.length === 0
      ? <p className="goal-attention-empty">{loaded ? "Nothing needs you. Every launched agent is working, ready or merged." : "Checking every launched agent…"}</p>
      : <ul className="goal-attention-rows">{rows.map(({ goal, item, kind }) => {
        const task = item as HealthTask;
        const relaunchKey = `relaunch:${goal.planId}:${task.id}`;
        const skipKey = `skip:${goal.planId}:${task.id}`;
        const working = busy[relaunchKey] === true || busy[skipKey] === true;
        const rebranchable = kind === "task" && task.launchStatus === "failed" && canRetryOnFreshBranch(task.launchReason);
        const confirmRestart = confirming === `restart:${goal.planId}:${task.id}`;
        const confirmSkip = confirming === `skip:${goal.planId}:${task.id}`;
        return <li key={`${goal.planId}:${kind}:${item.id}`}>
          <div className="goal-attention-copy">
            <RepoChip name={goal.repositoryName} />
            <strong>{item.title}</strong>
            <small>{goal.goal}{kind === "task" && task.agent ? ` · ${task.agent === "claude" ? "Claude" : "Codex"}` : ""}</small>
            {kind === "task" && <code>{task.branch}</code>}
            <p><span className={`goal-attention-badge ${item.health}`}>{HEALTH_LABELS[item.health]}</span>{item.reason}</p>
            {rebranchable && <p>Retrying starts from the task’s base on a fresh branch and leaves the blocked branch untouched.</p>}
          </div>
          {kind === "merge"
            ? <div className="goal-attention-actions">{item.session?.id && <button type="button" aria-label={`Open ${item.title} in cmux`} disabled={busy[`focus:${item.session.id}`] === true} onClick={() => onFocus(String(item.session?.id), item.title)}>Open in cmux</button>}</div>
            : confirmRestart
            ? <div className="goal-attention-confirm"><span>Restart discards this branch and its worktree, then rebuilds from base. Work the agent already did is lost.</span><div><button type="button" aria-label={`Cancel restarting ${task.title}`} onClick={() => onRequestConfirm("")}>Cancel</button><button type="button" className="confirm-restart" aria-label={`Confirm restart ${task.title}`} disabled={working} onClick={() => onRelaunch(goal, task, "restart")}>{busy[relaunchKey] ? "Restarting…" : "Confirm restart"}</button></div></div>
            : confirmSkip
              ? <div className="goal-attention-confirm"><span>Skipping drops this task from the goal, so the merge no longer waits for it.</span><div><button type="button" aria-label={`Cancel skipping ${task.title}`} onClick={() => onRequestConfirm("")}>Cancel</button><button type="button" className="confirm-skip" aria-label={`Confirm skip ${task.title}`} disabled={working} onClick={() => onSkip(goal, task)}>{busy[skipKey] ? "Skipping…" : "Confirm skip"}</button></div></div>
              : <div className="goal-attention-actions">
                {rebranchable && <button type="button" aria-label={`Retry on new branch for ${task.title}`} disabled={working} onClick={() => onRelaunch(goal, task, "rebranch")}>{busy[relaunchKey] && relaunchModes[relaunchKey] === "rebranch" ? "Retrying on new branch…" : "Retry on new branch"}</button>}
                <button type="button" aria-label={`Continue ${task.title}`} disabled={working} onClick={() => onRelaunch(goal, task, "continue")}>{busy[relaunchKey] && relaunchModes[relaunchKey] === "continue" ? "Continuing…" : "Continue"}</button>
                <button type="button" aria-label={`Restart ${task.title}`} disabled={working} onClick={() => onRequestConfirm(`restart:${goal.planId}:${task.id}`)}>Restart</button>
                <button type="button" aria-label={`Skip ${task.title}`} disabled={working} onClick={() => onRequestConfirm(`skip:${goal.planId}:${task.id}`)}>Skip</button>
                {task.session?.id && <button type="button" aria-label={`Open ${task.title} in cmux`} disabled={working || busy[`focus:${task.session.id}`] === true} onClick={() => onFocus(String(task.session?.id), task.title)}>Open in cmux</button>}
              </div>}
        </li>;
      })}</ul>}
  </section>;
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
