import assert from "node:assert/strict";
import test from "node:test";
import { BurstStore } from "../server/burst-store.mjs";
import { BURST_RESTARTED, BurstService } from "../server/burst-service.mjs";

const REPO_A = "repoAAAAAAAAAAAAAA";
const REPO_B = "repoBBBBBBBBBBBBBB";
const PLAIN = "repoPPPPPPPPPPPPPP";

const REPO_C = "repoCCCCCCCCCCCCCC";

const account = (remainingPercent) => ({ status: "ready", windows: [{ category: "usage", remainingPercent }] });
const CLAUDE_ONLY = { providers: [{ id: "claude", available: true, accounts: [account(60)] }] };

function harness(t, { proposals = {}, failures = {}, repositories = null, usage = null, scan = null, concurrency = 1, store = null, start = null } = {}) {
  store ||= new BurstStore({ path: ":memory:" });
  t.after(() => store.close());
  const scans = [];
  const starts = [];
  const logs = [];
  // Mutable so a test can un-star a repository, or break the dashboard, while
  // a scan is in flight. The read happens after a tick so the mutation lands.
  const starred = { error: null, list: repositories || [
    { id: REPO_A, name: "a", path: "/r/a", favorite: true, archived: false },
    { id: REPO_B, name: "b", path: "/r/b", favorite: true, archived: false },
    { id: PLAIN, name: "p", path: "/r/p", favorite: false, archived: false },
  ] };
  const service = new BurstService({
    store,
    worktrees: { snapshot: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      if (starred.error) throw starred.error;
      return { repositories: starred.list };
    } },
    scanner: { scan: async ({ repository, provider }) => {
      scans.push({ id: repository.id, provider });
      if (scan) return scan({ repository, provider });
      if (failures[repository.id]) throw new Error(failures[repository.id]);
      return proposals[repository.id] || { goal: `Goal for ${repository.name}`, rationale: "because", evidence: ["README.md"], sizeEstimate: "small" };
    } },
    goalSessions: { start: async (input) => { starts.push(input); if (start) return start(input); return { planId: `plan-${starts.length}` }; } },
    accountUsage: { snapshot: async () => usage || CLAUDE_ONLY },
    concurrency,
    log: { warn: (...args) => logs.push(args), debug: () => {} },
  });
  return { store, service, scans, starts, starred, logs };
}

const proposal = { goal: "g", rationale: "r", evidence: [], sizeEstimate: "small" };

test("create writes one scanning candidate per starred repository and scans in the background", async (t) => {
  const { service, scans } = harness(t);
  const created = await service.create();
  assert.equal(created.status, "scanning");
  assert.deepEqual(created.candidates.map((c) => c.repositoryId), [REPO_A, REPO_B]);
  await service.settled(created.burstId);
  const burst = service.get(created.burstId);
  assert.equal(burst.status, "ready");
  assert.deepEqual(burst.candidates.map((c) => c.status), ["proposed", "proposed"]);
  assert.deepEqual(scans.map((s) => s.provider), ["claude", "claude"]);
});

test("an empty starred set is a stated reason, not a burst", async (t) => {
  const { service } = harness(t, { repositories: [] });
  const result = await service.create();
  assert.equal(result.status, "no_starred_repositories");
  assert.match(result.message, /Star a repository/);
  assert.equal(service.list().length, 0);
});

test("one failed scan never aborts the others", async (t) => {
  const { service } = harness(t, { failures: { [REPO_A]: "boom" } });
  const created = await service.create();
  await service.settled(created.burstId);
  const burst = service.get(created.burstId);
  assert.equal(burst.candidates.find((c) => c.repositoryId === REPO_A).status, "failed");
  assert.equal(burst.candidates.find((c) => c.repositoryId === REPO_A).reason, "boom");
  assert.equal(burst.candidates.find((c) => c.repositoryId === REPO_B).status, "proposed");
});

test("approve starts a burst goal session once and returns the same plan on a repeat", async (t) => {
  const { service, starts } = harness(t);
  const created = await service.create();
  await service.settled(created.burstId);
  const first = await service.approve(created.burstId, REPO_A, { goal: "Edited goal" });
  assert.equal(first.status, "approved");
  assert.equal(first.planId, "plan-1");
  assert.deepEqual(starts[0], { repositoryId: REPO_A, goal: "Edited goal", burst: true });
  const again = await service.approve(created.burstId, REPO_A, {});
  assert.equal(again.planId, "plan-1");
  assert.equal(starts.length, 1);
});

test("decline and rescan act on one candidate", async (t) => {
  const { service, scans } = harness(t);
  const created = await service.create();
  await service.settled(created.burstId);
  assert.equal(service.decline(created.burstId, REPO_A).status, "declined");
  const rescanned = await service.rescan(created.burstId, REPO_B);
  assert.equal(rescanned.status, "scanning");
  await service.settled(created.burstId);
  assert.equal(service.get(created.burstId).candidates.find((c) => c.repositoryId === REPO_B).status, "proposed");
  assert.equal(scans.length, 3);
});

test("a second create while one burst scans returns the running burst", async (t) => {
  const { service } = harness(t);
  const first = await service.create();
  const second = await service.create();
  assert.equal(second.burstId, first.burstId);
  await service.settled(first.burstId);
});

test("two concurrent creates make one burst", async (t) => {
  const { service, store } = harness(t);
  const [first, second] = await Promise.all([service.create(), service.create()]);
  assert.equal(second.burstId, first.burstId);
  assert.equal(store.list().length, 1);
  await service.settled(first.burstId);
});

