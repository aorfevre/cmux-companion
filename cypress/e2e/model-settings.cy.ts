import { DEFAULT_MODEL_ROLES } from "../../server/model-options.mjs";

type Roles = Record<string, { provider?: string; models: Record<string, string> }>;
const now = "2026-09-06T12:00:00Z";
const repo = {
  id: "repo-models", name: "Model fixture", root: "test", path: "/fixture", pullRequestsAvailable: true,
  summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 },
  worktrees: [{ id: "worktree-models", repoId: "repo-models", path: "/fixture", name: "Model fixture", branch: "main", isPrimary: true, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }], releases: [],
};
function scenario() {
  const state = { roles: structuredClone(DEFAULT_MODEL_ROLES) as Roles, failSave: false, failLoad: false };
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
  cy.intercept("GET", "**/api/worktree-plans*", { plans: [] });
  cy.intercept("GET", "**/api/settings/models", (request) => {
    request.reply(state.failLoad ? { statusCode: 503, body: { error: "Settings unavailable" } } : { roles: state.roles, defaults: DEFAULT_MODEL_ROLES, warning: null });
  }).as("loadModels");
  cy.intercept("PATCH", "**/api/settings/models", (request) => {
    if (state.failSave) request.reply({ statusCode: 500, body: { error: "Could not save settings" } });
    else { state.roles = request.body.roles; request.reply({ roles: state.roles, defaults: DEFAULT_MODEL_ROLES, warning: null }); }
  }).as("saveModels");
  return state;
}
function settings() { cy.visit("/?view=settings"); cy.wait("@loadModels"); }
function planner() {
  cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); } });
  cy.findByRole("button", { name: "Plan a goal for Model fixture" }).click();
  cy.wait("@loadModels");
}

describe("model defaults", () => {
  it("saves all roles on mobile, survives a reload, and resets one role without changing the others", () => {
    scenario(); cy.viewport(390, 844); settings();
    cy.findByLabelText("Planner default provider").should("have.value", "codex");
    cy.findByLabelText("Planner Codex model").should("have.value", "gpt-6-astra");
    cy.findByRole("region", { name: "Model defaults" }).screenshot("model-defaults-mobile");
    for (const role of ["Planner", "Spec reviewer", "Coder", "Code reviewer", "Merge agent", "Follow-up agent", "Issue analyzer"]) {
      cy.findByLabelText(`${role} Codex model`).select("__custom__");
      cy.findByLabelText(`${role} Codex model ID`).type(`custom/${role.toLowerCase().replaceAll(" ", "-")}`);
    }
    cy.findByLabelText("Planner default provider").select("claude");
    cy.findByLabelText("Planner Claude model").select("__custom__");
    cy.findByLabelText("Planner Claude model ID").type("custom-planner");
    cy.findByRole("button", { name: "Save model defaults" }).click();
    cy.wait("@saveModels").its("request.body.roles.coder.models.codex").should("equal", "custom/coder");
    cy.contains("Model defaults saved").should("be.visible");
    cy.reload(); cy.wait("@loadModels");
    cy.findByLabelText("Planner Claude model ID").should("have.value", "custom-planner");
    cy.findByLabelText("Code reviewer Codex model ID").should("have.value", "custom/code-reviewer");
    cy.findByRole("button", { name: "Reset planner" }).click();
    cy.findByRole("button", { name: "Save model defaults" }).click(); cy.wait("@saveModels");
    cy.reload(); cy.wait("@loadModels");
    cy.findByLabelText("Planner Codex model").should("have.value", "gpt-6-astra");
    cy.findByLabelText("Coder Codex model ID").should("have.value", "custom/coder");
    cy.document().then((doc) => expect(doc.documentElement.scrollWidth).to.be.at.most(390));
  });

  it("offers all models while provider default is selected and persists concrete choices", () => {
    scenario(); settings();
    for (const role of ["Planner", "Spec reviewer", "Coder", "Code reviewer", "Merge agent", "Follow-up agent", "Issue analyzer"]) {
      cy.findByLabelText(`${role} Claude model`).find("option").should("contain.text", "Provider default").and("contain.text", "Opus 5").and("contain.text", "Fable 5.1");
      cy.findByLabelText(`${role} Claude model`).select("claude-fable-5-1");
      cy.findByLabelText(`${role} Codex model`).find("option").should("contain.text", "Codex Astra").and("contain.text", "GPT-5.6 Sol").and("contain.text", "GPT-5.6 Terra").and("contain.text", "GPT-5.6 Luna");
      cy.findByLabelText(`${role} Codex model`).select("gpt-5.6-terra");
    }
    cy.findByRole("button", { name: "Save model defaults" }).click(); cy.wait("@saveModels");
    cy.reload(); cy.wait("@loadModels");
    cy.findByLabelText("Coder Claude model").should("have.value", "claude-fable-5-1");
    cy.findByLabelText("Coder Codex model").should("have.value", "gpt-5.6-terra");
    planner();
    cy.findByLabelText("Planner model").should("have.value", "gpt-5.6-terra");
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

  it("waits for defaults and preserves edits made while they are loading", () => {
    const state = scenario();
    state.roles.planner.models.codex = "saved-planner";
    cy.intercept("GET", "**/api/settings/models", { delay: 1500, body: { roles: state.roles, defaults: DEFAULT_MODEL_ROLES, warning: null } }).as("delayedModels");
    cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); } });
    cy.findByRole("button", { name: "Plan a goal for Model fixture" }).click();
    cy.findByLabelText("Goal").type("Keep my choice");
    cy.findByRole("button", { name: "Plan this goal" }).should("be.disabled");
    cy.findByLabelText("Planner model").select("gpt-5.6-terra");
    cy.wait("@delayedModels");
    cy.findByLabelText("Planner model").should("have.value", "gpt-5.6-terra");
    cy.findByRole("button", { name: "Plan this goal" }).should("be.enabled");
  });

  for (const override of [false, true]) it(`loads custom defaults in the planner and submits ${override ? "explicit overrides" : "saved choices"}`, () => {
    const state = scenario();
    state.roles.planner = { provider: "codex", models: { claude: "custom-claude", codex: "custom-planner" } };
    state.roles.specReviewer.models.claude = "custom-spec-review";
    state.roles.codeReviewer.models.claude = "custom-code-review";
    cy.intercept("POST", "**/api/worktree-plans", (request) => {
      expect(request.body.engine.model).to.equal(override ? "custom-override" : "custom-planner");
      expect(request.body.reviewOptions.reviewerModel).to.equal(override ? "custom-review-override" : "custom-code-review");
      request.reply({ statusCode: 202, body: { planId: "model-plan", repositoryId: repo.id, goal: request.body.goal, running: true, status: "questions", round: 0, questions: [], tasks: [] } });
    }).as("plan");
    planner();
    cy.findByLabelText("Planner model ID").should("have.value", "custom-planner");
    cy.findByLabelText("Code-review model ID").should("have.value", "custom-code-review");
    cy.findByLabelText("Add a reviewer pass").check();
    cy.contains("custom-spec-review").should("be.visible");
    if (override) {
      cy.findByLabelText("Planner model ID").clear().type("custom-override");
      cy.findByLabelText("Code-review model ID").clear().type("custom-review-override");
    }
    cy.findByLabelText("Goal").type("Use the configured models");
    cy.findByRole("button", { name: "Plan this goal" }).click(); cy.wait("@plan");
  });
});
