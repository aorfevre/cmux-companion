import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BurstReview, BurstReviewTerminalError, burstReviewPrompt, reviewerProvider } from "../server/burst-review.mjs";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";

const HEAD = "f".repeat(40);
const SPEC = {
  version: 2, outcome: "Done", inScope: [], nonGoals: [], constraints: [], assumptions: [], risks: [],
  acceptanceCriteria: [{ id: "AC-1", text: "It works", verification: "npm test" }, { id: "AC-2", text: "Other", verification: "manual" }],
};

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "burst-review-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function fakeBriefs(dir) {
  return { directory: dir, async write({ planId, taskId, markdown }) { const path = join(dir, `${planId}-${taskId}.md`); await writeFile(path, markdown); return { path }; }, pointerPrompt: ({ path }) => `Read ${path}` };
}

function memoryStore(t) {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  return store;
}

// A launched burst goal with one task whose branch evidence is ready, exactly
// as the integrator leaves it before it asks for a review.
function taskPlan(store, { burst = true, ready = true, worktree = true } = {}) {
  store.createPlan({ planId: "plan-1", repositoryId: "repository12345678", repositoryName: "sample", cwd: "/repo", goal: "Ship it", burst });
  store.recordRound("plan-1", {
    round: 1, stage: "ready", spec: SPEC, readiness: { ready: true, errors: [], warnings: [], waves: [["t1"]], coverage: [] },
    tasks: [{ id: "t1", title: "Do", branch: "feature/do", prompt: "Build", agent: "claude", type: "backend", criterionIds: ["AC-1"], dependsOn: [], ownedAreas: ["src/"], verification: ["npm test"] }],
  });
  store.recordLaunch("plan-1", { base: "origin/main", baseSha: "c".repeat(40), results: [{ id: "t1", status: "launched", ...(worktree ? { path: "/wt/t1" } : {}), workspace: { workspace_id: "ws-t1" } }] });
  if (ready) store.recordTaskReady("plan-1", "t1", HEAD, { report: { criteria: ["AC-1"], verification: [{ check: "npm test", status: "passed" }], limitations: [] } });
  return store.get("plan-1");
}

function harness(t, dir, store) {
  const calls = [];
  let created = 0;
  const cmux = {
    workspaceCreate: async (options) => { calls.push(["create", options]); created += 1; return { workspace_id: `review-${created}` }; },
    sendWorkspacePrompt: async (ws, text) => { calls.push(["prompt", ws, text]); },
    workspaceClose: async (ws) => { calls.push(["close", ws]); },
  };
  const warnings = [];
  const review = new BurstReview({ store, cmux, briefs: fakeBriefs(dir), modelSettings: { workspace: (role, agent) => ({ agent, model: "default" }) }, log: { warn: (details, message) => warnings.push(message) } });
  return { review, calls, store, cmux, warnings, task: () => store.get("plan-1").tasks[0] };
}

const kinds = (store, kind) => store.events("plan-1").filter((event) => event.kind === kind);

test("the reviewer uses the other provider", () => {
  assert.equal(reviewerProvider("claude"), "codex");
  assert.equal(reviewerProvider("codex"), "claude");
  assert.equal(reviewerProvider(undefined), "codex");
});

test("launches one reviewer on a ready task and records it", async (t) => {
  const dir = await directory(t);
  const store = memoryStore(t);
  const plan = taskPlan(store);
  const { review, calls, task } = harness(t, dir, store);
  assert.equal(await review.reviewTask("plan-1", "t1"), true);
  const create = calls.find(([kind]) => kind === "create")[1];
  assert.equal(create.cwd, "/wt/t1");
  assert.equal(create.agent, "codex");
  assert.match(create.title, /Burst review 1/);
  assert.equal(create.env.COMPANION_PLAN, "plan-1");
  assert.match(create.prompt, new RegExp(`^Read ${dir}/plan-1-t1-burst-review-1.md$`));
  assert.equal(task().burstReviewStatus, "running");
  assert.equal(task().burstReviewRound, 1);
  assert.equal(task().burstReviewWorkspaceId, "review-1");
  assert.equal(task().burstReviewHeadSha, HEAD);
  assert.equal(await review.reviewTask("plan-1", "t1"), false, "a running review is not doubled");
  assert.equal(calls.filter(([kind]) => kind === "create").length, 1);
  const brief = burstReviewPrompt(plan, plan.tasks[0], join(dir, "plan-1-t1-burst-review-1.json"));
  assert.match(brief, /verdict/);
  assert.match(brief, /Do not edit/);
  assert.match(brief, /AC-1: It works/);
  assert.doesNotMatch(brief, /AC-2/);
  assert.match(brief, /plan-1-t1-burst-review-1\.json/);
  assert.match(brief, /Stop exactly once, after the verdict file is written/);
});

