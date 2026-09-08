/* eslint-disable @typescript-eslint/no-explicit-any -- Cypress response fixtures are intentionally open JSON. */
type Json = Record<string, any>;

let taskCount = 1;
let fixtureRoot = "";
const runId = `cypress-${Date.now().toString(36)}`;
let activePlanId: string | null = null;
let reachedMerged = false;

function waitForPlan(planId: string, attempts = 120): Cypress.Chainable<Json> {
  if (attempts <= 0) throw new Error(`Planner ${planId} did not become ready`);
  return cy.request<Json>(`/api/worktree-plans/${encodeURIComponent(planId)}`).then(({ body }) => {
    const stage = body.stage || (["ready", "questions"].includes(body.status) ? body.status : null);
    if (body.running) return cy.wait(5_000).then(() => waitForPlan(planId, attempts - 1));
    if (stage === "ready" && Array.isArray(body.tasks) && body.tasks.length > 0) return body;
    if (stage === "questions") {
      return cy.request("POST", `/api/worktree-plans/${encodeURIComponent(planId)}/answers`, { answers: [], skip: true, background: true })
        .then(() => cy.wait(2_000))
        .then(() => waitForPlan(planId, attempts - 1));
    }
    throw new Error(`Planner stopped in ${stage || body.status || "an unknown state"}: ${body.runError || body.lastError || "no detail"}`);
  });
}

function refreshGoal(planId: string, wanted: string[], attempts = 120): Cypress.Chainable<Json> {
  if (attempts <= 0) throw new Error(`Goal ${planId} never reached ${wanted.join(" or ")}`);
  return cy.request("/api/goals/health")
    .then(() => cy.request<Json>("/api/worktree-plans?status=all&limit=200&health=1"))
    .then(({ body }) => {
      const plan = (body.plans || []).find((item: Json) => item.planId === planId);
      if (plan && wanted.includes(plan.boardState)) return plan;
      if (plan?.boardState === "stopped") throw new Error(`Real goal became blocked: ${plan.healthReason || plan.deliveryError || "no detail"}`);
      return cy.wait(10_000).then(() => refreshGoal(planId, wanted, attempts - 1));
    });
}

function waitForPullRequest(planId: string, attempts = 120): Cypress.Chainable<Json> {
  if (attempts <= 0) throw new Error(`Goal ${planId} never opened its pull request`);
  return cy.request<Json>("/api/worktree-plans?status=all&limit=200&health=1")
    .then(({ body }) => {
      const plan = (body.plans || []).find((item: Json) => item.planId === planId);
      if (plan?.boardState === "stopped") throw new Error(`Real goal became blocked: ${plan.healthReason || plan.deliveryError || "no detail"}`);
      if (/^https:\/\/github\.com\/aorfevre\/cmux-e2e-cypress\/pull\/\d+$/.test(plan?.boardPrUrl || "")) return plan;
      return cy.wait(10_000).then(() => waitForPullRequest(planId, attempts - 1));
    });
}

function refreshMergedGoal(planId: string, attempts = 60): Cypress.Chainable<Json> {
  if (attempts <= 0) throw new Error(`Goal ${planId} was not observed as merged`);
  return cy.request({ method: "POST", url: `/api/worktree-plans/${encodeURIComponent(planId)}/check-merge`, failOnStatusCode: false })
    .then(() => cy.request<Json>("/api/worktree-plans?status=all&limit=200&health=1"))
    .then(({ body }) => {
      const plan = (body.plans || []).find((item: Json) => item.planId === planId);
      if (plan?.boardState === "shipped") return plan;
      return cy.wait(5_000).then(() => refreshMergedGoal(planId, attempts - 1));
    });
}

function assertCardInColumn(column: string) {
  // The real dashboard performs several cmux/GitHub reads on mount. A cold
  // local refresh can outlive the normal command budget even though the API
  // and agents are healthy, so this assertion waits for the board itself.
  cy.get('section[aria-label="Goals board"]', { timeout: 90_000 }).within(() => {
    cy.findByRole("region", { name: column }).should("contain.text", runId);
  });
  cy.findAllByText(new RegExp(runId)).filter("article strong").should("have.length", 1);
}

