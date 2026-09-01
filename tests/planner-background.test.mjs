import assert from "node:assert/strict";
import test from "node:test";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";
import { WorktreePlanner } from "../server/worktree-planner.mjs";

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
