import { DEFAULT_MODEL_ROLES } from "../../server/model-options.mjs";

const now = "2026-09-06T12:00:00Z";
const repo = {
  id: "repo-links", name: "Goal links", root: "karven", path: "/fixture", pullRequestsAvailable: true,
  summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 },
  worktrees: [{ id: "worktree-links", repoId: "repo-links", path: "/fixture", name: "Goal links", branch: "main", isPrimary: true, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }], releases: [],
};
const goals = [
  { planId: "goal-launched", repositoryId: repo.id, repositoryName: repo.name, goal: "Review the whole project", status: "launched", planStatus: "launched", stage: "ready", boardState: "dev_in_progress", round: 1, taskCount: 0, tasks: [], questions: [], createdAt: now, updatedAt: now, launchedAt: now },
  { planId: "goal-draft", repositoryId: repo.id, repositoryName: repo.name, goal: "Prepare another goal", status: "draft", planStatus: "draft", stage: "questions", boardState: "writing_spec", round: 1, taskCount: 0, tasks: [], questions: [{ id: "q1", text: "Which behavior should change?", options: ["Navigation", "Search"] }], createdAt: now, updatedAt: now, launchedAt: null },
];
function scenario(listed = true) {
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing local fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [], refreshedAt: now });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/github-issues*", { syncedAt: null, issues: [] });
  cy.intercept("GET", "**/api/goals/capacity*", { providers: [], next: null, available: false });
  cy.intercept("GET", "**/api/goals/health", { checkedAt: now, goals: [], summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0 } });
  cy.intercept("GET", "**/api/worktree-dashboard*", { generatedAt: now, github: { status: "ready" }, summary: { repositories: 1, ...repo.summary }, repositories: [repo], orphanSessions: [] });
  cy.intercept("GET", "**/api/settings/models", { roles: DEFAULT_MODEL_ROLES, defaults: DEFAULT_MODEL_ROLES, warning: null });
  cy.intercept("GET", "**/api/worktree-plans*", { plans: listed ? goals : [] });
  for (const goal of goals) cy.intercept("GET", `**/api/worktree-plans/${goal.planId}`, { ...goal, status: goal.stage }).as(goal.planId);
  cy.intercept("GET", "**/api/worktree-plans/missing", { statusCode: 404, body: { error: "Unknown plan. Start a new goal" } });
}
function visit(url = "/?mode=worktrees") { cy.visit(url); }
function sheet() { return cy.findByRole("dialog", { name: "Plan a goal" }); }
function close() { cy.findByRole("button", { name: "Close goal planner sheet" }).click(); cy.findByRole("dialog").should("not.exist"); }

describe("shareable goal popups", () => {
  it("puts a launched goal in the address bar, copies its reference, and restores it on reload and Back/Forward", () => {
    scenario(); visit();
    cy.findByRole("button", { name: "View Review the whole project" }).click();
    cy.location("search").should("contain", "plan=goal-launched");
    sheet().should("contain.text", "Saved discovery").and("contain.text", "goal-launched");
    cy.window().then((window) => { cy.stub(window.navigator.clipboard, "writeText").as("copyLink").resolves(); });
    cy.findByRole("button", { name: "Copy goal link" }).click();
    cy.get("@copyLink").should("have.been.calledOnce").then((stub) => {
      const url = new URL((stub as unknown as { firstCall: { args: string[] } }).firstCall.args[0]);
      expect(url.searchParams.get("plan")).to.equal("goal-launched");
      expect(url.searchParams.get("mode")).to.equal("worktrees");
    });
    cy.reload(); sheet().should("contain.text", "goal-launched");
    cy.go("back"); cy.findByRole("dialog").should("not.exist");
    cy.go("forward"); sheet().should("contain.text", "goal-launched");
    close(); cy.location("search").should("not.contain", "plan=");
    cy.findByRole("button", { name: "View Review the whole project" }).click();
    sheet().should("contain.text", "goal-launched");
  });

  it("opens a pasted draft link even outside the board list and with Sessions saved as home", () => {
    scenario(false);
    cy.visit("/?plan=goal-draft", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "sessions"); } });
    sheet().should("contain.text", "goal-draft").and("contain.text", "Which behavior should change?");
    cy.findByRole("button", { name: "Copy goal link" }).should("be.visible");
    close(); cy.location("search").should("not.contain", "plan=");
  });

  it("gives new-goal popups a repository URL, upgrades a saved goal, and clears it on close", () => {
    scenario(); visit();
    cy.findByRole("button", { name: "Plan a goal for Goal links" }).click();
    cy.location("search").should("contain", "newGoal=repo-links");
    cy.reload(); sheet().should("contain.text", "Goal links");
    cy.findByLabelText("Goal").type("Create a shareable goal");
    cy.intercept("POST", "**/api/goal-sessions", { statusCode: 202, body: { ...goals[1], planId: "goal-created", status: "questions", running: true } }).as("created");
    cy.intercept("GET", "**/api/worktree-plans/goal-created", { ...goals[1], planId: "goal-created", status: "questions", running: true });
    cy.findByRole("button", { name: "Start goal session" }).click(); cy.wait("@created");
    cy.findByRole("dialog").should("not.exist");
    cy.location("search").should("not.contain", "plan=").and("not.contain", "newGoal=");
    cy.go("forward");
    sheet().should("contain.text", "goal-created");
    cy.location("search").should("contain", "plan=goal-created");
  });

  it("switches from a saved goal to a new goal without leaving the previous ID in the URL", () => {
    scenario(); visit("/?plan=goal-draft");
    sheet().should("contain.text", "goal-draft");
    cy.findByRole("button", { name: "← New goal" }).click();
    cy.location("search").should("contain", "newGoal=repo-links").and("not.contain", "plan=");
    cy.findByLabelText("Goal").should("have.value", "");
    cy.reload(); cy.findByLabelText("Goal").should("have.value", "");
    close(); cy.location("search").should("not.contain", "newGoal=");
  });

  it("keeps polling a running goal while the board clock updates", () => {
    scenario(false);
    cy.intercept("GET", "**/api/worktree-plans/goal-draft", (request) => {
      request.reply({ ...goals[1], status: "questions", workflow: "goal_session", goalSessionState: "planning", running: false });
    }).as("runningGoal");
    visit("/?plan=goal-draft");
    cy.wait("@runningGoal");
    cy.findByRole("region", { name: "Goal session status" }).should("be.visible");
    cy.wait("@runningGoal", { timeout: 12000 });
    sheet().should("contain.text", "Goal conversation");
    cy.location("search").should("contain", "plan=goal-draft");
  });

  it("shows a missing goal error and lets a user close the link", () => {
    scenario(false); visit("/?plan=missing");
    cy.findByRole("dialog", { name: "Open goal" }).should("contain.text", "Goal unavailable");
    cy.findByRole("alert").should("contain.text", "Unknown plan");
    close(); cy.location("search").should("not.contain", "plan=");
  });
});