function goalText() {
  if (taskCount === 1) return [
    `Local Cypress run ${runId}. This must be exactly one task.`,
    `Create e2e-runs/${runId}.txt containing '${runId}'.`,
    `Add one assertion for that marker under test/. Do not edit src/left.mjs or src/right.mjs.`,
    "Run npm test. This is a disposable fixture repository.",
  ].join(" ");
  return [
    `Local Cypress run ${runId}. This must be exactly two independent tasks with no dependency.`,
    `Task one owns only src/left.mjs and its matching assertion and changes leftLabel to 'left-${runId}'.`,
    `Task two owns only src/right.mjs and its matching assertion and changes rightLabel to 'right-${runId}'.`,
    "The tasks must be safe to run in parallel. Run npm test. This is a disposable fixture repository.",
  ].join(" ");
}

describe("real local goal lifecycle", { testIsolation: false }, () => {
  before(() => {
    cy.env(["taskCount", "fixtureRoot"]).then((environment) => {
      taskCount = Number(environment.taskCount || 1);
      fixtureRoot = String(environment.fixtureRoot || "");
    });
  });

  after(() => {
    // Abort and direct cmux cleanup happen in one Node task. Its finally block
    // still closes run-owned sessions when the Companion request times out.
    cy.task("cleanupLiveRun", { planId: activePlanId, runId, reachedMerged });
  });

  it("runs a real one- or two-task goal through cmux and GitHub", { defaultCommandTimeout: 30_000 }, () => {
    expect([1, 2]).to.include(taskCount);
    cy.task<string>("pairingToken").then((token) => cy.request("POST", "/api/auth/pair", { token }));

    cy.request<Json>("/api/worktree-dashboard?refresh=1").then(({ body }) => {
      const repo = (body.repositories || []).find((item: Json) => item.name === "cmux-e2e-cypress");
      expect(repo, "fixture repository under the Karven root").not.to.equal(undefined);
      expect(repo.path, "exact disposable fixture checkout").to.equal(fixtureRoot);
      return cy.request<Json>("POST", "/api/worktree-plans", {
        repositoryId: repo.id,
        goal: goalText(),
        deliveryPolicy: taskCount === 2 ? "combined" : "auto",
        // Claude is the planner only. The ready tasks are rewritten below so a
        // one-task smoke launches xcodex and a two-task smoke launches both.
        engine: { provider: "claude", model: "default", effort: "high", reviewer: false },
        background: true,
      });
    }).then(({ body }) => {
      activePlanId = body.planId;
      cy.visit("/?mode=worktrees");
      assertCardInColumn("Discovering");
      return waitForPlan(body.planId);
    }).then((draft) => {
      expect(draft.tasks, "planner task count").to.have.length(taskCount);
      const tasks = draft.tasks.map((item: Json, index: number) => ({ ...item, agent: index === 0 ? "codex" : "claude" }));
      return cy.request<Json>("PATCH", `/api/worktree-plans/${encodeURIComponent(draft.planId)}`, { tasks });
    }).then(({ body: draft }) => {
      cy.reload();
      assertCardInColumn("Needs you");
      return cy.request<Json>("POST", `/api/worktree-plans/${encodeURIComponent(draft.planId)}/launch`, {}).then(({ body }) => ({ draft, launch: body }));
    }).then(({ draft, launch }) => {
      expect(launch.launched, "real cmux sessions launched").to.equal(taskCount);
      const workspaceIds = launch.results.map((item: Json) => item.workspace?.workspace_id).filter(Boolean);
      expect(workspaceIds).to.have.length(taskCount);
      return cy.task<Json[]>("cmuxWorkspaces").then((workspaces) => {
        const live = new Set(workspaces.map((item) => item.id));
        for (const id of workspaceIds) expect(live.has(id), `workspace ${id} exists directly in cmux`).to.equal(true);
        cy.reload();
        assertCardInColumn("Building");
        return refreshGoal(draft.planId, ["in_review"]).then(() => waitForPullRequest(draft.planId));
      });
    }).then((plan) => {
      expect(plan.boardPrUrl, "goal pull request").to.match(/^https:\/\/github\.com\/aorfevre\/cmux-e2e-cypress\/pull\/\d+$/);
      cy.reload();
      assertCardInColumn("In review");
      return cy.task("mergeFixturePullRequest", { url: plan.boardPrUrl, runId }).then(() => refreshMergedGoal(plan.planId));
    }).then((plan) => {
      reachedMerged = true;
      cy.reload();
      assertCardInColumn("Shipped");
      cy.log(`Real goal ${plan.planId} traversed the Kanban and merged its fixture pull request`);
    });
  });
});
