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
    id: "S1", kind: "screen", title: "Spec depth sheet", summary: "The planner sheet gains the six requests.",
    screen: {
      name: "Plan a goal",
      elements: [
        { id: "e1", label: "Spec depth header", kind: "header", change: "added" },
        { id: "e2", label: "Planner effort select", kind: "input", change: "changed" },
        { id: "e3", label: "Second reasoning toggle", kind: "button", change: "removed" },
        { id: "e4", label: "Plan this goal button", kind: "button", change: "unchanged" },
      ],
    },
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
    ...readySummary(), planStatus: "draft", deliveryMode: "combined", questions: [], tasks: readyTasks, events: [],
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

describe("delivery plan readability", () => {
  for (const width of [390, 1280]) {
    it(`shows parallel stages and expandable dependencies at ${width}px`, () => {
      cy.viewport(width, 900);
      installScenario({ plans: [readySummary()] });
      const detail = readyDetail();
      const titles = ["Define report outcomes and planner behavior", "Persist normalized findings and atomic provenance", "Securely collect findings reports", "Make board supervision and cleanup report-aware", "Expose authenticated findings APIs", "Build report planning and triage UI", "Complete end-to-end verification and documentation"];
      const dependencies = [[], ["T1"], ["T1", "T2"], ["T1", "T2"], ["T3", "T4"], ["T5"], ["T3", "T4", "T5", "T6"]];
      detail.tasks = titles.map((title, index) => ({ ...readyTasks[0], id: `T${index + 1}`, title, dependsOn: dependencies[index], wave: [0, 1, 2, 2, 3, 4, 5][index] }));
      detail.readiness = { ...detail.readiness, waves: [["T1"], ["T2"], ["T3", "T4"], ["T5"], ["T6"], ["T7"]] };
      cy.intercept("GET", "**/api/worktree-plans/plan-spec", detail).as("deliveryDetail");
      visitBoard();
      cy.findByRole("button", { name: `Resume ${READY_GOAL}` }).click();
      cy.wait("@deliveryDetail");
      cy.findByRole("tab", { name: "Tasks" }).click();
      cy.findByRole("region", { name: "Delivery plan" }).within(() => {
        cy.contains("7 tasks · 6 stages").should("be.visible");
        cy.get(".delivery-stage").should("have.length", 6);
        cy.get(".delivery-plan-task").should("have.length", 7).each(($card) => {
          expect($card[0].scrollWidth).to.be.at.most($card[0].clientWidth);
        });
        cy.contains("2 tasks can run in parallel").should("be.visible");
        cy.get(".delivery-plan-task").last().within(() => {
          cy.get("details").should("not.have.attr", "open");
          cy.contains("summary", "After task 3, task 4, task 5, task 6").click();
          cy.contains("li", titles[2]).should("be.visible");
          cy.contains("li", titles[5]).should("be.visible");
        });
        cy.contains("One combined pull request").should("be.visible");
      });
    });
  }
});

