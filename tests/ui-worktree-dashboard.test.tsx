import assert from "node:assert/strict";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { WorktreeDashboardView } from "../app/worktree-dashboard";

// Two repositories on the board, one per project, with an orphan session and
// one worktree that carries a live session, so the closing and focus paths
// have something real to act on.
const now = new Date().toISOString();
const session = { id: "ws-live", title: "live agent", preview: "Editing", terminalCount: 1, lastActivityAt: Math.round(Date.now() / 1000), provider: "Codex", state: { label: "Working", tone: "working" } };
const repository = (id: string, name: string, root: string, extra: Record<string, unknown> = {}) => ({ id, name, root, path: `/Users/me/${root}/${name}`, pullRequestsAvailable: false, favorite: true, summary: { worktrees: 2, sessions: 1, needsYou: 0, working: 1, dirty: 0 }, worktrees: [
  { id: `${id}-primary`, repoId: id, path: `/Users/me/${root}/${name}`, name, branch: "main", isPrimary: true, detached: false, locked: null, prunable: null, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } },
  { id: `${id}-clean`, repoId: id, path: `/Users/me/${root}/${name}-clean`, name: `${name}-clean`, branch: "feature/clean", isPrimary: false, detached: false, locked: null, prunable: null, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } },
  { id: `${id}-busy`, repoId: id, path: `/Users/me/${root}/${name}-busy`, name: `${name}-busy`, branch: "feature/busy", isPrimary: false, detached: false, locked: null, prunable: null, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [session], state: { label: "Working", tone: "working" } },
], ...extra });
const karven = repository("repo-karven", "trust-layer", "karven");
const rekord = repository("repo-rekord", "recorder", "rekord");
const orphan = { id: "ws-orphan", title: "stray shell", preview: "idle", directory: "/Users/me/karven/elsewhere", terminalCount: 1, lastActivityAt: 1, provider: "Shell", state: { label: "Ready", tone: "ready" } };
const dashboard = { generatedAt: now, github: { checkedAt: now, status: "partial" }, summary: { repositories: 2, worktrees: 6, sessions: 2, needsYou: 0, working: 2, dirty: 0, pullRequests: 0 }, orphanSessions: [orphan], repositories: [karven, rekord] };

const plan = (over: Record<string, unknown> & { planId: string }): Record<string, unknown> & { planId: string } => ({ repositoryId: "repo-karven", repositoryName: "trust-layer", goal: "A goal", status: "draft", stage: "ready", round: 1, taskCount: 1, createdAt: now, updatedAt: now, launchedAt: null, ...over });
const inReview = plan({ planId: "plan-review", goal: "Waiting on the PR", status: "launched", taskCount: 2, launchedAt: now, boardState: "in_review", boardPrState: "OPEN", boardPrNumber: 77, boardPrUrl: "https://github.test/acme/trust-layer/pull/77", issueNumbers: [12] });
const stopped = plan({ planId: "plan-stopped", goal: "Its agent died", status: "launched", taskCount: 2, launchedAt: now, boardState: "stopped", health: "dead", healthReason: "This task session is no longer open in cmux", stuckCount: 1 });
const aborted = plan({ planId: "plan-aborted", goal: "Stopped on purpose", boardState: "aborted", boardStatus: "aborted", issueNumbers: [42] });
const drafted = plan({ planId: "plan-draft", goal: "Round two draft", round: 2, stage: "ready", boardState: "needs_you" });
const rekordDraft = plan({ planId: "plan-rekord", repositoryId: "repo-rekord", repositoryName: "recorder", goal: "Improve recording search", round: 1, stage: "questions", boardState: "discovering" });
const allPlans = [inReview, stopped, aborted, drafted, rekordDraft];

