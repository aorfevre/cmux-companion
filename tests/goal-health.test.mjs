import assert from "node:assert/strict";
import test from "node:test";

import { agentStateFromScreen, DEFAULT_IDLE_MS, GoalHealthSweep, isStuck, screenShowsBlockingPrompt, worst } from "../server/goal-health.mjs";

const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const now = () => NOW;

function plan(overrides = {}) {
  return {
    planId: "plan-1",
    goal: "Ship the board",
    repositoryId: "repo-1",
    repositoryName: "cmux-companion",
    status: "launched",
    deliveryMode: "combined",
    deliveryStatus: "implementing",
    boardStatus: null,
    mergeStatus: null,
    mergeWorkspaceId: null,
    tasks: [],
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    id: "T1",
    title: "Board model",
    branch: "feature/board-model",
    agent: "claude",
    wave: 0,
    launchStatus: "launched",
    launchError: null,
    deliveryStatus: "pending",
    evidenceStatus: null,
    evidenceError: null,
    workspaceId: "ws-1",
    worktreePath: "/repo-board-model",
    sessionClosedAt: null,
    ...overrides,
  };
}

function store(plans) {
  const list = Array.isArray(plans) ? plans : [plans];
  return {
    list: () => list.map((item) => ({ planId: item.planId, boardStatus: item.boardStatus ?? null })),
    get: (planId) => list.find((item) => item.planId === planId) || null,
  };
}

function cmux(workspaces) {
  return { workspaceListDetailed: async () => ({ workspaces }) };
}

function workspace(overrides = {}) {
  return {
    id: "ws-1",
    title: "Board model",
    last_activity_at: NOW - 60_000,
    has_unread: false,
    status: { effective: "working", signals: { any_agent_running: true } },
    ...overrides,
  };
}

test("calls a launched task dead when its cmux session is gone", async () => {
  const sweep = new GoalHealthSweep({ store: store(plan({ tasks: [task()] })), cmux: cmux([]), now });
  const result = await sweep.sweep();

  assert.equal(result.sessionsAvailable, true);
  assert.equal(result.goals.length, 1);
  assert.equal(result.goals[0].health, "dead");
  assert.equal(result.goals[0].tasks[0].health, "dead");
  assert.match(result.goals[0].tasks[0].reason, /no longer open in cmux/);
  assert.equal(result.summary.deadTasks, 1);
  assert.equal(result.summary.stuck, 1);
});

test("reports a running agent as working and never as stuck", async () => {
  const sweep = new GoalHealthSweep({ store: store(plan({ tasks: [task()] })), cmux: cmux([workspace()]), now });
  const result = await sweep.sweep();

  assert.equal(result.goals[0].health, "working");
  assert.equal(result.goals[0].stuckCount, 0);
  assert.equal(result.goals[0].tasks[0].session.id, "ws-1");
  assert.equal(isStuck(result.goals[0].health), false);
});

test("an open session with no activity for longer than the idle window is idle", async () => {
  const quiet = workspace({
    last_activity_at: NOW - DEFAULT_IDLE_MS - 60_000,
    has_unread: false,
    status: { effective: "done", signals: { any_agent_running: false } },
  });
  const sweep = new GoalHealthSweep({ store: store(plan({ tasks: [task()] })), cmux: cmux([quiet]), now });
  const result = await sweep.sweep();

  assert.equal(result.goals[0].tasks[0].health, "idle");
  assert.equal(result.summary.idleTasks, 1);
  assert.equal(isStuck("idle"), true);
});

test("an agent that asked a question needs you rather than a relaunch", async () => {
  const asking = workspace({ has_unread: true, status: { effective: "waiting", signals: { any_agent_needs_input: true } } });
  const sweep = new GoalHealthSweep({ store: store(plan({ tasks: [task()] })), cmux: cmux([asking]), now });
  const result = await sweep.sweep();

  assert.equal(result.goals[0].health, "needs_you");
  assert.equal(result.summary.needsYou, 1);
  assert.equal(result.summary.stuck, 0);
});

