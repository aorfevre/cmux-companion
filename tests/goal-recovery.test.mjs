import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentBriefs } from "../server/agent-brief.mjs";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";
import { WorktreePlanner } from "../server/worktree-planner.mjs";

const REPO_ID = "repository12345678";

const roots = [];
process.on("exit", () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

// A worktree that really exists on disk, because `continue` mode checks the
// path with existsSync rather than asking the dashboard.
async function realWorktree() {
  const root = tempRoot("recovery-worktree-");
  return mkdtemp(join(root, "task-"));
}

// The same shape as `launchDeps` in tests/worktree-planner.test.mjs, narrowed
// to what the two recovery paths touch: a cmux client, a worktree dashboard, a
// git runner and a brief directory. Every call lands in `calls`.
function recoveryDeps() {
  const calls = [];
  const root = tempRoot("recovery-briefs-");
  return {
    calls,
    briefs: new AgentBriefs({ directory: join(root, "briefs") }),
    worktrees: {
      snapshot: async () => ({
        repositories: [{
          id: REPO_ID,
          name: "sample",
          path: "/repo/sample",
          worktrees: [{ id: "worktree1234567890", branch: "main", path: "/repo/sample", isPrimary: true }],
        }],
      }),
      removeBranchWorktree: async (repositoryId, branch) => {
        calls.push(["remove", repositoryId, branch]);
        return { removed: true, branch, path: `/repo/sample-${branch.replace(/\W+/g, "-")}` };
      },
      create: async (repositoryId, options) => {
        calls.push(["create", repositoryId, options]);
        return { created: true, worktree: { id: "w1", branch: options.branch, path: `/repo/sample-${options.branch.replace(/\W+/g, "-")}` } };
      },
    },
    cmux: {
      workspaceListDetailed: async () => ({ workspaces: [] }),
      workspaceCreate: async (options) => { calls.push(["workspace", options]); return { workspace_id: "ws-new" }; },
      workspaceClose: async (workspaceId) => { calls.push(["close", workspaceId]); return { ok: true }; },
    },
    accountUsage: { snapshot: async () => ({ providers: [] }) },
    git: async (cwd, args) => { calls.push(["git", cwd, args]); return args[0] === "rev-parse" ? "abc1234\n" : ""; },
    execute: async () => ({ stdout: "" }),
  };
}

const TASKS = [
  { id: "t1", title: "Billing", branch: "feature/billing", prompt: "Add billing.", type: "backend", agent: "claude" },
  { id: "t2", title: "Invoices", branch: "feature/invoices", prompt: "Add invoices.", type: "ui", agent: "codex" },
];

// A launched plan sitting in the store, exactly as a real launch left it. The
// recovery paths read the durable row and never the draft cache, so the tests
// build the row instead of driving a launch.
function launched(t, { worktreePath = "/repo/sample-feature-billing", deps = recoveryDeps(), planId = "plan-1" } = {}) {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  store.createPlan({ planId, repositoryId: REPO_ID, repositoryName: "sample", cwd: "/repo/sample", goal: "Add billing" });
  store.recordRound(planId, {
    round: 1, stage: "ready", sessionId: "sess-a",
    spec: { outcome: "Customers can pay invoices", acceptanceCriteria: [{ id: "AC-1", text: "Payment works", verification: "npm test" }] },
    tasks: TASKS,
  });
  store.recordLaunch(planId, {
    base: "origin/main", baseSha: "a".repeat(40),
    results: [
      { id: "t1", status: "launched", path: worktreePath, workspace: { workspace_id: "ws-old" }, startSha: "a".repeat(40) },
      { id: "t2", status: "launched", path: "/repo/sample-feature-invoices", workspace: { workspace_id: "ws-two" }, startSha: "a".repeat(40) },
    ],
  });
  const planner = new WorktreePlanner({ ...deps, store });
  return { store, deps, planner, planId };
}

// --- what a relaunch refuses ---------------------------------------------

test("refuses to relaunch a plan the store has never seen", async (t) => {
  const { planner } = launched(t);
  await assert.rejects(() => planner.relaunchTask("plan-nope", "t1"), /Unknown plan/);
});

// The recovery paths exist for launched plans. A draft still has its normal
// launch route, and relaunching one would write a session onto a plan with no
// worktrees at all.
test("refuses to relaunch a plan that has not launched yet", async (t) => {
  const deps = recoveryDeps();
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  store.createPlan({ planId: "draft-1", repositoryId: REPO_ID, repositoryName: "sample", goal: "Add billing" });
  store.recordRound("draft-1", { round: 1, stage: "ready", sessionId: "s", tasks: TASKS });
  const planner = new WorktreePlanner({ ...deps, store });
  await assert.rejects(() => planner.relaunchTask("draft-1", "t1"), /has not launched yet/);
  await assert.rejects(() => planner.skipTask("draft-1", "t1"), /has not launched yet/);
});

test("refuses a task id the plan does not hold", async (t) => {
  const { planner } = launched(t);
  await assert.rejects(() => planner.relaunchTask("plan-1", "t9"), /Unknown task/);
  await assert.rejects(() => planner.skipTask("plan-1", ""), /Unknown task/);
});

// The branch is already in the goal branch. Relaunching would produce a second
// set of commits for work the integrator has already merged.
test("refuses to relaunch or skip a task that is already integrated", async (t) => {
  const { store, planner } = launched(t);
  store.recordTaskReady("plan-1", "t1", "b".repeat(40));
  store.recordIntegrationStarted("plan-1", { branch: "goal/billing", path: "/repo/goal" });
  store.recordTaskIntegrated("plan-1", "t1", "d".repeat(40));
  await assert.rejects(() => planner.relaunchTask("plan-1", "t1"), /already merged into the goal branch/);
  await assert.rejects(() => planner.skipTask("plan-1", "t1"), /already merged, so it cannot be skipped/);
});

// Two modes only. A typo must not fall through to whichever branch the code
// happens to default to, because they do opposite things to the working tree.
test("refuses a mode that is neither continue nor restart", async (t) => {
  const { planner, deps } = launched(t);
  for (const mode of ["clean", "CONTINUE", "", null, "restart "]) {
    await assert.rejects(() => planner.relaunchTask("plan-1", "t1", { mode }), /must be continue or restart/i);
  }
  assert.deepEqual(deps.calls.filter((call) => call[0] === "remove"), [], "a rejected mode must touch nothing");
});

// The one case where relaunching is the wrong answer: a second agent in one
// worktree would fight the first over the same files.
test("refuses to relaunch while the task's cmux session is still live", async (t) => {
  const deps = recoveryDeps();
  deps.cmux.workspaceListDetailed = async () => ({ workspaces: [{ id: "ws-old", current_directory: "/repo/sample-feature-billing" }] });
  const { planner } = launched(t, { deps });
  await assert.rejects(() => planner.relaunchTask("plan-1", "t1"), (error) => {
    // The message has to name the fix, or the user is told no with no route on.
    assert.match(error.message, /still open/i);
    assert.match(error.message, /close it first/i);
    return true;
  });
  assert.deepEqual(deps.calls.filter((call) => call[0] === "workspace"), [], "no session may be opened");
});

// A crashed agent usually leaves its workspace open at a shell prompt, so
// refusing outright sent the user to cmux to close it by hand and come back —
// the round trip this whole path exists to remove.
test("closeLive closes the open session and then relaunches", async (t) => {
  const path = await realWorktree();
  const deps = recoveryDeps();
  deps.cmux.workspaceListDetailed = async () => ({ workspaces: [{ id: "ws-old", current_directory: path }] });
  const { planner } = launched(t, { deps, worktreePath: path });

  const result = await planner.relaunchTask("plan-1", "t1", { closeLive: true });

  assert.equal(result.status, "launched");
  assert.deepEqual(deps.calls.filter((call) => call[0] === "close").map((call) => call[1]), ["ws-old"]);
  assert.equal(deps.calls.filter((call) => call[0] === "workspace").length, 1, "exactly one new session");
  // The close must happen before the new session opens, or two agents share the
  // worktree for as long as the create call takes.
  const order = deps.calls.map((call) => call[0]).filter((name) => name === "close" || name === "workspace");
  assert.deepEqual(order, ["close", "workspace"]);
});

// A close that fails must not abandon the recovery: cmux may have dropped the
// session already, which is the state the close was asking for.
test("a failed close still relaunches the task", async (t) => {
  const path = await realWorktree();
  const deps = recoveryDeps();
  deps.cmux.workspaceListDetailed = async () => ({ workspaces: [{ id: "ws-old", current_directory: path }] });
  deps.cmux.workspaceClose = async () => { throw new Error("no such workspace"); };
  const { planner } = launched(t, { deps, worktreePath: path });

  const result = await planner.relaunchTask("plan-1", "t1", { closeLive: true });
  assert.equal(result.status, "launched");
});

// A live session that belongs to another task must not block this one.
test("another task's live session does not block a relaunch", async (t) => {
  const path = await realWorktree();
  const deps = recoveryDeps();
  deps.cmux.workspaceListDetailed = async () => ({ workspaces: [{ id: "ws-two", current_directory: "/elsewhere" }] });
  const { planner } = launched(t, { deps, worktreePath: path });
  const result = await planner.relaunchTask("plan-1", "t1");
  assert.equal(result.status, "launched");
});

// Refusing every recovery while cmux is down would rebuild the lock this whole
// path exists to remove, so an unreachable list is treated as "not live".
test("an unreachable cmux workspace list still lets a relaunch run", async (t) => {
  const path = await realWorktree();
  const deps = recoveryDeps();
  deps.cmux.workspaceListDetailed = async () => { throw new Error("cmux is not running"); };
  const { planner, store } = launched(t, { deps, worktreePath: path });
  const result = await planner.relaunchTask("plan-1", "t1");
  assert.equal(result.status, "launched");
  assert.equal(store.get("plan-1").tasks[0].workspaceId, "ws-new");
});

// A task whose launch failed has no workspace id at all. The liveness probe
// must short-circuit rather than matching a workspace whose id is "".
test("a task that never got a session is not treated as live", async (t) => {
  const path = await realWorktree();
  const deps = recoveryDeps();
  deps.cmux.workspaceListDetailed = async () => ({ workspaces: [{ id: "", current_directory: "/nowhere" }] });
  const { store, planner } = launched(t, { deps, worktreePath: path });
  store.recordTaskRelaunch("plan-1", "t1", { status: "failed", path, error: "cmux is not running" });
  const result = await planner.relaunchTask("plan-1", "t1");
  assert.equal(result.status, "launched");
});

test("refuses to relaunch a task on a goal the user aborted", async (t) => {
  const { store, planner } = launched(t);
  store.recordGoalAborted("plan-1");
  await assert.rejects(() => planner.relaunchTask("plan-1", "t1"));
  await assert.rejects(() => planner.skipTask("plan-1", "t1"));
});

// --- continue mode -------------------------------------------------------

// `worktrees.create` refuses a dirty worktree by design, which is right for a
// launch and wrong here: half-finished work is exactly what this mode keeps.
test("continue reuses the existing worktree and creates none", async (t) => {
  const path = await realWorktree();
  const { deps, planner, store } = launched(t, { worktreePath: path });
  const result = await planner.relaunchTask("plan-1", "t1", { mode: "continue" });

  assert.equal(result.status, "launched");
  assert.equal(result.path, path);
  assert.equal(result.mode, "continue");
  assert.deepEqual(deps.calls.filter((call) => call[0] === "create"), [], "continue must not create a worktree");
  assert.deepEqual(deps.calls.filter((call) => call[0] === "remove"), [], "continue must not remove a branch");
  const workspace = deps.calls.find((call) => call[0] === "workspace")[1];
  assert.equal(workspace.cwd, path);
  assert.equal(workspace.agent, "claude");
  assert.equal(workspace.title, "SMP · Customers can pay invoices (plan) · T1-api · Billing");
  assert.equal(store.get("plan-1").tasks[0].worktreePath, path);
});

// The mode's whole purpose is to keep what the dead agent wrote. Without the
// resume sentence the new agent reads a brief describing untouched work and
// starts again from nothing.
test("continue tells the new agent that work is already in the worktree", async (t) => {
  const path = await realWorktree();
  const { deps, planner } = launched(t, { worktreePath: path });
  await planner.relaunchTask("plan-1", "t1", { mode: "continue" });
  const { prompt } = deps.calls.find((call) => call[0] === "workspace")[1];
  assert.match(prompt, /A previous agent worked in this worktree and stopped/);
  assert.match(prompt, /git status/);
  assert.match(prompt, /Do not start again from nothing/);
  // The pointer still leads with the brief file, or the agent reads the resume
  // sentence and nothing else.
  assert.match(prompt, /^Read the file .+ in full/m);
});

// A restart's brief describes a fresh worktree, so the resume sentence would
// be a lie there.
test("restart does not carry the resume sentence", async (t) => {
  const { deps, planner } = launched(t);
  await planner.relaunchTask("plan-1", "t1", { mode: "restart" });
  const { prompt } = deps.calls.find((call) => call[0] === "workspace")[1];
  assert.equal(/previous agent/.test(prompt), false, prompt);
});

// The worktree the task launched into can be gone: a user prunes it, or a
// failed launch never made one. Continuing into a missing directory would open
// a session in whatever directory cmux happened to start from.
test("continue refuses a worktree that is no longer on disk and names the way out", async (t) => {
  const root = await realWorktree();
  const missing = join(root, "never-created");
  assert.equal(existsSync(missing), false);
  const { deps, planner } = launched(t, { worktreePath: missing });
  await assert.rejects(() => planner.relaunchTask("plan-1", "t1", { mode: "continue" }), (error) => {
    assert.match(error.message, /no worktree left to continue/i);
    assert.match(error.message, /restart/i);
    return true;
  });
  assert.deepEqual(deps.calls.filter((call) => call[0] === "workspace"), []);
});

test("continue refuses a task that has no recorded worktree path at all", async (t) => {
  const deps = recoveryDeps();
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  store.createPlan({ planId: "plan-1", repositoryId: REPO_ID, repositoryName: "sample", goal: "Add billing" });
  store.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "s", tasks: TASKS });
  store.recordLaunch("plan-1", {
    base: "origin/main",
    results: [
      { id: "t1", status: "failed", error: "That branch already has a worktree" },
      { id: "t2", status: "launched", path: "/repo/sample-feature-invoices", workspace: { workspace_id: "ws-two" } },
    ],
  });
  const planner = new WorktreePlanner({ ...deps, store });
  await assert.rejects(() => planner.relaunchTask("plan-1", "t1", { mode: "continue" }), /no worktree left to continue/i);
});

