// After the independent planner review completes, the user decides on each
// finding and sends the agreed ones to the planner as one change request.
// Every request fails closed behind a 501 fixture registered first.
export {};

const now = "2026-09-09T10:00:00.000Z";
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
type Decision = { findingId: string; verdict: string; comment: string };

function summary() {
  return { planId: "plan-review", repositoryId: "repo-review", repositoryName: "cmux-e2e-cypress", goal: GOAL, status: "draft", stage: "ready", round: 1, taskCount: 0, launchedCount: 0, readyCount: 0, boardState: "needs_you", createdAt: now, updatedAt: now, launchedAt: null, workflow: "goal_session", goalType: "coding", goalSessionGeneration: 1, goalSessionState: "awaiting_approval" };
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
  cy.intercept("GET", "**/api/worktree-plans*", { plans: [summary()] }).as("plans");
}

describe("Planner review decisions", () => {
  it("agrees, disagrees, comments, sends one change request and shows the next revision", () => {
    cy.viewport(390, 844);
    const review = { id: "d".repeat(64), kind: "planner", target: "1", status: "completed", result: "```json\n{}\n```\n\nFull prose", error: null, acknowledgedAt: null, findings, decisions: [] as Decision[], decisionsSentAt: null as string | null };
    let detail = { ...summary(), planStatus: "draft", questions: [], tasks: [], events: [], engine: { provider: "claude", model: "default", effort: "default", reviewer: true }, proposalRevision: 1, proposal: { intendedBehavior: "Add billing" }, reviews: [review], analysisReports: [] };
    install();
    cy.intercept("GET", "**/api/worktree-plans/plan-review", (request) => request.reply(detail)).as("detail");
    cy.intercept("PUT", `**/api/goal-sessions/plan-review/reviews/${review.id}/decisions/*`, (request) => {
      const findingId = request.url.split("/").pop() as string;
      review.decisions = [...review.decisions.filter((decision) => decision.findingId !== findingId), { findingId, ...request.body }];
      detail = { ...detail, reviews: [{ ...review }] }; request.reply(detail);
    }).as("decide");
    cy.intercept("POST", `**/api/goal-sessions/plan-review/reviews/${review.id}/send-decisions`, (request) => {
      expect(request.body).to.deep.equal({ generation: 1, revision: 1 });
      review.decisionsSentAt = now;
      detail = { ...detail, goalSessionState: "planning", reviews: [{ ...review }] }; request.reply(detail);
    }).as("send");
    cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); window.localStorage.setItem("cmux-companion-read-only", "false"); } });
    cy.wait(["@dashboard", "@plans"]);
    cy.findByRole("button", { name: `Resume ${GOAL}` }).click(); cy.wait("@detail");
    cy.findByRole("heading", { name: "Proposal revision 1" }).should("be.visible");
    cy.findByRole("button", { name: "Send decisions to planner" }).should("be.disabled");
    cy.findByText("0 of 2 decided").should("be.visible");
    cy.findByRole("region", { name: "Suggestion for Missing rollback" }).should("be.visible").and("contain.text", "Add one");
    cy.findByText("No down step").should("not.be.visible");
    cy.findByRole("article", { name: "Missing rollback" }).within(() => {
      cy.contains("summary", "Technical details").click();
      cy.findByText("No down step").should("be.visible");
      cy.contains("summary", "Technical details").click();
      cy.findByRole("radio", { name: "Agree with Missing rollback" }).parent().should(($label) => {
        expect($label[0].getBoundingClientRect().height).to.be.at.least(44);
      });
    });
    cy.findByRole("radio", { name: "Agree with Missing rollback" }).click();
    cy.wait("@decide").its("request.body").should("deep.equal", { verdict: "agree", comment: "" });
    cy.findByText("1 of 2 decided").should("be.visible");
    cy.findByRole("textbox", { name: "Comment on Naming" }).type("Repo convention");
    cy.findByRole("radio", { name: "Disagree with Naming" }).click();
    cy.wait("@decide").its("request.body").should("deep.equal", { verdict: "disagree", comment: "Repo convention" });
    cy.findByRole("button", { name: "Send decisions to planner" }).should("be.enabled").click(); cy.wait("@send");
    cy.findByRole("region", { name: "Goal session status" }).should("contain.text", "Discovery is open");
    cy.findByText(/Decisions sent/).should("be.visible");
    cy.findByRole("button", { name: "Send decisions to planner" }).should("not.exist");
    cy.contains("Disagreed · Repo convention").should("be.visible");
    // The next revision arrives with its own review; the old one is historical.
    cy.then(() => { detail = { ...detail, goalSessionState: "awaiting_approval", proposalRevision: 2, reviews: [{ ...review, id: "e".repeat(64), target: "2", decisions: [], decisionsSentAt: null }, { ...review }] }; });
    cy.reload(); cy.wait(["@plans", "@detail"]);
    cy.findByRole("heading", { name: "Proposal revision 2" }).should("be.visible");
    cy.findByText("0 of 2 decided").should("be.visible");
    cy.contains("historical target").should("be.visible");
    cy.contains("Agreed").should("be.visible");
  });

  it("keeps send disabled when every finding is disagreed and offers approval instead", () => {
    const review = { id: "d".repeat(64), kind: "planner", target: "1", status: "completed", result: "Prose", error: null, acknowledgedAt: null, findings, decisions: findings.map((finding) => ({ findingId: finding.id, verdict: "disagree", comment: "" })), decisionsSentAt: null };
    const detail = { ...summary(), planStatus: "draft", questions: [], tasks: [], events: [], engine: { provider: "claude", model: "default", effort: "default", reviewer: true }, proposalRevision: 1, proposal: { intendedBehavior: "Add billing" }, reviews: [review], analysisReports: [] };
    install();
    cy.intercept("GET", "**/api/worktree-plans/plan-review", detail).as("detail");
    cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); window.localStorage.setItem("cmux-companion-read-only", "false"); } });
    cy.wait(["@dashboard", "@plans"]);
    cy.findByRole("button", { name: `Resume ${GOAL}` }).click(); cy.wait("@detail");
    cy.findByText("2 of 2 decided").should("be.visible");
    cy.findByText("Agree with at least one finding to send, or approve the proposal.").should("be.visible");
    cy.findByRole("button", { name: "Send decisions to planner" }).should("be.disabled");
    cy.findByRole("button", { name: "Approve and implement" }).should("be.enabled");
  });
});
