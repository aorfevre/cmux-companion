import assert from "node:assert/strict";
import test from "node:test";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";
import { GoalVerification, chooseVerificationCommand } from "../server/goal-verification.mjs";

// A goal session whose contract names a check and whose pull request GitHub
// reports as OPEN. Approval means "the words look right"; this is the first
// time Companion runs one of those words itself.
function fixture(t, { verification = ["npm test"], scripts = ["test", "lint", "verify"] } = {}) {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const planId = "goal-verify";
  store.createPlan({ planId, repositoryId: "repository12345678", cwd: "/repo/app", goal: "Ship billing" });
  store.reserveGoalSession(planId, { branch: "goal-session/billing", generation: 1 });
  store.recordGoalSessionStart(planId, { worktreePath: "/repo/billing", workspaceId: "ws-owner", generation: 1 });
  store.publishProposal(planId, { generation: 1, providerSessionId: "p", proposal: { intendedBehavior: "Ship billing", scope: ["Billing"], verification } });
  store.approveProposal(planId, { generation: 1, revision: 1 });
  const runs = [];
  const execute = async (bin, args, options) => {
    runs.push({ bin, args, cwd: options?.cwd });
    if (args.includes("git")) return { stdout: "abc123\n" };
    if (options?.cwd === "/repo/billing" && args.includes("lint")) throw Object.assign(new Error("lint failed"), { stdout: "", stderr: "3 problems (3 errors)\n" });
    return { stdout: "ok\n", stderr: "" };
  };
  const repoCatalog = { get: async () => ({ scripts }) };
  const service = new GoalVerification({ store, execute, repoCatalog, gitHead: async () => "abc123" });
  return { store, planId, service, runs };
}

test("chooseVerificationCommand maps a contract check to one declared package script or refuses", () => {
  const scripts = ["test", "lint", "verify", "test:ui"];
  assert.deepEqual(chooseVerificationCommand(["npm test"], scripts), { script: "test", source: "npm test" });
  assert.deepEqual(chooseVerificationCommand(["Run npm run verify before opening the PR"], scripts), { script: "verify", source: "Run npm run verify before opening the PR" });
  assert.deepEqual(chooseVerificationCommand(["npx vitest run", "npm run test:ui"], scripts), { script: "test:ui", source: "npm run test:ui" });
  // A script the repository does not declare is never run, whatever the contract says.
  assert.equal(chooseVerificationCommand(["npm run deploy"], scripts), null);
  assert.equal(chooseVerificationCommand(["Try a sandbox payment"], scripts), null);
  assert.equal(chooseVerificationCommand([], scripts), null);
  // `verify` is preferred when several declared scripts appear.
  assert.equal(chooseVerificationCommand(["npm test", "npm run verify"], scripts).script, "verify");
});

test("verify runs the matched script in the goal worktree once per head commit and records a pass", async (t) => {
  const { store, planId, service, runs } = fixture(t);
  const result = await service.verify(planId);
  assert.deepEqual(result, { planId, status: "passed", script: "test", headSha: "abc123" });
  const plan = store.get(planId);
  assert.equal(plan.verification.status, "passed");
  assert.equal(plan.verification.script, "test");
  assert.equal(plan.verification.headSha, "abc123");
  assert.equal(plan.verification.source, "npm test");
  assert.ok(plan.verification.finishedAt);
  assert.deepEqual(runs.filter((run) => run.bin === "npm").map((run) => [run.args, run.cwd]), [[["run", "--silent", "test"], "/repo/billing"]]);
  // The same head is not verified twice.
  assert.equal((await service.verify(planId)).status, "passed");
  assert.equal(runs.filter((run) => run.bin === "npm").length, 1);
  assert.equal(store.list()[0].verification.status, "passed");
});

test("a failing script records the failure with the stated output and never moves the goal", async (t) => {
  const { store, planId, service } = fixture(t, { verification: ["npm run lint"] });
  const result = await service.verify(planId);
  assert.equal(result.status, "failed");
  const plan = store.get(planId);
  assert.equal(plan.verification.status, "failed");
  assert.match(plan.verification.output, /3 problems/);
  assert.equal(plan.boardStatus, null);
  assert.equal(plan.goalSessionError, null);
});

test("a contract without a runnable check records that nothing was run", async (t) => {
  const { store, planId, service, runs } = fixture(t, { verification: ["Try a sandbox payment"] });
  const result = await service.verify(planId);
  assert.equal(result.status, "unavailable");
  assert.match(store.get(planId).verification.reason, /no declared package script/);
  assert.equal(runs.filter((run) => run.bin === "npm").length, 0);
});

test("a new head commit is verified again, and an old result is replaced", async (t) => {
  const { store, planId, runs } = fixture(t);
  let head = "abc123";
  const execute = async (bin, args, options) => { runs.push({ bin, args, cwd: options?.cwd }); return { stdout: "ok\n", stderr: "" }; };
  const service = new GoalVerification({ store, execute, repoCatalog: { get: async () => ({ scripts: ["test"] }) }, gitHead: async () => head });
  await service.verify(planId);
  head = "def456";
  const result = await service.verify(planId);
  assert.equal(result.headSha, "def456");
  assert.equal(runs.filter((run) => run.bin === "npm").length, 2);
  assert.equal(store.get(planId).verification.headSha, "def456");
});

test("verify refuses a goal that is not an approved goal session with a worktree", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  store.createPlan({ planId: "legacy", repositoryId: "repository12345678", cwd: "/repo", goal: "Old" });
  const service = new GoalVerification({ store, execute: async () => ({ stdout: "" }), repoCatalog: { get: async () => ({ scripts: ["test"] }) } });
  assert.equal((await service.verify("legacy")).status, "skipped");
  assert.equal((await service.verify("missing")).status, "skipped");
});
