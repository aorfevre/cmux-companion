import assert from "node:assert/strict";
import test from "node:test";
import { taskLaunchResult } from "../server/task-launch-result.mjs";
import { PlannerRuns } from "../server/planner-runs.mjs";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";

test("task launch results reject invented statuses and malformed fields", () => {
  for (const value of [null, [], { id: "t1", status: "done" }, { id: "t1", status: "launched", branch: 42 }]) assert.throws(() => taskLaunchResult(value), TypeError);
  for (const status of ["launched", "failed", "queued"]) assert.equal(taskLaunchResult({ id: "t1", status }).status, status);
});

test("planner transitions reject invented phases and snapshots cannot mutate the owner", () => {
  const runs = new PlannerRuns();
  runs.begin("goal");
  assert.throws(() => runs.setStage("goal", "launching"), /Unknown/);
  assert.throws(() => runs.finish("goal", { phase: "invented" }), /Unknown/);
  const snapshot = runs.get("goal");
  snapshot.phase = "failed";
  assert.equal(runs.get("goal").phase, "running");
  runs.finish("goal", { phase: "aborted" });
  assert.equal(runs.get("goal").phase, "aborted");
});

test("invalid launch evidence cannot partially update a durable plan", t => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  store.createPlan({ planId: "goal", repositoryId: "repo", goal: "fixture" });
  const before = store.get("goal");
  assert.throws(() => store.recordLaunch("goal", { base: "main", results: [{ id: "t1", status: "invented" }] }), /Unknown task launch status/);
  assert.deepEqual(store.get("goal"), before);
});
