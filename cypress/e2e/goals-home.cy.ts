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

for (const [width, height] of [[390, 844], [1100, 760], [1440, 900]]) {
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
      cy.findByRole("region", { name: "Goals needing attention" }).should("contain.text", "No goal tasks need your attention.");
      cy.get('.worktree-filter-tabs').should("not.be.visible");
      cy.contains("summary", "Board tools").click();
      cy.findByRole("tab", { name: /^Inactive/ }).click();
      cy.findByRole("region", { name: "Goals board" }).should("not.exist");
      cy.findByRole("button", { name: "Goals" }).click();
      cy.findByRole("region", { name: "Goals board" }).should("be.visible");
      cy.get('.worktree-filter-tabs').should("not.be.visible");
      cy.contains("summary", "Tools").click();
      cy.findByRole("navigation", { name: "Dashboard tools" }).within(() => {
        cy.findByRole("button", { name: "Local apps" }).should("be.visible");
        cy.findByRole("button", { name: "Sessions" }).click();
      });
      cy.findByRole("heading", { name: "Sessions", level: 1 }).should("be.visible");
      cy.findByRole("button", { name: "Goals" }).click();
      cy.findByRole("region", { name: "Goals board" }).should("be.visible");
      cy.reload();
      cy.findByRole("region", { name: "Goals board" }).should("be.visible");
    });

    it("shows weekly opportunities on the collapsed board and groups account limits", () => {
      const observed = new Date().toISOString();
      const resetAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
      const weekly = { cadence: "weekly", label: "Weekly limit", remainingPercent: 60, resetAt };
      cy.intercept("GET", "**/api/goals/capacity*", {
        available: true, next: "claude", state: "eligible", reason: "Claude has the most reported headroom.", nextReset: resetAt,
        providers: [{ id: "claude", label: "Claude", available: true, headroom: 45, bestPercent: 45,
          accounts: [{ id: "work", label: "Work account", status: "ready", eligibility: "eligible", headroom: 45, updatedAt: observed,
            windows: [weekly, { cadence: "5h", label: "Session limit", remainingPercent: 45, resetAt }], opportunity: weekly },
          { id: "personal", label: "Personal account", status: "ready", paused: true, eligibility: "paused", headroom: 80, windows: [weekly] }] }],
      }).as("quota");
      cy.visit("/?view=sessions");
      cy.wait("@quota");
      cy.findByRole("region", { name: "Weekly reset opportunities" }).should("be.visible")
        .and("contain.text", "Claude · Work account").and("contain.text", "60% weekly remaining").and("contain.text", "45% short-window remaining");
      cy.findByRole("region", { name: "Weekly reset opportunities" }).screenshot(`weekly-opportunity-${width}`, { scale: true });
      cy.findByRole("region", { name: "Agent capacity" }).should("not.exist");
      cy.findByRole("button", { name: /Show agent capacity/ }).click();
      cy.findByRole("region", { name: "Claude Work account" }).should("contain.text", "Weekly limit");
      cy.findByRole("region", { name: "Claude Personal account" }).should("contain.text", "Paused");
      cy.findByRole("region", { name: "Agent capacity" }).should("contain.text", "Goal sessions keep their selected engine");
      cy.findByRole("button", { name: "Refresh quota" }).click();
      cy.wait("@quota").its("request.url").should("include", "refresh=1");
      cy.document().then((doc) => { expect(doc.documentElement.scrollWidth).to.be.at.most(width); });
      cy.findByRole("region", { name: "Agent capacity" }).then(($panel) => {
        expect($panel[0].getBoundingClientRect().right).to.be.at.most(width);
      });
      cy.findByRole("region", { name: "Agent capacity" }).screenshot(`account-capacity-${width}`, { scale: true });
      cy.intercept("GET", "**/api/account-usage*", { generatedAt: observed, summary: {}, providers: [] });
      cy.findByRole("region", { name: "Weekly reset opportunities" }).within(() => cy.findByRole("button", { name: "All account usage" }).click());
      cy.findByRole("heading", { name: "Licence usage" }).should("be.visible");
      cy.location("search").should("eq", "?view=usage");
    });

    it("distinguishes missing quota from exhaustion", () => {
      cy.visit("/");
      cy.findByRole("button", { name: /Quota unknown/ }).should("be.visible");
      cy.contains("Both exhausted").should("not.exist");
    });

    it("reports unavailable goal attention without claiming everything is clear", () => {
      cy.intercept("GET", "**/api/goals/health", { statusCode: 503, body: { error: "Goal supervision unavailable" } });
      cy.visit("/");
      cy.findByRole("region", { name: "Goals needing attention" }).should("contain.text", "Goal attention could not be fully checked.")
        .and("not.contain.text", "No goal tasks need your attention.");
    });

    it("preserves explicit session links and returns to Goals", () => {
      cy.visit("/?mode=sessions");
      cy.findByRole("heading", { name: "Sessions", level: 1 }).should("be.visible");
      cy.findByRole("region", { name: "Goals board" }).should("not.exist");
      cy.findByRole("button", { name: "Goals" }).click();
      cy.findByRole("region", { name: "Goals board" }).should("be.visible");
    });
  });
}

export {};