// The mode defaults to continue, because a dead agent with work on disk is the
// common case and throwing that work away must always be asked for.
test("the default mode is continue", async (t) => {
  const path = await realWorktree();
  const { deps, planner } = launched(t, { worktreePath: path });
  const result = await planner.relaunchTask("plan-1", "t1");
  assert.equal(result.mode, "continue");
  assert.deepEqual(deps.calls.filter((call) => call[0] === "remove"), []);
});

// --- restart mode --------------------------------------------------------

// `create` checks out an existing branch, so without the removal first the
// agent would be put straight back on the work this mode was asked to discard.
test("restart removes the branch and its worktree before it creates a new one", async (t) => {
  const { deps, planner } = launched(t);
  const result = await planner.relaunchTask("plan-1", "t1", { mode: "restart" });

  assert.equal(result.status, "launched");
  assert.equal(result.path, "/repo/sample-feature-billing");
  const removeAt = deps.calls.findIndex((call) => call[0] === "remove");
  const createAt = deps.calls.findIndex((call) => call[0] === "create");
  assert.ok(removeAt !== -1, "it must remove the branch");
  assert.ok(createAt !== -1, "it must create the worktree");
  assert.ok(removeAt < createAt, "the removal must come first");
  assert.deepEqual(deps.calls[removeAt].slice(1), [REPO_ID, "feature/billing"]);
  assert.equal(deps.calls[createAt][2].branch, "feature/billing");
  assert.equal(deps.calls[createAt][2].base, "origin/main");
});

