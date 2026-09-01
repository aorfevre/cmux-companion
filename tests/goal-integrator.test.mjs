import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalIntegrator, mergePrompt, readyCount } from "../server/goal-integrator.mjs";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";

const REPO_ID = "repository12345678";
const TASK_ONE = "a".repeat(40);
const TASK_TWO = "b".repeat(40);
const BASE = "c".repeat(40);

function fixture(t, { secondPushed = true, pullRequest = null, thirdFailed = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "goal-integrator-"));
  const integrationPath = join(root, "sample-goal");
  mkdirSync(integrationPath);
  const store = new WorktreePlanStore({ path: ":memory:" });
  store.createPlan({ planId: "plan-12345678", repositoryId: REPO_ID, repositoryName: "sample", cwd: root, goal: "Ship combined billing", sourceType: "github_issues", issueNumbers: [54, 55], issueUrls: ["https://github.test/issues/54"] });
  store.recordRound("plan-12345678", {
    round: 1, stage: "ready", sessionId: "session",
    tasks: [
      { id: "t1", title: "Billing API", branch: "feature/billing-api", prompt: "Build it", agent: "codex" },
      { id: "t2", title: "Billing UI", branch: "feature/billing-ui", prompt: "Build it", agent: "claude" },
      ...(thirdFailed ? [{ id: "t3", title: "Billing docs", branch: "feature/billing-docs", prompt: "Build it", agent: "codex" }] : []),
    ],
  });
  store.recordLaunch("plan-12345678", {
    base: "origin/main", baseSha: BASE,
    results: [
      { id: "t1", status: "launched", path: join(root, "task-one"), workspace: { workspace_id: "workspace-one" } },
      { id: "t2", status: "launched", path: join(root, "task-two"), workspace: { workspace_id: "workspace-two" } },
      ...(thirdFailed ? [{ id: "t3", status: "failed", error: "worktree already exists" }] : []),
    ],
  });
  const calls = [];
  const repoCatalog = {
    git: async (cwd, args) => {
      calls.push(["git", cwd, args]);
      if (args[0] === "status") return "";
      if (args[0] === "rev-list") return "1\n";
      if (args[0] === "log") {
        const taskId = cwd.endsWith("task-one") ? "t1" : "t2";
        return `Finish task\n\nCmux-Goal-Ready: plan-12345678/${taskId}\n`;
      }
      if (args[0] === "ls-remote") {
        if (!secondPushed && cwd.endsWith("task-two")) return "";
        return `${cwd.endsWith("task-one") ? TASK_ONE : TASK_TWO}\t${args[2]}\n`;
      }
      if (args[0] === "rev-parse" && cwd.endsWith("task-one")) return `${TASK_ONE}\n`;
      if (args[0] === "rev-parse" && cwd.endsWith("task-two")) return `${TASK_TWO}\n`;
      return "";
    },
  };
  const worktrees = {
    create: async (repositoryId, options) => {
      calls.push(["create", repositoryId, options]);
      return { branchCreated: true, worktree: { path: integrationPath, branch: options.branch } };
    },
    snapshot: async () => ({ repositories: [] }),
  };
  const execute = async (bin, args, options) => {
    calls.push([bin, args, options]);
    if (bin === "gh" && args[1] === "view") {
      if (!pullRequest) throw new Error("no pull request found");
      return { stdout: JSON.stringify(pullRequest) };
    }
    return { stdout: "" };
  };
  const cmux = {
    workspaceCreate: async (options) => { calls.push(["workspaceCreate", options]); return { workspace_id: "workspace-merge" }; },
    rpc: async (method, params) => { calls.push(["rpc", method, params]); return {}; },
    notify: async (workspaceId, body) => { calls.push(["notify", workspaceId, body]); return {}; },
  };
  const integrator = new GoalIntegrator({ store, worktrees, repoCatalog, cmux, execute, settleMs: 1 });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, integrator, calls, integrationPath };
}

test("launches one merge agent in a fresh goal worktree when every branch is ready", async (t) => {
  const { store, integrator, calls, integrationPath } = fixture(t);
  const result = await integrator.assemble("plan-12345678");
  assert.equal(result.deliveryStatus, "assembling");
  assert.equal(result.mergeStatus, "running");
  assert.equal(calls.filter((call) => call[0] === "create").length, 1);
  const created = calls.find((call) => call[0] === "workspaceCreate")[1];
  assert.equal(created.cwd, integrationPath);
  assert.equal(created.agent, "claude");
  assert.ok(created.prompt.includes(TASK_ONE));
  assert.ok(created.prompt.includes(TASK_TWO));
  assert.equal(calls.some((call) => call[0] === "git" && call[2][0] === "merge"), false);
  assert.equal(calls.some((call) => call[0] === "git" && call[2][0] === "push"), false);
  assert.equal(calls.some((call) => call[0] === "gh" && call[1][1] === "create"), false);
  assert.equal(store.get("plan-12345678").mergeWorkspaceId, "workspace-merge");
});

