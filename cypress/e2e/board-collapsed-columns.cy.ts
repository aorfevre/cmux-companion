const now = "2026-09-03T12:00:00.000Z";
const preferenceKey = "cmux-companion-goal-board-column-expansion";

const repository = {
  id: "repo-board", name: "board-fixture", root: "karven", path: "/Users/test/Developers/karven/board-fixture",
  favorite: true, pullRequestsAvailable: true,
  summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 },
  worktrees: [{ id: "worktree-board", repoId: "repo-board", path: "/Users/test/Developers/karven/board-fixture", name: "board-fixture", branch: "main", isPrimary: true, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }],
  releases: [],
};

function plan(planId: string, goal: string, boardState: string, overrides: Record<string, unknown> = {}) {
  return {
    planId, repositoryId: repository.id, repositoryName: repository.name, goal,
    status: "draft", stage: "ready", round: 1, taskCount: 1, createdAt: now, updatedAt: now, launchedAt: null,
    boardState, ...overrides,
  };
}

const plans = [
  plan("goal-writing", "Draft the resilient spec", "writing_spec", { stage: "questions", round: 0, running: true, runStage: "writing_spec" }),
  plan("goal-review", "Review the resilient spec", "review_spec", { running: true, runStage: "review_spec" }),
  plan("goal-waiting", "Prepare the implementation", "waiting_for_dev"),
  plan("goal-dev", "Build the implementation", "dev_in_progress", { status: "launched", launchedAt: now, deliveryStatus: "implementing" }),
  plan("goal-pr", "Land the implementation", "waiting_for_merge", { status: "launched", launchedAt: now, deliveryStatus: "pr_open", boardPrState: "OPEN" }),
  plan("goal-blocked", "Repair the blocked implementation", "blocked", { status: "launched", launchedAt: now, deliveryStatus: "blocked" }),
  plan("goal-merged-one", "Merged terminal one", "merged", { status: "launched", launchedAt: now, boardStatus: "merged", boardPrState: "MERGED" }),
  plan("goal-merged-two", "Merged terminal two", "merged", { status: "launched", launchedAt: now, boardStatus: "merged", boardPrState: "MERGED" }),
  plan("goal-aborted", "Aborted terminal", "aborted", { boardStatus: "aborted" }),
];

function installBoard() {
  const dashboard = {
    generatedAt: now, github: { checkedAt: now, status: "ready" },
    summary: { repositories: 1, worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 },
    repositories: [repository], orphanSessions: [],
  };
  const issues = [{ repositoryId: repository.id, repositoryName: repository.name, number: 17, title: "Keep the issue lane expanded", labels: ["board"], url: "https://github.test/acme/board-fixture/issues/17", updatedAt: now, syncedAt: now, planId: null }];

  // Registered first so the explicit routes below win Cypress's reverse-order
  // matching. No request can escape these deterministic local fixtures.
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
  cy.intercept("GET", "**/api/worktree-dashboard*", dashboard).as("dashboard");
  cy.intercept("GET", "**/api/worktree-plans*", { plans }).as("plans");
  cy.intercept("GET", "**/api/github-issues", { syncedAt: now, issues }).as("issues");
}

function visitBoard() {
  cy.visit("/?mode=worktrees", { onBeforeLoad(window) {
    window.localStorage.setItem("cmux-companion-home-mode", "worktrees");
    window.localStorage.removeItem(preferenceKey);
  } });
  cy.wait(["@dashboard", "@plans", "@health", "@issues"]);
  cy.findByRole("region", { name: "Goals board" }).should("be.visible");
}

const column = (name: string) => cy.findByRole("region", { name });