// A combined goal that has already opened its integration branch rebuilds from
// that branch, not from the original base: the other tasks are already in it.
test("restart rebuilds from the integration branch once a combined goal has one", async (t) => {
  const { store, deps, planner } = launched(t);
  store.recordIntegrationStarted("plan-1", { branch: "goal/billing-plan1", path: "/repo/goal" });
  await planner.relaunchTask("plan-1", "t1", { mode: "restart" });
  assert.equal(deps.calls.find((call) => call[0] === "create")[2].base, "goal/billing-plan1");
});

// A failed removal is a failed relaunch, not a half-rebuilt worktree the next
// create silently reuses.
test("a removal that fails is recorded as a failed relaunch", async (t) => {
  const deps = recoveryDeps();
  deps.worktrees.removeBranchWorktree = async () => { throw new TypeError("That branch belongs to a companion release"); };
  const { store, planner } = launched(t, { deps });
  await assert.rejects(() => planner.relaunchTask("plan-1", "t1", { mode: "restart" }), /companion release/);
  assert.deepEqual(deps.calls.filter((call) => call[0] === "create"), []);
  assert.equal(store.get("plan-1").tasks[0].launchStatus, "failed");
});

// --- persistence ---------------------------------------------------------

// A cmux that refuses the session is the failure the board most needs to show,
// so it is both persisted and thrown: a silent failure leaves a task looking
// relaunched with nothing running.
test("a failed cmux create is persisted as a failed relaunch and thrown", async (t) => {
  const path = await realWorktree();
  const deps = recoveryDeps();
  deps.cmux.workspaceCreate = async () => { throw new Error("cmux is not running"); };
  const { store, planner } = launched(t, { deps, worktreePath: path });

  await assert.rejects(() => planner.relaunchTask("plan-1", "t1"), /cmux is not running/);
  const task = store.get("plan-1").tasks[0];
  assert.equal(task.launchStatus, "failed");
  assert.match(task.launchError, /cmux is not running/);
  // The worktree it was going to reuse is still recorded, so a second attempt
  // can find it.
  assert.equal(task.worktreePath, path);
  assert.equal(store.events("plan-1").at(-1).kind, "task_relaunched");
});

