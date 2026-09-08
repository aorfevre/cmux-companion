import assert from "node:assert/strict";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { AccountUsageView } from "../app/account-usage";
import { AppsView } from "../app/apps-view";
import { MarkdownViewer } from "../app/markdown-viewer";
import { BottomNav, HomeModeSwitch, InboxView, LastUpdateStamp, ManagedGoalControls, PullRequestBanner, TerminalPanel } from "../app/page";
import { TerminalGrid } from "../app/terminal-grid.tsx";
import { WorktreeDashboardView } from "../app/worktree-dashboard";
import { WorktreePlannerSheet } from "../app/worktree-planner";
import { GitHubIssuePicker } from "../app/github-issue-picker";
import { DeploymentHealth } from "../app/deployment-health";
import { DEFAULT_MODEL_ROLES } from "../server/model-options.mjs";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("contextual mobile features", () => {
  test("keeps permanent navigation focused on frequent mobile destinations", async () => {
    const navigate = vi.fn();
    render(<BottomNav view="usage" onView={navigate} />);
    assert.ok(screen.getByRole("button", { name: "Licence Usage" }).classList.contains("active"));
    assert.equal(screen.queryByRole("button", { name: "Apps" }), null);
    assert.equal(screen.queryByRole("button", { name: "Sessions" }), null);
    assert.equal(screen.queryByRole("button", { name: "Inbox" }), null);
    assert.equal(screen.queryByRole("button", { name: "Launch" }), null);
    await userEvent.click(screen.getByRole("button", { name: "Goals" }));
    assert.deepEqual(navigate.mock.calls[0], ["sessions"]);
  });

  test("shows CCS quota by account while treating absent windows as unreported", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-01T10:00:00.000Z"));
    const weeklyReset = new Date(Date.now() + ((3 * 24 + 2) * 60 + 7) * 60_000);
    const usage = { generatedAt: new Date().toISOString(), source: "CCS", available: true, summary: { ready: 1, low: 0, exhausted: 0, reconnect: 1, unavailable: 0 }, providers: [
      { id: "claude", label: "Claude Code", available: true, accounts: [{ id: "one", label: "one", email: "one@example.test", plan: null, isDefault: true, paused: false, status: "ready", message: null, updatedAt: new Date().toISOString(), windows: [
        { id: "usage-5h-0", cadence: "5h", label: "Session limit", category: "usage", remainingPercent: 82, resetAt: new Date(Date.now() + 3_600_000).toISOString(), reported: true },
        { id: "usage-weekly-1", cadence: "weekly", label: "Weekly limit", category: "usage", remainingPercent: 55, resetAt: weeklyReset.toISOString(), reported: true },
        { id: "usage-monthly-2", cadence: "monthly", label: "Monthly provider limit", category: "usage", remainingPercent: 44, resetAt: weeklyReset.toISOString(), reported: true },
        { id: "review-other-3", cadence: "other", label: "Review tokens", category: "code-review", remainingPercent: 90, resetAt: null, reported: true },
      ] }] },
      { id: "codex", label: "OpenAI Codex", available: true, accounts: [{ id: "two", label: "two", email: "two@example.test", plan: "pro", isDefault: false, paused: false, status: "reconnect", message: "Reconnect this account in CCS", updatedAt: null, windows: [] }] },
    ] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => { void input; return new Response(JSON.stringify(usage), { status: 200, headers: { "content-type": "application/json" } }); });
    vi.stubGlobal("fetch", fetchMock);
    const back = vi.fn();
    render(<AccountUsageView onBack={back} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    assert.ok(await screen.findByText("one@example.test"));
    assert.ok(screen.getByText("82%"));
    assert.ok(screen.getByText("55%"));
    const reportedAccount = screen.getByText("one@example.test").closest("article");
    const emptyAccount = screen.getByText("two@example.test").closest("article");
    assert.ok(reportedAccount);
    assert.ok(emptyAccount);
    assert.equal(within(reportedAccount).queryByText("Not reported"), null);
    assert.equal(within(emptyAccount).getAllByText("Not reported").length, 2);
    assert.equal(screen.getAllByText("5 hours").length, 2);
    assert.equal(screen.getAllByText("Weekly").length, 2);
    assert.equal(screen.queryByText("Daily"), null);
    assert.equal(screen.queryByText("Monthly"), null);
    assert.equal(screen.queryByText("Monthly provider limit"), null);
    assert.equal(screen.queryByText("44%"), null);
    assert.ok(within(reportedAccount).getByText("Additional limits"));
    assert.ok(within(reportedAccount).getByText("Review tokens"));
    const countdown = within(reportedAccount).getByText("Resets in 03:02:07");
    assert.equal(countdown.tagName, "TIME");
    assert.equal(countdown.getAttribute("datetime"), weeklyReset.toISOString());
    const fetchesBeforeTick = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    assert.ok(within(reportedAccount).getByText("Resets in 03:02:06"));
    assert.equal(fetchMock.mock.calls.length, fetchesBeforeTick);
    assert.ok(screen.getByText("Reconnect this account in CCS"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh account usage" })); });
    assert.equal(fetchMock.mock.calls.some(([url]) => String(url).endsWith("?refresh=1")), true);
    fireEvent.click(screen.getByRole("button", { name: "‹ Settings" }));
    assert.equal(back.mock.calls.length, 1);
  });

  test("offers a compact phone-safe reconnect flow only for expired accounts", async () => {
    const usage = { generatedAt: new Date().toISOString(), source: "CCS", available: true, summary: { ready: 1, low: 0, exhausted: 0, reconnect: 1, unavailable: 0 }, providers: [
      { id: "claude", label: "Claude Code", available: true, accounts: [{ id: "connected", label: "claude", email: "claude@example.test", plan: null, isDefault: true, paused: false, status: "ready", message: "Connected. Provider reported no active usage window.", updatedAt: null, windows: [] }] },
      { id: "codex", label: "OpenAI Codex", available: true, accounts: [{ id: "0123456789abcdefabcd", label: "codex", email: "codex@example.test", plan: "pro", isDefault: false, paused: false, status: "reconnect", message: "Reconnect this account in CCS", updatedAt: null, windows: [] }] },
    ] };
    const waiting = { sessionId: "session-1", provider: "codex", status: "waiting", message: "Complete the provider login", authUrl: "https://auth.openai.test/authorize?state=safe", expiresAt: "2026-09-01T00:00:00.000Z" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/0123456789abcdefabcd/reconnect") && init?.method === "POST") return new Response(JSON.stringify(waiting), { status: 201 });
      if (url.endsWith("/session-1/callback") && init?.method === "POST") return new Response(JSON.stringify({ ...waiting, status: "success", message: "Account reconnected", authUrl: null }), { status: 200 });
      if (url.endsWith("/session-1")) return new Response(JSON.stringify(waiting), { status: 200 });
      return new Response(JSON.stringify(usage), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountUsageView onBack={() => {}} />);
    assert.ok(await screen.findByText("Connected. Provider reported no active usage window."));
    assert.equal(screen.getAllByRole("button", { name: "Reconnect account" }).length, 1);
    await userEvent.click(screen.getByRole("button", { name: "Reconnect account" }));
    assert.ok(await screen.findByRole("dialog", { name: "Reconnect OpenAI Codex" }));
    assert.equal((await screen.findByRole("link", { name: /Open OpenAI login/ })).getAttribute("href"), waiting.authUrl);
    fireEvent.change(screen.getByRole("textbox", { name: "Localhost callback URL" }), { target: { value: "http://localhost:1455/auth/callback?code=safe&state=safe" } });
    await userEvent.click(screen.getByRole("button", { name: "Finish reconnect" }));
    assert.ok(await screen.findByText("Account reconnected"));
    assert.equal(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/session-1/callback") && init?.method === "POST"), true);
    assert.equal(fetchMock.mock.calls.some(([url]) => String(url).endsWith("?refresh=1")), true);
  });

  test("keeps session tools secondary to the Goals board", async () => {
    const mode = vi.fn();
    render(<HomeModeSwitch mode="sessions" onMode={mode} />);
    assert.ok(screen.getByRole("heading", { name: "Sessions" }));
    await userEvent.click(screen.getByText("Tools"));
    await userEvent.click(screen.getByRole("button", { name: "Goals board" }));
    assert.deepEqual(mode.mock.calls[0], ["worktrees"]);
  });

  test("groups parallel sessions by worktree and launches an isolated agent", async () => {
    const dashboard = { generatedAt: "2026-08-31", summary: { repositories: 1, worktrees: 2, sessions: 1, needsYou: 0, working: 1, dirty: 1, pullRequests: 1 }, orphanSessions: [], repositories: [{
      id: "repo-1", name: "companion", root: "karven", path: "/repo/companion", pullRequestsAvailable: true, summary: { worktrees: 2, sessions: 1, needsYou: 0, working: 1, dirty: 1 }, worktrees: [{
        id: "worktree123456789", repoId: "repo-1", path: "/repo/companion-feature", name: "companion-feature", branch: "feature/mobile", isPrimary: false, detached: false, ahead: 2, behind: 0, changedFiles: 3, dirty: true, lastActivity: Math.round(Date.now() / 1000), state: { label: "Working", tone: "working" },
        pullRequest: { number: 12, title: "Mobile dashboard", url: "https://github.test/pr/12", isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeState: "CLEAN", checks: { passed: 2, failed: 0, pending: 1, total: 3 } },
        sessions: [{ id: "workspace-1", title: "mobile agent", preview: "Editing app/page.tsx", terminalCount: 1, lastActivityAt: Math.round(Date.now() / 1000), provider: "Codex", state: { label: "Working", tone: "working" } }],
      }, {
        id: "worktree987654321", repoId: "repo-1", path: "/repo/companion-old", name: "companion-old", branch: "chore/old-work", isPrimary: false, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, state: { label: "No session", tone: "ready" }, pullRequest: null, sessions: [],
      }] }] };
    const open = vi.fn(); const launched = vi.fn(async (workspaceId: string) => { void workspaceId; }); const notice = vi.fn();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(_input);
      if (url.endsWith("/api/attachments/images") && init?.method === "POST") return new Response(JSON.stringify({ image: { path: "/private/launch.png", name: "launch.png", mime: "image/png", size: 5 } }), { status: 201 });
      if (url.endsWith("/repositories/repo-1/worktrees") && init?.method === "POST") return new Response(JSON.stringify({ branchCreated: true, worktree: { id: "createdworktree123", branch: "feature/new-flow", path: "/repo/companion-feature-new-flow" } }), { status: 201 });
      if (url.endsWith("/createdworktree123/launch") && init?.method === "POST") return new Response(JSON.stringify({ workspace: { workspace_id: "workspace-created" } }), { status: 201 });
      if (init?.method === "POST") return new Response(JSON.stringify({ workspace: { workspace_id: "workspace-new" } }), { status: 201 });
      return new Response(JSON.stringify(dashboard), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<WorktreeDashboardView onOpenWorkspace={open} onLaunched={launched} onNotice={notice} />);
    // The board is the landing view now, so a worktree test opens the Active
    // tab first, exactly as a user would.
    await openOtherViews();
    await userEvent.click(await screen.findByRole("tab", { name: /Active/ }));
    assert.ok(await screen.findByText("feature/mobile"));
    assert.ok(screen.getByText(/GitHub refresh is manual/));
    assert.equal(fetchMock.mock.calls.some(([url]) => String(url).includes("github=1")), false);
    await openOtherViews();
    await userEvent.click(screen.getByRole("button", { name: "Refresh GitHub" }));
    await waitFor(() => assert.equal(fetchMock.mock.calls.some(([url]) => String(url).endsWith("?refresh=1&github=1")), true));
    await userEvent.click(screen.getByRole("tab", { name: /Rekord/ }));
    assert.ok(screen.getByText("No active Rekord projects"));
    await userEvent.click(screen.getByRole("tab", { name: /Karven/ }));
    assert.equal(screen.getByRole("link", { name: /PR #12.*Mobile dashboard/ }).getAttribute("href"), "https://github.test/pr/12");
    await userEvent.click(screen.getByRole("button", { name: "Create worktree for companion" }));
    assert.ok(screen.getByRole("dialog", { name: "Create Git worktree" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Branch name" }), "feature/new-flow");
    assert.equal((screen.getByRole("textbox", { name: "Base revision" }) as HTMLInputElement).value, "feature/mobile");
    await userEvent.click(screen.getByRole("button", { name: "Create & start session" }));
    await waitFor(() => assert.equal(launched.mock.calls.some(([id]) => id === "workspace-created"), true));
    const createCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/repositories/repo-1/worktrees") && init?.method === "POST");
    assert.match(String(createCall?.[1]?.body), /"branch":"feature\/new-flow"/);
    assert.match(String(createCall?.[1]?.body), /"base":"feature\/mobile"/);
    await userEvent.click(screen.getByRole("button", { name: /^mobile agent/ }));
    assert.deepEqual(open.mock.calls[0], ["workspace-1"]);
    await userEvent.click(screen.getByRole("button", { name: "Close session mobile agent" }));
    assert.equal(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/api/workspaces/workspace-1/close") && init?.method === "POST"), true);
    await userEvent.click(screen.getAllByRole("button", { name: "＋ Session" })[0]);
    assert.ok(screen.getByRole("dialog", { name: "Launch worktree session" }));
    await userEvent.click(screen.getByRole("button", { name: "Claude (xclaude)" }));
    const initialTask = screen.getByRole("textbox", { name: "Initial task" });
    await userEvent.type(initialTask, "Review the mobile dashboard");
    const launchImage = new File(["image"], "launch.png", { type: "image/png" });
    fireEvent.paste(initialTask, { clipboardData: { items: [{ type: "image/png", getAsFile: () => launchImage }] } });
    assert.ok(await screen.findByRole("img", { name: "launch.png" }));
    await userEvent.click(screen.getByRole("button", { name: "Launch Claude" }));
    await waitFor(() => assert.equal(launched.mock.calls.some(([id]) => id === "workspace-new"), true));
    const launchCall = fetchMock.mock.calls.find(([url, init]) => String(url).includes("/worktree123456789/launch") && init?.method === "POST");
    assert.ok(launchCall);
    assert.match(String(launchCall?.[1]?.body), /Review the mobile dashboard/);
    assert.match(String(launchCall?.[1]?.body), /Attached image:\\n- \/private\/launch.png/);
    const oldWorktree = screen.getByText("chore/old-work").closest("article");
    assert.ok(oldWorktree);
    await userEvent.click(within(oldWorktree).getByRole("button", { name: "Remove" }));
    assert.ok(within(oldWorktree).getByText("Remove local worktree?"));
    await userEvent.click(within(oldWorktree).getByRole("button", { name: "Confirm remove" }));
    const removeCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/api/worktree-dashboard/worktree987654321") && init?.method === "DELETE");
    assert.ok(removeCall);
    assert.equal(new Headers(removeCall[1]?.headers).has("Content-Type"), false);
    await userEvent.click(screen.getByRole("button", { name: "Archive companion" }));
    assert.ok(screen.getByText("No active Karven projects"));
    assert.equal(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/repositories/repo-1/archive") && init?.method === "PATCH"), true);
    await openOtherViews();
    await userEvent.click(screen.getByRole("tab", { name: /Archived/ }));
    assert.ok(screen.getByRole("button", { name: "Unarchive companion" }));
    await userEvent.click(screen.getByRole("button", { name: "Unarchive companion" }));
    assert.ok(screen.getByText("No archived Karven projects"));
  });

  test("searches projects by name and keeps a favorited project in the Active tab", async () => {
    const repository = (id: string, name: string, sessions: number, favorite: boolean) => ({
      id, name, root: "karven", path: `/repo/${name}`, favorite, pullRequestsAvailable: false,
      summary: { worktrees: 1, sessions, needsYou: 0, working: 0, dirty: 0 },
      worktrees: [{ id: `${id}-primary-wt`, repoId: id, path: `/repo/${name}`, name, branch: "main", isPrimary: true, detached: false, locked: null, prunable: null, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }],
    });
    const dashboard = { generatedAt: "2026-09-01", summary: { repositories: 3, worktrees: 3, sessions: 1, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 }, orphanSessions: [], repositories: [
      repository("repo-busy", "companion", 1, false),
      repository("repo-star", "trust-layer", 0, true),
      repository("repo-idle", "quiet-tools", 0, false),
    ] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      if (String(input).startsWith("/api/worktree-plans")) return new Response(JSON.stringify({ plans: [] }), { status: 200 });
      return new Response(JSON.stringify(dashboard), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreeDashboardView onOpenWorkspace={vi.fn()} onLaunched={vi.fn(async () => {})} onNotice={vi.fn()} />);
    // The board is the landing view now, so this opens Active first.
    await openOtherViews();
    await userEvent.click(await screen.findByRole("tab", { name: /^Active/ }));
    // The favorite has no session, yet Active lists it above the busy project.
    assert.ok(await screen.findByText("trust-layer"));
    assert.ok(screen.getByText("companion"));
    assert.equal(screen.queryByText("quiet-tools"), null);
    await openOtherViews();
    assert.equal(screen.getByRole("tab", { name: /^Active/ }).textContent?.includes("2"), true);
    assert.deepEqual(screen.getAllByRole("group").filter((item) => item.classList.contains("worktree-repository")).map((item) => item.querySelector("strong")?.textContent), ["trust-layer", "companion"]);
    assert.ok(screen.getByText(/2 shown · 3 total/));

    const searchBox = screen.getByRole("searchbox", { name: "Search projects" });
    await userEvent.type(searchBox, "trust");
    assert.equal(screen.queryByText("companion"), null);
    assert.ok(screen.getByText(/1 shown · 3 total/));
    await userEvent.clear(searchBox);
    await userEvent.type(searchBox, "nothing-here");
    assert.ok(screen.getByText(/No project matches/));
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    assert.ok(screen.getByText("companion"));

    // Unfavoriting moves the project out of Active and into Inactive.
    await userEvent.click(screen.getByRole("button", { name: "Unfavorite trust-layer" }));
    await waitFor(() => assert.equal(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/repositories/repo-star/favorite") && init?.method === "PATCH"), true));
    await waitFor(() => assert.equal(screen.queryByText("trust-layer"), null));
    await openOtherViews();
    await userEvent.click(screen.getByRole("tab", { name: /^Inactive/ }));
    assert.ok(screen.getByRole("button", { name: "Favorite trust-layer" }));
    assert.ok(screen.getByText("quiet-tools"));
  });

  test("shows project-wide draft and launched goals and opens the selected saved plan", async () => {
    const repository = (id: string, name: string, root: string) => ({ id, name, root, path: `/repo/${name}`, pullRequestsAvailable: false, summary: { worktrees: 1, sessions: 0, needsYou: 0, working: 0, dirty: 0 }, worktrees: [{ id: `${id}-primary-worktree`, repoId: id, path: `/repo/${name}`, name, branch: "main", isPrimary: true, detached: false, locked: null, prunable: null, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }] });
    const dashboard = { generatedAt: "2026-09-01", summary: { repositories: 2, worktrees: 2, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 }, orphanSessions: [], repositories: [repository("repo-karven", "trust-layer", "karven"), repository("repo-rekord", "recorder", "rekord")] };
    const updatedAt = new Date().toISOString();
    const draft = { planId: "plan-draft", repositoryId: "repo-karven", repositoryName: "trust-layer", goal: "Improve the LLM flow", status: "draft", stage: "ready", round: 2, taskCount: 1, createdAt: updatedAt, updatedAt, launchedAt: null };
    const launched = { planId: "plan-launched", repositoryId: "repo-karven", repositoryName: "trust-layer", goal: "Ship prompt analytics", status: "launched", stage: "ready", round: 1, taskCount: 2, createdAt: updatedAt, updatedAt, launchedAt: updatedAt };
    const rekordDraft = { ...draft, planId: "plan-rekord", repositoryId: "repo-rekord", repositoryName: "recorder", goal: "Improve recording search" };
    const detail = { ...draft, questions: [], tasks: [{ id: "task-1", title: "Polish the model output", branch: "feature/model-output", prompt: "Polish the model output.", agent: "codex", agentReason: "Codex has more headroom" }] };
    const launchedDetail = { ...launched, questions: [], tasks: [{ id: "task-2", title: "Measure prompt quality", branch: "feature/prompt-quality", prompt: "Measure prompt quality.", agent: "claude", agentReason: "Claude has more headroom" }] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/worktree-plans?status=all&limit=200&health=1") return new Response(JSON.stringify({ plans: [draft, launched, rekordDraft] }), { status: 200 });
      if (url === "/api/worktree-plans?repositoryId=repo-karven") return new Response(JSON.stringify({ plans: [draft, launched] }), { status: 200 });
      if (url === "/api/worktree-plans/plan-draft") return new Response(JSON.stringify(detail), { status: 200 });
      if (url === "/api/worktree-plans/plan-launched" && !init?.method) return new Response(JSON.stringify(launchedDetail), { status: 200 });
      if (url === "/api/worktree-plans/plan-launched" && init?.method === "DELETE") return new Response(JSON.stringify({ planId: "plan-launched", deleted: true }), { status: 200 });
      return new Response(JSON.stringify(dashboard), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreeDashboardView onOpenWorkspace={vi.fn()} onLaunched={vi.fn(async () => {})} onNotice={vi.fn()} />);

    await openOtherViews();
    await userEvent.click(await screen.findByRole("tab", { name: /Draft Goals 1/ }));
    const draftGoals = screen.getByRole("region", { name: "Draft goals" });
    assert.ok(within(draftGoals).getByText("Improve the LLM flow"));
    assert.equal(within(draftGoals).queryByText("Improve recording search"), null);
    assert.ok(screen.getByText("1 goal ready to resume."));

    await userEvent.click(within(draftGoals).getByRole("button", { name: "Resume Improve the LLM flow" }));
    const planner = await screen.findByRole("dialog", { name: "Plan a goal" });
    assert.ok(within(planner).getByText("Polish the model output"));
    assert.ok(within(planner).getByText("Round 2 · 1 task"));
    await userEvent.click(within(planner).getByRole("button", { name: "Close goal planner sheet" }));

    await openOtherViews();
    await userEvent.click(screen.getByRole("tab", { name: /Launched Goals 1/ }));
    const launchedGoals = screen.getByRole("region", { name: "Launched goals" });
    assert.ok(within(launchedGoals).getByText("Ship prompt analytics"));
    await userEvent.click(within(launchedGoals).getByRole("button", { name: "View Ship prompt analytics" }));
    const launchedPlanner = await screen.findByRole("dialog", { name: "Plan a goal" });
    assert.ok(within(launchedPlanner).getByRole("heading", { name: "Measure prompt quality" }));
    assert.ok(within(launchedPlanner).getByText("This goal was already launched. The saved plan is read-only."));
    await userEvent.click(within(launchedPlanner).getByRole("button", { name: "Close goal planner sheet" }));
    await userEvent.click(within(launchedGoals).getByRole("button", { name: "Delete Ship prompt analytics" }));
    await userEvent.click(within(launchedGoals).getByRole("button", { name: "Confirm delete Ship prompt analytics" }));
    await waitFor(() => assert.equal(screen.queryByText("Ship prompt analytics"), null));
  });

  test("confirms goal deletion and surfaces the server error verbatim", async () => {
    const repository = (id: string, name: string, root: string) => ({ id, name, root, path: `/repo/${name}`, pullRequestsAvailable: false, summary: { worktrees: 1, sessions: 0, needsYou: 0, working: 0, dirty: 0 }, worktrees: [{ id: `${id}-primary-worktree`, repoId: id, path: `/repo/${name}`, name, branch: "main", isPrimary: true, detached: false, locked: null, prunable: null, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }] });
    const dashboard = { generatedAt: "2026-09-01", summary: { repositories: 1, worktrees: 1, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 }, orphanSessions: [], repositories: [repository("repo-karven", "trust-layer", "karven")] };
    const now = new Date().toISOString();
    const saved = (planId: string, goal: string) => ({ planId, repositoryId: "repo-karven", repositoryName: "trust-layer", goal, status: "draft", stage: "ready", round: 1, taskCount: 2, createdAt: now, updatedAt: now, launchedAt: null });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/plan-delete") && init?.method === "DELETE") return new Response(JSON.stringify({ planId: "plan-delete", deleted: true }), { status: 200 });
      if (url.endsWith("/plan-fail") && init?.method === "DELETE") return new Response(JSON.stringify({ error: "SQLite is busy" }), { status: 503 });
      if (url.startsWith("/api/worktree-plans")) return new Response(JSON.stringify({ plans: [saved("plan-delete", "Delete this goal"), saved("plan-fail", "Keep this goal")] }), { status: 200 });
      return new Response(JSON.stringify(dashboard), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreeDashboardView onOpenWorkspace={vi.fn()} onLaunched={vi.fn(async () => {})} onNotice={vi.fn()} />);

    await openOtherViews();
    await userEvent.click(await screen.findByRole("tab", { name: /Draft Goals 2/ }));
    const goals = screen.getByRole("region", { name: "Draft goals" });
    // Deleting a goal is irreversible, so the first click only arms it.
    await userEvent.click(within(goals).getByRole("button", { name: "Delete Delete this goal" }));
    assert.equal(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"), false);
    await userEvent.click(within(goals).getByRole("button", { name: "Confirm delete Delete this goal" }));
    await waitFor(() => assert.equal(screen.queryByText("Delete this goal"), null));

    // A refused delete keeps the card and repeats the server's own words.
    await userEvent.click(within(goals).getByRole("button", { name: "Delete Keep this goal" }));
    await userEvent.click(within(goals).getByRole("button", { name: "Confirm delete Keep this goal" }));
    assert.ok(await screen.findByText("SQLite is busy"));
    assert.ok(within(goals).getByText("Keep this goal"));
  });

  test("badges a running round on the tab and the goal card, and opens it from a notification link", async () => {
    const repository = (id: string, name: string, root: string) => ({ id, name, root, path: `/repo/${name}`, pullRequestsAvailable: false, summary: { worktrees: 1, sessions: 0, needsYou: 0, working: 0, dirty: 0 }, worktrees: [{ id: `${id}-primary-worktree`, repoId: id, path: `/repo/${name}`, name, branch: "main", isPrimary: true, detached: false, locked: null, prunable: null, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }] });
    const dashboard = { generatedAt: "2026-09-01", summary: { repositories: 1, worktrees: 1, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 }, orphanSessions: [], repositories: [repository("repo-karven", "trust-layer", "karven")] };
    const updatedAt = new Date().toISOString();
    const planning = { planId: "plan-running", repositoryId: "repo-karven", repositoryName: "trust-layer", goal: "Improve the LLM flow", status: "draft", stage: "questions", round: 0, taskCount: 0, running: true, runPhase: "running", runStep: "Grep \"useMemo\"", createdAt: updatedAt, updatedAt, launchedAt: null };
    const idle = { planId: "plan-idle", repositoryId: "repo-karven", repositoryName: "trust-layer", goal: "Ship prompt analytics", status: "draft", stage: "ready", round: 2, taskCount: 1, running: false, createdAt: updatedAt, updatedAt, launchedAt: null };
    const detail = { ...planning, planStatus: "draft", questions: [], tasks: [] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/worktree-plans?")) return new Response(JSON.stringify({ plans: [planning, idle] }), { status: 200 });
      if (url === "/api/worktree-plans/plan-running") return new Response(JSON.stringify(detail), { status: 200 });
      return new Response(JSON.stringify(dashboard), { status: 200 });
    }));
    window.history.replaceState(null, "", "/?view=sessions&mode=worktrees&plan=plan-running");
    render(<WorktreeDashboardView onOpenWorkspace={vi.fn()} onLaunched={vi.fn(async () => {})} onNotice={vi.fn()} />);

    // The deep link resolves the goal independently of board selection.
    const planner = await screen.findByRole("dialog", { name: "Plan a goal" });
    assert.ok(await within(planner).findByRole("region", { name: "Continue discovery" }));
    assert.equal(new URLSearchParams(location.search).get("plan"), "plan-running");
    await userEvent.click(within(planner).getByRole("button", { name: "Close goal planner sheet" }));

    await openOtherViews();
    const tab = screen.getByRole("tab", { name: /Draft Goals/ });
    await userEvent.click(tab);
    assert.ok(within(tab).getByText("1 planning"), "the tab counts the running round");
    const goals = screen.getByRole("region", { name: "Draft goals" });
    assert.ok(within(goals).getByText("Planning…"));
    assert.ok(within(goals).getByText('Grep "useMemo"'));
    assert.equal((within(goals).getByRole("button", { name: "Delete Improve the LLM flow" }) as HTMLButtonElement).disabled, true);
    assert.ok(within(goals).getByRole("button", { name: "Watch Improve the LLM flow" }));
    // A goal with no round running keeps its ordinary controls.
    assert.equal((within(goals).getByRole("button", { name: "Delete Ship prompt analytics" }) as HTMLButtonElement).disabled, false);
    assert.ok(within(goals).getByRole("button", { name: "Resume Ship prompt analytics" }));
  });

  test("collapses managed releases while preserving bulk cleanup and non-managed detached discard", async () => {
    const worktree = (over: Record<string, unknown>) => ({ repoId: "repo-1", head: "abc", locked: null, prunable: null, ahead: 0, behind: 0, changedFiles: 0, dirty: false, detached: false, isPrimary: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" }, ...over });
    const emptyRepo = { id: "repo-2", name: "solo", root: "karven", path: "/repo/solo", pullRequestsAvailable: false, summary: { worktrees: 1, sessions: 0, needsYou: 0, working: 0, dirty: 0 }, worktrees: [worktree({ id: "soloprimary1234567", path: "/repo/solo", name: "solo", branch: "main", isPrimary: true })] };
    const repo = { id: "repo-1", name: "companion", root: "karven", path: "/repo/companion", pullRequestsAvailable: false, summary: { worktrees: 4, releases: 2, sessions: 0, needsYou: 0, working: 0, dirty: 1 }, worktrees: [
      worktree({ id: "primaryworktree123", path: "/repo/companion", name: "companion", branch: "main", isPrimary: true }),
      worktree({ id: "cleanworktree12345", path: "/repo/companion-clean", name: "companion-clean", branch: "chore/clean" }),
      worktree({ id: "lockedworktree1234", path: "/repo/companion-locked", name: "companion-locked", branch: "chore/locked", locked: "pinned" }),
      worktree({ id: "releaseworktree123", path: "/releases/abc123", name: "abc123", branch: "HEAD", detached: true, changedFiles: 2, dirty: true }),
    ], releases: [
      worktree({ id: "managedrelease1234", path: "/Users/test/.local/share/cmux-companion/releases/abcdef0123456789abcdef0123456789abcdef01", name: "abcdef0123456789abcdef0123456789abcdef01", branch: "HEAD", shortSha: "abcdef0", detached: true, managedRelease: true, locked: "release pinned", lastActivity: Math.round(Date.now() / 1000) - 60 }),
      worktree({ id: "managedrelease5678", path: "/Users/test/.local/share/cmux-companion/releases/1234567890abcdef1234567890abcdef12345678", name: "1234567890abcdef1234567890abcdef12345678", branch: "HEAD", shortSha: "1234567", detached: true, managedRelease: true }),
    ] };
    const dashboard = { generatedAt: "2026-08-31", summary: { repositories: 2, worktrees: 5, releases: 2, sessions: 0, needsYou: 0, working: 0, dirty: 1, pullRequests: 0 }, orphanSessions: [], repositories: [repo, emptyRepo] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/repositories/repo-1/remove-clean")) return new Response(JSON.stringify({ repository: { id: "repo-1", name: "companion" }, requested: 1, removed: 0, failed: 1, branchPreserved: true, results: [{ id: "cleanworktree12345", branch: "chore/clean", path: "/repo/companion-clean", removed: false, error: "Git could not remove this worktree: fatal: locked" }] }), { status: 200 });
      if (init?.method === "DELETE") return new Response(JSON.stringify({ removed: true, branchPreserved: true, discardedChanges: true }), { status: 200 });
      return new Response(JSON.stringify(dashboard), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const notice = vi.fn();
    render(<WorktreeDashboardView onOpenWorkspace={vi.fn()} onLaunched={vi.fn(async () => {})} onNotice={notice} />);
    await openOtherViews();
    await userEvent.click(await screen.findByRole("tab", { name: /Inactive/ }));

    // Only the clean, unlocked, session-free, non-primary worktree counts.
    const bulk = screen.getByRole("button", { name: "Remove clean worktrees in companion" });
    assert.equal(bulk.textContent, "Remove clean (1)");
    assert.equal((bulk as HTMLButtonElement).disabled, false);
    const soloBulk = screen.getByRole("button", { name: "Remove clean worktrees in solo" });
    assert.equal(soloBulk.textContent, "Remove clean (0)");
    assert.equal((soloBulk as HTMLButtonElement).disabled, true);

    assert.ok(screen.getByText("4 worktrees · 0 sessions · 2 releases"));
    assert.ok(screen.getByText("2", { selector: ".worktree-hero strong" }));
    const releases = screen.getByText("Deployment releases (2)").closest("details");
    assert.ok(releases);
    assert.equal((releases as HTMLDetailsElement).open, false);
    await userEvent.click(within(releases).getByText("Deployment releases (2)"));
    assert.ok(within(releases).getByText("The local updater owns these checkouts; Companion will not remove them."));
    assert.ok(within(releases).getByText("abcdef0"));
    assert.ok(within(releases).getByText("~/.local/share/cmux-companion/releases/abcdef0123456789abcdef0123456789abcdef01"));
    assert.ok(within(releases).getByText("Locked"));
    assert.equal(within(releases).queryByRole("button"), null);
    assert.equal(within(releases).queryByText("(detached)"), null);

    await userEvent.click(bulk);
    const sheet = screen.getByRole("dialog", { name: "Remove clean worktrees" });
    assert.ok(within(sheet).getByText("Remove 1 clean worktree?"));
    assert.ok(within(sheet).getByText("chore/clean"));
    assert.equal(within(sheet).queryByText("chore/locked"), null);
    assert.equal(within(sheet).queryByText("main"), null);
    await userEvent.click(within(sheet).getByRole("button", { name: "Remove 1 worktree" }));
    await waitFor(() => assert.equal(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/repositories/repo-1/remove-clean") && init?.method === "POST"), true));
    await waitFor(() => assert.equal(notice.mock.calls.some(([message]) => String(message).includes("Removed 0 of 1 worktrees") && String(message).includes("chore/clean (Git could not remove this worktree: fatal: locked)")), true));

    // A non-managed detached checkout is dirty, so it needs a second confirmation
    // that names what is destroyed before the client may pass discardChanges.
    const release = screen.getByText("/releases/abc123").closest("article");
    assert.ok(release);
    await userEvent.click(within(release).getByRole("button", { name: "Remove…" }));
    assert.ok(within(release).getByText("Discard 2 uncommitted changes?"));
    assert.ok(within(release).getByText(/deletes \/releases\/abc123 and its 2 uncommitted files permanently/));
    await userEvent.click(within(release).getByRole("button", { name: "Discard and remove" }));
    await waitFor(() => assert.equal(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/api/worktree-dashboard/releaseworktree123?discardChanges=1") && init?.method === "DELETE"), true));
  });

  test("terminal Markdown and localhost references are interactive", async () => {
    const markdown = vi.fn(); const local = vi.fn();
    render(<TerminalGrid view={{ mode: "text", text: "Read docs/plan.md then http://localhost:3000" }} onMarkdownLink={markdown} onLocalUrl={local} />);
    await userEvent.click(screen.getByRole("button", { name: "docs/plan.md" }));
    await userEvent.click(screen.getByRole("button", { name: "http://localhost:3000" }));
    assert.deepEqual(markdown.mock.calls, [["docs/plan.md"]]);
    assert.deepEqual(local.mock.calls, [["http://localhost:3000"]]);
  });

  test("mobile terminal keeps one composer, hides the native prompt, expands writing, and accepts pasted images", async () => {
    const image = new File(["image"], "paste.png", { type: "image/png" });
    const onImage = vi.fn();
    render(<TerminalPanel
      workspace={{ id: "workspace-1", title: "Sample", terminals: [{ id: "terminal-1", title: "shell" }] }}
      terminal={{ id: "terminal-1", title: "shell" }}
      terminalView={{ mode: "text", text: "result\n\n› Ask Codex to do anything\n\n  gpt-5.6-sol high · ~/repo" }}
      screenError="" draft="/" attachments={[]} queueItems={[]} sending={false} readOnly={false} fontSize={14} fitToPhone shortcutsOpen={false}
      onTerminal={() => {}} onDraft={() => {}} onImage={onImage} onRemoveImage={() => {}} onSubmit={() => {}} onKey={() => {}}
      onQueue={() => {}} onQueueUpdate={async () => {}} onQueueMove={async () => {}} onQueueSend={async () => {}} onQueueRemove={async () => {}}
      onReadOnly={() => {}} onRefresh={() => {}} onShortcuts={() => {}} onMarkdown={() => {}} onLocalUrl={() => {}}
    />);
    assert.equal(screen.getAllByRole("textbox").length, 1);
    assert.equal(screen.queryByText(/Ask Codex to do anything/), null);
    assert.ok(screen.getByRole("button", { name: /^\/help/ }));
    const composer = screen.getByRole("textbox", { name: "Terminal input" });
    fireEvent.paste(composer, { clipboardData: { items: [{ type: "image/png", getAsFile: () => image }] } });
    assert.equal(onImage.mock.calls[0][0], image);
    await userEvent.click(screen.getByRole("button", { name: "Open large writing area" }));
    assert.equal((screen.getByRole("textbox", { name: "Expanded terminal input" }) as HTMLTextAreaElement).value, "/");
  });

  test("queued prompts stay behind a compact composer control and remain editable", async () => {
    const update = vi.fn(async () => {}); const send = vi.fn(async () => {});
    render(<TerminalPanel
      workspace={{ id: "workspace-1", title: "Sample", terminals: [{ id: "terminal-1", title: "shell" }] }}
      terminal={{ id: "terminal-1", title: "shell" }} terminalView={{ mode: "text", text: "working" }} screenError="" draft="" attachments={[]}
      queueItems={[{ id: "11111111-2222-4333-8444-555555555555", workspaceId: "workspace-1", surfaceId: "terminal-1", text: "Run the tests next", createdAt: "2026-01-01", updatedAt: "2026-01-01", attempts: 0 }]}
      sending={false} readOnly={false} fontSize={14} fitToPhone shortcutsOpen={false} onTerminal={() => {}} onDraft={() => {}} onImage={() => {}} onRemoveImage={() => {}} onSubmit={() => {}} onQueue={() => {}} onQueueUpdate={update} onQueueMove={async () => {}} onQueueSend={send} onQueueRemove={async () => {}} onKey={() => {}} onReadOnly={() => {}} onRefresh={() => {}} onShortcuts={() => {}} onMarkdown={() => {}} onLocalUrl={() => {}}
    />);
    await userEvent.click(screen.getByRole("button", { name: "Prompt queue, 1 waiting" }));
    const queued = screen.getByRole("textbox", { name: "Queued prompt 1" });
    await userEvent.clear(queued); await userEvent.type(queued, "Run every test next"); fireEvent.blur(queued);
    assert.deepEqual(update.mock.calls[0], ["11111111-2222-4333-8444-555555555555", "Run every test next"]);
    await userEvent.click(screen.getAllByRole("button", { name: "Send now" }).at(-1)!);
    assert.deepEqual(send.mock.calls[0], ["11111111-2222-4333-8444-555555555555"]);
  });

  test("an open pull request appears as a direct project link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ pullRequest: {
      number: 12, title: "Mobile companion", url: "https://github.com/example/repo/pull/12", state: "OPEN", isDraft: false,
      reviewDecision: "APPROVED", mergeState: "CLEAN", headBranch: "feature", baseBranch: "main",
      checks: { passed: 3, failed: 0, pending: 0, total: 3 },
    } }), { status: 200 })));
    render(<PullRequestBanner repo={{ id: "repo-12345678", name: "sample", root: "root", path: "/repo", branch: "feature", ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 0, scripts: [] }} />);
    const link = await screen.findByRole("link", { name: /#12 Mobile companion/ });
    assert.equal(link.getAttribute("href"), "https://github.com/example/repo/pull/12");
  });

  test("Markdown reader renders rich content and follows safe relative links", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); requests.push(url);
      const guide = url.includes("docs%2Fguide.md");
      return new Response(JSON.stringify({ repo: { id: "repo-12345678", name: "sample", path: "/repo" }, path: guide ? "docs/guide.md" : "README.md", name: guide ? "guide.md" : "README.md", content: guide ? "# Guide\n\nDone." : "# Home\n\n[Guide](docs/guide.md)\n\n```js\nconst ok = true;\n```" }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const ask = vi.fn();
    render(<MarkdownViewer repoId="repo-12345678" path="README.md" onClose={() => {}} onAsk={ask} onOpenWorkspace={() => {}} />);
    assert.ok(await screen.findByRole("heading", { name: "Home" }));
    assert.ok(document.querySelector(".hljs-keyword"), "code is syntax highlighted");
    await userEvent.click(screen.getByRole("button", { name: "Guide" }));
    assert.ok(await screen.findByRole("heading", { name: "Guide" }));
    assert.equal(requests.some((url) => url.includes("docs%2Fguide.md")), true);
    await userEvent.click(screen.getByRole("button", { name: "Ask agent" }));
    assert.equal(ask.mock.calls[0][0].path, "docs/guide.md");
  });

  test("Apps screen explicitly enables and opens a detected private preview", async () => {
    let active = false;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (String(_input).endsWith("/capture")) return new Response(JSON.stringify({ dataUrl: "data:image/png;base64,iVBORw0KGgo=", viewport: { width: 390, height: 844 }, sourceUrl: "http://localhost:3000/" }), { status: 201 });
      if (init?.method === "POST") { active = true; return new Response(JSON.stringify({ preview: {} }), { status: 200 }); }
      return new Response(JSON.stringify({ tailnetOnly: true, previews: [{ id: "preview-1", workspaceId: "workspace-1", name: "Web", targetPort: 3000, sourceUrl: "http://localhost:3000", status: active ? "active" : "detected", url: active ? "https://mac.tail.test:8500" : null, updatedAt: "2026-01-01" }, { id: "preview-old", workspaceId: "workspace-old", name: "Old app", targetPort: 4000, sourceUrl: "http://localhost:4000", status: "stopped", url: null, updatedAt: "2025-01-01" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppsView focusedId="preview-1" onOpenWorkspace={() => {}} onNotice={() => {}} onFix={async () => {}} />);
    assert.equal(screen.queryByText("Old app"), null);
    assert.ok(await screen.findByText("Running · setup needed"));
    await userEvent.click(await screen.findByRole("button", { name: "Create private link" }));
    assert.ok(await screen.findByRole("link", { name: /Open app/ }));
    assert.equal(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/api/previews/preview-1/enable") && init?.method === "POST"), true);
    await userEvent.click(screen.getByRole("button", { name: "◎ Fix this" }));
    assert.ok(await screen.findByRole("dialog", { name: "Annotate preview" }));
    assert.ok(screen.getByRole("img", { name: "Web mobile preview" }));
    await userEvent.click(screen.getByRole("tab", { name: /History/ }));
    const oldCard = (await screen.findByText("Old app")).closest("article");
    assert.ok(oldCard);
    assert.ok(within(oldCard).getByText("Offline"));
    assert.equal(within(oldCard).queryByRole("button", { name: "Create private link" }), null);
    assert.equal(within(oldCard).queryByRole("button", { name: "◎ Fix this" }), null);
  });

  test("notification deep link presents only the exact pending decision", async () => {
    const close = vi.fn(); const reload = vi.fn(async () => {});
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<InboxView inbox={{ actionableCount: 2, unreadCount: 0, items: [
      { id: "req-1", requestId: "req-1", type: "request", kind: "permissionRequest", title: "Run tests", workspaceId: "workspace-1", toolName: "exec", toolInput: { command: "npm test" } },
      { id: "req-2", requestId: "req-2", type: "request", kind: "question", title: "Hidden question" },
    ] }} workspaces={[{ id: "workspace-1", title: "Sample", current_directory: "/repo", terminals: [] }]} repos={[{ id: "repo-12345678", name: "sample", root: "root", path: "/repo", branch: "main", ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 0, scripts: [] }]} focusedId="req-1" onCloseFocus={close} onDocument={() => {}} onReload={reload} onOpen={() => {}} onNotice={() => {}} />);
    assert.ok(screen.getByRole("heading", { name: "Run tests" }));
    assert.equal(screen.queryByText("Hidden question"), null);
    await userEvent.click(screen.getByRole("button", { name: "Approve once" }));
    await waitFor(() => assert.equal(close.mock.calls.length, 1));
    assert.equal(fetchMock.mock.calls[0][0], "/api/inbox/req-1/reply");
  });
});

describe("worktree goal planner", () => {
  const repository = { id: "repo-1", name: "companion" };
  const tasks = [
    { id: "task-1", title: "Build the sheet", branch: "feature/planner-sheet", prompt: "Build the planner sheet.", agent: "codex", agentReason: "UI work suits Codex" },
    { id: "task-2", title: "Wire the routes", branch: "feature/planner-routes", prompt: "Wire the planner routes.", agent: "claude", agentReason: "Server work suits Claude" },
  ];
  const readyDraft = { planId: "plan-1", repositoryId: "repo-1", goal: "Ship the planner", round: 2, status: "ready", questions: [], tasks };

  // Submitting a goal is fire and forget. The companion answers as soon as the
  // plan row exists, so the sheet has nothing left to show and the board takes
  // the goal from there.
  test("a submitted goal closes the sheet and announces itself", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...readyDraft, running: true }), { status: 202 })));
    const close = vi.fn();
    const notice = vi.fn();
    const openConversation = vi.fn();
    render(<WorktreePlannerSheet repository={repository} onClose={close} onNotice={notice} onGoalSessionStarted={openConversation} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Goal" }), "Ship the planner");
    await userEvent.click(screen.getByRole("button", { name: "Start goal session" }));

    await waitFor(() => assert.equal(close.mock.calls.length, 1));
    assert.match(String(notice.mock.calls[0][0]), /Goal session started in cmux for companion/);
    assert.equal(openConversation.mock.calls.length, 0);
  });

  // The submit fails before any plan row exists, so this sheet is the only
  // place the reason can be read. Closing it would throw the goal text away.
  test("a refused goal keeps the sheet open with its reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Unknown repository" }), { status: 400 })));
    const close = vi.fn();
    render(<WorktreePlannerSheet repository={repository} onClose={close} onNotice={() => {}} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Goal" }), "Ship the planner");
    await userEvent.click(screen.getByRole("button", { name: "Start goal session" }));

    assert.ok(await screen.findByText("Unknown repository"));
    assert.equal(close.mock.calls.length, 0);
    assert.equal((screen.getByRole("textbox", { name: "Goal" }) as HTMLTextAreaElement).value, "Ship the planner");
  });

  const formChecks = {
    "Unit tests": true, "End-to-end tests": true, "Edge cases": true, "Refactor review": true,
    "Screen wireframes": false, "Flowcharts": false,
  };
  const defaultSpecOptions = { unitTests: true, e2eTests: true, edgeCases: true, refactorPass: true, screenMocks: false, flowcharts: false };
  const changedSpecOptions = { unitTests: false, e2eTests: false, edgeCases: true, refactorPass: false, screenMocks: true, flowcharts: true };
  const changedChecks = { ...formChecks, "Unit tests": false, "End-to-end tests": false, "Refactor review": false, "Screen wireframes": true, "Flowcharts": true };
  function assertFormChecks(expected = formChecks) {
    for (const [name, checked] of Object.entries(expected)) {
      assert.equal((screen.getByRole("checkbox", { name }) as HTMLInputElement).checked, checked, name);
    }
    assert.equal(within(screen.getByRole("region", { name: "Spec depth" })).getAllByRole("checkbox").length, 6);
  }
  async function changeFormChecks() {
    for (const name of Object.keys(formChecks) as (keyof typeof formChecks)[]) {
      if (formChecks[name] !== changedChecks[name]) await userEvent.click(screen.getByRole("checkbox", { name }));
    }
  }

  for (const [button, endpoint] of [["Start goal session", "/api/goal-sessions"]]) {
    for (const changed of [false, true]) {
      test(`${button} submits ${changed ? "explicit overrides after a failed submit" : "untouched review and spec defaults"} and resets on New goal`, async () => {
        let fail = changed;
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input) === endpoint && init?.method === "POST") {
            if (fail) return new Response(JSON.stringify({ error: "Planner unavailable" }), { status: 503 });
            return new Response(JSON.stringify(readyDraft), { status: 201 });
          }
          return new Response(JSON.stringify({ plans: [] }), { status: 200 });
        });
        vi.stubGlobal("fetch", fetchMock);
        render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onNotice={() => {}} />);
        assertFormChecks();
        if (changed) {
          await changeFormChecks();
        }
        await userEvent.type(screen.getByRole("textbox", { name: "Goal" }), "Ship the planner");
        await userEvent.click(screen.getByRole("button", { name: button }));
        if (changed) {
          assert.ok(await screen.findByText("Planner unavailable"));
          assertFormChecks(changedChecks);
          fail = false;
          await userEvent.click(screen.getByRole("button", { name: button }));
        }
        const posts = fetchMock.mock.calls.filter(([url, init]) => String(url) === endpoint && init?.method === "POST");
        assert.equal(posts.length, changed ? 2 : 1);
        for (const [, init] of posts) {
          const body = JSON.parse(String(init?.body));
          assert.deepEqual(body.engine, { provider: "codex", model: "gpt-6-astra", effort: "default", reviewer: true });
          assert.deepEqual(body.specOptions, changed ? changedSpecOptions : defaultSpecOptions);
          assert.deepEqual(body.reviewOptions, { codeReview: true, reviewer: "claude", reviewerModel: "claude-fable-5-1" });
        }
        await userEvent.click(await screen.findByRole("button", { name: "← New goal" }));
        assertFormChecks();
      });
    }
  }

  test("parent-managed New goal remount restores every form default", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(readyDraft), { status: 200 })));
    function Harness() {
      const [generation, setGeneration] = useState(0);
      return <WorktreePlannerSheet key={generation} repository={repository} onNewGoal={() => setGeneration((current) => current + 1)} onClose={() => {}} onNotice={() => {}} />;
    }
    render(<Harness />);
    await changeFormChecks();
    await userEvent.type(screen.getByRole("textbox", { name: "Goal" }), "Ship the planner");
    await userEvent.click(screen.getByRole("button", { name: "Start goal session" }));
    await userEvent.click(await screen.findByRole("button", { name: "← New goal" }));
    assertFormChecks();
    assert.equal((screen.getByRole("textbox", { name: "Goal" }) as HTMLTextAreaElement).value, "");
  });

  test("resuming a saved goal does not replace its disabled options with form defaults", async () => {
    const saved = {
      ...readyDraft,
      engine: { provider: "codex", model: "gpt-6-astra", effort: "default", reviewer: false },
      reviewOptions: { codeReview: false, reviewer: "claude", reviewerModel: "claude-fable-5-1" },
      specOptions: { unitTests: false, e2eTests: false, edgeCases: false, refactorPass: false, screenMocks: false, flowcharts: false },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input; void init;
      return new Response(JSON.stringify(saved), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const resolved = vi.fn();
    render(<WorktreePlannerSheet repository={repository} initialPlanId="plan-1" onPlanResolved={resolved} onClose={() => {}} onNotice={() => {}} />);
    assert.ok(await screen.findByRole("button", { name: "Continue discovery" }));
    assert.equal(screen.queryByRole("region", { name: "Spec depth" }), null);
    assert.equal(screen.queryByRole("checkbox", { name: "Add a reviewer pass" }), null);
    assert.deepEqual(resolved.mock.calls[0][0], saved);
    assert.equal(fetchMock.mock.calls.some(([, init]) => init?.method === "POST"), false);
  });

  // AC-7. The coverage rows come from the server. The artifacts come from a
  // model, so this also asserts that a label which looks like markup or a link
  // stays literal text.
  test("shows requested option coverage and safely renders flow and screen artifacts", async () => {
    const hostileNode = "<img src=x onerror=alert(1)> step";
    const hostileElement = "Visit https://evil.test/login now";
    const artifactDraft = {
      ...readyDraft,
      contractVersion: 2,
      spec: {
        version: 2, outcome: "Operators can ship billing safely", inScope: [], nonGoals: [], constraints: [], assumptions: [], risks: [],
        acceptanceCriteria: [{ id: "AC-1", text: "API creates invoices", verification: "API tests pass" }],
        optionEvidence: { unitTests: { status: "planned", rationale: "", taskIds: ["task-1"], criterionIds: ["AC-1"] } },
        designArtifacts: [
          {
            id: "F1", kind: "flow", title: "Invoice flow",
            nodes: [
              { id: "n1", label: "Start", kind: "start" },
              { id: "n2", label: hostileNode, kind: "step" },
              { id: "n3", label: "Retry", kind: "decision" },
              { id: "n4", label: "A very long node label that must wrap onto more than one line and then stop", kind: "end" },
              { id: "n5", label: "Detached note", kind: "step" },
            ],
            // n2 → n3 → n2 is a cycle, and n5 is disconnected.
            edges: [{ from: "n1", to: "n2", label: "submit" }, { from: "n2", to: "n3", label: "" }, { from: "n3", to: "n2", label: "retry" }, { from: "n3", to: "n4", label: "" }],
          },
          {
            id: "S1", kind: "screen", title: "Invoice screen", summary: "The invoice screen gains a total and drops the legacy line.",
            screen: {
              name: "Invoice detail",
              elements: [
                { id: "e1", label: "Invoice header", kind: "header", change: "added" },
                { id: "e2", label: hostileElement, kind: "text", change: "changed", note: "Copy review pending" },
                { id: "e3", label: "Legacy total", kind: "text", change: "removed" },
                { id: "e4", label: "Footer", kind: "note", change: "unchanged" },
              ],
            },
          },
        ],
      },
      readiness: {
        ready: true, errors: [], warnings: [], waves: [["task-1"], ["task-2"]], coverage: [],
        optionCoverage: [
          { id: "unitTests", requested: true, status: "covered", message: "task-1 · AC-1" },
          { id: "e2eTests", requested: false, status: "not_requested", message: "" },
          { id: "edgeCases", requested: true, status: "not_applicable", message: "The endpoint takes no input." },
          { id: "refactorPass", requested: true, status: "missing", message: "no linked task has the refactor type" },
          { id: "screenMocks", requested: false, status: "not_requested", message: "" },
          { id: "flowcharts", requested: false, status: "not_requested", message: "" },
        ],
      },
      tasks: [{ ...tasks[0], criterionIds: ["AC-1"], wave: 0 }, { ...tasks[1], wave: 1 }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(artifactDraft), { status: 201 })));
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onNotice={() => {}} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Goal" }), "Ship billing safely");
    await userEvent.click(screen.getByRole("button", { name: "Start goal session" }));

    const passport = await screen.findByRole("region", { name: "Goal passport" });
    await userEvent.click(within(passport).getByRole("tab", { name: "Checks" }));
    // Only requested options appear, each with the server's own status word.
    assert.ok(within(passport).getByText("Unit tests"));
    assert.ok(within(passport).getByText("Covered"));
    assert.ok(within(passport).getByText("Not applicable"));
    assert.ok(within(passport).getByText("Missing"));
    assert.ok(within(passport).getByText("The endpoint takes no input."));
    assert.ok(within(passport).getByText("no linked task has the refactor type"));
    assert.equal(within(passport).queryByText("End-to-end tests"), null);

    await userEvent.click(within(passport).getByRole("tab", { name: "Design" }));
    // The cyclic and disconnected flow renders, and its diagram is named.
    const diagram = within(passport).getByRole("img", { name: "Flow diagram: Invoice flow" });
    assert.equal(diagram.tagName.toLowerCase(), "svg");
    assert.ok(diagram.closest(".spec-flow-scroll"));
    assert.ok(within(passport).getByText("Detached note"));
    assert.ok(within(passport).getByText("retry"));

    // Every element carries a readable change marker.
    assert.ok(within(passport).getByText("Added"));
    assert.ok(within(passport).getByText("Changed"));
    assert.ok(within(passport).getByText("Removed"));
    assert.ok(within(passport).getByText("Unchanged"));
    assert.ok(within(passport).getByText("Invoice header"));

    // The screen names itself, and both artifacts show their summary.
    assert.ok(within(passport).getByText("Invoice detail"));
    assert.ok(within(passport).getByText("The invoice screen gains a total and drops the legacy line."));

    // Hostile-looking strings stay text: no element was injected and no link
    // was created from artifact content.
    assert.equal(passport.querySelector("img"), null);
    assert.equal(within(passport).queryByRole("link"), null);
    assert.ok(within(passport).getByText(hostileElement));
    assert.ok(diagram.textContent?.includes("<img"));
    assert.equal(diagram.querySelector("script"), null);
    assert.equal(diagram.querySelector("foreignObject"), null);
  });

  test("renders a Markdown prompt and still shows its exact text on demand", async () => {
    const markdown = "## Step one\n\n- Touch `server/app.mjs`\n- See https://example.test/issue for the report\n- Do not touch [the store](../store.mjs)\n\nFinish with a pull request.";
    const markdownDraft = { ...readyDraft, tasks: [{ ...tasks[0], prompt: markdown }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(markdownDraft), { status: 201 })));
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onNotice={() => {}} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Goal" }), "Ship the planner");
    await userEvent.click(screen.getByRole("button", { name: "Start goal session" }));

    // The markers are structure, not literal text: a heading is a heading and a
    // list is a list, so no "##" or "-" survives into the rendered output.
    assert.ok(await screen.findByRole("heading", { name: "Step one" }));
    assert.equal(screen.queryByText(/## Step one/), null);
    assert.ok(screen.getAllByRole("listitem").length >= 3);

    // An absolute web link opens in a new tab. A repository-relative link has
    // no resolver in this sheet, so it renders as inert text.
    const link = screen.getByRole("link", { name: "https://example.test/issue" });
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noreferrer");
    assert.equal(screen.queryByRole("link", { name: "the store" }), null);
    assert.ok(screen.getByText("the store"));

    // The agent receives the raw text, so the reviewer must be able to read it.
    await userEvent.click(screen.getByRole("button", { name: "Show Prompt for Build the sheet as raw text" }));
    assert.ok(screen.getByText(/## Step one/));
    await userEvent.click(screen.getByRole("button", { name: "Show Prompt for Build the sheet as Markdown" }));
    assert.ok(screen.getByRole("heading", { name: "Step one" }));
  });

  test("renders the delivery contract, workflow waves, and completion evidence as a Goal Passport", async () => {
    const passportDraft = {
      ...readyDraft,
      contractVersion: 2,
      spec: {
        version: 2, outcome: "Operators can ship billing safely", inScope: ["Billing API", "Billing UI"], nonGoals: ["New payment provider"], constraints: ["Keep the public API stable"], assumptions: ["Stripe sandbox is available"], risks: [{ text: "Provider outage", mitigation: "Keep retries bounded", level: "high" }],
        acceptanceCriteria: [
          { id: "AC-1", text: "API creates invoices", verification: "API tests pass" },
          { id: "AC-2", text: "UI shows invoices", verification: "UI tests pass" },
          { id: "AC-3", text: "Docs explain rollout", verification: "Docs build passes" },
        ],
      },
      readiness: { ready: true, errors: [], warnings: ["One planner assumption remains visible for approval"], waves: [["task-1"], ["task-2", "task-3"]], coverage: [] },
      tasks: [
        { ...tasks[0], criterionIds: ["AC-1"], ownedAreas: ["server/**"], verification: ["npm test"], wave: 0, launchStatus: "launched", deliveryStatus: "integrated", evidenceStatus: "ready", completionReport: { criteria: ["AC-1"], verification: [{ check: "npm test", status: "passed" }], limitations: [] } },
        { ...tasks[1], criterionIds: ["AC-2"], dependsOn: ["task-1"], ownedAreas: ["app/**"], verification: ["npm run test:ui"], wave: 1, launchStatus: "launched", deliveryStatus: "ready", evidenceStatus: "ready", completionReport: { criteria: ["AC-2"], verification: [{ check: "npm run test:ui", status: "passed" }], limitations: ["Safari was not available"] }, scopeWarnings: ["README.md"] },
        { id: "task-3", title: "Write rollout docs", branch: "docs/billing", prompt: "Document it", agent: "claude", agentReason: "", criterionIds: ["AC-3"], dependsOn: ["task-1"], ownedAreas: ["docs/**"], verification: ["npm run build"], wave: 1, launchStatus: "queued", deliveryStatus: "pending" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(passportDraft), { status: 201 })));
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onNotice={() => {}} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Goal" }), "Ship billing safely");
    await userEvent.click(screen.getByRole("button", { name: "Start goal session" }));

    const passport = await screen.findByRole("region", { name: "Goal passport" });
    assert.ok(within(passport).getByText("Operators can ship billing safely"));
    assert.equal(within(passport).queryByText("New payment provider"), null);
    await userEvent.click(within(passport).getByRole("tab", { name: /Impacts/ }));
    assert.ok(within(passport).getByText("New payment provider"));
    assert.ok(within(passport).getByText("One planner assumption remains visible for approval"));
    assert.ok(within(passport).getByText("Provider outage"));
    assert.ok(within(passport).getByText("Keep retries bounded"));
    await userEvent.click(within(passport).getByRole("tab", { name: "Tasks" }));
    assert.ok(within(passport).getByText("Stage 1"));
    assert.ok(within(passport).getByText("Stage 2"));
    assert.ok(within(passport).getByText("Owns: server/**"));
    assert.ok(within(passport).getByText("Verify: npm run test:ui"));
    await userEvent.click(within(passport).getByRole("tab", { name: "Checks" }));
    assert.ok(within(passport).getByText("integrated"));
    assert.ok(within(passport).getByText("completed"));
    assert.ok(within(passport).getByText("planned"));
    assert.ok(within(passport).getByText("Limitation: Safari was not available"));
    assert.ok(within(passport).getByText("Outside ownership: README.md"));
    assert.ok(screen.getByRole("button", { name: "Continue discovery" }));
  });

  test("keeps an approval summary and dependency delivery plan concise until details are requested", async () => {
    const overview = "Review a concise plan before starting work. " + "Keep the saved decision context visible. ".repeat(9);
    const approvalDraft = {
      ...readyDraft,
      deliveryMode: "combined",
      spec: {
        version: 2, outcome: "Operators can review every detail before launch", inScope: ["Planner review"], nonGoals: ["Automatic launch"], constraints: ["Keep saved plans compatible"], assumptions: ["A reviewer opens the plan"], risks: [],
        approvalSummary: {
          overview,
          userFlow: ["Read the plan", "Inspect the waves", "Start work"],
          decisions: [{ choice: "One combined PR", consequence: "The delivery is assembled after every task is ready." }],
          successCriteria: ["Dependencies are visible before launch."],
        },
        acceptanceCriteria: [{ id: "AC-1", text: "The plan is reviewable", verification: "npm run test:ui" }],
      },
      readiness: { ready: false, errors: ["Assign a verification command"], warnings: ["One assumption needs approval"], waves: [["task-1"], ["task-2"]], coverage: [] },
      tasks: [
        { ...tasks[0], title: "Prepare API", criterionIds: ["AC-1"], ownedAreas: ["server/**"], verification: ["npm test"] },
        { ...tasks[1], title: "Publish UI", criterionIds: ["AC-1"], dependsOn: ["task-1"], ownedAreas: ["app/**"], verification: ["npm run test:ui"] },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(approvalDraft), { status: 201 })));
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onNotice={() => {}} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Goal" }), "Make approval clearer");
    await userEvent.click(screen.getByRole("button", { name: "Start goal session" }));

    const passport = await screen.findByRole("region", { name: "Goal passport" });
    assert.equal(within(passport).getByRole("tab", { name: "Overview" }).getAttribute("aria-selected"), "true");
    assert.ok((passport.querySelector(".goal-review-outcome")?.textContent?.length || 0) < 300);
    await userEvent.click(within(passport).getByText("Read the full overview"));
    assert.ok(within(passport).getByText(overview.trim()));
    await userEvent.click(within(passport).getByRole("tab", { name: /Impacts/ }));
    assert.ok(within(passport).getByText("One combined PR"));
    assert.ok(within(passport).getByText("Assign a verification command"));
    assert.ok(within(passport).getByText("One assumption needs approval"));
    assert.ok(within(passport).getByText("Automatic launch"));
    assert.ok(within(passport).getByText("A reviewer opens the plan"));
    await userEvent.click(within(passport).getByRole("tab", { name: "Tasks" }));
    const chart = within(passport).getByRole("region", { name: "Delivery plan" });
    assert.ok(within(chart).getByText("2 tasks · 2 stages"));
    assert.ok(within(chart).getByText(/One combined pull request/));
    const task = chart.querySelectorAll(".delivery-plan-task")[1] as HTMLElement;
    await userEvent.click(within(task).getByText("Scope and checks"));
    assert.ok(within(task).getByText("Scope: The plan is reviewable"));
    assert.ok(within(task).getByText("Files: app/**"));
    const dependencies = within(task).getByText("After task 1").parentElement as HTMLDetailsElement;
    assert.equal(dependencies.open, false);
    await userEvent.click(within(task).getByText("After task 1"));
    assert.equal(dependencies.open, true);
    assert.ok(within(dependencies).getByText("Prepare API"));
    await userEvent.click(within(passport).getByRole("tab", { name: "Overview" }));
    const fullOutcome = within(passport).getByText("Read the full expected outcome").closest("details") as HTMLDetailsElement;
    assert.equal(fullOutcome.open, false);
    await userEvent.click(within(fullOutcome).getByText("Read the full expected outcome"));
    assert.equal(fullOutcome.open, true);
    assert.ok(within(fullOutcome).getByText("Operators can review every detail before launch"));

    const overviewTab = within(passport).getByRole("tab", { name: "Overview" });
    overviewTab.focus();
    await userEvent.keyboard("{ArrowRight}");
    assert.equal(within(passport).getByRole("tab", { name: "Design" }).getAttribute("aria-selected"), "true");
    assert.ok(within(passport).getByRole("list", { name: "User journey" }));
    assert.ok(within(passport).getByText("No design sketches yet"));
    await userEvent.keyboard("{End}");
    assert.equal(within(passport).getByRole("tab", { name: "Checks" }).getAttribute("aria-selected"), "true");
    assert.ok(within(passport).getByText("Assign a verification command"));
    await userEvent.keyboard("{Home}{ArrowLeft}");
    assert.equal(within(passport).getByRole("tab", { name: "Checks" }).getAttribute("aria-selected"), "true");

  });

  test("views launched goals without offering edits or a second launch", async () => {
    const now = new Date().toISOString();
    const summary = { planId: "plan-launched", repositoryId: "repo-1", repositoryName: "companion", goal: "Ship the finished flow", status: "launched", stage: "ready", round: 2, taskCount: 2, launchedCount: 2, createdAt: now, updatedAt: now, launchedAt: now };
    const launchedDraft = { ...readyDraft, planId: "plan-launched", repositoryName: "companion", goal: summary.goal, planStatus: "launched", createdAt: now, updatedAt: now, launchedAt: now, base: "main", history: [] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("?repositoryId=")) return new Response(JSON.stringify({ plans: [summary] }), { status: 200 });
      if (url.endsWith("/plan-launched")) return new Response(JSON.stringify(launchedDraft), { status: 200 });
      return new Response(JSON.stringify({ error: "Unexpected request" }), { status: 400 });
    }));
    render(<WorktreePlannerSheet repository={repository} initialPlanId="plan-launched" onClose={() => {}} onNotice={() => {}} />);

    assert.ok(await screen.findByText("This goal was already launched. The saved plan is read-only."));
    assert.equal(screen.queryByRole("button", { name: "Launch 2 sessions" }), null);
    assert.equal(screen.queryByRole("button", { name: "Remove Build the sheet" }), null);
    assert.equal(screen.queryByRole("button", { name: "Use Codex for Build the sheet" }), null);
    assert.ok(screen.getByRole("button", { name: "← New goal" }));
  });

  test("shows and retries one combined delivery until its final pull request is ready", async () => {
    const now = new Date().toISOString();
    const summary = { planId: "plan-combined", repositoryId: "repo-1", repositoryName: "companion", goal: "Ship together", status: "launched", stage: "ready", deliveryMode: "combined", deliveryStatus: "blocked", round: 2, taskCount: 2, launchedCount: 2, createdAt: now, updatedAt: now, launchedAt: now };
    const launchedDraft = { ...readyDraft, planId: "plan-combined", repositoryName: "companion", goal: summary.goal, planStatus: "launched", deliveryMode: "combined", deliveryStatus: "blocked", deliveryError: "Waiting for one pushed branch", integrationBranch: "goal/ship-together", createdAt: now, updatedAt: now, launchedAt: now };
    const finishedDraft = { ...launchedDraft, deliveryStatus: "pr_open", deliveryError: null, finalPrNumber: 42, finalPrUrl: "https://github.test/pr/42" };
    let detailReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("?repositoryId=")) return new Response(JSON.stringify({ plans: [summary] }), { status: 200 });
      if (url.endsWith("/assemble") && init?.method === "POST") return new Response(JSON.stringify({ planId: "plan-combined", deliveryMode: "combined", deliveryStatus: "pr_open", finalPrNumber: 42, finalPrUrl: finishedDraft.finalPrUrl }), { status: 200 });
      if (url.endsWith("/plan-combined")) return new Response(JSON.stringify(detailReads++ ? finishedDraft : launchedDraft), { status: 200 });
      return new Response(JSON.stringify({ error: "Unexpected request" }), { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreePlannerSheet repository={repository} initialPlanId="plan-combined" onClose={() => {}} onNotice={() => {}} />);

    assert.ok(await screen.findByRole("region", { name: "Combined delivery status" }));
    assert.ok(screen.getByText("Combined delivery needs attention"));
    assert.ok(screen.getByText("Waiting for one pushed branch"));
    await userEvent.click(screen.getByRole("button", { name: "Check & build combined PR" }));
    assert.ok(await screen.findByRole("link", { name: "Open PR #42" }));
    assert.equal(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/assemble")), true);
  });

  test("counts ready task branches and lists each task's delivery state", async () => {
    const now = new Date().toISOString();
    const summary = { planId: "plan-count", repositoryId: "repo-1", repositoryName: "companion", goal: "Ship together", status: "launched", stage: "ready", deliveryMode: "combined", deliveryStatus: "assembling", round: 2, taskCount: 3, launchedCount: 3, createdAt: now, updatedAt: now, launchedAt: now };
    const draft = {
      ...readyDraft, planId: "plan-count", repositoryName: "companion", goal: summary.goal,
      planStatus: "launched", deliveryMode: "combined", deliveryStatus: "assembling",
      createdAt: now, updatedAt: now, launchedAt: now,
      tasks: [
        { id: "t1", title: "API", branch: "feature/api", prompt: "Do", agent: "claude", agentReason: "", launchStatus: "launched", deliveryStatus: "ready" },
        { id: "t2", title: "UI", branch: "feature/ui", prompt: "Do", agent: "claude", agentReason: "", launchStatus: "launched", deliveryStatus: "pending" },
        { id: "t3", title: "Docs", branch: "feature/docs", prompt: "Do", agent: "claude", agentReason: "", launchStatus: "launched", deliveryStatus: "integrated" },
        { id: "t4", title: "Metrics", branch: "feature/metrics", prompt: "Do", agent: "claude", agentReason: "", launchStatus: "failed", deliveryStatus: "pending" },
        { id: "t5", title: "Docs follow-up", branch: "feature/docs-follow-up", prompt: "Do", agent: "claude", agentReason: "", launchStatus: "queued", deliveryStatus: "pending", wave: 1 },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("?repositoryId=")) return new Response(JSON.stringify({ plans: [summary] }), { status: 200 });
      if (url.endsWith("/plan-count")) return new Response(JSON.stringify(draft), { status: 200 });
      return new Response(JSON.stringify({ error: "Unexpected request" }), { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreePlannerSheet repository={repository} initialPlanId="plan-count" onClose={() => {}} onNotice={() => {}} />);

    assert.ok(await screen.findByText("2 of 3 branches ready"));
    const rows = screen.getByRole("list", { name: "Task delivery" });
    assert.ok(within(rows).getByText("API"));
    assert.ok(within(rows).getByText("Metrics"));
    assert.ok(within(rows).getByText("Ready"));
    assert.ok(within(rows).getByText("Waiting"));
    assert.ok(within(rows).getByText("Merged"));
    assert.ok(within(rows).getByText("Not launched"));
    assert.ok(within(rows).getByText("Queued · wave 2"));
  });

  test("counts tasks with no recorded launch status as launched", async () => {
    const now = new Date().toISOString();
    const summary = { planId: "plan-nostatus", repositoryId: "repo-1", repositoryName: "companion", goal: "Ship quietly", status: "launched", stage: "ready", deliveryMode: "combined", deliveryStatus: "assembling", round: 2, taskCount: 2, launchedCount: 2, createdAt: now, updatedAt: now, launchedAt: now };
    const draft = {
      ...readyDraft, planId: "plan-nostatus", repositoryName: "companion", goal: summary.goal,
      planStatus: "launched", deliveryMode: "combined", deliveryStatus: "assembling",
      createdAt: now, updatedAt: now, launchedAt: now,
      tasks: [
        { id: "t1", title: "API", branch: "feature/api", prompt: "Do", agent: "claude", agentReason: "", deliveryStatus: "ready" },
        { id: "t2", title: "UI", branch: "feature/ui", prompt: "Do", agent: "claude", agentReason: "", deliveryStatus: "pending" },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("?repositoryId=")) return new Response(JSON.stringify({ plans: [summary] }), { status: 200 });
      if (url.endsWith("/plan-nostatus")) return new Response(JSON.stringify(draft), { status: 200 });
      return new Response(JSON.stringify({ error: "Unexpected request" }), { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreePlannerSheet repository={repository} initialPlanId="plan-nostatus" onClose={() => {}} onNotice={() => {}} />);

    assert.ok(await screen.findByText("1 of 2 branches ready"));
    const rows = screen.getByRole("list", { name: "Task delivery" });
    assert.ok(within(rows).getByText("Ready"));
    assert.ok(within(rows).getByText("Waiting"));
  });

  // jsdom has no EventSource, so the sheet gets a fake it can drive by hand.
  function fakeEventSource() {
    const opened: { url: string; closed: boolean; emit: (data: unknown) => void }[] = [];
    class FakeEventSource {
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) {
        opened.push({ url, closed: false, emit: (data) => this.onmessage?.({ data: JSON.stringify(data) }) });
        this.index = opened.length - 1;
      }
      index: number;
      close() { opened[this.index].closed = true; }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    return opened;
  }

  test("offers to start the round again when it stopped without a result", async () => {
    fakeEventSource();
    const stalledSummary = { planId: "plan-1", repositoryId: "repo-1", repositoryName: "companion", goal: "Ship the planner", status: "draft", stage: "questions", round: 0, taskCount: 0, launchedCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), launchedAt: null };
    const stalledDraft = { planId: "plan-1", repositoryId: "repo-1", repositoryName: "companion", goal: "Ship the planner", round: 0, status: "questions", planStatus: "draft", questions: [], tasks: [], running: false };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("?repositoryId=")) return new Response(JSON.stringify({ plans: [stalledSummary] }), { status: 200 });
      if (url.endsWith("/continue")) return new Response(JSON.stringify({ ...stalledDraft, workflow: "goal_session", planId: "successor", goalSessionWorkspaceId: "native" }), { status: 200 });
      return new Response(JSON.stringify(stalledDraft), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreePlannerSheet repository={repository} initialPlanId="plan-1" onClose={() => {}} onNotice={() => {}} />);

    const panel = await screen.findByRole("region", { name: "Planning stopped" });
    assert.ok(within(panel).getByText(/A companion restart does this/));
    await userEvent.click(screen.getByRole("button", { name: "Continue discovery" }));
    await waitFor(() => assert.ok(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/continue"))));
    assert.ok(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/goal-sessions/plan-1/continue")));
  });

  test("a refused stopped-goal continuation preserves the goal and can retry on the board", async () => {
    const saved = { ...readyDraft, round: 0, status: "questions" as const, planStatus: "draft" as const,
      tasks: [], questions: [], running: false, images: [{ path: "/tmp/goal.png", name: "goal.png" }] };
    const started = { ...saved, planId: "successor", workflow: "goal_session", goalSessionWorkspaceId: "workspace-new" };
    const close = vi.fn(); const open = vi.fn(); const notice = vi.fn();
    let attempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/goal-sessions/plan-1/continue" && init?.method === "POST") {
        if (++attempts === 1) return new Response(JSON.stringify({ error: "Session unavailable" }), { status: 503 });
        return new Response(JSON.stringify(started), { status: 200 });
      }
      return new Response(JSON.stringify(saved), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreePlannerSheet repository={repository} initialDraft={saved} onClose={close} onGoalSessionStarted={open} onNotice={notice} />);
    assert.equal(screen.queryByRole("button", { name: "Plan this goal again" }), null);
    const button = screen.getByRole("button", { name: "Continue discovery" });
    await userEvent.click(button);
    assert.ok(await screen.findByText("Session unavailable"));
    assert.ok(screen.getByRole("region", { name: "Planning stopped" }));
    assert.ok(screen.getByText("goal.png"));
    assert.equal(close.mock.calls.length, 0);
    assert.equal(notice.mock.calls.length, 0);
    await userEvent.click(button);
    await waitFor(() => assert.equal(close.mock.calls.length, 1));
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    assert.deepEqual(posts.map(([url]) => url), ["/api/goal-sessions/plan-1/continue", "/api/goal-sessions/plan-1/continue"]);
    assert.equal(posts[0][1]?.body, posts[1][1]?.body);
    assert.match(String(notice.mock.calls[0][0]), /Previous context remains saved/);
    assert.equal(open.mock.calls.length, 0);
  });

  // A timeout is not a restart. Blaming one for the other sent a user looking
  // for a crash that never happened, while the real limit stayed invisible.
  test("names the reason a round stopped instead of blaming a restart", async () => {
    fakeEventSource();
    const at = new Date(Date.now() - 3 * 60_000).toISOString();
    const stalledSummary = { planId: "plan-1", repositoryId: "repo-1", repositoryName: "companion", goal: "Ship the planner", status: "draft", stage: "questions", round: 0, taskCount: 0, launchedCount: 0, createdAt: at, updatedAt: at, launchedAt: null };
    const stalledDraft = { planId: "plan-1", repositoryId: "repo-1", repositoryName: "companion", goal: "Ship the planner", round: 0, status: "questions", planStatus: "draft", questions: [], tasks: [], running: false, lastError: "The planner stopped answering: no output for 4 minutes. Try again", lastErrorAt: at };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("?repositoryId=")) return new Response(JSON.stringify({ plans: [stalledSummary] }), { status: 200 });
      return new Response(JSON.stringify(stalledDraft), { status: 200 });
    }));
    render(<WorktreePlannerSheet repository={repository} initialPlanId="plan-1" onClose={() => {}} onNotice={() => {}} />);

    const panel = await screen.findByRole("region", { name: "Planning stopped" });
    assert.ok(within(panel).getByText(/no output for 4 minutes/));
    assert.ok(within(panel).getByText(/3m ago/));
    // The wrong explanation must be gone, not merely accompanied by the right one.
    assert.equal(within(panel).queryByText(/A companion restart does this/), null);
    // The goal is still recoverable either way.
    assert.ok(screen.getByRole("button", { name: "Continue discovery" }));
  });

  // A round that failed seconds ago is still in the run registry, which is
  // fresher than the stored copy.
  test("prefers the live failure over the stored one", async () => {
    fakeEventSource();
    const stalledSummary = { planId: "plan-1", repositoryId: "repo-1", repositoryName: "companion", goal: "Ship the planner", status: "draft", stage: "questions", round: 0, taskCount: 0, launchedCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), launchedAt: null };
    const stalledDraft = { planId: "plan-1", repositoryId: "repo-1", repositoryName: "companion", goal: "Ship the planner", round: 0, status: "questions", planStatus: "draft", questions: [], tasks: [], running: false, runError: "The planner needs the ccs CLI. Install it, then try again", lastError: "an older failure" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("?repositoryId=")) return new Response(JSON.stringify({ plans: [stalledSummary] }), { status: 200 });
      return new Response(JSON.stringify(stalledDraft), { status: 200 });
    }));
    render(<WorktreePlannerSheet repository={repository} initialPlanId="plan-1" onClose={() => {}} onNotice={() => {}} />);

    const panel = await screen.findByRole("region", { name: "Planning stopped" });
    assert.ok(within(panel).getByText(/needs the ccs CLI/));
    assert.equal(within(panel).queryByText(/an older failure/), null);
  });

  test("attaches a pasted image to the goal and drops it again", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/attachments/images") && init?.method === "POST") return new Response(JSON.stringify({ image: { path: "/attachments/goal.png", name: "goal.png", mime: "image/png", size: 5 } }), { status: 201 });
      return new Response(JSON.stringify(readyDraft), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onNotice={() => {}} />);
    const goal = screen.getByRole("textbox", { name: "Goal" });
    await userEvent.type(goal, "Ship the planner");
    const pasted = new File(["image"], "goal.png", { type: "image/png" });
    fireEvent.paste(goal, { clipboardData: { items: [{ type: "image/png", getAsFile: () => pasted }] } });
    assert.ok(await screen.findByRole("img", { name: "goal.png" }));
    await userEvent.click(screen.getByRole("button", { name: "Start goal session" }));
    const planCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/goal-sessions");
    assert.match(String(planCall?.[1]?.body), /"images":\[\{"path":"\/attachments\/goal.png","name":"goal.png"\}\]/);
  });

  test("the remove button drops an attached image", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/attachments/images") && init?.method === "POST") return new Response(JSON.stringify({ image: { path: "/attachments/goal.png", name: "goal.png", mime: "image/png", size: 5 } }), { status: 201 });
      return new Response(JSON.stringify(readyDraft), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onNotice={() => {}} />);
    const goal = screen.getByRole("textbox", { name: "Goal" });
    await userEvent.type(goal, "Ship the planner");
    const pasted = new File(["image"], "goal.png", { type: "image/png" });
    fireEvent.paste(goal, { clipboardData: { items: [{ type: "image/png", getAsFile: () => pasted }] } });
    assert.ok(await screen.findByRole("img", { name: "goal.png" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove goal.png" }));
    assert.equal(screen.queryByRole("img", { name: "goal.png" }), null);
    await userEvent.click(screen.getByRole("button", { name: "Start goal session" }));
    const planCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/goal-sessions");
    assert.match(String(planCall?.[1]?.body), /"images":\[\]/);
  });

  test("shows the goal and the attached image in the context panel", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/attachments/images") && init?.method === "POST") return new Response(JSON.stringify({ image: { path: "/attachments/goal.png", name: "goal.png", mime: "image/png", size: 5 } }), { status: 201 });
      return new Response(JSON.stringify({ ...readyDraft, images: [{ path: "/attachments/goal.png", name: "goal.png" }] }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onNotice={() => {}} />);
    const goal = screen.getByRole("textbox", { name: "Goal" });
    await userEvent.type(goal, "Ship the planner");
    fireEvent.paste(goal, { clipboardData: { items: [{ type: "image/png", getAsFile: () => new File(["image"], "goal.png", { type: "image/png" }) }] } });
    assert.ok(await screen.findByRole("img", { name: "goal.png" }));
    await userEvent.click(screen.getByRole("button", { name: "Start goal session" }));
    assert.ok(await screen.findByText("Build the sheet"));
    const panel = screen.getByLabelText("Your goal and attachments").closest("details") as HTMLElement;
    assert.ok(panel);
    assert.ok(within(panel).getByText("Ship the planner"));
    assert.ok(within(panel).getByRole("img", { name: "goal.png" }));
    // The review panel shows what was sent, so it offers no remove button.
    assert.equal(within(panel).queryByRole("button", { name: "Remove goal.png" }), null);
  });

  test("names an image it cannot preview instead of showing a broken one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...readyDraft, images: [{ path: "/attachments/old.png", name: "old.png" }] }), { status: 201 })));
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onNotice={() => {}} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Goal" }), "Ship the planner");
    await userEvent.click(screen.getByRole("button", { name: "Start goal session" }));
    const panel = (await screen.findByLabelText("Your goal and attachments")).closest("details") as HTMLElement;
    assert.ok(panel);
    assert.ok(within(panel).getByText("old.png"));
    assert.equal(within(panel).queryByRole("img"), null);
  });

  test("a click on the backdrop leaves the planner open", async () => {
    const closed = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(readyDraft), { status: 201 })));
    const { container } = render(<WorktreePlannerSheet repository={repository} onClose={closed} onNotice={() => {}} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Goal" }), "Ship the planner");
    const backdrop = container.querySelector(".session-menu-backdrop");
    assert.ok(backdrop);
    await userEvent.click(backdrop);
    assert.equal(closed.mock.calls.length, 0);
    assert.equal((screen.getByRole("textbox", { name: "Goal" }) as HTMLTextAreaElement).value, "Ship the planner");
    await userEvent.click(screen.getByRole("button", { name: "Close goal planner sheet" }));
    assert.equal(closed.mock.calls.length, 1);
  });

});

