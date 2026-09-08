import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BurstReview, burstReviewPrompt, reviewerProvider } from "../server/burst-review.mjs";

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "burst-review-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function plan(overrides = {}) {
  return {
    planId: "plan-1", repositoryName: "sample", goal: "Ship it", burst: true, baseRef: "origin/main",
    spec: { outcome: "Done", acceptanceCriteria: [{ id: "AC-1", text: "It works", verification: "npm test" }, { id: "AC-2", text: "Other", verification: "manual" }] },
    tasks: [{ id: "t1", title: "Do", branch: "feature/do", agent: "claude", workspaceId: "ws-t1", worktreePath: "/wt/t1", launchStatus: "launched", deliveryStatus: "ready", criterionIds: ["AC-1"], ownedAreas: ["src/"], burstReviewStatus: null, burstReviewRound: 0, burstReviewWorkspaceId: null, burstReviewFindings: [] }],
    ...overrides,
  };
}

function fakeBriefs(dir) {
  return { directory: dir, async write({ planId, taskId, markdown }) { const path = join(dir, `${planId}-${taskId}.md`); await writeFile(path, markdown); return { path }; }, pointerPrompt: ({ path }) => `Read ${path}` };
}

function harness(t, dir, current) {
  const calls = [];
  let created = 0;
  const store = {
    plan: current,
    get(id) { return id === this.plan.planId ? this.plan : null; },
    recordBurstReviewLaunched(id, taskId, { workspaceId }) {
      calls.push(["launched", taskId, workspaceId]);
      const task = this.plan.tasks.find((x) => x.id === taskId);
      task.burstReviewStatus = "running"; task.burstReviewRound += 1; task.burstReviewWorkspaceId = workspaceId;
      return this.plan;
    },
    recordBurstReviewVerdict(id, taskId, { verdict, findings }) {
      calls.push(["verdict", taskId, verdict, findings]);
      const task = this.plan.tasks.find((x) => x.id === taskId);
      task.burstReviewStatus = verdict === "pass" ? "pass" : task.burstReviewRound >= 2 ? "blocked_twice" : "block";
      task.burstReviewFindings = findings;
      return this.plan;
    },
    recordTaskPending(id, taskId, value) { calls.push(["pending", taskId, value.error]); return this.plan; },
    findTaskByBurstReviewWorkspace(ws) { const task = this.plan.tasks.find((x) => x.burstReviewWorkspaceId === ws); return task ? { planId: this.plan.planId, taskId: task.id } : null; },
  };
  const cmux = {
    workspaceCreate: async (options) => { calls.push(["create", options]); created += 1; return { workspace_id: `review-${created}` }; },
    sendWorkspacePrompt: async (ws, text) => { calls.push(["prompt", ws, text]); },
  };
  const review = new BurstReview({ store, cmux, briefs: fakeBriefs(dir), modelSettings: { workspace: (role, agent) => ({ agent, model: "default" }) } });
  return { review, calls, store, cmux };
}

test("the reviewer uses the other provider", () => {
  assert.equal(reviewerProvider("claude"), "codex");
  assert.equal(reviewerProvider("codex"), "claude");
  assert.equal(reviewerProvider(undefined), "codex");
});

test("launches one reviewer on a ready task and records it", async (t) => {
  const dir = await directory(t);
  const { review, calls } = harness(t, dir, plan());
  assert.equal(await review.reviewTask("plan-1", "t1"), true);
  const create = calls.find(([kind]) => kind === "create")[1];
  assert.equal(create.cwd, "/wt/t1");
  assert.equal(create.agent, "codex");
  assert.match(create.title, /Burst review 1/);
  assert.equal(create.env.COMPANION_PLAN, "plan-1");
  assert.match(create.prompt, new RegExp(`^Read ${dir}/plan-1-t1-burst-review-1.md$`));
  assert.deepEqual(calls.find(([kind]) => kind === "launched").slice(1), ["t1", "review-1"]);
  assert.equal(await review.reviewTask("plan-1", "t1"), false, "a running review is not doubled");
  assert.equal(calls.filter(([kind]) => kind === "create").length, 1);
  const brief = burstReviewPrompt(plan(), plan().tasks[0], join(dir, "plan-1-t1-burst-review-1.json"));
  assert.match(brief, /verdict/);
  assert.match(brief, /Do not edit/);
  assert.match(brief, /AC-1: It works/);
  assert.doesNotMatch(brief, /AC-2/);
  assert.match(brief, /plan-1-t1-burst-review-1\.json/);
});

test("nothing launches for a non-burst plan, an unfinished task, or a task without a worktree", async (t) => {
  const dir = await directory(t);
  for (const current of [
    plan({ burst: false }),
    plan({ tasks: [{ ...plan().tasks[0], deliveryStatus: "pending" }] }),
    plan({ tasks: [{ ...plan().tasks[0], worktreePath: null }] }),
    plan({ tasks: [{ ...plan().tasks[0], burstReviewStatus: "pass" }] }),
    plan({ tasks: [{ ...plan().tasks[0], burstReviewStatus: "blocked_twice", burstReviewRound: 2 }] }),
  ]) {
    const { review, calls } = harness(t, dir, current);
    assert.equal(await review.reviewTask("plan-1", "t1"), false);
    assert.equal(calls.length, 0);
  }
  const { review } = harness(t, dir, plan());
  assert.equal(await review.reviewTask("plan-1", "missing"), false);
  assert.equal(await review.reviewTask("plan-9", "t1"), false);
});

