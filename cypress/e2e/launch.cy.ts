const now = "2026-09-08T09:00:00.000Z";
const billingRepo = { id: "repo-billing", name: "billing-service", root: "karven", path: "/Users/dev/karven/billing-service", branch: "feature/invoices", ahead: 2, behind: 0, changedFiles: 3, dirty: true, lastActivity: 1_788_000_000, scripts: ["dev", "test"] };
const docsRepo = { id: "repo-docs", name: "docs-site", root: "rekord", path: "/Users/dev/rekord/docs-site", branch: "main", ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1_787_000_000, scripts: [] };
const launched = { id: "workspace-launched", title: "billing-service", current_directory: billingRepo.path, terminals: [{ id: "terminal-launched", title: "Codex", is_focused: true }] };

function fixtures() {
  let workspaces: Array<typeof launched> = [];
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", (request) => request.reply({ connected: true, host: { mac_display_name: "Launch Mac" }, workspaces, error: null, refreshedAt: now })).as("bootstrap");
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos*", { repos: [billingRepo, docsRepo] }).as("repos");
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/prompt-queue?*", { items: [] });
  cy.intercept("GET", "**/api/goal-sessions/workspace/*", { plan: null });
  cy.intercept("GET", "**/api/terminals/terminal-launched/replay*", { mode: "text", text: "Codex is starting in billing-service" }).as("replay");
  cy.intercept("GET", "**/api/goals/capacity*", { providers: [], next: null, available: false });
  cy.intercept("GET", "**/api/goals/health", { sessionsAvailable: true, goals: [], summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0 } });
  cy.intercept("GET", "**/api/goals/sessions/retirable*", { sessionsAvailable: true, closed: [], kept: [], failed: [] });
  cy.intercept("GET", "**/api/github-issues", { syncedAt: null, issues: [] });
  cy.intercept("GET", "**/api/worktree-plans*", { plans: [] });
  cy.intercept("GET", "**/api/worktree-dashboard*", { generatedAt: now, github: { status: "ready" }, summary: { repositories: 0, worktrees: 0, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 }, repositories: [], orphanSessions: [] });
  return { reveal: () => { workspaces = [launched]; } };
}

function visitLaunch() {
  cy.visit("/?view=launch");
  cy.wait("@repos");
  cy.findByRole("heading", { name: "Start work", level: 1 }).should("be.visible");
}

for (const [width, height] of [[390, 844], [1440, 900]]) {
  describe(`Launch view at ${width}px`, () => {
    beforeEach(() => cy.viewport(width, height));

    it("filters repositories, prefills the workspace name and opens the launched workspace", () => {
      const state = fixtures();
      cy.intercept("POST", "**/api/workspaces", (request) => {
        state.reveal();
        request.reply({ statusCode: 201, body: { workspace: { workspace_id: launched.id }, repo: { id: billingRepo.id, name: billingRepo.name } } });
      }).as("launch");
      visitLaunch();
      cy.get(".repo-list button").should("have.length", 2);
      cy.contains(".repo-list button", "billing-service").should("contain.text", "karven · feature/invoices").and("contain.text", "3 changed");
      cy.contains(".repo-list button", "docs-site").should("not.contain.text", "changed");
      cy.findByPlaceholderText("Find a repository…").type("rekord");
      cy.get(".repo-list button").should("have.length", 1).and("contain.text", "docs-site");
      cy.findByPlaceholderText("Find a repository…").clear().type("invoices");
      cy.contains(".repo-list button", "billing-service").click();
      cy.findByLabelText("Workspace name").should("have.value", "billing-service").clear().type("Invoice totals");
      cy.contains(".selected-repo", "~/karven/billing-service · feature/invoices").should("be.visible");
      cy.findByRole("button", { name: "Codex" }).should("have.class", "selected");
      cy.findByLabelText("Initial task").type("Add invoice totals to the billing summary");
      cy.findByRole("button", { name: "Launch codex" }).click();
      cy.wait("@launch").its("request.body").should("deep.equal", { repoId: "repo-billing", title: "Invoice totals", agent: "codex", prompt: "Add invoice totals to the billing summary", script: null });
      cy.wait("@replay");
      cy.location("search").should("eq", "?workspace=workspace-launched");
      cy.contains(".detail-header strong", "billing-service").should("be.visible");
      cy.get(".terminal-fallback").should("contain.text", "Codex is starting in billing-service");
    });
  });
}

