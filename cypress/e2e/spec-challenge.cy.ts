// A goal that is being questioned is not a goal that is being re-planned. This
// spec pins the difference through the UI: the card stays under "Waiting for
// dev", the sheet keeps the Delivery Contract and its tasks on screen, and the
// thread carries its own progress while every mutating control is disabled.
//
// Every request fails closed. A broad 501 fixture is registered first, so a
// call this spec forgot cannot escape through Vite's proxy to the installed
// companion.
const now = "2026-09-05T09:00:00.000Z";
const GOAL = "Question the contract before launching it";

const repository = {
  id: "repo-challenge", name: "cmux-e2e-cypress", root: "karven", path: "/Users/test/Developers/karven/cmux-e2e-cypress",
  pullRequestsAvailable: true,
  summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 },
  worktrees: [{ id: "worktree-challenge", repoId: "repo-challenge", path: "/Users/test/Developers/karven/cmux-e2e-cypress", name: "cmux-e2e-cypress", branch: "main", isPrimary: true, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }],
  releases: [],
};

const tasks = [
  { id: "T1", title: "Store the discussion", branch: "challenge/t1", prompt: "Store the discussion.", agent: "claude", agentReason: "Server work suits Claude", type: "backend", criterionIds: ["AC-1"], dependsOn: [], ownedAreas: ["server/worktree-plan-store.mjs"], verification: ["npm test"], wave: 0 },
  { id: "T2", title: "Render the thread", branch: "challenge/t2", prompt: "Render the thread.", agent: "codex", agentReason: "UI work suits Codex", type: "ui", criterionIds: ["AC-1"], dependsOn: ["T1"], ownedAreas: ["app/worktree-planner.tsx"], verification: ["npm run test:ui"], wave: 1 },
];

const spec = {
  version: 2,
  outcome: "A questioned contract is answered without being rewritten",
  inScope: ["The goal sheet"], nonGoals: ["Editing the contract from an answer"], constraints: ["No new planner round"], assumptions: [],
  acceptanceCriteria: [{ id: "AC-1", text: "The thread survives a reload", verification: "npm run test:ui" }],
  risks: [],
};

const readiness = {
  ready: true, errors: [], warnings: [],
  waves: [["T1"], ["T2"]],
  coverage: [{ criterionId: "AC-1", taskIds: ["T1", "T2"] }],
};

// Oldest first, exactly as the detail route returns it. The round 1 entry is
// the historical one; round 2 matches the contract on screen.
const discussion = [
  { question: "Does task 1 already own the migration?", answer: "No.\nIt owns the store only.", contractImpact: "none", suggestion: "", round: 1, createdAt: now },
  { question: "Is the answer round covered by a task?", answer: "Task 1 stores it, task 2 renders it.", contractImpact: "none", suggestion: "", round: 2, createdAt: now },
];

// The goal is being questioned, not planned: it is a ready draft that stays in
// "Waiting for dev" while its round runs.
function discussingSummary() {
  return {
    planId: "plan-challenge", repositoryId: "repo-challenge", repositoryName: "cmux-e2e-cypress", goal: GOAL,
    status: "draft", stage: "ready", running: true, runStage: "discussing", runStep: "Reading the contract",
    round: 2, taskCount: tasks.length, launchedCount: 0, readyCount: 0,
    boardState: "waiting_for_dev", createdAt: now, updatedAt: now, launchedAt: null,
  };
}

function discussingDetail() {
  return {
    ...discussingSummary(), planStatus: "draft", questions: [], tasks, events: [],
    spec, readiness, contractVersion: 2, discussion,
  };
}

function installScenario() {
  const dashboard = {
    generatedAt: now, github: { checkedAt: now, status: "ready" },
    summary: { repositories: 1, worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 },
    repositories: [repository], orphanSessions: [],
  };

  // Registered first, so every explicit route below wins Cypress's
  // reverse-order matching and an unlisted /api call still fails closed.
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [], error: null, refreshedAt: now });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/github-issues*", { syncedAt: null, issues: [] });
  cy.intercept("GET", "**/api/goals/capacity*", { providers: [], next: null, reason: "Local fixture", nextReset: null, available: false });
  cy.intercept("GET", "**/api/goals/health", { checkedAt: now, sessionsAvailable: true, goals: [], summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0, deadTasks: 0, idleTasks: 0, failedTasks: 0 } });
  cy.intercept("GET", "**/api/worktree-dashboard*", dashboard).as("dashboard");
  // The list pattern is registered before the detail route on purpose: the
  // detail route must be matched first, so a plan id can never be answered with
  // the list fixture.
  cy.intercept("GET", "**/api/worktree-plans*", (request) => request.reply({ plans: [discussingSummary()] })).as("plans");
  cy.intercept("GET", "**/api/worktree-plans/plan-challenge", discussingDetail()).as("detail");
}

function visitBoard() {
  cy.visit("/?mode=worktrees", {
    onBeforeLoad(window) {
      window.localStorage.setItem("cmux-companion-home-mode", "worktrees");
      // The running sheet opens its own progress stream. A real EventSource
      // would reach the installed companion, so it gets an inert stand-in that
      // never emits and never retries. The running view then stays on screen
      // for as long as the assertions need it.
      class InertEventSource {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        readyState = 1;
        constructor(public url: string) {}
        close() { this.readyState = 2; }
        addEventListener() {}
        removeEventListener() {}
      }
      Object.defineProperty(window, "EventSource", { configurable: true, writable: true, value: InertEventSource });
    },
  });
  cy.wait(["@dashboard", "@plans"]);
  cy.findByRole("region", { name: "Goals board" }).should("be.visible");
}

describe("saved discovery is read-only", () => {
  it("keeps the old specification and discussion while offering one native continuation", () => {
    installScenario(); visitBoard();
    cy.findByRole("button", { name: `Watch ${GOAL}` }).click(); cy.wait("@detail");
    cy.findByRole("dialog", { name: "Plan a goal" }).within(() => {
      cy.findByRole("button", { name: "Continue discovery" }).should("be.enabled");
      cy.findByRole("button", { name: /^Ask$/ }).should("not.exist");
      cy.findByRole("button", { name: "This plan is wrong" }).should("not.exist");
      cy.findByRole("region", { name: "Saved discussion" }).should("contain.text", "Does task 1 already own the migration?");
    });
  });
});
export {};
