const now = "2026-09-06T12:00:00Z";
const workspace = { id: "workspace-safety", title: "Safety session", current_directory: "/repo", terminals: [{ id: "terminal-a", title: "Alpha", is_focused: true }, { id: "terminal-b", title: "Beta" }] };
const item = { id: "queue-safety", workspaceId: workspace.id, surfaceId: "terminal-a", text: "Old instruction", createdAt: now, updatedAt: now, attempts: 0 };

function common() {
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic safety fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: {}, workspaces: [workspace], refreshedAt: now });
  cy.intercept("GET", "**/api/goal-sessions/workspace/*", { plan: null });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [item] });
  cy.intercept("GET", "**/api/terminals/*/replay*", { mode: "text", text: "Ready for instructions" });
  cy.intercept("POST", "**/api/terminals/*/viewport", {});
}

function visitSession() {
  cy.visit(`/?mode=sessions&workspace=${workspace.id}&surface=terminal-a`, {
    onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-read-only", "false"); },
  });
}

describe("review safety boundaries", () => {
  it("keeps edited instructions after a failed save and sends only after successful retry", () => {
    common();
    let fail = true;
    let saved = item.text;
    const sent: string[] = [];
    cy.intercept("PATCH", "**/api/prompt-queue/queue-safety", (request) => {
      if (fail) request.reply(503, { error: "Save unavailable" });
      else { saved = request.body.text; request.reply({ statusCode: 200, body: {} }); }
    }).as("save");
    cy.intercept("POST", "**/api/prompt-queue/queue-safety/send", (request) => { sent.push(saved); request.reply({ statusCode: 200, body: {} }); }).as("send");
    cy.intercept("GET", "**/api/prompt-queue?*", (request) => request.reply({ items: [{ ...item, text: saved }] }));
    visitSession();
    cy.findByRole("button", { name: "Prompt queue, 1 waiting" }).click();
    cy.findByRole("textbox", { name: "Queued prompt 1" }).clear().type("The instruction I reviewed");
    cy.findByRole("dialog", { name: "Prompt queue" }).findByRole("button", { name: "Send now" }).click();
    cy.wait("@save");
    cy.findByRole("alert").should("contain.text", "Your edits are kept");
    cy.get(".toast").should("be.visible").and("contain.text", "Save unavailable");
    cy.findByRole("textbox", { name: "Queued prompt 1" }).should("have.value", "The instruction I reviewed");
    cy.then(() => { expect(sent).to.deep.equal([]); fail = false; });
    cy.findByRole("dialog", { name: "Prompt queue" }).findByRole("button", { name: "Send now" }).click();
    cy.wait("@send");
    cy.then(() => expect(sent).to.deep.equal(["The instruction I reviewed"]));
  });

  it("loads fresh terminal and queue state on A-to-B-to-A selection", () => {
    common();
    let returnedToAlpha = false;
    cy.intercept("GET", "**/api/terminals/terminal-a/replay*", (request) => { request.reply({ mode: "text", text: returnedToAlpha ? "Current Alpha" : "First Alpha" }); });
    cy.intercept("GET", "**/api/terminals/terminal-b/replay*", { mode: "text", text: "Current Beta" });
    cy.intercept("GET", "**/api/prompt-queue?*", (request) => request.reply({ items: String(request.query.surfaceId) === "terminal-a" ? [{ ...item, text: "Alpha instructions" }] : [] }));
    visitSession();
    cy.contains("First Alpha").should("be.visible");
    cy.findByRole("button", { name: "Session menu" }).click();
    cy.findByRole("button", { name: "2. Beta" }).click();
    cy.contains("Current Beta").should("be.visible");
    cy.then(() => { returnedToAlpha = true; });
    cy.findByRole("button", { name: "Session menu" }).click();
    cy.findByRole("button", { name: "1. Alpha" }).click();
    cy.contains("Current Alpha").should("be.visible");
    cy.findByRole("button", { name: "Prompt queue, 1 waiting" }).click();
    cy.findByRole("textbox", { name: "Queued prompt 1" }).should("have.value", "Alpha instructions");
  });

  for (const bulk of [false, true]) {
    it(`retains the worktree and shows failed safety evidence during ${bulk ? "bulk" : "single"} removal`, () => {
      common();
      const row = { id: "worktree-safety", repoId: "repo-safety", path: "/repo-feature", name: "feature", branch: "feature/safety", head: "abc", isPrimary: false, detached: false, locked: null, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } };
      const summary = { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 };
      const repository = { id: "repo-safety", name: "cmux-e2e-safety", root: "karven", path: "/repo", pullRequestsAvailable: true, summary, worktrees: [row], releases: [] };
      cy.intercept("GET", "**/api/bootstrap", { connected: true, host: {}, workspaces: [], refreshedAt: now });
      cy.intercept("GET", "**/api/worktree-dashboard*", { generatedAt: now, summary: { ...summary, repositories: 1, pullRequests: 0 }, repositories: [repository], orphanSessions: [] });
      cy.intercept("GET", "**/api/worktree-plans*", { plans: [] });
      cy.intercept("GET", "**/api/github-issues", { syncedAt: null, issues: [] });
      cy.intercept("GET", "**/api/goals/health", { sessionsAvailable: true, goals: [], summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0 } });
      const error = "Sessions could not be checked. Retry before removing this worktree";
      cy.intercept("DELETE", "**/api/worktree-dashboard/worktree-safety", { statusCode: 400, body: { error, reason: "sessions-unavailable" } }).as("remove");
      cy.intercept("POST", "**/api/worktree-dashboard/repositories/repo-safety/remove-clean", { repository: { id: repository.id, name: repository.name }, requested: 1, removed: 0, failed: 1, results: [{ ...row, removed: false, error }], branchPreserved: true }).as("bulk");
      cy.visit("/?mode=worktrees");
      cy.findByRole("tab", { name: /^Inactive/ }).click();
      if (bulk) {
        cy.findByRole("button", { name: "Remove clean worktrees in cmux-e2e-safety" }).click();
        cy.findByRole("button", { name: "Remove 1 worktree" }).click();
        cy.wait("@bulk");
      } else {
        cy.contains(".worktree-card", "feature/safety").findByRole("button", { name: "Remove" }).click();
        cy.findByRole("button", { name: "Confirm remove" }).click();
        cy.wait("@remove");
      }
      cy.get(".toast").should("be.visible").and("contain.text", "Sessions could not be checked");
      cy.contains(".worktree-card", "feature/safety").should("be.visible");
    });
  }
});

export {};
