import assert from "node:assert/strict";
import test from "node:test";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";
import { GoalMergeWatch } from "../server/goal-merge-watch.mjs";

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
