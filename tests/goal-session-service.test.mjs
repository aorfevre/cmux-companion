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
