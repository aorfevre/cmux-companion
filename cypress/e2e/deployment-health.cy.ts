// Deployment health on Settings and the header's "Updated" stamp: what each
// updater state looks like (healthy, updating, failed, paused, stale process,
// unavailable) and how the card recovers from a failed read. The clock is
// frozen so relative times are stable.
import { DEFAULT_MODEL_ROLES } from "../../server/model-options.mjs";

const frozenNow = new Date("2026-09-08T12:00:00.000Z");
const iso = (offsetMinutes: number) => new Date(frozenNow.getTime() + offsetMinutes * 60_000).toISOString();
const CURRENT = "1234567abcdef0000000000000000000000000ab";
const REMOTE = "89abcdef1111111111111111111111111111111c";
const UPDATER = "fedcba9876543210000000000000000000000000";

type Service = { runningSha?: string | null; deployedSha: string | null; observedRemoteSha: string | null; pendingSha?: string | null; quarantinedSha: string | null; alive: boolean; processRunning?: boolean; enabled?: boolean; healthy: boolean; status: "current" | "updating" | "behind" | "problem" | "unknown" | "paused" };

function status(overrides: { summary: "healthy" | "updating" | "attention" | "paused"; phase?: string; lastError?: string | null; lastSuccessAt?: string | null; companion?: Partial<Service>; updater?: Partial<Service> }) {
  const companion: Service = { runningSha: CURRENT, deployedSha: CURRENT, observedRemoteSha: CURRENT, pendingSha: null, quarantinedSha: null, alive: true, healthy: true, status: "current", ...overrides.companion };
  const updater: Service = { deployedSha: UPDATER, observedRemoteSha: UPDATER, quarantinedSha: null, alive: true, processRunning: true, enabled: true, healthy: true, status: "current", ...overrides.updater };
  return { available: true, enabled: updater.enabled !== false, deployedSha: companion.deployedSha, observedRemoteSha: companion.observedRemoteSha, pendingSha: companion.pendingSha || null, phase: overrides.phase || "idle",
    lastCheckAt: iso(-3), lastSuccessAt: overrides.lastSuccessAt === undefined ? iso(-125) : overrides.lastSuccessAt, lastFailureAt: overrides.lastError ? iso(-3) : null, lastError: overrides.lastError || null, restartExpected: false,
    summary: overrides.summary, services: { companion, updater } };
}

function scenario() {
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/settings/local", { statusCode: 404, body: { error: "Legacy settings" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [], error: null, refreshedAt: iso(0) });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
  cy.intercept("GET", "**/api/settings/models", { roles: DEFAULT_MODEL_ROLES, defaults: DEFAULT_MODEL_ROLES, warning: null });
  cy.intercept("GET", "**/api/push/status*", { supported: false, subscribed: false });
  cy.intercept("GET", "**/api/health", { ok: true, service: "cmux-companion", now: iso(0), version: { gitSha: CURRENT, builtAt: iso(-60 * 26) } }).as("health");
}

function visitSettings() {
  cy.clock(frozenNow.getTime(), ["Date"]);
  cy.visit("/settings#advanced");
  cy.findByRole("heading", { name: /^Settings$/ }).should("be.visible");
}

function card() { return cy.findByRole("region", { name: "Deployment health" }); }