test("a pass verdict is recorded and the owner is not prompted", async (t) => {
  const dir = await directory(t);
  const { review, calls } = harness(t, dir, plan());
  await review.reviewTask("plan-1", "t1");
  await writeFile(join(dir, "plan-1-t1-burst-review-1.json"), JSON.stringify({ verdict: "pass", findings: ["advisory only"] }));
  assert.equal(await review.onWorkspaceStopped("review-1"), true);
  assert.deepEqual(calls.find(([kind]) => kind === "verdict").slice(1), ["t1", "pass", ["advisory only"]]);
  assert.equal(calls.some(([kind]) => kind === "prompt"), false);
  assert.equal(calls.some(([kind]) => kind === "pending"), false);
  assert.equal(await review.onWorkspaceStopped("review-1"), false, "a settled review does not re-read its verdict");
});

test("a first block returns findings to the owner and marks the task pending; a second block stops", async (t) => {
  const dir = await directory(t);
  const { review, calls, store } = harness(t, dir, plan());
  await review.reviewTask("plan-1", "t1");
  await writeFile(join(dir, "plan-1-t1-burst-review-1.json"), JSON.stringify({ verdict: "block", findings: ["Missing empty-case test"] }));
  assert.equal(await review.onWorkspaceStopped("review-1"), true);
  const prompt = calls.find(([kind]) => kind === "prompt");
  assert.equal(prompt[1], "ws-t1");
  assert.match(prompt[2], /- Missing empty-case test/);
  assert.match(prompt[2], /second review follows/);
  const pending = calls.find(([kind]) => kind === "pending");
  assert.equal(pending[1], "t1");
  assert.match(pending[2], /Burst review found blocking issues \(round 1\)/);
  assert.equal(store.plan.tasks[0].burstReviewStatus, "block");
  // The owner amended and stopped again: a second review runs on the same task.
  assert.equal(await review.reviewTask("plan-1", "t1"), true);
  assert.equal(store.plan.tasks[0].burstReviewRound, 2);
  await writeFile(join(dir, "plan-1-t1-burst-review-2.json"), JSON.stringify({ verdict: "block", findings: ["Still missing"] }));
  assert.equal(await review.onWorkspaceStopped(store.plan.tasks[0].burstReviewWorkspaceId), true);
  assert.equal(store.plan.tasks[0].burstReviewStatus, "blocked_twice");
  const pendings = calls.filter(([kind]) => kind === "pending");
  assert.equal(pendings.length, 2);
  assert.match(pendings.at(-1)[2], /blocked twice/);
  assert.match(pendings.at(-1)[2], /Still missing/);
  assert.equal(calls.filter(([kind]) => kind === "prompt").length, 1, "the owner is not prompted after the final block");
  assert.equal(await review.reviewTask("plan-1", "t1"), false);
});

test("a missing or malformed verdict file blocks with a stated reason", async (t) => {
  const dir = await directory(t);
  const missing = harness(t, dir, plan());
  await missing.review.reviewTask("plan-1", "t1");
  assert.equal(await missing.review.onWorkspaceStopped("review-1"), true);
  assert.match(missing.calls.find(([kind]) => kind === "verdict")[3][0], /no verdict file/);
  assert.equal(missing.store.plan.tasks[0].burstReviewStatus, "block");
  const malformed = harness(t, dir, plan({ planId: "plan-2" }));
  await malformed.review.reviewTask("plan-2", "t1");
  await writeFile(join(dir, "plan-2-t1-burst-review-1.json"), '{"verdict":"maybe"}');
  assert.equal(await malformed.review.onWorkspaceStopped("review-1"), true);
  assert.match(malformed.calls.find(([kind]) => kind === "verdict")[3][0], /malformed.*pass or block/);
});

test("a failed nudge to the owner is logged and does not lose the verdict", async (t) => {
  const dir = await directory(t);
  const warnings = [];
  const { review, calls, cmux } = harness(t, dir, plan());
  review.log = { warn: (details, message) => warnings.push(message) };
  cmux.sendWorkspacePrompt = async () => { throw new Error("workspace gone"); };
  await review.reviewTask("plan-1", "t1");
  await writeFile(join(dir, "plan-1-t1-burst-review-1.json"), JSON.stringify({ verdict: "block", findings: ["x"] }));
  assert.equal(await review.onWorkspaceStopped("review-1"), true);
  assert.equal(calls.some(([kind]) => kind === "verdict"), true);
  assert.equal(warnings.length, 1);
});

test("gate: a burst task counts as ready only after a pass", () => {
  const { review } = harness({ after() {} }, "/tmp", plan());
  assert.equal(review.taskReady({ burst: true }, { deliveryStatus: "ready", burstReviewStatus: null }), false);
  assert.equal(review.taskReady({ burst: true }, { deliveryStatus: "ready", burstReviewStatus: "running" }), false);
  assert.equal(review.taskReady({ burst: true }, { deliveryStatus: "ready", burstReviewStatus: "block" }), false);
  assert.equal(review.taskReady({ burst: true }, { deliveryStatus: "ready", burstReviewStatus: "pass" }), true);
  assert.equal(review.taskReady({ burst: true }, { deliveryStatus: "pending", burstReviewStatus: "pass" }), false);
  assert.equal(review.taskReady({ burst: false }, { deliveryStatus: "ready", burstReviewStatus: null }), true);
  assert.equal(review.taskReady(null, { deliveryStatus: "ready", burstReviewStatus: null }), true);
});

test("an unrelated workspace stop is ignored", async (t) => {
  const dir = await directory(t);
  const { review } = harness(t, dir, plan());
  assert.equal(await review.onWorkspaceStopped("ws-other"), false);
  assert.equal(await review.onWorkspaceStopped(""), false);
});

test("the constructor refuses missing collaborators", () => {
  assert.throws(() => new BurstReview({}), /store, cmux, briefs and model settings/);
});