const failedTask = { id: "T1", title: "Wire the index", branch: "feature/index", agent: "codex", wave: 0, launchStatus: "failed", launchError: "locked", launchReason: "locked", deliveryStatus: "pending", workspaceId: null, health: "failed", reason: "The worktree is locked", session: null };
const deadTask = { id: "T2", title: "Build the sweep", branch: "feature/sweep", agent: "claude", wave: 0, launchStatus: "launched", launchError: null, launchReason: null, deliveryStatus: "pending", workspaceId: "ws-dead", health: "dead", reason: "This task session is no longer open in cmux", session: { id: "ws-dead", title: "TL · Its agent died (a1b2) · T2-sweep · Build the sweep", lastActivityAt: 1, effective: null } };
const merge = { id: "merge", kind: "merge", title: "Merge agent", workspaceId: "ws-merge", health: "needs_you", reason: "The merge agent asked a question", session: { id: "ws-merge", title: "merge", lastActivityAt: 1, effective: "needs_input" } };
const healthSweep = {
  checkedAt: now, sessionsAvailable: true,
  summary: { goals: 1, tasks: 2, stuck: 2, needsYou: 1, working: 0, deadTasks: 1, idleTasks: 0, failedTasks: 1 },
  goals: [
    { planId: "plan-stopped", repositoryId: "repo-karven", repositoryName: "trust-layer", goal: "Its agent died", health: "dead", stuckCount: 2, readyCount: 0, launchedCount: 1, taskCount: 2, deliveryStatus: "blocked", merge, tasks: [failedTask, deadTask] },
    { planId: "plan-review", repositoryId: "repo-karven", repositoryName: "trust-layer", goal: "Waiting on the PR", health: "needs_you", stuckCount: 0, readyCount: 2, launchedCount: 2, taskCount: 2, deliveryStatus: "pr_open", merge: null, tasks: [] },
  ],
};
const issue = { repositoryId: "repo-karven", repositoryName: "trust-layer", number: 7, title: "Flaky login test", labels: ["bug"], url: "https://github.test/acme/trust-layer/issues/7", updatedAt: now, syncedAt: now, planId: null };
const capacityWindow = { cadence: "weekly", label: "Weekly", remainingPercent: 40, resetAt: new Date(Date.now() + 3_600_000).toISOString() };
const capacity = { providers: [{ id: "claude", label: "Claude", available: true, headroom: 40, bestPercent: 40, accounts: [{ id: "acct", label: "main", status: "ready", headroom: 40, windows: [capacityWindow], opportunity: capacityWindow, updatedAt: now }] }], next: "claude", reason: "Claude has headroom", nextReset: null, available: true };

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
type Handler = (url: string, init?: RequestInit) => Response | undefined;

function mount(handler: Handler = () => undefined, props: Partial<Parameters<typeof WorktreeDashboardView>[0]> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const custom = handler(url, init);
    if (custom) return custom;
    if (url === "/api/github-issues") return response({ syncedAt: now, issues: [issue] });
    if (url === "/api/goals/health") return response(healthSweep);
    if (url === "/api/goals/capacity" || url === "/api/goals/capacity?refresh=1") return response(capacity);
    if (url === "/api/goals/sessions/retirable") return response({ checkedAt: now, sessionsAvailable: true, closed: [{ planId: "plan-stopped", workspaceId: "ws-dead", taskId: "T2", kind: "task", title: "Build the sweep", reason: "finished" }], kept: [], failed: [] });
    if (url.startsWith("/api/worktree-plans?")) return response({ plans: allPlans });
    if (url.startsWith("/api/worktree-dashboard")) return response(dashboard);
    if (url === "/api/settings/models") return response({ error: "unavailable" }, 503);
    return response({ error: `Unmocked ${url}` }, 501);
  });
  vi.stubGlobal("fetch", fetchMock);
  const notice = vi.fn();
  const onOpenWorkspace = vi.fn();
  const onLaunched = vi.fn(async () => {});
  render(<WorktreeDashboardView onOpenWorkspace={onOpenWorkspace} onLaunched={onLaunched} onNotice={notice} {...props} />);
  return { calls, notice, onOpenWorkspace, onLaunched };
}

const posted = (calls: { url: string; init?: RequestInit }[], url: string, method = "POST") => calls.filter((call) => call.url === url && (call.init?.method || "GET").toUpperCase() === method);
const lastNotice = (notice: ReturnType<typeof vi.fn>) => String(notice.mock.calls.at(-1)?.[0] || "");

async function openBoardTools() {
  const summary = await screen.findByText("Board tools");
  if (!summary.closest("details")?.open) await userEvent.click(summary);
}

async function switchTab(name: RegExp) {
  await openBoardTools();
  await userEvent.click(await screen.findByRole("tab", { name }));
}

