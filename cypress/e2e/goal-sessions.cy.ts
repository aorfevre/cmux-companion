import { DEFAULT_MODEL_ROLES } from "../../server/model-options.mjs";

const now = "2026-09-07T12:00:00Z";
const repo = { id: "repo-goal", name: "Goal app", root: "fixture", path: "/fixture", pullRequestsAvailable: true,
  summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 },
  worktrees: [{ id: "wt", repoId: "repo-goal", path: "/fixture", name: "Goal app", branch: "main", isPrimary: true, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }], releases: [] };
const workspace = { id: "goal-workspace", title: "Goal · Billing", current_directory: "/fixture-goal", terminals: [{ id: "goal-terminal", title: "Goal conversation" }] };
const basePlan = { planId: "goal-one", repositoryId: repo.id, repositoryName: repo.name, goal: "Add billing", workflow: "goal_session", goalSessionWorkspaceId: workspace.id, goalSessionGeneration: 1, goalSessionState: "awaiting_input", proposalRevision: 0, status: "questions", round: 0, tasks: [], questions: [{ id: "q1", text: "Which payment method?", options: ["Card", "Invoice"] }] };
const proposal = { intendedBehavior: "Customers can pay by card", scope: ["Card payment form"], assumptions: ["Existing payment account"], verification: ["Try a sandbox payment"] };

function scenario(initial: Record<string, unknown> = basePlan) {
  let plan = { ...initial };
  let started = false;
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing local fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", (request) => request.reply({ connected: true, host: { mac_display_name: "Fixture Mac" }, workspaces: started ? [workspace] : [], refreshedAt: now }));
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/github-issues*", { syncedAt: null, issues: [] });
  cy.intercept("GET", "**/api/goals/capacity*", { providers: [], next: null, available: false });
  cy.intercept("GET", "**/api/goals/health", { checkedAt: now, goals: [], summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0 } });
  cy.intercept("GET", "**/api/worktree-dashboard*", { generatedAt: now, github: { status: "ready" }, summary: { repositories: 1, ...repo.summary }, repositories: [repo], orphanSessions: [] });
  cy.intercept("GET", "**/api/settings/models", { roles: DEFAULT_MODEL_ROLES, defaults: DEFAULT_MODEL_ROLES, warning: null });
  cy.intercept("GET", "**/api/worktree-plans*", { plans: [] });
  cy.intercept("GET", "**/api/terminals/goal-terminal/replay*", { text: "Visible goal conversation", grid: null });
  cy.intercept("GET", "**/api/goal-sessions/workspace/goal-workspace", (request) => request.reply({ plan })).as("goalState");
  cy.intercept("POST", "**/api/goal-sessions", (request) => {
    expect(request.body.repositoryId).to.equal(repo.id);
    expect(request.body.goal).to.equal("Add billing");
    started = true; request.reply({ statusCode: 201, body: plan });
  }).as("startGoal");
  cy.intercept("POST", "**/api/terminals/goal-terminal/input", (request) => {
    expect(request.body.text).to.equal("Card");
    plan = { ...plan, questions: [], goalSessionState: "awaiting_approval", proposalRevision: 1, proposal };
    request.reply({ ok: true });
  }).as("answer");
  cy.intercept("POST", "**/api/goal-sessions/goal-one/request-changes", (request) => {
    expect(request.body).to.deep.equal({ generation: 1, revision: 1, feedback: "Include receipts" });
    plan = { ...plan, proposalRevision: 2, proposal: { ...proposal, scope: [...proposal.scope, "Email receipts"] } };
    request.reply(plan);
  }).as("changes");
  cy.intercept("POST", "**/api/goal-sessions/goal-one/approve", (request) => {
    expect(request.body.generation).to.equal(1);
    expect(request.body.revision).to.equal(plan.proposalRevision);
    plan = { ...plan, goalSessionState: "implementing", approvalRevision: plan.proposalRevision };
    request.reply(plan);
  }).as("approval");
  return { getPlan: () => plan, setPlan: (next: Record<string, unknown>) => { plan = next; } };
}
function start() {
  cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-read-only", "false"); } });
  cy.findByRole("button", { name: "Plan a goal for Goal app" }).click();
  cy.findByLabelText("Goal").type("Add billing");
  cy.findByRole("button", { name: "Start goal session" }).click();
  cy.wait("@startGoal");
  cy.location("search").should("contain", "workspace=goal-workspace");
  cy.wait("@goalState");
}

