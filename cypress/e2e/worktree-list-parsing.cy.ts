const now = "2026-09-06T10:00:00.000Z";
const branch = "feature/mobile";
const repository = {
  id: "repo-parsing", name: "cmux-e2e-cypress", root: "karven",
  path: "/Users/test/Developers/karven/cmux-e2e-cypress", pullRequestsAvailable: true,
  summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 },
  worktrees: [{
    id: "worktree-parsing", repoId: "repo-parsing",
    path: "/Users/test/Developers/karven/cmux-e2e-cypress-feature",
    name: "cmux-e2e-cypress-feature", branch, head: "abc", isPrimary: false, detached: false,
    locked: "Locked", ahead: 0, behind: 0, changedFiles: 0, dirty: false,
    lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" },
  }],
  releases: [],
};

describe("worktree list compatibility", () => {
  it("renders the branch and generic Locked indicator and blocks normal removal", () => {
    // Fail closed: no unhandled API request can reach the installed Companion.
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
    cy.intercept("GET", "**/api/goals/health", { sessionsAvailable: true, goals: [], summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0 } });
    cy.intercept("GET", "**/api/goals/sessions/retirable*", { sessionsAvailable: true, closed: [], kept: [], failed: [] });
    cy.intercept("GET", "**/api/worktree-plans*", { plans: [] });
    cy.intercept("GET", "**/api/worktree-dashboard*", {
      generatedAt: now, summary: { ...repository.summary, repositories: 1, pullRequests: 0 },
      repositories: [repository], orphanSessions: [],
    }).as("dashboard");
    cy.intercept("DELETE", "**/api/worktree-dashboard/*", { statusCode: 500, body: { error: "Locked worktree must not be removed" } }).as("remove");

    cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); } });
    cy.wait("@dashboard");
    cy.contains("summary", "Board tools").click();
    cy.findByRole("tab", { name: /^Inactive/ }).click();
    cy.contains(".worktree-card", branch).should("be.visible").within(() => {
      cy.get("header strong").should("have.text", branch);
      cy.contains(".worktree-facts span", /^Locked$/).should("be.visible");
      cy.findByRole("button", { name: /^Remove$/ }).should("not.exist");
      cy.findByLabelText(`Actions for ${branch}`).click();
      cy.findByRole("button", { name: "Remove worktree" }).should("be.disabled");
    });
    cy.get("@remove.all").should("have.length", 0);
  });
});

export {};