test("relaunching with no cmux connection at all is refused before anything moves", async (t) => {
  const path = await realWorktree();
  const deps = recoveryDeps();
  const { planner } = launched(t, { deps, worktreePath: path });
  planner.cmux = null;
  await assert.rejects(() => planner.relaunchTask("plan-1", "t1"), /needs a cmux connection/);
  assert.deepEqual(deps.calls.filter((call) => call[0] === "workspace"), []);
});

// The dead session's id is the only record that it existed. Writing the new id
// first would erase it with nothing saying it was retired, and the sweep would
// leave the old session open forever.
test("the old workspace id is retired before the new one is written", async (t) => {
  const path = await realWorktree();
  const { store, planner } = launched(t, { worktreePath: path });
  const events = () => store.events("plan-1").map((event) => event.kind);
  const before = events().length;

  const result = await planner.relaunchTask("plan-1", "t1");
  assert.equal(result.workspace.workspace_id, "ws-new");
  const written = events().slice(before);
  assert.deepEqual(written, ["session_retired", "task_relaunched"]);
  const retired = store.events("plan-1").find((event) => event.kind === "session_retired");
  assert.deepEqual(retired.payload.sessions, [{ workspaceId: "ws-old", taskId: "t1" }]);
  assert.equal(store.get("plan-1").tasks[0].workspaceId, "ws-new");
});

