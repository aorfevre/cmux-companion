import { seedLegacyPlan } from "./helpers/legacy-plan-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBriefs } from "../server/agent-brief.mjs";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";
import { WorktreePlanner, describeTimeout, streamExecFile } from "../server/worktree-planner.mjs";

// Each launch test writes its briefs to its own directory, and the whole set is
// removed when the process exits.
const briefRoots = [];
process.on("exit", () => { for (const root of briefRoots) rmSync(root, { recursive: true, force: true }); });

const REPO_ID = "repository12345678";

function envelope(text, sessionId = "session-1") {
  return `${JSON.stringify({ session_id: sessionId, result: text })}\n`;
}

function usageFor(claudePercent, codexPercent) {
  return {
    providers: [
      { id: "claude", accounts: [{ status: "ready", windows: [{ category: "usage", cadence: "5h", remainingPercent: claudePercent }] }] },
      { id: "codex", accounts: [{ status: "ready", windows: [{ category: "usage", cadence: "5h", remainingPercent: codexPercent }] }] },
    ],
  };
}

function fakeDeps({ replies = [] }) {
  const calls = [];
  const queue = [...replies];
  return {
    calls,
    worktrees: {
      snapshot: async () => ({
        repositories: [{
          id: REPO_ID,
          name: "sample",
          path: "/repo/sample",
          worktrees: [{ id: "worktree1234567890", branch: "main", path: "/repo/sample", isPrimary: true }],
        }],
      }),
    },
    cmux: { workspaceCreate: async () => ({ workspace_id: "ws-1" }) },
    accountUsage: { snapshot: async () => usageFor(90, 20) },
    execute: async (bin, args, options) => {
      calls.push([bin, args, options]);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { stdout: next ?? "" };
    },
  };
}

test("the run registry refuses a stage it does not define", () => {
  const planner = new WorktreePlanner(fakeDeps({ replies: [] }));
  planner.runs.begin("plan-1", "plan");
  assert.throws(() => planner.runs.setStage("plan-1", "shipping"), /Unknown planner run stage/);
  planner.runs.setStage("plan-1", "review_spec");
  assert.equal(planner.runs.get("plan-1").stage, "review_spec");
  // A finished run keeps the stage it ended on.
  planner.runs.finish("plan-1", { phase: "done" });
  planner.runs.setStage("plan-1", "writing_spec");
  assert.equal(planner.runs.get("plan-1").stage, "review_spec");
});

test("a real child process stops when its abort signal fires", async () => {
  const controller = new AbortController();
  const promise = streamExecFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal, timeout: 30_000 });
  controller.abort();
  const failure = await promise.then(() => null, (cause) => cause);
  assert.ok(failure, "an aborted child must reject");
  assert.equal(failure.killed, true);
  assert.equal(failure.reason, "aborted");
  assert.match(describeTimeout(failure.reason, 1_000, 2_000), /aborted/);
});

test("an already aborted signal stops the child before it can produce output", async () => {
  const failure = await streamExecFile(process.execPath, ["-e", "console.log('hello')"], { signal: AbortSignal.abort(), timeout: 30_000 })
    .then(() => null, (cause) => cause);
  assert.equal(failure.reason, "aborted");
});

test("a finished round removes its abort listener from a shared controller", async () => {
  const controller = new AbortController();
  await streamExecFile(process.execPath, ["-e", "console.log('done')"], { signal: controller.signal, timeout: 30_000 });
  // A listener left behind would keep the finished round reachable from the
  // controller, and would try to kill a child that no longer exists.
  assert.doesNotThrow(() => controller.abort());
});

// --- background launch ---------------------------------------------------

const TASKS_REPLY = '{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."},{"title":"Invoices","branch":"feature/invoices","prompt":"Add invoices."}]}';

