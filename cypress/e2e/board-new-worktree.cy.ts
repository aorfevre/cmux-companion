// The board's "＋ Worktree" button is a one-click path to agent work: pick a
// repository, keep the generated branch name, and get a worktree on the latest
// default branch plus a running agent. The base is never a form field here, so
// this spec proves the request carries `useDefaultBase` and no base at all.

const now = "2026-09-07T12:00:00.000Z";

const repository = (id: string, name: string) => ({
  id, name, root: "karven", path: `/Users/test/Developers/karven/${name}`,
  favorite: true, pullRequestsAvailable: true,
  summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 },
  worktrees: [{ id: `worktree-${id}`, repoId: id, path: `/Users/test/Developers/karven/${name}`, name, branch: "main", isPrimary: true, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }],
  releases: [],
});

// Two repositories, so the button must open the picker rather than skip it.
const trust = repository("repositoryTrust0001", "trust-layer");
const recorder = repository("repositoryRecord01", "recorder");

const createdWorktree = {
  id: "worktreeCreated0001", repoId: trust.id, path: "/Users/test/Developers/karven/trust-layer-wt", name: "trust-layer-wt",
  branch: "wt/2026-09-07-1200", isPrimary: false, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false,
  lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" },
};

function installBoard() {
  const dashboard = {
    generatedAt: now, github: { checkedAt: now, status: "ready" },
    summary: { repositories: 2, worktrees: 2, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 },
    repositories: [trust, recorder], orphanSessions: [],
  };
  // Registered first so the explicit routes below win Cypress's reverse-order
  // matching. Any unfixtured call fails closed instead of reaching a real API.
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [], error: null, refreshedAt: now });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/goals/capacity*", { providers: [], next: null, reason: "Local fixture", nextReset: null, available: false });
  cy.intercept("GET", "**/api/goals/health", { checkedAt: now, sessionsAvailable: true, goals: [], summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0, deadTasks: 0, idleTasks: 0, failedTasks: 0 } }).as("health");
  cy.intercept("GET", "**/api/github-issues*", { syncedAt: null, issues: [] }).as("issues");
  cy.intercept("GET", "**/api/worktree-dashboard*", dashboard).as("dashboard");
  cy.intercept("GET", "**/api/worktree-plans*", { plans: [] }).as("plans");
  cy.intercept("POST", `**/api/worktree-dashboard/repositories/${trust.id}/worktrees`, {
    statusCode: 201,
    body: { created: true, reused: false, branchCreated: true, worktree: createdWorktree },
  }).as("createWorktree");
  cy.intercept("POST", `**/api/worktree-dashboard/${createdWorktree.id}/launch`, {
    statusCode: 201,
    body: { workspace: { workspace_id: "workspaceBoardWt01" }, worktree: { id: createdWorktree.id, repoId: trust.id, branch: createdWorktree.branch, path: createdWorktree.path } },
  }).as("launchWorktree");
}

function visitBoard() {
  cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); } });
  cy.wait(["@dashboard", "@plans", "@health", "@issues"]);
  cy.findByRole("region", { name: "Goals board" }).should("be.visible");
}

describe("the board creates a worktree on the latest default branch", () => {
  beforeEach(() => {
    installBoard();
    visitBoard();
  });

  it("picks a repository, keeps the generated branch, and starts the chosen agent", () => {
    cy.openBoardTools();
    cy.findByRole("button", { name: "＋ Worktree" }).click();
    cy.findByRole("menuitem", { name: "Create a worktree in trust-layer" }).click();
    cy.findByRole("dialog", { name: "Create Git worktree" }).within(() => {
      cy.findByRole("textbox", { name: "Branch name" }).should(($input) => {
        expect($input.val()).to.match(/^wt\/\d{4}-\d{2}-\d{2}-\d{4}$/);
      });
      // The server owns the base in this mode, so the form offers no field.
      cy.findByRole("textbox", { name: "Base revision" }).should("not.exist");
      cy.findByRole("button", { name: "New worktree Claude (xclaude)" }).click();
      cy.findByRole("button", { name: "Create & start session" }).click();
    });
    cy.wait("@createWorktree").its("request.body").should((body) => {
      expect(body.useDefaultBase).to.equal(true);
      expect(body).to.not.have.property("base");
      expect(body.branch).to.match(/^wt\/\d{4}-\d{2}-\d{2}-\d{4}$/);
    });
    cy.wait("@launchWorktree").its("request.body.agent").should("equal", "claude");
    cy.findByRole("dialog", { name: "Create Git worktree" }).should("not.exist");
  });

  it("filters the picker by name and reaches the other repository", () => {
    cy.openBoardTools();
    cy.findByRole("button", { name: "＋ Worktree" }).click();
    cy.findByRole("searchbox", { name: "Find a repository" }).type("record");
    cy.findByRole("menuitem", { name: "Create a worktree in trust-layer" }).should("not.exist");
    cy.findByRole("menuitem", { name: "Create a worktree in recorder" }).should("be.visible");
  });
});