// A task with no session to retire must not write an empty retirement event.
test("a task with no previous session records no retirement", async (t) => {
  const path = await realWorktree();
  const { store, planner } = launched(t, { worktreePath: path });
  store.recordTaskRelaunch("plan-1", "t1", { status: "failed", path, error: "cmux is not running" });
  const before = store.events("plan-1").length;
  await planner.relaunchTask("plan-1", "t1");
  assert.deepEqual(store.events("plan-1").slice(before).map((event) => event.kind), ["task_relaunched"]);
});

// --- skipping a task -----------------------------------------------------

test("skipping closes the task's live session and records the reason", async (t) => {
  const deps = recoveryDeps();
  deps.cmux.workspaceListDetailed = async () => ({ workspaces: [{ id: "ws-old", current_directory: "/repo/sample-feature-billing" }] });
  const { store, planner } = launched(t, { deps });

  const result = await planner.skipTask("plan-1", "t1", { reason: "covered by t2" });
  assert.deepEqual(result, { planId: "plan-1", taskId: "t1", skipped: true, closedSession: "ws-old" });
  assert.deepEqual(deps.calls.filter((call) => call[0] === "close"), [["close", "ws-old"]]);

  const task = store.get("plan-1").tasks[0];
  assert.equal(task.launchStatus, "skipped");
  assert.equal(task.launchError, "covered by t2");
  assert.equal(store.events("plan-1").at(-1).kind, "task_skipped");
});

