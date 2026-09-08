import assert from "node:assert/strict";
import test from "node:test";
import { BurstStore } from "../server/burst-store.mjs";
import { BurstService } from "../server/burst-service.mjs";

const REPO_A = "repoAAAAAAAAAAAAAA";
const REPO_B = "repoBBBBBBBBBBBBBB";
const PLAIN = "repoPPPPPPPPPPPPPP";

function harness(t, { proposals = {}, failures = {}, repositories = null, usage = null } = {}) {
  const store = new BurstStore({ path: ":memory:" });
  t.after(() => store.close());
  const scans = [];
  const starts = [];
  const service = new BurstService({
    store,
    worktrees: { snapshot: async () => ({ repositories: repositories || [
      { id: REPO_A, name: "a", path: "/r/a", favorite: true, archived: false },
      { id: REPO_B, name: "b", path: "/r/b", favorite: true, archived: false },
      { id: PLAIN, name: "p", path: "/r/p", favorite: false, archived: false },
    ] }) },
    scanner: { scan: async ({ repository, provider }) => {
      scans.push({ id: repository.id, provider });
      if (failures[repository.id]) throw new Error(failures[repository.id]);
      return proposals[repository.id] || { goal: `Goal for ${repository.name}`, rationale: "because", evidence: ["README.md"], sizeEstimate: "small" };
    } },
    goalSessions: { start: async (input) => { starts.push(input); return { planId: `plan-${starts.length}` }; } },
    accountUsage: { snapshot: async () => usage || { providers: [{ id: "claude", available: true, accounts: [{ status: "ready", windows: [{ category: "usage", remainingPercent: 60 }] }] }] } },
    concurrency: 1,
  });
  return { store, service, scans, starts };
}

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
