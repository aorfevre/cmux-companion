import assert from "node:assert/strict";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, test, vi } from "vitest";
import { goalPrLink, terminalStatus, WorktreePlannerSheet, type PlanDraft } from "../app/worktree-planner";

const repository = { id: "repo-1", name: "companion" };
const now = new Date().toISOString();
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
type Handler = (url: string, init?: RequestInit) => Response | undefined;

function stubFetch(handler: Handler = () => undefined) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const custom = handler(url, init);
    if (custom) return custom;
    if (url === "/api/settings/models") return response({ error: "Model settings unavailable" }, 503);
    return response({ error: `Unmocked ${url}` }, 501);
  }));
  return calls;
}

// The passport's readiness block is also an alert, so the sheet-level error is the last one.
const sheetError = async () => (await screen.findAllByRole("alert")).at(-1)!.textContent || "";
const posted = (calls: { url: string; init?: RequestInit }[], url: string) => calls.filter((call) => call.url === url && call.init?.method === "POST");

// A goal session with a saved proposal, so approval, feedback, answers and the
// managed runner poll all have a real draft to act on.
const proposalDraft: PlanDraft = { planId: "plan-goal", repositoryId: "repo-1", goal: "Ship the sheet", round: 1, status: "ready", questions: [], tasks: [], workflow: "goal_session", goalSessionState: "awaiting_approval", goalSessionGeneration: 3, goalSessionQuestionRevision: 1, proposalRevision: 2, proposal: { intendedBehavior: "Deliver the sheet" }, goalSessionRunnerPid: 44, goalSessionWorkspaceId: "ws-goal" };

