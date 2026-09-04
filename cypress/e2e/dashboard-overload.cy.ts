const now = "2026-09-04T10:00:00.000Z";
const TIMEOUT_MESSAGE = "The worktree scan did not finish in time. This Mac may be overloaded.";

const repository = {
  id: "repo-overload", name: "cmux-e2e-cypress", root: "karven", path: "/Users/test/Developers/karven/cmux-e2e-cypress",
  pullRequestsAvailable: true,
  summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 },
  worktrees: [{
    id: "worktree-overload", repoId: "repo-overload", path: "/Users/test/Developers/karven/cmux-e2e-cypress",
    name: "cmux-e2e-cypress", branch: "main", isPrimary: true, detached: false, ahead: 0, behind: 0,
    changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" },
  }],
  releases: [],
};

const goalPlan = {
  planId: "goal-overload", repositoryId: "repo-overload", repositoryName: "cmux-e2e-cypress",
  goal: "Survive an overloaded Mac", status: "launched", stage: "ready", round: 1,
  taskCount: 1, launchedCount: 1, readyCount: 0, agentSplit: { claude: 1, codex: 0 },
  workspaceIds: [] as string[], deliveryStatus: "implementing", boardState: "dev_in_progress",
  createdAt: now, updatedAt: now, launchedAt: now,
};

function dashboardBody(sessions: number) {
  return {
    generatedAt: now, github: { checkedAt: now, status: "ready" },
    summary: { repositories: 1, worktrees: 1, releases: 0, sessions, needsYou: 0, working: sessions, dirty: 0, pullRequests: 0 },
    repositories: [{ ...repository, summary: { ...repository.summary, sessions, working: sessions } }],
    orphanSessions: [],
  };
}

// Registered first so the explicit routes below win Cypress's reverse-order
// matching. Any missing fixture fails closed instead of escaping through
// Vite's proxy to the installed Companion.
function installBaseFixtures() {
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/goals/capacity*", { providers: [], next: null, reason: "Local fixture", nextReset: null, available: false });
  cy.intercept("GET", "**/api/goals/health", {
    checkedAt: now, sessionsAvailable: true, goals: [],
    summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0, deadTasks: 0, idleTasks: 0, failedTasks: 0 },
  }).as("health");
  cy.intercept("GET", "**/api/worktree-plans*", { plans: [goalPlan] }).as("plans");
}

function visitBoard() {
  cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); } });
}

describe("the board survives an overloaded Mac", () => {
  it("names the overload instead of showing an empty board for ever", () => {
    installBaseFixtures();
    cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [], error: null, refreshedAt: now });
    // This is what the companion now returns when the worktree scan runs out
    // of time. Before the deadline the request never answered, and the board
    // stayed blank with every count on zero.
    cy.intercept("GET", "**/api/worktree-dashboard*", { statusCode: 503, body: { error: TIMEOUT_MESSAGE, code: "DASHBOARD_TIMEOUT" } }).as("dashboardTimeout");
    visitBoard();
    cy.wait("@dashboardTimeout");

    cy.contains(TIMEOUT_MESSAGE).should("be.visible");
    cy.findByRole("button", { name: "Retry" }).should("be.visible");
  });

  it("recovers the whole board when the retry succeeds", () => {
    installBaseFixtures();
    cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [], error: null, refreshedAt: now });
    let overloaded = true;
    cy.intercept("GET", "**/api/worktree-dashboard*", (request) => {
      if (overloaded) return request.reply({ statusCode: 503, body: { error: TIMEOUT_MESSAGE, code: "DASHBOARD_TIMEOUT" } });
      return request.reply(dashboardBody(1));
    }).as("dashboard");
    visitBoard();
    cy.wait("@dashboard");
    cy.contains(TIMEOUT_MESSAGE).should("be.visible");

    cy.then(() => { overloaded = false; });
    cy.findByRole("button", { name: "Retry" }).click();
    cy.wait("@dashboard");

    cy.contains(TIMEOUT_MESSAGE).should("not.exist");
    cy.findByRole("region", { name: "Goals board" }).should("contain.text", "Survive an overloaded Mac");
    cy.findByLabelText("1 live cmux sessions").should("exist");
  });

  it("still draws every goal when cmux stalls and the board loses only its session badges", () => {
    installBaseFixtures();
    // A stalled cmux is what the companion now answers as "Waiting for cmux"
    // rather than holding the request open. The dashboard still arrives, with
    // no live sessions attached to it.
    cy.intercept("GET", "**/api/bootstrap", { connected: false, host: null, workspaces: [], error: "Waiting for cmux", refreshedAt: now });
    cy.intercept("GET", "**/api/worktree-dashboard*", dashboardBody(0)).as("dashboard");
    visitBoard();
    cy.wait("@dashboard");

    cy.findByRole("region", { name: "Goals board" }).should("contain.text", "Survive an overloaded Mac");
    cy.findByLabelText("0 live cmux sessions").should("exist");
    cy.contains("Waiting for cmux").should("be.visible");
  });
});

export {};