describe("collapsible goal board columns", () => {
  beforeEach(() => installBoard());

  it("starts Blocked and terminal columns collapsed, keeps their counts query-aware, and toggles every lane accessibly", () => {
    visitBoard();

    column("Merged").within(() => {
      cy.findByLabelText("2 goals in Merged").should("be.visible");
      cy.findByRole("button", { name: "Expand Merged" }).should("have.attr", "aria-expanded", "false");
      cy.contains("Merged terminal one").should("not.exist");
      cy.contains("The goal pull request is merged.").should("not.exist");
    });
    column("Aborted").within(() => {
      cy.findByLabelText("1 goal in Aborted").should("be.visible");
      cy.findByRole("button", { name: "Expand Aborted" }).should("have.attr", "aria-expanded", "false");
      cy.contains("Aborted terminal").should("not.exist");
      cy.contains("The goal was stopped and no more work is expected.").should("not.exist");
    });

    column("Blocked").within(() => {
      cy.findByLabelText("1 goal in Blocked").should("be.visible");
      cy.findByRole("button", { name: "Expand Blocked" }).should("have.attr", "aria-expanded", "false");
      cy.contains("Repair the blocked implementation").should("not.exist");
    });
    cy.findByRole("button", { name: "Expand Blocked" }).click();
    column("Blocked").should("contain.text", "Repair the blocked implementation");
    cy.findByRole("button", { name: "Collapse Blocked" }).click();

    const expandedCards = [
      ["GitHub Issues", "Keep the issue lane expanded"],
      ["Writing Spec", "Draft the resilient spec"],
      ["Review Spec", "Review the resilient spec"],
      ["Waiting for dev", "Prepare the implementation"],
      ["Dev in progress", "Build the implementation"],
      ["Waiting for merge", "Land the implementation"],
    ];
    for (const [name, card] of expandedCards) column(name).should("contain.text", card);
    cy.findAllByRole("button", { name: /^(Expand|Collapse) / }).should("have.length", 9);

    cy.findByRole("button", { name: "Expand Merged" }).click().should("have.attr", "aria-expanded", "true");
    column("Merged").find("article").should("have.length", 2);
    cy.findByRole("button", { name: "Collapse Merged" }).click().should("have.attr", "aria-expanded", "false");
    cy.findByRole("searchbox", { name: "Search projects" }).type("Prepare the implementation");
    column("Merged").findByLabelText("0 goals in Merged").should("exist");
  });

  it("persists expansion, re-collapse, and a working-column choice across reloads", () => {
    visitBoard();
    cy.findByRole("button", { name: "Expand Merged" }).click();
    cy.findByRole("button", { name: "Expand Blocked" }).click();
    cy.reload();
    cy.wait(["@dashboard", "@plans", "@health", "@issues"]);
    column("Blocked").should("contain.text", "Repair the blocked implementation");
    cy.findByRole("button", { name: "Collapse Blocked" }).click();
    column("Merged").should("contain.text", "Merged terminal one");
    cy.findByRole("button", { name: "Collapse Merged" }).should("have.attr", "aria-expanded", "true").click();

    cy.reload();
    cy.wait(["@dashboard", "@plans", "@health", "@issues"]);
    column("Blocked").should("not.contain.text", "Repair the blocked implementation");
    column("Merged").should("not.contain.text", "Merged terminal one");
    cy.findByRole("button", { name: "Expand Merged" }).should("have.attr", "aria-expanded", "false");

    cy.findByRole("button", { name: "Collapse Waiting for dev" }).click();
    column("Waiting for dev").should("not.contain.text", "Prepare the implementation");
    cy.reload();
    cy.wait(["@dashboard", "@plans", "@health", "@issues"]);
    cy.findByRole("button", { name: "Expand Waiting for dev" }).should("have.attr", "aria-expanded", "false");
    column("Waiting for dev").should("not.contain.text", "Prepare the implementation");
  });

  it("applies the Blocked default to older saved preferences without resetting other columns", () => {
    cy.visit("/?mode=worktrees", { onBeforeLoad(window) {
      window.localStorage.setItem(preferenceKey, JSON.stringify({ blocked: true, merged: true, waiting_for_dev: false }));
    } });
    cy.wait(["@dashboard", "@plans", "@health", "@issues"]);
    cy.findByRole("button", { name: "Expand Blocked" }).should("have.attr", "aria-expanded", "false");
    column("Merged").should("contain.text", "Merged terminal one");
    cy.findByRole("button", { name: "Expand Waiting for dev" }).should("exist");
    cy.findByRole("button", { name: "Expand Blocked" }).click();
    cy.reload();
    cy.wait(["@dashboard", "@plans", "@health", "@issues"]);
    column("Blocked").should("contain.text", "Repair the blocked implementation");
  });

  it("uses a materially narrower strip at desktop and mobile widths", () => {
    cy.viewport(1440, 900);
    visitBoard();
    column("Merged").then(($collapsed) => {
      const collapsedWidth = $collapsed[0].getBoundingClientRect().width;
      column("Waiting for dev").then(($expanded) => {
        const expandedWidth = $expanded[0].getBoundingClientRect().width;
        expect(collapsedWidth).to.be.lessThan(expandedWidth * 0.5);
        expect(collapsedWidth).to.be.at.most(90);
      });
    });

    cy.viewport(390, 844);
    column("Merged").then(($collapsed) => {
      const collapsedWidth = $collapsed[0].getBoundingClientRect().width;
      column("Waiting for dev").then(($expanded) => {
        const expandedWidth = $expanded[0].getBoundingClientRect().width;
        expect(collapsedWidth).to.be.lessThan(expandedWidth * 0.5);
        expect(collapsedWidth).to.be.at.most(90);
      });
    });
  });
});

export {};