test("nothing launches for a non-burst plan, an unfinished task, or a task without a worktree", async (t) => {
  const dir = await directory(t);
  for (const options of [{ burst: false }, { ready: false }, { worktree: false }]) {
    const store = memoryStore(t);
    taskPlan(store, options);
    const { review, calls } = harness(t, dir, store);
    assert.equal(await review.reviewTask("plan-1", "t1"), false);
    assert.equal(calls.length, 0);
  }
  const store = memoryStore(t);
  taskPlan(store);
  const { review, calls } = harness(t, dir, store);
  assert.equal(await review.reviewTask("plan-1", "missing"), false);
  assert.equal(await review.reviewTask("plan-9", "t1"), false);
  store.recordBurstReviewLaunched("plan-1", "t1", { workspaceId: "old" });
  store.recordBurstReviewVerdict("plan-1", "t1", { verdict: "pass" });
  assert.equal(await review.reviewTask("plan-1", "t1"), false, "a passed task is never reviewed again");
  assert.equal(calls.length, 0);
});

test("a pass verdict is recorded and the owner is not prompted", async (t) => {
  const dir = await directory(t);
  const store = memoryStore(t);
  taskPlan(store);
  const { review, calls, task } = harness(t, dir, store);
  await review.reviewTask("plan-1", "t1");
  await writeFile(join(dir, "plan-1-t1-burst-review-1.json"), JSON.stringify({ verdict: "pass", findings: ["advisory only"] }));
  assert.equal(await review.onWorkspaceStopped("review-1"), true);
  assert.equal(task().burstReviewStatus, "pass");
  assert.deepEqual(task().burstReviewFindings, ["advisory only"]);
  assert.equal(task().deliveryStatus, "ready");
  assert.equal(calls.some(([kind]) => kind === "prompt"), false);
  assert.equal(await review.onWorkspaceStopped("review-1"), false, "a settled review does not re-read its verdict");
});

test("a first block returns findings to the owner and marks the task pending; a second block stops", async (t) => {
  const dir = await directory(t);
  const store = memoryStore(t);
  taskPlan(store);
  const { review, calls, task } = harness(t, dir, store);
  await review.reviewTask("plan-1", "t1");
  await writeFile(join(dir, "plan-1-t1-burst-review-1.json"), JSON.stringify({ verdict: "block", findings: ["Missing empty-case test"] }));
  assert.equal(await review.onWorkspaceStopped("review-1"), true);
  const prompt = calls.find(([kind]) => kind === "prompt");
  assert.equal(prompt[1], "ws-t1");
  assert.match(prompt[2], /- Missing empty-case test/);
  assert.match(prompt[2], /second review follows/);
  assert.equal(task().burstReviewStatus, "block");
  assert.equal(task().deliveryStatus, "pending");
  assert.match(task().evidenceError, /Burst review found blocking issues \(round 1\)/);
  // The owner amended and force-pushed; the integrator re-readies the task.
  store.recordTaskReady("plan-1", "t1", "d".repeat(40), { report: { criteria: ["AC-1"], verification: [], limitations: [] } });
  assert.equal(await review.reviewTask("plan-1", "t1"), true);
  assert.equal(task().burstReviewRound, 2);
  await writeFile(join(dir, "plan-1-t1-burst-review-2.json"), JSON.stringify({ verdict: "block", findings: ["Still missing"] }));
  assert.equal(await review.onWorkspaceStopped(task().burstReviewWorkspaceId), true);
  assert.equal(task().burstReviewStatus, "blocked_twice");
  assert.equal(task().deliveryStatus, "pending");
  assert.match(task().evidenceError, /blocked twice/);
  assert.match(task().evidenceError, /Still missing/);
  assert.equal(calls.filter(([kind]) => kind === "prompt").length, 1, "the owner is not prompted after the final block");
  assert.equal(await review.reviewTask("plan-1", "t1"), false);
  assert.equal(kinds(store, "burst_review_verdict").length, 2);
});

