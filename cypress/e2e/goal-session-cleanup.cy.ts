// The board's report of automatic session cleanup. The server owns the rule
// about which cmux session may close; every route here is stubbed, so this
// spec only proves what the board says about a pass and what it offers before
// one runs.
const now = "2026-09-04T12:00:00.000Z";
const repository = {
  id: "repo-e2e", name: "cmux-e2e-cypress", root: "karven", path: "/Users/test/Developers/karven/cmux-e2e-cypress",
  pullRequestsAvailable: true,
  summary: { worktrees: 1, releases: 0, sessions: 3, needsYou: 0, working: 0, dirty: 0 },
  worktrees: [{ id: "worktree-e2e", repoId: "repo-e2e", path: "/Users/test/Developers/karven/cmux-e2e-cypress", name: "cmux-e2e-cypress", branch: "main", isPrimary: true, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }],
  releases: [],
};

// One launched goal whose pull request is open: two finished task sessions and
// a merge session whose agent is still running.
const plan = {
  planId: "goal-cleanup", repositoryId: "repo-e2e", repositoryName: "cmux-e2e-cypress",
  goal: "Retire the finished goal sessions", status: "launched", stage: "ready", round: 1,
  taskCount: 2, launchedCount: 2, readyCount: 2, agentSplit: { claude: 1, codex: 1 },
  workspaceIds: ["ws-t1", "ws-t2", "ws-merge"], deliveryStatus: "pr_open",
  boardPrState: "OPEN", boardPrNumber: 12, boardPrUrl: "https://github.test/pull/12",
  boardState: "in_review", createdAt: now, updatedAt: now, launchedAt: now,
};

const closedTask = (id: string, taskId: string, title: string) => ({
  planId: plan.planId, workspaceId: id, taskId, kind: "task", title,
  reason: "This goal's pull request is open, so this task's work is delivered",
});
const keptMerge = {
  planId: plan.planId, workspaceId: "ws-merge", kind: "merge",
  reason: "This session's agent is running",
};

// The dry run and the real pass answer with the same shape, so one builder
// serves both and the button's count can never drift from the pass.
function report(overrides: Record<string, unknown> = {}) {
  return {
    checkedAt: now, sessionsAvailable: true,
    closed: [closedTask("ws-t1", "T1", "Implement the fixture"), closedTask("ws-t2", "T2", "Verify the fixture")],
    kept: [keptMerge], failed: [],
    ...overrides,
  };
}

type Scenario = { retirable: Record<string, unknown>; reap: Record<string, unknown>; liveSessions: number };

function installScenario(state: Scenario) {
  const dashboard = () => ({
    generatedAt: now, github: { checkedAt: now, status: "ready" },
    summary: { repositories: 1, worktrees: 1, releases: 0, sessions: state.liveSessions, needsYou: 0, working: 0, dirty: 0, pullRequests: 1 },
    repositories: [{ ...repository, summary: { ...repository.summary, sessions: state.liveSessions } }], orphanSessions: [],
  });
  const health = () => ({
    checkedAt: now, sessionsAvailable: true,
    goals: [{
      planId: plan.planId, goal: plan.goal, repositoryId: plan.repositoryId, repositoryName: plan.repositoryName,
      health: "ready", stuckCount: 0, readyCount: 2, launchedCount: 2, taskCount: 2,
      deliveryStatus: plan.deliveryStatus, merge: null, tasks: [],
    }],
    summary: { goals: 1, tasks: 2, stuck: 0, needsYou: 0, working: 0, deadTasks: 0, idleTasks: 0, failedTasks: 0 },
  });

  // Registered first so the explicit routes below win Cypress's reverse-order
  // matching. Any missing fixture, including a future mutation, fails closed
  // instead of escaping through Vite's proxy to the installed Companion.
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [], error: null, refreshedAt: now });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/github-issues", { syncedAt: null, issues: [] });
  cy.intercept("GET", "**/api/goals/capacity*", { providers: [], next: null, reason: "Local fixture", nextReset: null, available: false });
  cy.intercept("GET", "**/api/worktree-dashboard*", (request) => request.reply(dashboard())).as("dashboard");
  cy.intercept("GET", "**/api/worktree-plans*", (request) => request.reply({ plans: [plan] })).as("plans");
  cy.intercept("GET", "**/api/goals/health", (request) => request.reply(health())).as("health");
  cy.intercept("GET", "**/api/goals/sessions/retirable*", (request) => request.reply(state.retirable)).as("retirable");
  cy.intercept("POST", "**/api/goals/sessions/reap", (request) => request.reply(state.reap)).as("reap");
}