test("a scan chain that throws fails every candidate it owned instead of stranding them", async (t) => {
  const { service, starred, logs } = harness(t);
  const created = await service.create();
  // The chain re-reads the starred set; make that read fail.
  starred.error = new Error("dashboard offline");
  await service.settled(created.burstId);
  const burst = service.get(created.burstId);
  assert.deepEqual(burst.candidates.map((c) => [c.status, c.reason]), [["failed", "dashboard offline"], ["failed", "dashboard offline"]]);
  assert.equal(burst.status, "closed");
  assert.equal(logs.length, 1);
  assert.equal(service.list().length, 1);
});

test("a fresh service fails scanning rows left by a restart, then create makes a new burst", async (t) => {
  const seeded = new BurstStore({ path: ":memory:" });
  seeded.create({ burstId: "burst-old", repositories: [{ id: REPO_A, name: "a" }, { id: REPO_B, name: "b" }] });
  seeded.recordProposal("burst-old", REPO_B, proposal);
  const { service, store } = harness(t, { store: seeded });
  const old = store.get("burst-old");
  assert.equal(old.status, "ready");
  const a = old.candidates.find((c) => c.repositoryId === REPO_A);
  assert.equal(a.status, "failed");
  assert.equal(a.reason, BURST_RESTARTED);
  assert.equal(old.candidates.find((c) => c.repositoryId === REPO_B).status, "proposed");
  const created = await service.create();
  assert.notEqual(created.burstId, "burst-old");
  assert.equal(created.status, "scanning");
  await service.settled(created.burstId);
  // recover() never touches a row whose scan is in flight.
  assert.deepEqual(service.get(created.burstId).candidates.map((c) => c.status), ["proposed", "proposed"]);
});

test("two concurrent approves start one goal session and share its plan", async (t) => {
  const { service, starts } = harness(t, { start: () => new Promise((resolve) => setTimeout(() => resolve({ planId: "plan-shared" }), 5)) });
  const created = await service.create();
  await service.settled(created.burstId);
  const [first, second] = await Promise.all([service.approve(created.burstId, REPO_A, {}), service.approve(created.burstId, REPO_A, { goal: "other" })]);
  assert.equal(starts.length, 1);
  assert.equal(first.planId, "plan-shared");
  assert.equal(second.planId, "plan-shared");
  assert.equal(first.status, "approved");
});

test("a recording failure after the session started is logged, not hidden", async (t) => {
  const { service, store, starts, logs } = harness(t);
  const created = await service.create();
  await service.settled(created.burstId);
  // Move the row from under the approval between start and record.
  const original = store.recordApproval.bind(store);
  store.recordApproval = (...args) => { store.recordDecline(created.burstId, REPO_A); return original(...args); };
  await assert.rejects(() => service.approve(created.burstId, REPO_A, {}), /Only a proposed candidate/);
  assert.equal(starts.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0].planId, "plan-1");
});

test("scans never exceed the concurrency bound", async (t) => {
  let inFlight = 0;
  let peak = 0;
  const { service } = harness(t, {
    concurrency: 2,
    repositories: [REPO_A, REPO_B, REPO_C].map((id) => ({ id, name: id, path: `/r/${id}`, favorite: true, archived: false })),
    scan: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return proposal;
    },
  });
  const created = await service.create();
  await service.settled(created.burstId);
  assert.equal(peak, 2);
  assert.deepEqual(service.get(created.burstId).candidates.map((c) => c.status), ["proposed", "proposed", "proposed"]);
});

test("two roomy providers share the scans", async (t) => {
  const usage = { providers: [
    { id: "claude", available: true, accounts: [account(70)] },
    { id: "codex", available: true, accounts: [account(65)] },
  ] };
  const { service, scans } = harness(t, { usage, repositories: [REPO_A, REPO_B, REPO_C].map((id) => ({ id, name: id, path: `/r/${id}`, favorite: true, archived: false })) });
  const created = await service.create();
  await service.settled(created.burstId);
  assert.deepEqual(scans.map((s) => s.provider), ["claude", "codex", "claude"]);
});

test("no usable quota fails every candidate with the assignment reason", async (t) => {
  const usage = { providers: [{ id: "claude", available: true, accounts: [{ ...account(2), status: "exhausted" }] }, { id: "codex", available: true, accounts: [{ status: "reconnect" }] }] };
  const { service, scans } = harness(t, { usage });
  const created = await service.create();
  await service.settled(created.burstId);
  const burst = service.get(created.burstId);
  assert.equal(scans.length, 0);
  assert.deepEqual(burst.candidates.map((c) => c.status), ["failed", "failed"]);
  assert.match(burst.candidates[0].reason, /No provider has usable quota/);
});

test("a rescan of a row still scanning is refused", async (t) => {
  let release = null;
  // Only the first scan blocks; the rest answer at once.
  const { service } = harness(t, { scan: () => release ? proposal : new Promise((resolve) => { release = () => resolve(proposal); }) });
  const created = await service.create();
  assert.throws(() => service.rescan(created.burstId, REPO_A), /cannot move to scanning/);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release();
  await service.settled(created.burstId);
  assert.deepEqual(service.get(created.burstId).candidates.map((c) => c.status), ["proposed", "proposed"]);
});

test("a repository un-starred mid-scan fails with that reason", async (t) => {
  const { service, starred, scans } = harness(t);
  const created = await service.create();
  starred.list = starred.list.filter((r) => r.id !== REPO_A);
  await service.settled(created.burstId);
  const burst = service.get(created.burstId);
  const a = burst.candidates.find((c) => c.repositoryId === REPO_A);
  assert.equal(a.status, "failed");
  assert.equal(a.reason, "This repository is no longer starred");
  assert.equal(burst.candidates.find((c) => c.repositoryId === REPO_B).status, "proposed");
  assert.deepEqual(scans.map((s) => s.id), [REPO_B]);
});
