const now = "2026-09-04T12:00:00.000Z";
const repository = {
  id: "repo-e2e", name: "cmux-e2e-cypress", root: "karven", path: "/Users/test/Developers/karven/cmux-e2e-cypress",
  pullRequestsAvailable: true,
  summary: { worktrees: 1, releases: 0, sessions: 3, needsYou: 0, working: 0, dirty: 0 },
  worktrees: [{ id: "worktree-e2e", repoId: "repo-e2e", path: "/Users/test/Developers/karven/cmux-e2e-cypress", name: "cmux-e2e-cypress", branch: "main", isPrimary: true, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }],
  releases: [],
};


const tasks = [
  { id: "T1 / blocked", title: "Blocked task", branch: "feature/blocked", agent: "codex", prompt: "Build", agentReason: "", wave: 1, launchStatus: "failed", launchReason: "running-session", launchError: "That branch already has a worktree with a running session", deliveryStatus: "pending", health: "failed", reason: "Branch is occupied", session: null, workspaceId: null },
  { id: "T2", title: "Sync failure", branch: "feature/sync", agent: "codex", prompt: "Build", agentReason: "", wave: 1, launchStatus: "failed", launchReason: "add-failure", deliveryStatus: "pending", health: "failed", reason: "Project sync failed", session: null, workspaceId: null },
];
const plan = { planId: "goal-retry", repositoryId: repository.id, repositoryName: repository.name, goal: "Recover blocked work", status: "launched", planStatus: "launched", stage: "ready", deliveryMode: "combined", deliveryStatus: "blocked", boardState: "stopped", round: 1, taskCount: 2, launchedCount: 0, createdAt: now, updatedAt: now, launchedAt: now, tasks, questions: [] };

describe("retry a blocked task on a fresh branch", () => {
  it("preserves the blocked branch, disables competing actions, and refreshes the effective branch", () => {
    let refreshed = false;
    let release: () => void = () => {};
    const currentTasks = () => tasks.map((task, index) => refreshed && index === 0 ? { ...task, branch: "feature/retry-2", launchStatus: "launched", launchReason: null, health: "idle", reason: "Agent is idle" } : task);
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

    cy.intercept("GET", "**/api/worktree-dashboard*", { generatedAt: now, summary: { ...repository.summary, repositories: 1 }, repositories: [repository], orphanSessions: [] }).as("dashboard");
    cy.intercept("GET", "**/api/worktree-plans?*", { plans: [plan] }).as("plans");
    cy.intercept("GET", "**/api/worktree-plans/goal-retry", (request) => request.reply({ ...plan, tasks: currentTasks() })).as("detail");
    cy.intercept("GET", "**/api/worktree-plans/goal-retry/health", (request) => request.reply({ tasks: currentTasks() }));
    cy.intercept("GET", "**/api/goals/health", (request) => request.reply({ sessionsAvailable: true, goals: [{ ...plan, tasks: currentTasks(), health: "failed", stuckCount: 2 }], summary: { goals: 1, tasks: 2, stuck: 1, needsYou: 0, working: 0 } })).as("health");
    cy.intercept("GET", "**/api/goals/sessions/retirable*", { sessionsAvailable: true, closed: [], kept: [], failed: [] });
    cy.intercept("POST", "**/api/worktree-plans/goal-retry/tasks/T1%20%2F%20blocked/relaunch", (request) => {
      expect(request.body).to.deep.equal({ mode: "rebranch", closeLive: false });
      return new Promise<void>((resolve) => { release = () => { refreshed = true; request.reply({ branch: "feature/retry-2" }); resolve(); }; });
    }).as("rebranch");
    cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); } });
    cy.wait(["@dashboard", "@plans", "@health"]);
    cy.findByRole("button", { name: "1 stuck goals. Show the tasks that need you" }).click();
    cy.findByRole("region", { name: "Goals needing attention" }).should("have.focus").within(() => {
      cy.contains("Retrying starts from the task’s base on a fresh branch and leaves the blocked branch untouched.").should("be.visible");
      cy.findByRole("button", { name: "Retry on new branch for Sync failure" }).should("not.exist");
      cy.findByRole("button", { name: "Retry on new branch for Blocked task" }).click().should("be.disabled").and("have.text", "Retrying on new branch…");
      for (const name of ["Continue Blocked task", "Restart Blocked task", "Skip Blocked task"]) cy.findByRole("button", { name }).should("be.disabled");
      cy.findByRole("button", { name: "Confirm restart Blocked task" }).should("not.exist");
    });
    cy.then(() => release());
    cy.wait(["@rebranch", "@detail", "@health", "@plans"]);
    cy.findByRole("region", { name: "Goals needing attention" }).within(() => {
      cy.contains("feature/retry-2").should("be.visible");
      cy.findByRole("button", { name: "Retry on new branch for Blocked task" }).should("not.exist");
    });
    cy.contains("Retried Blocked task on feature/retry-2").should("be.visible");
  });
});
export {};