test("a visible trust prompt repairs a missing cmux needs-input signal", async () => {
  let reads = 0;
  const quiet = workspace({
    terminals: [{ id: "surface-1", title: "xcodex" }],
    status: { effective: "todo", signals: { any_agent_running: false, any_agent_needs_input: false } },
  });
  const fakeCmux = {
    workspaceListDetailed: async () => ({ workspaces: [quiet] }),
    readScreen: async (surfaceId) => {
      reads += 1;
      assert.equal(surfaceId, "surface-1");
      return { text: "Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit" };
    },
  };
  const sweep = new GoalHealthSweep({ store: store(plan({ tasks: [task()] })), cmux: fakeCmux, now });
  const first = await sweep.sweep();
  const second = await sweep.sweep();

  assert.equal(first.goals[0].health, "needs_you");
  assert.match(first.goals[0].tasks[0].reason, /cmux status did not report/);
  assert.equal(first.goals[0].tasks[0].session.inputEvidence, "terminal_screen");
  assert.equal(reads, 1, "the next poll reuses the short screen cache");
  assert.equal(second.goals[0].health, "needs_you");
});

test("screen prompt detection is narrow to agent approval and trust dialogs", () => {
  assert.equal(screenShowsBlockingPrompt("Do you trust the files in this folder?"), true);
  assert.equal(screenShowsBlockingPrompt("Would you like to run the following command?"), true);
  assert.equal(screenShowsBlockingPrompt("Tests passed. Waiting for your next task."), false);
});

test("a visibly thinking Claude session repairs a missing running signal", async () => {
  const quiet = workspace({
    terminals: [{ id: "surface-1", title: "xclaude" }],
    status: { effective: "todo", signals: { any_agent_running: false, any_agent_needs_input: false } },
  });
  const fakeCmux = {
    workspaceListDetailed: async () => ({ workspaces: [quiet] }),
    readScreen: async () => ({ text: "· Zesting… (11s · ↓ 307 tokens · thinking with medium effort)\n❯" }),
  };
  const result = await new GoalHealthSweep({ store: store(plan({ tasks: [task()] })), cmux: fakeCmux, now }).sweep();
  assert.equal(result.goals[0].tasks[0].health, "working");
  assert.match(result.goals[0].tasks[0].reason, /visibly working although cmux status/);
  assert.equal(result.goals[0].tasks[0].session.workingEvidence, "terminal_screen");
  assert.equal(agentStateFromScreen("Working (12s • esc to interrupt)"), "working");
  assert.equal(agentStateFromScreen("Tests passed. Ready for the next task."), null);
});

// cmux sets `has_unread` whenever a turn ends with nobody watching, so an agent
// that crashed to a shell prompt carries it too. Reading it as a question would
// label every silent crash as "waiting for an answer" and, worse, keep it out
// of the idle clock for ever.
test("unread output alone is not a question, and still reaches the idle clock", async () => {
  const crashed = workspace({
    has_unread: true,
    last_activity_at: NOW - DEFAULT_IDLE_MS - 60_000,
    status: { effective: "done", signals: { any_agent_running: false } },
  });
  const result = await new GoalHealthSweep({ store: store(plan({ tasks: [task()] })), cmux: cmux([crashed]), now }).sweep();

  assert.equal(result.goals[0].tasks[0].health, "idle");
  assert.match(result.goals[0].tasks[0].reason, /output nobody has read/);
  assert.equal(result.summary.needsYou, 0);
  assert.equal(result.summary.idleTasks, 1);
});

// A skipped task was dropped on purpose. Reporting it as queued for a wave
// would tell the user to wait for work that will never run.
test("a skipped task says it was skipped, not that it is queued", async () => {
  const skipped = task({ launchStatus: "skipped", launchError: "Superseded by task T3", workspaceId: null });
  const result = await new GoalHealthSweep({ store: store(plan({ tasks: [skipped] })), cmux: cmux([]), now }).sweep();

  assert.equal(result.goals[0].tasks[0].health, "skipped");
  assert.equal(result.goals[0].tasks[0].reason, "Superseded by task T3");
  assert.equal(result.goals[0].stuckCount, 0);
});

