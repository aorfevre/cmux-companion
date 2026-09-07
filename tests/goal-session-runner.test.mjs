import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runGoalSession, validateGoalSessionExecution } from "../server/goal-session-runner.mjs";
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

function resultEnvelope({ subtype = "success", sessionId = "provider-session-1", result = "Completed", isError = false } = {}) {
  return JSON.stringify({ type: "result", subtype, session_id: sessionId, result, ...(isError ? { is_error: true } : {}) });
}

test("an exit-zero provider error envelope leaves approval transition uncertain", async (t) => {
  const { databasePath, planId, store } = setupSession(t);
  const calls = [];
  const stop = await runGoalSession({
    planId,
    databasePath,
    generation: 1,
    input: new PassThrough(),
    out: () => {},
    intervalMs: 10,
    execute: async (args) => {
      calls.push(args);
      return resultEnvelope({ subtype: "error", result: "permission denied", isError: true });
    },
  });
  t.after(stop);

  store.approveProposal(planId, { generation: 1, revision: 1 });
  await wait(60);

  assert.equal(calls.length, 1);
  const args = calls[0];
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob,Edit,Write,Bash");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "manual");
  assert.ok(args.includes("--restricted"));
  assert.ok(args.includes("--permission-prompts"));
  assert.match(args[args.indexOf("--allowed-tools") + 1], /Bash\(gh pr create \*\)/);
  assert.match(args[args.indexOf("--allowed-tools") + 1], /Bash\(cargo test \*\)/);
  assert.ok(!args.some((arg) => arg.includes("dangerously-skip-permissions") || arg.includes("bypassPermissions")));
  assert.equal(store.get(planId).transitionStatus, "uncertain");
  assert.match(store.get(planId).goalSessionError || "", /permission denied/);
});

test("only an accepted result from the resumed provider conversation completes a writable turn", () => {
  assert.equal(validateGoalSessionExecution(resultEnvelope(), "provider-session-1").session_id, "provider-session-1");
  assert.throws(() => validateGoalSessionExecution(resultEnvelope({ subtype: "error", result: "permission denied", isError: true }), "provider-session-1"), /permission denied/);
  assert.throws(() => validateGoalSessionExecution(JSON.stringify({ type: "result", subtype: "success", session_id: "provider-session-1", result: "denied", permission_denials: ["Edit"] }), "provider-session-1"), /denied/);
  assert.throws(() => validateGoalSessionExecution(resultEnvelope({ sessionId: "other-provider-session" }), "provider-session-1"), /different conversation id/);
  assert.throws(() => validateGoalSessionExecution("not an envelope"), /completion envelope/);
});

test("planning is read-only until its durable proposal approval dispatches one writable resume", async (t) => {
  const { databasePath, directory, planId, store } = setupSession(t);
  store.db.prepare("UPDATE plans SET goal_session_provider_session_id = NULL, proposal_revision = 0, proposal = NULL, goal_session_state = 'planning' WHERE plan_id = ?").run(planId);
  const calls = [];
  const stop = await runGoalSession({
    planId,
    databasePath,
    generation: 1,
    input: new PassThrough(),
    out: () => {},
    intervalMs: 10,
    execute: async (args) => {
      calls.push(args);
      if (calls.length === 1) return resultEnvelope({
        sessionId: "provider-session-2",
        result: JSON.stringify({ tasks: [{ title: "Billing", branch: "feature/billing", prompt: "Implement billing", verification: ["npm test"] }] }),
      });
      return resultEnvelope({ sessionId: "provider-session-2" });
    },
  });
  t.after(stop);

  await wait(60);
  assert.equal(calls.length, 1);
  const planning = calls[0];
  assert.equal(planning[planning.indexOf("--tools") + 1], "Read,Grep,Glob");
  assert.equal(planning[planning.indexOf("--permission-mode") + 1], "plan");
  assert.ok(!planning.includes("Bash"));
  assert.equal(store.get(planId).goalSessionState, "awaiting_approval");

  store.approveProposal(planId, { generation: 1, revision: 1 });
  await wait(60);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("--resume"));
  assert.equal(calls[1][calls[1].indexOf("--resume") + 1], "provider-session-2");
  assert.equal(store.get(planId).goalSessionWorktreePath, directory);
  assert.equal(store.get(planId).transitionStatus, "delivered");
});
