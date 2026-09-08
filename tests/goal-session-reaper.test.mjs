import assert from "node:assert/strict";
import test from "node:test";

import { GoalSessionReaper, retirableSessions } from "../server/goal-session-reaper.mjs";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";

const BASE = "a".repeat(40);

const TASKS = [
  { id: "t1", title: "Billing API", branch: "feature/billing-api", prompt: "Build it", agent: "codex" },
  { id: "t2", title: "Billing UI", branch: "feature/billing-ui", prompt: "Build it", agent: "claude" },
];

function memoryStore(t) {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  return store;
}

// A launched combined goal with one session per task and one merge session,
// exactly as a real launch plus a merge leaves it.
function combined(t, { tasks = TASKS, merge = true } = {}) {
  const store = memoryStore(t);
  store.createPlan({ planId: "plan-1", repositoryId: "repository12345678", repositoryName: "sample", cwd: "/repo/sample", goal: "Ship billing" });
  store.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "s", tasks });
  store.recordLaunch("plan-1", {
    base: "origin/main",
    baseSha: BASE,
    results: tasks.map((task, index) => ({ id: task.id, status: "launched", path: `/repo/task-${index}`, workspace: { workspace_id: `workspace-${index}` } })),
  });
  if (merge) store.recordMergeLaunched("plan-1", "workspace-merge");
  return store;
}

// Every workspace the fixture opened, all idle. cmux reports a live workspace
// with no busy signal for an agent that finished its turn.
function workspaces(ids, overrides = {}) {
  return ids.map((id) => ({ id, title: id, status: { effective: "idle", signals: { any_agent_running: false, any_agent_needs_input: false, is_git_dirty: false } }, ...(overrides[id] || {}) }));
}

function cmux(list) {
  const calls = [];
  return {
    calls,
    closed: () => calls.filter((call) => call[0] === "close").map((call) => call[1]),
    workspaceListDetailed: async () => ({ workspaces: list }),
    workspaceClose: async (workspaceId) => { calls.push(["close", workspaceId]); return { ok: true }; },
  };
}

const ALL = ["workspace-0", "workspace-1", "workspace-merge"];

function reasonFor(kept, workspaceId) {
  return kept.find((entry) => entry.workspaceId === workspaceId)?.reason || "";
}

// --- an open pull request -------------------------------------------------

// The delivery pull request is open, so every task's work is inside it. Only
// the session that owns the merge has anything left to do.
test("an open pull request retires the original task and merge sessions", async (t) => {
  const store = combined(t);
  store.recordGoalPullRequest("plan-1", { number: 7, url: "https://github.test/pr/7", state: "OPEN" });
  const client = cmux(workspaces(ALL));
  const reaper = new GoalSessionReaper({ store, cmux: client });

  const result = await reaper.reap();
  assert.deepEqual(result.closed.map((entry) => entry.workspaceId).sort(), ["workspace-0", "workspace-1", "workspace-merge"]);
  assert.deepEqual(client.closed().sort(), ["workspace-0", "workspace-1", "workspace-merge"]);
  assert.deepEqual(result.kept, []);
  assert.equal(result.failed.length, 0);
  const plan = store.get("plan-1");
  assert.ok(plan.tasks.every((task) => task.sessionClosedAt));
  assert.ok(plan.mergeSessionClosedAt);
});

// A single-task goal has no merge session. Its one task pushed the branch the
// pull request was opened from, so that task's session is the one to keep.
test("an open pull request on a single-task goal retires its task session", async (t) => {
  const store = combined(t, { tasks: [TASKS[0]], merge: false });
  store.recordGoalPullRequest("plan-1", { number: 8, url: "https://github.test/pr/8", state: "OPEN" });
  const client = cmux(workspaces(["workspace-0"]));
  const reaper = new GoalSessionReaper({ store, cmux: client });

  const result = await reaper.reap();
  assert.deepEqual(result.closed.map((entry) => entry.workspaceId), ["workspace-0"]);
  assert.deepEqual(client.closed(), ["workspace-0"]);
  assert.deepEqual(result.kept, []);
});

// --- a goal that ended ----------------------------------------------------

