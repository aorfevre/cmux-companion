import { DEFAULT_MODEL_ROLES } from "../../server/model-options.mjs";

const now = "2026-09-08T09:00:00.000Z";

// The paired home uses disposable monitoring fixtures; the pair screen itself only
// needs auth/status. Every other route stays a loud 501.
function pairedHome() {
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "Pairing Mac" }, workspaces: [], error: null, refreshedAt: now }).as("bootstrap");
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/github-issues", { syncedAt: null, issues: [] });
  cy.intercept("GET", "**/api/goals/capacity*", { providers: [], next: null, reason: "Local fixture", nextReset: null, available: false });
  cy.intercept("GET", "**/api/goals/health", { sessionsAvailable: true, goals: [], summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0 } });
  cy.intercept("GET", "**/api/goals/sessions/retirable*", { sessionsAvailable: true, closed: [], kept: [], failed: [] });
  cy.intercept("GET", "**/api/worktree-plans*", { plans: [] });
  cy.intercept("GET", "**/api/settings/models", { roles: DEFAULT_MODEL_ROLES, defaults: DEFAULT_MODEL_ROLES, warning: null });
  cy.intercept("GET", "**/api/worktree-dashboard*", {
    generatedAt: now, github: { status: "ready" },
    summary: { repositories: 0, worktrees: 0, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 }, repositories: [], orphanSessions: [],
  });
}

function fixtures(paired: boolean) {
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired }).as("authStatus");
  pairedHome();
}

for (const [width, height] of [[390, 844], [1440, 900]]) {
  describe(`Pairing at ${width}px`, () => {
    beforeEach(() => cy.viewport(width, height));

    it("shows the pair screen for an unpaired browser and never loads the paired home", () => {
      fixtures(false);
      cy.visit("/?view=sessions");
      cy.wait("@authStatus");
      cy.findByRole("heading", { name: "Pair this device." }).should("be.visible");
      cy.contains("Enter the private pairing code shown by the installer on your Mac.").should("be.visible");
      cy.findByPlaceholderText("Pairing code").should("have.attr", "type", "password");
      cy.findByRole("button", { name: "Pair securely" }).should("be.disabled");
      cy.findByRole("navigation", { name: "Main navigation" }).should("not.exist");
      cy.get("@bootstrap.all").should("have.length", 0);
    });

    it("pairs with a trimmed token and lands on the sessions home", () => {
      fixtures(false);
      cy.intercept("POST", "**/api/auth/pair", { paired: true, identity: null }).as("pair");
      cy.visit("/?view=sessions");
      cy.findByPlaceholderText("Pairing code").type("   fixture-pairing-code-0123456789abcdef   ");
      cy.findByRole("button", { name: "Pair securely" }).should("be.enabled").click();
      cy.wait("@pair").its("request.body").should("deep.equal", { token: "fixture-pairing-code-0123456789abcdef" });
      cy.wait("@bootstrap");
      cy.findByRole("link", { name: "Mission Control" }).should("have.attr", "href", "/orchestration");
      cy.findByRole("navigation", { name: "Main navigation" }).should("be.visible");
      cy.contains("Pairing Mac").should("be.visible");
      cy.findByPlaceholderText("Pairing code").should("not.exist");
    });
  });
}

describe("Pairing failures and offline", () => {
  beforeEach(() => cy.viewport(390, 844));

  it("keeps the typed code and reports a rejected pairing code", () => {
    fixtures(false);
    cy.intercept("POST", "**/api/auth/pair", { statusCode: 401, body: { error: "That pairing code is not valid", code: "INVALID_TOKEN" } }).as("pair");
    cy.visit("/?view=sessions");
    cy.findByPlaceholderText("Pairing code").type("wrong-code");
    cy.findByRole("button", { name: "Pair securely" }).click();
    cy.wait("@pair");
    cy.get(".form-error").should("be.visible").and("have.text", "That pairing code is not valid");
    cy.findByPlaceholderText("Pairing code").should("have.value", "wrong-code");
    cy.findByRole("heading", { name: "Pair this device." }).should("be.visible");
    cy.get("@bootstrap.all").should("have.length", 0);
  });

  it("reports rate limiting and origin rejection with the server's message", () => {
    fixtures(false);
    cy.intercept("POST", "**/api/auth/pair", { statusCode: 429, body: { error: "Too many pairing attempts. Try again later.", code: "PAIR_RATE_LIMIT" } }).as("limited");
    cy.visit("/?view=sessions");
    cy.findByPlaceholderText("Pairing code").type("any-code");
    cy.findByRole("button", { name: "Pair securely" }).click();
    cy.wait("@limited");
    cy.get(".form-error").should("have.text", "Too many pairing attempts. Try again later.");
    cy.intercept("POST", "**/api/auth/pair", { statusCode: 403, body: { error: "Origin rejected", code: "BAD_ORIGIN" } }).as("rejected");
    cy.findByRole("button", { name: "Pair securely" }).click();
    cy.wait("@rejected");
    cy.get(".form-error").should("have.text", "Origin rejected");
    cy.findByPlaceholderText("Pairing code").should("have.value", "any-code");
  });

  it("falls back to a generic message when the pairing reply is not JSON", () => {
    fixtures(false);
    cy.intercept("POST", "**/api/auth/pair", { statusCode: 502, headers: { "content-type": "text/html" }, body: "<h1>Bad gateway</h1>" }).as("pair");
    cy.visit("/?view=sessions");
    cy.findByPlaceholderText("Pairing code").type("some-code");
    cy.findByRole("button", { name: "Pair securely" }).click();
    cy.wait("@pair");
    cy.get(".form-error").should("have.text", "Request failed (502)");
  });

  it("shows the offline screen when the companion is unreachable and recovers on retry", () => {
    cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
    cy.intercept("GET", "**/api/auth/status", { forceNetworkError: true }).as("offlineStatus");
    pairedHome();
    cy.visit("/?view=sessions");
    cy.wait("@offlineStatus");
    cy.findByRole("heading", { name: "Your companion is offline." }).should("be.visible");
    cy.contains("Connect to Tailscale and reload this page.").should("be.visible");
    cy.findByPlaceholderText("Pairing code").should("not.exist");
    cy.get("@bootstrap.all").should("have.length", 0);
    cy.intercept("GET", "**/api/auth/status", { paired: true }).as("onlineStatus");
    cy.findByRole("button", { name: "Try again" }).click();
    cy.wait("@onlineStatus");
    cy.findByRole("link", { name: "Mission Control" }).should("have.attr", "href", "/orchestration");
  });

  it("unpairs from Settings and returns to the pair screen without reloading", () => {
    fixtures(true);
    cy.intercept("POST", "**/api/auth/logout", { paired: false }).as("logout");
    cy.intercept("GET", "**/api/auth/status", { paired: false });
    cy.intercept("GET", "**/api/orchestration/*", { statusCode: 401, body: { error: "Pair this device" } });
    cy.visit("/settings#general");
    cy.wait("@bootstrap");
    cy.findByRole("heading", { name: "Setup" }).should("be.visible");
    cy.findByRole("button", { name: "Unpair this device" }).click();
    cy.wait("@logout").its("request.body").should("deep.equal", {});
    cy.findByRole("heading", { name: "Pair this device" }).should("be.visible");
    cy.findByRole("navigation", { name: "Main navigation" }).should("be.visible");
    cy.findByLabelText("Pairing code").should("have.value", "");
  });
});

export {};