describe("goals board", () => {
  const columnPreferenceKey = "cmux-companion-goal-board-column-expansion";
  beforeEach(() => localStorage.removeItem(columnPreferenceKey));
  const now = new Date().toISOString();
  const repository = (id: string, name: string, root: string) => ({ id, name, root, path: `/repo/${name}`, pullRequestsAvailable: false, summary: { worktrees: 1, sessions: 0, needsYou: 0, working: 0, dirty: 0 }, worktrees: [{ id: `${id}-primary-worktree`, repoId: id, path: `/repo/${name}`, name, branch: "main", isPrimary: true, detached: false, locked: null, prunable: null, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }] });
  const dashboard = { generatedAt: "2026-09-01", summary: { repositories: 2, worktrees: 2, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 }, orphanSessions: [], repositories: [repository("repo-karven", "trust-layer", "karven"), repository("repo-rekord", "recorder", "rekord")] };
  const plan = (over: Record<string, unknown> & { planId: string }) => ({ repositoryId: "repo-karven", repositoryName: "trust-layer", goal: "A goal", status: "draft", stage: "ready", round: 1, taskCount: 1, createdAt: now, updatedAt: now, launchedAt: null, ...over });

  // One plan per column, plus a GitHub-issue plan and a Rekord plan.
  const writing = plan({ planId: "plan-writing", goal: "Write the spec", stage: "questions", round: 0, taskCount: 0, running: true, runPhase: "running", runStage: "plan", runStep: "Reading app/page.tsx", boardState: "discovering" });
  const review = plan({ planId: "plan-review", goal: "Review the spec", running: true, runPhase: "running", runStage: "review_spec", runStep: "Anything at all", boardState: "discovering" });
  const waitingDev = plan({ planId: "plan-waiting-dev", goal: "Ready to launch work", taskCount: 3, boardState: "needs_you", sourceType: "github_issues", issueNumbers: [42] });
  const devInProgress = plan({ planId: "plan-dev", goal: "Agents are coding", status: "launched", taskCount: 2, deliveryStatus: "planning", launchedAt: now, boardState: "building" });
  const waitingMerge = plan({ planId: "plan-merge", goal: "Waiting on the PR", status: "launched", taskCount: 2, followupCount: 2, deliveryStatus: "pr_open", launchedAt: now, boardState: "in_review", boardPrState: "OPEN", boardPrNumber: 77, boardPrUrl: "https://github.test/pr/77", verification: { status: "failed", script: "verify", source: "npm run verify", headSha: "abc1234def", reason: null, output: "2 tests failed", startedAt: now, finishedAt: now } });
  const merged = plan({ planId: "plan-merged", goal: "Merged already", status: "launched", taskCount: 4, launchedAt: now, boardState: "shipped", boardStatus: "merged", boardPrState: "MERGED", boardPrNumber: 12, boardPrUrl: "https://github.test/pr/12", verification: { status: "passed", script: "test", source: "npm test", headSha: "fed9876cba", reason: null, output: "", startedAt: now, finishedAt: now } });
  const aborted = plan({ planId: "plan-aborted", goal: "Stopped on purpose", taskCount: 1, boardState: "aborted", boardStatus: "aborted", boardChangedAt: now });
  // A launched goal whose agents died. It used to read as "Dev in progress",
  // which is the one state a supervisor must never be told wrongly.
  const blocked = plan({ planId: "plan-blocked", goal: "Its agent died", status: "launched", taskCount: 2, launchedAt: now, boardState: "stopped", deliveryStatus: "blocked", health: "dead", healthReason: "This task session is no longer open in cmux", stuckCount: 1 });
  const rekord = plan({ planId: "plan-rekord", repositoryId: "repo-rekord", repositoryName: "recorder", goal: "Improve recording search", boardState: "needs_you" });
  const allPlans = [writing, review, waitingDev, devInProgress, waitingMerge, blocked, merged, aborted, rekord];
  const healthSweep = {
    checkedAt: now, sessionsAvailable: true,
    summary: { goals: 2, tasks: 2, stuck: 0, needsYou: 0, working: 2, deadTasks: 0, idleTasks: 0, failedTasks: 0 },
    goals: [
      { planId: "plan-dev", repositoryId: "repo-karven", repositoryName: "trust-layer", goal: "Agents are coding", health: "working", stuckCount: 0, readyCount: 0, launchedCount: 1, taskCount: 1, tasks: [{ id: "T2", title: "Build the board UI", branch: "feature/board-ui", agent: "codex", wave: 1, launchStatus: "launched", launchError: null, deliveryStatus: "pending", workspaceId: "ws-dev", health: "working", reason: "This task agent is running", session: { id: "ws-dev", title: "TL · Agents are coding (pdev) · T2-ui · Build the board UI", lastActivityAt: Date.now(), effective: "working" } }] },
      { planId: "plan-rekord", repositoryId: "repo-rekord", repositoryName: "recorder", goal: "Improve recording search", health: "working", stuckCount: 0, readyCount: 0, launchedCount: 1, taskCount: 1, tasks: [{ id: "T1", title: "Index recording transcripts", branch: "feature/search-index", agent: "claude", wave: 1, launchStatus: "launched", launchError: null, deliveryStatus: "pending", workspaceId: "ws-rekord", health: "working", reason: "This task agent is running", session: { id: "ws-rekord", title: "RCR-T1-api · Index recording transcripts", lastActivityAt: Date.now(), effective: "working" } }] },
    ],
  };

  function mountBoard(plans: unknown[] = allPlans, extra?: (url: string, init?: RequestInit) => Response | null) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const custom = extra?.(url, init);
      if (custom) return custom;
      // The stored issue column is empty unless a test says otherwise, so the
      // goal-column assertions never depend on a synced issue.
      if (url === "/api/github-issues") return new Response(JSON.stringify({ syncedAt: null, issues: [] }), { status: 200 });
      if (url === "/api/goals/health") return new Response(JSON.stringify(healthSweep), { status: 200 });
      if (url.startsWith("/api/worktree-plans")) return new Response(JSON.stringify({ plans }), { status: 200 });
      return new Response(JSON.stringify(dashboard), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreeDashboardView onOpenWorkspace={vi.fn()} onLaunched={vi.fn(async () => {})} onNotice={vi.fn()} />);
    return fetchMock;
  }

  const COLUMNS = [
    ["Discovering", "The agent reads the repository and drafts the delivery contract."],
    ["Needs you", "Answer a question, approve the contract or request changes."],
    ["Building", "Agents are implementing the approved contract."],
    ["Analysis in progress", "The analyst is preparing a read-only report."],
    ["Analysis ready", "Read the saved report, challenge it or launch coding discovery."],
    ["In review", "The pull request is open and waits for review and merge."],
    ["Stopped", "The goal failed or its agent died. A person must decide."],
    ["Shipped", "The goal pull request is merged."],
    ["Aborted", "The goal was stopped on purpose and no more work is expected."],
  ];

  async function openBoard() {
    await openOtherViews();
    await userEvent.click(await screen.findByRole("tab", { name: /Goals board/ }));
    return screen.getByRole("region", { name: "Goals board" });
  }

  async function expandColumn(board: HTMLElement, label: string) {
    await userEvent.click(within(board).getByRole("button", { name: `Expand ${label}` }));
  }

  // The board's second creation button. It must reach a repository picker, open
  // the worktree sheet with a name already filled in, hide the base field, and
  // ask the server for the default remote branch.
  test("creates a worktree from the board on the latest default branch and starts an agent", async () => {
    const launched = vi.fn(async (workspaceId: string) => { void workspaceId; });
    const created = { worktree: { id: "worktree-new", repoId: "repo-karven", path: "/repo/trust-layer-wt", branch: "wt/board", name: "trust-layer-wt" }, branchCreated: true };
    const posts: { url: string; body: string }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.includes("/worktrees")) {
        posts.push({ url, body: String(init.body) });
        return new Response(JSON.stringify(created), { status: 201 });
      }
      if (init?.method === "POST" && url.endsWith("/launch")) {
        posts.push({ url, body: String(init.body) });
        return new Response(JSON.stringify({ workspace: { workspace_id: "ws-board-worktree" } }), { status: 201 });
      }
      if (url === "/api/github-issues") return new Response(JSON.stringify({ syncedAt: null, issues: [] }), { status: 200 });
      if (url === "/api/goals/health") return new Response(JSON.stringify(healthSweep), { status: 200 });
      if (url.startsWith("/api/worktree-plans")) return new Response(JSON.stringify({ plans: allPlans }), { status: 200 });
      return new Response(JSON.stringify(dashboard), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreeDashboardView onOpenWorkspace={vi.fn()} onLaunched={launched} onNotice={vi.fn()} />);
    await openBoard();
    // Two repositories are on the board, so the button opens the picker first.
    await openOtherViews();
    await userEvent.click(screen.getByRole("button", { name: "＋ Worktree" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Create a worktree in trust-layer" }));
    const sheet = await screen.findByRole("dialog", { name: "Create Git worktree" });
    const branch = within(sheet).getByRole("textbox", { name: "Branch name" }) as HTMLInputElement;
    assert.match(branch.value, /^wt\/\d{4}-\d{2}-\d{2}-\d{4}$/);
    // The base is the server's business in this mode, so no field offers one.
    assert.equal(within(sheet).queryByRole("textbox", { name: "Base revision" }), null);
    await userEvent.click(within(sheet).getByRole("button", { name: "New worktree Claude (xclaude)" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Create & start session" }));
    await waitFor(() => assert.equal(launched.mock.calls.some(([id]) => id === "ws-board-worktree"), true));
    const create = posts.find((post) => post.url.includes("/worktrees"));
    assert.match(String(create?.url), /\/repositories\/repo-karven\/worktrees$/);
    assert.deepEqual(JSON.parse(String(create?.body)), { branch: branch.value, useDefaultBase: true });
    const launch = posts.find((post) => post.url.endsWith("/launch"));
    assert.match(String(launch?.url), /\/api\/worktree-dashboard\/worktree-new\/launch$/);
    assert.equal(JSON.parse(String(launch?.body)).agent, "claude");
  });

  test("renders ordered columns with Stopped and terminal defaults collapsed and accurate counts", async () => {
    mountBoard();
    const board = await openBoard();
    await openOtherViews();
    assert.equal(screen.getByRole("tab", { name: /Goals board/ }).textContent?.includes("9"), true);
    const headings = within(board).getAllByRole("heading", { level: 3 }).map((item) => item.textContent);
    // GitHub Issues is the leftmost column, ahead of the eight goal columns.
    assert.deepEqual(headings, ["GitHub Issues", ...COLUMNS.map(([label]) => label)]);
    for (const [label, description] of COLUMNS.slice(0, 5)) assert.ok(within(board).getByText(description), `${label} description`);

    const column = (label: string) => within(board).getByRole("region", { name: label });
    assert.ok(within(column("Discovering")).getByText("Write the spec"));
    assert.ok(within(column("Discovering")).getByText("Review the spec"));
    assert.ok(within(column("Needs you")).getByText("Ready to launch work"));
    assert.ok(within(column("Building")).getByText("Agents are coding"));
    assert.ok(within(column("In review")).getByText("Waiting on the PR"));
    assert.equal(within(column("Stopped")).queryByText("Its agent died"), null);
    assert.ok(within(column("Stopped")).getByLabelText("1 goal in Stopped"));
    assert.ok(within(column("Needs you")).getByLabelText("2 goals in Needs you"));
    assert.ok(within(column("Shipped")).getByLabelText("1 goal in Shipped"));
    assert.ok(within(column("Needs you")).getByRole("list", { name: "Needs you goals" }));
    assert.equal(within(column("Shipped")).queryByText("Merged already"), null);
    assert.equal(within(column("Shipped")).queryByText(COLUMNS[7][1]), null);
    assert.equal(within(column("Aborted")).queryByText("Stopped on purpose"), null);
    assert.equal(within(column("Aborted")).queryByText(COLUMNS[8][1]), null);
    assert.equal(within(column("Shipped")).getByRole("button", { name: "Expand Shipped" }).getAttribute("aria-expanded"), "false");
    assert.equal(within(column("Aborted")).getByRole("button", { name: "Expand Aborted" }).getAttribute("aria-expanded"), "false");
    assert.equal(within(board).getAllByRole("button", { name: /^Collapse / }).length, 7);

    await expandColumn(board, "Shipped");
    await expandColumn(board, "Aborted");
    await expandColumn(board, "Stopped");
    assert.ok(within(column("Stopped")).getByText("Its agent died"));
    assert.ok(within(column("Shipped")).getByText("Merged already"));
    assert.ok(within(column("Shipped")).getByText(COLUMNS[7][1]));
    assert.ok(within(column("Aborted")).getByText("Stopped on purpose"));
    assert.ok(within(column("Aborted")).getByText(COLUMNS[8][1]));
    assert.equal(within(column("Shipped")).getByRole("button", { name: "Collapse Shipped" }).getAttribute("aria-expanded"), "true");
    // Every column renders, so an empty one carries a note instead of nothing.
    assert.equal(within(board).queryAllByText("No goal here yet.").length, 2);

    cleanup();
    localStorage.removeItem(columnPreferenceKey);
    mountBoard([]);
    const emptyBoard = await openBoard();
    assert.equal(within(emptyBoard).getAllByRole("heading", { level: 3 }).length, 10);
    assert.equal(within(emptyBoard).getAllByText("No goal here yet.").length, 6);
  });

  test("toggles any column and restores each choice from localStorage", async () => {
    mountBoard();
    let board = await openBoard();
    await expandColumn(board, "Shipped");
    assert.ok(within(board).getByText("Merged already"));

    cleanup();
    mountBoard();
    board = await openBoard();
    assert.ok(within(board).getByText("Merged already"));
    await userEvent.click(within(board).getByRole("button", { name: "Collapse Shipped" }));
    assert.equal(within(board).queryByText("Merged already"), null);

    cleanup();
    mountBoard();
    board = await openBoard();
    assert.equal(within(board).queryByText("Merged already"), null);
    const waitingToggle = within(board).getByRole("button", { name: "Collapse Needs you" });
    assert.equal(waitingToggle.getAttribute("aria-expanded"), "true");
    await userEvent.click(waitingToggle);
    assert.equal(within(board).queryByText("Ready to launch work"), null);
    assert.equal(within(board).getByRole("button", { name: "Expand Needs you" }).getAttribute("aria-expanded"), "false");
  });

  test("falls back to the shared derivation when a plan carries no usable board state", async () => {
    const missing = plan({ planId: "plan-missing", goal: "No board state at all", status: "launched", taskCount: 1, launchedAt: now, deliveryStatus: "planning" });
    const unknown = plan({ planId: "plan-unknown", goal: "An unknown board state", boardState: "somewhere_else", stage: "ready", round: 2 });
    const runningReview = plan({ planId: "plan-derived-review", goal: "Derived reviewer pass", running: true, runStage: "review_spec", runStep: "Round 2 · rewriting the split" });
    mountBoard([missing, unknown, runningReview]);
    const board = await openBoard();
    assert.ok(within(within(board).getByRole("region", { name: "Building" })).getByText("No board state at all"));
    assert.ok(within(within(board).getByRole("region", { name: "Needs you" })).getByText("An unknown board state"));
    // A running reviewer pass is still discovery; the wording of runStep cannot move it.
    assert.ok(within(within(board).getByRole("region", { name: "Discovering" })).getByText("Derived reviewer pass"));
  });

  // The launch runs on the companion after its request has ended. A goal in
  // that gap is neither idle nor launched, so its card must not repeat "Ready
  // to launch" for the whole minute the worktrees take.
  test("a goal whose launch is in flight reads as launching, not as ready", async () => {
    const launching = plan({ planId: "plan-launching", goal: "Its launch is running", taskCount: 2, boardState: "needs_you", launching: true });
    mountBoard([launching]);
    const board = await openBoard();
    const column = within(board).getByRole("region", { name: "Needs you" });
    assert.ok(within(column).getByText("Its launch is running"));
    assert.ok(within(column).getByText("Creating worktrees and starting sessions…"));
    assert.equal(within(column).queryByText("Ready to launch"), null);

    // Once the launch settles the marker is gone, so the card stops saying it.
    cleanup();
    mountBoard([{ ...launching, launching: false }]);
    const settled = within(await openBoard()).getByRole("region", { name: "Needs you" });
    assert.ok(within(settled).getByText("Ready to launch"));
    assert.equal(within(settled).queryByText("Creating worktrees and starting sessions…"), null);
  });

  test("filters by project and search without changing the status-based goal lists", async () => {
    mountBoard();
    const board = await openBoard();
    assert.equal(screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected"), "true");
    assert.ok(within(board).getByText("Ready to launch work"));
    assert.ok(within(board).getByText("Improve recording search"), "All shows live goals from both repository roots");

    await userEvent.click(screen.getByRole("tab", { name: /Karven/ }));
    const karvenBoard = screen.getByRole("region", { name: "Goals board" });
    assert.ok(within(karvenBoard).getByText("Ready to launch work"));
    assert.equal(within(karvenBoard).queryByText("Improve recording search"), null);

    await userEvent.click(screen.getByRole("tab", { name: /Rekord/ }));
    const rekordBoard = screen.getByRole("region", { name: "Goals board" });
    assert.ok(within(rekordBoard).getByText("Improve recording search"));
    assert.equal(within(rekordBoard).queryByText("Ready to launch work"), null);
    await openOtherViews();
    assert.equal(screen.getByRole("tab", { name: /Goals board/ }).textContent?.includes("1"), true);
    await userEvent.click(screen.getByRole("tab", { name: /Karven/ }));

    const searchBox = screen.getByRole("searchbox", { name: "Search projects" });
    await expandColumn(screen.getByRole("region", { name: "Goals board" }), "Shipped");
    await userEvent.type(searchBox, "Merged already");
    const filtered = screen.getByRole("region", { name: "Goals board" });
    assert.ok(within(filtered).getByText("Merged already"));
    assert.equal(within(filtered).queryByText("Write the spec"), null);
    // Nine goal columns plus the GitHub Issues column. The search filters
    // goals, so every column still renders.
    assert.equal(within(filtered).getAllByRole("heading", { level: 3 }).length, 10);
    await userEvent.clear(searchBox);
    await userEvent.type(searchBox, "trust-layer");
    assert.ok(within(screen.getByRole("region", { name: "Goals board" })).getByText("Write the spec"));
    await userEvent.clear(searchBox);

    // Draft and Launched still count and list by plan.status alone.
    await openOtherViews();
    const draftTab = screen.getByRole("tab", { name: /Draft Goals/ });
    assert.equal(draftTab.textContent?.includes("4"), true);
    await userEvent.click(draftTab);
    const draftGoals = screen.getByRole("region", { name: "Draft goals" });
    assert.deepEqual(within(draftGoals).getAllByRole("article").map((card) => card.querySelector("strong")?.textContent), ["Write the spec", "Review the spec", "Ready to launch work", "Stopped on purpose"]);
    // The aborted draft is read-only, so it never says Resume.
    assert.ok(within(draftGoals).getByRole("button", { name: "View Stopped on purpose" }));
    assert.ok(within(draftGoals).getByText("Aborted"));
    assert.ok(within(draftGoals).getByRole("button", { name: "Resume Ready to launch work" }));

    await openOtherViews();
    const launchedTab = screen.getByRole("tab", { name: /Launched Goals/ });
    // Four launched Karven goals now: the blocked one is launched too.
    assert.equal(launchedTab.textContent?.includes("4"), true);
    await userEvent.click(launchedTab);
    const launchedGoals = screen.getByRole("region", { name: "Launched goals" });
    assert.deepEqual(within(launchedGoals).getAllByRole("article").map((card) => card.querySelector("strong")?.textContent), ["Agents are coding", "Waiting on the PR", "Its agent died", "Merged already"]);
    assert.ok(within(launchedGoals).getByRole("button", { name: "View Merged already" }));
    assert.ok(within(launchedGoals).getByText("Merged"));
  });

  test("the board search narrows the GitHub Issues column, its count, and offers a way back", async () => {
    // The stored issue column, seeded through the same route the column reads.
    const issues = [
      { repositoryId: "repo-karven", repositoryName: "trust-layer", number: 12, title: "Restore the caret", labels: ["editor"], url: "https://github.test/acme/trust-layer/issues/12", updatedAt: now, syncedAt: now, planId: null },
      { repositoryId: "repo-karven", repositoryName: "trust-layer", number: 31, title: "Speed up the indexer", labels: ["performance"], url: "https://github.test/acme/trust-layer/issues/31", updatedAt: now, syncedAt: now, planId: null },
      // A card with no label proves an empty field is skipped, and its number
      // is the only thing the "#44" query can match.
      { repositoryId: "repo-karven", repositoryName: "trust-layer", number: 44, title: "Fix the sync", labels: [], url: "https://github.test/acme/trust-layer/issues/44", updatedAt: now, syncedAt: now, planId: null },
    ];
    mountBoard(allPlans, (url) => (url === "/api/github-issues" ? new Response(JSON.stringify({ syncedAt: now, issues }), { status: 200 }) : null));
    const board = await openBoard();
    const issueColumn = () => within(screen.getByRole("region", { name: "Goals board" })).getByRole("region", { name: "GitHub Issues" });
    await within(issueColumn()).findByText("Restore the caret");
    assert.ok(within(issueColumn()).getByLabelText("3 issues in GitHub Issues"));

    const searchBox = screen.getByRole("searchbox", { name: "Search projects" });
    await userEvent.type(searchBox, "caret");
    assert.ok(within(issueColumn()).getByText("Restore the caret"));
    assert.equal(within(issueColumn()).queryByText("Speed up the indexer"), null);
    // The count comes from the rendered array, so it reads 1, not 3.
    assert.ok(within(issueColumn()).getByLabelText("1 issue in GitHub Issues"));
    assert.equal(within(issueColumn()).getAllByRole("article").length, 1);

    // A label matches, and so does an issue number typed either way.
    await userEvent.clear(searchBox);
    await userEvent.type(searchBox, "performance");
    assert.ok(within(issueColumn()).getByText("Speed up the indexer"));
    assert.ok(within(issueColumn()).getByLabelText("1 issue in GitHub Issues"));
    await userEvent.clear(searchBox);
    await userEvent.type(searchBox, "#44");
    assert.ok(within(issueColumn()).getByLabelText("1 issue in GitHub Issues"));

    // Nothing matches: the column names the query and offers the way back.
    await userEvent.clear(searchBox);
    await userEvent.type(searchBox, "nothing-here");
    assert.ok(within(issueColumn()).getByText("No issue matches “nothing-here”"));
    assert.equal(within(issueColumn()).queryAllByRole("article").length, 0);
    await userEvent.click(within(issueColumn()).getByRole("button", { name: "Clear search" }));
    assert.equal((searchBox as HTMLInputElement).value, "");
    assert.ok(within(issueColumn()).getByLabelText("3 issues in GitHub Issues"));
    assert.ok(within(board).getByText("Write the spec"));
  });

  // A cmux session is never renamed after it is opened, so both title shapes
  // sit on the same board while the fleet turns over. The card must resolve a
  // readable code from each one, and must not invent a code from goal words.
  test("resolves a task code from the new segmented title, a legacy prefix title, and neither", async () => {
    const session = (id: string, title: string) => ({ id, title, lastActivityAt: Date.now(), effective: "working" });
    const codedTask = (id: string, title: string, workspaceId: string, sessionTitle: string) => ({
      id, title, branch: `feature/${id.toLowerCase()}`, agent: "codex", wave: 1, launchStatus: "launched", launchError: null,
      deliveryStatus: "pending", workspaceId, health: "working", reason: "This task agent is running",
      session: session(workspaceId, sessionTitle),
    });
    // The goal text is clipped by the generator's own budget, so the parser is
    // exercised against a realistic long title rather than a short one.
    const longGoal = "TL · Recover every completed goal wave before the mer… (7a2b) · T2-ui · Wire the health sweep";
    const sweep = {
      checkedAt: now, sessionsAvailable: true,
      summary: { goals: 1, tasks: 3, stuck: 0, needsYou: 0, working: 3, deadTasks: 0, idleTasks: 0, failedTasks: 0 },
      goals: [{
        planId: "plan-dev", repositoryId: "repo-karven", repositoryName: "trust-layer", goal: "Agents are coding",
        health: "working", stuckCount: 0, readyCount: 0, launchedCount: 3, taskCount: 3,
        tasks: [
          codedTask("T2", "Wire the health sweep", "ws-new", longGoal),
          codedTask("T5", "Carry the legacy title", "ws-legacy", "TL-T5-api · Carry the legacy title"),
          codedTask("T9", "Ship T7-api parity", "ws-bare", "Ship T7-api parity"),
        ],
      }],
    };
    mountBoard(allPlans, (url) => (url === "/api/goals/health" ? new Response(JSON.stringify(sweep), { status: 200 }) : null));
    const board = await openBoard();
    const card = within(board).getByText("Agents are coding").closest("article") as HTMLElement;

    // The new shape: the task-part segment, taken from the middle of the title.
    assert.ok(within(card).getByLabelText("T2-ui: Wire the health sweep"));
    // The legacy shape: the leading prefix still resolves to a code.
    assert.ok(within(card).getByLabelText("TL-T5-api: Carry the legacy title"));
    // No code segment at all: the raw task id, never a word from the goal text.
    assert.ok(within(card).getByLabelText("T9: Ship T7-api parity"));
    assert.equal(within(card).queryByLabelText("T7-api: Ship T7-api parity"), null);
  });

  test("shows card metadata, lifecycle evidence, and pull-request links", async () => {
    mountBoard();
    const board = await openBoard();
    await expandColumn(board, "Shipped");
    await expandColumn(board, "Aborted");
    await expandColumn(board, "Stopped");
    const card = (goal: string) => within(board).getByText(goal).closest("article") as HTMLElement;

    const dev = card("Ready to launch work");
    assert.ok(within(dev).getByText("trust-layer"));
    assert.ok(within(dev).getByText("3 tasks"));
    assert.ok(within(dev).getByText("Updated now"));
    assert.ok(within(dev).getByText("Ready to launch"));

    assert.ok(within(card("Write the spec")).getByText("Reading app/page.tsx"));
    assert.ok(within(card("Agents are coding")).getByText("Agents are working on the launched tasks"));
    assert.ok(within(card("Agents are coding")).getByLabelText("T2-ui: Build the board UI"));
    assert.ok(within(card("Stopped on purpose")).getByText("Stopped. Branches and worktrees were kept."));
    assert.ok(within(card("Merged already")).getByText("4 tasks"));

    assert.equal(within(card("Waiting on the PR")).getByRole("link", { name: "Open PR #77" }).getAttribute("href"), "https://github.test/pr/77");
    assert.equal(within(card("Merged already")).getByRole("link", { name: "Open PR #12" }).getAttribute("href"), "https://github.test/pr/12");
    assert.equal(within(card("Agents are coding")).queryByRole("link"), null);
    // The contract's own check, run by Companion on the goal branch: the one
    // piece of evidence that is not the agent's prose.
    assert.ok(within(card("Waiting on the PR")).getByText("Contract check failed"));
    assert.ok(within(card("Waiting on the PR")).getByTitle("npm run verify on abc1234 · 2 tests failed"));
    assert.ok(within(card("Merged already")).getByText("Contract check passed"));
    assert.equal(within(card("Agents are coding")).queryByText(/Contract check/), null);

    // Nonterminal cards reuse the planner sheet; terminal ones open read-only.
    assert.ok(within(card("Write the spec")).getByRole("button", { name: "Watch Write the spec" }));
    assert.ok(within(card("Ready to launch work")).getByRole("button", { name: "Resume Ready to launch work" }));
    assert.ok(within(card("Agents are coding")).getByRole("button", { name: "View Agents are coding" }));
    assert.ok(within(card("Merged already")).getByRole("button", { name: "View Merged already" }));
    assert.ok(within(card("Stopped on purpose")).getByRole("button", { name: "View Stopped on purpose" }));
    assert.ok(within(card("Waiting on the PR")).getByText("2 follow-ups"));
  });

  test("offers follow-up actions only on In review and submits several actions in one request", async () => {
    const issue = { repositoryId: "repo-karven", repositoryName: "trust-layer", number: 91, title: "Issue without follow-ups", labels: [], url: "https://github.test/issues/91", updatedAt: now, syncedAt: now, planId: null };
    let planReads = 0;
    const fetchMock = mountBoard(allPlans, (url, init) => {
      if (url === "/api/github-issues") return new Response(JSON.stringify({ syncedAt: now, issues: [issue] }), { status: 200 });
      if (url === "/api/worktree-plans/plan-merge/followups" && init?.method === "POST") return new Response(JSON.stringify({ planId: "plan-merge", workspaceId: "followup-workspace", agent: "codex", actions: ["question", "review"], branch: "goal/merge", worktreePath: "/repo/goal-merge", pullRequest: { number: 77, url: "https://github.test/pr/77" }, title: "Follow up" }), { status: 200 });
      if (url.startsWith("/api/worktree-plans") && (!init?.method || init.method === "GET")) { planReads += 1; return new Response(JSON.stringify({ plans: allPlans }), { status: 200 }); }
      return null;
    });
    const board = await openBoard();
    await within(board).findByText(issue.title);
    await expandColumn(board, "Stopped");
    // Merged and Aborted start collapsed, so their cards render only once the
    // column is expanded. The point of this test is that a terminal goal
    // offers no follow-up button, which needs the card on the page to prove.
    await userEvent.click(within(board).getByRole("button", { name: "Expand Shipped" }));
    await userEvent.click(within(board).getByRole("button", { name: "Expand Aborted" }));
    const card = (goal: string) => within(board).getByText(goal).closest("article") as HTMLElement;

    assert.ok(within(card("Waiting on the PR")).getByRole("button", { name: "More actions for Waiting on the PR" }));
    for (const goal of ["Its agent died", "Agents are coding", "Merged already", "Stopped on purpose"]) {
      assert.equal(within(card(goal)).queryByRole("button", { name: /More actions/ }), null, goal);
    }
    const issueCard = within(board).getByText(issue.title).closest("article") as HTMLElement;
    assert.equal(within(issueCard).queryByRole("button", { name: /More actions/ }), null);

    await userEvent.click(within(card("Waiting on the PR")).getByRole("button", { name: "More actions for Waiting on the PR" }));
    const sheet = screen.getByRole("dialog", { name: "More actions for Waiting on the PR" });
    for (const label of ["Ask a question", "More unit and e2e tests", "Complete code review", "Something else"]) assert.ok(within(sheet).getByText(label));
    assert.equal((within(sheet).getByRole("radio", { name: "Claude" }) as HTMLInputElement).checked, true);

    const postCount = () => fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/followups") && init?.method === "POST").length;
    await userEvent.click(within(sheet).getByRole("button", { name: "Submit follow-up" }));
    assert.ok(await within(sheet).findByText("Pick at least one follow-up action"));
    assert.equal(postCount(), 0);

    await userEvent.click(within(sheet).getByRole("checkbox", { name: /^Ask a question/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Submit follow-up" }));
    assert.ok(await within(sheet).findByText("Write the question you want answered"));
    assert.equal(postCount(), 0);

    await userEvent.type(within(sheet).getByRole("textbox", { name: "Ask a question details" }), "Which edge cases remain?");
    await userEvent.click(within(sheet).getByRole("checkbox", { name: /^Complete code review/ }));
    await userEvent.click(within(sheet).getByRole("radio", { name: "Codex" }));
    const readsBeforeSubmit = planReads;
    await userEvent.click(within(sheet).getByRole("button", { name: "Submit follow-up" }));

    await waitFor(() => assert.equal(postCount(), 1));
    const post = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/followups") && init?.method === "POST");
    assert.equal(String(post?.[0]), "/api/worktree-plans/plan-merge/followups");
    assert.deepEqual(JSON.parse(String(post?.[1]?.body)), { actions: ["question", "review"], question: "Which edge cases remain?", agent: "codex" });
    await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "More actions for Waiting on the PR" }), null));
    await waitFor(() => assert.ok(planReads > readsBeforeSubmit));
  });

  test("keeps the follow-up sheet open when the server refuses the request", async () => {
    const fetchMock = mountBoard(allPlans, (url, init) => url === "/api/worktree-plans/plan-merge/followups" && init?.method === "POST"
      ? new Response(JSON.stringify({ error: "The pull request branch is no longer available", code: "FOLLOWUP_BRANCH_MISSING" }), { status: 400 })
      : null);
    const board = await openBoard();
    await userEvent.click(within(board).getByRole("button", { name: "More actions for Waiting on the PR" }));
    const sheet = screen.getByRole("dialog", { name: "More actions for Waiting on the PR" });
    await userEvent.click(within(sheet).getByRole("checkbox", { name: /^More unit and e2e tests/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Submit follow-up" }));

    assert.ok(await within(sheet).findByText("The pull request branch is no longer available"));
    assert.ok(screen.getByRole("dialog", { name: "More actions for Waiting on the PR" }));
    assert.equal(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/followups") && init?.method === "POST").length, 1);
  });

  test("makes a blocked merge agree with cmux evidence, counters, and focus actions", async () => {
    const mergeBlocked = plan({
      planId: "plan-merge-blocked",
      goal: "Assemble the two ready tasks",
      status: "launched",
      taskCount: 2,
      launchedCount: 2,
      readyCount: 2,
      launchedAt: now,
      boardState: "stopped",
      deliveryStatus: "blocked",
      deliveryError: "The merge agent stopped before opening the pull request",
      mergeStatus: "blocked",
      mergeWorkspaceId: "ws-merge",
      workspaceIds: ["ws-task", "ws-merge"],
      health: "failed",
      healthReason: "The merge agent stopped before opening the pull request",
    });
    const mergeHealth = {
      checkedAt: now,
      sessionsAvailable: true,
      summary: { goals: 1, tasks: 2, stuck: 1, needsYou: 0, working: 0, deadTasks: 0, idleTasks: 0, failedTasks: 0 },
      goals: [{
        planId: "plan-merge-blocked", repositoryId: "repo-karven", repositoryName: "trust-layer", goal: "Assemble the two ready tasks",
        health: "failed", stuckCount: 1, readyCount: 2, launchedCount: 2, taskCount: 2, deliveryStatus: "blocked", tasks: [],
        merge: { id: "merge", kind: "merge", title: "Goal merge", workspaceId: "ws-merge", health: "failed", reason: "The merge agent stopped before opening the pull request", session: { id: "ws-merge", title: "TL-MERGE · Assemble goal", lastActivityAt: Date.now(), effective: "todo" } },
      }],
    };
    const selected: string[] = [];
    mountBoard([mergeBlocked], (url, init) => {
      if (url === "/api/goals/health") return new Response(JSON.stringify(mergeHealth), { status: 200 });
      if (url === "/api/workspaces/ws-merge/select" && init?.method === "POST") { selected.push(url); return new Response(JSON.stringify({ selected: true }), { status: 200 }); }
      return null;
    });
    const board = await openBoard();
    await expandColumn(board, "Stopped");
    const card = within(board).getByText("Assemble the two ready tasks").closest("article") as HTMLElement;

    assert.equal(within(card).getAllByText("The merge agent stopped before opening the pull request").length, 2);
    assert.ok(screen.getByRole("button", { name: "1 stuck goals. Show the tasks that need you" }));
    const rail = screen.getByRole("region", { name: "Goals needing attention" });
    assert.ok(within(rail).getByText("Goal merge"));
    assert.equal(within(rail).queryByRole("button", { name: /Continue|Restart|Skip/ }), null);

    await userEvent.click(within(card).getByRole("button", { name: "Open Assemble the two ready tasks in cmux" }));
    await waitFor(() => assert.deepEqual(selected, ["/api/workspaces/ws-merge/select"]));
  });

  test("does not offer a cmux focus action for a stale persisted workspace id", async () => {
    const stale = plan({
      planId: "plan-stale-session",
      goal: "Workspace already closed",
      status: "launched",
      taskCount: 1,
      launchedCount: 1,
      launchedAt: now,
      boardState: "stopped",
      deliveryStatus: "blocked",
      workspaceIds: ["ws-gone"],
      health: "dead",
      healthReason: "This task session is no longer open in cmux",
    });
    const staleHealth = {
      checkedAt: now,
      sessionsAvailable: true,
      summary: { goals: 1, tasks: 1, stuck: 1, needsYou: 0, working: 0, deadTasks: 1, idleTasks: 0, failedTasks: 0 },
      goals: [{
        planId: "plan-stale-session", repositoryId: "repo-karven", repositoryName: "trust-layer", goal: "Workspace already closed",
        health: "dead", stuckCount: 1, readyCount: 0, launchedCount: 1, taskCount: 1, deliveryStatus: "blocked", merge: null,
        tasks: [{ id: "T1", title: "Closed task", branch: "feature/closed", agent: "codex", wave: 0, launchStatus: "launched", launchError: null, deliveryStatus: "pending", workspaceId: "ws-gone", health: "dead", reason: "This task session is no longer open in cmux", session: null }],
      }],
    };
    mountBoard([stale], (url) => url === "/api/goals/health" ? new Response(JSON.stringify(staleHealth), { status: 200 }) : null);
    const board = await openBoard();
    await expandColumn(board, "Stopped");
    const card = within(board).getByText("Workspace already closed").closest("article") as HTMLElement;

    assert.equal(within(card).queryByRole("button", { name: "Open Workspace already closed in cmux" }), null);
  });

  test("aborts a goal behind an inline confirmation and reports partial session failures", async () => {
    let plans: unknown[] = allPlans;
    let abortCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/abort") && init?.method === "POST") {
        abortCalls += 1;
        plans = allPlans.map((item) => item.planId === "plan-waiting-dev" ? { ...item, boardState: "aborted", boardStatus: "aborted", status: "draft" } : item);
        return new Response(JSON.stringify({ planId: "plan-waiting-dev", aborted: true, alreadyAborted: false, closedSessionIds: ["workspace-1"], failedSessionIds: abortCalls === 1 ? ["workspace-2"] : [] }), { status: 200 });
      }
      if (url.startsWith("/api/worktree-plans")) return new Response(JSON.stringify({ plans }), { status: 200 });
      return new Response(JSON.stringify(dashboard), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreeDashboardView onOpenWorkspace={vi.fn()} onLaunched={vi.fn(async () => {})} onNotice={vi.fn()} />);
    const board = await openBoard();
    await expandColumn(board, "Shipped");
    await expandColumn(board, "Aborted");
    await expandColumn(board, "Stopped");
    const card = (goal: string) => within(screen.getByRole("region", { name: "Goals board" })).getByText(goal).closest("article") as HTMLElement;

    // Terminal cards never offer Abort.
    assert.equal(within(card("Merged already")).queryByRole("button", { name: "Abort Merged already" }), null);
    assert.equal(within(card("Stopped on purpose")).queryByRole("button", { name: "Abort Stopped on purpose" }), null);
    // Every non-terminal goal offers Abort, and the blocked goal is one of them.
    assert.equal(within(board).getAllByRole("button", { name: /^Abort / }).length, 7);

    // The first click replaces the footer with the warning, and Cancel undoes it.
    await userEvent.click(within(card("Ready to launch work")).getByRole("button", { name: "Abort Ready to launch work" }));
    assert.ok(within(card("Ready to launch work")).getByText("Abort this goal? Active specification work and live cmux sessions are cancelled. Its worktrees and branches are kept."));
    assert.equal(within(card("Ready to launch work")).queryByRole("button", { name: "Resume Ready to launch work" }), null);
    await userEvent.click(within(card("Ready to launch work")).getByRole("button", { name: "Cancel aborting Ready to launch work" }));
    assert.ok(within(card("Ready to launch work")).getByRole("button", { name: "Resume Ready to launch work" }));
    assert.equal(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/abort")), false);

    await userEvent.click(within(card("Ready to launch work")).getByRole("button", { name: "Abort Ready to launch work" }));
    await userEvent.click(within(card("Ready to launch work")).getByRole("button", { name: "Confirm abort Ready to launch work" }));
    await waitFor(() => assert.ok(within(within(screen.getByRole("region", { name: "Goals board" })).getByRole("region", { name: "Aborted" })).getByText("Ready to launch work")));
    const abortCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/abort"));
    assert.equal(String(abortCall?.[0]), "/api/worktree-plans/plan-waiting-dev/abort");
    assert.equal(abortCall?.[1]?.method, "POST");
    // The goal stays aborted, and the warning names the retryable failure.
    assert.ok(await screen.findByText(/1 cmux session could not be closed. Abort is safe to retry/));
    assert.equal(abortCalls, 1);
    // The warning has the shared goal Retry, which reloads the list and clears it.
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => assert.equal(screen.queryByText(/could not be closed/), null));
    assert.equal(within(card("Ready to launch work")).queryByRole("button", { name: "Abort Ready to launch work" }), null);
    assert.ok(within(card("Ready to launch work")).getByRole("button", { name: "View Ready to launch work" }));
  });

  test("encodes the plan id and keeps the card in place when the abort request fails", async () => {
    const awkward = plan({ planId: "plan/with space", goal: "Awkward id goal", boardState: "needs_you" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/abort") && init?.method === "POST") return new Response(JSON.stringify({ error: "cmux is unreachable" }), { status: 502 });
      if (url.startsWith("/api/worktree-plans")) return new Response(JSON.stringify({ plans: [awkward] }), { status: 200 });
      return new Response(JSON.stringify(dashboard), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreeDashboardView onOpenWorkspace={vi.fn()} onLaunched={vi.fn(async () => {})} onNotice={vi.fn()} />);
    await openBoard();
    await userEvent.click(screen.getByRole("button", { name: "Abort Awkward id goal" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm abort Awkward id goal" }));
    assert.ok(await screen.findByText("cmux is unreachable"));
    const abortCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/abort"));
    assert.equal(String(abortCall?.[0]), "/api/worktree-plans/plan%2Fwith%20space/abort");
    assert.ok(within(screen.getByRole("region", { name: "Needs you" })).getByText("Awkward id goal"));
  });

  test("Refresh GitHub reads the plan list only after the reconciled dashboard resolves", async () => {
    const order: string[] = [];
    let releaseDashboard: (() => void) | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("github=1")) {
        order.push("dashboard-start");
        await new Promise<void>((resolve) => { releaseDashboard = resolve; });
        order.push("dashboard-end");
        return new Response(JSON.stringify(dashboard), { status: 200 });
      }
      if (url.startsWith("/api/worktree-plans")) { order.push("plans"); return new Response(JSON.stringify({ plans: allPlans }), { status: 200 }); }
      return new Response(JSON.stringify(dashboard), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreeDashboardView onOpenWorkspace={vi.fn()} onLaunched={vi.fn(async () => {})} onNotice={vi.fn()} />);
    await openOtherViews();
    await screen.findByRole("tab", { name: /Goals board/ });
    order.length = 0;
    await openOtherViews();
    await userEvent.click(screen.getByRole("button", { name: "Refresh GitHub" }));
    await waitFor(() => assert.equal(order[0], "dashboard-start"));
    // No plan request may start while the reconciliation is still open.
    assert.equal(order.includes("plans"), false);
    await act(async () => { releaseDashboard?.(); await Promise.resolve(); });
    await waitFor(() => assert.deepEqual(order, ["dashboard-start", "dashboard-end", "plans"]));
  });

  test("a terminal planner sheet is a record with no mutating control", async () => {
    const mergedDetail = { planId: "plan-merged", repositoryId: "repo-1", goal: "Merged already", round: 2, status: "ready", planStatus: "launched", deliveryMode: "combined", deliveryStatus: "pr_open", boardStatus: "merged", boardState: "shipped", boardChangedAt: now, boardPrState: "MERGED", boardPrNumber: 12, boardPrUrl: "https://github.test/pr/12", finalPrNumber: 12, finalPrUrl: "https://github.test/pr/12", questions: [], tasks: [{ id: "task-1", title: "Build the sheet", branch: "feature/sheet", prompt: "Build it.", agent: "codex", agentReason: "UI work suits Codex", deliveryStatus: "integrated" }] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("?repositoryId=")) return new Response(JSON.stringify({ plans: [] }), { status: 200 });
      return new Response(JSON.stringify(mergedDetail), { status: 200 });
    }));
    render(<WorktreePlannerSheet repository={{ id: "repo-1", name: "companion" }} initialPlanId="plan-merged" onClose={() => {}} onNotice={() => {}} />);
    const sheet = await screen.findByRole("dialog", { name: "Plan a goal" });
    assert.ok(await within(sheet).findByRole("region", { name: "Merged goal" }));
    assert.ok(within(sheet).getByText("This goal is merged"));
    // The historical plan is still readable.
    assert.equal(within(sheet).getAllByText("Build the sheet").length, 2);
    assert.ok(within(sheet).getByText("Round 2 · 1 task"));
    assert.equal(within(sheet).getAllByRole("link", { name: "Open PR #12" }).length, 1);
    for (const name of ["Answer", "Skip questions", "This plan is wrong", "Check & build combined PR", "Plan this goal again", "Remove Build the sheet"]) {
      assert.equal(within(sheet).queryByRole("button", { name }), null, `${name} must be suppressed`);
    }
    assert.equal(within(sheet).queryByRole("button", { name: /^Launch / }), null);
    // Closing stays available.
    assert.ok(within(sheet).getByRole("button", { name: "Close goal planner sheet" }));

    cleanup();
    const abortedDetail = { ...mergedDetail, planId: "plan-aborted", goal: "Stopped on purpose", boardStatus: "aborted", boardState: "aborted", boardPrState: null, boardPrUrl: null, boardPrNumber: null, finalPrUrl: null, finalPrNumber: null, planStatus: "draft", status: "questions", questions: [{ id: "q1", text: "Which browsers?", options: ["All"] }], tasks: [] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("?repositoryId=")) return new Response(JSON.stringify({ plans: [] }), { status: 200 });
      return new Response(JSON.stringify(abortedDetail), { status: 200 });
    }));
    render(<WorktreePlannerSheet repository={{ id: "repo-1", name: "companion" }} initialPlanId="plan-aborted" onClose={() => {}} onNotice={() => {}} />);
    const abortedSheet = await screen.findByRole("dialog", { name: "Plan a goal" });
    assert.ok(await within(abortedSheet).findByRole("region", { name: "Aborted goal" }));
    assert.ok(within(abortedSheet).getByText("This goal is closed. Its questions and answers are read-only."));
    assert.equal((within(abortedSheet).getByRole("textbox", { name: "Which browsers?" }) as HTMLTextAreaElement).readOnly, true);
    assert.equal((within(abortedSheet).getByRole("button", { name: "Answer Which browsers? with All" }) as HTMLButtonElement).disabled, true);
    assert.equal(within(abortedSheet).queryByRole("button", { name: "Answer" }), null);
    assert.equal(within(abortedSheet).queryByRole("link"), null);
  });
});

describe("GitHub Issues board column", () => {
  const now = new Date().toISOString();
  const repository = (id: string, name: string, root: string, favorite: boolean) => ({ id, name, root, path: `/repo/${name}`, favorite, pullRequestsAvailable: false, summary: { worktrees: 1, sessions: 0, needsYou: 0, working: 0, dirty: 0 }, worktrees: [] });
  const dashboard = { generatedAt: "2026-09-01", summary: { repositories: 2, worktrees: 0, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 }, orphanSessions: [], repositories: [repository("repositoryStarred01", "trust-layer", "karven", true), repository("repositoryPlain00001", "recorder", "rekord", false)] };
  const issue = (over: Record<string, unknown> = {}) => ({
    repositoryId: "repositoryStarred01", repositoryName: "trust-layer", number: 12, title: "Restore the caret",
    labels: ["editor", "bug"], url: "https://github.test/acme/trust-layer/issues/12", updatedAt: now, syncedAt: now, planId: null, ...over,
  });
  const startedPlan = { planId: "plan-issue-12", repositoryId: "repositoryStarred01", repositoryName: "trust-layer", goal: "Resolve GitHub issue #12: Restore the caret", status: "draft", stage: "questions", round: 0, taskCount: 0, createdAt: now, updatedAt: now, launchedAt: null, boardState: "discovering", sourceType: "github_issues", issueNumbers: [12] };

  // The board mounts with a stored column and an optional route override, in
  // the same shape as the goals-board helper above.
  function mountIssues({ issues = [] as unknown[], plans = [] as unknown[], extra }: { issues?: unknown[]; plans?: unknown[]; extra?: (url: string, init?: RequestInit) => Response | null | undefined } = {}) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const custom = extra?.(url, init);
      if (custom) return custom;
      if (url === "/api/github-issues") return new Response(JSON.stringify({ syncedAt: null, issues }), { status: 200 });
      if (url === "/api/goals/health") return new Response(JSON.stringify({ checkedAt: now, sessionsAvailable: true, summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0, deadTasks: 0, idleTasks: 0, failedTasks: 0 }, goals: [] }), { status: 200 });
      if (url.startsWith("/api/worktree-plans")) return new Response(JSON.stringify({ plans }), { status: 200 });
      return new Response(JSON.stringify(dashboard), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const notice = vi.fn();
    render(<WorktreeDashboardView onOpenWorkspace={vi.fn()} onLaunched={vi.fn(async () => {})} onNotice={notice} />);
    return { fetchMock, notice };
  }

  async function openBoard() {
    await openOtherViews();
    await userEvent.click(await screen.findByRole("tab", { name: /Goals board/ }));
    return screen.getByRole("region", { name: "Goals board" });
  }

  test("renders the GitHub Issues column ahead of Writing Spec with the issue's repository, number, title, labels and link", async () => {
    mountIssues({ issues: [issue()] });
    const board = await openBoard();
    const column = await within(board).findByRole("region", { name: "GitHub Issues" });
    const writingSpec = within(board).getByRole("region", { name: "Discovering" });
    // DOM order is the column order, so the issue column really is leftmost.
    assert.equal(Boolean(column.compareDocumentPosition(writingSpec) & Node.DOCUMENT_POSITION_FOLLOWING), true);

    assert.ok(within(column).getByText("trust-layer"));
    assert.ok(within(column).getByText("#12"));
    assert.ok(within(column).getByText("Restore the caret"));
    assert.ok(within(column).getByText("editor"));
    assert.ok(within(column).getByText("bug"));
    assert.ok(within(column).getByLabelText("1 issue in GitHub Issues"));
    const link = within(column).getByRole("link", { name: "Open #12 on GitHub" }) as HTMLAnchorElement;
    assert.equal(link.getAttribute("href"), "https://github.test/acme/trust-layer/issues/12");
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noreferrer");
  });

  test("the empty column explains that starring a repository and syncing populates it", async () => {
    mountIssues();
    const board = await openBoard();
    const column = within(board).getByRole("region", { name: "GitHub Issues" });
    assert.ok(within(column).getByText("No GitHub issues yet. Star a repository, then choose GitHub Sync to pull its open issues."));
    assert.equal(within(column).queryByRole("button", { name: /^Start a goal/ }), null);
  });

  test("GitHub Sync posts to the sync route, shows its busy label, and leaves Refresh GitHub alone", async () => {
    let release: ((value: Response) => void) | null = null;
    const { fetchMock } = mountIssues({
      extra: (url, init) => {
        if (url === "/api/github-issues/sync" && init?.method === "POST") return undefined;
        return null;
      },
    });
    // The sync route is held open, so the busy label is observable.
    const held = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/github-issues/sync" && init?.method === "POST") return new Promise<Response>((resolve) => { release = resolve; });
      return fetchMock(input, init);
    });
    vi.stubGlobal("fetch", held);
    await openBoard();

    await openOtherViews();
    await userEvent.click(screen.getByRole("button", { name: "GitHub Sync" }));
    assert.ok(await screen.findByRole("button", { name: "Syncing GitHub issues…" }));
    // Refresh GitHub keeps its own label and its own request.
    await openOtherViews();
    assert.ok(screen.getByRole("button", { name: "Refresh GitHub" }));
    const syncCall = held.mock.calls.find(([url]) => String(url) === "/api/github-issues/sync");
    assert.equal(syncCall?.[1]?.method, "POST");

    await act(async () => {
      release?.(new Response(JSON.stringify({ syncedAt: now, status: "ok", message: null, repositories: [{ repositoryId: "repositoryStarred01", name: "trust-layer", status: "ok", issueCount: 1, truncated: false, error: null }], issues: [issue()] }), { status: 200 }));
      await Promise.resolve();
    });
    assert.ok(await screen.findByText("Restore the caret"));
    await openOtherViews();
    assert.ok(screen.getByRole("button", { name: "GitHub Sync" }));
  });

  test("a sync with no starred repository states the reason instead of doing nothing visible", async () => {
    const { notice } = mountIssues({
      extra: (url, init) => (url === "/api/github-issues/sync" && init?.method === "POST"
        ? new Response(JSON.stringify({ syncedAt: now, status: "no_starred_repositories", message: "No starred repositories. Star a repository first; GitHub Sync reads starred repositories only.", repositories: [], issues: [] }), { status: 200 })
        : null),
    });
    await openBoard();
    await openOtherViews();
    await userEvent.click(screen.getByRole("button", { name: "GitHub Sync" }));
    assert.ok(await screen.findByText("No starred repositories. Star a repository first; GitHub Sync reads starred repositories only."));
    assert.equal(notice.mock.calls.at(-1)?.[0], "No starred repositories. Star a repository first; GitHub Sync reads starred repositories only.");
  });

  test("a per-repository sync failure is surfaced rather than swallowed", async () => {
    const { notice } = mountIssues({
      extra: (url, init) => (url === "/api/github-issues/sync" && init?.method === "POST"
        ? new Response(JSON.stringify({ syncedAt: now, status: "ok", message: null, repositories: [{ repositoryId: "repositoryStarred01", name: "trust-layer", status: "failed", issueCount: 0, truncated: false, error: "gh: not authenticated" }], issues: [] }), { status: 200 })
        : null),
    });
    await openBoard();
    await openOtherViews();
    await userEvent.click(screen.getByRole("button", { name: "GitHub Sync" }));
    assert.ok(await screen.findByText(/could not read 1 starred repository: trust-layer \(gh: not authenticated\)/));
    assert.equal(notice.mock.calls.length > 0, true);
  });

  test("Start a goal posts once to the per-issue route, disables while in flight, and lands the goal in Writing Spec", async () => {
    const openConversation = vi.fn(async () => {});
    let release: ((value: Response) => void) | null = null;
    let plans: unknown[] = [];
    const goalCalls: RequestInit[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/goal") && init?.method === "POST") {
        goalCalls.push(init);
        return new Promise<Response>((resolve) => { release = resolve; });
      }
      if (url === "/api/github-issues") return new Response(JSON.stringify({ syncedAt: null, issues: [issue()] }), { status: 200 });
      if (url === "/api/goals/health") return new Response(JSON.stringify({ checkedAt: now, sessionsAvailable: true, summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0, deadTasks: 0, idleTasks: 0, failedTasks: 0 }, goals: [] }), { status: 200 });
      if (url.startsWith("/api/worktree-plans")) return new Response(JSON.stringify({ plans }), { status: 200 });
      return new Response(JSON.stringify(dashboard), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreeDashboardView onOpenWorkspace={vi.fn()} onGoalSessionStarted={openConversation} onLaunched={vi.fn(async () => {})} onNotice={vi.fn()} />);
    const board = await openBoard();
    await within(board).findByText("Restore the caret");

    const start = screen.getByRole("button", { name: "Start a goal for #12 Restore the caret" });
    await userEvent.click(start);
    // The button is disabled while its own request is open, so a second click
    // cannot create a second plan.
    const busy = await screen.findByRole("button", { name: "Start a goal for #12 Restore the caret" });
    assert.equal((busy as HTMLButtonElement).disabled, true);
    await userEvent.click(busy);
    assert.equal(goalCalls.length, 1);

    const goalCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/goal") && String(url).startsWith("/api/github-issues/"));
    assert.equal(String(goalCall?.[0]), "/api/github-issues/repositoryStarred01/12/goal");

    plans = [startedPlan];
    await act(async () => {
      release?.(new Response(JSON.stringify({ issue: issue({ planId: "plan-issue-12" }), plan: { planId: "plan-issue-12", workflow: "goal_session", goalSessionWorkspaceId: "issue-workspace" }, created: true }), { status: 200 }));
      await Promise.resolve();
    });

    // The new goal lands in Writing Spec, and the issue leaves the issue column
    // in the same render: the work is on the board once, not twice.
    await waitFor(() => assert.ok(within(within(screen.getByRole("region", { name: "Goals board" })).getByRole("region", { name: "Discovering" })).getByText("Resolve GitHub issue #12: Restore the caret")));
    await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Start a goal for #12 Restore the caret" }), null));
    const issueColumn = within(screen.getByRole("region", { name: "Goals board" })).getByRole("region", { name: "GitHub Issues" });
    assert.equal(within(issueColumn).queryByText("Restore the caret"), null);
    assert.equal(within(issueColumn).queryAllByRole("article").length, 0);
    assert.ok(within(issueColumn).getByLabelText("0 issues in GitHub Issues"));
    assert.equal(goalCalls.length, 1);
    assert.deepEqual(openConversation.mock.calls, []);
  });

  test("an issue whose goal is on the board renders no card and is not counted", async () => {
    mountIssues({ issues: [issue({ planId: "plan-issue-12" })], plans: [startedPlan] });
    const board = await openBoard();
    const column = await within(board).findByRole("region", { name: "GitHub Issues" });
    // The issue is gone from its own column…
    assert.equal(within(column).queryAllByRole("article").length, 0);
    assert.equal(within(column).queryByText("Restore the caret"), null);
    assert.equal(within(column).queryByRole("button", { name: /^Start a goal/ }), null);
    // …the header agrees with what is rendered…
    assert.ok(within(column).getByLabelText("0 issues in GitHub Issues"));
    // …and the work is still on the board, as its goal card.
    assert.ok(within(within(board).getByRole("region", { name: "Discovering" })).getByText("Resolve GitHub issue #12: Restore the caret"));
  });

  test("an issue whose goal was deleted comes back with a working Start a goal button", async () => {
    // The stored issue still carries the plan id, but the board loaded no such
    // plan. A stale id must never strand an issue off the board.
    mountIssues({ issues: [issue({ planId: "plan-gone" })], plans: [] });
    const board = await openBoard();
    const column = await within(board).findByRole("region", { name: "GitHub Issues" });
    assert.equal(within(column).getAllByRole("article").length, 1);
    assert.ok(within(column).getByText("Restore the caret"));
    assert.ok(within(column).getByLabelText("1 issue in GitHub Issues"));
    const start = within(column).getByRole("button", { name: "Start a goal for #12 Restore the caret" }) as HTMLButtonElement;
    assert.equal(start.disabled, false);
  });

  test("a column emptied only by started goals says so instead of the star-a-repository hint", async () => {
    mountIssues({ issues: [issue({ planId: "plan-issue-12" })], plans: [startedPlan] });
    const board = await openBoard();
    const column = await within(board).findByRole("region", { name: "GitHub Issues" });
    assert.ok(within(column).getByText("Every synced GitHub issue already has a goal. Each one is on the board in its lifecycle column."));
    assert.equal(within(column).queryByText("No GitHub issues yet. Star a repository, then choose GitHub Sync to pull its open issues."), null);
  });

  test("the goal filter runs before the search, so the column never blames the search for a hidden goal", async () => {
    // Two issues, one already a goal. A search that matches only the started
    // one leaves an empty column that reports the search, and a count of 0.
    const startedIssue = issue({ planId: "plan-issue-12" });
    const openIssue = issue({ number: 31, title: "Speed up the indexer", labels: [], url: "https://github.test/acme/trust-layer/issues/31" });
    mountIssues({ issues: [startedIssue, openIssue], plans: [startedPlan] });
    const board = await openBoard();
    const column = () => within(screen.getByRole("region", { name: "Goals board" })).getByRole("region", { name: "GitHub Issues" });
    await within(column()).findByText("Speed up the indexer");
    assert.ok(within(column()).getByLabelText("1 issue in GitHub Issues"));
    assert.equal(within(board).queryByText("Restore the caret"), null);

    await userEvent.type(screen.getByRole("searchbox", { name: "Search projects" }), "caret");
    await waitFor(() => assert.ok(within(column()).getByText(/No issue matches/)));
    assert.ok(within(column()).getByLabelText("0 issues in GitHub Issues"));
  });

  test("a board left open re-reads the column on its slow clock, and stops when the board is not the active view", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // The server syncs on its own schedule, so the second read answers with a
    // card that the first read did not carry.
    let served: unknown[] = [issue()];
    const { fetchMock } = mountIssues({
      extra: (url) => (url === "/api/github-issues" ? new Response(JSON.stringify({ syncedAt: now, issues: served }), { status: 200 }) : null),
    });
    await openOtherViews();
    await user.click(await screen.findByRole("tab", { name: /Goals board/ }));
    const column = () => within(screen.getByRole("region", { name: "Goals board" })).getByRole("region", { name: "GitHub Issues" });
    await within(column()).findByText("Restore the caret");
    const issueReads = () => fetchMock.mock.calls.filter(([url]) => String(url) === "/api/github-issues").length;
    assert.equal(issueReads(), 1);

    served = [issue(), issue({ number: 31, title: "Speed up the indexer", labels: ["performance"], url: "https://github.test/acme/trust-layer/issues/31" })];
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    assert.equal(issueReads(), 2);
    assert.ok(await within(column()).findByText("Speed up the indexer"));

    // The board is no longer the active view, so its clock stops with it.
    await openOtherViews();
    await user.click(screen.getByRole("tab", { name: /Draft Goals/ }));
    const readsWhenClosed = issueReads();
    served = [issue(), issue({ number: 44, title: "Fix the sync", labels: [], url: "https://github.test/acme/trust-layer/issues/44" })];
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
    assert.equal(issueReads(), readsWhenClosed);
    assert.equal(screen.queryByText("Fix the sync"), null);
  });

  test("a non-favorited repository contributes no card, because the sync reads starred repositories only", async () => {
    // The server answers with the starred repository's issue only. The column
    // renders exactly what it was given and invents nothing for `recorder`.
    mountIssues({ issues: [issue()] });
    const board = await openBoard();
    const column = await within(board).findByRole("region", { name: "GitHub Issues" });
    assert.equal(within(column).queryByText("recorder"), null);
    assert.equal(within(column).getAllByRole("article").length, 1);
  });
});

