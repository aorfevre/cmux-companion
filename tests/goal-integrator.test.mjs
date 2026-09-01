import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalIntegrator, mergePrompt } from "../server/goal-integrator.mjs";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";

const REPO_ID = "repository12345678";
const TASK_ONE = "a".repeat(40);
const TASK_TWO = "b".repeat(40);
const BASE = "c".repeat(40);

function fixture(t, { secondPushed = true, pullRequest = null, groupsFail = false } = {}) {
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
    ],
  });
  store.recordLaunch("plan-12345678", {
    base: "origin/main", baseSha: BASE,
    results: [
      { id: "t1", status: "launched", path: join(root, "task-one"), workspace: { workspace_id: "workspace-one" } },
      { id: "t2", status: "launched", path: join(root, "task-two"), workspace: { workspace_id: "workspace-two" } },
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
  const groups = {
    ensure: async (...args) => { calls.push(["ensure", ...args]); if (groupsFail) throw new Error("cmux is down"); return "group-1"; },
    rename: async (...args) => { calls.push(["rename", ...args]); if (groupsFail) throw new Error("cmux is down"); return true; },
  };
  const integrator = new GoalIntegrator({ store, worktrees, repoCatalog, cmux, groups, execute, settleMs: 1 });
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

test("a cmux group failure never blocks the merge", async (t) => {
  const { store, integrator, calls } = fixture(t, { groupsFail: true });
  await integrator.assemble("plan-12345678");
  assert.equal(calls.filter((call) => call[0] === "workspaceCreate").length, 1);
  assert.equal(store.get("plan-12345678").mergeStatus, "running");
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

test("renames the goal group with the counter and notifies at the three milestones", async (t) => {
  const { integrator, calls } = fixture(t, { pullRequest: { number: 42, url: "https://github.test/pr/42" } });
  await integrator.assemble("plan-12345678");
  await integrator.settle("plan-12345678");
  const names = calls.filter((call) => call[0] === "rename").map((call) => call[2]);
  assert.ok(names.some((name) => name.includes("merging")));
  assert.ok(names.some((name) => name.includes("PR #42")));
  const notices = calls.filter((call) => call[0] === "notify").map((call) => call[2].title);
  assert.equal(notices.length, 2);
  assert.ok(notices.some((title) => /merg/i.test(title)));
  assert.ok(notices.some((title) => /pull request/i.test(title)));
});

test("names a counting group with the ready count over the launched count", async (t) => {
  const { integrator, calls } = fixture(t, { secondPushed: false });
  await assert.rejects(() => integrator.assemble("plan-12345678"), /Waiting for 1 task branch/);
  assert.deepEqual(calls.filter((call) => call[0] === "rename").map((call) => call[2]), ["Ship combined billing — 1/2"]);
});

test("a notification failure never blocks the merge", async (t) => {
  const { store, integrator } = fixture(t, { pullRequest: { number: 42, url: "https://github.test/pr/42" } });
  integrator.cmux.notify = async () => { throw new Error("cmux is down"); };
  await integrator.assemble("plan-12345678");
  await integrator.settle("plan-12345678");
  assert.equal(store.get("plan-12345678").finalPrNumber, 42);
});

// The group name carries a live counter, so a lookup by exact name would make a
// new group on every count change. The goal prefix is what keeps it one group.
test("reuses one goal group as the counter advances", async (t) => {
  const { store, integrator, calls } = fixture(t, { pullRequest: { number: 42, url: "https://github.test/pr/42" } });
  await integrator.assemble("plan-12345678");
  await integrator.settle("plan-12345678");
  const ensured = calls.filter((call) => call[0] === "ensure");
  assert.equal(ensured.length, 1);
  assert.equal(ensured[0][1], "Ship combined billing — 2/2");
  assert.equal(ensured[0][2], "workspace-one");
  assert.equal(ensured[0][3].prefix, "Ship combined billing —");
  const renamed = calls.filter((call) => call[0] === "rename");
  assert.deepEqual([...new Set(renamed.map((call) => call[1]))], ["group-1"]);
  assert.deepEqual(renamed.map((call) => call[2]), [
    "Ship combined billing — 2/2", "Ship combined billing — merging", "Ship combined billing — PR #42",
  ]);
  assert.equal(store.get("plan-12345678").cmuxGroupId, "group-1");
});