test("a merged goal retires every session it owns, including the merge session", async (t) => {
  const store = combined(t);
  store.recordGoalMerged("plan-1", { number: 7, url: "https://github.test/pr/7" });
  const client = cmux(workspaces(ALL));
  const reaper = new GoalSessionReaper({ store, cmux: client });

  const result = await reaper.reap();
  assert.deepEqual(result.closed.map((entry) => entry.workspaceId).sort(), ALL.slice().sort());
  assert.ok(client.closed().includes("workspace-merge"));
  assert.deepEqual(result.kept, []);
  const plan = store.get("plan-1");
  assert.ok(plan.mergeSessionClosedAt);
  assert.ok(plan.tasks.every((task) => task.sessionClosedAt));
});

test("an aborted goal retires every session it owns, including a superseded merge", async (t) => {
  const store = combined(t);
  // A second merge agent replaced the first, so the plan owns three merge-side
  // ids in total: one live and one superseded.
  store.recordMergeLaunched("plan-1", "workspace-merge-2");
  store.recordGoalAborted("plan-1", { reason: "no longer needed" });
  const ids = ["workspace-0", "workspace-1", "workspace-merge", "workspace-merge-2"];
  const client = cmux(workspaces(ids));
  const reaper = new GoalSessionReaper({ store, cmux: client });

  const result = await reaper.reap();
  assert.deepEqual(result.closed.map((entry) => entry.workspaceId).sort(), ids.slice().sort());
  assert.ok(client.closed().includes("workspace-merge-2"));
  assert.ok(client.closed().includes("workspace-merge"));
  assert.equal(store.get("plan-1").mergeSessionClosedAt !== null, true);
  assert.deepEqual(store.get("plan-1").supersededMergeWorkspaces.filter((entry) => !entry.retiredAt), []);
});

// --- every refusal --------------------------------------------------------

test("a blocked merge closes nothing and says why", async (t) => {
  const store = combined(t);
  store.recordMergeBlocked("plan-1", "The merge agent stopped");
  const client = cmux(workspaces(ALL));

  const result = await new GoalSessionReaper({ store, cmux: client }).reap();
  assert.deepEqual(result.closed, []);
  assert.deepEqual(client.closed(), []);
  assert.equal(result.kept.length, 3);
  for (const id of ALL) assert.match(reasonFor(result.kept, id), /merge is blocked/);
});

test("an unreachable cmux closes nothing and says why", async (t) => {
  const store = combined(t);
  store.recordGoalMerged("plan-1", { number: 7, url: "https://github.test/pr/7" });
  const client = cmux([]);
  client.workspaceListDetailed = async () => { throw new Error("cmux is not running"); };

  const result = await new GoalSessionReaper({ store, cmux: client }).reap();
  assert.equal(result.sessionsAvailable, false);
  assert.deepEqual(result.closed, []);
  assert.deepEqual(client.closed(), []);
  assert.equal(result.kept.length, 3);
  for (const id of ALL) assert.match(reasonFor(result.kept, id), /could not be reached/);
  assert.equal(store.get("plan-1").tasks.some((task) => task.sessionClosedAt), false);
});

test("a running agent keeps its session open", async (t) => {
  const store = combined(t);
  store.recordGoalPullRequest("plan-1", { number: 7, url: "https://github.test/pr/7", state: "OPEN" });
  const client = cmux(workspaces(ALL, { "workspace-0": { status: { effective: "working", signals: { any_agent_running: true } } } }));

  const result = await new GoalSessionReaper({ store, cmux: client }).reap();
  assert.deepEqual(client.closed(), ["workspace-1", "workspace-merge"]);
  assert.match(reasonFor(result.kept, "workspace-0"), /agent is running/);
  assert.equal(store.get("plan-1").tasks[0].sessionClosedAt, null);
});

