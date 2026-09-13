import { DEFAULT_MODEL_ROLES } from "../../server/model-options.mjs";

type Roles = Record<string, { provider?: string; models: Record<string, string> }>;
const now = "2026-09-06T12:00:00Z";
function scenario() {
  const state = { roles: structuredClone(DEFAULT_MODEL_ROLES) as Roles, failSave: false, failLoad: false };
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing local fixture" } });
  cy.intercept("GET", "**/api/settings/local", { statusCode: 404, body: { error: "Legacy settings" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [], refreshedAt: now });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/settings/models", (request) => {
    request.reply(state.failLoad ? { statusCode: 503, body: { error: "Settings unavailable" } } : { roles: state.roles, defaults: DEFAULT_MODEL_ROLES, warning: null });
  }).as("loadModels");
  cy.intercept("PATCH", "**/api/settings/models", (request) => {
    if (state.failSave) request.reply({ statusCode: 500, body: { error: "Could not save settings" } });
    else { state.roles = request.body.roles; request.reply({ roles: state.roles, defaults: DEFAULT_MODEL_ROLES, warning: null }); }
  }).as("saveModels");
  return state;
}
function settings() { cy.visit("/settings#agents"); cy.wait("@loadModels"); }
describe("model defaults", () => {
  it("saves manual-session defaults on mobile, survives reload and resets the supported role", () => {
    scenario(); cy.viewport(390, 844); settings();
    cy.findByLabelText("Planner default provider").should("not.exist");
    cy.findByLabelText("Coder Codex model").select("__custom__");
    cy.findByLabelText("Coder Codex model ID").type("custom/coder");
    cy.findByRole("button", { name: "Save model defaults" }).click();
    cy.wait("@saveModels").its("request.body.roles.coder.models.codex").should("equal", "custom/coder");
    cy.reload(); cy.wait("@loadModels");
    cy.findByLabelText("Coder Codex model ID").should("have.value", "custom/coder");
    cy.findByRole("button", { name: "Reset coder" }).click();
    cy.findByRole("button", { name: "Save model defaults" }).click(); cy.wait("@saveModels");
    cy.reload(); cy.wait("@loadModels");
    cy.findByLabelText("Coder Codex model").should("have.value", "default");
    cy.document().then((doc) => expect(doc.documentElement.scrollWidth).to.be.at.most(390));
  });

  it("offers all models while provider default is selected and persists concrete choices", () => {
    scenario(); settings();
    for (const role of ["Coder"]) {
      cy.findByLabelText(`${role} Claude model`).find("option").should("contain.text", "Provider default").and("contain.text", "Opus 5").and("contain.text", "Fable 5.1");
      cy.findByLabelText(`${role} Claude model`).select("claude-fable-5-1");
      cy.findByLabelText(`${role} Codex model`).find("option").should("contain.text", "Codex Astra").and("contain.text", "GPT-5.6 Sol").and("contain.text", "GPT-5.6 Terra").and("contain.text", "GPT-5.6 Luna");
      cy.findByLabelText(`${role} Codex model`).select("gpt-5.6-terra");
    }
    cy.findByRole("button", { name: "Save model defaults" }).click(); cy.wait("@saveModels");
    cy.reload(); cy.wait("@loadModels");
    cy.findByLabelText("Coder Claude model").should("have.value", "claude-fable-5-1");
    cy.findByLabelText("Coder Codex model").should("have.value", "gpt-5.6-terra");
  });

  it("keeps edits visible on save failure, discards them, and retries a failed load", () => {
    const state = scenario(); state.failLoad = true; settings();
    cy.contains("Settings unavailable").should("be.visible");
    cy.then(() => { state.failLoad = false; });
    cy.findByRole("button", { name: "Retry loading model defaults" }).click(); cy.wait("@loadModels");
    cy.findByLabelText("Coder Codex model").select("__custom__");
    cy.findByLabelText("Coder Codex model ID").type("custom-coder");
    cy.then(() => { state.failSave = true; });
    cy.findByRole("button", { name: "Save model defaults" }).click(); cy.wait("@saveModels");
    cy.contains("Could not save settings").should("be.visible");
    cy.contains("Model defaults saved").should("not.exist");
    cy.findByLabelText("Coder Codex model ID").should("have.value", "custom-coder");
    cy.findByRole("button", { name: "Discard changes" }).click();
    cy.findByLabelText("Coder Codex model").should("have.value", "default");
  });

});
