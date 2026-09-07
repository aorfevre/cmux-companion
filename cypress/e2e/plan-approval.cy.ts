// Goal approval stays deterministic and fail-closed: every API response below
// is local fixture data, including both the new concise summary and an older
// saved contract that has no summary to regenerate.
const now = "2026-09-07T10:00:00.000Z";

const repository = {
  id: "repo-approval", name: "approval-fixture", root: "karven", path: "/Users/test/Developers/karven/approval-fixture",
  favorite: true, pullRequestsAvailable: true,
  summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 },
  worktrees: [{ id: "worktree-approval", repoId: "repo-approval", path: "/Users/test/Developers/karven/approval-fixture", name: "approval-fixture", branch: "main", isPrimary: true, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }],
  releases: [],
};

const tasks = [
  { id: "T1", title: "Build the approval surface", branch: "approval/surface", prompt: "Build the summary.", agent: "codex", agentReason: "UI ownership", criterionIds: ["AC-1"], dependsOn: [], ownedAreas: ["app/worktree-planner.tsx"], verification: ["npm run test:ui"], wave: 0 },
  { id: "T2", title: "Document approval review", branch: "approval/docs", prompt: "Document the review flow.", agent: "claude", agentReason: "Documentation ownership", criterionIds: ["AC-2"], dependsOn: [], ownedAreas: ["README.md"], verification: ["npm run lint"], wave: 0 },
  { id: "T3", title: "Verify the approval flow", branch: "approval/e2e", prompt: "Add local Cypress coverage.", agent: "codex", agentReason: "Cypress ownership", criterionIds: ["AC-3"], dependsOn: ["T1", "T2"], ownedAreas: ["cypress/e2e"], verification: ["npm run test:e2e:local"], wave: 1 },
  { id: "T4", title: "Check the delivery endpoint", branch: "approval/release", prompt: "Check release readiness.", agent: "claude", agentReason: "Delivery ownership", criterionIds: ["AC-3"], dependsOn: ["T1", "T3"], ownedAreas: ["server"], verification: ["npm run verify"], wave: 2 },
];

const summarySpec = {
  version: 2,
  outcome: "Reviewers approve a goal from a concise, actionable summary",
  approvalSummary: {
    overview: "Review the outcome, decisions, and parallel delivery before launching.",
    userFlow: ["Open a saved goal", "Review readiness and delivery", "Expand evidence only when needed"],
    decisions: [{ choice: "Use a concise default", consequence: "The detailed contract remains available without hiding readiness." }],
    successCriteria: ["Reviewers can see the delivery mode", "Dependencies are visible before launch"],
  },
  inScope: ["Goal passport"], nonGoals: ["Regenerating saved plans"], constraints: ["Keep readiness visible"], assumptions: ["The saved contract is authoritative"],
  risks: [{ text: "A dependency is missed", mitigation: "Show it on the downstream task", level: "medium" }],
  acceptanceCriteria: [
    { id: "AC-1", text: "The concise summary is readable", verification: "UI test passes" },
    { id: "AC-2", text: "The review flow is documented", verification: "Lint passes" },
    { id: "AC-3", text: "The local flow is covered", verification: "Cypress passes" },
  ],
};

const readiness = {
  ready: false,
  errors: ["A task dependency still needs approval"],
  warnings: ["End-to-end validation is queued after the parallel work"],
  waves: [["T1", "T2"], ["T3"], ["T4"]],
  coverage: [{ criterionId: "AC-1", taskIds: ["T1"] }, { criterionId: "AC-2", taskIds: ["T2"] }, { criterionId: "AC-3", taskIds: ["T3", "T4"] }],
};

function summary(planId = "plan-summary", goal = "Approve the concise delivery plan") {
  return { planId, repositoryId: repository.id, repositoryName: repository.name, goal, status: "draft", stage: "ready", round: 1, taskCount: tasks.length, createdAt: now, updatedAt: now, launchedAt: null, boardState: "waiting_for_dev" };
}

function summaryDetail() {
  return { ...summary(), planStatus: "draft", questions: [], events: [], tasks, spec: summarySpec, readiness, contractVersion: 2, deliveryMode: "combined" };
}

