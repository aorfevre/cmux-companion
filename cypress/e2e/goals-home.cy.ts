const now = "2026-09-07T10:00:00.000Z";

function fixtures() {
  // Every API request stays local to these fixtures.
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [], error: null, refreshedAt: now });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/github-issues", { syncedAt: null, issues: [] });
  cy.intercept("GET", "**/api/goals/capacity*", { providers: [], next: null, reason: "Local fixture", nextReset: null, available: false });
  cy.intercept("GET", "**/api/goals/health", { sessionsAvailable: true, goals: [], summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0 } });
  cy.intercept("GET", "**/api/goals/sessions/retirable*", { sessionsAvailable: true, closed: [], kept: [], failed: [] });
  cy.intercept("GET", "**/api/worktree-plans*", { plans: [] });
  cy.intercept("GET", "**/api/worktree-dashboard*", {
    generatedAt: now, github: { status: "ready" },
    summary: { repositories: 0, worktrees: 0, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 }, repositories: [], orphanSessions: [],
  });
}

for (const [width, height] of [[390, 844], [1440, 900]]) {
  describe(`Goals home at ${width}px`, () => {
    beforeEach(() => { cy.viewport(width, height); fixtures(); });

    it("lands on Goals despite a previous session preference and resets secondary views from navigation", () => {
      cy.visit("/", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "sessions"); } });
      cy.findByRole("heading", { name: "Goals board" }).should("be.visible");
      cy.findByRole("region", { name: "Goals board" }).should("be.visible");
      cy.findByRole("navigation", { name: "Main navigation" }).within(() => {
        cy.findAllByRole("button").should("have.length", 3);
        cy.findByRole("button", { name: "Goals" }).should("have.class", "active");
        cy.findByRole("button", { name: "Licence Usage" }).should("be.visible");
        cy.findByRole("button", { name: "Settings" }).should("be.visible");
      });
      cy.get('.worktree-filter-tabs').should("not.be.visible");
      cy.contains("summary", "Board tools").click();
      cy.findByRole("tab", { name: /^Inactive/ }).click();
      cy.findByRole("region", { name: "Goals board" }).should("not.exist");
      cy.findByRole("button", { name: "Goals", exact: true }).click();
      cy.findByRole("region", { name: "Goals board" }).should("be.visible");
      cy.get('.worktree-filter-tabs').should("not.be.visible");
      cy.contains("summary", "Tools").click();
      cy.findByRole("navigation", { name: "Dashboard tools" }).within(() => {
        cy.findByRole("button", { name: "Local apps" }).should("be.visible");
        cy.findByRole("button", { name: "Sessions" }).click();
      });
      cy.findByRole("heading", { name: "Sessions", exact: true }).should("be.visible");
      cy.findByRole("button", { name: "Goals", exact: true }).click();
      cy.findByRole("region", { name: "Goals board" }).should("be.visible");
      cy.reload();
      cy.findByRole("region", { name: "Goals board" }).should("be.visible");
    });

    it("preserves explicit session links and returns to Goals", () => {
      cy.visit("/?mode=sessions");
      cy.findByRole("heading", { name: "Sessions", exact: true }).should("be.visible");
      cy.findByRole("region", { name: "Goals board" }).should("not.exist");
      cy.findByRole("button", { name: "Goals", exact: true }).click();
      cy.findByRole("region", { name: "Goals board" }).should("be.visible");
    });
  });
}

export {};