describe("last update stamp", () => {
  const jsonRoutes = (routes: Record<string, unknown>) => vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    const match = Object.keys(routes).find((key) => path.endsWith(key));
    if (!match) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[match]), { status: 200, headers: { "content-type": "application/json" } });
  });

  test("prefers the last successful update time", async () => {
    const iso = new Date(Date.now() - 4 * 3_600_000).toISOString();
    vi.stubGlobal("fetch", jsonRoutes({ "/api/updater/status": { available: true, lastSuccessAt: iso }, "/api/health": { version: { builtAt: new Date().toISOString() } } }));
    render(<LastUpdateStamp />);
    const stamp = await screen.findByText("Updated 4h ago");
    assert.equal(stamp.tagName, "TIME");
    assert.equal(stamp.getAttribute("datetime"), iso);
    assert.equal(stamp.getAttribute("title"), iso);
  });

  test("falls back to the build time when the updater reports nothing", async () => {
    const iso = new Date(Date.now() - 3 * 86_400_000).toISOString();
    vi.stubGlobal("fetch", jsonRoutes({ "/api/updater/status": { available: false }, "/api/health": { version: { builtAt: iso } } }));
    render(<LastUpdateStamp />);
    assert.ok(await screen.findByText("Updated 3d ago"));
  });

  test("renders nothing when neither timestamp exists", async () => {
    vi.stubGlobal("fetch", jsonRoutes({ "/api/updater/status": { available: false }, "/api/health": { version: { builtAt: null } } }));
    const { container } = render(<LastUpdateStamp />);
    await waitFor(() => assert.equal(container.querySelector("time"), null));
    assert.equal(screen.queryByText(/Updated/), null);
  });
});