describe("human launch review", () => {
  for (const width of [390, 1280]) {
    it(`offers a concise overview and visual design review at ${width}px`, () => {
      cy.viewport(width, 900);
      installScenario({ plans: [readySummary()] });
      const detail = readyDetail();
      cy.intercept("GET", "**/api/worktree-plans/plan-spec", {
        ...detail, spec: { ...detail.spec, approvalSummary: {
          overview: "Choose how thoroughly your goal is checked, then review the proposed screens and workflow before starting development.",
          userFlow: ["Choose your checks", "Review the proposed design", "Approve and start work"],
          decisions: [{ choice: "Keep the review before launch", consequence: "You can change the plan before agents start modifying code." }],
          successCriteria: ["Your requested checks stay with the goal.", "You can inspect the design before launch.", "Results show which checks actually passed.", "Older saved plans remain readable."],
        } },
      }).as("conciseReview");
      visitBoard();
      cy.findByRole("button", { name: `Resume ${READY_GOAL}` }).click();
      cy.wait("@conciseReview");
      cy.get(".review-success li").should("have.length", 3);
      cy.findByRole("tabpanel", { name: "Overview" }).should("be.visible");
      cy.screenshot(`plan-review-overview-${width}`, { capture: "viewport" });
      cy.findByRole("tab", { name: "Design" }).click();
      cy.findByRole("list", { name: "User journey" }).find("li").should("have.length", 3);
      cy.findByRole("img", { name: "Flow diagram: Request to evidence" }).should("be.visible");
      cy.screenshot(`plan-review-design-${width}`, { capture: "viewport" });
      cy.findByRole("tab", { name: /Impacts/ }).click();
      cy.contains("You can change the plan before agents start modifying code.").should("be.visible");
      cy.contains("summary", "Affected code").click();
      cy.contains("Planned ownership, not a measured diff.").should("be.visible");
      cy.screenshot(`plan-review-impacts-${width}`, { capture: "viewport" });
      cy.findByRole("tab", { name: "Tasks" }).focus().type("{rightarrow}");
      cy.findByRole("tab", { name: "Checks" }).should("have.focus").and("have.attr", "aria-selected", "true");
      cy.get(".goal-passport-criteria").should("be.visible");
      cy.contains("Older saved plans remain readable.").should("be.visible");
    });

    it(`surfaces decisions and preserves a long outcome at ${width}px`, () => {
      cy.viewport(width, 900);
      installScenario({ plans: [readySummary()] });
      const fullOutcome = "Restore the saved dictation session without autoplay. " + "Existing drafts must remain readable. ".repeat(20) + "Final constraint: preserve the listening requirement.";
      const detail = readyDetail();
      cy.intercept("GET", "**/api/worktree-plans/plan-spec", {
        ...detail, spec: { ...detail.spec, outcome: fullOutcome,
          assumptions: ["Restoring correction access must preserve the listening requirement"],
          risks: [{ text: "Legacy drafts may be lost", mitigation: "Read both draft formats", level: "high" }],
        },
      }).as("reviewDetail");
      let launches = 0;
      cy.intercept("POST", "**/api/worktree-plans/plan-spec/launch", (request) => {
        launches += 1;
        request.reply({ statusCode: 202, body: { planId: "plan-spec", launched: 0, results: [] } });
      }).as("launchReview");
      visitBoard();
      cy.findByRole("button", { name: `Resume ${READY_GOAL}` }).click();
      cy.wait("@reviewDetail");
      cy.findByRole("region", { name: "Goal passport" }).within(() => {
        cy.contains("Review before launch").should("be.visible");
        cy.findByRole("tab", { name: "Overview" }).should("have.attr", "aria-selected", "true");
        cy.findByRole("tablist").then(($tabs) => expect($tabs[0].scrollWidth).to.be.at.most($tabs[0].clientWidth));
        cy.contains("Success criteria and verification").should("not.exist");
        cy.get(".planner-task").should("not.exist");
        cy.contains("Expected outcome (excerpt)").should("be.visible");
        cy.get(".goal-review-outcome").invoke("text").should("have.length.lessThan", 300);
        cy.findByRole("tab", { name: /Impacts/ }).click();
        cy.contains("Restoring correction access must preserve the listening requirement").should("be.visible");
        cy.contains("Legacy drafts may be lost").should("be.visible");
        cy.contains("Read both draft formats").should("be.visible");
        cy.findByRole("tab", { name: "Checks" }).click();
        cy.contains("Success criteria and verification").should("be.visible");
        cy.get(".goal-passport-criteria").should("contain.text", "planned");
        cy.findByRole("tab", { name: "Overview" }).click();
        cy.contains("summary", "Read the full expected outcome").click();
        cy.findByRole("button", { name: "Show Full expected outcome as raw text" }).click();
        cy.get("pre").should("have.text", fullOutcome);
      });
      cy.findByRole("region", { name: "Launch decision" }).within(() => {
        cy.contains("Review 1 assumptions and 1 warnings in Impacts before proceeding.").should("be.visible");
        cy.findByRole("button", { name: /Start workflow/ }).should("be.enabled");
      });
      cy.then(() => expect(launches).to.equal(0));
      cy.findByRole("region", { name: "Launch decision" }).findByRole("button").click();
      cy.wait("@launchReview");
      cy.then(() => expect(launches).to.equal(1));
    });
  }

  it("keeps structural errors visible and prevents launch", () => {
    installScenario({ plans: [readySummary()] });
    const detail = readyDetail();
    cy.intercept("GET", "**/api/worktree-plans/plan-spec", {
      ...detail, readiness: { ...detail.readiness, ready: false, errors: ["AC-2 has no task"] },
    }).as("blockedReview");
    visitBoard();
    cy.findByRole("button", { name: `Resume ${READY_GOAL}` }).click();
    cy.wait("@blockedReview");
    cy.contains("Needs work").should("be.visible");
    cy.contains("AC-2 has no task").should("be.visible");
    cy.findByRole("region", { name: "Launch decision" }).findByRole("button").should("be.disabled");
    cy.findByRole("button", { name: "This plan is wrong" }).should("be.enabled");
  });
});