test("an agent waiting for an answer keeps its session open", async (t) => {
  const store = combined(t);
  store.recordGoalMerged("plan-1", { number: 7, url: "https://github.test/pr/7" });
  const client = cmux(workspaces(ALL, { "workspace-merge": { status: { effective: "idle", signals: { any_agent_needs_input: true } } } }));

  const result = await new GoalSessionReaper({ store, cmux: client }).reap();
  assert.deepEqual(client.closed().sort(), ["workspace-0", "workspace-1"]);
  assert.match(reasonFor(result.kept, "workspace-merge"), /waiting for an answer/);
  assert.equal(store.get("plan-1").mergeSessionClosedAt, null);
});

// The policy may only ever name a workspace id the plan actually persists.
// Anything else belongs to work this goal does not own.
test("it never names a workspace id that the plan does not record", (t) => {
  const store = combined(t);
  store.recordGoalMerged("plan-1", { number: 7, url: "https://github.test/pr/7" });
  const plan = store.get("plan-1");
  const live = { available: true, byId: new Map(workspaces([...ALL, "workspace-stranger"]).map((item) => [item.id, item])) };

  const { close, keep } = retirableSessions(plan, live);
  const named = [...close, ...keep].map((entry) => entry.workspaceId);
  assert.equal(named.includes("workspace-stranger"), false);
  assert.deepEqual(named.slice().sort(), ALL.slice().sort());
});

// --- durability and idempotency ------------------------------------------

test("a second pass closes nothing again", async (t) => {
  const store = combined(t);
  store.recordGoalMerged("plan-1", { number: 7, url: "https://github.test/pr/7" });
  const client = cmux(workspaces(ALL));
  const reaper = new GoalSessionReaper({ store, cmux: client });

  await reaper.reap();
  assert.equal(client.closed().length, 3);
  const second = await reaper.reap();
  assert.deepEqual(second.closed, []);
  assert.deepEqual(second.kept, []);
  assert.equal(client.closed().length, 3);
});

test("a close cmux refuses stays pending and is retried on the next pass", async (t) => {
  const store = combined(t);
  store.recordGoalPullRequest("plan-1", { number: 7, url: "https://github.test/pr/7", state: "OPEN" });
  const client = cmux(workspaces(ALL));
  let refuse = true;
  client.workspaceClose = async (workspaceId) => {
    client.calls.push(["close", workspaceId]);
    if (refuse && workspaceId === "workspace-0") throw new Error("cmux is down");
    return { ok: true };
  };
  const reaper = new GoalSessionReaper({ store, cmux: client });

  const first = await reaper.reap();
  assert.deepEqual(first.closed.map((entry) => entry.workspaceId), ["workspace-1", "workspace-merge"]);
  assert.deepEqual(first.failed.map((entry) => entry.workspaceId), ["workspace-0"]);
  assert.match(first.failed[0].error, /cmux is down/);
  assert.equal(store.get("plan-1").tasks[0].sessionClosedAt, null);

  refuse = false;
  const second = await reaper.reap();
  assert.deepEqual(second.closed.map((entry) => entry.workspaceId), ["workspace-0"]);
  assert.ok(store.get("plan-1").tasks[0].sessionClosedAt);
});

test("a missing-workspace rejection is recorded as retired rather than retried", async (t) => {
  const store = combined(t);
  store.recordGoalMerged("plan-1", { number: 7, url: "https://github.test/pr/7" });
  const client = cmux(workspaces(ALL));
  client.workspaceClose = async (workspaceId) => {
    client.calls.push(["close", workspaceId]);
    throw new Error(`workspace ${workspaceId} not found`);
  };

  const reaper = new GoalSessionReaper({ store, cmux: client });
  const first = await reaper.reap();
  assert.deepEqual(first.closed.map((entry) => entry.workspaceId).sort(), ALL.slice().sort());
  assert.deepEqual(first.failed, []);
  const second = await reaper.reap();
  assert.deepEqual(second.closed, []);
  assert.equal(client.closed().length, 3);
});

// A workspace cmux no longer lists is finished from cmux's point of view.
// Calling close on it would log a failure for a session that is already gone.
test("a workspace the live list does not hold is retired without a close call", async (t) => {
  const store = combined(t);
  store.recordGoalMerged("plan-1", { number: 7, url: "https://github.test/pr/7" });
  const client = cmux(workspaces(["workspace-merge"]));

  const result = await new GoalSessionReaper({ store, cmux: client }).reap();
  assert.deepEqual(client.closed(), ["workspace-merge"]);
  assert.deepEqual(result.closed.filter((entry) => entry.closedInCmux === false).map((entry) => entry.workspaceId).sort(), ["workspace-0", "workspace-1"]);
  assert.ok(store.get("plan-1").tasks.every((task) => task.sessionClosedAt));
});