test("a stop without a verdict file leaves the round open; a malformed file blocks", async (t) => {
  const dir = await directory(t);
  const missing = harness(t, dir, memoryStore(t));
  taskPlan(missing.store);
  await missing.review.reviewTask("plan-1", "t1");
  assert.equal(await missing.review.onWorkspaceStopped("review-1"), true, "the stop is ours even without a verdict");
  assert.equal(missing.task().burstReviewStatus, "running", "no verdict means no verdict; the reviewer may stop again");
  assert.equal(missing.task().burstReviewRound, 1);
  assert.deepEqual(missing.warnings, ["burst reviewer stopped without a verdict file"]);
  assert.equal(kinds(missing.store, "burst_review_verdict").length, 0);
  // The reviewer writes the file and stops a second time: that stop is read.
  await writeFile(join(dir, "plan-1-t1-burst-review-1.json"), JSON.stringify({ verdict: "pass", findings: [] }));
  assert.equal(await missing.review.onWorkspaceStopped("review-1"), true);
  assert.equal(missing.task().burstReviewStatus, "pass");
  const malformed = harness(t, dir, memoryStore(t));
  taskPlan(malformed.store);
  await malformed.review.reviewTask("plan-1", "t1");
  await writeFile(join(dir, "plan-1-t1-burst-review-1.json"), '{"verdict":"maybe"}');
  assert.equal(await malformed.review.onWorkspaceStopped("review-1"), true);
  assert.equal(malformed.task().burstReviewStatus, "block");
  assert.match(malformed.task().burstReviewFindings[0], /malformed.*pass or block/);
});

test("a failed nudge to the owner is logged and does not lose the verdict", async (t) => {
  const dir = await directory(t);
  const store = memoryStore(t);
  taskPlan(store);
  const { review, cmux, warnings, task } = harness(t, dir, store);
  cmux.sendWorkspacePrompt = async () => { throw new Error("workspace gone"); };
  await review.reviewTask("plan-1", "t1");
  await writeFile(join(dir, "plan-1-t1-burst-review-1.json"), JSON.stringify({ verdict: "block", findings: ["x"] }));
  assert.equal(await review.onWorkspaceStopped("review-1"), true);
  assert.equal(task().burstReviewStatus, "block");
  assert.deepEqual(warnings, ["burst review findings could not reach the owner"]);
});

test("gate: a burst task counts as ready only after a pass", () => {
  const { taskReady } = BurstReview.prototype;
  assert.equal(taskReady({ burst: true }, { deliveryStatus: "ready", burstReviewStatus: null }), false);
  assert.equal(taskReady({ burst: true }, { deliveryStatus: "ready", burstReviewStatus: "running" }), false);
  assert.equal(taskReady({ burst: true }, { deliveryStatus: "ready", burstReviewStatus: "block" }), false);
  assert.equal(taskReady({ burst: true }, { deliveryStatus: "ready", burstReviewStatus: "pass" }), true);
  assert.equal(taskReady({ burst: true }, { deliveryStatus: "pending", burstReviewStatus: "pass" }), false);
  assert.equal(taskReady({ burst: false }, { deliveryStatus: "ready", burstReviewStatus: null }), true);
  assert.equal(taskReady(null, { deliveryStatus: "ready", burstReviewStatus: null }), true);
});

