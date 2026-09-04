import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { GitHubIssueSyncScheduler } from "../server/github-issue-sync-scheduler.mjs";

// Every test injects this. The real GitHubIssueSync spawns `gh` over every
// starred repository and writes the production store, so a test that reached it
// would be slow, networked and destructive at once.
function stubSync({ result = { repositories: 0, issues: [] }, onCall = null } = {}) {
  const calls = [];
  return {
    calls,
    sync: async () => {
      calls.push(Date.now());
      if (onCall) return onCall(calls.length);
      return result;
    },
  };
}

// The timer is real and the interval is tiny, so the pass count is asserted by
// polling rather than by a fixed sleep. A machine under load must not turn a
// correct scheduler into a red test.
async function waitFor(predicate, { timeoutMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(5);
  }
  return false;
}

test("runs a pass on every interval without any HTTP request", async () => {
  const sync = stubSync();
  const scheduler = new GitHubIssueSyncScheduler({ sync, intervalMs: 10, startDelayMs: 0 });
  scheduler.start();
  const fired = await waitFor(() => sync.calls.length >= 3);
  scheduler.stop();
  assert.equal(fired, true, "the scheduler should fire repeatedly across several intervals");
});

test("keeps the schedule after a pass throws, and logs the failure", async () => {
  const warnings = [];
  const sync = stubSync({
    onCall: (call) => {
      if (call === 1) throw new Error("gh is not authenticated");
      return { repositories: 1, issues: [] };
    },
  });
  const scheduler = new GitHubIssueSyncScheduler({
    sync,
    intervalMs: 10,
    startDelayMs: 0,
    log: { warn: (fields, message) => warnings.push({ fields, message }) },
  });
  scheduler.start();
  const fired = await waitFor(() => sync.calls.length >= 2);
  scheduler.stop();
  assert.equal(fired, true, "a rejected pass must not stop the next one");
  assert.equal(warnings.length >= 1, true, "the failure must be logged, not thrown");
  assert.match(String(warnings[0].fields.err?.message), /gh is not authenticated/);
});

test("collapses concurrent callers onto one sync, and gives both the same result", async () => {
  let release = null;
  const held = new Promise((resolve) => { release = resolve; });
  const payload = { repositories: 2, issues: [{ number: 7 }] };
  const sync = stubSync({ onCall: async () => { await held; return payload; } });
  const scheduler = new GitHubIssueSyncScheduler({ sync, intervalMs: 10_000, startDelayMs: 10_000 });

  const first = scheduler.syncNow();
  const second = scheduler.syncNow();
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(sync.calls.length, 1, "a second caller must join the running pass");
  assert.equal(a, b, "both callers must resolve with the same object");
  assert.deepEqual(a, payload);
});

test("frees the guard after a failed pass, so the next caller runs a new sync", async () => {
  const sync = stubSync({
    onCall: (call) => {
      if (call === 1) throw new Error("first pass failed");
      return { repositories: 1, issues: [] };
    },
  });
  const scheduler = new GitHubIssueSyncScheduler({ sync, intervalMs: 10_000, startDelayMs: 10_000 });
  await assert.rejects(scheduler.syncNow(), /first pass failed/);
  assert.deepEqual(await scheduler.syncNow(), { repositories: 1, issues: [] });
  assert.equal(sync.calls.length, 2);
});

test("stop() clears the timer, so no handle outlives the server", async () => {
  const sync = stubSync();
  const scheduler = new GitHubIssueSyncScheduler({ sync, intervalMs: 5, startDelayMs: 5 });
  const detach = scheduler.start();
  assert.notEqual(scheduler.timer, null);
  detach();
  assert.equal(scheduler.timer, null);
  await delay(40);
  assert.equal(sync.calls.length, 0, "a stopped scheduler must not fire again");
});

test("rejects a missing sync, and falls back to the hourly defaults on bad numbers", () => {
  assert.throws(() => new GitHubIssueSyncScheduler({}), TypeError);
  const scheduler = new GitHubIssueSyncScheduler({ sync: stubSync(), intervalMs: 0, startDelayMs: -1 });
  assert.equal(scheduler.intervalMs, 60 * 60 * 1_000);
  assert.equal(scheduler.startDelayMs, 60 * 1_000);
});
