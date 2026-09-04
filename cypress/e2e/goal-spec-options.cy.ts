// Specification rigor is an opt-in the user makes before any code exists. This
// spec covers the whole visible arc: the six unchecked controls, the exact
// booleans that reach the server, and the Goal Passport that reports back how
// each request was covered, ruled out or missed.
//
// Every request fails closed. A broad 501 fixture is registered first, so any
// call this spec forgot cannot escape through Vite's proxy to the installed
// companion.
const now = "2026-09-04T09:00:00.000Z";
const repository = {
  id: "repo-spec", name: "cmux-e2e-cypress", root: "karven", path: "/Users/test/Developers/karven/cmux-e2e-cypress",
  pullRequestsAvailable: true,
  summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 },
  worktrees: [{ id: "worktree-spec", repoId: "repo-spec", path: "/Users/test/Developers/karven/cmux-e2e-cypress", name: "cmux-e2e-cypress", branch: "main", isPrimary: true, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }],
  releases: [],
};

// The catalog order and the exact labels come from server/worktree-planner-options.mjs.
const SPEC_CONTROLS = ["Unit tests", "End-to-end tests", "Edge cases", "Refactor review", "Screen wireframes", "Flowcharts"];
const GOAL = "Add a spec-rigor pass to the planner sheet";
const READY_GOAL = "Render the spec coverage evidence";

const readyTasks = [
  { id: "T1", title: "Cover the option logic", branch: "spec/t1", prompt: "Cover the option logic.", agent: "claude", agentReason: "Server work suits Claude", type: "test", criterionIds: ["AC-1"], dependsOn: [], ownedAreas: ["server/spec-options.mjs"], verification: ["npm test"], wave: 0 },
  { id: "T2", title: "Clean the touched planner code", branch: "spec/t2", prompt: "Clean the touched planner code.", agent: "codex", agentReason: "UI work suits Codex", type: "refactor", criterionIds: ["AC-2"], dependsOn: ["T1"], ownedAreas: ["app/worktree-planner.tsx"], verification: ["npm run lint"], wave: 1 },
];

// One artifact of each kind, with labels short enough that the renderer's
// two-line wrap and its 24-character edge-label cut leave them intact.
const designArtifacts = [
  {
    id: "F1", kind: "flow", title: "Request to evidence",
    nodes: [
      { id: "n1", label: "Pick options", kind: "start" },
      { id: "n2", label: "Plan the goal", kind: "step" },
      { id: "n3", label: "Show evidence", kind: "end" },
    ],
    edges: [{ from: "n1", to: "n2", label: "submit" }, { from: "n2", to: "n3", label: "" }],
  },
  {
    id: "S1", kind: "screen", title: "Spec depth sheet",
    elements: [
      { id: "e1", label: "Spec depth header", kind: "header", change: "new" },
      { id: "e2", label: "Planner effort select", kind: "input", change: "changed" },
      { id: "e3", label: "Second reasoning toggle", kind: "button", change: "removed" },
      { id: "e4", label: "Plan this goal button", kind: "button", change: "unchanged" },
    ],
  },
];

// Three of the four requested statuses the server can return, so the passport is
// asserted against covered, not-applicable and missing at once.
const optionCoverage = [
  { id: "unitTests", requested: true, status: "covered", message: "T1 · AC-1" },
  { id: "e2eTests", requested: false, status: "not_requested", message: "" },
  { id: "edgeCases", requested: true, status: "not_applicable", message: "The goal changes no branch of the option parser" },
  { id: "refactorPass", requested: true, status: "covered", message: "T2 · AC-2" },
  { id: "screenMocks", requested: true, status: "covered", message: "T1 · AC-1" },
  { id: "flowcharts", requested: true, status: "missing", message: "the contract holds no flow artifact" },
];

const readySpec = {
  version: 2,
  outcome: "Requested specification rigor is visible and reported back",
  inScope: ["The planner sheet"], nonGoals: ["A second reasoning control"], constraints: ["No new planner tool"], assumptions: [],
  acceptanceCriteria: [
    { id: "AC-1", text: "The six requests reach the contract", verification: "npm test" },
    { id: "AC-2", text: "The touched planner code is reviewed", verification: "npm run lint" },
  ],
  risks: [],
  optionEvidence: {
    unitTests: { status: "planned", rationale: "", taskIds: ["T1"], criterionIds: ["AC-1"] },
    edgeCases: { status: "not_applicable", rationale: "The goal changes no branch of the option parser", taskIds: [], criterionIds: [] },
    refactorPass: { status: "planned", rationale: "", taskIds: ["T2"], criterionIds: ["AC-2"] },
    screenMocks: { status: "planned", rationale: "", taskIds: ["T1"], criterionIds: ["AC-1"] },
  },
  designArtifacts,
};

const readyReadiness = {
  ready: true, errors: [],
  warnings: ["Requested flowcharts coverage is missing: the contract holds no flow artifact"],
  waves: [["T1"], ["T2"]],
  coverage: [{ criterionId: "AC-1", taskIds: ["T1"] }, { criterionId: "AC-2", taskIds: ["T2"] }],
  optionCoverage,
};

function readySummary() {
  return {
    planId: "plan-spec", repositoryId: "repo-spec", repositoryName: "cmux-e2e-cypress", goal: READY_GOAL,
    status: "draft", stage: "ready", round: 2, taskCount: readyTasks.length, launchedCount: 0, readyCount: 0,
    boardState: "waiting_for_dev", createdAt: now, updatedAt: now, launchedAt: null,
  };
}