test("an unrelated workspace stop is ignored", async (t) => {
  const dir = await directory(t);
  const store = memoryStore(t);
  taskPlan(store);
  const { review } = harness(t, dir, store);
  assert.equal(await review.onWorkspaceStopped("ws-other"), false);
  assert.equal(await review.onWorkspaceStopped("ws-t1"), false, "the task owner's own stop is not a review stop");
  assert.equal(await review.onWorkspaceStopped(""), false);
});

test("the constructor refuses missing collaborators", () => {
  assert.throws(() => new BurstReview({}), /store, cmux, briefs and model settings/);
});

test("no reviewer opens on a goal that ended, before or during the cmux call", async (t) => {
  const dir = await directory(t);
  const aborted = harness(t, dir, memoryStore(t));
  taskPlan(aborted.store);
  aborted.store.recordGoalAborted("plan-1");
  await assert.rejects(() => aborted.review.reviewTask("plan-1", "t1"), BurstReviewTerminalError);
  assert.equal(aborted.calls.some(([k]) => k === "create"), false);
  assert.equal(aborted.task().burstReviewStatus, null);
  // The abort lands while cmux is creating the session: the session is closed,
  // its id recorded first so a failed close is still the reaper's to finish.
  const racing = harness(t, dir, memoryStore(t));
  taskPlan(racing.store);
  racing.cmux.workspaceCreate = async () => { racing.store.recordGoalAborted("plan-1"); return { workspace_id: "review-late" }; };
  await assert.rejects(() => racing.review.reviewTask("plan-1", "t1"), /aborted/);
  assert.deepEqual(racing.calls.filter(([k]) => k === "close"), [["close", "review-late"]]);
  assert.ok(racing.store.get("plan-1").supersededMergeWorkspaces.some((entry) => entry.workspaceId === "review-late" && !entry.retiredAt));
  assert.equal(racing.task().burstReviewStatus, null);
  const failing = harness(t, dir, memoryStore(t));
  taskPlan(failing.store);
  failing.cmux.workspaceCreate = async () => { failing.store.recordGoalMerged("plan-1", { number: 1, url: "https://github.test/pr/1" }); return { workspace_id: "review-late" }; };
  failing.cmux.workspaceClose = async () => { throw new Error("cmux is down"); };
  await assert.rejects(() => failing.review.reviewTask("plan-1", "t1"), /merged.*still needs cleanup: cmux is down/s);
  assert.ok(failing.store.get("plan-1").supersededMergeWorkspaces.some((entry) => entry.workspaceId === "review-late"));
});

test("the verdict path is sanitised so a hostile task id stays inside the briefs directory", async (t) => {
  const dir = await directory(t);
  const { review } = harness(t, dir, memoryStore(t));
  assert.equal(review.verdictPath("plan-1", "t1", 1), join(dir, "plan-1-t1-burst-review-1.json"));
  assert.throws(() => review.verdictPath("plan-1", "../../etc/passwd", 1), /must not contain a path/);
  assert.throws(() => review.verdictPath("../plan", "t1", 1), /must not contain a path/);
  const odd = review.verdictPath("plan-1", "t 1", 1);
  assert.ok(odd.startsWith(`${dir}/`));
  assert.doesNotMatch(odd, /\s/);
});

test("a verdict file larger than 64 KiB is treated as malformed", async (t) => {
  const dir = await directory(t);
  const store = memoryStore(t);
  taskPlan(store);
  const { review, task } = harness(t, dir, store);
  await review.reviewTask("plan-1", "t1");
  await writeFile(join(dir, "plan-1-t1-burst-review-1.json"), JSON.stringify({ verdict: "pass", findings: ["x".repeat(70_000)] }));
  assert.equal(await review.onWorkspaceStopped("review-1"), true);
  assert.equal(task().burstReviewStatus, "block");
  assert.match(task().burstReviewFindings[0], /malformed.*larger than 65536 bytes/);
});

// --- goal sessions -----------------------------------------------------------