test("an unreachable cmux reports unknown instead of declaring live agents dead", async () => {
  const broken = { workspaceListDetailed: async () => { throw new Error("cmux is closed"); } };
  const warnings = [];
  const sweep = new GoalHealthSweep({
    store: store(plan({ tasks: [task()] })),
    cmux: broken,
    log: { warn: (_details, message) => warnings.push(message) },
    now,
  });
  const result = await sweep.sweep();

  assert.equal(result.sessionsAvailable, false);
  assert.equal(result.goals[0].tasks[0].health, "unknown");
  assert.match(result.goals[0].tasks[0].reason, /could not be reached/);
  assert.equal(result.summary.stuck, 0);
  assert.equal(warnings.length, 1);
});

test("a failed launch is stuck without needing a session, and a queued task is not", async () => {
  const tasks = [
    task({ id: "T1", launchStatus: "failed", launchError: "Branch already exists", workspaceId: null }),
    task({ id: "T2", launchStatus: "queued", wave: 1, workspaceId: null }),
  ];
  const sweep = new GoalHealthSweep({ store: store(plan({ tasks })), cmux: cmux([]), now });
  const result = await sweep.sweep();

  assert.equal(result.goals[0].tasks[0].health, "failed");
  assert.equal(result.goals[0].tasks[0].reason, "Branch already exists");
  assert.equal(result.goals[0].tasks[1].health, "queued");
  assert.match(result.goals[0].tasks[1].reason, /wave 1/);
  assert.equal(result.summary.failedTasks, 1);
  assert.equal(result.goals[0].stuckCount, 1);
});

test("finished work needs no live agent", async () => {
  const tasks = [
    task({ id: "T1", deliveryStatus: "ready" }),
    task({ id: "T2", deliveryStatus: "integrated" }),
  ];
  const sweep = new GoalHealthSweep({ store: store(plan({ tasks })), cmux: cmux([]), now });
  const result = await sweep.sweep();

  assert.equal(result.goals[0].tasks[0].health, "ready");
  assert.equal(result.goals[0].tasks[1].health, "integrated");
  assert.equal(result.goals[0].readyCount, 2);
  assert.equal(result.goals[0].stuckCount, 0);
});

// The worst false alarm there is: the goal succeeded, its agent finished and
// closed, and the sweep reported it as dead twenty minutes later.
test("a goal with an open pull request has finished, whatever its session did", async () => {
  const delivered = plan({ deliveryMode: "single", boardPrState: "OPEN", tasks: [task()] });
  const result = await new GoalHealthSweep({ store: store(delivered), cmux: cmux([]), now }).sweep();

  assert.equal(result.goals[0].tasks[0].health, "ready");
  assert.equal(result.goals[0].tasks[0].reason, "This task opened its pull request");
  assert.equal(result.goals[0].health, "ready");
  assert.equal(result.summary.stuck, 0);

  // A recorded final pull request counts as the same evidence.
  const finished = plan({ deliveryMode: "single", finalPrUrl: "https://github.test/pr/9", tasks: [task()] });
  const after = await new GoalHealthSweep({ store: store(finished), cmux: cmux([]), now }).sweep();
  assert.equal(after.goals[0].health, "ready");
});

test("a closed pull request does not hide a dead task behind its stale URL", async () => {
  const reopened = plan({
    deliveryMode: "single",
    boardPrState: "CLOSED",
    finalPrUrl: "https://github.test/pr/9",
    tasks: [task()],
  });
  const result = await new GoalHealthSweep({ store: store(reopened), cmux: cmux([]), now }).sweep();

  assert.equal(result.goals[0].tasks[0].health, "dead");
  assert.equal(result.goals[0].health, "dead");
  assert.equal(result.goals[0].stuckCount, 1);
  assert.match(result.goals[0].tasks[0].reason, /no longer open in cmux/);
});

test("checks a single-task goal, which no other watcher covers", async () => {
  const single = plan({ deliveryMode: "single", tasks: [task()] });
  const sweep = new GoalHealthSweep({ store: store(single), cmux: cmux([]), now });
  const result = await sweep.sweep();

  assert.equal(result.goals.length, 1);
  assert.equal(result.goals[0].deliveryMode, "single");
  assert.equal(result.goals[0].health, "dead");
});