describe("planner engine defaults", () => {
  it("submits Codex Astra and keeps Default and provider switches valid", () => {
    installScenario({ plans: [] });
    cy.intercept("POST", "**/api/worktree-plans", (request) => {
      expect(request.body.engine).to.deep.equal({ provider: "codex", model: "gpt-6-astra", effort: "default", reviewer: true });
      request.reply({ statusCode: 202, body: {
        planId: "astra-default", repositoryId: "repo-spec", goal: request.body.goal,
        status: "questions", round: 0, running: true, questions: [], tasks: [],
      } });
    }).as("planAstra");
    visitBoard();
    cy.findByRole("button", { name: "Plan a goal for cmux-e2e-cypress" }).click();
    cy.findByRole("combobox", { name: "Planner engine" }).should("have.value", "codex");
    cy.findByRole("combobox", { name: "Planner model" }).should("have.value", "gpt-6-astra");
    cy.contains("Codex (xcodex) · Codex Astra").should("be.visible");
    cy.findByRole("checkbox", { name: "Add a reviewer pass" }).check();
    cy.contains("Reviewer: Claude Code (xclaude) · Fable 5.1 · xhigh effort").should("be.visible");
    cy.findByRole("combobox", { name: "Planner model" }).select("default");
    cy.contains("Codex (xcodex) · CCS default model").should("be.visible");
    cy.findByRole("combobox", { name: "Planner engine" }).select("claude");
    cy.findByRole("combobox", { name: "Planner model" }).should("have.value", "default");
    cy.contains("Claude Code (xclaude) · CCS default model").should("be.visible");
    cy.findByRole("combobox", { name: "Planner model" }).select("claude-opus-5");
    cy.findByRole("combobox", { name: "Planner engine" }).select("codex");
    cy.findByRole("combobox", { name: "Planner model" }).should("have.value", "gpt-6-astra");
    cy.findByRole("textbox", { name: "Goal" }).type("Plan using Astra");
    cy.findByRole("button", { name: "Plan this goal" }).click();
    cy.wait("@planAstra");
    cy.findByRole("dialog", { name: "Plan a goal" }).should("not.exist");
  });
});

describe("post-delivery reviewer model", () => {
  for (const changeModel of [false, true]) {
    it(`opens with Fable 5.1 and submits the ${changeModel ? "selected" : "default"} reviewer model`, () => {
      installScenario({ plans: [] });
      cy.intercept("POST", "**/api/worktree-plans", (request) => {
        expect(request.body.reviewOptions).to.deep.equal({ codeReview: true, reviewer: changeModel ? "codex" : "claude", reviewerModel: changeModel ? "gpt-6-astra" : "claude-fable-5-1" });
        request.reply({ statusCode: 202, body: { planId: "review-model", repositoryId: "repo-spec", goal: request.body.goal, status: "questions", round: 0, running: true, questions: [], tasks: [] } });
      }).as("reviewModel");
      visitBoard();
      cy.findByRole("button", { name: "Plan a goal for cmux-e2e-cypress" }).click();
      cy.findByRole("combobox", { name: "Code-review model" }).should("be.visible").and("have.value", "claude-fable-5-1").find("option:selected").should("have.text", "Fable 5.1");
      cy.findByRole("combobox", { name: "Code-review reviewer" }).should("have.value", "claude");
      if (changeModel) {
        cy.findByRole("combobox", { name: "Code-review reviewer" }).select("codex");
        cy.findByRole("combobox", { name: "Code-review model" }).select("gpt-6-astra").find('option[value="claude-fable-5-1"]').should("not.exist");
      }
      cy.findByRole("checkbox", { name: "Code review" }).check();
      cy.findByRole("textbox", { name: "Goal" }).type("Review the delivered goal");
      cy.findByRole("button", { name: "Plan this goal" }).click();
      cy.wait("@reviewModel");
    });
  }
});

