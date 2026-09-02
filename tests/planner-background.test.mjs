import assert from "node:assert/strict";
import test from "node:test";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";
import { WorktreePlanner, describeTimeout, streamExecFile } from "../server/worktree-planner.mjs";

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

// A background round runs after the request ends, so a test waits on the run
// registry rather than on a promise no caller holds.
async function settled(planner, planId, attempts = 500) {
  for (let index = 0; index < attempts; index += 1) {
    if (!planner.isRunning(planId)) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`the round for ${planId} never finished`);
}

// A deferred reply, so a test can hold one round open and act while it runs.
function gatedDeps(reply) {
  const deps = fakeDeps({ replies: [] });
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  deps.execute = async () => { await gate; return { stdout: reply }; };
  return { deps, release };
}

test("a background round answers before it runs and finishes on its own", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Which database?"}]}', "sess-a")] });
  const planner = new WorktreePlanner(deps);
  const draft = await planner.startBackground({ repositoryId: REPO_ID, goal: "Add billing" });
  assert.equal(draft.running, true);
  assert.equal(draft.round, 0);
  assert.ok(draft.planId);
  await settled(planner, draft.planId);
  const resumed = await planner.resume(draft.planId);
  assert.equal(resumed.running, false);
  assert.equal(resumed.status, "questions");
  assert.equal(resumed.round, 1);
});

test("two goals plan at the same time and both finish", async () => {
  const first = gatedDeps(envelope('{"questions":[{"text":"One?"}]}', "sess-a"));
  const second = gatedDeps(envelope('{"questions":[{"text":"Two?"}]}', "sess-b"));
  const plannerA = new WorktreePlanner(first.deps);
  const plannerB = new WorktreePlanner(second.deps);
  const draftA = await plannerA.startBackground({ repositoryId: REPO_ID, goal: "Goal A" });
  const draftB = await plannerB.startBackground({ repositoryId: REPO_ID, goal: "Goal B" });
  assert.equal(plannerA.isRunning(draftA.planId), true);
  assert.equal(plannerB.isRunning(draftB.planId), true);
  first.release();
  second.release();
  await settled(plannerA, draftA.planId);
  await settled(plannerB, draftB.planId);
  assert.equal((await plannerA.resume(draftA.planId)).questions[0].text, "One?");
  assert.equal((await plannerB.resume(draftB.planId)).questions[0].text, "Two?");
});

test("one planner runs two of its own plans at the same time", async () => {
  const deps = fakeDeps({ replies: [] });
  const gates = new Map();
  deps.execute = async (bin, args) => {
    const prompt = args.at(-1);
    const key = prompt.includes("Goal A") ? "A" : "B";
    await gates.get(key).promise;
    return { stdout: envelope(`{"questions":[{"text":"${key}?"}]}`, `sess-${key}`) };
  };
  for (const key of ["A", "B"]) {
    let release = () => {};
    const promise = new Promise((resolve) => { release = resolve; });
    gates.set(key, { promise, release });
  }
  const planner = new WorktreePlanner(deps);
  const draftA = await planner.startBackground({ repositoryId: REPO_ID, goal: "Goal A" });
  const draftB = await planner.startBackground({ repositoryId: REPO_ID, goal: "Goal B" });
  assert.equal(planner.activeRuns().runs.filter((run) => run.finishedAt === null).length, 2);
  gates.get("A").release();
  gates.get("B").release();
  await settled(planner, draftA.planId);
  await settled(planner, draftB.planId);
  assert.equal((await planner.resume(draftA.planId)).questions[0].text, "A?");
  assert.equal((await planner.resume(draftB.planId)).questions[0].text, "B?");
});

test("refuses a second round on a plan that is already planning", async () => {
  const { deps, release } = gatedDeps(envelope('{"questions":[{"text":"Which database?"}]}', "sess-a"));
  const planner = new WorktreePlanner(deps);
  const draft = await planner.startBackground({ repositoryId: REPO_ID, goal: "Add billing" });
  await assert.rejects(() => planner.answerBackground(draft.planId, { skip: true }), /planning right now/);
  await assert.rejects(() => planner.answer(draft.planId, { skip: true }), /planning right now/);
  await assert.rejects(() => planner.launch(draft.planId), /planning right now/);
  await assert.rejects(() => planner.remove(draft.planId), /planning right now/);
  release();
  await settled(planner, draft.planId);
});

test("a failed background round records its error and notifies", async () => {
  const deps = fakeDeps({ replies: [new Error("boom")] });
  const sent = [];
  const planner = new WorktreePlanner({ ...deps, pushService: { send: async (payload) => { sent.push(payload); } } });
  const draft = await planner.startBackground({ repositoryId: REPO_ID, goal: "Add billing" });
  await settled(planner, draft.planId);
  const run = planner.runs.get(draft.planId);
  assert.equal(run.phase, "failed");
  assert.ok(run.error);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "failure");
  assert.equal(sent[0].planId, draft.planId);
});