// A burst goal session whose pull request GitHub has reported OPEN.
function goalPlan(store, { burst = true, open = true } = {}) {
  store.createPlan({ planId: "plan-g", repositoryId: "repository12345678", repositoryName: "sample", cwd: "/repo", goal: "Ship", burst });
  store.reserveGoalSession("plan-g", { branch: "goal/ship", generation: 1 });
  store.recordGoalSessionStart("plan-g", { worktreePath: "/wt/goal", workspaceId: "ws-goal", generation: 1 });
  store.publishProposal("plan-g", { generation: 1, providerSessionId: "provider", proposal: { intendedBehavior: "Ship", scope: ["All"] } });
  store.approveProposal("plan-g", { generation: 1, revision: 1 });
  if (open) store.recordGoalPullRequest("plan-g", { number: 1, url: "https://github.test/pr/1", state: "OPEN" });
  return store.get("plan-g");
}

function goalHarness(t, dir, store) {
  const calls = [];
  const cmux = {
    workspaceCreate: async (options) => { calls.push(["create", options]); return { workspace_id: "review-g" }; },
    sendWorkspacePrompt: async (ws, text) => { calls.push(["prompt", ws, text]); },
    workspaceClose: async (ws) => { calls.push(["close", ws]); },
  };
  const warnings = [];
  const review = new BurstReview({ store, cmux, briefs: fakeBriefs(dir), modelSettings: { workspace: (role, agent) => ({ agent, model: "default" }) }, log: { warn: (details, message) => warnings.push(message) } });
  return { review, calls, store, cmux, warnings, plan: () => store.get("plan-g") };
}

const goalVerdicts = (store) => store.events("plan-g").filter((event) => event.kind === "burst_review_verdict");

test("reviewGoal launches once on the goal session worktree and prompts the owner on block", async (t) => {
  const dir = await directory(t);
  const store = memoryStore(t);
  goalPlan(store);
  const { review, calls, plan } = goalHarness(t, dir, store);
  assert.equal(await review.reviewGoal("plan-g"), true);
  const create = calls.find(([k]) => k === "create")[1];
  assert.equal(create.cwd, "/wt/goal");
  assert.equal(create.agent, "codex");
  assert.match(create.title, /^Burst review: Ship$/);
  assert.equal(create.env.COMPANION_PLAN, "plan-g");
  assert.equal(create.env.COMPANION_TASK, undefined);
  assert.equal(plan().reviewStatus, "running");
  assert.equal(plan().reviewWorkspaceId, "review-g");
  assert.match(plan().reviewBriefPath || "", /plan-g-goal-burst-review-1\.md$/);
  assert.equal(await review.reviewGoal("plan-g"), false, "a second call while one runs is a no-op");
  assert.equal(calls.filter(([k]) => k === "create").length, 1);
  await writeFile(join(dir, "plan-g-goal-burst-review-1.json"), JSON.stringify({ verdict: "block", findings: ["Missing changelog"] }));
  assert.equal(await review.onWorkspaceStopped("review-g"), true);
  const prompt = calls.find(([k]) => k === "prompt");
  assert.equal(prompt[1], "ws-goal");
  assert.match(prompt[2], /- Missing changelog/);
  assert.match(prompt[2], /do not merge/);
  assert.ok(plan().reviewSessionClosedAt);
  // The verdict is on the record, under the same event the task reviews use.
  const [event] = goalVerdicts(store);
  assert.deepEqual(event.payload, { taskId: "goal", verdict: "block", status: "block", findings: ["Missing changelog"] });
  assert.equal(await review.onWorkspaceStopped("review-g"), false, "a closed review is not read twice");
  assert.equal(calls.filter(([k]) => k === "prompt").length, 1);
  assert.equal(goalVerdicts(store).length, 1);
});

test("a passing goal review closes quietly and is recorded", async (t) => {
  const dir = await directory(t);
  const store = memoryStore(t);
  goalPlan(store);
  const { review, calls, plan } = goalHarness(t, dir, store);
  await review.reviewGoal("plan-g");
  await writeFile(join(dir, "plan-g-goal-burst-review-1.json"), JSON.stringify({ verdict: "pass", findings: ["nit"] }));
  assert.equal(await review.onWorkspaceStopped("review-g"), true);
  assert.ok(plan().reviewSessionClosedAt);
  assert.equal(calls.some(([k]) => k === "prompt"), false);
  assert.deepEqual(goalVerdicts(store).map((event) => event.payload), [{ taskId: "goal", verdict: "pass", status: "pass", findings: ["nit"] }]);
});