// A launch that is held open on purpose. `gate` blocks the very first worktree
// creation, so the test can act while the launch is still in flight.
function gatedLaunchDeps({ reply = TASKS_REPLY, gitFails = false } = {}) {
  const deps = fakeDeps({ replies: [envelope(reply, "sess-a")] });
  const root = mkdtempSync(join(tmpdir(), "launch-briefs-"));
  briefRoots.push(root);
  deps.briefs = new AgentBriefs({ directory: join(root, "briefs") });
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  deps.created = [];
  deps.sessions = [];
  deps.worktrees.create = async (repositoryId, options) => {
    await gate;
    deps.created.push(options.branch);
    return { created: true, worktree: { id: "w1", branch: options.branch, path: `/repo/sample-${options.branch.replace(/\W+/g, "-")}` } };
  };
  deps.cmux = {
    workspaceCreate: async (options) => { deps.sessions.push(options.cwd); return { workspace_id: `ws-${deps.sessions.length}` }; },
    workspaceListDetailed: async () => ({ workspaces: [] }),
  };
  deps.git = async (cwd, args) => {
    if (args[0] === "symbolic-ref") return "origin/main\n";
    if (args[0] === "fetch" && gitFails) throw Object.assign(new Error("fetch failed"), { stderr: "fatal: could not resolve host: github.com" });
    return "";
  };
  return { deps, release, gate };
}

// A background launch runs after the request ends, so a test waits on the
// launch registry rather than on a promise no caller holds.
async function launchSettled(planner, planId, timeoutMs = 5_000) {
  // Counting event-loop turns can exhaust the budget before brief-file I/O
  // finishes on CI. Bound actual elapsed time and yield to the filesystem.
  const deadline = performance.now() + timeoutMs;
  while (planner.isLaunching(planId)) {
    if (performance.now() >= deadline) throw new Error(`the launch for ${planId} never finished`);
    await delay(5);
  }
}

async function readyPlan(planner) {
  return seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
}

test("a background launch answers before any worktree or session is created", async () => {
  const { deps, release } = gatedLaunchDeps();
  const planner = new WorktreePlanner(deps);
  const draft = await readyPlan(planner);

  const answer = await planner.launchBackground(draft.planId);
  assert.equal(answer.planId, draft.planId);
  assert.equal(answer.launching, true);
  // The gate is still closed, so nothing may have been created yet.
  assert.deepEqual(deps.created, []);
  assert.deepEqual(deps.sessions, []);

  release();
  await launchSettled(planner, draft.planId);
  assert.deepEqual(deps.created, ["feature/billing", "feature/invoices"]);
  assert.equal(deps.sessions.length, 2);
});

test("a background launch waits for delayed brief-file I/O", async () => {
  const { deps, release } = gatedLaunchDeps();
  const write = deps.briefs.write.bind(deps.briefs);
  deps.briefs.write = async (options) => { await delay(50); return write(options); };
  const planner = new WorktreePlanner(deps);
  const draft = await readyPlan(planner);
  await planner.launchBackground(draft.planId);
  release();
  await launchSettled(planner, draft.planId);
  assert.deepEqual(deps.created, ["feature/billing", "feature/invoices"]);
  assert.equal(deps.sessions.length, 2);
});

test("a second launch while one is in flight is refused and launches nothing twice", async () => {
  const { deps, release } = gatedLaunchDeps();
  const planner = new WorktreePlanner(deps);
  const draft = await readyPlan(planner);
  await planner.launchBackground(draft.planId);

  await assert.rejects(() => planner.launchBackground(draft.planId), /launching right now/);
  await assert.rejects(() => planner.launch(draft.planId), /launching right now/);

  release();
  await launchSettled(planner, draft.planId);
  assert.deepEqual(deps.created, ["feature/billing", "feature/invoices"]);
  assert.equal(deps.sessions.length, 2);
});

test("a finished background launch notifies with the number of sessions started", async () => {
  const { deps, release } = gatedLaunchDeps();
  const sent = [];
  const planner = new WorktreePlanner({ ...deps, pushService: { send: async (payload) => { sent.push(payload); } } });
  const draft = await readyPlan(planner);
  await planner.launchBackground(draft.planId);
  release();
  await launchSettled(planner, draft.planId);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "completion");
  assert.equal(sent[0].planId, draft.planId);
  assert.equal(sent[0].tag, `cmux-plan-${draft.planId}`);
  assert.match(sent[0].body, /2 sessions started/);
});

// The fetch runs before the per-task try/catch, so it is the failure that used
// to leave a plan with no launch rows and no reason at all.
test("a background launch that throws before any task notifies and stores its reason", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const { deps, release } = gatedLaunchDeps({ gitFails: true });
  const sent = [];
  const planner = new WorktreePlanner({ ...deps, store, pushService: { send: async (payload) => { sent.push(payload); } } });
  const draft = await readyPlan(planner);
  await planner.launchBackground(draft.planId);
  release();
  await launchSettled(planner, draft.planId);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "failure");
  assert.match(sent[0].body, /could not fetch/i);

  const stored = store.get(draft.planId);
  assert.match(stored.lastError, /could not fetch/i);
  assert.deepEqual(stored.tasks.map((task) => task.launchStatus), ["failed", "failed"]);
  assert.match(stored.tasks[0].launchError, /could not fetch/i);

  const reopened = await planner.detail(draft.planId);
  assert.match(reopened.lastError, /could not fetch/i);
  assert.equal(reopened.launching, false);
});