// --- the kill switch ------------------------------------------------------

test("a disabled reaper is a no-op", async (t) => {
  const store = combined(t);
  store.recordGoalMerged("plan-1", { number: 7, url: "https://github.test/pr/7" });
  const client = cmux(workspaces(ALL));

  const result = await new GoalSessionReaper({ store, cmux: client, enabled: false }).reap();
  assert.deepEqual(result, { checkedAt: result.checkedAt, sessionsAvailable: false, closed: [], kept: [], failed: [] });
  assert.deepEqual(client.calls, []);
  assert.equal(store.get("plan-1").tasks.some((task) => task.sessionClosedAt), false);
});

// --- the rule while the goal is still being assembled ---------------------

// The rule that already existed must keep working: an integrated task and a
// replaced merge session are finished whatever the pull request says.
test("an integrated task and a superseded merge retire before any pull request", async (t) => {
  const store = combined(t);
  store.recordTaskIntegrated("plan-1", "t1", "d".repeat(40));
  store.recordMergeLaunched("plan-1", "workspace-merge-2");
  const ids = ["workspace-0", "workspace-1", "workspace-merge", "workspace-merge-2"];
  const client = cmux(workspaces(ids));

  const result = await new GoalSessionReaper({ store, cmux: client }).reap();
  assert.deepEqual(client.closed().sort(), ["workspace-0", "workspace-merge"]);
  assert.deepEqual(result.kept.map((entry) => entry.workspaceId).sort(), ["workspace-1", "workspace-merge-2"]);
  assert.match(reasonFor(result.kept, "workspace-1"), /not integrated yet/);
});

test("reaping one named plan leaves every other goal untouched", async (t) => {
  const store = combined(t);
  store.recordGoalMerged("plan-1", { number: 7, url: "https://github.test/pr/7" });
  store.createPlan({ planId: "plan-2", repositoryId: "repository12345678", repositoryName: "sample", goal: "Other goal" });
  store.recordRound("plan-2", { round: 1, stage: "ready", sessionId: "s", tasks: [TASKS[0]] });
  store.recordLaunch("plan-2", { base: "origin/main", baseSha: BASE, results: [{ id: "t1", status: "launched", path: "/repo/other", workspace: { workspace_id: "workspace-other" } }] });
  store.recordGoalMerged("plan-2", { number: 8, url: "https://github.test/pr/8" });
  const client = cmux(workspaces([...ALL, "workspace-other"]));

  await new GoalSessionReaper({ store, cmux: client }).reap({ planId: "plan-1" });
  assert.equal(client.closed().includes("workspace-other"), false);
  assert.equal(store.get("plan-2").tasks[0].sessionClosedAt, null);
});

test("a cmux client that cannot close a workspace reports the failure and closes nothing", async (t) => {
  const store = combined(t);
  store.recordGoalMerged("plan-1", { number: 7, url: "https://github.test/pr/7" });
  const client = cmux(workspaces(ALL));
  delete client.workspaceClose;

  const result = await new GoalSessionReaper({ store, cmux: client }).reap();
  assert.deepEqual(result.closed, []);
  assert.equal(result.failed.length, 3);
  assert.equal(store.get("plan-1").tasks.some((task) => task.sessionClosedAt), false);
});

