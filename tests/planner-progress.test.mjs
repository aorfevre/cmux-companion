import assert from "node:assert/strict";
import test from "node:test";
import { PlannerProgress } from "../server/planner-progress.mjs";

const TRACE = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-8888-4777-8666-555555555555";

function collect(progress, traceId) {
  const seen = [];
  const detach = progress.subscribe(traceId, (event) => seen.push(event));
  return { seen, detach };
}

test("delivers an event to a live subscriber", () => {
  const progress = new PlannerProgress();
  const { seen } = collect(progress, TRACE);
  progress.publish(TRACE, { k: "tool", t: "Read server/app.mjs" });
  assert.deepEqual(seen, [{ k: "tool", t: "Read server/app.mjs" }]);
});

test("replays the buffered events to a late subscriber", () => {
  const progress = new PlannerProgress();
  progress.publish(TRACE, { k: "tool", t: "Read one.mjs" });
  progress.publish(TRACE, { k: "tool", t: "Read two.mjs" });
  const { seen } = collect(progress, TRACE);
  assert.deepEqual(seen.map((event) => event.t), ["Read one.mjs", "Read two.mjs"]);
});

test("keeps only the newest events in the replay window", () => {
  const progress = new PlannerProgress();
  for (let index = 0; index < 60; index += 1) progress.publish(TRACE, { k: "tool", t: `Read ${index}.mjs` });
  const { seen } = collect(progress, TRACE);
  assert.equal(seen.length, 40);
  assert.equal(seen[0].t, "Read 20.mjs");
  assert.equal(seen.at(-1).t, "Read 59.mjs");
});

test("never mixes two traces", () => {
  const progress = new PlannerProgress();
  const first = collect(progress, TRACE);
  const second = collect(progress, OTHER);
  progress.publish(TRACE, { k: "tool", t: "mine" });
  assert.deepEqual(first.seen.map((event) => event.t), ["mine"]);
  assert.deepEqual(second.seen, []);
});

test("ignores a trace id that is not a uuid", () => {
  const progress = new PlannerProgress();
  for (const bad of ["", "../../etc/passwd", "not-a-uuid", "x".repeat(400), null, undefined, 7]) {
    progress.publish(bad, { k: "tool", t: "leak" });
    assert.deepEqual(progress.subscribe(bad, () => { throw new Error("must not subscribe"); })(), undefined);
  }
  assert.equal(progress.traces.size, 0);
});

test("drops the oldest trace instead of growing without limit", () => {
  let clock = 1_000;
  const progress = new PlannerProgress({ now: () => (clock += 1_000) });
  // Many more traces than the cap, whatever the cap is. The property under test
  // is that the map stops growing, not the exact number it stops at.
  const published = 400;
  for (let index = 0; index < published; index += 1) {
    const id = `${String(index).padStart(8, "0")}-2222-4333-8444-555555555555`;
    progress.publish(id, { k: "tool", t: `step ${index}` });
  }
  assert.ok(progress.traces.size < published / 2, `held ${progress.traces.size} traces`);
});

test("stops sending to a detached subscriber", () => {
  const progress = new PlannerProgress();
  const { seen, detach } = collect(progress, TRACE);
  progress.publish(TRACE, { k: "tool", t: "before" });
  detach();
  progress.publish(TRACE, { k: "tool", t: "after" });
  assert.deepEqual(seen.map((event) => event.t), ["before"]);
});

test("one broken subscriber never stops another", () => {
  const progress = new PlannerProgress();
  progress.subscribe(TRACE, () => { throw new Error("that stream is gone"); });
  const { seen } = collect(progress, TRACE);
  progress.publish(TRACE, { k: "tool", t: "still delivered" });
  assert.deepEqual(seen.map((event) => event.t), ["still delivered"]);
});

test("sweeps a finished trace that nobody watches", () => {
  let clock = 1_000_000;
  const progress = new PlannerProgress({ ttlMs: 60_000, now: () => clock });
  progress.publish(TRACE, { k: "tool", t: "step" });
  progress.publish(TRACE, { k: "done" });
  assert.equal(progress.traces.size, 1, "a reconnect must still find the done event");
  clock += 30_000;
  progress.publish(OTHER, { k: "tool", t: "other" });
  assert.equal(progress.traces.has(TRACE), false, "the finished trace must be gone");
});

test("keeps a trace alive while somebody still watches it", () => {
  let clock = 1_000_000;
  const progress = new PlannerProgress({ ttlMs: 60_000, now: () => clock });
  collect(progress, TRACE);
  progress.publish(TRACE, { k: "done" });
  clock += 600_000;
  progress.publish(OTHER, { k: "tool", t: "other" });
  assert.equal(progress.traces.has(TRACE), true);
});
