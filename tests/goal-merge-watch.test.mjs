import assert from "node:assert/strict";
import test from "node:test";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";
import { GoalMergeWatch } from "../server/goal-merge-watch.mjs";
import { BurstReview } from "../server/burst-review.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A launched burst goal session whose pull request GitHub reports as `state`.
function fixture(t, { burst = true, state = "OPEN" } = {}) {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const planId = "burst-owner";
  store.createPlan({ planId, repositoryId: "repo", cwd: "/repo", goal: "Ship billing", burst });
  store.reserveGoalSession(planId, { branch: "goal-session/billing", generation: 1 });
  store.recordGoalSessionStart(planId, { worktreePath: "/repo/billing", workspaceId: "ws-owner", generation: 1 });
  store.publishProposal(planId, { generation: 1, providerSessionId: "provider-owner", proposal: { intendedBehavior: "Ship billing", scope: ["Billing"] } });
  store.approveProposal(planId, { generation: 1, revision: 1 });
  const reviewed = [];
  const warnings = [];
  const observation = { number: 42, url: "https://github.test/pull/42", state, headBranch: "goal-session/billing" };
  const watch = new GoalMergeWatch({
    store,
    worktrees: { pullRequestObservations: () => ({ available: true, observations: [observation] }) },
    burstReview: { reviewGoal: async (id) => { reviewed.push(id); return true; } },
    log: { warn: (details, message) => warnings.push(message) },
  });
  return { store, planId, watch, reviewed, warnings, observation };
}

test("an OPEN pull request on a burst goal session asks for a goal review", async (t) => {
  const { store, planId, watch, reviewed } = fixture(t);
  const { recorded } = await watch.reconcile();
  assert.deepEqual(recorded.map((entry) => [entry.planId, entry.state]), [[planId, "OPEN"]]);
  assert.equal(store.get(planId).boardPrNumber, 42);
  assert.deepEqual(reviewed, [planId]);
});

test("the review is asked for again on each pass; the reviewer owns the once-only rule", async (t) => {
  const { watch, reviewed } = fixture(t);
  await watch.reconcile();
  await watch.reconcile();
  assert.deepEqual(reviewed, ["burst-owner", "burst-owner"]);
});

test("a review that failed to start is asked for again on the next pass, with no change to the pull request", async (t) => {
  const { store, planId, watch, warnings } = fixture(t);
  const dir = await mkdtemp(join(tmpdir(), "goal-merge-watch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const created = [];
  let failures = 1;
  const cmux = {
    workspaceCreate: async (options) => {
      if (failures > 0) { failures -= 1; throw new Error("cmux is down"); }
      created.push(options.cwd);
      return { workspace_id: "review-g" };
    },
    sendWorkspacePrompt: async () => {},
    workspaceClose: async () => {},
  };
  const briefs = { directory: dir, async write({ planId: id, taskId, markdown }) { const path = join(dir, `${id}-${taskId}.md`); await writeFile(path, markdown); return { path }; }, pointerPrompt: ({ path }) => `Read ${path}` };
  const reviewer = new BurstReview({ store, cmux, briefs, modelSettings: { workspace: (role, agent) => ({ agent, model: "default" }) } });
  let reviewRun;
  watch.burstReview = { reviewGoal: (...args) => { reviewRun = reviewer.reviewGoal(...args); return reviewRun; } };
  const first = await watch.reconcile();
  assert.equal(first.recorded.length, 1, "the pull request is recorded on the first pass");
  await assert.rejects(reviewRun, /cmux is down/);
  assert.deepEqual(warnings, ["burst goal review could not start"]);
  assert.equal(store.get(planId).reviewStatus, null, "the failed launch released its claim");
  const events = () => store.events(planId).filter((event) => event.kind === "board_pull_request").length;
  assert.equal(events(), 1);
  await watch.reconcile();
  assert.equal(events(), 1, "nothing changed on GitHub, so nothing new is written");
  await reviewRun;
  assert.deepEqual(created, ["/repo/billing"]);
  assert.equal(store.get(planId).reviewStatus, "running");
  assert.equal(store.get(planId).reviewWorkspaceId, "review-g");
  // A third pass finds the claim and opens nothing.
  await watch.reconcile();
  await reviewRun;
  assert.equal(created.length, 1);
  assert.deepEqual(warnings, ["burst goal review could not start"]);
});

test("a merged pull request records the goal and asks for no review", async (t) => {
  const { store, planId, watch, reviewed } = fixture(t, { state: "MERGED" });
  await watch.reconcile();
  assert.equal(store.get(planId).boardStatus, "merged");
  assert.deepEqual(reviewed, []);
});

test("a goal without the burst flag is still offered to the reviewer, which declines it", async (t) => {
  // The watch does not know the burst rules; BurstReview.reviewGoal does.
  const { watch, reviewed } = fixture(t, { burst: false });
  await watch.reconcile();
  assert.deepEqual(reviewed, ["burst-owner"]);
});

test("a review that fails to start is logged and never blocks the reconciliation", async (t) => {
  const { store, planId, watch, warnings } = fixture(t);
  watch.burstReview = { reviewGoal: async () => { throw new Error("cmux is down"); } };
  const { recorded } = await watch.reconcile();
  assert.equal(recorded.length, 1);
  assert.equal(store.get(planId).boardPrNumber, 42);
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.deepEqual(warnings, ["burst goal review could not start"]);
});

test("a watch built without a reviewer records the pull request as before", async (t) => {
  const { store, planId } = fixture(t);
  const watch = new GoalMergeWatch({ store, worktrees: { pullRequestObservations: () => ({ available: true, observations: [{ number: 42, state: "OPEN", headBranch: "goal-session/billing" }] }) } });
  const { recorded } = await watch.reconcile();
  assert.equal(recorded.length, 1);
  assert.equal(store.get(planId).boardPrState, "OPEN");
});

// The contract's check runs on the goal branch on every pass the pull request
// is open. The verifier owns the once-per-head rule, so the watch asks each
// time. Like the reviewer, it must not hold up the refresh, so it is not awaited.
test("an OPEN pull request on a goal session asks for the contract's verification", async (t) => {
  const { store, planId, watch } = fixture(t, { burst: false });
  const verified = [];
  watch.verification = { verify: async (id) => { verified.push(id); return { status: "passed" }; } };
  await watch.reconcile();
  await watch.reconcile();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(verified, [planId, planId]);
  assert.equal(store.get(planId).boardPrState, "OPEN");
});

test("a verifier that throws is logged and never fails the pass", async (t) => {
  const { watch, warnings } = fixture(t, { burst: false });
  watch.verification = { verify: async () => { throw new Error("npm missing"); } };
  const { recorded } = await watch.reconcile();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recorded.length, 1);
  assert.ok(warnings.includes("goal verification could not run"));
});
