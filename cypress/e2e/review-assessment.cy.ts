// After the independent planner review completes, Companion hands it to the
// planner automatically. The user takes no action until the reviewed final
// plan appears; then the only decisions are approve or request changes.
// Every request fails closed behind a 501 fixture registered first.
export {};

const now = "2026-09-10T10:00:00.000Z";
const GOAL = "Add billing to the checkout";
const repository = {
  id: "repo-review", name: "cmux-e2e-cypress", root: "karven", path: "/Users/test/Developers/karven/cmux-e2e-cypress", pullRequestsAvailable: true,
  summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 1, working: 0, dirty: 0 },
  worktrees: [{ id: "worktree-review", repoId: "repo-review", path: "/Users/test/Developers/karven/cmux-e2e-cypress", name: "cmux-e2e-cypress", branch: "main", isPrimary: true, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivityAt: now, sessions: [] }],
  releases: [],
};
const findings = [
  { id: "F1", severity: "high", title: "Missing rollback", evidence: "No down step", suggestion: "Add one" },
  { id: "F2", severity: "low", title: "Naming", evidence: "Mixed case", suggestion: "" },
];
const reviewId = "d".repeat(64);
const engine = { provider: "claude", model: "default", effort: "default", reviewer: true };

function summary(patch: Record<string, unknown> = {}) {
  return { planId: "plan-review", repositoryId: "repo-review", repositoryName: "cmux-e2e-cypress", goal: GOAL, status: "draft", stage: "ready", round: 1, taskCount: 0, launchedCount: 0, readyCount: 0, boardState: "discovering", plannerReviewStatus: "running", createdAt: now, updatedAt: now, launchedAt: null, workflow: "goal_session", goalType: "coding", goalSessionGeneration: 1, goalSessionState: "awaiting_approval", ...patch };
}

function install() {
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
  cy.intercept("GET", "**/api/worktree-dashboard*", { generatedAt: now, github: { checkedAt: now, status: "ready" }, summary: { repositories: 1, worktrees: 1, releases: 0, sessions: 0, needsYou: 1, working: 0, dirty: 0, pullRequests: 0 }, repositories: [repository], orphanSessions: [] }).as("dashboard");
}

function visit() {
  cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); window.localStorage.setItem("cmux-companion-read-only", "false"); } });
  cy.wait(["@dashboard", "@plans"]);
}

