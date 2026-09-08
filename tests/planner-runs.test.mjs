import assert from "node:assert/strict";
import test from "node:test";
import { PlannerRuns } from "../server/planner-runs.mjs";

function clock(start = 1_000) {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

test("a round starts in a validated stage, carries its kind, and moves through stages while live", () => {
  const time = clock();
  const runs = new PlannerRuns({ now: time.now });
  runs.begin("plan-1", "answer", { stage: "discussing" });
  assert.deepEqual(runs.get("plan-1"), { planId: "plan-1", kind: "answer", phase: "running", stage: "discussing", step: "", error: "", startedAt: 1_000, finishedAt: null, at: 1_000 });
  assert.throws(() => runs.begin("plan-2", "plan", { stage: "launching" }), /Unknown planner run stage launching/);
  assert.equal(runs.get("plan-2"), null, "an invalid stage never creates a run");
  time.advance(10);
  runs.setStage("plan-1", "review_spec");
  runs.step("plan-1", `${"x".repeat(200)}`);
  const live = runs.get("plan-1");
  assert.equal(live.stage, "review_spec");
  assert.equal(live.step.length, 120);
  assert.equal(live.at, 1_010);
  assert.equal(runs.isRunning("plan-1"), true);
});

test("a blank plan id is ignored and unknown ids are no-ops for every mutation", () => {
  const runs = new PlannerRuns();
  runs.begin("", "plan");
  runs.begin(null);
  assert.deepEqual(runs.list(), []);
  runs.setStage("missing", "review_spec");
  runs.step("missing", "text");
  runs.finish("missing", { phase: "failed" });
  assert.equal(runs.isRunning("missing"), false);
  assert.equal(runs.get(undefined), null);
});

test("a finished run freezes its step and stage, clamps its error, then expires after the TTL", () => {
  const time = clock();
  const runs = new PlannerRuns({ ttlMs: 500, now: time.now });
  runs.begin("plan-1");
  runs.step("plan-1", "writing");
  time.advance(5);
  runs.finish("plan-1", { phase: "failed", error: "e".repeat(500) });
  runs.step("plan-1", "late");
  runs.setStage("plan-1", "discussing");
  const finished = runs.get("plan-1");
  assert.equal(finished.step, "writing");
  assert.equal(finished.stage, "writing_spec");
  assert.equal(finished.error.length, 400);
  assert.equal(finished.finishedAt, 1_005);
  assert.equal(runs.isRunning("plan-1"), false);
  time.advance(500);
  assert.equal(runs.get("plan-1").phase, "failed", "still visible until the TTL passes");
  time.advance(1);
  assert.equal(runs.get("plan-1"), null);
  assert.deepEqual(runs.list(), []);
});

test("finish defaults to done with an empty error and rejects a null error gracefully", () => {
  const runs = new PlannerRuns();
  runs.begin("plan-1");
  runs.finish("plan-1", { error: null });
  assert.equal(runs.get("plan-1").phase, "done");
  assert.equal(runs.get("plan-1").error, "");
  runs.begin("plan-2");
  runs.finish("plan-2");
  assert.equal(runs.get("plan-2").phase, "done");
});

test("the registry evicts only the oldest finished run once it is full, and never a live one", () => {
  const time = clock();
  const runs = new PlannerRuns({ now: time.now });
  for (let index = 0; index < 200; index += 1) {
    runs.begin(`plan-${index}`);
    time.advance(1);
  }
  runs.finish("plan-7");
  runs.finish("plan-3");
  runs.begin("plan-new");
  assert.equal(runs.runs.size, 200);
  assert.equal(runs.get("plan-3"), null, "the finished run that began earliest is evicted");
  assert.equal(runs.get("plan-7").phase, "done");
  assert.equal(runs.get("plan-new").phase, "running");

  // With every run live nothing is evicted, and the newest still registers.
  const full = new PlannerRuns({ now: time.now });
  for (let index = 0; index < 200; index += 1) full.begin(`live-${index}`);
  full.begin("live-extra");
  assert.equal(full.runs.size, 201);
  assert.equal(full.list().every((run) => run.phase === "running"), true);
});

test("list returns detached copies and clear drops every run after a restart", () => {
  const runs = new PlannerRuns();
  runs.begin("plan-1");
  runs.begin("plan-2", "answer", { stage: "discussing" });
  const listed = runs.list();
  assert.deepEqual(listed.map((run) => run.planId), ["plan-1", "plan-2"]);
  listed[0].phase = "failed";
  assert.equal(runs.get("plan-1").phase, "running");
  runs.clear();
  assert.deepEqual(runs.list(), []);
  assert.equal(runs.isRunning("plan-2"), false);
});