test("recovers a restored merge UUID by exact path and Companion title without rewriting stored ownership", async (t) => {
  const store = combined(t);
  store.recordGoalPullRequest("plan-1", { number: 7, url: "https://github.test/pr/7", state: "OPEN" });
  const original = store.get.bind(store);
  store.get = (id) => ({ ...original(id), integrationWorktreePath: "/repo/goal" });
  const restored = { id: "restored", title: "SMP-MERGE · Ship billing", current_directory: "/repo/goal",
    status: { effective: "done", signals: { any_agent_running: false, any_agent_needs_input: false, is_git_dirty: false } } };
  const list = [restored];
  const client = cmux(list);
  client.workspaceClose = async (id) => { client.calls.push(["close", id]); list.splice(list.findIndex((w) => w.id === id), 1); };
  const reaper = new GoalSessionReaper({ store, cmux: client });
  const result = await reaper.reap();
  assert.ok(result.closed.some((e) => e.workspaceId === "restored" && e.kind === "restored"));
  assert.equal(store.get("plan-1").mergeWorkspaceId, "workspace-merge");
  assert.equal((await reaper.reap()).closed.length, 0);
});

test("restored session reconciliation protects ambiguous, unrelated, unfinished and follow-up workspaces", async () => {
  const { restoredGoalSessions, restoredSessionProtection } = await import("../server/restored-goal-sessions.mjs");
  const plan = { planId: "abc", repositoryName: "sample", integrationWorktreePath: "/repo/goal", boardStatus: "merged", tasks: [] };
  const workspace = { id: "new", title: "SMP-MERGE · Ship billing", current_directory: "/repo/goal" };
  assert.equal(restoredGoalSessions([plan], [workspace])[0].eligible, true);
  assert.equal(restoredGoalSessions([plan, { ...plan, planId: "other" }], [workspace])[0].eligible, false);
  assert.equal(restoredGoalSessions([plan], [{ ...workspace, current_directory: "/repo/elsewhere" }])[0].eligible, false);
  assert.equal(restoredGoalSessions([plan], [{ ...workspace, title: "SMP-ASK · Follow up" }])[0].eligible, false);
  assert.equal(restoredGoalSessions([{ ...plan, boardStatus: null }], [workspace])[0].eligible, false);
  assert.equal(restoredGoalSessions([{ ...plan, followups: [{ workspaceId: "new" }] }], [workspace]).length, 0);
  assert.ok(restoredSessionProtection(workspace));
  for (const signals of [
    { any_agent_running: true, any_agent_needs_input: false, is_git_dirty: false },
    { any_agent_running: false, any_agent_needs_input: true, is_git_dirty: false },
    { any_agent_running: false, any_agent_needs_input: false, is_git_dirty: true },
  ]) assert.ok(restoredSessionProtection({ ...workspace, status: { signals } }));
});

test("restored closure rechecks paths and fresh agent activity and retries individual failures", async (t) => {
  const store = combined(t);
  store.recordGoalPullRequest("plan-1", { number: 7, url: "https://github.test/pr/7", state: "OPEN" });
  const original = store.get.bind(store);
  store.get = (id) => ({ ...original(id), integrationWorktreePath: "/repo/goal" });
  const workspace = { id: "restored", title: "SMP-MERGE · Ship billing", current_directory: "/repo/goal",
    status: { signals: { any_agent_running: false, any_agent_needs_input: false, is_git_dirty: false } } };
  const client = cmux([workspace]);
  let reads = 0;
  client.workspaceListDetailed = async () => ({ workspaces: [{ ...workspace, current_directory: ++reads > 1 ? "/repo/other" : "/repo/goal" }] });
  const reaper = new GoalSessionReaper({ store, cmux: client });
  assert.ok((await reaper.reap()).kept.some((e) => /identity/.test(e.reason)));
  assert.deepEqual(client.closed(), []);
  client.workspaceListDetailed = async () => ({ workspaces: [workspace] });
  client.workspaceStatus = async () => ({ signals: { ...workspace.status.signals, any_agent_running: true } });
  assert.ok((await reaper.reap()).kept.some((e) => /activity/.test(e.reason)));
  assert.deepEqual(client.closed(), []);
  client.workspaceStatus = async () => { throw new Error("status unavailable"); };
  assert.equal((await reaper.reap()).failed[0].error, "status unavailable");
  client.workspaceStatus = async () => workspace.status;
  assert.ok((await reaper.reap()).closed.some((e) => e.workspaceId === "restored"));
});

