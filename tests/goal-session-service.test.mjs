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
  assert.deepEqual(calls.find(([kind]) => kind === "runner").slice(1), ["workspace-goal", { planId: plan.planId, databasePath: ":memory:", generation: 1 }]);
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
  const recovered = await service.recover(planId);
  assert.equal(recovered.goalSessionWorkspaceId, "workspace-goal");
  assert.equal(restarted.length, 1);
  assert.equal(restarted[0][0], "workspace-goal");
});
