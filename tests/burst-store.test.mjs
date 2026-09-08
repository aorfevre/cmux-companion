import assert from "node:assert/strict";
import test from "node:test";
import { BurstStore } from "../server/burst-store.mjs";
import { MAX_BURST_GOAL } from "../server/burst-contract.mjs";

const REPO_A = "repoAAAAAAAAAAAAAA";
const REPO_B = "repoBBBBBBBBBBBBBB";

function memoryStore(t) {
  const store = new BurstStore({ path: ":memory:" });
  t.after(() => store.close());
  return store;
}

test("creates a burst with one scanning candidate per repository", (t) => {
  const store = memoryStore(t);
  const burst = store.create({ burstId: "burst-1", capacitySnapshot: { next: "claude" }, repositories: [{ id: REPO_A, name: "a" }, { id: REPO_B, name: "b" }] });
  assert.equal(burst.status, "scanning");
  assert.deepEqual(burst.candidates.map((c) => [c.repositoryId, c.status]), [[REPO_A, "scanning"], [REPO_B, "scanning"]]);
  assert.deepEqual(burst.capacitySnapshot, { next: "claude" });
});

test("a proposal moves a candidate to proposed; a failure records its reason", (t) => {
  const store = memoryStore(t);
  store.create({ burstId: "burst-1", repositories: [{ id: REPO_A, name: "a" }, { id: REPO_B, name: "b" }] });
  store.recordProposal("burst-1", REPO_A, { goal: "Cover the store", rationale: "No tests", evidence: ["server/x.mjs"], sizeEstimate: "medium" });
  store.recordFailure("burst-1", REPO_B, "Invalid JSON");
  const burst = store.get("burst-1");
  assert.equal(burst.status, "ready");
  const a = burst.candidates.find((c) => c.repositoryId === REPO_A);
  assert.equal(a.status, "proposed");
  assert.equal(a.goal, "Cover the store");
  assert.deepEqual(a.evidence, ["server/x.mjs"]);
  const b = burst.candidates.find((c) => c.repositoryId === REPO_B);
  assert.equal(b.status, "failed");
  assert.equal(b.reason, "Invalid JSON");
});

test("approve stores the plan id once; a second approve keeps the first", (t) => {
  const store = memoryStore(t);
  store.create({ burstId: "burst-1", repositories: [{ id: REPO_A, name: "a" }] });
  store.recordProposal("burst-1", REPO_A, { goal: "g", rationale: "r", evidence: [], sizeEstimate: "small" });
  const first = store.recordApproval("burst-1", REPO_A, { planId: "plan-1", goal: "g edited" });
  assert.equal(first.status, "approved");
  assert.equal(first.planId, "plan-1");
  assert.equal(first.goal, "g edited");
  assert.throws(() => store.recordApproval("burst-1", REPO_A, { planId: "plan-2", goal: "g" }), /already approved/);
  assert.equal(store.get("burst-1").status, "closed");
});

test("decline and rescan change one candidate only", (t) => {
  const store = memoryStore(t);
  store.create({ burstId: "burst-1", repositories: [{ id: REPO_A, name: "a" }, { id: REPO_B, name: "b" }] });
  store.recordProposal("burst-1", REPO_A, { goal: "g", rationale: "r", evidence: [], sizeEstimate: "small" });
  store.recordFailure("burst-1", REPO_B, "boom");
  assert.equal(store.recordDecline("burst-1", REPO_A).status, "declined");
  assert.equal(store.resetForScan("burst-1", REPO_B).status, "scanning");
  const burst = store.get("burst-1");
  assert.equal(burst.status, "scanning");
  assert.equal(burst.candidates.find((c) => c.repositoryId === REPO_A).status, "declined");
});

test("list is newest first and unknown ids return null", (t) => {
  const store = memoryStore(t);
  store.create({ burstId: "burst-1", repositories: [{ id: REPO_A, name: "a" }] });
  store.create({ burstId: "burst-2", repositories: [{ id: REPO_A, name: "a" }] });
  assert.deepEqual(store.list().map((b) => b.burstId), ["burst-2", "burst-1"]);
  assert.equal(store.get("nope"), null);
});

test("a stale scan result never overwrites a candidate that already settled", (t) => {
  const store = memoryStore(t);
  store.create({ burstId: "burst-1", repositories: [{ id: REPO_A, name: "a" }] });
  store.recordProposal("burst-1", REPO_A, { goal: "first", rationale: "r" });
  store.recordDecline("burst-1", REPO_A);
  assert.throws(() => store.recordProposal("burst-1", REPO_A, { goal: "late", rationale: "r" }), /cannot move to proposed/);
  assert.throws(() => store.recordFailure("burst-1", REPO_A, "late"), /cannot move to failed/);
  const candidate = store.get("burst-1").candidates[0];
  assert.equal(candidate.status, "declined");
  assert.equal(candidate.goal, "first");
});

test("a duplicate repository is a typed error and running lists scanning bursts", (t) => {
  const store = memoryStore(t);
  assert.throws(() => store.create({ burstId: "burst-1", repositories: [{ id: REPO_A, name: "a" }, { id: REPO_A, name: "a" }] }), TypeError);
  assert.equal(store.list().length, 0);
  store.create({ burstId: "burst-1", repositories: [{ id: REPO_A, name: "a" }, { id: REPO_B, name: "b" }] });
  store.create({ burstId: "burst-2", repositories: [{ id: REPO_A, name: "a" }] });
  store.recordProposal("burst-2", REPO_A, { goal: "g", rationale: "r" });
  assert.deepEqual(store.running(), ["burst-1"]);
  assert.deepEqual(store.strandedScanning(), [{ burstId: "burst-1", repositoryId: REPO_A }, { burstId: "burst-1", repositoryId: REPO_B }]);
});

test("an approved goal is capped at the goal session limit", (t) => {
  const store = memoryStore(t);
  store.create({ burstId: "burst-1", repositories: [{ id: REPO_A, name: "a" }] });
  store.recordProposal("burst-1", REPO_A, { goal: "g", rationale: "r" });
  assert.equal(store.recordApproval("burst-1", REPO_A, { planId: "plan-1", goal: "x".repeat(5_000) }).goal.length, MAX_BURST_GOAL);
});