test("a goal reviewer that stops without a verdict file keeps its review open", async (t) => {
  const dir = await directory(t);
  const store = memoryStore(t);
  goalPlan(store);
  const { review, calls, plan, warnings } = goalHarness(t, dir, store);
  await review.reviewGoal("plan-g");
  assert.equal(await review.onWorkspaceStopped("review-g"), true);
  assert.equal(plan().reviewSessionClosedAt, null);
  assert.equal(plan().reviewStatus, "running");
  assert.deepEqual(warnings, ["burst goal reviewer stopped without a verdict file"]);
  assert.equal(calls.some(([k]) => k === "prompt"), false);
  assert.equal(goalVerdicts(store).length, 0);
});

test("the goal brief names the goal branch and the verdict file", async (t) => {
  const dir = await directory(t);
  const store = memoryStore(t);
  goalPlan(store);
  const { review } = goalHarness(t, dir, store);
  await review.reviewGoal("plan-g");
  const brief = await readFile(join(dir, "plan-g-goal-burst-review-1.md"), "utf8");
  assert.match(brief, /Branch: goal\/ship against origin\/main/);
  assert.match(brief, /plan-g-goal-burst-review-1\.json/);
  assert.match(brief, /Goal: Ship/);
});

test("reviewGoal declines plans that are not open burst goal sessions", async (t) => {
  const dir = await directory(t);
  for (const seed of [
    (store) => goalPlan(store, { burst: false }),
    (store) => goalPlan(store, { open: false }),
    // A planned (task-based) goal with an open pull request is not a goal session.
    (store) => { taskPlan(store); store.recordGoalPullRequest("plan-1", { number: 1, url: "https://github.test/pr/1", state: "OPEN" }); },
    (store) => { goalPlan(store); store.claimGoalReview("plan-g", { agent: "codex" }); },
  ]) {
    const store = memoryStore(t);
    seed(store);
    const { review, calls } = goalHarness(t, dir, store);
    assert.equal(await review.reviewGoal("plan-g"), false);
    assert.equal(await review.reviewGoal("plan-1"), false);
    assert.equal(calls.some(([k]) => k === "create"), false);
  }
  const { review: unknown } = goalHarness(t, dir, memoryStore(t));
  assert.equal(await unknown.reviewGoal("plan-x"), false);
});

test("a failed goal reviewer launch releases the claim so a later pass can retry", async (t) => {
  const dir = await directory(t);
  const store = memoryStore(t);
  goalPlan(store);
  const { review, cmux, plan } = goalHarness(t, dir, store);
  cmux.workspaceCreate = async () => { throw new Error("cmux is down"); };
  await assert.rejects(() => review.reviewGoal("plan-g"), /cmux is down/);
  assert.equal(plan().reviewStatus, null);
  cmux.workspaceCreate = async () => ({});
  await assert.rejects(() => review.reviewGoal("plan-g"), /did not return its id/);
  assert.equal(plan().reviewStatus, null);
  cmux.workspaceCreate = async () => ({ workspace_id: "review-g" });
  assert.equal(await review.reviewGoal("plan-g"), true);
});

test("no goal reviewer opens on a goal that ended, and the claim is released", async (t) => {
  const dir = await directory(t);
  const store = memoryStore(t);
  goalPlan(store);
  const { review, calls, cmux, plan } = goalHarness(t, dir, store);
  cmux.workspaceCreate = async () => { store.recordGoalAborted("plan-g"); return { workspace_id: "review-late" }; };
  await assert.rejects(() => review.reviewGoal("plan-g"), BurstReviewTerminalError);
  assert.deepEqual(calls.filter(([k]) => k === "close"), [["close", "review-late"]]);
  assert.equal(plan().reviewStatus, null);
  assert.equal(plan().reviewWorkspaceId, null);
});