test("does not launch a second merge agent while one is already running", async (t) => {
  const { integrator, calls } = fixture(t);
  await integrator.assemble("plan-12345678");
  await integrator.assemble("plan-12345678");
  assert.equal(calls.filter((call) => call[0] === "workspaceCreate").length, 1);
});

test("waits without creating a goal worktree until every task branch is pushed", async (t) => {
  const { store, integrator, calls } = fixture(t, { secondPushed: false });
  await assert.rejects(() => integrator.assemble("plan-12345678"), /Waiting for 1 task branch/);
  assert.equal(calls.filter((call) => call[0] === "create").length, 0);
  assert.equal(calls.some((call) => call[0] === "workspaceCreate"), false);
  assert.equal(store.get("plan-12345678").tasks[0].deliveryStatus, "ready");
  assert.equal(store.get("plan-12345678").tasks[1].deliveryStatus, "pending");
});

test("records the final pull request when the merge agent stops and a pull request exists", async (t) => {
  const { store, integrator } = fixture(t, { pullRequest: { number: 42, url: "https://github.test/pr/42" } });
  await integrator.assemble("plan-12345678");
  const result = await integrator.settle("plan-12345678");
  assert.equal(result.deliveryStatus, "pr_open");
  assert.equal(result.finalPrNumber, 42);
  const saved = store.get("plan-12345678");
  assert.equal(saved.finalPrUrl, "https://github.test/pr/42");
  assert.equal(saved.mergeStatus, "done");
});

test("blocks the plan when the merge agent stops without a pull request", async (t) => {
  const { store, integrator } = fixture(t);
  await integrator.assemble("plan-12345678");
  const result = await integrator.settle("plan-12345678");
  assert.equal(result.deliveryStatus, "blocked");
  assert.equal(result.mergeStatus, "blocked");
  const saved = store.get("plan-12345678");
  assert.match(saved.deliveryError, /workspace/i);
  assert.equal(saved.mergeWorkspaceId, "workspace-merge");
});

test("retries a blocked merge in the same workspace instead of opening a second one", async (t) => {
  const { integrator, calls } = fixture(t);
  await integrator.assemble("plan-12345678");
  await integrator.settle("plan-12345678");
  await integrator.assemble("plan-12345678");
  assert.equal(calls.filter((call) => call[0] === "workspaceCreate").length, 1);
  const sent = calls.filter((call) => call[0] === "rpc" && call[1] === "surface.send_text");
  assert.equal(sent.length, 1);
  assert.equal(sent[0][2].workspace_id, "workspace-merge");
  assert.match(sent[0][2].text, /Continue the merge/);
});