function visitBoard() {
  cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); } });
  cy.wait(["@dashboard", "@plans", "@health", "@retirable"]);
  cy.findByRole("region", { name: "Goals board" }).should("be.visible");
}

describe("the board reports finished goal session cleanup", () => {
  it("includes restored workspaces in the review and reports their closure", () => {
    const restored = { ...closedTask("restored-uuid", "", "Restored goal merge"), kind: "restored",
      reason: "Restored workspace matches a delivered goal by checkout path and Companion title" };
    const state: Scenario = { retirable: report({ closed: [restored] }), reap: report({ closed: [restored] }), liveSessions: 2 };
    installScenario(state);
    visitBoard();
    cy.openBoardTools();
    cy.findByRole("button", { name: "Close 1 finished session" }).should("be.enabled");
    cy.then(() => { state.liveSessions = 1; state.retirable = report({ closed: [] }); });
    cy.openBoardTools();
    cy.findByRole("button", { name: "Close 1 finished session" }).click();
    cy.wait("@reap");
    cy.contains("Closed 1 finished session, 1 kept.").should("be.visible");
    cy.openBoardTools();
    cy.findByRole("button", { name: "Close finished sessions. No sessions currently qualify for safe cleanup." }).should("be.disabled");
  });

  it("closes two finished task sessions and explains the merge session it kept", () => {
    const state: Scenario = { retirable: report(), reap: report(), liveSessions: 3 };
    installScenario(state);
    visitBoard();

    // The count is read before the button is pressed, so the label is honest
    // about what a pass would do.
    cy.openBoardTools();
    cy.findByRole("button", { name: "Close 2 finished sessions" })
      .should("be.enabled")
      .and("contain.text", "Close finished sessions (2)");

    cy.then(() => { state.liveSessions = 1; state.retirable = report({ closed: [] }); });
    cy.openBoardTools();
    cy.findByRole("button", { name: "Close 2 finished sessions" }).click();
    cy.wait("@reap");
    cy.wait(["@dashboard", "@plans", "@health", "@retirable"]);

    cy.contains("Closed 2 finished sessions, 1 kept.").should("be.visible");
    cy.contains("This session's agent is running").should("be.visible");
    // Nothing is finished after the pass, so the button disables rather than
    // disappearing: the action is still there, it just has nothing to do.
    cy.openBoardTools();
    cy.findByRole("button", { name: "Close finished sessions. No sessions currently qualify for safe cleanup." }).should("be.disabled");
    cy.findByLabelText("1 live cmux sessions").should("exist");
  });

  it("says liveness is unknown, rather than zero finished sessions, when cmux is unreachable", () => {
    const unreachable = { checkedAt: now, sessionsAvailable: false, closed: [], kept: [], failed: [] };
    // An unreachable cmux still leaves the action on screen, disabled: a pass
    // that proves nothing must never be offered as a pass that found nothing.
    const state: Scenario = { retirable: report(), reap: unreachable, liveSessions: 3 };
    installScenario(state);
    visitBoard();

    // The pass re-reads the dry run when it finishes, so the fixture changes
    // before the click rather than after it. The button's label at click time
    // came from the read the board already made.
    cy.then(() => { state.retirable = unreachable; });
    cy.openBoardTools();
    cy.findByRole("button", { name: "Close 2 finished sessions" }).click();
    cy.wait("@reap");

    cy.contains("cmux could not be reached, so agent liveness is unknown. No session was closed.").should("be.visible");
    cy.contains("Closed 0 finished sessions").should("not.exist");
    cy.openBoardTools();
    cy.findByRole("button", { name: "Close finished sessions. No sessions currently qualify for safe cleanup." }).should("be.disabled");
  });

  it("names the session cmux refused to close", () => {
    const refused = report({
      closed: [closedTask("ws-t1", "T1", "Implement the fixture")],
      failed: [{ planId: plan.planId, workspaceId: "ws-t2", error: "Closing this session failed" }],
    });
    const state: Scenario = { retirable: report(), reap: refused, liveSessions: 3 };
    installScenario(state);
    visitBoard();

    cy.openBoardTools();
    cy.findByRole("button", { name: "Close 2 finished sessions" }).click();
    cy.wait("@reap");

    cy.contains("Closed 1 finished session, 1 kept.").should("be.visible");
    cy.contains("cmux refused to close 1 session: ws-t2 (Closing this session failed)").should("be.visible");
  });
});

export {};
