import assert from "node:assert/strict";
import test from "node:test";

import { GoalSessionService } from "../server/goal-session-service.mjs";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";

test("starts one managed workspace and persists its uploaded goal context", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const calls = [];
  const service = new GoalSessionService({
    store,
    modelSettings: { roles: undefined },
    worktrees: {
      resolveRepository: async (id) => ({ id, name: "sample", primaryPath: "/repo/sample" }),
      create: async (id, options) => { calls.push(["create", id, options]); return { worktree: { path: "/repo/sample-goal" } }; },
    },
    cmux: {
      workspaceListDetailed: async () => ({ workspaces: [] }),
      workspaceCreate: async (options) => { calls.push(["workspace", options]); return { workspace_id: "workspace-goal" }; },
      workspaceStartGoalSessionRunner: async (id, options) => { calls.push(["runner", id, options]); },
    },
  });

  const plan = await service.start({
    repositoryId: "repo-1",
    goal: "Implement billing",
    images: [{ path: "/attachments/reference.png", name: "reference.png" }],
  });

  assert.equal(plan.workflow, "goal_session");
  assert.equal(plan.goalSessionWorkspaceId, "workspace-goal");
  assert.deepEqual(plan.images, [{ path: "/attachments/reference.png", name: "reference.png" }]);
  assert.equal(calls.filter(([kind]) => kind === "create").length, 1);
  const runner = calls.find(([kind]) => kind === "runner").slice(1);
  assert.equal(runner[0], "workspace-goal");
  assert.deepEqual({ planId: runner[1].planId, databasePath: runner[1].databasePath, generation: runner[1].generation }, { planId: plan.planId, databasePath: ":memory:", generation: 1 });
  assert.match(runner[1].dispatchId, /^[0-9a-f-]{36}$/);
});

test("rejects malformed goal-session image references before creating a worktree", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  let created = false;
  const service = new GoalSessionService({
    store,
    modelSettings: { roles: undefined },
    worktrees: { resolveRepository: async () => ({ id: "repo-1", name: "sample", primaryPath: "/repo/sample" }), create: async () => { created = true; } },
    cmux: {},
  });
  await assert.rejects(() => service.start({ repositoryId: "repo-1", goal: "Implement billing", images: [{ name: "missing path" }] }), /file path/);
  assert.equal(created, false);
});

test("records the worktree before cmux creates a workspace and recovers the exact workspace", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const calls = [];
  let pathAtWorkspaceCreate = null;
  const service = new GoalSessionService({
    store, modelSettings: { roles: undefined }, processAlive: () => false,
    worktrees: {
      resolveRepository: async (id) => ({ id, name: "sample", primaryPath: "/repo/sample" }),
      create: async (_id, options) => { calls.push(options); return { worktree: { path: "/repo/managed-goal" } }; },
    },
    cmux: {
      workspaceListDetailed: async () => ({ workspaces: [] }),
      workspaceCreate: async () => { pathAtWorkspaceCreate = store.list({ limit: 1 })[0]?.planId ? store.get(store.list({ limit: 1 })[0].planId)?.goalSessionWorktreePath : null; return { workspace_id: "workspace-goal" }; },
      workspaceStartGoalSessionRunner: async () => { throw new Error("runner transport failed"); },
    },
  });
  let planId = null;
  await assert.rejects(() => service.start({ repositoryId: "repo-1", goal: "Implement billing" }), (error) => { planId = error.planId; return /runner transport failed/.test(error.message); });
  assert.equal(pathAtWorkspaceCreate, "/repo/managed-goal");
  assert.equal(calls[0].useDefaultBase, true);
  const failed = store.get(planId);
  assert.equal(failed.goalSessionWorkspaceId, "workspace-goal");

  const restarted = [];
  service.cmux.workspaceStartGoalSessionRunner = async (...args) => { restarted.push(args); };
  await assert.rejects(() => service.recover(planId), /still uncertain/);
  // The cmux transport failure could have delivered the command, so ordinary
  // recovery refuses another writer. This simulates an operator proving it
  // never reached cmux before clearing the dispatch record.
  const dispatchId = store.get(planId).goalSessionRunnerDispatchId;
  assert.ok(dispatchId);
  store.releaseGoalSessionRunnerDispatch(planId, { generation: 1, dispatchId });
  const recovered = await service.recover(planId);
  assert.equal(recovered.goalSessionWorkspaceId, "workspace-goal");
  assert.equal(restarted.length, 1);
  assert.equal(restarted[0][0], "workspace-goal");
});