test("restored reconciliation supports current titles and legacy task titles with integrated evidence", async () => {
  const { restoredGoalSessions } = await import("../server/restored-goal-sessions.mjs");
  const { mergeSessionTitle, sessionTitle } = await import("../server/session-name.mjs");
  const task = { id: "T2", title: "Build UI", type: "ui", worktreePath: "/repo/task", deliveryStatus: "integrated" };
  const plan = { planId: "abc", repositoryName: "sample", goal: "Ship billing", integrationWorktreePath: "/repo/goal", boardStatus: "merged", tasks: [task] };
  for (const title of [sessionTitle(plan, task), "SMP-T2-ui · Build UI"]) {
    assert.equal(restoredGoalSessions([plan], [{ id: "new", title, current_directory: "/repo/task" }])[0].eligible, true);
  }
  assert.equal(restoredGoalSessions([plan], [{ id: "new", title: mergeSessionTitle(plan), current_directory: "/repo/goal" }])[0].eligible, true);
  assert.equal(restoredGoalSessions([{ ...plan, boardStatus: null }], [{ id: "new", title: sessionTitle(plan, task), current_directory: "/repo/task" }])[0].eligible, true);
});

for (const scenario of ["running", "unknown", "dirty", "status-fails", "inventory-fails", "replaced"]) {
  test(`recorded session is protected when fresh evidence becomes ${scenario}`, async (t) => {
    const store = combined(t, { tasks: [TASKS[0]], merge: false });
    store.recordGoalPullRequest("plan-1", { number: 7, url: "https://github.test/pr/7", state: "OPEN" });
    const client = cmux(workspaces(["workspace-0"]));
    let reads = 0;
    client.workspaceListDetailed = async () => {
      if (++reads > 1 && scenario === "inventory-fails") throw new Error("offline");
      return { workspaces: workspaces(["workspace-0"]) };
    };
    client.workspaceStatus = async () => {
      if (scenario === "status-fails") throw new Error("status unavailable");
      if (scenario === "unknown") return {};
      if (scenario === "replaced") store.recordTaskRelaunch("plan-1", "t1", { status: "launched", path: "/repo/task-0", workspace: { workspace_id: "replacement" } });
      return { signals: { any_agent_running: scenario === "running", any_agent_needs_input: false, is_git_dirty: scenario === "dirty" } };
    };
    const result = await new GoalSessionReaper({ store, cmux: client }).reap();
    assert.deepEqual(client.closed(), []);
    assert.equal(result.closed.length, 0);
    assert.equal(store.get("plan-1").tasks[0].sessionClosedAt, null);
  });
}

test("retirement does not stamp a replacement created while old close was awaiting", async (t) => {
  const store = combined(t, { tasks: [TASKS[0]], merge: false });
  store.recordGoalPullRequest("plan-1", { number: 7, url: "https://github.test/pr/7", state: "OPEN" });
  const client = cmux(workspaces(["workspace-0"]));
  client.workspaceClose = async () => {
    store.recordTaskRelaunch("plan-1", "t1", { status: "launched", path: "/repo/task-0", workspace: { workspace_id: "replacement" } });
  };
  await new GoalSessionReaper({ store, cmux: client }).reap();
  const task = store.get("plan-1").tasks[0];
  assert.equal(task.workspaceId, "replacement");
  assert.equal(task.sessionClosedAt, null);
});

test("a managed owner stays available through PR review, even without a task row", async () => {
  const plan = { planId: "managed", workflow: "goal_session", goalSessionWorkspaceId: "owner", goalSessionWorktreePath: "/repo/goal", boardPrState: "OPEN", finalPrUrl: "https://github.test/pr/4", tasks: [] };
  const live = { available: true, byId: new Map(workspaces(["owner"]).map((workspace) => [workspace.id, workspace])) };
  for (const tasks of [[], [{ id: "owner-task", workspaceId: "owner", deliveryStatus: "integrated" }]]) {
    const result = retirableSessions({ ...plan, tasks }, live);
    assert.deepEqual(result.close, []);
    assert.match(reasonFor(result.keep, "owner"), /review and corrections/);
  }
  const { restoredGoalSessions } = await import("../server/restored-goal-sessions.mjs");
  const restored = restoredGoalSessions([plan], [{ id: "restored-owner", title: "Restored goal", current_directory: "/repo/goal" }]);
  assert.equal(restored[0].eligible, false);
  assert.match(restored[0].reason, /review and corrections/);
  assert.deepEqual(restoredGoalSessions([plan], [{ id: "owner", title: "Goal", current_directory: "/repo/goal" }]), []);
});