describe("per-project development setup review", () => {
  for (const provider of ["claude", "codex"]) {
    it(`submits an editable project-specific review with ${provider}`, () => {
      installScenario({ plans: [] });
      cy.intercept("POST", "**/api/worktree-plans", (request) => {
        expect(request.body.repositoryId).to.equal("repo-spec");
        expect(request.body.engine.provider).to.equal(provider);
        expect(request.body.goal).to.include("TypeScript, Cypress and Astro");
        expect(request.body.goal).to.include("AGENTS.md, CLAUDE.md");
        expect(request.body.goal).to.include("Result:").and.include("Checks:").and.include("Blockers:");
        expect(request.body.goal).to.include("Keep the hardware simulator.");
        expect(request.body.goal.length).to.be.at.most(4000);
        expect(request.body.background).to.equal(true);
        request.reply({ statusCode: 202, body: {
          planId: "dev-setup", repositoryId: "repo-spec", goal: request.body.goal,
          status: "questions", round: 0, running: true, questions: [], tasks: [],
        } });
      }).as("reviewSetup");
      visitBoard();
      cy.findByRole("button", { name: "Plan a goal for cmux-e2e-cypress" }).click();
      cy.findByRole("button", { name: "Review dev setup" }).click();
      cy.findByRole("textbox", { name: "Goal" }).type("\nKeep the hardware simulator.");
      cy.findByRole("combobox", { name: "Planner engine" }).select(provider);
      cy.findByRole("button", { name: "Plan this goal" }).click();
      cy.wait("@reviewSetup");
      cy.findByRole("dialog", { name: "Plan a goal" }).should("not.exist");
    });
  }

  it("preserves a written goal and keeps the review editable after a failed submit", () => {
    installScenario({ plans: [] });
    cy.intercept("POST", "**/api/worktree-plans", { statusCode: 503, body: { error: "Planner unavailable" } }).as("failedReview");
    visitBoard();
    cy.findByRole("button", { name: "Plan a goal for cmux-e2e-cypress" }).click();
    cy.findByRole("textbox", { name: "Goal" }).type("Keep my existing scope");
    cy.findByRole("button", { name: "Review dev setup" }).should("be.disabled");
    cy.findByRole("textbox", { name: "Goal" }).should("have.value", "Keep my existing scope").clear();
    cy.findByRole("button", { name: "Review dev setup" }).click();
    cy.findByRole("button", { name: "Plan this goal" }).click();
    cy.wait("@failedReview");
    cy.findByRole("dialog", { name: "Plan a goal" }).should("be.visible");
    cy.contains("Planner unavailable").should("be.visible");
    cy.findByRole("textbox", { name: "Goal" }).should("contain.value", "Make this repository");
  });

  it("opens a review from one project without submitting or carrying it into a normal goal", () => {
    installScenario({ plans: [] });
    let submissions = 0;
    cy.intercept("POST", "**/api/worktree-plans", () => { submissions += 1; });
    visitBoard();
    cy.contains("summary", "Board tools").click();
    cy.findByRole("tab", { name: /^Inactive/ }).click();
    cy.findByRole("button", { name: "Review dev setup for cmux-e2e-cypress" }).click();
    cy.findByRole("textbox", { name: "Goal" }).should("contain.value", "Make this repository");
    cy.findByRole("button", { name: "Close goal planner sheet" }).click();
    cy.then(() => expect(submissions).to.equal(0));
    cy.findByRole("button", { name: "Plan a goal for cmux-e2e-cypress" }).click();
    cy.findByRole("textbox", { name: "Goal" }).should("have.value", "");
  });
});

describe("specification rigor options", () => {
  it("offers six unchecked controls and submits every one of them", () => {
    installScenario({ plans: [] });
    cy.intercept("POST", "**/api/worktree-plans", (request) => {
      expect(request.body.specOptions).to.deep.equal({
        unitTests: true, e2eTests: false, edgeCases: false, refactorPass: true, screenMocks: false, flowcharts: true,
      });
      // Effort stays the single extended-reasoning control. No second
      // reasoning field may ride along with the requests.
      expect(request.body.engine).to.deep.equal({ provider: "codex", model: "gpt-6-astra", effort: "default", reviewer: false });
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
      cy.findByRole("tab", { name: /Impacts/ }).click();
      cy.contains("Requested flowcharts coverage is missing: the contract holds no flow artifact").should("be.visible");
      cy.contains("Review before launch").should("be.visible");

      // Coverage and design artifacts are authoritative contract detail. The
      // concise approval surface leaves them collapsed until a reviewer asks.
      cy.findByRole("tab", { name: "Checks" }).click();
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
      cy.findByRole("tab", { name: "Design" }).click();
      cy.contains("Design artifacts").should("be.visible");
      cy.findByRole("img", { name: "Flow diagram: Request to evidence" }).within(() => {
        cy.contains("tspan", "Pick options").should("exist");
        cy.contains("tspan", "Plan the goal").should("exist");
        cy.contains("tspan", "Show evidence").should("exist");
        cy.contains("text", "submit").should("exist");
      });

      // The screen artifact is a structured description, not a screenshot.
      cy.get(".spec-screen").should("contain.text", "Spec depth sheet").within(() => {
        cy.get("li.change-added").should("contain.text", "Added").and("contain.text", "Spec depth header");
        cy.get("li.change-changed").should("contain.text", "Changed").and("contain.text", "Planner effort select");
        cy.get("li.change-removed").should("contain.text", "Removed").and("contain.text", "Second reasoning toggle");
        cy.get("li.change-unchanged").should("contain.text", "Unchanged").and("contain.text", "Plan this goal button");
        cy.contains(".spec-screen-name", "Plan a goal").should("be.visible");
        cy.contains(".spec-artifact-summary", "The planner sheet gains the six requests.").should("be.visible");
        cy.get("img").should("not.exist");
      });
    });
  });
});

export {};
