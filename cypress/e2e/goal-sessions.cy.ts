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
  cy.intercept("GET", "**/api/worktree-plans*", (request) => request.reply({ plans: started ? [{ ...plan, status: "draft", stage: "questions", taskCount: 0, launchedCount: 0, createdAt: now, updatedAt: now }] : [] }));
  cy.intercept("GET", "**/api/worktree-plans/goal-one", (request) => request.reply(plan));
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
    // Companion sends the approval to the conversation itself; the user never types "continue".
    plan = { ...plan, goalSessionState: "implementing", approvalRevision: plan.proposalRevision, transitionStatus: "sent", approvalDelivery: { status: "sent", reason: null } };
    request.reply(plan);
  }).as("approval");
  cy.intercept("POST", "**/api/goal-sessions/goal-one/resend-approval", (request) => {
    plan = { ...plan, transitionStatus: "sent", approvalDelivery: { status: "sent", reason: null } };
    request.reply(plan);
  }).as("resend");
  return { setStarted: () => { started = true; }, getPlan: () => plan, setPlan: (next: Record<string, unknown>) => { plan = next; } };
}
function start() {
  cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-read-only", "false"); } });
  cy.findByRole("button", { name: "Plan a goal for Goal app" }).click();
  cy.findByLabelText("Goal").type("Add billing");
  cy.findByRole("button", { name: "Start goal session" }).click();
  cy.wait("@startGoal");
  cy.location("search").should("not.contain", "workspace=");
  cy.contains("Goal session started in cmux for Goal app.").should("be.visible");
  cy.findByRole("button", { name: "Expand Stopped" }).click();
  cy.findByRole("button", { name: "Resume Add billing" }).click();
  cy.findByRole("button", { name: "Open conversation" }).click();
  cy.location("search").should("contain", "workspace=goal-workspace");
  cy.wait("@goalState");
}