describe("deployment health", () => {
  const sha = (character: string) => character.repeat(40);
  const service = (overrides: Record<string, unknown> = {}) => ({
    deployedSha: sha("a"), observedRemoteSha: sha("a"), quarantinedSha: null,
    alive: true, healthy: true, status: "current", ...overrides,
  });
  const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  test("shows both current deployments and refreshes them on demand", async () => {
    const fetchMock = vi.fn(async () => response({
      available: true, summary: "healthy", phase: "idle", lastCheckAt: "2026-09-01T12:10:07.113Z", lastSuccessAt: "2026-09-01T12:08:30.471Z",
      services: { companion: service({ runningSha: sha("a") }), updater: service({ deployedSha: sha("b"), observedRemoteSha: sha("b") }) },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DeploymentHealth />);
    assert.ok(await screen.findByText("Both services healthy"));
    assert.ok(screen.getByText("cmux companion"));
    assert.ok(screen.getByText("cmux companion updater"));
    assert.equal(screen.getAllByText("Current").length, 2);
    assert.equal(screen.getByRole("region", { name: "Deployment health" }).getAttribute("aria-busy"), "false");
    assert.equal(screen.getByRole("status").textContent, "Both services healthy");
    await userEvent.click(screen.getByRole("button", { name: "Refresh deployment health" }));
    await waitFor(() => assert.equal(fetchMock.mock.calls.length, 2));
  });

  test("makes an in-progress Companion rollout explicit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      available: true, summary: "updating", phase: "fetching", lastCheckAt: new Date().toISOString(),
      services: { companion: service({ healthy: false, status: "updating", pendingSha: sha("c") }), updater: service() },
    })));
    render(<DeploymentHealth />);
    assert.ok(await screen.findByText("Update in progress"));
    assert.ok(screen.getByText("Updating"));
    assert.ok(screen.getByText("fetching"));
  });

  test("shows updater failures with the bounded recovery detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      available: true, summary: "attention", phase: "failed", lastCheckAt: new Date().toISOString(), lastError: "Unsafe non-fast-forward history for updater",
      services: { companion: service(), updater: service({ healthy: false, status: "problem", quarantinedSha: sha("c") }) },
    })));
    render(<DeploymentHealth />);
    assert.ok(await screen.findByText("Attention needed"));
    assert.ok(screen.getByText("Problem"));
    assert.ok(screen.getByText("Unsafe non-fast-forward history for updater"));
  });

  test("shows intentionally paused automatic updates without claiming health", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      available: true, enabled: false, summary: "paused", phase: "idle", lastCheckAt: new Date().toISOString(),
      services: { companion: service(), updater: service({ enabled: false, healthy: false, status: "paused" }) },
    })));
    render(<DeploymentHealth />);
    assert.ok(await screen.findByText("Automatic updates paused"));
    assert.ok(screen.getByText("Paused"));
  });
});