test("the merge prompt pins every task commit and states the conflict rule", () => {
  const plan = {
    planId: "plan-12345678",
    goal: "Ship combined billing",
    baseRef: "origin/main",
    integrationBranch: "goal/ship-combined-billing-plan1234",
    issueNumbers: [54, 55],
    tasks: [
      { id: "t1", title: "Billing API", branch: "feature/billing-api", headSha: "a".repeat(40), launchStatus: "launched" },
      { id: "t2", title: "Billing UI", branch: "feature/billing-ui", headSha: "b".repeat(40), launchStatus: "launched" },
    ],
  };
  const prompt = mergePrompt(plan);
  assert.ok(prompt.includes("a".repeat(40)));
  assert.ok(prompt.includes("b".repeat(40)));
  assert.ok(prompt.includes("feature/billing-api"));
  assert.ok(prompt.includes("Cmux-Goal-Task: plan-12345678/t1/" + "a".repeat(40)));
  assert.match(prompt, /Closes #54/);
  assert.match(prompt, /Conflicts resolved/);
  assert.match(prompt, /Do not guess/);
  assert.match(prompt, /gh pr create/);
  assert.match(prompt, /--base main/);
  assert.ok(prompt.length <= 8_000);
});

test("the merge prompt skips a task that failed to launch", () => {
  const plan = {
    planId: "plan-12345678", goal: "Ship it", baseRef: "origin/main",
    integrationBranch: "goal/ship-it-plan1234", issueNumbers: [],
    tasks: [
      { id: "t1", title: "Kept", branch: "feature/kept", headSha: "a".repeat(40), launchStatus: "launched" },
      { id: "t2", title: "Dropped", branch: "feature/dropped", headSha: null, launchStatus: "failed" },
    ],
  };
  const prompt = mergePrompt(plan);
  assert.ok(prompt.includes("feature/kept"));
  assert.equal(prompt.includes("feature/dropped"), false);
});

function manyTaskPlan(count) {
  const tasks = [];
  for (let index = 0; index < count; index += 1) {
    tasks.push({
      id: `t${index}`, title: `Task title number ${index}`, branch: `feature/task-${index}`,
      headSha: String(index % 10).repeat(40), launchStatus: "launched",
    });
  }
  return {
    planId: "plan-12345678", goal: "Ship a very large combined goal with many tasks",
    baseRef: "origin/main", integrationBranch: "goal/ship-it-plan1234", issueNumbers: [54, 55], tasks,
  };
}

test("the merge prompt refuses a goal with too many tasks to fit the cmux prompt limit", () => {
  assert.throws(() => mergePrompt(manyTaskPlan(40)), /too many tasks/);
});

test("the merge prompt keeps the finish section and the conflicts-resolved requirement near the size limit", () => {
  const prompt = mergePrompt(manyTaskPlan(20));
  assert.ok(prompt.length <= 8_000);
  assert.match(prompt, /## Finish/);
  assert.match(prompt, /## Conflicts resolved` section. This section is required/);
});

test("the merge prompt omits the linked issues section when there are no issue numbers", () => {
  const plan = {
    planId: "plan-12345678", goal: "Ship it", baseRef: "origin/main",
    integrationBranch: "goal/ship-it-plan1234", issueNumbers: [],
    tasks: [
      { id: "t1", title: "Kept", branch: "feature/kept", headSha: "a".repeat(40), launchStatus: "launched" },
    ],
  };
  const prompt = mergePrompt(plan);
  assert.equal(prompt.includes("## Linked issues"), false);
});

// Every task Stop schedules another assemble, and assemble publishes on every
// run. The extra assembles below are what a chatty five-task goal really does,
// so they are what proves the notification is sent on a change and not on a
// state.
test("notifies at the three milestones and never twice for one", async (t) => {
  const { integrator, calls } = fixture(t, { pullRequest: { number: 42, url: "https://github.test/pr/42" } });
  await integrator.assemble("plan-12345678");
  for (let index = 0; index < 4; index += 1) await integrator.assemble("plan-12345678");
  await integrator.settle("plan-12345678");
  const notices = calls.filter((call) => call[0] === "notify").map((call) => call[2].title);
  assert.equal(notices.length, 2);
  assert.ok(notices.some((title) => /merg/i.test(title)));
  assert.ok(notices.some((title) => /pull request/i.test(title)));
});

// A task that never launched can never produce a branch, so a combined pull
// request built without it would silently drop that work.
test("refuses to assemble while any task failed to launch", async (t) => {
  const { store, integrator } = fixture(t, { secondPushed: false, thirdFailed: true });
  assert.equal(store.get("plan-12345678").tasks.length, 3);
  await assert.rejects(() => integrator.assemble("plan-12345678"), /Every task must launch successfully/);
});

test("a notification failure never blocks the merge", async (t) => {
  const { store, integrator } = fixture(t, { pullRequest: { number: 42, url: "https://github.test/pr/42" } });
  integrator.cmux.notify = async () => { throw new Error("cmux is down"); };
  await integrator.assemble("plan-12345678");
  await integrator.settle("plan-12345678");
  assert.equal(store.get("plan-12345678").finalPrNumber, 42);
});

// launch_status is nullable and only recordLaunch sets it, so a missing value
// is reachable. app/worktree-planner.tsx imports this very function to render
// the goal's progress counter, so a miscount is a user-visible one.
test("counts a task with no recorded launch status as launched", () => {
  const tasks = [
    { id: "t1", deliveryStatus: "ready" },
    { id: "t2", deliveryStatus: "pending" },
    { id: "t3", launchStatus: "failed", deliveryStatus: "pending" },
  ];
  assert.deepEqual(readyCount(tasks), { ready: 1, total: 2 });
});

const tick = (ms = 20) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The lock is per operation, not per plan. A shared lock would hand the settle
// caller the assemble promise, so the pull request would never be read.
test("a settle during an in-flight assemble still checks for the pull request", async (t) => {
  const { integrator, calls } = fixture(t, { pullRequest: { number: 42, url: "https://github.test/pr/42" } });
  await integrator.assemble("plan-12345678");
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const git = integrator.repoCatalog.git;
  integrator.repoCatalog.git = async (cwd, args) => { await held; return git(cwd, args); };
  const assembling = integrator.assemble("plan-12345678");
  await tick(1);
  const settling = integrator.settle("plan-12345678");
  release();
  await assembling;
  const result = await settling;
  assert.equal(result.deliveryStatus, "pr_open");
  assert.equal(calls.some((call) => call[0] === "gh" && call[1][1] === "view"), true);
});

// The merge agent's Stop is the only settle trigger there is, so a task Stop
// arriving inside its debounce window must not take its place.
test("a task stop does not cancel a pending merge settle", async (t) => {
  const { integrator, calls } = fixture(t, { pullRequest: { number: 42, url: "https://github.test/pr/42" } });
  await integrator.assemble("plan-12345678");
  integrator.scheduleWorkspace("workspace-merge");
  integrator.scheduleWorkspace("workspace-one");
  await tick();
  assert.equal(calls.filter((call) => call[0] === "gh" && call[1][1] === "view").length, 1);
});

// A closed workspace and a cmux hiccup reject identically, so the nudge falling
// through to a fresh agent is what keeps a dead workspace id from stranding the
// plan forever. The fall-through must happen inside this one call: a retry that
// only reports the failure would take the identical branch again next time.
test("a blocked retry whose merge workspace is gone opens a fresh one", async (t) => {
  const { store, integrator, calls } = fixture(t);
  await integrator.assemble("plan-12345678");
  await integrator.settle("plan-12345678");
  integrator.cmux.rpc = async () => { throw new Error("workspace not found"); };
  integrator.cmux.workspaceCreate = async (options) => { calls.push(["workspaceCreate", options]); return { workspace_id: "workspace-merge-2" }; };
  const result = await integrator.assemble("plan-12345678");
  assert.equal(result.mergeStatus, "running");
  assert.equal(result.mergeWorkspaceId, "workspace-merge-2");
  const saved = store.get("plan-12345678");
  assert.equal(saved.mergeWorkspaceId, "workspace-merge-2");
  assert.equal(saved.deliveryStatus, "assembling");
  assert.equal(saved.deliveryError, null);
  assert.equal(calls.filter((call) => call[0] === "workspaceCreate").length, 2);
});

test("a task that pushes again mid-merge leaves the running merge alone", async (t) => {
  const { store, integrator } = fixture(t);
  await integrator.assemble("plan-12345678");
  const git = integrator.repoCatalog.git;
  integrator.repoCatalog.git = async (cwd, args) => (args[0] === "ls-remote" && cwd.endsWith("task-two") ? "" : git(cwd, args));
  const result = await integrator.assemble("plan-12345678");
  assert.equal(result.mergeStatus, "running");
  assert.equal(store.get("plan-12345678").deliveryStatus, "assembling");
});

test("a git failure while reading task branches records a delivery failure", async (t) => {
  const { store, integrator } = fixture(t);
  integrator.repoCatalog.git = async () => { throw new Error("fatal: not a git repository"); };
  await assert.rejects(() => integrator.assemble("plan-12345678"), /not a git repository/);
  const saved = store.get("plan-12345678");
  assert.equal(saved.deliveryStatus, "blocked");
  assert.match(saved.deliveryError, /not a git repository/);
});

test("a delivery failure while the merge runs demotes the merge with it", async (t) => {
  const { store, integrator } = fixture(t);
  await integrator.assemble("plan-12345678");
  integrator.repoCatalog.git = async () => { throw new Error("fatal: not a git repository"); };
  await assert.rejects(() => integrator.assemble("plan-12345678"), /not a git repository/);
  const saved = store.get("plan-12345678");
  assert.equal(saved.deliveryStatus, "blocked");
  assert.equal(saved.mergeStatus, "blocked");
});

// Only what HEAD carries counts as merged. The worktree was created for this
// branch and has it checked out, so HEAD is where the merge agent committed;
// asking for the branch by name could resolve some other ref of that name and
// silently read a history the merge never touched. The stub answers that name
// with base history to prove which one is read.
test("marks each task integrated from the trailers on the merged branch", async (t) => {
  const { store, integrator, integrationPath } = fixture(t, { pullRequest: { number: 42, url: "https://github.test/pr/42" } });
  await integrator.assemble("plan-12345678");
  const git = integrator.repoCatalog.git;
  integrator.repoCatalog.git = async (cwd, args) => {
    if (cwd !== integrationPath || args[0] !== "log") return git(cwd, args);
    return args.includes("HEAD")
      ? `Task 1: Billing API\n\nCmux-Goal-Task: plan-12345678/t1/${TASK_ONE}\n`
      : "Some earlier commit on the base branch\n";
  };
  await integrator.settle("plan-12345678");
  const saved = store.get("plan-12345678");
  assert.equal(saved.tasks[0].deliveryStatus, "integrated");
  assert.equal(saved.tasks[0].integratedCommitSha, TASK_ONE);
  assert.equal(saved.tasks[1].deliveryStatus, "ready");
});
