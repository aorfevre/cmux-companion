import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, test, vi } from "vitest";
import { AccountUsageView } from "../app/account-usage";
import { AppsView } from "../app/apps-view";
import { MarkdownViewer } from "../app/markdown-viewer";
import { BottomNav, HomeModeSwitch, InboxView, LastUpdateStamp, PullRequestBanner, TerminalPanel } from "../app/page";
import { TerminalGrid } from "../app/terminal-grid.tsx";
import { WorktreeDashboardView } from "../app/worktree-dashboard";
import { WorktreePlannerSheet } from "../app/worktree-planner";
import { GitHubIssuePlannerSheet } from "../app/github-issue-planner";
import { DeploymentHealth } from "../app/deployment-health";

afterEach(() => vi.unstubAllGlobals());

describe("GitHub issue topic planner", () => {
  test("shows live GitHub analysis milestones while the request is running", async () => {
    const streams: { url: string; closed: boolean; emit: (data: unknown) => void }[] = [];
    class FakeEventSource {
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      index: number;
      constructor(public url: string) {
        this.index = streams.length;
        streams.push({ url, closed: false, emit: (data) => this.onmessage?.({ data: JSON.stringify(data) }) });
      }
      close() { streams[this.index].closed = true; }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    let release: (value: Response) => void = () => {};
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input; void init;
      return new Promise<Response>((resolve) => { release = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<GitHubIssuePlannerSheet repository={{ id: "repository12345678", name: "app" }} onClose={() => {}} onLaunched={async () => {}} onNotice={() => {}} />);
    const sheet = await screen.findByRole("dialog", { name: "Plan GitHub issues" });
    await waitFor(() => assert.equal(streams.length, 1));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    assert.match(body.traceId, /^[0-9a-f-]{36}$/);
    assert.ok(streams[0].url.endsWith(`/api/worktree-plans/progress/${body.traceId}`));

    streams[0].emit({ k: "phase", t: "Fetching repository details and open issues…" });
    streams[0].emit({ k: "phase", t: "Found 3 open issues" });
    streams[0].emit({ k: "phase", t: "Grouping 3 issues by outcome and implementation overlap…" });
    assert.ok(await within(sheet).findByText("Grouping 3 issues by outcome and implementation overlap…"));
    assert.ok(within(sheet).getByText("Found 3 open issues"));
    assert.ok(within(sheet).getByRole("status"));

    release(new Response(JSON.stringify({ analysisId: null, repository: { nameWithOwner: "acme/app", url: null, issuesUrl: null }, issues: [], topics: [], analyzedAt: new Date().toISOString() }), { status: 200 }));
    assert.ok(await within(sheet).findByText("No open issues"));
    assert.equal(streams[0].closed, true);
  });

  test("groups tickets, captures clarification, creates goal plans, and launches every ready topic", async () => {
    const analysis = {
      analysisId: "analysis-1", repository: { nameWithOwner: "acme/app", url: "https://github.com/acme/app", issuesUrl: "https://github.com/acme/app/issues" }, analyzedAt: new Date().toISOString(),
      issues: [
        { number: 54, title: "Restore focus", labels: ["editor"], url: "https://github.com/acme/app/issues/54", updatedAt: "2026-09-01" },
        { number: 55, title: "Caret visibility", labels: ["editor"], url: "https://github.com/acme/app/issues/55", updatedAt: "2026-09-01" },
        { number: 57, title: "Diagnostics", labels: ["backend"], url: "https://github.com/acme/app/issues/57", updatedAt: "2026-09-01" },
      ],
      topics: [
        { id: "topic-1", title: "Editor reliability", goal: "Make editing reliable", rationale: "Shared editor files", issueNumbers: [54, 55], questions: [{ id: "question-1", text: "Which browsers?", options: ["All", "Safari"] }], acceptanceCriteria: [], overlapRisk: "Both touch the editor", dependencies: [] },
        { id: "topic-2", title: "Correction observability", goal: "Add diagnostics", rationale: "Independent backend work", issueNumbers: [57], questions: [], acceptanceCriteria: [], overlapRisk: "low", dependencies: [] },
      ],
    };
    const plan = (id: string, title: string, branch: string) => ({ planId: id, repositoryId: "repository12345678", goal: title, round: 1, status: "ready", deliveryMode: "combined", questions: [], tasks: [{ id: "t1", title, branch, prompt: "Do it", agent: "codex", agentReason: "Codex has headroom" }] });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/analyze")) return new Response(JSON.stringify(analysis), { status: 200 });
      if (url.endsWith("/prepare")) return new Response(JSON.stringify({ analysisId: "analysis-1", results: [
        { topicId: "topic-1", title: "Editor reliability", issueNumbers: [54, 55], status: "planned", plan: plan("plan-1", "Editor task", "feature/editor") },
        { topicId: "topic-2", title: "Correction observability", issueNumbers: [57], status: "planned", plan: plan("plan-2", "Diagnostics task", "feature/diagnostics") },
      ] }), { status: 200 });
      if (url.endsWith("/launch")) return new Response(JSON.stringify({ requested: 2, launchedTopics: 2, launchedWorktrees: 2, results: [{ planId: "plan-1", status: "launched" }, { planId: "plan-2", status: "launched" }] }), { status: 200 });
      throw new Error(`Unexpected ${url} ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const launched = vi.fn(async () => {});
    render(<GitHubIssuePlannerSheet repository={{ id: "repository12345678", name: "app" }} onClose={() => {}} onLaunched={launched} onNotice={() => {}} />);
    const sheet = await screen.findByRole("dialog", { name: "Plan GitHub issues" });
    assert.ok(await within(sheet).findByText("Editor reliability"));
    await userEvent.click(within(sheet).getByRole("button", { name: "All" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Create 2 goal plans" }));
    assert.ok(await within(sheet).findByText("Editor task"));
    assert.ok(within(sheet).getByText("Diagnostics task"));
    await userEvent.click(within(sheet).getByRole("button", { name: "Launch 2 topics" }));
    assert.ok(await within(sheet).findByText("2 topics in flight"));
    assert.equal(launched.mock.calls.length, 1);
    const prepareCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/prepare"));
    assert.match(String(prepareCall?.[1]?.body), /"question-1":"All"/);
  });
});

describe("contextual mobile features", () => {
  test("keeps permanent navigation focused on frequent mobile destinations", async () => {
    const navigate = vi.fn();
    render(<BottomNav view="usage" onView={navigate} />);
    assert.ok(screen.getByRole("button", { name: "Licence Usage" }).classList.contains("active"));
    assert.ok(screen.getByRole("button", { name: "Apps" }));
    assert.equal(screen.queryByRole("button", { name: "Inbox" }), null);
    assert.equal(screen.queryByRole("button", { name: "Launch" }), null);
    await userEvent.click(screen.getByRole("button", { name: "Apps" }));
    assert.deepEqual(navigate.mock.calls[0], ["apps"]);
  });

  test("shows CCS quota by account while treating absent windows as unreported", async () => {
    const weeklyReset = new Date(Date.now() + 3 * 24 * 60 * 60_000);
    const usage = { generatedAt: new Date().toISOString(), source: "CCS", available: true, summary: { ready: 1, low: 0, exhausted: 0, reconnect: 1, unavailable: 0 }, providers: [
      { id: "claude", label: "Claude Code", available: true, accounts: [{ id: "one", label: "one", email: "one@example.test", plan: null, isDefault: true, paused: false, status: "ready", message: null, updatedAt: new Date().toISOString(), windows: [
        { id: "usage-5h-0", cadence: "5h", label: "Session limit", category: "usage", remainingPercent: 82, resetAt: new Date(Date.now() + 3_600_000).toISOString(), reported: true },
        { id: "usage-weekly-1", cadence: "weekly", label: "Weekly limit", category: "usage", remainingPercent: 55, resetAt: weeklyReset.toISOString(), reported: true },
      ] }] },
      { id: "codex", label: "OpenAI Codex", available: true, accounts: [{ id: "two", label: "two", email: "two@example.test", plan: "pro", isDefault: false, paused: false, status: "reconnect", message: "Reconnect this account in CCS", updatedAt: null, windows: [] }] },
    ] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => { void input; return new Response(JSON.stringify(usage), { status: 200, headers: { "content-type": "application/json" } }); });
    vi.stubGlobal("fetch", fetchMock);
    const back = vi.fn();
    render(<AccountUsageView onBack={back} />);
    assert.ok(await screen.findByText("one@example.test"));
    assert.ok(screen.getByText("82%"));
    assert.ok(screen.getByText("55%"));
    assert.ok(screen.getByText(`Resets ${new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(weeklyReset)}`));
    assert.equal(screen.getAllByText("Not reported").length, 4);
    assert.equal(screen.queryByText("Daily"), null);
    assert.equal(screen.getAllByText("Weekly").length, 2);
    assert.ok(screen.getByText("Reconnect this account in CCS"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh account usage" }));
    await waitFor(() => assert.equal(fetchMock.mock.calls.some(([url]) => String(url).endsWith("?refresh=1")), true));
    await userEvent.click(screen.getByRole("button", { name: "‹ Settings" }));
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

  test("keeps classic sessions available while the worktree visualization is opt-in", async () => {
    const mode = vi.fn();
    render(<HomeModeSwitch mode="sessions" onMode={mode} />);
    assert.equal(screen.getByRole("button", { name: "Sessions" }).getAttribute("aria-pressed"), "true");
    await userEvent.click(screen.getByRole("button", { name: /Worktrees Beta/ }));
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
    assert.ok(await screen.findByText("feature/mobile"));
    assert.ok(screen.getByText(/GitHub refresh is manual/));
    assert.equal(fetchMock.mock.calls.some(([url]) => String(url).includes("github=1")), false);
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
    await userEvent.click(screen.getByRole("tab", { name: /Archived/ }));
    assert.ok(screen.getByRole("button", { name: "Unarchive companion" }));
    await userEvent.click(screen.getByRole("button", { name: "Unarchive companion" }));
    assert.ok(screen.getByText("No archived Karven projects"));
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
      if (url === "/api/worktree-plans?status=all&limit=200") return new Response(JSON.stringify({ plans: [draft, launched, rekordDraft] }), { status: 200 });
      if (url === "/api/worktree-plans?repositoryId=repo-karven") return new Response(JSON.stringify({ plans: [draft, launched] }), { status: 200 });
      if (url === "/api/worktree-plans/plan-draft") return new Response(JSON.stringify(detail), { status: 200 });
      if (url === "/api/worktree-plans/plan-launched" && !init?.method) return new Response(JSON.stringify(launchedDetail), { status: 200 });
      if (url === "/api/worktree-plans/plan-launched" && init?.method === "DELETE") return new Response(JSON.stringify({ planId: "plan-launched", deleted: true }), { status: 200 });
      return new Response(JSON.stringify(dashboard), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreeDashboardView onOpenWorkspace={vi.fn()} onLaunched={vi.fn(async () => {})} onNotice={vi.fn()} />);

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

    await userEvent.click(screen.getByRole("tab", { name: /Launched Goals 1/ }));
    const launchedGoals = screen.getByRole("region", { name: "Launched goals" });
    assert.ok(within(launchedGoals).getByText("Ship prompt analytics"));
    await userEvent.click(within(launchedGoals).getByRole("button", { name: "View Ship prompt analytics" }));
    const launchedPlanner = await screen.findByRole("dialog", { name: "Plan a goal" });
    assert.ok(within(launchedPlanner).getByText("Measure prompt quality"));
    assert.ok(within(launchedPlanner).getByText("This goal was already launched. The saved plan is read-only."));
    await userEvent.click(within(launchedPlanner).getByRole("button", { name: "Close goal planner sheet" }));
    await userEvent.click(within(launchedGoals).getByRole("button", { name: "Delete Ship prompt analytics" }));
    await userEvent.click(within(launchedGoals).getByRole("button", { name: "Confirm delete Ship prompt analytics" }));
    await waitFor(() => assert.equal(screen.queryByText("Ship prompt analytics"), null));
  });

  test("offers bulk cleanup of clean worktrees and a named second confirmation for a detached release checkout", async () => {
    const worktree = (over: Record<string, unknown>) => ({ repoId: "repo-1", head: "abc", locked: null, prunable: null, ahead: 0, behind: 0, changedFiles: 0, dirty: false, detached: false, isPrimary: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" }, ...over });
    const emptyRepo = { id: "repo-2", name: "solo", root: "karven", path: "/repo/solo", pullRequestsAvailable: false, summary: { worktrees: 1, sessions: 0, needsYou: 0, working: 0, dirty: 0 }, worktrees: [worktree({ id: "soloprimary1234567", path: "/repo/solo", name: "solo", branch: "main", isPrimary: true })] };
    const repo = { id: "repo-1", name: "companion", root: "karven", path: "/repo/companion", pullRequestsAvailable: false, summary: { worktrees: 4, sessions: 0, needsYou: 0, working: 0, dirty: 1 }, worktrees: [
      worktree({ id: "primaryworktree123", path: "/repo/companion", name: "companion", branch: "main", isPrimary: true }),
      worktree({ id: "cleanworktree12345", path: "/repo/companion-clean", name: "companion-clean", branch: "chore/clean" }),
      worktree({ id: "lockedworktree1234", path: "/repo/companion-locked", name: "companion-locked", branch: "chore/locked", locked: "pinned" }),
      worktree({ id: "releaseworktree123", path: "/releases/abc123", name: "abc123", branch: "HEAD", detached: true, changedFiles: 2, dirty: true }),
    ] };
    const dashboard = { generatedAt: "2026-08-31", summary: { repositories: 2, worktrees: 5, sessions: 0, needsYou: 0, working: 0, dirty: 1, pullRequests: 0 }, orphanSessions: [], repositories: [repo, emptyRepo] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/repositories/repo-1/remove-clean")) return new Response(JSON.stringify({ repository: { id: "repo-1", name: "companion" }, requested: 1, removed: 0, failed: 1, branchPreserved: true, results: [{ id: "cleanworktree12345", branch: "chore/clean", path: "/repo/companion-clean", removed: false, error: "Git could not remove this worktree: fatal: locked" }] }), { status: 200 });
      if (init?.method === "DELETE") return new Response(JSON.stringify({ removed: true, branchPreserved: true, discardedChanges: true }), { status: 200 });
      return new Response(JSON.stringify(dashboard), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const notice = vi.fn();
    render(<WorktreeDashboardView onOpenWorkspace={vi.fn()} onLaunched={vi.fn(async () => {})} onNotice={notice} />);
    await userEvent.click(await screen.findByRole("tab", { name: /Inactive/ }));

    // Only the clean, unlocked, session-free, non-primary worktree counts.
    const bulk = screen.getByRole("button", { name: "Remove clean worktrees in companion" });
    assert.equal(bulk.textContent, "Remove clean (1)");
    assert.equal((bulk as HTMLButtonElement).disabled, false);
    const soloBulk = screen.getByRole("button", { name: "Remove clean worktrees in solo" });
    assert.equal(soloBulk.textContent, "Remove clean (0)");
    assert.equal((soloBulk as HTMLButtonElement).disabled, true);

    await userEvent.click(bulk);
    const sheet = screen.getByRole("dialog", { name: "Remove clean worktrees" });
    assert.ok(within(sheet).getByText("Remove 1 clean worktree?"));
    assert.ok(within(sheet).getByText("chore/clean"));
    assert.equal(within(sheet).queryByText("chore/locked"), null);
    assert.equal(within(sheet).queryByText("main"), null);
    await userEvent.click(within(sheet).getByRole("button", { name: "Remove 1 worktree" }));
    await waitFor(() => assert.equal(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/repositories/repo-1/remove-clean") && init?.method === "POST"), true));
    await waitFor(() => assert.equal(notice.mock.calls.some(([message]) => String(message).includes("Removed 0 of 1 worktrees") && String(message).includes("chore/clean (Git could not remove this worktree: fatal: locked)")), true));

    // The detached release checkout is dirty, so it needs a second confirmation
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

  async function launchReadyPlan(launchResult: unknown) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      void init;
      if (url.endsWith("/launch")) return new Response(JSON.stringify(launchResult), { status: 200 });
      return new Response(JSON.stringify(readyDraft), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onLaunched={async () => {}} onNotice={() => {}} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Goal" }), "Ship the planner");
    await userEvent.click(screen.getByRole("button", { name: "Plan this goal" }));
    await userEvent.click(await screen.findByRole("button", { name: "Launch 2 sessions" }));
    return fetchMock;
  }

  test("lists saved goals and resumes each persisted stage", async () => {
    const updatedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const questionDraft = { planId: "plan-questions", repositoryId: "repo-1", repositoryName: "companion", goal: "Clarify the mobile flow", round: 3, status: "questions", planStatus: "draft", questions: [{ id: "question-1", text: "Which screen comes first?", options: ["Goals", "Tasks"] }], tasks: [], createdAt: updatedAt, updatedAt, launchedAt: null, base: "main", history: [] };
    const summaries = { plans: [
      { planId: "plan-questions", repositoryId: "repo-1", repositoryName: "companion", goal: "Clarify the mobile flow", status: "draft", stage: "questions", round: 3, taskCount: 0, launchedCount: 0, createdAt: updatedAt, updatedAt, launchedAt: null },
      { planId: "plan-launched", repositoryId: "repo-1", repositoryName: "companion", goal: "Ship the finished flow", status: "launched", stage: "ready", round: 2, taskCount: 2, launchedCount: 2, createdAt: updatedAt, updatedAt, launchedAt: updatedAt },
    ] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/worktree-plans?repositoryId=repo-1") return new Response(JSON.stringify(summaries), { status: 200 });
      if (url === "/api/worktree-plans/plan-questions") return new Response(JSON.stringify(questionDraft), { status: 200 });
      return new Response(JSON.stringify({ error: "Unexpected request" }), { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onLaunched={async () => {}} onNotice={() => {}} />);

    const saved = await screen.findByRole("region", { name: "Saved goals" });
    assert.ok(within(saved).getByText("Clarify the mobile flow"));
    assert.ok(within(saved).getByText("Ship the finished flow"));
    assert.equal(within(saved).getAllByText("Draft").length, 1);
    assert.equal(within(saved).getAllByText("Launched").length, 1);
    assert.ok(within(saved).getByText(/round 3 · 0 tasks · 2h/));
    assert.ok(screen.getByRole("textbox", { name: "Goal" }), "the new-goal form stays below saved goals");

    await userEvent.click(within(saved).getByRole("button", { name: "Resume Clarify the mobile flow" }));
    assert.ok(await screen.findByText("Round 3"));
    assert.ok(screen.getByRole("textbox", { name: "Which screen comes first?" }));
    assert.ok(screen.getByRole("button", { name: "Answer" }));
    await userEvent.click(screen.getByRole("button", { name: "← New goal" }));
    assert.ok(await screen.findByRole("region", { name: "Saved goals" }));
    assert.equal((screen.getByRole("textbox", { name: "Goal" }) as HTMLTextAreaElement).value, "");
    await waitFor(() => assert.equal(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/worktree-plans?repositoryId=repo-1").length, 2));
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
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onLaunched={async () => {}} onNotice={() => {}} />);

    await userEvent.click(await screen.findByRole("button", { name: "View Ship the finished flow" }));
    assert.ok(await screen.findByText("This goal was already launched. The saved plan is read-only."));
    assert.equal(screen.queryByRole("button", { name: "Launch 2 sessions" }), null);
    assert.equal(screen.queryByRole("button", { name: "Remove Build the sheet" }), null);
    assert.equal((screen.getByRole("button", { name: "Use Codex for Build the sheet" }) as HTMLButtonElement).disabled, true);
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
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onLaunched={async () => {}} onNotice={() => {}} />);

    await userEvent.click(await screen.findByRole("button", { name: "View Ship together" }));
    assert.ok(await screen.findByRole("region", { name: "Combined delivery status" }));
    assert.ok(screen.getByText("Combined delivery needs attention"));
    assert.ok(screen.getByText("Waiting for one pushed branch"));
    await userEvent.click(screen.getByRole("button", { name: "Check & build combined PR" }));
    assert.ok(await screen.findByRole("link", { name: "Open PR #42" }));
    assert.equal(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/assemble")), true);
  });

  test("confirms saved-goal deletion and surfaces the server error verbatim", async () => {
    const now = new Date().toISOString();
    const saved = (planId: string, goal: string) => ({ planId, repositoryId: "repo-1", repositoryName: "companion", goal, status: "draft", stage: "ready", round: 1, taskCount: 2, launchedCount: 0, createdAt: now, updatedAt: now, launchedAt: null });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("?repositoryId=")) return new Response(JSON.stringify({ plans: [saved("plan-delete", "Delete this goal"), saved("plan-fail", "Keep this goal")] }), { status: 200 });
      if (url.endsWith("/plan-delete") && init?.method === "DELETE") return new Response(JSON.stringify({ deleted: true }), { status: 200 });
      if (url.endsWith("/plan-fail") && init?.method === "DELETE") return new Response(JSON.stringify({ error: "SQLite is busy" }), { status: 503 });
      return new Response(JSON.stringify({ error: "Unexpected request" }), { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onLaunched={async () => {}} onNotice={() => {}} />);

    await userEvent.click(await screen.findByRole("button", { name: "Delete Delete this goal" }));
    assert.equal(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"), false);
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete Delete this goal" }));
    await waitFor(() => assert.equal(screen.queryByText("Delete this goal"), null));

    await userEvent.click(screen.getByRole("button", { name: "Delete Keep this goal" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete Keep this goal" }));
    assert.ok(await screen.findByText("SQLite is busy"));
    assert.ok(screen.getByText("Keep this goal"));
  });

  test("walks a goal through questions into a plan and launches every task", async () => {
    const questionDraft = { planId: "plan-1", repositoryId: "repo-1", goal: "Ship the planner", round: 1, status: "questions", questions: [{ id: "question-1", text: "Which surface comes first?", options: ["Mobile", "Desktop"] }], tasks: [] };
    const toggled = { ...readyDraft, tasks: [{ ...tasks[0], agent: "claude", agentReason: "You picked Claude" }, tasks[1]] };
    const launchResult = { planId: "plan-1", base: "main", launched: 2, results: [
      { id: "task-1", title: "Build the sheet", branch: "feature/planner-sheet", agent: "claude", status: "launched", path: "/repo/companion-planner-sheet" },
      { id: "task-2", title: "Wire the routes", branch: "feature/planner-routes", agent: "claude", status: "launched", path: "/repo/companion-planner-routes" },
    ] };
    const launched = vi.fn(async () => {});
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/worktree-plans" && init?.method === "POST") return new Response(JSON.stringify(questionDraft), { status: 201 });
      if (url === "/api/worktree-plans/plan-1/answers") return new Response(JSON.stringify(readyDraft), { status: 200 });
      if (url === "/api/worktree-plans/plan-1" && init?.method === "PATCH") return new Response(JSON.stringify(toggled), { status: 200 });
      if (url === "/api/worktree-plans/plan-1/launch") return new Response(JSON.stringify(launchResult), { status: 200 });
      return new Response(JSON.stringify({ error: "Unexpected request" }), { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onLaunched={launched} onNotice={() => {}} />);
    const goal = screen.getByRole("textbox", { name: "Goal" });
    assert.equal(goal.getAttribute("maxlength"), "4000");
    assert.equal((screen.getByRole("button", { name: "Plan this goal" }) as HTMLButtonElement).disabled, true);
    await userEvent.type(goal, "Ship the planner");
    await userEvent.click(screen.getByRole("button", { name: "Plan this goal" }));
    assert.ok(await screen.findByText("Round 1"));
    await userEvent.click(screen.getByRole("button", { name: "Answer Which surface comes first? with Mobile" }));
    assert.equal((screen.getByRole("textbox", { name: "Which surface comes first?" }) as HTMLTextAreaElement).value, "Mobile");
    assert.ok(screen.getByRole("button", { name: "Skip questions" }));
    await userEvent.click(screen.getByRole("button", { name: "Answer" }));
    assert.ok(await screen.findByText("Build the sheet"));
    assert.ok(screen.getByText("feature/planner-routes"));
    assert.ok(screen.getByText("UI work suits Codex"));
    await userEvent.click(screen.getByRole("button", { name: "Use Claude for Build the sheet" }));
    assert.ok(await screen.findByText("You picked Claude"));
    await userEvent.click(screen.getByRole("button", { name: "Launch 2 sessions" }));
    assert.ok(await screen.findByText("main"));
    assert.equal(screen.getAllByText("Launched").length, 2);
    await waitFor(() => assert.equal(launched.mock.calls.length, 1));
    const answerCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/answers"));
    assert.match(String(answerCall?.[1]?.body), /"id":"question-1"/);
    assert.match(String(answerCall?.[1]?.body), /"text":"Mobile"/);
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    assert.match(String(patchCall?.[1]?.body), /"agent":"claude"/);
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([url]) => String(url));
    assert.deepEqual(posts, ["/api/worktree-plans", "/api/worktree-plans/plan-1/answers", "/api/worktree-plans/plan-1/launch"]);
  });

  test("offers a retry only when nothing launched", async () => {
    await launchReadyPlan({ planId: "plan-1", base: "main", launched: 1, results: [
      { id: "task-1", title: "Build the sheet", branch: "feature/planner-sheet", agent: "codex", status: "launched", path: "/repo/companion-planner-sheet" },
      { id: "task-2", title: "Wire the routes", branch: "feature/planner-routes", agent: "claude", status: "failed", error: "Branch already exists" },
    ] });
    assert.ok(await screen.findByText("Branch already exists"));
    assert.equal(screen.queryByRole("button", { name: "Try again" }), null);
    assert.ok(screen.getByText(/finish the rest from the dashboard/i));
    cleanup();
    const fetchMock = await launchReadyPlan({ planId: "plan-1", base: "main", launched: 0, results: [
      { id: "task-1", title: "Build the sheet", branch: "feature/planner-sheet", agent: "codex", status: "failed", error: "Could not read the repository" },
      { id: "task-2", title: "Wire the routes", branch: "feature/planner-routes", agent: "claude", status: "failed", error: "Could not read the repository" },
    ] });
    const retry = await screen.findByRole("button", { name: "Try again" });
    await userEvent.click(retry);
    await waitFor(() => assert.equal(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/launch")).length, 2));
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

  test("shows the live steps while a plan is being made", async () => {
    const streams = fakeEventSource();
    let release: (value: Response) => void = () => {};
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      if (String(input) === "/api/worktree-plans") return new Promise<Response>((resolve) => { release = resolve; });
      return new Response(JSON.stringify(readyDraft), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onLaunched={async () => {}} onNotice={() => {}} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Goal" }), "Ship the planner");
    await userEvent.click(screen.getByRole("button", { name: "Plan this goal" }));

    const body = JSON.parse(String(fetchMock.mock.calls.find(([url]) => String(url) === "/api/worktree-plans")?.[1]?.body));
    assert.match(body.traceId, /^[0-9a-f-]{36}$/);
    assert.equal(streams.length, 1);
    assert.ok(streams[0].url.endsWith(`/api/worktree-plans/progress/${body.traceId}`));

    streams[0].emit({ k: "tool", t: "Read server/app.mjs" });
    streams[0].emit({ k: "text", t: "Thinking…" });
    assert.ok(await screen.findByText("Read server/app.mjs"));
    assert.ok(screen.getByText("Thinking…"));

    release(new Response(JSON.stringify(readyDraft), { status: 201 }));
    assert.ok(await screen.findByText("Build the sheet"));
    assert.equal(screen.queryByText("Read server/app.mjs"), null);
  });

  test("closes the progress stream when the sheet closes", async () => {
    const streams = fakeEventSource();
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>(() => {})));
    const view = render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onLaunched={async () => {}} onNotice={() => {}} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Goal" }), "Ship the planner");
    await userEvent.click(screen.getByRole("button", { name: "Plan this goal" }));
    assert.equal(streams[0].closed, false);
    view.unmount();
    assert.equal(streams[0].closed, true);
  });

  test("ends the stream when the planner reports it is done", async () => {
    const streams = fakeEventSource();
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>(() => {})));
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onLaunched={async () => {}} onNotice={() => {}} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Goal" }), "Ship the planner");
    await userEvent.click(screen.getByRole("button", { name: "Plan this goal" }));
    streams[0].emit({ k: "tool", t: "Read server/app.mjs" });
    assert.ok(await screen.findByText("Read server/app.mjs"));
    streams[0].emit({ k: "done" });
    assert.equal(streams[0].closed, true);
  });

  test("attaches a pasted image to the goal and drops it again", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/attachments/images") && init?.method === "POST") return new Response(JSON.stringify({ image: { path: "/attachments/goal.png", name: "goal.png", mime: "image/png", size: 5 } }), { status: 201 });
      return new Response(JSON.stringify(readyDraft), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onLaunched={async () => {}} onNotice={() => {}} />);
    const goal = screen.getByRole("textbox", { name: "Goal" });
    await userEvent.type(goal, "Ship the planner");
    const pasted = new File(["image"], "goal.png", { type: "image/png" });
    fireEvent.paste(goal, { clipboardData: { items: [{ type: "image/png", getAsFile: () => pasted }] } });
    assert.ok(await screen.findByRole("img", { name: "goal.png" }));
    await userEvent.click(screen.getByRole("button", { name: "Plan this goal" }));
    const planCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/worktree-plans");
    assert.match(String(planCall?.[1]?.body), /"images":\[\{"path":"\/attachments\/goal.png","name":"goal.png"\}\]/);
  });

  test("the remove button drops an attached image", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/attachments/images") && init?.method === "POST") return new Response(JSON.stringify({ image: { path: "/attachments/goal.png", name: "goal.png", mime: "image/png", size: 5 } }), { status: 201 });
      return new Response(JSON.stringify(readyDraft), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onLaunched={async () => {}} onNotice={() => {}} />);
    const goal = screen.getByRole("textbox", { name: "Goal" });
    await userEvent.type(goal, "Ship the planner");
    const pasted = new File(["image"], "goal.png", { type: "image/png" });
    fireEvent.paste(goal, { clipboardData: { items: [{ type: "image/png", getAsFile: () => pasted }] } });
    assert.ok(await screen.findByRole("img", { name: "goal.png" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove goal.png" }));
    assert.equal(screen.queryByRole("img", { name: "goal.png" }), null);
    await userEvent.click(screen.getByRole("button", { name: "Plan this goal" }));
    const planCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/worktree-plans");
    assert.match(String(planCall?.[1]?.body), /"images":\[\]/);
  });

  test("shows the goal and the attached image in the context panel", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/attachments/images") && init?.method === "POST") return new Response(JSON.stringify({ image: { path: "/attachments/goal.png", name: "goal.png", mime: "image/png", size: 5 } }), { status: 201 });
      return new Response(JSON.stringify({ ...readyDraft, images: [{ path: "/attachments/goal.png", name: "goal.png" }] }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onLaunched={async () => {}} onNotice={() => {}} />);
    const goal = screen.getByRole("textbox", { name: "Goal" });
    await userEvent.type(goal, "Ship the planner");
    fireEvent.paste(goal, { clipboardData: { items: [{ type: "image/png", getAsFile: () => new File(["image"], "goal.png", { type: "image/png" }) }] } });
    assert.ok(await screen.findByRole("img", { name: "goal.png" }));
    await userEvent.click(screen.getByRole("button", { name: "Plan this goal" }));
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
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onLaunched={async () => {}} onNotice={() => {}} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Goal" }), "Ship the planner");
    await userEvent.click(screen.getByRole("button", { name: "Plan this goal" }));
    const panel = (await screen.findByLabelText("Your goal and attachments")).closest("details") as HTMLElement;
    assert.ok(panel);
    assert.ok(within(panel).getByText("old.png"));
    assert.equal(within(panel).queryByRole("img"), null);
  });

  test("a click on the backdrop leaves the planner open", async () => {
    const closed = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(readyDraft), { status: 201 })));
    const { container } = render(<WorktreePlannerSheet repository={repository} onClose={closed} onLaunched={async () => {}} onNotice={() => {}} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Goal" }), "Ship the planner");
    const backdrop = container.querySelector(".session-menu-backdrop");
    assert.ok(backdrop);
    await userEvent.click(backdrop);
    assert.equal(closed.mock.calls.length, 0);
    assert.equal((screen.getByRole("textbox", { name: "Goal" }) as HTMLTextAreaElement).value, "Ship the planner");
    await userEvent.click(screen.getByRole("button", { name: "Close goal planner sheet" }));
    assert.equal(closed.mock.calls.length, 1);
  });

  test("names the worktree a failed task left behind", async () => {
    await launchReadyPlan({ planId: "plan-1", base: "main", launched: 0, results: [
      { id: "task-1", title: "Build the sheet", branch: "feature/planner-sheet", agent: "codex", status: "failed", path: "/Users/sample/repo/companion-planner-sheet", error: "The session did not start" },
      { id: "task-2", title: "Wire the routes", branch: "feature/planner-routes", agent: "claude", status: "failed", error: "The session did not start" },
    ] });
    assert.ok(await screen.findByText(/~\/repo\/companion-planner-sheet/));
    assert.equal(screen.getAllByText(/Remove it from the dashboard/).length, 1);
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
