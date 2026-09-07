import { DEFAULT_LAUNCHERS } from "../../server/provider-launchers.mjs";

const now = "2026-09-07T12:00:00Z";
const usage = {
  generatedAt: now, source: "CCS + Kimi Code", available: true,
  summary: { ready: 1, low: 0, exhausted: 0, reconnect: 0, unavailable: 0 },
  providers: [
    { id: "claude", label: "Claude Code", available: true, accounts: [] },
    { id: "codex", label: "OpenAI Codex", available: true, accounts: [] },
    { id: "kimi", label: "Kimi Code", available: true, accounts: [{ id: "kimi", label: "Kimi Code subscription", email: null, plan: "Subscription", isDefault: false, paused: false, status: "ready", message: null, updatedAt: now, windows: [
      { id: "weekly", category: "usage", cadence: "weekly", label: "Weekly", remainingPercent: 70, resetAt: "2026-09-10T14:07:00Z", reported: true },
      { id: "daily", category: "usage", cadence: "daily", label: "Daily limit", remainingPercent: 44, resetAt: null, reported: true },
    ] }] },
  ],
};
function setup() {
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing local fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [], refreshedAt: now });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [{ id: "repo-kimi", name: "Kimi fixture", path: "/fixture", root: "test", branch: "main", scripts: [] }] });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/settings/launchers", { providers: DEFAULT_LAUNCHERS.map((provider) => provider.id === "kimi" ? { ...provider, command: "xkimi" } : provider) }).as("launchers");
  cy.intercept("GET", "**/api/account-usage*", usage).as("usage");
}

describe("licence usage and provider commands", () => {
  for (const width of [390, 1440]) it(`shows Kimi quotas and configured launchers at ${width}px`, () => {
    setup(); cy.viewport(width, 900); cy.clock(new Date(now).getTime());
    cy.visit("/?view=usage"); cy.tick(1); cy.wait(["@usage", "@launchers"]);
    cy.contains("Kimi Code subscription").should("be.visible");
    cy.contains("70%").should("be.visible");
    cy.contains("44%").should("be.visible");
    cy.contains("Not reported").should("be.visible");
    cy.contains("Resets in 3d 2h 7m").should("be.visible");
    cy.contains("Provider launcher commands").click();
    cy.contains("code", "xclaude").should("be.visible");
    cy.contains("code", "xcodex").should("be.visible");
    cy.contains("code", "xkimi").should("be.visible");
    cy.document().then((doc) => expect(doc.documentElement.scrollWidth).to.be.at.most(width));
    cy.screenshot(`licence-providers-${width}`);
    cy.tick(60_000); cy.wait("@usage").its("request.url").should("not.include", "refresh=1");
    cy.findByRole("button", { name: "Refresh account usage" }).click();
    cy.wait("@usage").its("request.url").should("include", "refresh=1");
    cy.intercept("GET", "**/api/account-usage*", { statusCode: 503, body: { error: "Provider unavailable" } }).as("failedUsage");
    cy.findByRole("button", { name: "Refresh account usage" }).click(); cy.wait("@failedUsage");
    cy.contains("Refresh failed · showing previous usage").should("be.visible");
    cy.contains("70%").should("be.visible");
  });

  it("launches Kimi from an approved repository using the provider id", () => {
    setup();
    cy.intercept("POST", "**/api/workspaces", { statusCode: 201, body: { workspace: { workspace_id: "kimi-workspace" } } }).as("launch");
    cy.visit("/?view=launch");
    cy.contains("button", "Kimi fixture").click(); cy.wait("@launchers");
    cy.findByRole("button", { name: "Kimi (xkimi)" }).click();
    cy.findByLabelText("Initial task").type("Review this repository");
    cy.findByRole("button", { name: "Launch kimi" }).click();
    cy.wait("@launch").its("request.body").should((body) => {
      expect(body.agent).to.equal("kimi"); expect(body.prompt).to.equal("Review this repository");
      expect(body).not.to.have.property("command");
    });
  });
});