const tasks = [
  { id: "T1", title: "Build the sheet", branch: "feature/sheet", prompt: "Build it", agent: "codex" as const, agentReason: "UI", wave: 0, launchStatus: "launched", deliveryStatus: "pending", criterionIds: ["C1"], ownedAreas: ["app/"], verification: ["npm test"], dependsOn: [] },
  { id: "T2", title: "Wire the routes", branch: "feature/routes", prompt: "Wire it", agent: "claude" as const, agentReason: "Server", wave: 1, launchStatus: "failed", launchReason: "locked", deliveryStatus: "pending", criterionIds: ["C1"], dependsOn: ["T1"], completionReport: { criteria: [], verification: [{ check: "npm test", status: "failed" as const }], limitations: ["No e2e"] }, scopeWarnings: ["server/app.mjs"], evidenceError: "Report missing" },
  { id: "T3", title: "Merged task", branch: "feature/merged", prompt: "Done", agent: "codex" as const, agentReason: "", wave: 1, launchStatus: "launched", deliveryStatus: "integrated", criterionIds: ["C2"] },
];
const launchedDraft: PlanDraft = { planId: "plan-launched", repositoryId: "repo-1", goal: "Ship together", round: 2, status: "ready", planStatus: "launched", deliveryMode: "combined", deliveryStatus: "assembling", questions: [{ id: "Q1", text: "Which database?", options: ["SQLite", "Postgres"] }], tasks, launchedAt: now, discussion: [{ question: "Why two waves?", answer: "", contractImpact: "revision_suggested", suggestion: "Merge them", round: 1, createdAt: now }, { question: "Is this safe?", answer: "Yes", contractImpact: "none", suggestion: "", round: 2, createdAt: now }],
  spec: { outcome: "A".repeat(340), inScope: ["The sheet"], nonGoals: [], constraints: ["No new deps"], assumptions: ["Users have cmux"], acceptanceCriteria: [{ id: "C1", text: "Sheet renders", verification: "vitest" }, { id: "C2", text: "Routes answer", verification: "" }, { id: "C3", text: "Unassigned", verification: "" }], risks: [{ text: "Flaky", mitigation: "", level: "low" }], approvalSummary: { overview: "B".repeat(340), userFlow: ["Open the sheet", "Approve"], decisions: [{ choice: "Combined PR", consequence: "One review" }], successCriteria: ["Everything green"] }, optionEvidence: {} },
  readiness: { ready: false, errors: ["Task T2 has no prompt"], warnings: ["T3 owns nothing"], waves: [["T1"], ["T2", "T3"]], coverage: [], optionCoverage: [{ id: "unitTests", requested: true, status: "covered", message: "Vitest covers it" }, { id: "e2eTests", requested: false, status: "not_requested", message: "" }] },
};

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("goal session sheet", () => {
  test("approves a proposal, requests changes and reports refusals", async () => {
    let approveFails = true;
    const calls = stubFetch((url, init) => {
      if (url === "/api/goal-sessions/plan-goal/approve" && init?.method === "POST") return approveFails ? response({ error: "Revision moved on" }, 409) : response({ ...proposalDraft, goalSessionState: "implementing", proposal: null });
      if (url === "/api/goal-sessions/plan-goal/request-changes" && init?.method === "POST") return response({ ...proposalDraft, proposalRevision: 3 });
      if (url === "/api/worktree-plans/plan-goal") return response(proposalDraft);
      return undefined;
    });
    const notice = vi.fn();
    render(<WorktreePlannerSheet repository={repository} initialDraft={proposalDraft} onClose={() => {}} onNotice={notice} />);
    assert.ok(screen.getByText("Proposal revision 2"));
    assert.ok(screen.getByText("Goal conversation"));
    await userEvent.type(screen.getByRole("textbox", { name: "Request proposal changes" }), "  Tighten the scope ");
    await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
    assert.ok(await screen.findByText("Proposal revision 3"));
    assert.deepEqual(JSON.parse(String(posted(calls, "/api/goal-sessions/plan-goal/request-changes")[0].init?.body)), { generation: 3, revision: 2, feedback: "Tighten the scope" });
    await userEvent.click(screen.getByRole("button", { name: "Approve and implement" }));
    assert.ok(await screen.findByRole("alert"));
    assert.match(screen.getByRole("alert").textContent || "", /Revision moved on/);
    approveFails = false;
    await userEvent.click(screen.getByRole("button", { name: "Approve and implement" }));
    assert.ok(await screen.findByText("Implementation is continuing in the same managed goal session."));
    assert.deepEqual(JSON.parse(String(posted(calls, "/api/goal-sessions/plan-goal/approve").at(-1)?.init?.body)), { generation: 3, revision: 3 });
  });

  test("answers managed questions and reports a refused answer", async () => {
    const questionDraft: PlanDraft = { ...proposalDraft, goalSessionState: "awaiting_input", proposal: null, questions: [{ id: "Q1", text: "Which database?", options: ["SQLite", "Postgres"] }, { id: "Q2", text: "Any deadline?", options: [] }] };
    let refuse = true;
    const calls = stubFetch((url, init) => {
      if (url === "/api/goal-sessions/plan-goal/answer" && init?.method === "POST") return refuse ? response({ error: "Question revision changed" }, 409) : response({ ...proposalDraft, goalSessionState: "planning", proposal: null });
      if (url === "/api/worktree-plans/plan-goal") return response(questionDraft);
      return undefined;
    });
    const opened = vi.fn();
    render(<WorktreePlannerSheet repository={repository} initialDraft={questionDraft} onClose={() => {}} onNotice={() => {}} onGoalSessionStarted={opened} />);
    assert.ok(screen.getByText("Question: Which database? (SQLite / Postgres)"));
    assert.ok(screen.getByText("Question: Any deadline?"));
    assert.equal((screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement).disabled, true);
    await userEvent.type(screen.getByRole("textbox", { name: "Answer managed goal questions" }), "SQLite, no deadline");
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));
    assert.match((await screen.findByRole("alert")).textContent || "", /Question revision changed/);
    refuse = false;
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));
    assert.ok(await screen.findByText(/Discovery is open in the interactive cmux conversation/));
    assert.deepEqual(JSON.parse(String(posted(calls, "/api/goal-sessions/plan-goal/answer")[0].init?.body)), { generation: 3, questionRevision: 1, feedback: "SQLite, no deadline" });
    await userEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    assert.equal(opened.mock.calls[0][0].planId, "plan-goal");
  });

  test("polls the managed runner while open, resumes a closed conversation and reports a failed resume", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const closedDraft: PlanDraft = { ...proposalDraft, goalSessionState: "planning", proposal: null, goalSessionRunnerPid: null, goalSessionRunnerDispatchId: null, goalSessionError: null };
    let reads = 0;
    let recoverFails = true;
    const calls = stubFetch((url, init) => {
      if (url === "/api/worktree-plans/plan-goal") { reads += 1; return reads > 1 ? response({ error: "Plan vanished" }, 404) : response(closedDraft); }
      if (url === "/api/goal-sessions/plan-goal/recover" && init?.method === "POST") return recoverFails ? response({ error: "Runner is busy" }, 409) : response({ ...closedDraft, goalSessionRunnerPid: 9 });
      return undefined;
    });
    const notice = vi.fn();
    render(<WorktreePlannerSheet repository={repository} initialDraft={closedDraft} onClose={() => {}} onNotice={notice} />);
    assert.ok(screen.getByText("Conversation closed. Discovery and saved proposals are preserved."));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_600); });
    assert.equal(reads, 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_600); });
    assert.ok(await screen.findByText("Plan vanished"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resume conversation" })); });
    await waitFor(() => assert.match(screen.getByRole("alert").textContent || "", /Runner is busy/));
    recoverFails = false;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resume conversation" })); });
    await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Resume conversation" }), null));
    assert.match(String(notice.mock.calls.at(-1)?.[0]), /recovery requested/);
    assert.equal(posted(calls, "/api/goal-sessions/plan-goal/recover").length, 2);
  });

  test("an analysis goal reads its own states and approval label", async () => {
    stubFetch();
    const analysing: PlanDraft = { ...proposalDraft, goalType: "analysis", goalSessionState: "analyzing", proposal: null };
    const { rerender } = render(<WorktreePlannerSheet repository={repository} initialDraft={analysing} onClose={() => {}} onNotice={() => {}} />);
    assert.ok(screen.getByText(/Analysis is continuing read-only/));
    rerender(<WorktreePlannerSheet key="ready" repository={repository} initialDraft={{ ...analysing, goalSessionState: "analysis_ready" }} onClose={() => {}} onNotice={() => {}} />);
    assert.ok(screen.getByText(/The analysis report is saved below/));
    rerender(<WorktreePlannerSheet key="uncertain" repository={repository} initialDraft={{ ...analysing, goalSessionState: "planning", transitionStatus: "uncertain" }} onClose={() => {}} onNotice={() => {}} />);
    assert.ok(screen.getByText(/The implementation handoff is uncertain/));
    rerender(<WorktreePlannerSheet key="approve" repository={repository} initialDraft={{ ...proposalDraft, goalType: "analysis" }} onClose={() => {}} onNotice={() => {}} />);
    assert.ok(screen.getByRole("button", { name: "Approve analysis" }));
    rerender(<WorktreePlannerSheet key="review" repository={repository} initialDraft={{ ...proposalDraft, engine: { provider: "claude", model: "m", effort: "high", reviewer: true }, reviews: [{ id: "r1", kind: "planner", target: "2", status: "running", result: null, error: null, acknowledgedAt: null }] }} onClose={() => {}} onNotice={() => {}} />);
    assert.ok(screen.getByText(/Independent planner review must finish/));
    assert.equal((screen.getByRole("button", { name: "Approve and implement" }) as HTMLButtonElement).disabled, true);
  });

  test("a lost session clears the draft and returns to the form", async () => {
    stubFetch((url, init) => url === "/api/goal-sessions/plan-goal/approve" && init?.method === "POST" ? response({ error: "The planner lost its session; start again" }, 410) : undefined);
    render(<WorktreePlannerSheet repository={repository} initialDraft={proposalDraft} onClose={() => {}} onNotice={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve and implement" }));
    assert.ok(await screen.findByRole("textbox", { name: "Goal" }));
    assert.ok(screen.getByText(/The planner lost its session/));
  });
});