// --- burst reviewers --------------------------------------------------------

// A burst reviewer lives on the task row beside the task's own session. It is
// finished by its verdict, never by the pull request, and the goal's end
// finishes it like everything else.
function burstCombined(t) {
  const store = combined(t, { merge: false });
  const plan = store.get("plan-1");
  // The fixture creates a plain goal; the burst flag is what makes reviewers exist.
  store.db.prepare("UPDATE plans SET burst = 1 WHERE plan_id = ?").run(plan.planId);
  store.recordBurstReviewLaunched("plan-1", "t1", { workspaceId: "review-0" });
  return store;
}

test("a reviewer still reading stays open while its task's pull request opens", async (t) => {
  const store = burstCombined(t);
  store.recordGoalPullRequest("plan-1", { number: 7, url: "https://github.test/pr/7", state: "OPEN" });
  const client = cmux(workspaces(["workspace-0", "workspace-1", "review-0"]));
  const result = await new GoalSessionReaper({ store, cmux: client }).reap();
  assert.equal(client.closed().includes("review-0"), false);
  assert.match(reasonFor(result.kept, "review-0"), /has not delivered its verdict/);
  assert.equal(result.kept.find((entry) => entry.workspaceId === "review-0").kind, "review");
});

test("a reviewer that delivered its verdict retires before any pull request, and only once", async (t) => {
  const store = burstCombined(t);
  store.recordBurstReviewVerdict("plan-1", "t1", { verdict: "pass" });
  const client = cmux(workspaces(["workspace-0", "workspace-1", "review-0"]));
  const reaper = new GoalSessionReaper({ store, cmux: client });
  const first = await reaper.reap();
  assert.deepEqual(client.closed(), ["review-0"]);
  const entry = first.closed.find((item) => item.workspaceId === "review-0");
  assert.equal(entry.kind, "review");
  assert.equal(entry.taskId, "t1");
  assert.match(entry.reason, /delivered its verdict/);
  assert.ok(store.get("plan-1").tasks[0].burstReviewSessionClosedAt);
  assert.equal(store.get("plan-1").tasks[0].sessionClosedAt, null, "the task's own session is untouched");
  await reaper.reap();
  assert.deepEqual(client.closed(), ["review-0"]);
});

test("an aborted burst goal retires a reviewer that is still reading", async (t) => {
  const store = burstCombined(t);
  store.recordGoalAborted("plan-1");
  const client = cmux(workspaces(["workspace-0", "workspace-1", "review-0"]));
  const result = await new GoalSessionReaper({ store, cmux: client }).reap();
  assert.deepEqual(client.closed().sort(), ["review-0", "workspace-0", "workspace-1"]);
  assert.equal(result.closed.find((item) => item.workspaceId === "review-0").reason, "This goal was aborted");
  assert.ok(store.get("plan-1").tasks[0].burstReviewSessionClosedAt);
});

test("a second review round reopens the reviewer column for its new session", async (t) => {
  const store = burstCombined(t);
  store.recordBurstReviewVerdict("plan-1", "t1", { verdict: "block", findings: ["x"] });
  store.recordSessionsRetired("plan-1", [{ workspaceId: "review-0", taskId: "t1", kind: "review" }]);
  assert.ok(store.get("plan-1").tasks[0].burstReviewSessionClosedAt);
  store.recordBurstReviewLaunched("plan-1", "t1", { workspaceId: "review-1" });
  assert.equal(store.get("plan-1").tasks[0].burstReviewSessionClosedAt, null);
  const { close, keep } = retirableSessions(store.get("plan-1"), { available: true, byId: new Map(workspaces(["review-1"]).map((item) => [item.id, item])) });
  assert.deepEqual(close, []);
  assert.equal(keep.find((entry) => entry.workspaceId === "review-1").kind, "review");
});
