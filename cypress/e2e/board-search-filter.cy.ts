// The board search box narrows every column of the Kanban, including the
// GitHub Issues column. One query, one board: the header count, the issue
// cards and the goal cards must never disagree with each other.

const now = "2026-09-03T12:00:00.000Z";

const starred = {
  id: "repositoryStarred01", name: "trust-layer", root: "karven", path: "/Users/test/Developers/karven/trust-layer",
  favorite: true, pullRequestsAvailable: true,
  summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 },
  worktrees: [{ id: "worktree-starred", repoId: "repositoryStarred01", path: "/Users/test/Developers/karven/trust-layer", name: "trust-layer", branch: "main", isPrimary: true, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }],
  releases: [],
};

// Three issues with distinct titles, one distinct label each, and distinct
// numbers. Every assertion below can therefore name exactly one card.
const issues = [
  { repositoryId: starred.id, repositoryName: starred.name, number: 12, title: "Restore the caret", labels: ["editor"], url: "https://github.test/acme/trust-layer/issues/12", updatedAt: now, syncedAt: now, planId: null },
  { repositoryId: starred.id, repositoryName: starred.name, number: 31, title: "Speed up the indexer", labels: ["performance"], url: "https://github.test/acme/trust-layer/issues/31", updatedAt: now, syncedAt: now, planId: null },
  { repositoryId: starred.id, repositoryName: starred.name, number: 44, title: "Publish the changelog", labels: [], url: "https://github.test/acme/trust-layer/issues/44", updatedAt: now, syncedAt: now, planId: null },
];

// One goal card, so the same query can be proved to filter a goal column too.
const goalPlan = {
  planId: "plan-search", repositoryId: starred.id, repositoryName: starred.name, goal: "Ship the caret rewrite",
  status: "draft", stage: "ready", round: 1, taskCount: 1, createdAt: now, updatedAt: now, launchedAt: null,
  boardState: "waiting_for_dev",
};

function installBoard() {
  const dashboard = {
    generatedAt: now, github: { checkedAt: now, status: "ready" },
    summary: { repositories: 1, worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 },
    repositories: [starred], orphanSessions: [],
  };
  // Registered first so the explicit routes below win Cypress's reverse-order
  // matching. Any unfixtured call fails closed instead of reaching a real API.
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [], error: null, refreshedAt: now });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/goals/capacity*", { providers: [], next: null, reason: "Local fixture", nextReset: null, available: false });
  cy.intercept("GET", "**/api/goals/health", { checkedAt: now, sessionsAvailable: true, goals: [], summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0, deadTasks: 0, idleTasks: 0, failedTasks: 0 } }).as("health");
  cy.intercept("GET", "**/api/worktree-dashboard*", dashboard).as("dashboard");
  cy.intercept("GET", "**/api/worktree-plans*", { plans: [goalPlan] }).as("plans");
  cy.intercept("GET", "**/api/github-issues", { syncedAt: now, issues }).as("issues");
}

function visitBoard() {
  cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); } });
  cy.wait(["@dashboard", "@plans", "@health", "@issues"]);
  cy.findByRole("region", { name: "Goals board" }).should("be.visible");
}

const issueColumn = () => cy.findByRole("region", { name: "GitHub Issues" });
const search = () => cy.findByRole("searchbox", { name: "Search projects" });

describe("the board search filters the GitHub Issues column", () => {
  beforeEach(() => {
    installBoard();
    visitBoard();
    issueColumn().should("contain.text", "Restore the caret");
    issueColumn().findByLabelText("3 issues in GitHub Issues").should("exist");
  });

  it("leaves only the matching issue, and reads the filtered count", () => {
    search().type("caret");
    issueColumn().within(() => {
      cy.contains("Restore the caret").should("exist");
      cy.contains("Speed up the indexer").should("not.exist");
      cy.contains("Publish the changelog").should("not.exist");
      // The count comes from the rendered array, so it can never say 3 here.
      cy.findByLabelText("1 issue in GitHub Issues").should("exist");
      cy.get("article").should("have.length", 1);
    });

    // The same query narrows a goal column too, and clearing restores both.
    cy.findByRole("region", { name: "Waiting for dev" }).should("contain.text", "Ship the caret rewrite");
    search().clear().type("indexer");
    issueColumn().findByLabelText("1 issue in GitHub Issues").should("exist");
    cy.findByRole("region", { name: "Waiting for dev" }).should("not.contain.text", "Ship the caret rewrite");

    cy.findByRole("button", { name: "Clear the project search" }).click();
    issueColumn().findByLabelText("3 issues in GitHub Issues").should("exist");
    cy.findByRole("region", { name: "Waiting for dev" }).should("contain.text", "Ship the caret rewrite");
  });

  it("matches a label and an issue number typed with or without the hash", () => {
    search().type("performance");
    issueColumn().within(() => {
      cy.contains("Speed up the indexer").should("exist");
      cy.contains("Restore the caret").should("not.exist");
      cy.findByLabelText("1 issue in GitHub Issues").should("exist");
    });

    search().clear().type("44");
    issueColumn().within(() => {
      cy.contains("Publish the changelog").should("exist");
      cy.findByLabelText("1 issue in GitHub Issues").should("exist");
    });

    search().clear().type("#44");
    issueColumn().within(() => {
      cy.contains("Publish the changelog").should("exist");
      cy.findByLabelText("1 issue in GitHub Issues").should("exist");
    });
  });

  it("names the query when nothing matches, and its clear control restores every issue", () => {
    search().type("nothing-here");
    issueColumn().within(() => {
      cy.contains("No issue matches “nothing-here”").should("be.visible");
      cy.get("article").should("have.length", 0);
      cy.findByLabelText("0 issues in GitHub Issues").should("exist");
      cy.findByRole("button", { name: "Clear search" }).click();
    });

    search().should("have.value", "");
    issueColumn().within(() => {
      cy.contains("Restore the caret").should("exist");
      cy.contains("Speed up the indexer").should("exist");
      cy.contains("Publish the changelog").should("exist");
      cy.findByLabelText("3 issues in GitHub Issues").should("exist");
    });
  });
});

export {};