test("recovery queues a failed turn for its live owner without starting another runner", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  store.createPlan({ planId: "managed-plan", repositoryId: "repo", goal: "Ship billing" });
  store.reserveGoalSession("managed-plan", { branch: "goal-session/managed", generation: 1 });
  store.recordGoalSessionStart("managed-plan", { worktreePath: "/repo/managed", workspaceId: "workspace-managed", generation: 1 });
  store.publishProposal("managed-plan", { generation: 1, providerSessionId: "provider", proposal: { intendedBehavior: "Ship billing" } });
  store.requestProposalChanges("managed-plan", { generation: 1, revision: 1, feedback: "Keep exports stable." });
  store.consumeGoalSessionInput("managed-plan", { generation: 1 });
  store.recordGoalSessionInputFailure("managed-plan", { generation: 1, error: "provider timed out" });
  const dispatchId = "00000000-0000-4000-8000-000000000010";
  store.claimGoalSessionRunnerDispatch("managed-plan", { generation: 1, dispatchId });
  store.claimGoalSessionRunner("managed-plan", { generation: 1, dispatchId, pid: process.pid });
  let started = false;
  const service = new GoalSessionService({
    store, modelSettings: { roles: undefined }, processAlive: () => true,
    worktrees: {}, cmux: { workspaceStartGoalSessionRunner: async () => { started = true; } },
  });
  const recovered = await service.recover("managed-plan");
  assert.equal(started, false);
  assert.equal(recovered.goalSessionActiveInput, null);
  assert.equal(recovered.goalSessionPendingInput, "Keep exports stable.");
  assert.equal(recovered.goalSessionError, null);
});

test("restarts aborted discovery once, retaining context and moving GitHub ownership", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  let created = 0;
  const service = new GoalSessionService({ store, worktrees: {
    resolveRepository: async (id) => ({ id, name: "sample", primaryPath: "/repo/sample" }),
    create: async () => { created++; return { worktree: { path: "/repo/restarted" } }; },
  }, cmux: { workspaceListDetailed: async () => ({ workspaces: [] }), workspaceCreate: async () => ({ workspace_id: "fresh" }), workspaceStartGoalSessionRunner: async () => {} } });
  const source = store.createPlan({ planId: "old", repositoryId: "repo", goal: "Fix issue eight", issueNumbers: [8], issueUrls: ["https://github.com/example/sample/issues/8"], images: [{ path: "/attachments/shot.png", name: "shot.png" }], engine: { provider: "codex", model: "gpt-5.4", effort: "high", reviewer: true }, specOptions: { unitTests: true, edgeCases: true }, reviewOptions: { codeReview: true } });
  await assert.rejects(() => service.restart("old"), /Abort the old goal/);
  assert.equal(created, 0);
  assert.equal(store.get("old").issuesReturnedAt, null);
  store.recordGoalAborted("old");
  const [first, repeated] = await Promise.all([service.restart("old"), service.restart("old")]);
  assert.equal(first.planId, repeated.planId);
  assert.equal(created, 1);
  assert.equal((await service.restart("old")).planId, first.planId);
  assert.equal(created, 1);
  assert.equal(first.workflow, "goal_session");
  for (const key of ["goal", "images", "specOptions", "issueNumbers", "issueUrls"]) assert.deepEqual(first[key], source[key]);
  assert.deepEqual(first.engine, source.engine);
  assert.equal(first.reviewOptions.codeReview, true);
  assert.equal(store.get("old").boardStatus, "aborted");
  assert.ok(store.get("old").issuesReturnedAt);
  assert.throws(() => store.createPlan({ planId: "duplicate", repositoryId: "repo", goal: "Duplicate", issueNumbers: [8] }), /already belongs/);
});

test("restart refuses live discovery owners and retains failed successors for recovery", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  let attempts = 0;
  const service = new GoalSessionService({ store, worktrees: {
    resolveRepository: async (id) => ({ id, name: "sample", primaryPath: "/repo/sample" }),
    create: async () => { attempts++; throw new Error("Checkout failed"); },
  }, cmux: { workspaceListDetailed: async () => ({ workspaces: [] }) } });
  store.createPlan({ planId: "old", repositoryId: "repo", goal: "Retry discovery" });
  store.reserveGoalSession("old", { branch: "old", generation: 1 });
  store.recordGoalSessionStart("old", { worktreePath: "/repo/old", workspaceId: "old-workspace", generation: 1 });
  store.recordGoalAborted("old");
  service.cmux.workspaceListDetailed = async () => ({ workspaces: [{ id: "old-workspace" }] });
  await assert.rejects(() => service.restart("old"), /Close the old discovery workspace/);
  assert.equal(attempts, 0);
  service.cmux.workspaceListDetailed = async () => ({ workspaces: [] });
  let failedId;
  await assert.rejects(() => service.restart("old"), (error) => { failedId = error.planId; return /Checkout failed/.test(error.message); });
  const saved = await service.restart("old");
  assert.equal(saved.planId, failedId);
  assert.match(saved.goalSessionError, /Checkout failed/);
  assert.equal(attempts, 1);
});