function legacyDetail() {
  const legacySpec = { ...summarySpec, outcome: "Older saved contract stays reviewable", approvalSummary: undefined };
  return { ...summary("plan-legacy", "Review an older saved contract"), planStatus: "draft", questions: [], events: [], tasks: [tasks[0]], spec: legacySpec, readiness: { ...readiness, ready: true, errors: [], waves: [["T1"]] }, contractVersion: 2, deliveryMode: "single" };
}

function installScenario(kind: "summary" | "legacy") {
  const detail = kind === "summary" ? summaryDetail() : legacyDetail();
  const dashboard = { generatedAt: now, github: { checkedAt: now, status: "ready" }, summary: { repositories: 1, worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 }, repositories: [repository], orphanSessions: [] };
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
  cy.intercept("GET", "**/api/worktree-plans*", { plans: [summary(detail.planId, detail.goal)] }).as("plans");
  cy.intercept("GET", `**/api/worktree-plans/${detail.planId}`, detail).as("detail");
}

function openSavedGoal(goal: string) {
  cy.viewport(390, 844);
  cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); } });
  cy.wait(["@dashboard", "@plans"]);
  cy.findByRole("region", { name: "Goals board" }).should("be.visible");
  cy.findByRole("region", { name: "Waiting for dev" }).findByRole("button", { name: `Resume ${goal}` }).click();
  cy.wait("@detail");
}

describe("concise saved-goal approval", () => {
  it("keeps readiness visible, groups independent work in waves, and reveals selected task detail", () => {
    installScenario("summary");
    openSavedGoal("Approve the concise delivery plan");

    cy.findByRole("region", { name: "Goal passport" }).within(() => {
      cy.contains("Review the outcome, decisions, and parallel delivery before launching.").should("be.visible");
      cy.contains("User flow").should("be.visible");
      cy.contains("Use a concise default").should("be.visible");
      cy.contains("Needs work").should("be.visible");
      cy.contains("A task dependency still needs approval").should("be.visible");
      cy.contains("End-to-end validation is queued after the parallel work").should("be.visible");

      cy.findByRole("region", { name: "Delivery plan" }).within(() => {
        cy.contains("One combined pull request").should("be.visible");
        cy.get(".delivery-stage").eq(0).find(".delivery-plan-task").should("have.length", 2);
        cy.get(".delivery-stage").eq(1).find(".delivery-plan-task").should("have.length", 1);
        cy.get(".delivery-stage").eq(2).find(".delivery-plan-task").should("have.length", 1);
        cy.contains("After task 1, task 2").should("be.visible");
        cy.contains("After task 1, task 3").click();
        cy.get(".delivery-plan-task").last().find("details[open] li").should("have.length", 2)
          .and("contain.text", "Build the approval surface").and("contain.text", "Verify the approval flow");
        cy.root().then(($chart) => expect($chart[0].scrollWidth).to.be.at.most($chart[0].clientWidth));
        cy.get(".delivery-plan-task").eq(2).within(() => {
          cy.contains("summary", "Scope and checks").click();
          cy.contains("Scope: The local flow is covered").should("be.visible");
          cy.contains("Files: cypress/e2e").should("be.visible");
          cy.contains("Checks: npm run test:e2e:local").should("be.visible");
        });
      });
      cy.screenshot("plan-approval-mobile", { capture: "fullPage" });

      cy.contains("In scope").should("be.visible");
      cy.contains("Goal passport").should("be.visible");
      cy.contains("A dependency is missed").should("be.visible");
      cy.contains("The concise summary is readable").should("be.visible");
      cy.findByText("Task ownership and checks").click();
      cy.contains("Owns: cypress/e2e").should("be.visible");
    });
  });

  it("falls back to the saved contract when a legacy plan has no approval summary", () => {
    installScenario("legacy");
    openSavedGoal("Review an older saved contract");

    cy.findByRole("region", { name: "Goal passport" }).within(() => {
      cy.contains("Older saved contract stays reviewable").should("be.visible");
      cy.contains("Review the outcome, decisions, and parallel delivery before launching.").should("not.exist");
      cy.findByRole("region", { name: "Delivery plan" }).should("contain.text", "1 task pull request");
      cy.contains("Goal passport").should("be.visible");
      cy.contains("Regenerating saved plans").should("be.visible");
    });
  });
});

export {};