test("notifies with questions when a background round asks something", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Which database?"}]}', "sess-a")] });
  const sent = [];
  const planner = new WorktreePlanner({ ...deps, pushService: { send: async (payload) => { sent.push(payload); } } });
  const draft = await planner.startBackground({ repositoryId: REPO_ID, goal: "Add billing" });
  await settled(planner, draft.planId);
  assert.equal(sent[0].kind, "attention");
  assert.match(sent[0].body, /1 question/);
});

test("notifies with a completion when a background round returns tasks", async () => {
  const deps = fakeDeps({ replies: [envelope('{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}', "sess-a")] });
  const sent = [];
  const planner = new WorktreePlanner({ ...deps, pushService: { send: async (payload) => { sent.push(payload); } } });
  const draft = await planner.startBackground({ repositoryId: REPO_ID, goal: "Add billing" });
  await settled(planner, draft.planId);
  assert.equal(sent[0].kind, "completion");
  assert.match(sent[0].body, /1 task/);
});

test("a notification failure never fails the round", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Which database?"}]}', "sess-a")] });
  const planner = new WorktreePlanner({ ...deps, pushService: { send: async () => { throw new Error("no subscriptions"); } } });
  const draft = await planner.startBackground({ repositoryId: REPO_ID, goal: "Add billing" });
  await settled(planner, draft.planId);
  assert.equal((await planner.resume(draft.planId)).status, "questions");
});

test("a background round publishes its progress on the plan id", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Which database?"}]}', "sess-a")] });
  const published = [];
  const planner = new WorktreePlanner({ ...deps, progress: { publish: (id, event) => published.push([id, event]) } });
  const draft = await planner.startBackground({ repositoryId: REPO_ID, goal: "Add billing" });
  await settled(planner, draft.planId);
  assert.ok(published.length > 0);
  assert.ok(published.every(([id]) => id === draft.planId));
  assert.equal(published.at(-1)[1].k, "done");
});

test("re-runs a plan whose first round never finished", async () => {
  const deps = fakeDeps({ replies: [
    envelope('{"questions":[{"text":"Which database?"}]}', "sess-a"),
    envelope('{"questions":[{"text":"Which database?"}]}', "sess-a"),
  ] });
  const planner = new WorktreePlanner(deps);
  const draft = await planner.startBackground({ repositoryId: REPO_ID, goal: "Add billing" });
  // A restart loses the run, and the plan row is left at round zero.
  planner.runs.clear();
  const rerun = await planner.run(draft.planId);
  assert.equal(rerun.running, true);
  await settled(planner, draft.planId);
  assert.ok((await planner.resume(draft.planId)).round >= 1);
});

test("refuses to re-run a plan that already has a round", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Which database?"}]}', "sess-a")] });
  const planner = new WorktreePlanner(deps);
  const draft = await planner.startBackground({ repositoryId: REPO_ID, goal: "Add billing" });
  await settled(planner, draft.planId);
  await assert.rejects(() => planner.run(draft.planId), /already has a plan round/);
});

test("the list carries the run state of each plan", async () => {
  const { deps, release } = gatedDeps(envelope('{"questions":[{"text":"Which database?"}]}', "sess-a"));
  const store = new WorktreePlanStore({ path: ":memory:" });
  const planner = new WorktreePlanner({ ...deps, store });
  const draft = await planner.startBackground({ repositoryId: REPO_ID, goal: "Add billing" });
  const listed = await planner.list({ status: "all" });
  assert.equal(listed.plans.find((plan) => plan.planId === draft.planId).running, true);
  release();
  await settled(planner, draft.planId);
  const after = await planner.list({ status: "all" });
  assert.equal(after.plans.find((plan) => plan.planId === draft.planId).running, false);
});

test("a background answer round resumes the same session", async () => {
  const deps = fakeDeps({ replies: [
    envelope('{"questions":[{"text":"Which database?"}]}', "sess-a"),
    envelope('{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}', "sess-a"),
  ] });
  const planner = new WorktreePlanner(deps);
  const draft = await planner.startBackground({ repositoryId: REPO_ID, goal: "Add billing" });
  await settled(planner, draft.planId);
  await planner.answerBackground(draft.planId, { answers: [{ id: "q1", text: "Postgres" }] });
  await settled(planner, draft.planId);
  const ready = await planner.resume(draft.planId);
  assert.equal(ready.status, "ready");
  assert.equal(ready.round, 2);
  assert.ok(deps.calls[1][1].includes("--resume"));
});