// The point of skipping is to unblock the goal. A cmux that will not close the
// session must not stop the row from being written, or the goal stays stuck on
// the very task the user asked to drop.
test("a close that rejects still skips the task", async (t) => {
  const deps = recoveryDeps();
  deps.cmux.workspaceListDetailed = async () => ({ workspaces: [{ id: "ws-old", current_directory: "/repo" }] });
  deps.cmux.workspaceClose = async () => { throw new Error("cmux is not running"); };
  const { store, planner } = launched(t, { deps });

  const result = await planner.skipTask("plan-1", "t1", { reason: "dead agent" });
  assert.equal(result.skipped, true);
  assert.equal(result.closedSession, null);
  assert.equal(store.get("plan-1").tasks[0].launchStatus, "skipped");
});

// No live session means nothing to close. Calling close on a session cmux has
// already dropped would log a failure for a task that is fine.
test("skipping a task whose session is already gone closes nothing", async (t) => {
  const { deps, planner, store } = launched(t);
  const result = await planner.skipTask("plan-1", "t1");
  assert.equal(result.closedSession, null);
  assert.deepEqual(deps.calls.filter((call) => call[0] === "close"), []);
  assert.equal(store.get("plan-1").tasks[0].launchStatus, "skipped");
  assert.equal(store.get("plan-1").tasks[0].launchError, null);
});

// Skipping is the answer to "one dead task blocks the merge for every other
// task that finished", so the sibling's evidence has to survive it.
test("skipping one task leaves the other task's evidence untouched", async (t) => {
  const { store, planner } = launched(t);
  store.recordTaskReady("plan-1", "t2", "c".repeat(40), { changedFiles: ["server/invoices.mjs"] });
  store.recordDeliveryFailure("plan-1", "t1 is not ready");

  const plan = store.get("plan-1");
  assert.equal(plan.deliveryStatus, "blocked");
  await planner.skipTask("plan-1", "t1", { reason: "abandoned" });

  const after = store.get("plan-1");
  assert.equal(after.deliveryStatus, "implementing");
  assert.equal(after.tasks[1].deliveryStatus, "ready");
  assert.equal(after.tasks[1].headSha, "c".repeat(40));
  assert.deepEqual(after.tasks[1].changedFiles, ["server/invoices.mjs"]);
});

// Skipping twice must be harmless: the board can double-fire, and the second
// call reads a task that is already skipped rather than already integrated.
test("skipping the same task twice is harmless", async (t) => {
  const { store, planner } = launched(t);
  await planner.skipTask("plan-1", "t1", { reason: "first" });
  const second = await planner.skipTask("plan-1", "t1", { reason: "second" });
  assert.equal(second.skipped, true);
  assert.equal(store.get("plan-1").tasks[0].launchError, "second");
});