describe("goal form", () => {
  test("loads saved model defaults, switches engines and reviewers, and posts the intake answers", async () => {
    const calls = stubFetch((url, init) => {
      if (url === "/api/settings/models") return response({ roles: { planner: { provider: "claude", models: { claude: "default", codex: "gpt-6-astra" } }, codeReviewer: { models: { claude: "claude-fable-5-1", codex: "gpt-5.6-sol" } }, specReviewer: { models: { claude: "claude-fable-5-1", codex: "gpt-5.6-sol" } } }, defaults: {}, warning: "Saved planner model is deprecated" });
      if (url === "/api/goal-sessions" && init?.method === "POST") return response({ ...proposalDraft, running: true });
      return undefined;
    });
    const close = vi.fn();
    render(<WorktreePlannerSheet repository={repository} onClose={close} onNotice={() => {}} />);
    assert.ok(await screen.findByRole("status"));
    assert.match(screen.getByRole("status").textContent || "", /deprecated/);
    assert.equal((screen.getByRole("combobox", { name: "Planner engine" }) as HTMLSelectElement).value, "claude");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Planner engine" }), "codex");
    assert.equal((screen.getByRole("combobox", { name: "Planner model" }) as HTMLSelectElement).value, "gpt-6-astra");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Planner model" }), "__custom__");
    await userEvent.type(screen.getByRole("textbox", { name: "Planner model ID" }), "gpt-custom");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Planner effort" }), "low");
    await userEvent.click(screen.getByRole("checkbox", { name: "Add reviewer pass" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Code reviewer" }), "codex");
    assert.equal((screen.getByRole("combobox", { name: "Code reviewer model" }) as HTMLSelectElement).value, "gpt-5.6-sol");
    await userEvent.click(screen.getByRole("checkbox", { name: "Code review" }));
    await userEvent.click(screen.getByRole("button", { name: "Review dev setup" }));
    assert.ok(screen.getByText(/The goal below is editable/));
    assert.equal((screen.getByRole("button", { name: "Review dev setup" }) as HTMLButtonElement).disabled, true);
    await userEvent.clear(screen.getByRole("textbox", { name: "Goal" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Goal" }), "Ship the sheet");
    await userEvent.type(screen.getByRole("textbox", { name: "What must not change" }), "The pairing flow");
    await userEvent.type(screen.getByRole("textbox", { name: "How you will know it worked" }), "npm test passes");
    await userEvent.click(screen.getByRole("checkbox", { name: "Burst" }));
    await userEvent.click(screen.getByRole("button", { name: "Start goal session" }));
    await waitFor(() => assert.equal(close.mock.calls.length, 1));
    const body = JSON.parse(String(posted(calls, "/api/goal-sessions")[0].init?.body));
    assert.deepEqual(body.engine, { provider: "codex", model: "gpt-custom", effort: "low", reviewer: false });
    assert.deepEqual(body.reviewOptions, { codeReview: false, reviewer: "codex", reviewerModel: "gpt-5.6-sol" });
    assert.deepEqual(body.intake, { exclusions: "The pairing flow", verification: "npm test passes" });
    assert.equal(body.burst, true);
    assert.equal(typeof body.idempotencyKey, "string");
  });

  test("an analysis goal disables the inapplicable spec options and code review", async () => {
    stubFetch();
    render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onNotice={() => {}} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Goal type" }), "analysis");
    assert.ok(screen.getByText(/versioned Markdown report/));
    const unitTests = screen.getByRole("checkbox", { name: "Unit tests" }) as HTMLInputElement;
    assert.equal(unitTests.disabled, true);
    assert.equal(unitTests.checked, false);
    assert.equal(screen.getAllByText("Not applicable to read-only analysis").length, 3);
    assert.equal((screen.getByRole("checkbox", { name: "Code review" }) as HTMLInputElement).disabled, true);
    assert.ok(screen.getByRole("combobox", { name: "Analysis critique model" }));
    assert.ok(screen.getByText(/Challenge the saved report instead/));
    await userEvent.click(screen.getByRole("checkbox", { name: "Flowcharts" }));
    assert.equal((screen.getByRole("checkbox", { name: "Flowcharts" }) as HTMLInputElement).checked, true);
  });

  test("copies the goal link and falls back to the address bar when the clipboard refuses", async () => {
    stubFetch();
    const notice = vi.fn();
    const write = vi.fn<(text: string) => Promise<void>>(async () => { throw new Error("denied"); });
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    render(<WorktreePlannerSheet repository={repository} initialDraft={proposalDraft} onClose={() => {}} onNotice={notice} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy goal link" }));
    await waitFor(() => assert.match(String(notice.mock.calls.at(-1)?.[0]), /Copy the goal URL from the address bar/));
    write.mockImplementation(async () => {});
    await userEvent.click(screen.getByRole("button", { name: "Copy goal link" }));
    await waitFor(() => assert.equal(notice.mock.calls.at(-1)?.[0], "Goal link copied"));
    assert.match(String(write.mock.calls.at(-1)?.[0]), /plan=plan-goal/);
  });

  test("a saved goal opened by id that cannot be read keeps the sheet on the form with the reason", async () => {
    stubFetch((url) => url === "/api/worktree-plans/plan-missing" ? response({ error: "Goal not found" }, 404) : undefined);
    render(<WorktreePlannerSheet repository={repository} initialPlanId="plan-missing" onClose={() => {}} onNotice={() => {}} />);
    assert.ok(await screen.findByText("Goal not found"));
    assert.ok(screen.getByRole("textbox", { name: "Goal" }));
  });
});

describe("launched goal passport", () => {
  test("reads every review tab, the delivery plan, the evidence and the discussion thread", async () => {
    stubFetch((url) => url === "/api/worktree-plans/plan-launched/health" ? response({ tasks: [{ id: "T1", health: "dead", reason: "Its session is gone", launchReason: null, session: { id: "ws-1" } }, { id: "T2", health: "failed", reason: "Locked", launchReason: "locked", session: null }] }) : undefined);
    render(<WorktreePlannerSheet repository={repository} initialDraft={launchedDraft} onClose={() => {}} onNotice={() => {}} />);
    assert.ok(screen.getByText("Saved discovery"));
    assert.ok(screen.getByText("Round 2 · 3 tasks"));
    assert.ok(screen.getByText("This goal was already launched. The saved plan is read-only."));
    assert.ok(screen.getByText(/Saved questions are read-only/));
    assert.ok(screen.getByRole("button", { name: "Answer Which database? with SQLite" }));
    const passport = screen.getByRole("region", { name: "Goal passport" });
    assert.ok(within(passport).getByText("Needs work"));
    assert.ok(within(passport).getByText("Task T2 has no prompt"));
    assert.ok(within(passport).getByText("Expected outcome (excerpt)"));
    assert.ok(within(passport).getByText("Read the full expected outcome"));
    assert.ok(within(passport).getByText("Read the full overview"));
    assert.ok(within(passport).getByText(/Before you decide: review 1 assumptions, 1 risks and 1 warnings/));
    await userEvent.click(within(passport).getByRole("button", { name: /Before you decide/ }));
    assert.equal(within(passport).getByRole("tab", { name: /Impacts/ }).getAttribute("aria-selected"), "true");
    assert.ok(within(passport).getByText("Combined PR"));
    assert.ok(within(passport).getByText("T3 owns nothing"));
    assert.ok(within(passport).getByText("Affected code · 1 declared areas"));
    assert.ok(within(passport).getByText(/Some tasks have no declared areas/));
    assert.ok(within(passport).getByText("No mitigation recorded"));
    await userEvent.click(within(passport).getByRole("tab", { name: "Design" }));
    assert.ok(within(passport).getByRole("list", { name: "User journey" }));
    assert.ok(within(passport).getByText("No design sketches yet"));
    await userEvent.click(within(passport).getByRole("tab", { name: "Tasks" }));
    const delivery = within(passport).getByRole("region", { name: "Delivery plan" });
    assert.ok(within(delivery).getByText("3 tasks · 2 stages"));
    assert.ok(within(delivery).getByText("2 tasks can run in parallel"));
    assert.ok(within(delivery).getByText("After task 1"));
    assert.equal(within(delivery).getAllByText("No prerequisites").length, 2);
    assert.ok(within(delivery).getByText("One combined pull request"));
    assert.equal(within(delivery).getAllByText("Scope: Sheet renders").length, 2);
    assert.ok(within(delivery).getAllByText("Files: Not declared").length >= 1);
    assert.ok(within(passport).getByText("Depends on: T1"));
    await userEvent.click(within(passport).getByRole("tab", { name: "Checks" }));
    assert.ok(within(passport).getByText("Everything green"));
    assert.equal(within(passport).getAllByText("Check: Not specified").length, 2);
    assert.ok(within(passport).getByText("No task assigned"));
    assert.ok(within(passport).getAllByText("integrated").length >= 1);
    assert.ok(within(passport).getAllByText("Unit tests").length >= 1);
    assert.ok(within(passport).getAllByText("Covered").length >= 1);
    assert.ok(within(passport).getByText("Vitest covers it"));
    assert.ok(within(passport).getByText("Limitation: No e2e"));
    assert.ok(within(passport).getByText("Outside ownership: server/app.mjs"));
    assert.ok(within(passport).getByText("Report missing"));
    // Keyboard navigation wraps around the tab list in both directions.
    const checks = within(passport).getByRole("tab", { name: "Checks" });
    checks.focus();
    await userEvent.keyboard("{ArrowRight}");
    assert.equal(within(passport).getByRole("tab", { name: "Overview" }).getAttribute("aria-selected"), "true");
    await userEvent.keyboard("{ArrowLeft}");
    assert.equal(within(passport).getByRole("tab", { name: "Checks" }).getAttribute("aria-selected"), "true");
    await userEvent.keyboard("{Home}");
    assert.equal(within(passport).getByRole("tab", { name: "Overview" }).getAttribute("aria-selected"), "true");
    await userEvent.keyboard("{End}");
    assert.equal(within(passport).getByRole("tab", { name: "Checks" }).getAttribute("aria-selected"), "true");
    await userEvent.keyboard("{Tab}");
    assert.equal(within(passport).getByRole("tab", { name: "Checks" }).getAttribute("aria-selected"), "true");
    await userEvent.click(within(passport).getByRole("tab", { name: "Overview" }));
    await userEvent.click(within(passport).getByRole("button", { name: /Design sketches/ }));
    assert.equal(within(passport).getByRole("tab", { name: "Design" }).getAttribute("aria-selected"), "true");
    await userEvent.click(within(passport).getByRole("tab", { name: "Overview" }));
    await userEvent.click(within(passport).getByRole("button", { name: /See all 3 acceptance checks/ }));
    assert.equal(within(passport).getByRole("tab", { name: "Checks" }).getAttribute("aria-selected"), "true");
    const thread = screen.getByRole("list", { name: "Discussion history" });
    assert.ok(within(thread).getByText("Earlier contract round"));
    assert.ok(within(thread).getByText("No answer was recorded yet."));
    assert.ok(within(thread).getByText("Merge them"));
    assert.ok(within(thread).getByText(/examined an earlier contract round/));
    assert.ok(screen.getByText("A merge agent is assembling this goal"));
    assert.ok(await screen.findByText("Its session is gone"));
    assert.ok(screen.getByText("1 of 2 branches ready"));
    assert.ok(screen.getAllByText("Merged").length >= 1);
    assert.ok(screen.getByText("Not launched"));
  });

  test("relaunches, restarts, skips and retries launched tasks from the sheet and reports refusals", async () => {
    let relaunchFails = true;
    let healthReads = 0;
    const calls = stubFetch((url, init) => {
      if (url === "/api/worktree-plans/plan-launched/health") { healthReads += 1; return healthReads === 1 ? response({ tasks: [{ id: "T1", health: "dead", reason: "Its session is gone", session: { id: "ws-1" } }, { id: "T2", health: "failed", reason: "Locked", launchReason: "locked", session: { id: "ws-2" } }] }) : response({ error: "Sweep unavailable" }, 503); }
      if (url.endsWith("/relaunch") && init?.method === "POST") return relaunchFails ? response({ error: "Relaunch refused" }, 409) : response(url.includes("T2") ? { branch: "feature/routes-2" } : {});
      if (url.endsWith("/skip") && init?.method === "POST") return response({});
      if (url === "/api/worktree-plans/plan-launched") return response(launchedDraft);
      return undefined;
    });
    const notice = vi.fn();
    render(<WorktreePlannerSheet repository={repository} initialDraft={launchedDraft} onClose={() => {}} onNotice={notice} />);
    const list = screen.getByRole("list", { name: "Task delivery" });
    await within(list).findByText("Its session is gone");
    await userEvent.click(within(list).getByRole("button", { name: "Continue Build the sheet" }));
    assert.match(await sheetError(), /Relaunch refused/);
    relaunchFails = false;
    await userEvent.click(within(list).getByRole("button", { name: "Continue Build the sheet" }));
    await waitFor(() => assert.equal(notice.mock.calls.at(-1)?.[0], "Continued the task in its existing worktree"));
    assert.deepEqual(JSON.parse(String(posted(calls, "/api/worktree-plans/plan-launched/tasks/T1/relaunch").at(-1)?.init?.body)), { mode: "continue", closeLive: true });
    await userEvent.click(within(list).getByRole("button", { name: "Restart or skip Build the sheet" }));
    assert.ok(within(list).getByText(/Restart discards this task/));
    await userEvent.click(within(list).getByRole("button", { name: "Cancel recovering Build the sheet" }));
    await userEvent.click(within(list).getByRole("button", { name: "Restart or skip Build the sheet" }));
    await userEvent.click(within(list).getByRole("button", { name: "Confirm restart Build the sheet" }));
    await waitFor(() => assert.equal(notice.mock.calls.at(-1)?.[0], "Restarted the task from its base branch"));
    // The second health read failed, so the verdict map is empty and closeLive is false.
    assert.deepEqual(JSON.parse(String(posted(calls, "/api/worktree-plans/plan-launched/tasks/T1/relaunch").at(-1)?.init?.body)), { mode: "restart", closeLive: false });
    await userEvent.click(within(list).getByRole("button", { name: "Restart or skip Build the sheet" }));
    await userEvent.click(within(list).getByRole("button", { name: "Confirm skip Build the sheet" }));
    await waitFor(() => assert.match(String(notice.mock.calls.at(-1)?.[0]), /Skipped the task/));
    assert.deepEqual(JSON.parse(String(posted(calls, "/api/worktree-plans/plan-launched/tasks/T1/skip")[0].init?.body)), { reason: "Skipped from the goal sheet" });
    await userEvent.click(within(list).getByRole("button", { name: "Retry on new branch for Wire the routes" }));
    await waitFor(() => assert.equal(notice.mock.calls.at(-1)?.[0], "Retried the task on feature/routes-2"));
    assert.deepEqual(JSON.parse(String(posted(calls, "/api/worktree-plans/plan-launched/tasks/T2/relaunch")[0].init?.body)), { mode: "rebranch", closeLive: false });
  });

  test("a refused skip and a rebranch without a branch name are both reported", async () => {
    stubFetch((url, init) => {
      if (url === "/api/worktree-plans/plan-launched/health") return response({ tasks: [{ id: "T2", health: "failed", reason: "Locked", launchReason: "locked", session: { id: "ws-2" } }] });
      if (url.endsWith("/skip") && init?.method === "POST") return response({ error: "Skip refused" }, 409);
      if (url.endsWith("/relaunch") && init?.method === "POST") return response({});
      if (url === "/api/worktree-plans/plan-launched") return response(launchedDraft);
      return undefined;
    });
    const notice = vi.fn();
    render(<WorktreePlannerSheet repository={repository} initialDraft={launchedDraft} onClose={() => {}} onNotice={notice} />);
    const list = screen.getByRole("list", { name: "Task delivery" });
    await within(list).findByText("Locked");
    await userEvent.click(within(list).getByRole("button", { name: "Restart or skip Build the sheet" }));
    await userEvent.click(within(list).getByRole("button", { name: "Confirm skip Build the sheet" }));
    assert.match(await sheetError(), /Skip refused/);
    await userEvent.click(within(list).getByRole("button", { name: "Retry on new branch for Wire the routes" }));
    await waitFor(() => assert.equal(notice.mock.calls.at(-1)?.[0], "Retried the task on a fresh branch"));
  });

  test("a failed assembly keeps the goal open with its reason", async () => {
    stubFetch((url, init) => {
      if (url === "/api/worktree-plans/plan-launched/health") return response({ tasks: [] });
      if (url.endsWith("/assemble") && init?.method === "POST") return response({ error: "One branch is behind" }, 409);
      return undefined;
    });
    render(<WorktreePlannerSheet repository={repository} initialDraft={{ ...launchedDraft, deliveryStatus: "blocked", integrationBranch: "goal/together" }} onClose={() => {}} onNotice={() => {}} />);
    assert.ok(screen.getByText("Combined delivery needs attention"));
    assert.ok(screen.getByText("goal/together"));
    await userEvent.click(screen.getByRole("button", { name: "Check & build combined PR" }));
    assert.match(await sheetError(), /One branch is behind/);
  });

  test("a stalled round names its last error and a terminal goal links its pull request", () => {
    stubFetch();
    const { rerender } = render(<WorktreePlannerSheet repository={repository} initialDraft={{ planId: "plan-stalled", repositoryId: "repo-1", goal: "Stalled goal", round: 0, status: "questions", questions: [], tasks: [], lastError: "The planner crashed", lastErrorAt: now }} onClose={() => {}} onNotice={() => {}} />);
    assert.ok(screen.getByText(/This round stopped before it produced anything\./));
    assert.ok(screen.getByText(/The planner crashed/));
    assert.ok(screen.getByText(/ago/));
    rerender(<WorktreePlannerSheet key="merged" repository={repository} initialDraft={{ ...launchedDraft, boardStatus: "merged", boardChangedAt: now, boardPrUrl: "https://github.test/pr/9", boardPrNumber: 9 }} onClose={() => {}} onNotice={() => {}} />);
    assert.ok(screen.getByRole("region", { name: "Merged goal" }));
    assert.equal(screen.getByRole("link", { name: "Open PR #9" }).getAttribute("href"), "https://github.test/pr/9");
    assert.ok(screen.getByText(/This goal is closed. Its questions and answers are read-only/));
    assert.equal(screen.queryByRole("button", { name: "Check & build combined PR" }), null);
    assert.equal(terminalStatus({ boardStatus: "merged" }), "merged");
    assert.equal(terminalStatus({ boardStatus: null }), null);
    assert.deepEqual(goalPrLink({ finalPrUrl: "https://github.test/pr/3", finalPrNumber: 3 }), { url: "https://github.test/pr/3", label: "Open PR #3" });
    assert.deepEqual(goalPrLink({ boardPrUrl: "https://github.test/pr/4" }), { url: "https://github.test/pr/4", label: "Open PR" });
    assert.equal(goalPrLink({}), null);
  });
});