describe("fresh branch recovery", () => {
  for (const surface of ["rail", "sheet"] as const) {
    for (const outcome of ["success", "generic", "failure"] as const) {
      test(`${surface} retries structured acquisition failures immediately (${outcome})`, async () => {
        const planId = "goal / retry"; const taskId = "T1 / blocked";
        const detailUrl = `/api/worktree-plans/${encodeURIComponent(planId)}`;
        const tasks = [
          { id: taskId, title: "Blocked task", branch: "feature/blocked", agent: "codex", prompt: "Build", agentReason: "", wave: 1, launchStatus: "failed", launchReason: "running-session", launchError: "That branch already has a worktree with a running session", deliveryStatus: "pending", health: "failed", reason: "Branch is occupied", session: null, workspaceId: null },
          { id: "T2", title: "Sync failure", branch: "feature/sync", agent: "codex", prompt: "Build", agentReason: "", wave: 1, launchStatus: "failed", launchReason: "add-failure", launchError: "That branch already has a worktree with a running session", deliveryStatus: "pending", health: "failed", reason: "Sync unavailable", session: null, workspaceId: null },
          { id: "T3", title: "Dead task", branch: "feature/dead", agent: "codex", prompt: "Build", agentReason: "", wave: 1, launchStatus: "launched", launchReason: null, deliveryStatus: "pending", health: "dead", reason: "Agent stopped", session: null, workspaceId: null },
        ];
        const now = new Date().toISOString();
        const plan = { planId, repositoryId: "repo-retry", repositoryName: "companion", goal: "Recover blocked work", status: "launched", planStatus: "launched", stage: "ready", deliveryMode: "combined", deliveryStatus: "blocked", boardState: "stopped", round: 1, taskCount: 3, launchedCount: 1, createdAt: now, updatedAt: now, launchedAt: now, tasks, questions: [] };
        const repository = { id: "repo-retry", name: "companion", root: "karven", path: "/repo", summary: {}, worktrees: [], releases: [] };
        let release: (value: Response) => void = () => {};
        let refreshed = false;
        const currentTasks = () => tasks.map((task, index) => refreshed && index === 0 ? { ...task, branch: "feature/retry-2", launchStatus: "launched", launchReason: null, health: "idle" } : task);
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url === `${detailUrl}/tasks/${encodeURIComponent(taskId)}/relaunch`) return new Promise<Response>((resolve) => { release = resolve; });
          if (url === detailUrl) return Response.json({ ...plan, tasks: currentTasks().map((task) => ({ ...task, launchReason: undefined })) });
          if (url === `${detailUrl}/health`) return Response.json({ tasks: currentTasks() });
          if (url.startsWith("/api/worktree-plans?")) return Response.json({ plans: [plan] });
          if (url === "/api/goals/health") return Response.json({ sessionsAvailable: true, goals: [{ ...plan, tasks: currentTasks(), health: "failed", stuckCount: 3 }], summary: { goals: 1, tasks: 3, stuck: 1, needsYou: 0, working: 0 } });
          if (url.startsWith("/api/worktree-dashboard")) return Response.json({ generatedAt: now, summary: {}, repositories: [repository], orphanSessions: [] });
          void init;
          return Response.json({ providers: [], closed: [], kept: [], failed: [], items: [] });
        });
        vi.stubGlobal("fetch", fetchMock);
        const confirm = vi.fn(); vi.stubGlobal("confirm", confirm);
        const notice = vi.fn();
        render(surface === "rail"
          ? <WorktreeDashboardView onOpenWorkspace={vi.fn()} onLaunched={async () => {}} onNotice={notice} />
          : <WorktreePlannerSheet repository={repository} initialPlanId={planId} onClose={vi.fn()} onNotice={notice} />);
        const retry = await screen.findByRole("button", { name: "Retry on new branch for Blocked task" });
        assert.equal(screen.queryByRole("button", { name: "Retry on new branch for Sync failure" }), null);
        assert.equal(screen.queryByRole("button", { name: "Retry on new branch for Dead task" }), null);
        assert.ok(screen.getByRole("button", { name: "Continue Dead task" }));
        assert.ok(screen.getByText(/blocked branch.*untouched/));
        await userEvent.click(retry);
        assert.equal((retry as HTMLButtonElement).disabled, true);
        assert.equal(retry.textContent, "Retrying on new branch…");
        if (surface === "rail") for (const name of ["Continue Blocked task", "Restart Blocked task", "Skip Blocked task"]) assert.equal((screen.getByRole("button", { name }) as HTMLButtonElement).disabled, true);
        assert.equal(screen.queryByRole("button", { name: /Confirm restart/ }), null);
        assert.equal(confirm.mock.calls.length, 0);
        const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/relaunch"));
        assert.equal(call?.[0], `${detailUrl}/tasks/${encodeURIComponent(taskId)}/relaunch`);
        assert.equal(call?.[1]?.method, "POST");
        assert.deepEqual(JSON.parse(String(call?.[1]?.body)), { mode: "rebranch", closeLive: false });
        if (outcome === "failure") {
          await act(async () => release(Response.json({ error: "Retry unavailable" }, { status: 409 })));
          await waitFor(() => assert.equal((retry as HTMLButtonElement).disabled, false));
          if (surface === "rail") assert.equal(notice.mock.calls.at(-1)?.[0], "Retry unavailable");
          else assert.ok(screen.getByText("Retry unavailable"));
        } else {
          refreshed = true;
          await act(async () => release(Response.json(outcome === "generic" ? {} : { branch: "feature/retry-2" })));
          assert.ok((await screen.findAllByText("feature/retry-2")).length);
          await waitFor(() => assert.match(notice.mock.calls.at(-1)?.[0], outcome === "generic" ? /on a fresh branch/ : /feature\/retry-2/));
          assert.ok(fetchMock.mock.calls.some(([url]) => url === detailUrl));
          assert.ok(fetchMock.mock.calls.filter(([url]) => url === (surface === "rail" ? "/api/goals/health" : `${detailUrl}/health`)).length >= 2);
        }
      });
    }
  }
});