describe("Automatic planner assessment", () => {
  it("progresses from review to assessed final plan with zero user actions, then approves only the final revision", () => {
    cy.viewport(390, 844);
    const running = { id: reviewId, kind: "planner", target: "1", status: "running", result: null as string | null, error: null, acknowledgedAt: null, findings: [] as typeof findings, assessment: null as Record<string, unknown> | null };
    const assessed = { ...running, status: "completed", result: "```json\n{}\n```\n\nFull critique prose", findings, assessment: { status: "completed", sourceRevision: 1, finalRevision: 2, summary: "Added a rollback step. Kept the current naming because it matches the repository.", dispositions: [{ findingId: "F1", disposition: "accept", rationale: "Protect existing data" }, { findingId: "F2", disposition: "reject", rationale: "Matches repository convention" }] } };
    let plans = [summary()];
    let detail: Record<string, unknown> = { ...summary(), planStatus: "draft", questions: [], tasks: [], events: [], engine, proposalRevision: 1, proposal: { intendedBehavior: "Add billing" }, reviews: [running], analysisReports: [] };
    install();
    cy.intercept("GET", "**/api/worktree-plans*", (request) => request.reply({ plans })).as("plans");
    cy.intercept("GET", "**/api/worktree-plans/plan-review", (request) => request.reply(detail)).as("detail");
    cy.intercept("POST", "**/api/goal-sessions/plan-review/approve", (request) => {
      expect(request.body).to.deep.equal({ generation: 1, revision: 2 });
      detail = { ...detail, goalSessionState: "implementing", approvalRevision: 2 };
      request.reply(detail);
    }).as("approve");
    visit();
    cy.contains("An independent reviewer is checking the current proposal").should("be.visible");
    cy.findByRole("button", { name: `Resume ${GOAL}` }).click(); cy.wait("@detail");
    cy.findByRole("region", { name: "Plan review progress" }).should("contain.text", "Preparing your reviewed plan");
    cy.findByRole("button", { name: "Approve and implement" }).should("not.exist");
    cy.findByText("Reviewing your plan").should("be.visible");
    // The reviewer finishes; the planner assessment is pending. Still no action.
    cy.then(() => { detail = { ...detail, reviews: [{ ...assessed, assessment: { status: "pending", sourceRevision: 1, finalRevision: null } }] }; });
    cy.findByText("Planner is assessing the review", { timeout: 10_000 }).should("be.visible");
    cy.findByRole("button", { name: "Approve and implement" }).should("not.exist");
    cy.findByRole("radio").should("not.exist");
    // The planner publishes the assessed final revision. Only now is approval offered.
    cy.then(() => { plans = [summary({ boardState: "needs_you", plannerReviewStatus: "completed" })]; detail = { ...detail, proposalRevision: 2, proposal: { intendedBehavior: "Add billing with rollback" }, reviews: [assessed] }; });
    cy.findByRole("heading", { name: "Proposal revision 2", timeout: 10_000 }).should("be.visible");
    cy.findByText("Reviewed plan ready").should("be.visible");
    cy.findByRole("region", { name: "What changed after review" }).should("be.visible").and("contain.text", "Added a rollback step");
    cy.findByText("No down step").should("not.be.visible");
    cy.contains("summary", "Review details").should(($summary) => { expect($summary[0].getBoundingClientRect().height).to.be.at.least(44); }).click();
    cy.findByText("No down step").should("be.visible");
    cy.contains("Planner: reject · Matches repository convention").should("be.visible");
    cy.findByRole("radio").should("not.exist");
    cy.findByRole("button", { name: "Send decisions to planner" }).should("not.exist");
    cy.findByRole("button", { name: "Approve and implement" }).should("be.enabled").and(($button) => { expect($button[0].getBoundingClientRect().height).to.be.at.least(44); }).click();
    cy.wait("@approve");
    cy.findByRole("region", { name: "Goal session status" }).should("contain.text", "Implementation is continuing");
    cy.get("@approve.all").should("have.length", 1);
  });

  it("discloses a failed assessment, offers one explicit retry and keeps approval blocked", () => {
    cy.viewport(390, 844);
    const failed = { id: reviewId, kind: "planner", target: "1", status: "completed", result: "Prose", error: null, acknowledgedAt: null, findings, assessment: { status: "failed", sourceRevision: 1, finalRevision: null, error: "Provider unavailable" } };
    let detail: Record<string, unknown> = { ...summary({ boardState: "stopped", plannerReviewStatus: "failed" }), planStatus: "draft", questions: [], tasks: [], events: [], engine, proposalRevision: 1, proposal: { intendedBehavior: "Add billing" }, reviews: [failed], analysisReports: [] };
    install();
    cy.intercept("GET", "**/api/worktree-plans*", { plans: [summary({ boardState: "stopped", plannerReviewStatus: "failed" })] }).as("plans");
    cy.intercept("GET", "**/api/worktree-plans/plan-review", (request) => request.reply(detail)).as("detail");
    cy.intercept("POST", "**/api/goal-sessions/plan-review/reviews/assessment-retry", (request) => {
      expect(request.body).to.deep.equal({ reviewId });
      detail = { ...detail, reviews: [{ ...failed, assessment: { status: "pending", sourceRevision: 1, finalRevision: null } }] };
      request.reply(detail);
    }).as("retry");
    visit();
    cy.findByRole("button", { name: "Expand Stopped" }).click();
    cy.contains("Planner review or assessment needs attention").should("be.visible");
    cy.findByRole("button", { name: `Resume ${GOAL}` }).click(); cy.wait("@detail");
    cy.findByRole("button", { name: "Approve and implement" }).should("not.exist");
    cy.findByText("Planner assessment needs attention").should("be.visible");
    cy.findByText("Provider unavailable").should("be.visible");
    cy.findByRole("button", { name: "Retry planner assessment" }).click(); cy.wait("@retry");
    cy.findByText("Planner is assessing the review").should("be.visible");
    cy.findByRole("button", { name: "Retry planner assessment" }).should("not.exist");
    cy.findByRole("button", { name: "Approve and implement" }).should("not.exist");
  });
});
