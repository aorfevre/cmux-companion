import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalIntegrator, qualityCommands } from "../server/goal-integrator.mjs";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";

const REPO_ID = "repository12345678";
const TASK_ONE = "a".repeat(40);
const TASK_TWO = "b".repeat(40);
const BASE = "c".repeat(40);

function fixture(t, { secondPushed = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "goal-integrator-"));
  const integrationPath = join(root, "sample-goal");
  mkdirSync(integrationPath);
  writeFileSync(join(integrationPath, "package.json"), JSON.stringify({ scripts: { verify: "node verify.mjs" } }));
  writeFileSync(join(integrationPath, "package-lock.json"), "{}\n");
  const store = new WorktreePlanStore({ path: ":memory:" });
  store.createPlan({ planId: "plan-12345678", repositoryId: REPO_ID, repositoryName: "sample", cwd: root, goal: "Ship combined billing", sourceType: "github_issues", issueNumbers: [54, 55], issueUrls: ["https://github.test/issues/54", "https://github.test/issues/55"] });
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
  let integrationCommits = 0;
  let prViews = 0;
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
        const sha = cwd.endsWith("task-one") ? TASK_ONE : TASK_TWO;
        if (!secondPushed && cwd.endsWith("task-two")) return "";
        return `${sha}\t${args[2]}\n`;
      }
      if (args[0] === "rev-parse" && cwd.endsWith("task-one")) return `${TASK_ONE}\n`;
      if (args[0] === "rev-parse" && cwd.endsWith("task-two")) return `${TASK_TWO}\n`;
      if (args[0] === "commit") integrationCommits += 1;
      if (args[0] === "rev-parse" && cwd === integrationPath) return `${String(integrationCommits).repeat(40).slice(0, 40)}\n`;
      return "";
    },
  };
  const worktrees = {
    create: async (repositoryId, options) => {
      calls.push(["create", repositoryId, options]);
      return { branchCreated: true, worktree: { path: integrationPath, branch: options.branch } };
    },
  };
  const execute = async (bin, args, options) => {
    calls.push([bin, args, options]);
    if (bin === "gh" && args[1] === "view") {
      prViews += 1;
      if (prViews === 1) throw new Error("no pull request");
      return { stdout: JSON.stringify({ number: 42, url: "https://github.test/pr/42" }) };
    }
    return { stdout: "" };
  };
  const integrator = new GoalIntegrator({ store, worktrees, repoCatalog, execute, settleMs: 1 });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, integrator, calls, integrationPath };
}

test("assembles pushed task heads, verifies them together and opens one pull request", async (t) => {
  const { store, integrator, calls } = fixture(t);
  const result = await integrator.assemble("plan-12345678");
  assert.equal(result.deliveryStatus, "pr_open");
  assert.equal(result.finalPrNumber, 42);
  assert.equal(result.finalPrUrl, "https://github.test/pr/42");
  assert.deepEqual(calls.filter((call) => call[0] === "git" && call[2][0] === "merge").map((call) => call[2].at(-1)), [TASK_ONE, TASK_TWO]);
  assert.equal(calls.filter((call) => call[0] === "create").length, 1);
  assert.ok(calls.some((call) => call[0] === "npm" && call[1][0] === "ci"));
  assert.ok(calls.some((call) => call[0] === "npm" && call[1].join(" ") === "run verify"));
  const createPr = calls.find((call) => call[0] === "gh" && call[1][1] === "create");
  assert.equal(createPr[1][createPr[1].indexOf("--base") + 1], "main");
  assert.match(createPr[1][createPr[1].indexOf("--body") + 1], /Billing API/);
  assert.match(createPr[1][createPr[1].indexOf("--body") + 1], /Billing UI/);
  assert.match(createPr[1][createPr[1].indexOf("--body") + 1], /Closes #54\nCloses #55/);
  const saved = store.get("plan-12345678");
  assert.deepEqual(saved.tasks.map((task) => task.deliveryStatus), ["integrated", "integrated"]);
  assert.equal(saved.finalPrUrl, "https://github.test/pr/42");
});

test("waits without creating an integration branch until every task branch is pushed", async (t) => {
  const { store, integrator, calls } = fixture(t, { secondPushed: false });
  await assert.rejects(() => integrator.assemble("plan-12345678"), /Waiting for 1 task branch/);
  assert.equal(calls.filter((call) => call[0] === "create").length, 0);
  assert.equal(store.get("plan-12345678").tasks[0].deliveryStatus, "ready");
  assert.equal(store.get("plan-12345678").tasks[1].deliveryStatus, "pending");
});

test("selects one declared verify script instead of guessing model-generated commands", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "goal-quality-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { verify: "all", test: "unit", build: "build" } }));
  const commands = await qualityCommands(root);
  assert.deepEqual(commands, [{ bin: "npm", args: ["run", "verify"] }]);
});
