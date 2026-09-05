import assert from "node:assert/strict";
import test from "node:test";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";
import { GoalSessionCollector } from "../server/goal-session-collector.mjs";
import { GoalMergeWatch } from "../server/goal-merge-watch.mjs";
import { GoalWatchdog } from "../server/goal-watchdog.mjs";

function fixture(t) {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const closed = [];
  const cmux = { workspaceClose: async (id) => { closed.push(id); } };
  const collector = new GoalSessionCollector({ store, cmux });
  const seed = (id, combined = false) => {
    store.createPlan({ planId: id, repositoryId: "repo", cwd: "/repo", goal: id });
    const tasks = [{ id: "t1", title: "Task", branch: `feature/${id}`, prompt: "Build", agent: "codex" }];
    if (combined) tasks.push({ ...tasks[0], id: "t2", branch: `feature/${id}-two` });
    store.recordRound(id, { round: 1, stage: "ready", tasks });
    store.recordLaunch(id, { base: "origin/main", results: [{ id: "t1", status: "launched", path: `/repo/${id}`, workspace: { workspace_id: `ws-${id}` } }] });
  };
  return { store, closed, cmux, collector, seed };
}

test("GitHub reconciliation closes a single-task goal session and preserves its PR", async (t) => {
  const { store, closed, collector, seed } = fixture(t);
  seed("delivered");
  seed("working");
  const watch = new GoalMergeWatch({ store, sessionCollector: collector, worktrees: {
    pullRequestObservations: () => ({ available: true, observations: [{ number: 12, url: "https://github.test/pull/12", state: "OPEN", headBranch: "feature/delivered" }] }),
  } });
  await watch.reconcile();
  assert.deepEqual(closed, ["ws-delivered"]);
  assert.equal(store.get("delivered").boardPrNumber, 12);
  assert.deepEqual(store.list().find((p) => p.planId === "delivered").workspaceIds, []);
  await watch.reconcile();
  assert.equal(closed.length, 1);
});

test("watchdog collects old merged goals even without active repositories or available cmux health", async (t) => {
  const { store, closed, collector, seed } = fixture(t);
  seed("old");
  store.recordGoalMerged("old", { number: 1, url: "https://github.test/pull/1" });
  for (let i = 0; i < 201; i++) seed(`active-${i}`);
  const watchdog = new GoalWatchdog({
    health: { sweep: async () => ({ sessionsAvailable: false }) },
    mergeWatch: { activeRepositoryIds: () => [], reconcile: async () => {} },
    sessionCollector: collector,
  });
  await watchdog.check();
  assert.deepEqual(closed, ["ws-old"]);
});

test("failed closes retry after restart; missing sessions retire; concurrent sweeps deduplicate", async (t) => {
  const { store, closed, cmux, collector, seed } = fixture(t);
  seed("retry");
  seed("missing");
  for (const id of ["retry", "missing"]) store.recordGoalPullRequest(id, { number: 1, state: "CLOSED" });
  cmux.workspaceClose = async (id) => { throw new Error(id === "ws-missing" ? "workspace not found" : "cmux unavailable"); };
  await collector.sweep();
  assert.equal(store.get("retry").tasks[0].sessionClosedAt, null);
  assert.ok(store.get("missing").tasks[0].sessionClosedAt);
  cmux.workspaceClose = async (id) => { closed.push(id); };
  const restarted = new GoalSessionCollector({ store, cmux });
  await Promise.all([restarted.sweep(), restarted.sweep()]);
  assert.deepEqual(closed, ["ws-retry"]);
  assert.ok(store.get("retry").tasks[0].sessionClosedAt);
});


test("a task PR does not retire a combined goal before its goal PR exists", async (t) => {
  const { store, closed, collector, seed } = fixture(t);
  seed("combined", true);
  assert.equal(store.get("combined").deliveryMode, "combined");
  const watch = new GoalMergeWatch({ store, sessionCollector: collector, worktrees: {
    pullRequestObservations: () => ({ available: true, observations: [{ number: 12, state: "OPEN", headBranch: "feature/combined" }] }),
  } });
  await watch.reconcile();
  await collector.sweep();
  assert.deepEqual(closed, []);
  assert.equal(store.get("combined").boardPrNumber, null);
});

test("a missing cmux executable does not count as an already-closed workspace", async (t) => {
  const { store, cmux, collector, seed } = fixture(t);
  seed("offline");
  store.recordGoalPullRequest("offline", { number: 1, state: "OPEN" });
  cmux.workspaceClose = async () => { throw new Error("cmux executable not found"); };
  await collector.sweep();
  assert.equal(store.get("offline").tasks[0].sessionClosedAt, null);
});