describe("managed goal controls in a visible workspace", () => {
  test("keeps the revision-bound approval card beside its exact conversation", async () => {
    const proposal = {
      planId: "goal-1", repositoryId: "repo-1", goal: "Ship billing", round: 0, status: "questions", questions: [], tasks: [],
      workflow: "goal_session", goalSessionWorkspaceId: "workspace-goal", goalSessionGeneration: 1, goalSessionState: "awaiting_approval", proposalRevision: 3,
      proposal: { intendedBehavior: "Customers can pay", scope: ["Billing form"], verification: ["npm test"] },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/goal-sessions/workspace/workspace-goal") return new Response(JSON.stringify({ plan: proposal }), { status: 200 });
      if (url === "/api/goal-sessions/goal-1/approve" && init?.method === "POST") return new Response(JSON.stringify({ ...proposal, goalSessionState: "implementing", proposal: null }), { status: 200 });
      return new Response(JSON.stringify({ error: "Unexpected request" }), { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagedGoalControls workspaceId="workspace-goal" />);
    assert.ok(await screen.findByRole("region", { name: "Proposal awaiting approval" }));
    await userEvent.click(screen.getByRole("button", { name: "Approve and implement" }));
    await waitFor(() => assert.ok(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/approve") && init?.method === "POST")));
    const approval = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/approve"));
    assert.deepEqual(JSON.parse(String(approval?.[1]?.body)), { generation: 1, revision: 3 });
    assert.ok(await screen.findByText("Implementation is continuing in this conversation."));
  });
});

async function openOtherViews() {
  const summary = await screen.findByText("Board tools");
  if (!summary.closest("details")?.open) await userEvent.click(summary);
}

describe("unified GitHub issue picker", () => {
  test("reads issues without a planning request and delegates the selected issue to the board entry", async () => {
    const issue = { repositoryId: "repository12345678", repositoryName: "App", number: 8, title: "Billing", labels: [], url: "", updatedAt: "", syncedAt: "", planId: null };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => { assert.match(String(input), /github-issues/); return new Response(JSON.stringify({ issues: [issue] })); });
    vi.stubGlobal("fetch", fetchMock);
    const start = vi.fn(async () => {}), close = vi.fn();
    render(<GitHubIssuePicker repository={{ id: issue.repositoryId, name: "App" }} onStart={start} onClose={close} />);
    const button = await screen.findByRole("button", { name: "Continue discovery for #8" });
    assert.equal(start.mock.calls.length, 0);
    assert.equal(String(fetchMock.mock.calls[0]?.[0]), "/api/github-issues/repository/repository12345678");
    await userEvent.click(button);
    assert.deepEqual(start.mock.calls[0], [issue]); assert.equal(close.mock.calls.length, 1);
  });
  test("keeps the issue picker open when the shared board action reports failure", async () => {
    const issue = { repositoryId: "repository12345678", number: 8, title: "Billing" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ issues: [issue] }))));
    const close = vi.fn();
    render(<GitHubIssuePicker repository={{ id: issue.repositoryId, name: "App" }} onStart={async () => false} onClose={close} />);
    await userEvent.click(await screen.findByRole("button", { name: "Continue discovery for #8" }));
    assert.equal(close.mock.calls.length, 0);
    assert.ok(screen.getByRole("button", { name: "Continue discovery for #8" }));
  });
  test("reports issue-fetch failures without launching discovery", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "GitHub unavailable" }), { status: 503 })));
    const start = vi.fn(async () => {});
    render(<GitHubIssuePicker repository={{ id: "repository12345678", name: "App" }} onStart={start} onClose={() => {}} />);
    await screen.findByRole("alert"); assert.equal(start.mock.calls.length, 0);
  });
});