function readyDetail() {
  return {
    ...readySummary(), planStatus: "draft", questions: [], tasks: readyTasks, events: [],
    specOptions: { unitTests: true, e2eTests: false, edgeCases: true, refactorPass: true, screenMocks: true, flowcharts: true },
    spec: readySpec, readiness: readyReadiness, contractVersion: 2,
  };
}

type Scenario = { plans: Array<Record<string, unknown>> };

function installScenario(state: Scenario) {
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
  cy.intercept("GET", "**/api/worktree-plans*", (request) => request.reply({ plans: state.plans })).as("plans");
  cy.intercept("GET", "**/api/worktree-plans/plan-spec", readyDetail()).as("detail");
}

function visitBoard() {
  cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); } });
  cy.wait(["@dashboard", "@plans"]);
  cy.findByRole("region", { name: "Goals board" }).should("be.visible");
}

describe("specification rigor options", () => {
  it("offers six unchecked controls and submits every one of them", () => {
    installScenario({ plans: [] });
    cy.intercept("POST", "**/api/worktree-plans", (request) => {
      expect(request.body.specOptions).to.deep.equal({
        unitTests: true, e2eTests: false, edgeCases: false, refactorPass: true, screenMocks: false, flowcharts: true,
      });
      // Effort stays the single extended-reasoning control. No second
      // reasoning field may ride along with the requests.
      expect(request.body.engine).to.deep.equal({ provider: "claude", model: "default", effort: "default", reviewer: false });
      request.reply({
        planId: "plan-new", repositoryId: "repo-spec", repositoryName: "cmux-e2e-cypress", goal: GOAL,
        status: "questions", stage: "questions", planStatus: "draft", running: true, round: 0,
        questions: [], tasks: [], createdAt: now, updatedAt: now, launchedAt: null,
      });
    }).as("createPlan");
    visitBoard();

    cy.findByRole("button", { name: "Plan a goal for cmux-e2e-cypress" }).click();
    cy.findByRole("dialog", { name: "Plan a goal" }).should("be.visible").within(() => {
      cy.findByRole("region", { name: "Spec depth" }).should("be.visible");
      // Nothing is requested until the user asks for it.
      SPEC_CONTROLS.forEach((label) => cy.findByRole("checkbox", { name: label }).should("not.be.checked"));
      cy.findByRole("region", { name: "Spec depth" }).findAllByRole("checkbox").should("have.length", SPEC_CONTROLS.length);

      cy.findByRole("textbox", { name: "Goal" }).type(GOAL);
      cy.findByRole("checkbox", { name: "Unit tests" }).check();
      cy.findByRole("checkbox", { name: "Refactor review" }).check();
      cy.findByRole("checkbox", { name: "Flowcharts" }).check();
      cy.findByRole("checkbox", { name: "Unit tests" }).should("be.checked");
      cy.findByRole("checkbox", { name: "Edge cases" }).should("not.be.checked");

      cy.findByRole("button", { name: "Plan this goal" }).click();
    });

    cy.wait("@createPlan");
    cy.findByRole("dialog", { name: "Plan a goal" }).should("not.exist");
  });

  it("reports covered, not-applicable and missing requests with their artifacts", () => {
    installScenario({ plans: [readySummary()] });
    visitBoard();

    cy.findByRole("region", { name: "Waiting for dev" }).findByRole("button", { name: `Resume ${READY_GOAL}` }).click();
    cy.wait("@detail");

    cy.findByRole("region", { name: "Goal passport" }).should("be.visible").within(() => {
      // Missing requested coverage is a readiness warning. It never blocks the
      // launch, so the contract still reads as ready.
      cy.contains("Requested flowcharts coverage is missing: the contract holds no flow artifact").should("be.visible");
      cy.contains("Ready to code").should("be.visible");

      cy.contains("Specification coverage").should("be.visible");
      cy.get(".goal-passport-options li").should("have.length", 5);
      // A request the user never made is absent, rather than reported as clean.
      cy.get(".goal-passport-options").should("not.contain.text", "End-to-end tests");

      cy.get(".goal-passport-options li.coverage-covered").first()
        .should("contain.text", "Unit tests").and("contain.text", "T1 · AC-1").and("contain.text", "Covered");
      cy.get(".goal-passport-options li.coverage-not_applicable")
        .should("contain.text", "Edge cases")
        .and("contain.text", "The goal changes no branch of the option parser")
        .and("contain.text", "Not applicable");
      cy.get(".goal-passport-options li.coverage-missing")
        .should("contain.text", "Flowcharts")
        .and("contain.text", "the contract holds no flow artifact")
        .and("contain.text", "Missing");

      // The flow artifact is drawn from the returned nodes and edges only.
      cy.contains("Design artifacts").should("be.visible");
      cy.findByRole("img", { name: "Flow diagram: Request to evidence" }).within(() => {
        cy.contains("tspan", "Pick options").should("exist");
        cy.contains("tspan", "Plan the goal").should("exist");
        cy.contains("tspan", "Show evidence").should("exist");
        cy.contains("text", "submit").should("exist");
      });

      // The screen artifact is a structured description, not a screenshot.
      cy.get(".spec-screen").should("contain.text", "Spec depth sheet").within(() => {
        cy.get("li.change-new").should("contain.text", "Added").and("contain.text", "Spec depth header");
        cy.get("li.change-changed").should("contain.text", "Changed").and("contain.text", "Planner effort select");
        cy.get("li.change-removed").should("contain.text", "Removed").and("contain.text", "Second reasoning toggle");
        cy.get("li.change-unchanged").should("contain.text", "Unchanged").and("contain.text", "Plan this goal button");
        cy.get("img").should("not.exist");
      });
    });
  });
});

export {};
