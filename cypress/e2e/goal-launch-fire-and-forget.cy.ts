// Launching a goal is fire and forget. The companion answers 202 as soon as it
// accepts the launch, so the sheet closes on a short notice, the card reads as
// launching, and a push notification reports the outcome later.
const now = "2026-09-03T12:00:00.000Z";
const repository = {
  id: "repo-e2e", name: "cmux-e2e-cypress", root: "karven", path: "/Users/test/Developers/karven/cmux-e2e-cypress",
  pullRequestsAvailable: true,
  summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 },
  worktrees: [{ id: "worktree-e2e", repoId: "repo-e2e", path: "/Users/test/Developers/karven/cmux-e2e-cypress", name: "cmux-e2e-cypress", branch: "main", isPrimary: true, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }],
  releases: [],
};

const GOAL = "Close the goal sheet on Launch";
const tasks = [
  { id: "T1", title: "Post the background launch", branch: "e2e/t1", prompt: "Post the background launch.", agent: "codex", agentReason: "UI work suits Codex" },
  { id: "T2", title: "Report the outcome", branch: "e2e/t2", prompt: "Report the outcome.", agent: "claude", agentReason: "Server work suits Claude" },
];

function readyPlan(overrides: Record<string, unknown> = {}) {
  return {
    planId: "plan-launch", repositoryId: "repo-e2e", repositoryName: "cmux-e2e-cypress", goal: GOAL,
    status: "draft", stage: "ready", round: 2, taskCount: tasks.length, launchedCount: 0, readyCount: 0,
    boardState: "needs_you", createdAt: now, updatedAt: now, launchedAt: null,
    ...overrides,
  };
}

function planDetail(overrides: Record<string, unknown> = {}) {
  return { ...readyPlan(overrides), planStatus: "draft", questions: [], tasks, events: [] };
}

type Scenario = { plans: Array<Record<string, unknown>>; detail: Record<string, unknown> };

function installScenario(state: Scenario) {
  const dashboard = () => ({
    generatedAt: now, github: { checkedAt: now, status: "ready" },
    summary: { repositories: 1, worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 },
    repositories: [repository], orphanSessions: [],
  });

  // Registered first so the explicit routes below win Cypress's reverse-order
  // matching. Any missing fixture fails closed instead of escaping through
  // Vite's proxy to the installed Companion.
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [], error: null, refreshedAt: now });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/github-issues*", { syncedAt: null, issues: [] });
  cy.intercept("GET", "**/api/goals/capacity*", { providers: [], next: null, reason: "Local fixture", nextReset: null, available: false });
  cy.intercept("GET", "**/api/goals/health", { checkedAt: now, sessionsAvailable: true, goals: [], summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0, deadTasks: 0, idleTasks: 0, failedTasks: 0 } });
  cy.intercept("GET", "**/api/worktree-dashboard*", (request) => request.reply(dashboard())).as("dashboard");
  cy.intercept("GET", "**/api/worktree-plans/plan-launch", (request) => request.reply(state.detail)).as("detail");
  cy.intercept("GET", "**/api/worktree-plans*", (request) => request.reply({ plans: state.plans })).as("plans");
}

function visitBoard() {
  cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); } });
  cy.wait(["@dashboard", "@plans"]);
  cy.findByRole("region", { name: "Goals board" }).should("be.visible");
}

function openTheGoalSheet() {
  cy.findByRole("region", { name: "Needs you" }).findByRole("button", { name: `Resume ${GOAL}` }).click();
  cy.wait("@detail");
  cy.findByRole("dialog", { name: "Plan a goal" }).should("be.visible");
}

describe("continuing saved discovery and observing existing delivery", () => {
  it("offers one continuation action for an unlaunched historical plan", () => {
    const state: Scenario = { plans: [readyPlan()], detail: planDetail() }; installScenario(state); visitBoard(); openTheGoalSheet();
    cy.findByRole("button", { name: "Continue discovery" }).should("be.enabled");
    cy.findByRole("button", { name: "Launch 2 sessions" }).should("not.exist");
    cy.findByRole("button", { name: "Plan this goal" }).should("not.exist");
  });

  it("stops saying launching once the launch settles", () => {
    const state: Scenario = { plans: [readyPlan({ launching: true })], detail: planDetail({ launching: true }) };
    installScenario(state);
    visitBoard();

    cy.findByRole("region", { name: "Needs you" }).should("contain.text", "Creating worktrees and starting sessions…");

    cy.then(() => {
      state.plans = [readyPlan({ status: "launched", launchedCount: 2, launchedAt: now, deliveryStatus: "implementing", boardState: "building" })];
    });
    cy.openBoardTools();
    cy.findByRole("button", { name: "Refresh GitHub" }).click();
    cy.wait("@plans");

    cy.findByRole("region", { name: "Building" }).should("contain.text", GOAL);
    cy.findByRole("region", { name: "Needs you" }).should("not.contain.text", "Creating worktrees and starting sessions…");
  });

  it("keeps the sheet open and reports the reason when a launch is refused", () => {
    const state: Scenario = { plans: [readyPlan()], detail: planDetail() };
    installScenario(state);
    cy.intercept("POST", "**/api/goal-sessions/plan-launch/continue", { statusCode: 409, body: { error: "This goal is launching right now. Wait for the launch to finish" } }).as("launch");
    visitBoard();
    openTheGoalSheet();

    cy.findByRole("dialog", { name: "Plan a goal" }).within(() => {
      cy.findByRole("button", { name: "Continue discovery" }).click();
    });

    cy.wait("@launch");
    cy.findByRole("dialog", { name: "Plan a goal" }).should("be.visible")
      .and("contain.text", "This goal is launching right now. Wait for the launch to finish");
  });
});

export {};
