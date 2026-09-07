import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runGoalSession } from "../server/goal-session-runner.mjs";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";

function setupSession(t) {
  const directory = mkdtempSync(join(tmpdir(), "cmux-goal-session-runner-"));
  const databasePath = join(directory, "plans.db");
  const store = new WorktreePlanStore({ path: databasePath });
  const planId = "goal-session-plan";
  store.createPlan({ planId, repositoryId: "repo", cwd: directory, goal: "Add billing" });
  store.reserveGoalSession(planId, { branch: "goal-session/test", generation: 1 });
  store.recordGoalSessionStart(planId, {
    worktreePath: directory,
    workspaceId: "00000000-0000-4000-8000-000000000001",
    generation: 1,
  });
  store.publishProposal(planId, {
    generation: 1,
    providerSessionId: "provider-session-1",
    proposal: { intendedBehavior: "Add billing", scope: ["billing"] },
  });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { databasePath, directory, planId, store };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("a rejected durable proposal correction runs once and remains recoverable", async (t) => {
  const { databasePath, directory, planId, store } = setupSession(t);
  let calls = 0;
  const stop = await runGoalSession({
    planId,
    databasePath,
    generation: 1,
    input: new PassThrough(),
    out: () => {},
    intervalMs: 10,
    execute: async () => {
      calls += 1;
      throw new Error("provider rejected the correction");
    },
  });
  t.after(stop);

  store.requestProposalChanges(planId, { generation: 1, revision: 1, feedback: "Keep invoices out." });
  await wait(100);

  const plan = store.get(planId);
  assert.equal(calls, 1, "a provider rejection must not replay the correction automatically");
  assert.equal(plan.goalSessionPendingInput, null);
  assert.equal(plan.goalSessionActiveInput, "Keep invoices out.", "the rejected correction remains durable for an explicit retry");
  assert.match(plan.goalSessionError || "", /provider rejected the correction/);
  assert.equal(plan.goalSessionWorktreePath, directory);
});