test("a background answer round also restates the goal when the session is gone", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  store.createPlan({ planId: "plan-lost", repositoryId: REPO_ID, repositoryName: "sample", cwd: "/repo/sample", goal: "Add billing", images: [{ path: "/tmp/shot.png", name: "shot.png" }] });
  store.recordRound("plan-lost", { round: 1, stage: "questions", sessionId: null, questions: [{ id: "q1", text: "Which database?", options: [] }] });

  const deps = fakeDeps({ replies: [envelope('{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}', "sess-new")] });
  const planner = new WorktreePlanner({ ...deps, store });
  await planner.answerBackground("plan-lost", { answers: [{ id: "q1", text: "Postgres" }] });
  await settled(planner, "plan-lost");

  // The background path must choose the same prompt as the awaited one, or a
  // resumed plan would go back to inventing work from the working tree.
  const prompt = deps.calls[0][1].at(-1);
  assert.ok(prompt.includes("Goal: Add billing"));
  assert.ok(prompt.includes("/tmp/shot.png"));
  assert.ok(prompt.includes("Q: Which database?"));
  assert.ok(prompt.includes("A: Postgres"));
  assert.ok(!deps.calls[0][1].includes("--resume"));
  assert.equal((await planner.resume("plan-lost")).status, "ready");
});

// The failure has to outlive the round. The progress stream is closed and the
// run registry expires within a minute, so without the stored copy a sheet
// reopened later blamed a companion restart for a timeout.
test("a failed background round stores its reason on the plan", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const timedOut = Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM", reason: "idle" });
  const deps = fakeDeps({ replies: [timedOut] });
  const planner = new WorktreePlanner({ ...deps, store, idleTimeoutMs: 240_000 });
  const draft = await planner.startBackground({ repositoryId: REPO_ID, goal: "Add billing" });
  await settled(planner, draft.planId);

  const stored = store.get(draft.planId);
  assert.match(stored.lastError, /no output for 4 minutes/);
  assert.ok(Date.parse(stored.lastErrorAt) > 0);
  // A reopened sheet reads the same reason, not the generic restart sentence.
  const reopened = await planner.detail(draft.planId);
  assert.match(reopened.lastError, /no output for 4 minutes/);
  assert.equal((await planner.list({ status: "all" })).plans[0].lastError, stored.lastError);
});

test("a plan that plans again drops the previous failure", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const timedOut = Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM", reason: "idle" });
  const deps = fakeDeps({ replies: [timedOut, envelope('{"questions":[{"text":"Which database?"}]}', "sess-a")] });
  const planner = new WorktreePlanner({ ...deps, store });
  const draft = await planner.startBackground({ repositoryId: REPO_ID, goal: "Add billing" });
  await settled(planner, draft.planId);
  assert.ok(store.get(draft.planId).lastError);

  await planner.run(draft.planId);
  await settled(planner, draft.planId);
  const stored = store.get(draft.planId);
  assert.equal(stored.lastError, null);
  assert.equal(stored.lastErrorAt, null);
  assert.equal(stored.round, 1);
  assert.equal((await planner.resume(draft.planId)).lastError, null);
});

// --- run stage and abort -------------------------------------------------

test("a background run begins at writing_spec and carries the stage into the list", async () => {
  const { deps, release } = gatedDeps(envelope('{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}', "sess-a"));
  const store = new WorktreePlanStore({ path: ":memory:" });
  const planner = new WorktreePlanner({ ...deps, store });
  const draft = await planner.startBackground({ repositoryId: REPO_ID, goal: "Add billing" });
  const run = planner.runs.get(draft.planId);
  assert.equal(run.stage, "writing_spec");
  assert.equal((await planner.list()).plans[0].runStage, "writing_spec");
  release();
  await settled(planner, draft.planId);
  store.close();
});

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

test("aborting a live background round finishes its run and records the goal", async () => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  const deps = fakeDeps({ replies: [] });
  const events = [];
  let started = () => {};
  const running = new Promise((resolve) => { started = resolve; });
  deps.execute = async (bin, args, options) => {
    started();
    await new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("Command failed"), { killed: true, reason: "aborted" })), { once: true });
    });
    return { stdout: "" };
  };
  const planner = new WorktreePlanner({ ...deps, store, progress: { publish: (planId, event) => events.push([planId, event]) } });
  const draft = await planner.startBackground({ repositoryId: REPO_ID, goal: "Add billing" });
  await running;
  await planner.abort(draft.planId);
  assert.equal(planner.isRunning(draft.planId), false);
  assert.equal(planner.runs.get(draft.planId).phase, "aborted");
  assert.match(planner.runs.get(draft.planId).error, /aborted/);
  assert.ok(events.some(([, event]) => event.k === "error" && /aborted/.test(event.t)));
  assert.equal(store.get(draft.planId).boardStatus, "aborted");
  await settled(planner, draft.planId);
  assert.equal(planner.controllers.size, 0, "the aborted round must clear its controller");
  store.close();
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