test("a background launch where every task fails reports a failure, not a success", async () => {
  const { deps, release } = gatedLaunchDeps();
  deps.worktrees.create = async () => { throw new TypeError("That branch already has a worktree"); };
  const sent = [];
  const planner = new WorktreePlanner({ ...deps, pushService: { send: async (payload) => { sent.push(payload); } } });
  const draft = await readyPlan(planner);
  await planner.launchBackground(draft.planId);
  release();
  await launchSettled(planner, draft.planId);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "failure");
  assert.match(sent[0].body, /already has a worktree/);
});

test("a push service that throws never fails a background launch", async () => {
  const { deps, release } = gatedLaunchDeps();
  const planner = new WorktreePlanner({ ...deps, pushService: { send: async () => { throw new Error("no subscriptions"); } } });
  const draft = await readyPlan(planner);
  await planner.launchBackground(draft.planId);
  release();
  await launchSettled(planner, draft.planId);
  assert.equal(deps.sessions.length, 2);
});

test("the launching marker is reported while the launch runs and dropped once it settles", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const { deps, release } = gatedLaunchDeps();
  const planner = new WorktreePlanner({ ...deps, store });
  const draft = await readyPlan(planner);
  await planner.launchBackground(draft.planId);

  const listed = (await planner.list({ status: "all" })).plans[0];
  assert.equal(listed.launching, true);
  // A launch is not a specification round, so it must carry no run stage and
  // must not read as a plan that is being written.
  assert.equal(listed.running, false);
  assert.equal(listed.runStage, null);
  assert.notEqual(listed.boardState, "writing_spec");
  assert.equal((await planner.detail(draft.planId)).launching, true);

  release();
  await launchSettled(planner, draft.planId);
  assert.equal((await planner.list({ status: "all" })).plans[0].launching, false);
  assert.equal((await planner.detail(draft.planId)).launching, false);
});

test("a background launch invalidates the dashboard caches only after it settles", async () => {
  const { deps, release } = gatedLaunchDeps();
  const settledIds = [];
  const planner = new WorktreePlanner({ ...deps, onLaunchSettled: (planId) => settledIds.push(planId) });
  const draft = await readyPlan(planner);
  await planner.launchBackground(draft.planId);
  assert.deepEqual(settledIds, []);
  release();
  await launchSettled(planner, draft.planId);
  assert.deepEqual(settledIds, [draft.planId]);
});

test("a background launch refuses a plan that is not ready in the caller's hand", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Which database?"}]}', "sess-a")] });
  const planner = new WorktreePlanner(deps);
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
  await assert.rejects(() => planner.launchBackground(draft.planId), /not ready to launch/);
  assert.equal(planner.isLaunching(draft.planId), false);
});

for (const second of ["launch", "launchBackground"]) {
  test(`an awaited launch claims ownership before a concurrent ${second}`, async () => {
    const { deps, release } = gatedLaunchDeps();
    const planner = new WorktreePlanner(deps);
    const draft = await readyPlan(planner);
    const first = planner.launch(draft.planId);
    // Both calls can enter asynchronous draft validation before the claim.
    await assert.rejects(() => planner[second](draft.planId), /launching right now/);
    assert.equal(planner.isLaunching(draft.planId), true);
    release();
    await first;
    assert.equal(planner.isLaunching(draft.planId), false);
    assert.deepEqual(deps.created, ["feature/billing", "feature/invoices"]);
    assert.equal(deps.sessions.length, 2);
  });
}

test("launch registry capacity refuses new claims without evicting live owners", async () => {
  const { LaunchRuns } = await import("../server/launch-runs.mjs");
  const runs = new LaunchRuns();
  for (let index = 0; index < 200; index++) assert.equal(runs.begin(`plan-${index}`), true);
  assert.equal(runs.begin("overflow"), false);
  assert.equal(runs.begin("plan-0"), false);
  assert.equal(runs.isLaunching("plan-0"), true);
  runs.finish("plan-1");
  assert.equal(runs.begin("overflow"), true);
  assert.equal(runs.isLaunching("plan-0"), true);
});
