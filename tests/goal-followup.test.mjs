import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalFollowups } from "../server/goal-followup.mjs";

async function deliveryDirectory(t) {
  const path = await mkdtemp(join(tmpdir(), "goal-followup-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function combinedPlan(path, overrides = {}) {
  return {
    planId: "plan-12345678",
    repositoryName: "cmux-companion",
    goal: "Ship follow-up actions",
    spec: { outcome: "Every waiting goal can launch follow-up work" },
    status: "launched",
    deliveryMode: "combined",
    deliveryStatus: "pr_open",
    integrationWorktreePath: path,
    integrationBranch: "goal/follow-up-actions",
    baseRef: "origin/main",
    boardPrNumber: 62,
    boardPrUrl: "https://github.test/pulls/62",
    boardPrState: "OPEN",
    mergeStatus: null,
    followups: [],
    tasks: [],
    ...overrides,
  };
}

function fakeBriefs() {
  return {
    written: [],
    async write(value) {
      const path = `/briefs/${value.planId}-${value.taskId}.md`;
      this.written.push({ ...value, path });
      return { path };
    },
    pointerPrompt({ path }) { return `Read ${path}`; },
  };
}

function harness(plan, { cmux = true } = {}) {
  const workspaceCalls = [];
  const briefs = fakeBriefs();
  const store = {
    plan,
    recorded: [],
    reads: 0,
    get(id) { this.reads += 1; return this.plan?.planId === id ? this.plan : null; },
    recordFollowupLaunched(id, value) {
      this.recorded.push([id, value]);
      this.plan.followups.push({ ...value });
      return this.plan;
    },
  };
  const cmuxClient = cmux ? {
    async workspaceCreate(value) {
      workspaceCalls.push(value);
      return { workspace_id: `workspace-${workspaceCalls.length}` };
    },
  } : null;
  return { launcher: new GoalFollowups({ store, cmux: cmuxClient, briefs }), store, briefs, workspaceCalls };
}

test("opens exactly one follow-up session with every selected action in its brief", async (t) => {
  const path = await deliveryDirectory(t);
  const plan = combinedPlan(path);
  const { launcher, store, briefs, workspaceCalls } = harness(plan);
  const result = await launcher.launch(plan.planId, {
    actions: ["custom", "review", "question", "tests"],
    question: "Does the retry preserve unfinished work?",
    custom: "Also document the retry boundary.",
    agent: "codex",
  });

  assert.equal(workspaceCalls.length, 1);
  assert.equal(workspaceCalls[0].cwd, path);
  assert.equal(workspaceCalls[0].agent, "codex");
  assert.equal(workspaceCalls[0].title, result.title);
  assert.match(workspaceCalls[0].title, /^CC-ASK · /);
  assert.deepEqual(result.actions, ["question", "tests", "review", "custom"]);
  assert.deepEqual(result.pullRequest, { number: 62, url: "https://github.test/pulls/62" });

  const markdown = briefs.written[0].markdown;
  for (const heading of ["Ask a question", "More unit and e2e tests", "Complete code review", "Something else"]) {
    assert.match(markdown, new RegExp(`## ${heading}`));
  }
  assert.ok(markdown.indexOf("## Ask a question") < markdown.indexOf("## More unit and e2e tests"));
  assert.ok(markdown.indexOf("## More unit and e2e tests") < markdown.indexOf("## Complete code review"));
  assert.match(markdown, /```\nDoes the retry preserve unfinished work\?\n```/);
  assert.match(markdown, /```\nAlso document the retry boundary\.\n```/);
  assert.match(markdown, /branch `goal\/follow-up-actions`/);
  assert.match(markdown, /https:\/\/github\.test\/pulls\/62/);
  assert.match(markdown, /Pushing this branch updates that same pull request/);
  assert.match(markdown, /NEVER run `gh pr create` or open any pull request/);
  assert.equal(store.recorded.length, 1);
  assert.equal(store.recorded[0][1].briefPath, briefs.written[0].path);
});

test("a single-task goal follows its launched task branch and worktree", async (t) => {
  const path = await deliveryDirectory(t);
  const plan = combinedPlan(null, {
    deliveryMode: "single",
    integrationBranch: null,
    boardPrUrl: null,
    boardPrNumber: null,
    finalPrUrl: "https://github.test/pulls/71",
    finalPrNumber: 71,
    tasks: [
      { id: "t0", branch: "feature/failed", worktreePath: "/missing", launchStatus: "failed" },
      { id: "t1", branch: "feature/billing", worktreePath: path, launchStatus: "launched" },
    ],
  });
  const { launcher, workspaceCalls } = harness(plan);
  const result = await launcher.launch(plan.planId, { actions: ["tests"], agent: "claude" });
  assert.equal(workspaceCalls.length, 1);
  assert.equal(workspaceCalls[0].cwd, path);
  assert.equal(result.branch, "feature/billing");
  assert.deepEqual(result.pullRequest, { number: 71, url: "https://github.test/pulls/71" });
});

test("question-only work can answer without manufacturing a commit", async (t) => {
  const path = await deliveryDirectory(t);
  const plan = combinedPlan(path, { boardPrUrl: null, finalPrUrl: null });
  const { launcher, briefs } = harness(plan);
  await launcher.launch(plan.planId, { actions: ["question"], question: "Why is this safe?" });
  const markdown = briefs.written[0].markdown;
  assert.match(markdown, /an answer in the session is enough/);
  assert.match(markdown, /A commit is only needed if the answer implies a fix/);
  assert.match(markdown, /There is no recorded pull request\. Push the branch and stop/);
});

test("two follow-ups use distinct brief paths and each opens one session", async (t) => {
  const path = await deliveryDirectory(t);
  const plan = combinedPlan(path);
  const { launcher, briefs, workspaceCalls } = harness(plan);
  await launcher.launch(plan.planId, { actions: ["tests"] });
  await launcher.launch(plan.planId, { actions: ["review"], agent: "codex" });
  assert.equal(workspaceCalls.length, 2);
  assert.deepEqual(briefs.written.map((brief) => brief.taskId), ["followup-1", "followup-2"]);
  assert.equal(new Set(briefs.written.map((brief) => brief.path)).size, 2);
});

test("every refusal is explicit and creates no workspace", async (t) => {
  const path = await deliveryDirectory(t);
  const valid = combinedPlan(path);
  const cases = [
    { body: {}, message: "Pick at least one follow-up action", plan: valid, unread: true },
    { body: { actions: ["unknown"] }, message: "Unknown follow-up action", plan: valid, unread: true },
    { body: { actions: ["question"] }, message: "Write the question you want answered", plan: valid, unread: true },
    { body: { actions: ["custom"] }, message: "Write what you want done", plan: valid, unread: true },
    { body: { actions: ["tests"], agent: "other" }, message: "Follow-up agent must be claude or codex", plan: valid, unread: true },
    { body: { actions: ["tests"] }, message: "Unknown plan. Start a new goal", plan: null },
    { body: { actions: ["tests"] }, message: "Only a goal waiting for merge can take a follow-up action", plan: combinedPlan(path, { boardPrState: null, finalPrUrl: null, deliveryStatus: "implementing" }) },
    { body: { actions: ["tests"] }, message: "A merge agent is working on this goal. Wait for it to finish, then add a follow-up", plan: combinedPlan(path, { mergeStatus: "running" }) },
    { body: { actions: ["tests"] }, message: "This goal has no delivery worktree left on disk, so a follow-up has nowhere to run", plan: combinedPlan(join(path, "gone")) },
  ];

  for (const item of cases) {
    const { launcher, store, workspaceCalls } = harness(item.plan);
    await assert.rejects(launcher.launch(valid.planId, item.body), { name: "TypeError", message: item.message });
    assert.equal(workspaceCalls.length, 0, item.message);
    if (item.unread) assert.equal(store.reads, 0, `${item.message}: validation must precede the read`);
  }

  const disconnected = harness(valid, { cmux: false });
  await assert.rejects(disconnected.launcher.launch(valid.planId, { actions: ["tests"] }), {
    name: "TypeError",
    message: "Follow-up sessions need a cmux connection",
  });
  assert.equal(disconnected.workspaceCalls.length, 0);
});

test("refuses a cmux response without a workspace id before recording launch", async (t) => {
  const path = await deliveryDirectory(t);
  const plan = combinedPlan(path);
  const { launcher, store, workspaceCalls } = harness(plan);
  launcher.cmux.workspaceCreate = async (value) => { workspaceCalls.push(value); return {}; };
  await assert.rejects(launcher.launch(plan.planId, { actions: ["review"] }), /did not return its id/);
  assert.equal(workspaceCalls.length, 1);
  assert.equal(store.recorded.length, 0);
});