describe("Launch options and outcomes", () => {
  beforeEach(() => cy.viewport(390, 844));

  it("launches a package script as a shell workspace without an initial task", () => {
    const state = fixtures();
    cy.intercept("POST", "**/api/workspaces", (request) => { state.reveal(); request.reply({ statusCode: 201, body: { workspace: { workspace_id: launched.id }, repo: { id: billingRepo.id, name: billingRepo.name } } }); }).as("launch");
    visitLaunch();
    cy.contains(".repo-list button", "billing-service").click();
    cy.findByRole("button", { name: "Claude" }).click();
    cy.findByRole("button", { name: "Claude" }).should("have.class", "selected");
    cy.findByLabelText("Initial task").type("Draft a plan");
    cy.findByLabelText("Or run package script").select("npm run test");
    cy.findByLabelText("Initial task").should("not.exist");
    cy.findByRole("button", { name: "Claude" }).should("not.have.class", "selected");
    cy.findByRole("button", { name: "Launch script" }).click();
    cy.wait("@launch").its("request.body").should("deep.equal", { repoId: "repo-billing", title: "billing-service", agent: "shell", prompt: "Draft a plan", script: "test" });
    cy.location("search").should("eq", "?workspace=workspace-launched");
  });

  it("hides the script picker for a repository without scripts and the task for a shell", () => {
    fixtures();
    visitLaunch();
    cy.contains(".repo-list button", "docs-site").click();
    cy.findByLabelText("Or run package script").should("not.exist");
    cy.findByLabelText("Initial task").should("be.visible");
    cy.findByRole("button", { name: "Shell" }).click();
    cy.findByLabelText("Initial task").should("not.exist");
    cy.findByRole("button", { name: "Launch shell" }).should("be.visible");
    cy.findByRole("button", { name: "‹ Choose another repo" }).click();
    cy.get(".repo-list button").should("have.length", 2);
    cy.findByPlaceholderText("Find a repository…").should("have.value", "");
  });

  it("returns to the sessions view with a notice when cmux has not reported the new workspace yet", () => {
    fixtures();
    cy.intercept("POST", "**/api/workspaces", { statusCode: 201, body: { workspace: { workspace_id: "workspace-not-yet" }, repo: { id: docsRepo.id, name: docsRepo.name } } }).as("launch");
    visitLaunch();
    cy.contains(".repo-list button", "docs-site").click();
    cy.findByRole("button", { name: "Launch codex" }).click();
    cy.wait("@launch");
    cy.wait("@bootstrap");
    cy.get(".toast").should("be.visible").and("contain.text", "Workspace launched. It will appear in a moment.");
    cy.findByRole("link", { name: "← Back to Goals" }).should("have.attr", "href", "/orchestration");
    cy.location("search").should("not.contain", "workspace=");
    cy.get("@replay.all").should("have.length", 0);
  });

  it("shows the launch error inline and keeps the form", () => {
    fixtures();
    cy.intercept("POST", "**/api/workspaces", { statusCode: 400, body: { error: "That package script is not available" } }).as("launch");
    visitLaunch();
    cy.contains(".repo-list button", "billing-service").click();
    cy.findByLabelText("Initial task").type("Keep me");
    cy.findByRole("button", { name: "Launch codex" }).click();
    cy.wait("@launch");
    cy.get(".form-error").should("have.text", "That package script is not available");
    cy.findByLabelText("Initial task").should("have.value", "Keep me");
    cy.findByRole("button", { name: "Launch codex" }).should("be.enabled");
    cy.findByRole("heading", { name: "Start work", level: 1 }).should("be.visible");
  });

  it("rescans the repository catalogue on demand", () => {
    fixtures();
    visitLaunch();
    cy.get("@repos.all").should("have.length", 1);
    cy.findByRole("button", { name: "Rescan" }).click();
    cy.get("@repos.all").should("have.length", 2);
  });
});

export {};