describe("visible goal conversation", () => {
  it("opens its exact session, answers a question, revises scope and approves the latest revision", () => {
    scenario(); start();
    cy.findByText("Goal needs your answer").should("be.visible");
    cy.findByRole("button", { name: "Approve and implement" }).should("not.exist");
    cy.findByRole("textbox", { name: "Terminal input" }).type("Card");
    cy.findByRole("button", { name: "Send now" }).click(); cy.wait("@answer");
    cy.findByText("Proposal revision 1", { timeout: 6000 }).should("be.visible");
    cy.findByRole("textbox", { name: "Request proposal changes" }).type("Include receipts");
    cy.findByRole("button", { name: /^Request changes$/ }).click(); cy.wait("@changes");
    cy.findByText("Proposal revision 2").should("be.visible");
    cy.contains("Email receipts").should("be.visible");
    cy.findByRole("button", { name: "Approve and implement" }).click(); cy.wait("@approval");
    cy.findByText("Implementation is continuing in this conversation.").should("be.visible");
    cy.location("search").should("contain", "workspace=goal-workspace");
    cy.get("@startGoal.all").should("have.length", 1);
    cy.get("@approval.all").should("have.length", 1);
  });

  it("answers a durable goal question from the inbox without approving implementation", () => {
    const state = scenario();
    cy.intercept("GET", "**/api/inbox", (request) => {
      const waiting = state.getPlan().goalSessionState === "awaiting_input";
      request.reply({ items: waiting ? [{ id: "goal-question-current", requestId: "goal-question-current", type: "request", kind: "question", workspaceId: workspace.id, title: "Goal needs your answer", body: "Which payment method?", questionOptions: ["Card", "Invoice", "Write reply…"] }] : [], actionableCount: waiting ? 1 : 0, unreadCount: 0 });
    });
    cy.intercept("POST", "**/api/inbox/goal-question-current/reply", (request) => {
      expect(request.body).to.deep.equal({ kind: "question", selections: ["Card"] });
      state.setPlan({ ...state.getPlan(), questions: [], goalSessionState: "awaiting_approval", proposalRevision: 1, proposal });
      request.reply({ ok: true });
    }).as("inboxAnswer");
    start();
    cy.findByRole("button", { name: /Back/ }).click();
    cy.findByRole("button", { name: "1 item needs your attention" }).click();
    cy.findByRole("heading", { name: "Goal needs your answer" }).should("be.visible");
    cy.findByRole("button", { name: /^Card$/ }).click(); cy.wait("@inboxAnswer");
    cy.findByRole("heading", { name: "Goal needs your answer" }).should("not.exist");
    cy.get("@approval.all").should("have.length", 0);
  });

  it("recovers a failed planning turn in the recorded conversation", () => {
    const state = scenario({ ...basePlan, questions: [], goalSessionState: "planning", goalSessionError: "Provider connection failed" });
    cy.intercept("POST", "**/api/goal-sessions/goal-one/recover", (request) => {
      state.setPlan({ ...state.getPlan(), goalSessionError: null, goalSessionState: "awaiting_approval", proposalRevision: 1, proposal });
      request.reply(state.getPlan());
    }).as("recover");
    start();
    cy.contains("Provider connection failed").should("be.visible");
    cy.findByRole("button", { name: "Recover failed turn" }).click(); cy.wait("@recover");
    cy.findByText("Proposal revision 1").should("be.visible");
    cy.location("search").should("contain", "workspace=goal-workspace");
    cy.get("@startGoal.all").should("have.length", 1);
    cy.get("@approval.all").should("have.length", 0);
  });

  it("keeps stale approval rejection visible and requires review of the new proposal", () => {
    scenario({ ...basePlan, questions: [], goalSessionState: "awaiting_approval", proposalRevision: 1, proposal });
    cy.intercept("POST", "**/api/goal-sessions/goal-one/approve", { statusCode: 409, body: { error: "Proposal changed; review the latest revision" } }).as("stale");
    start();
    cy.findByRole("button", { name: "Approve and implement" }).click(); cy.wait("@stale");
    cy.findByRole("alert").should("contain.text", "Proposal changed");
    cy.wait("@goalState");
    cy.findByRole("alert").should("contain.text", "Proposal changed");
    cy.findByText("Implementation is continuing in this conversation.").should("not.exist");
  });
});