beforeEach(() => localStorage.clear());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("goals board actions", () => {
  test("the attention rail continues, retries on a fresh branch, restarts, skips and focuses sessions", async () => {
    let relaunchFails = false;
    const { calls, notice } = mount((url, init) => {
      if (url.endsWith("/relaunch") && init?.method === "POST") return relaunchFails ? response({ error: "Relaunch refused" }, 409) : response({ branch: "feature/index-2" });
      if (url.endsWith("/skip") && init?.method === "POST") return response({ skipped: true });
      if (url === "/api/worktree-plans/plan-stopped") return response({ ...stopped, tasks: [] });
      if (url.endsWith("/select") && init?.method === "POST") return url.includes("ws-merge") ? response({ error: "cmux is not focused" }, 500) : response({});
      return undefined;
    });
    const rail = await screen.findByRole("region", { name: "Goals needing attention" });
    await within(rail).findByText("Wire the index");
    assert.ok(within(rail).getByText("Merge agent"));
    assert.ok(within(rail).getByText(/Retrying starts from the task/));
    await userEvent.click(within(rail).getByRole("button", { name: "Retry on new branch for Wire the index" }));
    await waitFor(() => assert.match(lastNotice(notice), /Retried Wire the index on feature\/index-2/));
    const relaunch = posted(calls, "/api/worktree-plans/plan-stopped/tasks/T1/relaunch")[0];
    assert.deepEqual(JSON.parse(String(relaunch.init?.body)), { mode: "rebranch", closeLive: false });
    await userEvent.click(within(rail).getByRole("button", { name: "Continue Build the sweep" }));
    await waitFor(() => assert.match(lastNotice(notice), /Continued Build the sweep in its existing worktree/));
    assert.deepEqual(JSON.parse(String(posted(calls, "/api/worktree-plans/plan-stopped/tasks/T2/relaunch")[0].init?.body)), { mode: "continue", closeLive: true });
    await userEvent.click(within(rail).getByRole("button", { name: "Restart Build the sweep" }));
    assert.ok(within(rail).getByText(/Restart discards this branch/));
    await userEvent.click(within(rail).getByRole("button", { name: "Cancel restarting Build the sweep" }));
    await userEvent.click(within(rail).getByRole("button", { name: "Restart Build the sweep" }));
    await userEvent.click(within(rail).getByRole("button", { name: "Confirm restart Build the sweep" }));
    await waitFor(() => assert.match(lastNotice(notice), /Restarted Build the sweep from its base branch/));
    await userEvent.click(within(rail).getByRole("button", { name: "Skip Build the sweep" }));
    assert.ok(within(rail).getByText(/Skipping drops this task/));
    await userEvent.click(within(rail).getByRole("button", { name: "Cancel skipping Build the sweep" }));
    await userEvent.click(within(rail).getByRole("button", { name: "Skip Build the sweep" }));
    await userEvent.click(within(rail).getByRole("button", { name: "Confirm skip Build the sweep" }));
    await waitFor(() => assert.match(lastNotice(notice), /Skipped Build the sweep/));
    assert.deepEqual(JSON.parse(String(posted(calls, "/api/worktree-plans/plan-stopped/tasks/T2/skip")[0].init?.body)), { reason: "This task session is no longer open in cmux" });
    await userEvent.click(within(rail).getByRole("button", { name: "Open Build the sweep in cmux" }));
    await waitFor(() => assert.match(lastNotice(notice), /Focused Build the sweep in cmux/));
    assert.equal(posted(calls, "/api/workspaces/ws-dead/select").length, 1);
    await userEvent.click(within(rail).getByRole("button", { name: "Open Merge agent in cmux" }));
    await waitFor(() => assert.match(lastNotice(notice), /cmux is not focused/));
    relaunchFails = true;
    await userEvent.click(within(rail).getByRole("button", { name: "Continue Build the sweep" }));
    await waitFor(() => assert.match(lastNotice(notice), /Relaunch refused/));
  });

  test("a failed skip and a failed rail read keep their reasons visible and retry", async () => {
    let healthFails = false;
    const { notice } = mount((url, init) => {
      if (url.endsWith("/skip") && init?.method === "POST") return response({ error: "Skip refused" }, 409);
      if (url === "/api/goals/health" && healthFails) return response({ error: "Sweep unavailable" }, 503);
      return undefined;
    });
    const rail = await screen.findByRole("region", { name: "Goals needing attention" });
    await within(rail).findByText("Build the sweep");
    await userEvent.click(within(rail).getByRole("button", { name: "Skip Build the sweep" }));
    await userEvent.click(within(rail).getByRole("button", { name: "Confirm skip Build the sweep" }));
    await waitFor(() => assert.match(lastNotice(notice), /Skip refused/));
    healthFails = true;
    await openBoardTools();
    await userEvent.click(screen.getByRole("button", { name: "Refresh GitHub" }));
    assert.ok(await within(rail).findByText("Sweep unavailable"));
    healthFails = false;
    await userEvent.click(within(rail).getByRole("button", { name: "Retry the goal health check" }));
    await waitFor(() => assert.equal(within(rail).queryByText("Sweep unavailable"), null));
  });

  test("board cards check merges, return issues, open goals and abort with partial failures reported", async () => {
    let mergeAnswer: Record<string, unknown> = { planId: "plan-review", changed: false, state: "OPEN", boardStatus: null, pullRequest: { number: 77, url: inReview.boardPrUrl }, checked: true };
    let abortAnswer: Record<string, unknown> = { planId: "plan-stopped", aborted: true, alreadyAborted: false, closedSessionIds: [], failedSessionIds: ["ws-dead"] };
    const { calls, notice } = mount((url, init) => {
      if (url.endsWith("/check-merge") && init?.method === "POST") return mergeAnswer.error ? response(mergeAnswer, 500) : response(mergeAnswer);
      if (url.endsWith("/abort") && init?.method === "POST") return abortAnswer.error ? response(abortAnswer, 500) : response(abortAnswer);
      if (url.endsWith("/return-issues") && init?.method === "POST") return url.includes("plan-aborted") ? response({ issuesReturnedAt: now }) : response({ error: "Nothing to return" }, 409);
      if (url.endsWith("/select") && init?.method === "POST") return response({});
      if (url === "/api/worktree-plans/plan-aborted") return response({ ...aborted, tasks: [], questions: [] });
      return undefined;
    });
    const board = await screen.findByRole("region", { name: "Goals board" });
    const reviewCard = (await within(board).findByText("Waiting on the PR")).closest("article")!;
    assert.equal(within(reviewCard).getByRole("link", { name: "Open issue #12 on GitHub" }).getAttribute("href"), "https://github.test/acme/trust-layer/issues/12");
    await userEvent.click(within(reviewCard).getByRole("button", { name: "Check if Waiting on the PR is merged" }));
    await waitFor(() => assert.match(lastNotice(notice), /still open on GitHub \(PR #77\)/));
    mergeAnswer = { ...mergeAnswer, pullRequest: null };
    await userEvent.click(within(reviewCard).getByRole("button", { name: "Check if Waiting on the PR is merged" }));
    await waitFor(() => assert.match(lastNotice(notice), /knows no pull request/));
    mergeAnswer = { ...mergeAnswer, changed: true, boardStatus: "merged" };
    await userEvent.click(within(reviewCard).getByRole("button", { name: "Check if Waiting on the PR is merged" }));
    await waitFor(() => assert.match(lastNotice(notice), /moved to Shipped/));
    mergeAnswer = { error: "GitHub unreachable" };
    await userEvent.click(within(reviewCard).getByRole("button", { name: "Check if Waiting on the PR is merged" }));
    await waitFor(() => assert.match(lastNotice(notice), /GitHub unreachable/));

    await userEvent.click(within(board).getByRole("button", { name: "Expand Aborted" }));
    const abortedCard = within(board).getByText("Stopped on purpose").closest("article")!;
    await userEvent.click(within(abortedCard).getByRole("button", { name: "Return issues to GitHub list for Stopped on purpose" }));
    await userEvent.click(within(abortedCard).getByRole("button", { name: "Cancel returning issues for Stopped on purpose" }));
    await userEvent.click(within(abortedCard).getByRole("button", { name: "Return issues to GitHub list for Stopped on purpose" }));
    await userEvent.click(within(abortedCard).getByRole("button", { name: "Confirm return issues for Stopped on purpose" }));
    await waitFor(() => assert.match(lastNotice(notice), /Issues released for a new goal/));
    assert.ok(within(abortedCard).getByText(/Issues returned to GitHub list/));
    assert.equal(posted(calls, "/api/worktree-plans/plan-aborted/return-issues").length, 1);
    await userEvent.click(within(abortedCard).getByRole("button", { name: "View Stopped on purpose" }));
    assert.ok(await screen.findByRole("dialog", { name: "Plan a goal" }));
    assert.equal(new URLSearchParams(location.search).get("plan"), "plan-aborted");
    await userEvent.click(screen.getByRole("button", { name: "Close goal planner sheet" }));
    await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Plan a goal" }), null));

    await userEvent.click(within(board).getByRole("button", { name: "Expand Stopped" }));
    const stoppedCard = within(board).getByText("Its agent died").closest("article")!;
    assert.ok(within(stoppedCard).getByLabelText("T2-sweep: Build the sweep"));
    await userEvent.click(within(stoppedCard).getByRole("button", { name: "Abort Its agent died" }));
    await userEvent.click(within(stoppedCard).getByRole("button", { name: "Cancel aborting Its agent died" }));
    await userEvent.click(within(stoppedCard).getByRole("button", { name: "Abort Its agent died" }));
    await userEvent.click(within(stoppedCard).getByRole("button", { name: "Confirm abort Its agent died" }));
    assert.ok(await screen.findByText(/Aborted this goal, but 1 cmux session could not be closed/));
    abortAnswer = { error: "Abort refused" };
    await userEvent.click(within(stoppedCard).getByRole("button", { name: "Abort Its agent died" }));
    await userEvent.click(within(stoppedCard).getByRole("button", { name: "Confirm abort Its agent died" }));
    assert.ok(await screen.findByText("Abort refused"));
    abortAnswer = { planId: "plan-stopped", aborted: true, alreadyAborted: false, closedSessionIds: ["ws-dead"], failedSessionIds: [] };
    await userEvent.click(within(stoppedCard).getByRole("button", { name: "Confirm abort Its agent died" }));
    await waitFor(() => assert.match(lastNotice(notice), /Aborted goal from trust-layer/));
    // A stopped goal focuses its merge session when the sweep joined one.
    await userEvent.click(within(stoppedCard).getByRole("button", { name: "Open Its agent died in cmux" }));
    await waitFor(() => assert.equal(posted(calls, "/api/workspaces/ws-merge/select").length, 1));
  });

  test("the stuck and needs-you counters focus the rail, and the board columns collapse with a remembered preference", async () => {
    mount();
    const rail = await screen.findByRole("region", { name: "Goals needing attention" });
    await userEvent.click(await screen.findByRole("button", { name: "1 stuck goals. Show the tasks that need you" }));
    assert.equal(document.activeElement, rail);
    await userEvent.click(screen.getByRole("button", { name: "1 goals need you. Show the tasks that need you" }));
    assert.ok(screen.getByText(/GitHub checked just now · partial/));
    const board = screen.getByRole("region", { name: "Goals board" });
    await userEvent.click(within(board).getByRole("button", { name: "Collapse GitHub Issues" }));
    assert.equal(JSON.parse(localStorage.getItem("cmux-companion-goal-board-column-expansion") || "{}").github_issues, false);
    await userEvent.click(within(board).getByRole("button", { name: "Expand GitHub Issues" }));
    assert.ok(within(board).getByRole("button", { name: "Start a goal for #7 Flaky login test" }));
  });

  test("GitHub sync reports failures, empty stars and started issues, and the issue column filters by search", async () => {
    let sync: Record<string, unknown> = { syncedAt: now, status: "ok", message: null, repositories: [{ repositoryId: "repo-karven", name: "trust-layer", status: "error", issueCount: 0, truncated: false, error: "rate limited" }], issues: [issue] };
    let startAnswer: Record<string, unknown> = { issue: { ...issue, planId: "plan-issue" }, plan: { planId: "plan-issue", workflow: "planned" }, created: true };
    const { notice } = mount((url, init) => {
      if (url === "/api/github-issues/sync" && init?.method === "POST") return sync.error ? response(sync, 500) : response(sync);
      if (url === "/api/github-issues/repo-karven/7/goal" && init?.method === "POST") return startAnswer.error ? response(startAnswer, 500) : response(startAnswer);
      return undefined;
    });
    const board = await screen.findByRole("region", { name: "Goals board" });
    await within(board).findByText("Flaky login test");
    await openBoardTools();
    await userEvent.click(screen.getByRole("button", { name: "GitHub Sync" }));
    assert.ok(await screen.findByText(/GitHub Sync could not read 1 starred repository: trust-layer \(rate limited\)/));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    sync = { syncedAt: now, status: "no_starred_repositories", message: null, repositories: [], issues: [] };
    await userEvent.click(screen.getByRole("button", { name: "GitHub Sync" }));
    assert.ok(await screen.findByText(/No starred repositories/));
    assert.ok(within(board).getByText(/No GitHub issues yet/));
    sync = { syncedAt: now, status: "ok", message: null, repositories: [{ repositoryId: "repo-karven", name: "trust-layer", status: "ok", issueCount: 1, truncated: false, error: null }], issues: [issue] };
    await userEvent.click(screen.getByRole("button", { name: "GitHub Sync" }));
    await waitFor(() => assert.match(lastNotice(notice), /GitHub Sync read 1 open issue/));
    sync = { error: "gh is not installed" };
    await userEvent.click(screen.getByRole("button", { name: "GitHub Sync" }));
    assert.ok(await screen.findByText("gh is not installed"));
    const search = screen.getByRole("searchbox", { name: "Search projects" });
    await userEvent.type(search, "#99");
    assert.ok(await within(board).findByText(/No issue matches “#99”/));
    await userEvent.click(within(board).getByRole("button", { name: "Clear search" }));
    await userEvent.type(search, "#7");
    assert.ok(await within(board).findByText("Flaky login test"));
    await userEvent.click(screen.getByRole("button", { name: "Clear the project search" }));
    startAnswer = { error: "Issue is closed" };
    await userEvent.click(within(board).getByRole("button", { name: "Start a goal for #7 Flaky login test" }));
    assert.ok(await screen.findByText("Issue is closed"));
    startAnswer = { issue: { ...issue, planId: "plan-issue" }, plan: { planId: "plan-issue", workflow: "planned" }, created: false };
    await userEvent.click(within(board).getByRole("button", { name: "Start a goal for #7 Flaky login test" }));
    await waitFor(() => assert.match(lastNotice(notice), /already has a goal/));
  });

  test("closes finished sessions and reports what the pass kept, refused or could not reach", async () => {
    let report: Record<string, unknown> = { checkedAt: now, sessionsAvailable: true, closed: [{ planId: "p", workspaceId: "ws-dead", taskId: "T2", kind: "task", title: "t", reason: "finished" }], kept: [{ planId: "p", workspaceId: "ws-live", kind: "task", reason: "Its agent is still working" }], failed: [{ planId: "p", workspaceId: "ws-x", error: "" }] };
    const { notice } = mount((url, init) => url === "/api/goals/sessions/reap" && init?.method === "POST" ? (report.error ? response(report, 500) : response(report)) : undefined);
    await openBoardTools();
    const button = await screen.findByRole("button", { name: "Close 1 finished session" });
    await userEvent.click(button);
    await waitFor(() => assert.equal(lastNotice(notice), "Closed 1 finished session, 1 kept. Its agent is still working. cmux refused to close 1 session: ws-x (unknown error)"));
    report = { checkedAt: now, sessionsAvailable: false, closed: [], kept: [], failed: [] };
    await userEvent.click(screen.getByRole("button", { name: "Close 1 finished session" }));
    await waitFor(() => assert.match(lastNotice(notice), /agent liveness is unknown/));
    report = { checkedAt: now, sessionsAvailable: true, closed: [], kept: [], failed: [] };
    await userEvent.click(screen.getByRole("button", { name: "Close 1 finished session" }));
    await waitFor(() => assert.equal(lastNotice(notice), "Closed 0 finished sessions, 0 kept."));
    report = { error: "Reap refused" };
    await userEvent.click(screen.getByRole("button", { name: "Close 1 finished session" }));
    await waitFor(() => assert.match(lastNotice(notice), /Reap refused/));
  });

  test("shows the burst banner and the capacity strip, and opens a burst goal on the board", async () => {
    const burst = { burstId: "burst-1", status: "ready", createdAt: now, updatedAt: now, capacitySnapshot: null, candidates: [{ repositoryId: "repo-karven", repositoryName: "trust-layer", goal: "Cover the store", rationale: "no tests", evidence: [], sizeEstimate: "small", status: "approved", reason: null, planId: "plan-draft", updatedAt: now }, { repositoryId: "repo-gone", repositoryName: "vanished", goal: "Ghost", rationale: "none", evidence: [], sizeEstimate: "small", status: "approved", reason: null, planId: "plan-ghost", updatedAt: now }] };
    const { notice, calls } = mount((url) => {
      if (url === "/api/bursts") return response({ bursts: [burst] });
      if (url === "/api/bursts/burst-1") return response(burst);
      if (url === "/api/worktree-plans/plan-draft") return response({ ...drafted, tasks: [], questions: [] });
      return undefined;
    }, { onUsage: vi.fn() });
    assert.ok(await screen.findByRole("region", { name: "Burst opportunity" }));
    await userEvent.click(screen.getByRole("button", { name: /Show agent capacity/ }));
    assert.ok(await screen.findByRole("region", { name: "Agent capacity" }));
    await userEvent.click(screen.getByRole("button", { name: "Refresh quota" }));
    await waitFor(() => assert.ok(calls.some((call) => call.url === "/api/goals/capacity?refresh=1")));
    await userEvent.click(screen.getByRole("button", { name: "Start a burst" }));
    await userEvent.click(await screen.findByRole("button", { name: "Open goal for vanished" }));
    await waitFor(() => assert.match(lastNotice(notice), /no longer on the board/));
    await openBoardTools();
    await userEvent.click(screen.getByRole("button", { name: "Burst" }));
    await userEvent.click(await screen.findByRole("button", { name: "Open goal for trust-layer" }));
    assert.ok(await screen.findByRole("dialog", { name: "Plan a goal" }));
    assert.equal(new URLSearchParams(location.search).get("plan"), "plan-draft");
  });

  test("follow-up actions start from the review card and a started goal session opens its workspace", async () => {
    const { calls, notice, onOpenWorkspace } = mount((url, init) => {
      if (url.endsWith("/followups") && init?.method === "POST") return response({ planId: "plan-review", workspaceId: "ws-follow", agent: "codex", actions: ["tests", "review"], branch: "b", worktreePath: "/p", pullRequest: null, title: "t" });
      if (url === "/api/worktree-plans/plan-draft") return response({ ...drafted, tasks: [], questions: [], workflow: "goal_session", goalSessionState: "planning", goalSessionWorkspaceId: "ws-goal", goalSessionRunnerPid: 1 });
      return undefined;
    });
    const board = await screen.findByRole("region", { name: "Goals board" });
    const reviewCard = (await within(board).findByText("Waiting on the PR")).closest("article")!;
    await userEvent.click(within(reviewCard).getByRole("button", { name: "More actions for Waiting on the PR" }));
    const sheet = await screen.findByRole("dialog", { name: /More actions for/ });
    await userEvent.click(within(sheet).getByRole("checkbox", { name: /More unit and e2e tests/ }));
    await userEvent.click(within(sheet).getByRole("checkbox", { name: /Complete code review/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Submit follow-up" }));
    await waitFor(() => assert.match(lastNotice(notice), /Started 2 follow-up actions for Waiting on the PR with Codex/));
    assert.deepEqual(JSON.parse(String(posted(calls, "/api/worktree-plans/plan-review/followups")[0].init?.body)).actions, ["tests", "review"]);
    await userEvent.click(within(board).getByRole("button", { name: "Resume Round two draft" }));
    await userEvent.click(await screen.findByRole("button", { name: "Open conversation" }));
    await waitFor(() => assert.deepEqual(onOpenWorkspace.mock.calls[0], ["ws-goal"]));
  });

  test("read-only protection keeps every mutating board control disabled", async () => {
    mount(() => undefined, { readOnly: true });
    assert.ok(await screen.findByText(/Read-only protection is on/));
    const rail = await screen.findByRole("region", { name: "Goals needing attention" });
    await within(rail).findByText("Build the sweep");
    assert.equal((within(rail).getByRole("button", { name: "Continue Build the sweep" }) as HTMLButtonElement).disabled, true);
    await openBoardTools();
    assert.equal((screen.getByRole("button", { name: "GitHub Sync" }) as HTMLButtonElement).disabled, true);
    assert.equal((screen.getByRole("button", { name: "Close 1 finished session" }) as HTMLButtonElement).disabled, true);
  });
});

describe("worktree lists", () => {
  test("shows a loading skeleton, a dashboard failure with retry and the orphan sessions", async () => {
    let fail = true;
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const { notice, onOpenWorkspace, calls } = mount((url, init) => {
      if (url.startsWith("/api/worktree-dashboard") && fail && !init?.method) return response({ error: "Git is unavailable" }, 503);
      if (url === "/api/workspaces/ws-orphan/close" && init?.method === "POST") return response({ error: "Already closed" }, 409);
      return undefined;
    });
    assert.ok(await screen.findByText("Git is unavailable"));
    await switchTab(/Active/);
    assert.ok(document.querySelector(".worktree-skeleton") === null);
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    assert.ok(await screen.findByText("stray shell"));
    assert.ok(calls.some((call) => call.url === "/api/worktree-dashboard?refresh=1"));
    await userEvent.click(screen.getByRole("button", { name: /^stray shell/ }));
    assert.deepEqual(onOpenWorkspace.mock.calls[0], ["ws-orphan"]);
    confirm.mockReturnValueOnce(false);
    await userEvent.click(screen.getByRole("button", { name: "Close session stray shell" }));
    assert.equal(posted(calls, "/api/workspaces/ws-orphan/close").length, 0);
    await userEvent.click(screen.getByRole("button", { name: "Close session stray shell" }));
    await waitFor(() => assert.match(lastNotice(notice), /Already closed/));
  });

  test("worktree removal, bulk removal and repository flags report their refusals", async () => {
    const { notice } = mount((url, init) => {
      if (url === "/api/worktree-dashboard/repo-karven-clean" && init?.method === "DELETE") return response({ error: "Worktree is in use" }, 409);
      if (url.endsWith("/remove-clean") && init?.method === "POST") return response({ requested: 2, removed: 1, failed: 1, results: [{ id: "a", branch: "feature/clean", path: "/p", removed: true, error: "" }, { id: "b", branch: "feature/other", path: "/q", removed: false, error: "dirty" }] });
      if (url.endsWith("/favorite") && init?.method === "PATCH") return response({ error: "Flags are locked" }, 423);
      return undefined;
    });
    await switchTab(/Active/);
    const cleanCard = (await screen.findByText("feature/clean")).closest("article")!;
    await userEvent.click(within(cleanCard).getByRole("button", { name: "Remove" }));
    await userEvent.click(within(cleanCard).getByRole("button", { name: "Cancel" }));
    await userEvent.click(within(cleanCard).getByRole("button", { name: "Remove" }));
    await userEvent.click(within(cleanCard).getByRole("button", { name: "Confirm remove" }));
    assert.ok(await within(cleanCard).findByText("Worktree is in use"));
    const busyCard = screen.getByText("feature/busy").closest("article")!;
    assert.ok(within(busyCard).getByText("Close active sessions first"));
    await userEvent.click(screen.getByRole("button", { name: "Remove clean worktrees in trust-layer" }));
    const sheet = await screen.findByRole("dialog", { name: "Remove clean worktrees" });
    assert.ok(within(sheet).getByText("feature/clean"));
    await userEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove clean worktrees in trust-layer" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Remove clean worktrees" })).getByRole("button", { name: "Remove 1 worktree" }));
    await waitFor(() => assert.equal(lastNotice(notice), "Removed 1 of 2 worktrees. Failed: feature/other (dirty)"));
    await userEvent.click(screen.getByRole("button", { name: "Unfavorite trust-layer" }));
    await waitFor(() => assert.match(lastNotice(notice), /Flags are locked/));
  });

  test("a created worktree whose session fails to start is still reported, and a refused creation stays in the sheet", async () => {
    let createFails = false;
    const { notice, onLaunched } = mount((url, init) => {
      if (url.endsWith("/worktrees") && init?.method === "POST") return createFails ? response({ error: "Branch exists" }, 409) : response({ worktree: { id: "wt-new", branch: "feature/new", path: "/p" }, branchCreated: true });
      if (url === "/api/worktree-dashboard/wt-new/launch" && init?.method === "POST") return response({ error: "cmux is down" }, 503);
      if (url === "/api/worktree-dashboard/repo-karven-busy/launch" && init?.method === "POST") return response({ error: "No agent available" }, 503);
      return undefined;
    });
    await switchTab(/Active/);
    await userEvent.click(await screen.findByRole("button", { name: "Create worktree for trust-layer" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Branch name" }), "feature/new");
    await userEvent.click(screen.getByRole("button", { name: "Create & start session" }));
    await waitFor(() => assert.match(lastNotice(notice), /Worktree created, but the session could not start: cmux is down/));
    await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Create Git worktree" }), null));
    assert.equal(onLaunched.mock.calls.length, 0);
    createFails = true;
    await userEvent.click(await screen.findByRole("button", { name: "Create worktree for trust-layer" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Branch name" }), "feature/dup");
    await userEvent.click(screen.getByRole("checkbox", { name: /Start a session/ }));
    await userEvent.click(screen.getByRole("button", { name: "Create worktree" }));
    assert.ok(await screen.findByText("Branch exists"));
    await userEvent.click(screen.getByRole("button", { name: "Close new worktree dialog" }));
    const busyCard = screen.getByText("feature/busy").closest("article")!;
    await userEvent.click(within(busyCard).getByRole("button", { name: "＋ Session" }));
    await userEvent.click(screen.getByRole("button", { name: "Launch Codex" }));
    await waitFor(() => assert.match(lastNotice(notice), /No agent available/));
    await userEvent.click(screen.getByRole("button", { name: "Close worktree launcher" }));
  });

  test("the goal lists filter by search, delete goals and open the GitHub issue picker", async () => {
    let plansFail = false;
    const { calls } = mount((url, init) => {
      if (url.startsWith("/api/worktree-plans?") && plansFail) return response({ error: "Plans unavailable" }, 503);
      if (url === "/api/worktree-plans/plan-draft" && init?.method === "DELETE") return response({ error: "Goal is running" }, 409);
      if (url === "/api/github-issues/repository/repo-karven") return response({ issues: [issue] });
      return undefined;
    });
    await switchTab(/Draft Goals/);
    assert.ok(await screen.findByText("Round two draft"));
    assert.ok(screen.getByText(/2 goals ready to resume/));
    const search = screen.getByRole("searchbox", { name: "Search projects" });
    await userEvent.type(search, "nothing here");
    assert.ok(await screen.findByText(/No goal matches “nothing here”/));
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search projects" }), "zzz");
    assert.ok(await screen.findByText(/No goal matches “zzz”/));
    await userEvent.click(screen.getByRole("button", { name: "Clear the project search" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete Round two draft" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel deleting Round two draft" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete Round two draft" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete Round two draft" }));
    assert.ok(await screen.findByText("Goal is running"));
    plansFail = true;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    assert.ok(await screen.findByText("Plans unavailable"));
    plansFail = false;
    await switchTab(/Active/);
    await userEvent.click(await screen.findByRole("button", { name: "Plan GitHub issues for trust-layer" }));
    assert.ok(await screen.findByRole("dialog", { name: "GitHub issues" }));
    assert.ok(await screen.findByText(/Flaky login test/));
    await userEvent.click(screen.getByRole("button", { name: "Close GitHub issues" }));
    await waitFor(() => assert.ok(calls.filter((call) => call.url.startsWith("/api/worktree-plans?")).length >= 2));
    await switchTab(/Launched Goals/);
    assert.ok(await screen.findByText("Waiting on the PR"));
    await switchTab(/Rekord/);
    assert.ok(await screen.findByText(/No launched Rekord goals/));
  });

  test("a new-goal link for a missing repository and a resolved plan change the popup URL", async () => {
    window.history.replaceState(null, "", "/?view=sessions&mode=worktrees&newGoal=repo-missing");
    mount();
    assert.ok(await screen.findByText("Goal unavailable"));
    assert.match((screen.getByRole("alert")).textContent || "", /repository for this new-goal link is unavailable/);
    await userEvent.click(screen.getByRole("button", { name: "Close goal planner sheet" }));
    await waitFor(() => assert.equal(new URLSearchParams(location.search).get("newGoal"), null));
  });

  test("the board repository picker searches, answers to the keyboard and closes", async () => {
    mount();
    await screen.findByRole("region", { name: "Goals board" });
    await userEvent.click(screen.getByRole("button", { name: "＋ New goal" }));
    const input = screen.getByRole("searchbox", { name: "Find a repository" });
    await userEvent.type(input, "nope");
    assert.ok(screen.getByText("No repository matches that."));
    await userEvent.clear(input);
    await userEvent.type(input, "rekord/recorder");
    assert.ok(screen.getByRole("menuitem", { name: "Plan a goal for recorder" }));
    await userEvent.keyboard("{Escape}");
    assert.equal(screen.queryByRole("searchbox", { name: "Find a repository" }), null);
    await userEvent.click(screen.getByRole("button", { name: "＋ New goal" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Find a repository" }), "trust{Enter}");
    assert.ok(await screen.findByRole("dialog", { name: "Plan a goal" }));
    assert.equal(new URLSearchParams(location.search).get("newGoal"), "repo-karven");
    await userEvent.click(screen.getByRole("button", { name: "Close goal planner sheet" }));
    await userEvent.click(await screen.findByRole("button", { name: "＋ New goal" }));
    await userEvent.click(screen.getByRole("button", { name: "Close the repository picker" }));
    assert.equal(screen.queryByRole("searchbox", { name: "Find a repository" }), null);
  });

  test("the running-goal poll and the visibility guard keep the plan list fresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = mount((url) => url.startsWith("/api/worktree-plans?") ? response({ plans: [{ ...drafted, running: true, runStep: "Reading the repository" }] }) : undefined);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const planReads = () => calls.filter((call) => call.url.startsWith("/api/worktree-plans?")).length;
    const before = planReads();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    assert.ok(planReads() > before);
    await act(async () => { fireEvent.click(screen.getByText("Board tools")); });
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: /Draft Goals/ })); });
    assert.ok(screen.getByText(/1 planning/));
  });
});