test("restart refuses terminal completions, development tasks and live runner PIDs", async () => {
  for (const [source, message] of [
    [{ boardStatus: "merged" }, /Abort the old goal/],
    [{ boardStatus: "aborted", tasks: [{ id: "T1", worktreePath: "/repo/task" }] }, /before development tasks/],
    [{ boardStatus: "aborted", status: "launched" }, /before development tasks/],
    [{ planId: "old", boardStatus: "aborted", goalSessionRunnerPid: 123 }, /still active/],
  ]) {
    const service = new GoalSessionService({ store: { get: (id) => id === "old" ? source : null }, worktrees: {}, cmux: {}, processAlive: () => true });
    await assert.rejects(() => service.restart("old"), message);
  }
});

test("continuing legacy discovery stops it once and preserves its full unapproved context", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" }); t.after(() => store.close());
  const source = store.createPlan({ planId: "legacy", repositoryId: "repo", goal: "Fix the old issue", images: [{ path: "/images/context.png", name: "context.png" }], issueNumbers: [8], engine: { provider: "codex", model: "gpt-6-astra", effort: "high", reviewer: true } });
  store.recordRound("legacy", { round: 1, stage: "ready", spec: { outcome: "Saved outcome" }, tasks: [{ id: "T1", title: "Saved task", branch: "old/t1", prompt: "Saved instructions", agent: "codex" }] });
  store.recordDiscussion("legacy", { question: "Keep history?", answer: "Yes", contractImpact: "none", round: 1 });
  let stopped = 0, started = 0;
  const service = new GoalSessionService({ store, worktrees: { resolveRepository: async (id) => ({ id, name: "Repo", primaryPath: "/repo" }), create: async () => { started++; return { worktree: { path: "/repo-new" } }; } }, cmux: { workspaceListDetailed: async () => ({ workspaces: [] }), workspaceCreate: async () => ({ workspace_id: "new" }), workspaceStartGoalSessionRunner: async () => {} }, stopGoal: async (id) => { stopped++; store.recordGoalAborted(id); return { failedSessionIds: [] }; } });
  const next = await service.continueDiscovery("legacy");
  assert.equal(next.workflow, "goal_session"); assert.equal(next.approvalRevision, null);
  assert.equal(next.discoveryContext.sourcePlanId, "legacy");
  assert.equal(next.discoveryContext.spec.outcome, "Saved outcome");
  assert.equal(next.discoveryContext.tasks[0].title, "Saved task");
  assert.equal(next.discoveryContext.discussion[0].answer, "Yes");
  assert.deepEqual(next.images, source.images); assert.deepEqual(next.issueNumbers, [8]);
  assert.equal(next.engine.reviewer, true);
  assert.equal(store.get("legacy").boardStatus, "aborted");
  assert.equal((await service.continueDiscovery("legacy")).planId, next.planId);
  assert.equal((await service.continueDiscovery(next.planId)).planId, next.planId);
  assert.equal(stopped, 1); assert.equal(started, 1);
});

test("failed stop never creates another writer or releases issue ownership", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" }); t.after(() => store.close());
  store.createPlan({ planId: "legacy", repositoryId: "repo", goal: "Keep work", issueNumbers: [8] });
  const service = new GoalSessionService({ store, worktrees: { resolveRepository: async () => ({ id: "repo" }), create: () => { throw new Error("Must not create"); } }, cmux: {}, stopGoal: async () => ({ failedSessionIds: ["old"] }) });
  await assert.rejects(() => service.continueDiscovery("legacy"), /could not be stopped/);
  assert.equal(store.get("legacy").issuesReturnedAt, null);
  assert.equal(store.list().length, 1);
});

test("start persists burst and includes it in the idempotency identity", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const service = new GoalSessionService({
    store, modelSettings: { roles: undefined },
    worktrees: { resolveRepository: async (id) => ({ id, name: "sample", primaryPath: "/repo/sample" }), create: async () => ({ worktree: { path: "/repo/sample-goal" } }) },
    cmux: { workspaceListDetailed: async () => ({ workspaces: [] }), workspaceCreate: async () => ({ workspace_id: "ws" }), workspaceStartGoalSessionRunner: async () => {} },
  });
  const key = "11111111-1111-4111-8111-111111111111";
  const plan = await service.start({ repositoryId: "repo-1", goal: "Burst it", burst: true, idempotencyKey: key });
  assert.equal(plan.burst, true);
  await assert.rejects(() => service.start({ repositoryId: "repo-1", goal: "Burst it", burst: false, idempotencyKey: key }), /belongs to a different goal/);
});