test("checks the merge session only while a merge is running", async () => {
  const merging = plan({
    mergeStatus: "running",
    mergeWorkspaceId: "ws-merge",
    tasks: [task({ deliveryStatus: "ready" })],
  });
  const sweep = new GoalHealthSweep({ store: store(merging), cmux: cmux([]), now });
  const result = await sweep.sweep();

  assert.equal(result.goals[0].merge.health, "dead");
  assert.match(result.goals[0].merge.reason, /merge session is no longer open/);
  assert.equal(result.goals[0].health, "dead");

  const settled = plan({ mergeStatus: "done", mergeWorkspaceId: "ws-merge", tasks: [task({ deliveryStatus: "integrated" })] });
  const after = await new GoalHealthSweep({ store: store(settled), cmux: cmux([]), now }).sweep();
  assert.equal(after.goals[0].merge, null);
});

test("a persistently blocked merge is stuck even when its cmux workspace is still open", async () => {
  const blocked = plan({
    deliveryStatus: "blocked",
    deliveryError: "The wave merge agent stopped before every task was integrated",
    mergeStatus: "blocked",
    mergeWorkspaceId: "ws-merge",
    tasks: [task({ deliveryStatus: "ready" })],
  });
  const openShell = workspace({
    id: "ws-merge",
    title: "CC-MERGE · Assemble goal",
    status: { effective: "todo", signals: { any_agent_running: false } },
  });
  const result = await new GoalHealthSweep({ store: store(blocked), cmux: cmux([openShell]), now }).sweep();

  assert.equal(result.goals[0].health, "failed");
  assert.equal(result.goals[0].stuckCount, 1);
  assert.equal(result.goals[0].merge.kind, "merge");
  assert.equal(result.goals[0].merge.session.id, "ws-merge");
  assert.equal(result.goals[0].merge.observedHealth, "working");
  assert.match(result.goals[0].merge.reason, /stopped before every task/);
  assert.equal(result.summary.stuck, 1);
});

test("completed tasks keep their live cmux session as observable evidence", async () => {
  const ready = plan({ tasks: [task({ deliveryStatus: "ready" })] });
  const result = await new GoalHealthSweep({ store: store(ready), cmux: cmux([workspace()]), now }).sweep();

  assert.equal(result.goals[0].tasks[0].health, "ready");
  assert.equal(result.goals[0].tasks[0].session.id, "ws-1");
});

test("skips terminal goals and goals the store cannot read", async () => {
  const plans = [
    plan({ planId: "plan-merged", boardStatus: "merged", tasks: [task()] }),
    plan({ planId: "plan-aborted", boardStatus: "aborted", tasks: [task()] }),
    plan({ planId: "plan-live", tasks: [task()] }),
  ];
  const sweep = new GoalHealthSweep({ store: store(plans), cmux: cmux([]), now });
  const result = await sweep.sweep();

  assert.deepEqual(result.goals.map((goal) => goal.planId), ["plan-live"]);
});

test("an unreadable plan list returns an empty sweep instead of throwing", async () => {
  const broken = { list: () => { throw new Error("database is locked"); }, get: () => null };
  const sweep = new GoalHealthSweep({ store: broken, cmux: cmux([]), now });
  const result = await sweep.sweep();

  assert.deepEqual(result.goals, []);
  assert.equal(result.summary.goals, 0);
  assert.equal(result.sessionsAvailable, false);
});

test("inspect reads one goal and refuses an unknown plan", async () => {
  const sweep = new GoalHealthSweep({ store: store(plan({ tasks: [task()] })), cmux: cmux([workspace()]), now });
  const report = await sweep.inspect("plan-1");
  assert.equal(report.health, "working");
  await assert.rejects(() => sweep.inspect("nope"), /Unknown plan/);
});

test("worst ranks the sickest task and defaults to unknown", () => {
  assert.equal(worst(["working", "dead", "ready"]), "dead");
  assert.equal(worst(["ready", "idle"]), "idle");
  assert.equal(worst(["working", "needs_you"]), "needs_you");
  assert.equal(worst([]), "unknown");
  assert.equal(worst(["failed", "dead"]), "failed");
});