describe("deployment health", () => {
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    it(`shows both services current with their versions, phase and timestamps at ${width}px`, () => {
      cy.viewport(width, height);
      scenario();
      cy.intercept("GET", "**/api/updater/status", status({ summary: "healthy" })).as("updater");
      visitSettings();
      cy.wait("@updater");
      card().should("have.class", "healthy").within(() => {
        cy.findByRole("status").should("have.text", "Both services healthy");
        cy.contains(".deployment-service", "cmux companion updater").should("have.class", "current").and("contain.text", "Deployed").and("contain.text", "fedcba9").and("contain.text", "Current");
        cy.contains(".deployment-service", /^cmux companion(?! updater)/).should("contain.text", "Running").and("contain.text", "1234567");
        cy.get("code").first().should("have.attr", "title", CURRENT);
        cy.contains("Phase").should("contain.text", "idle");
        cy.contains("Last check").find("time").should("have.attr", "dateTime", iso(-3));
        cy.contains("Last success").find("time").should("have.attr", "dateTime", iso(-125));
        cy.get(".deployment-error").should("not.exist");
      });
      // The header stamp prefers the updater's last successful rollout.
      cy.get("header.settings-header .last-update").should("have.text", "Updated 2h ago").and("have.attr", "dateTime", iso(-125));
      cy.document().then((doc) => expect(doc.documentElement.scrollWidth).to.be.at.most(width));
    });
  }

  it("reports an update in progress with the pending version", () => {
    cy.viewport(390, 844);
    scenario();
    cy.intercept("GET", "**/api/updater/status", status({ summary: "updating", phase: "building", companion: { observedRemoteSha: REMOTE, pendingSha: REMOTE, healthy: false, status: "updating" } })).as("updater");
    visitSettings();
    cy.wait("@updater");
    card().should("have.class", "updating").within(() => {
      cy.findByRole("status").should("have.text", "Update in progress");
      cy.contains(".deployment-service", /^cmux companion(?! updater)/).should("have.class", "updating").and("contain.text", "Updating");
      cy.contains(".deployment-service", "cmux companion updater").should("contain.text", "Current");
      cy.contains("Phase").should("contain.text", "building");
    });
  });

  it("surfaces a failed rollout with its error and the quarantined version", () => {
    cy.viewport(390, 844);
    scenario();
    cy.intercept("GET", "**/api/updater/status", status({ summary: "attention", phase: "failed", lastError: "Health check failed on 89abcde: /api/health returned 503", companion: { observedRemoteSha: REMOTE, quarantinedSha: REMOTE, healthy: false, status: "problem" } })).as("updater");
    visitSettings();
    cy.wait("@updater");
    card().should("have.class", "attention").within(() => {
      cy.findByRole("status").should("have.text", "Attention needed");
      cy.contains(".deployment-service", /^cmux companion(?! updater)/).should("have.class", "problem").and("contain.text", "Problem");
      cy.contains("Phase").should("contain.text", "failed");
      cy.get(".deployment-error").should("have.text", "Health check failed on 89abcde: /api/health returned 503");
    });
  });

  it("shows automatic updates as paused when the updater is disabled and names a stale updater process", () => {
    cy.viewport(390, 844);
    scenario();
    let paused = true;
    cy.intercept("GET", "**/api/updater/status", (request) => request.reply(paused
      ? status({ summary: "paused", updater: { enabled: false, healthy: false, status: "paused" } })
      : status({ summary: "attention", updater: { alive: false, processRunning: false, healthy: false, status: "unknown" }, companion: { observedRemoteSha: REMOTE, healthy: false, status: "behind" } }))).as("updater");
    visitSettings();
    cy.wait("@updater");
    card().should("have.class", "paused").within(() => {
      cy.findByRole("status").should("have.text", "Automatic updates paused");
      cy.contains(".deployment-service", "cmux companion updater").should("have.class", "paused").and("contain.text", "Paused");
    });
    cy.then(() => { paused = false; });
    cy.findByRole("button", { name: "Refresh deployment health" }).click();
    cy.wait("@updater");
    card().should("have.class", "attention").within(() => {
      cy.findByRole("status").should("have.text", "Attention needed");
      cy.contains(".deployment-service", "cmux companion updater").should("have.class", "unknown").and("contain.text", "process not running").and("contain.text", "Unknown");
      cy.contains(".deployment-service", /^cmux companion(?! updater)/).should("have.class", "behind").and("contain.text", "Behind");
    });
  });

  it("falls back to the build stamp when the updater is not installed and recovers after a failed read", () => {
    cy.viewport(390, 844);
    scenario();
    let mode: "missing" | "error" | "ok" = "missing";
    cy.intercept("GET", "**/api/updater/status", (request) => {
      if (mode === "missing") request.reply({ available: false });
      else if (mode === "error") request.reply({ statusCode: 500, body: { error: "Unexpected companion error" } });
      else request.reply(status({ summary: "healthy", lastSuccessAt: iso(-10) }));
    }).as("updater");
    visitSettings();
    cy.wait("@updater");
    cy.wait("@health");
    card().should("have.class", "attention").within(() => {
      cy.findByRole("status").should("have.text", "Attention needed");
      cy.contains("Updater status is unavailable. The Companion is online, but updater health cannot be confirmed.").should("be.visible");
      cy.get(".deployment-service").should("not.exist");
    });
    cy.get("header.settings-header .last-update").should("have.text", "Updated 1d ago").and("have.attr", "dateTime", iso(-60 * 26));
    cy.then(() => { mode = "error"; });
    cy.findByRole("button", { name: "Refresh deployment health" }).click();
    cy.wait("@updater");
    card().should("contain.text", "Updater status is unavailable");
    cy.then(() => { mode = "ok"; });
    cy.findByRole("button", { name: "Refresh deployment health" }).click();
    cy.wait("@updater");
    card().should("have.class", "healthy").findByRole("status").should("have.text", "Both services healthy");
  });
});