describe("visible goal conversation", () => {
  for (const width of [390, 1280]) it(`keeps a long proposal readable and its decision controls reachable at ${width}px`, () => {
    cy.viewport(width, 900);
    scenario({ ...basePlan, questions: [], goalSessionState: "awaiting_approval", proposalRevision: 1, proposal: {
      ...proposal,
      scope: Array.from({ length: 12 }, (_, index) => `Scope item ${index + 1}: Preserve saved preferences and show the resulting behavior clearly in the conversation and board.`),
      exclusions: ["No automatic merge or deployment"],
      acceptanceCriteria: [{ text: "The customer receives a receipt", verification: "Complete a sandbox payment and inspect the receipt" }],
    } });
    cy.visit("/?plan=goal-one");
    cy.findByRole("heading", { name: "Proposal revision 1" }).should("be.visible");
    cy.findByRole("region", { name: "Proposal details" }).as("details").should("be.visible").then(($region) => {
      expect($region[0].scrollHeight).to.be.greaterThan($region[0].clientHeight);
      expect($region[0].scrollWidth).to.be.at.most($region[0].clientWidth);
    });
    cy.get("@details").find("li").should("have.length", 16);
    cy.findByRole("button", { name: "Approve and implement" }).should("be.visible");
    cy.findByRole("button", { name: "Approve and implement" }).scrollIntoView();
    cy.screenshot(`proposal-review-${width}`, { capture: "viewport" });
    cy.get("@details").scrollTo("bottom");
    cy.contains("How to verify").should("be.visible");
    cy.findByRole("button", { name: "Approve and implement" }).should("be.visible");
    cy.get("@approval.all").should("have.length", 0);
  });

  it("keeps discovery on the board and labels a published proposal ready for review", () => {
    const state = scenario({ ...basePlan, goalSessionState: "planning", questions: [] });
    cy.intercept("GET", "**/api/worktree-plans*", (request) => request.reply({ plans: [{ ...state.getPlan(), status: "draft", stage: "questions", taskCount: 0, launchedCount: 0, createdAt: now, updatedAt: now }] }));
    cy.visit("/?mode=worktrees");
    cy.contains("Discovery is open in the conversation").should("be.visible");
    cy.contains("Planning stopped before it produced anything").should("not.exist");
    cy.then(() => state.setPlan({ ...state.getPlan(), goalSessionState: "awaiting_approval", proposalRevision: 1, proposal }));
    cy.reload();
    cy.contains("The contract waits for your approval").should("be.visible");
    cy.screenshot("native-goal-review-ready", { capture: "viewport" });
    cy.contains("Ready to launch").should("not.exist");
  });

  it("keeps native discovery open after exit and resumes the recorded conversation", () => {
    const state = scenario({ ...basePlan, questions: [], goalSessionState: "planning", goalSessionError: null, goalSessionRunnerPid: null, goalSessionRunnerDispatchId: null });
    cy.intercept("POST", "**/api/goal-sessions/goal-one/recover", (request) => {
      state.setPlan({ ...state.getPlan(), goalSessionRunnerPid: 123 });
      request.reply(state.getPlan());
    }).as("resumeNative");
    start();
    cy.contains("Conversation closed. Discovery and saved proposals are preserved.").should("be.visible");
    cy.screenshot("native-goal-discovery-resume", { capture: "viewport" });
    cy.findByRole("button", { name: "Recover failed turn" }).should("not.exist");
    cy.findByRole("button", { name: "Approve and implement" }).should("not.exist");
    cy.findByRole("button", { name: "Resume conversation" }).click();
    cy.wait("@resumeNative");
    cy.findByRole("button", { name: "Resume conversation" }).should("not.exist");
    cy.contains("Discovery is open in the interactive conversation.").should("be.visible");
    cy.location("search").should("contain", "workspace=goal-workspace");
    cy.get("@startGoal.all").should("have.length", 1);
    cy.get("@approval.all").should("have.length", 0);
  });

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
    cy.findByText("Approval sent. The agent is starting the implementation.").should("be.visible");
    cy.findByRole("button", { name: "Send approval again" }).should("not.exist");
    cy.get("@resend.all").should("have.length", 0);
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
    cy.findByRole("button", { name: "Inbox · 1" }).click();
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

describe("one discovery process", () => {
  for (const width of [390, 1280]) it(`continues a stopped legacy goal in its native successor at ${width}px`, () => {
    cy.viewport(width, 900);
    const state = scenario({ ...basePlan, questions: [], goalSessionState: "planning" });
    cy.intercept("GET", "**/api/worktree-plans/old-goal", { planId: "old-goal", repositoryId: repo.id, repositoryName: repo.name, goal: "Add billing", status: "questions", round: 0, tasks: [], questions: [], lastError: "Old proxy failed" });
    cy.intercept("POST", "**/api/goal-sessions/old-goal/continue", (request) => {
      expect(request.body).to.deep.equal({}); state.setStarted(); request.reply(state.getPlan());
    }).as("continueDiscovery");
    cy.visit("/?plan=old-goal");
    cy.findByRole("button", { name: "Continue discovery" }).should("be.visible");
    cy.findByRole("button", { name: "Plan this goal again" }).should("not.exist");
    cy.get("@continueDiscovery.all").should("have.length", 0);
    cy.findByRole("button", { name: "Continue discovery" }).click(); cy.wait("@continueDiscovery");
    cy.location("search").should("not.contain", "workspace=");
    cy.findByRole("dialog").should("not.exist");
    cy.contains("Opened interactive discovery. Previous context remains saved.").should("be.visible");
    cy.get("@startGoal.all").should("have.length", 0);
    cy.get("@continueDiscovery.all").should("have.length", 1);
    cy.screenshot(`unified-discovery-${width}`, { capture: "viewport" });
  });
  it("shows why an approval was not sent and resends it from the goal at 390px", () => {
    cy.viewport(390, 844);
    const state = scenario({ ...basePlan, questions: [], goalSessionState: "implementing", proposalRevision: 1, approvalRevision: 1, proposal, transitionStatus: "pending", approvalDelivery: { status: "pending", reason: "The agent conversation is closed. Resume it, then send the approval again" } });
    cy.intercept("GET", "**/api/worktree-plans*", (request) => request.reply({ plans: [{ ...state.getPlan(), status: "launched", stage: "ready", taskCount: 1, launchedCount: 1, readyCount: 0, boardState: "needs_you", createdAt: now, updatedAt: now }] }));
    cy.visit("/?mode=worktrees");
    cy.contains("Approval not sent yet: The agent conversation is closed").should("be.visible");
    cy.findByRole("button", { name: "View Add billing" }).click();
    cy.findByRole("button", { name: "Send approval again" }).should("be.visible").and(($button) => { expect($button[0].getBoundingClientRect().height).to.be.at.least(44); }).click();
    cy.wait("@resend");
    cy.findByText("Approval sent. The agent is starting the implementation.").should("be.visible");
    cy.findByRole("button", { name: "Send approval again" }).should("not.exist");
  });
});
