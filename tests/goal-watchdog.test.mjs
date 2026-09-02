import assert from "node:assert/strict";
import test from "node:test";

import { GoalWatchdog } from "../server/goal-watchdog.mjs";

function sweep(goals, { sessionsAvailable = true } = {}) {
  return {
    sweep: async () => ({
      checkedAt: "2026-09-03T12:00:00.000Z",
      sessionsAvailable,
      goals,
      summary: { goals: goals.length, tasks: 0, stuck: 0, needsYou: 0, working: 0, deadTasks: 0, idleTasks: 0, failedTasks: 0 },
    }),
  };
}

function goal(overrides = {}) {
  return {
    planId: "plan-1",
    goal: "Ship the board",
    health: "dead",
    stuckCount: 1,
    tasks: [{ id: "T1", health: "dead", reason: "This task session is no longer open in cmux" }],
    merge: null,
    ...overrides,
  };
}

function push() {
  const sent = [];
  return { sent, send: async (payload) => { sent.push(payload); } };
}

test("pushes one alert for a dead goal and carries the plan id for the deep link", async () => {
  const pushService = push();
  const watchdog = new GoalWatchdog({ health: sweep([goal()]), pushService });
  const result = await watchdog.check();

  assert.equal(result.checked, true);
  assert.deepEqual(result.alerts.map((alert) => alert.planId), ["plan-1"]);
  assert.equal(pushService.sent.length, 1);
  assert.equal(pushService.sent[0].title, "A goal stopped");
  assert.match(pushService.sent[0].body, /Ship the board — This task session is no longer open/);
  assert.equal(pushService.sent[0].planId, "plan-1");
  assert.equal(pushService.sent[0].kind, "failure");
  assert.equal(pushService.sent[0].tag, "goal-health:plan-1");
});

test("does not repeat an alert while the goal stays in the same state", async () => {
  const pushService = push();
  const watchdog = new GoalWatchdog({ health: sweep([goal()]), pushService });

  await watchdog.check();
  const second = await watchdog.check();

  assert.deepEqual(second.alerts, []);
  assert.equal(pushService.sent.length, 1);
});

test("alerts again when the state changes, and after a recovery and a relapse", async () => {
  const pushService = push();
  let current = [goal()];
  const watchdog = new GoalWatchdog({ health: { sweep: async () => ({ sessionsAvailable: true, goals: current, summary: {} }) }, pushService });

  await watchdog.check();
  // Dead to idle is news: the goal moved, so the operator's picture is stale.
  current = [goal({ health: "idle", tasks: [{ id: "T1", health: "idle", reason: "quiet for 40 minutes" }] })];
  await watchdog.check();
  assert.equal(pushService.sent.length, 2);

  // A relaunch fixed it. No alert, and the memory is dropped.
  current = [goal({ health: "working", tasks: [{ id: "T1", health: "working", reason: "running" }] })];
  await watchdog.check();
  assert.equal(pushService.sent.length, 2);
  assert.equal(watchdog.alerted.has("plan-1"), false);

  // It died again. That is a new fact, so it alerts again.
  current = [goal()];
  await watchdog.check();
  assert.equal(pushService.sent.length, 3);
});

test("stays silent for healthy verdicts", async () => {
  const pushService = push();
  const goals = ["working", "ready", "integrated", "queued", "unknown"].map((health, index) => (
    goal({ planId: `plan-${index}`, health, tasks: [{ id: "T1", health, reason: "fine" }] })
  ));
  const result = await new GoalWatchdog({ health: sweep(goals), pushService }).check();

  assert.deepEqual(result.alerts, []);
  assert.equal(pushService.sent.length, 0);
});

test("skips the whole pass when cmux could not be reached", async () => {
  const pushService = push();
  const watchdog = new GoalWatchdog({ health: sweep([goal()], { sessionsAvailable: false }), pushService });
  const result = await watchdog.check();

  // Every session reads as unknown when cmux is closed. Alerting on that would
  // report every agent as dead each time the user quits cmux.
  assert.equal(result.checked, false);
  assert.deepEqual(result.alerts, []);
  assert.equal(pushService.sent.length, 0);
  // And the memory is untouched, so a goal that was already alerted is not
  // re-alerted the moment cmux comes back.
  assert.equal(watchdog.alerted.size, 0);
});

test("a goal that leaves the sweep is forgotten, so the memory stays bounded", async () => {
  const pushService = push();
  let current = [goal(), goal({ planId: "plan-2" })];
  const watchdog = new GoalWatchdog({ health: { sweep: async () => ({ sessionsAvailable: true, goals: current, summary: {} }) }, pushService });

  await watchdog.check();
  assert.equal(watchdog.alerted.size, 2);

  current = [goal()];
  await watchdog.check();
  assert.deepEqual([...watchdog.alerted.keys()], ["plan-1"]);
});

test("a push that throws never stops the sweep", async () => {
  const warnings = [];
  const broken = { send: async () => { throw new Error("no subscriptions"); } };
  const watchdog = new GoalWatchdog({
    health: sweep([goal(), goal({ planId: "plan-2", health: "needs_you", tasks: [{ id: "T1", health: "needs_you", reason: "waiting for an answer" }] })]),
    pushService: broken,
    log: { warn: (_details, message) => warnings.push(message) },
  });
  const result = await watchdog.check();

  assert.equal(result.alerts.length, 2);
  assert.equal(warnings.length, 2);
});

test("runs with no push service at all", async () => {
  const result = await new GoalWatchdog({ health: sweep([goal()]) }).check();
  assert.equal(result.alerts.length, 1);
});

test("needs_you is a decision, not a failure", async () => {
  const pushService = push();
  const waiting = goal({ health: "needs_you", tasks: [{ id: "T1", health: "needs_you", reason: "This task agent is waiting for an answer" }] });
  await new GoalWatchdog({ health: sweep([waiting]), pushService }).check();

  assert.equal(pushService.sent[0].kind, "decision");
  assert.equal(pushService.sent[0].title, "A goal is waiting for you");
});

test("start schedules a first pass and stop cancels it", async () => {
  const pushService = push();
  const watchdog = new GoalWatchdog({ health: sweep([goal()]), pushService, intervalMs: 10, startDelayMs: 1 });
  const detach = watchdog.start();
  // A second start does not create a second timer.
  watchdog.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  detach();

  assert.equal(watchdog.timer, null);
  assert.equal(pushService.sent.length, 1, "the repeated pass dedupes, so only the first alert is sent");
});

test("requires a health sweep", () => {
  assert.throws(() => new GoalWatchdog({}), /health sweep is required/);
});