describe("burst", () => {
  test("the goal form sends burst when the toggle is on", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/settings/models")) return new Response(JSON.stringify({ roles: DEFAULT_MODEL_ROLES, defaults: DEFAULT_MODEL_ROLES, warning: null }), { status: 200 });
      if (url.endsWith("/api/goal-sessions") && init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ planId: "p1", repositoryId: "r1", goal: "x", round: 0, status: "questions", questions: [], tasks: [], workflow: "goal_session" }), { status: 201 }); }
      return new Response("{}", { status: 200 });
    }));
    render(<WorktreePlannerSheet repository={{ id: "r1", name: "Repo" }} onClose={() => {}} onNotice={() => {}} />);
    await userEvent.type(await screen.findByLabelText("Goal"), "Ship burst");
    await userEvent.click(screen.getByLabelText("Burst"));
    await userEvent.click(screen.getByRole("button", { name: "Start goal session" }));
    await waitFor(() => assert.equal(posts.length, 1));
    assert.equal((posts[0] as { burst: boolean }).burst, true);
  });

  // Three questions map to the contract: the outcome, what must not change, and
  // how the user will know it worked. The two optional answers travel as
  // `intake`; a form with only a goal sends none.
  test("the goal form sends the intake answers only when the user typed them", async () => {
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/settings/models")) return new Response(JSON.stringify({ roles: DEFAULT_MODEL_ROLES, defaults: DEFAULT_MODEL_ROLES, warning: null }), { status: 200 });
      if (url.endsWith("/api/goal-sessions") && init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ planId: `p${posts.length}`, repositoryId: "r1", goal: "x", workflow: "goal_session", round: 0, status: "questions", tasks: [] }), { status: 200 }); }
      return new Response("{}", { status: 200 });
    }));
    const first = render(<WorktreePlannerSheet repository={{ id: "r1", name: "Repo" }} onClose={() => {}} onNotice={() => {}} />);
    await userEvent.type(await screen.findByLabelText("Goal"), "Add card payments");
    await userEvent.type(screen.getByLabelText("What must not change"), "Invoice PDF layout{enter}Database schema");
    await userEvent.type(screen.getByLabelText("How you will know it worked"), "A sandbox payment succeeds");
    await userEvent.click(screen.getByRole("button", { name: "Start goal session" }));
    await waitFor(() => assert.equal(posts.length, 1));
    assert.deepEqual(posts[0].intake, { exclusions: "Invoice PDF layout\nDatabase schema", verification: "A sandbox payment succeeds" });
    first.unmount();

    render(<WorktreePlannerSheet repository={{ id: "r1", name: "Repo" }} onClose={() => {}} onNotice={() => {}} />);
    await userEvent.type(await screen.findByLabelText("Goal"), "Only a goal");
    await userEvent.click(screen.getByRole("button", { name: "Start goal session" }));
    await waitFor(() => assert.equal(posts.length, 2));
    assert.equal("intake" in posts[1], false);
  });

  test("Board tools offers Burst and opens the sheet", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/bursts")) return new Response(JSON.stringify({ bursts: [] }), { status: 200 });
      if (url.includes("/api/worktree-dashboard")) return new Response(JSON.stringify({ generatedAt: "2026-09-08T00:00:00Z", github: { status: "ready" }, summary: { repositories: 0 }, repositories: [], orphanSessions: [] }), { status: 200 });
      if (url.includes("/api/worktree-plans")) return new Response(JSON.stringify({ plans: [] }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    render(<WorktreeDashboardView readOnly={false} onOpenWorkspace={() => {}} onLaunched={async () => {}} onNotice={() => {}} />);
    await userEvent.click(await screen.findByText("Board tools"));
    await userEvent.click(screen.getByRole("button", { name: "Burst" }));
    assert.ok(await screen.findByRole("dialog", { name: "Burst plan" }));
  });
});
