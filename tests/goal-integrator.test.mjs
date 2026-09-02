import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBriefs } from "../server/agent-brief.mjs";
import { GoalIntegrator, mergePrompt, readyCount } from "../server/goal-integrator.mjs";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";

const REPO_ID = "repository12345678";
const TASK_ONE = "a".repeat(40);
const TASK_TWO = "b".repeat(40);
const BASE = "c".repeat(40);

function fixture(t, { secondPushed = true, pullRequest = null, thirdFailed = false, contract = false, workflow = false, reports = {}, changedFiles = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "goal-integrator-"));
  const integrationPath = join(root, "sample-goal");
  mkdirSync(integrationPath);
  const store = new WorktreePlanStore({ path: ":memory:" });
  store.createPlan({ planId: "plan-12345678", repositoryId: REPO_ID, repositoryName: "sample", cwd: root, goal: "Ship combined billing", sourceType: "github_issues", issueNumbers: [54, 55], issueUrls: ["https://github.test/issues/54"] });
  store.recordRound("plan-12345678", {
    round: 1, stage: "ready", sessionId: "session",
    ...(contract ? {
      spec: {
        version: 2, outcome: "Ship combined billing", inScope: ["Billing API and UI"], nonGoals: [], constraints: [], assumptions: [], risks: [],
        acceptanceCriteria: [
          { id: "AC-1", text: "The API supports billing", verification: "API tests pass" },
          { id: "AC-2", text: "The UI supports billing", verification: "UI tests pass" },
        ],
      },
      readiness: { ready: true, errors: [], warnings: [], waves: workflow ? [["t1"], ["t2"]] : [["t1", "t2"]], coverage: [] },
    } : {}),
    tasks: [
      { id: "t1", title: "Billing API", branch: "feature/billing-api", prompt: "Build it", agent: "codex", ...(contract ? { type: "backend", criterionIds: ["AC-1"], dependsOn: [], ownedAreas: ["server/**"], verification: ["npm test"] } : {}) },
      { id: "t2", title: "Billing UI", branch: "feature/billing-ui", prompt: "Build it", agent: "claude", ...(contract ? { type: "ui", criterionIds: ["AC-2"], dependsOn: workflow ? ["t1"] : [], ownedAreas: ["app/**"], verification: ["npm test"], wave: workflow ? 1 : 0 } : {}) },
      ...(thirdFailed ? [{ id: "t3", title: "Billing docs", branch: "feature/billing-docs", prompt: "Build it", agent: "codex" }] : []),
    ],
  });
  store.recordLaunch("plan-12345678", {
    base: "origin/main", baseSha: BASE,
    results: [
      { id: "t1", status: "launched", path: join(root, "task-one"), workspace: { workspace_id: "workspace-one" } },
      { id: "t2", status: workflow ? "queued" : "launched", ...(workflow ? {} : { path: join(root, "task-two"), workspace: { workspace_id: "workspace-two" } }) },
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
        const criterion = taskId === "t1" ? "AC-1" : "AC-2";
        const defaultReport = { criteria: [criterion], verification: [{ check: "npm test", status: "passed" }], limitations: [] };
        const report = Object.hasOwn(reports, taskId) ? reports[taskId] : defaultReport;
        return `Finish task\n\n${contract && report !== null ? `Cmux-Goal-Report: ${JSON.stringify(report)}\n` : ""}Cmux-Goal-Ready: plan-12345678/${taskId}\n`;
      }
      if (args[0] === "diff") {
        const taskId = cwd.endsWith("task-one") ? "t1" : "t2";
        return (changedFiles[taskId] || []).join("\0");
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
      const path = options.branch === "feature/billing-ui" ? join(root, "task-two") : integrationPath;
      // Real git makes the directory. The fake must too, or a test cannot tell
      // a rebuilt worktree apart from a path that was never created.
      mkdirSync(path, { recursive: true });
      return { branchCreated: true, worktree: { path, branch: options.branch } };
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
    workspaceClose: async (workspaceId) => { calls.push(["workspaceClose", workspaceId]); return { ok: true }; },
  };
  const briefs = new AgentBriefs({ directory: join(root, "briefs") });
  const integrator = new GoalIntegrator({ store, worktrees, repoCatalog, cmux, execute, settleMs: 1, briefs });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, integrator, calls, integrationPath };
}

// cmux caps a prompt at this many characters, so the session gets a pointer and
// the brief itself lives in a file.
const MAX_PROMPT = 8_000;

// The prompt names the brief file. The brief content is what the agent reads.
function briefText(prompt) {
  const path = String(prompt).match(/^Read the file (.+?) in full/m)?.[1];
  assert.ok(path, `the prompt must name a brief file, got: ${prompt}`);
  return readFileSync(path, "utf8");
}

function assertPointer(prompt) {
  assert.ok(prompt.length <= MAX_PROMPT, `the prompt must stay under ${MAX_PROMPT} characters, got ${prompt.length}`);
  assert.match(prompt, /^Read the file .+ in full/m);
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
  assertPointer(created.prompt);
  const brief = briefText(created.prompt);
  assert.ok(brief.includes(TASK_ONE));
  assert.ok(brief.includes(TASK_TWO));
  assert.match(brief, /Closes #54/);
  assert.match(brief, /## How to merge/);
  assert.match(brief, /## Finish/);
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

test("a valid Delivery Contract report makes a task branch ready", async (t) => {
  const { store, integrator } = fixture(t, { contract: true, secondPushed: false });
  await assert.rejects(() => integrator.assemble("plan-12345678"), /Waiting for 1 task branch/);
  const task = store.get("plan-12345678").tasks[0];
  assert.equal(task.deliveryStatus, "ready");
  assert.equal(task.evidenceStatus, "ready");
  assert.deepEqual(task.completionReport.criteria, ["AC-1"]);
});

test("missing completion evidence keeps the task pending and sends one correction", async (t) => {
  const { store, integrator, calls } = fixture(t, { contract: true, reports: { t1: null }, secondPushed: false });
  await assert.rejects(() => integrator.assemble("plan-12345678"), /Waiting for 2 task branches/);
  await assert.rejects(() => integrator.assemble("plan-12345678"), /Waiting for 2 task branches/);
  const task = store.get("plan-12345678").tasks[0];
  assert.equal(task.deliveryStatus, "pending");
  assert.match(task.evidenceError, /no Cmux-Goal-Report/);
  assert.equal(calls.filter((call) => call[0] === "rpc" && call[2].workspace_id === "workspace-one").length, 1);
});

test("incomplete criterion coverage and failed verification keep branches pending", async (t) => {
  const reports = {
    t1: { criteria: [], verification: [{ check: "npm test", status: "passed" }], limitations: [] },
    t2: { criteria: ["AC-2"], verification: [{ check: "npm test", status: "failed" }], limitations: [] },
  };
  const { store, integrator } = fixture(t, { contract: true, reports });
  await assert.rejects(() => integrator.assemble("plan-12345678"), /Waiting for 2 task branches/);
  const [first, second] = store.get("plan-12345678").tasks;
  assert.match(first.evidenceError, /missing AC-1/);
  assert.match(second.evidenceError, /must pass/);
});

test("scope drift is stored as a warning but does not block readiness", async (t) => {
  const { store, integrator } = fixture(t, { contract: true, secondPushed: false, changedFiles: { t1: ["server/billing.mjs", "README.md"] } });
  await assert.rejects(() => integrator.assemble("plan-12345678"), /Waiting for 1 task branch/);
  const task = store.get("plan-12345678").tasks[0];
  assert.equal(task.deliveryStatus, "ready");
  assert.deepEqual(task.changedFiles, ["server/billing.mjs", "README.md"]);
  assert.deepEqual(task.scopeWarnings, ["README.md"]);
});

test("a completed workflow wave launches its dependents from the integrated commit", async (t) => {
  const { store, integrator, calls, integrationPath } = fixture(t, { contract: true, workflow: true });
  await integrator.assemble("plan-12345678");
  const wavePrompt = calls.find((call) => call[0] === "workspaceCreate")[1].prompt;
  assertPointer(wavePrompt);
  const waveBrief = briefText(wavePrompt);
  assert.match(waveBrief, /workflow wave 1/i);
  assert.match(waveBrief, /Do not open a pull request yet/);
  assert.equal(waveBrief.includes("gh pr create"), false);
  const git = integrator.repoCatalog.git;
  const integratedSha = "d".repeat(40);
  integrator.repoCatalog.git = async (cwd, args) => {
    if (cwd === integrationPath && args[0] === "log") return `Task 1: Billing API\n\nCmux-Goal-Task: plan-12345678/t1/${TASK_ONE}\n`;
    if (cwd === integrationPath && args[0] === "rev-parse") return `${integratedSha}\n`;
    return git(cwd, args);
  };
  const result = await integrator.settle("plan-12345678");
  assert.equal(result.deliveryStatus, "implementing");
  const saved = store.get("plan-12345678");
  assert.equal(saved.tasks[0].deliveryStatus, "integrated");
  assert.equal(saved.tasks[1].launchStatus, "launched");
  assert.equal(saved.tasks[1].startSha, integratedSha);
  assert.equal(calls.some((call) => call[0] === "create" && call[2].branch === "feature/billing-ui" && call[2].base === integratedSha), true);
  const downstream = calls.filter((call) => call[0] === "workspaceCreate").at(-1)[1];
  assertPointer(downstream.prompt);
  assert.match(briefText(downstream.prompt), /Workflow dependencies: t1/);
});

test("a restart advances queued work when the previous wave was already recorded as integrated", async (t) => {
  const { store, integrator, calls, integrationPath } = fixture(t, { contract: true, workflow: true });
  store.recordTaskReady("plan-12345678", "t1", TASK_ONE, { report: { criteria: ["AC-1"], verification: [{ check: "npm test", status: "passed" }], limitations: [] } });
  store.recordIntegrationStarted("plan-12345678", { branch: "goal/ship-combined-billing-plan1234", path: integrationPath });
  store.recordTaskIntegrated("plan-12345678", "t1", TASK_ONE);
  const integratedSha = "e".repeat(40);
  const git = integrator.repoCatalog.git;
  integrator.repoCatalog.git = async (cwd, args) => (cwd === integrationPath && args[0] === "rev-parse" ? `${integratedSha}\n` : git(cwd, args));

  const result = await integrator.assemble("plan-12345678");
  assert.equal(result.deliveryStatus, "implementing");
  assert.equal(store.get("plan-12345678").tasks[1].startSha, integratedSha);
  const workspace = calls.find((call) => call[0] === "workspaceCreate");
  // The session name carries the project, task and part codes before the
  // title, so a sidebar of parallel sessions is readable at a glance.
  assert.equal(workspace[1].title, "SMP-T2-ui \u00b7 Billing UI");
  assert.equal(workspace[1].cwd.endsWith("task-two"), true);
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
    spec: { outcome: "Customers can pay invoices", acceptanceCriteria: [{ id: "AC-1", text: "Payment succeeds", verification: "npm test" }], nonGoals: ["Refunds"], constraints: ["Stable API"] },
    tasks: [
      { id: "t1", title: "Billing API", branch: "feature/billing-api", headSha: "a".repeat(40), launchStatus: "launched", criterionIds: ["AC-1"], completionReport: { criteria: ["AC-1"], verification: [{ check: "npm test", status: "passed" }], limitations: [] }, scopeWarnings: ["README.md"] },
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
  assert.match(prompt, /## Delivery contract/);
  assert.match(prompt, /AC-1: Payment succeeds/);
  assert.match(prompt, /## Evidence/);
  assert.match(prompt, /npm test=passed/);
  assert.match(prompt, /scope exceptions: README.md/);
  assert.match(prompt, /Do not guess/);
  assert.match(prompt, /current HEAD.*do not checkout or reset another ref/i);
  assert.match(prompt, /gh pr create/);
  assert.match(prompt, /--base main/);
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

// The brief is a file, so no task count can overflow a prompt limit any more.
test("a twenty task goal still produces one complete merge brief", () => {
  const prompt = mergePrompt(manyTaskPlan(20));
  assert.match(prompt, /## Finish/);
  assert.match(prompt, /## Conflicts resolved` section. This section is required/);
  assert.match(prompt, /Task title number 19/);
});

test("a forty task goal produces a merge brief instead of throwing", () => {
  const prompt = mergePrompt(manyTaskPlan(40));
  assert.match(prompt, /Task title number 39/);
  assert.match(prompt, /## Finish/);
  assert.ok(prompt.length > MAX_PROMPT, "a forty task brief is longer than a cmux prompt, which is why it goes to a file");
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
  // The refusal now names the task and the two ways out, because a failed
  // task used to end the goal with no route back.
  await assert.rejects(() => integrator.assemble("plan-12345678"), /1 task never launched \(Billing docs\)\. Relaunch each one, or skip it/);
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

test("rebuilds the goal worktree when its recorded path no longer exists on disk", async (t) => {
  const { store, integrator, calls, integrationPath } = fixture(t);
  await integrator.assemble("plan-12345678");
  await integrator.settle("plan-12345678");
  // The user removed the goal worktree between the blocked merge and the
  // retry. The branch survives; the directory does not.
  rmSync(integrationPath, { recursive: true, force: true });
  await integrator.assemble("plan-12345678");
  const cwds = calls.filter((call) => call[0] === "workspaceCreate").map((call) => call[1].cwd);
  const nudges = calls.filter((call) => call[0] === "rpc" && call[1] === "surface.send_text");
  for (const cwd of cwds) assert.equal(existsSync(cwd), true, `merge agent was sent to a missing directory: ${cwd}`);
  assert.equal(nudges.length === 0 || existsSync(store.get("plan-12345678").integrationWorktreePath), true);
});

test("reuses the goal worktree that git already has for the integration branch", async (t) => {
  const { store, integrator, calls, integrationPath } = fixture(t);
  await integrator.assemble("plan-12345678");
  await integrator.settle("plan-12345678");
  rmSync(integrationPath, { recursive: true, force: true });
  const recoveredPath = mkdtempSync(join(tmpdir(), "goal-recovered-"));
  t.after(() => rmSync(recoveredPath, { recursive: true, force: true }));
  const branch = store.get("plan-12345678").integrationBranch;
  integrator.worktrees.snapshot = async () => ({
    repositories: [{ id: REPO_ID, worktrees: [{ branch, path: recoveredPath }] }],
  });
  await integrator.assemble("plan-12345678");
  assert.equal(store.get("plan-12345678").integrationWorktreePath, recoveredPath);
  assert.equal(calls.filter((call) => call[0] === "create").length, 1);
});

// A wave launch makes the worktree first and opens the session second. When the
// session step fails, a retry finds the leftover worktree. The dashboard hands
// it back as reused, and the "branch already exists" guard must let it through.
test("a wave retry launches a task whose worktree a failed launch left behind", async (t) => {
  const { store, integrator, calls, integrationPath } = fixture(t, { contract: true, workflow: true });
  await integrator.assemble("plan-12345678");
  const git = integrator.repoCatalog.git;
  const integratedSha = "d".repeat(40);
  integrator.repoCatalog.git = async (cwd, args) => {
    if (cwd === integrationPath && args[0] === "log") return `Task 1: Billing API\n\nCmux-Goal-Task: plan-12345678/t1/${TASK_ONE}\n`;
    if (cwd === integrationPath && args[0] === "rev-parse") return `${integratedSha}\n`;
    return git(cwd, args);
  };
  const create = integrator.worktrees.create;
  integrator.worktrees.create = async (repositoryId, options) => {
    const result = await create(repositoryId, options);
    return { ...result, created: false, reused: true, branchCreated: false };
  };
  await integrator.settle("plan-12345678");
  const saved = store.get("plan-12345678");
  assert.equal(saved.tasks[1].launchStatus, "launched");
  assert.equal(saved.tasks[1].startSha, integratedSha);
  const waveCreate = calls.filter((call) => call[0] === "create" && call[2].branch === "feature/billing-ui").at(-1);
  assert.equal(waveCreate[2].reuseIfAtBase, true);
  assert.deepEqual(waveCreate[2].workspaces, []);
});


// A finished goal used to leave every session it opened in the cmux sidebar:
// one per task, plus one per merge attempt. Each is closed the moment its work
// is integrated, so only the session that opened the pull request stays.
function integrateBoth(integrator, integrationPath) {
  const git = integrator.repoCatalog.git;
  integrator.repoCatalog.git = async (cwd, args) => {
    if (cwd === integrationPath && args[0] === "log") {
      return `Task 1\n\nCmux-Goal-Task: plan-12345678/t1/${TASK_ONE}\nCmux-Goal-Task: plan-12345678/t2/${TASK_TWO}\n`;
    }
    return git(cwd, args);
  };
}

const closedWorkspaces = (calls) => calls.filter((call) => call[0] === "workspaceClose").map((call) => call[1]);

test("closes each task session once its branch is integrated", async (t) => {
  const { store, integrator, calls, integrationPath } = fixture(t, { pullRequest: { number: 42, url: "https://github.test/pr/42" } });
  await integrator.assemble("plan-12345678");
  integrateBoth(integrator, integrationPath);
  await integrator.settle("plan-12345678");
  assert.deepEqual(closedWorkspaces(calls).sort(), ["workspace-one", "workspace-two"]);
  const saved = store.get("plan-12345678");
  assert.ok(saved.tasks.every((task) => task.sessionClosedAt));
});

test("closes a merge session that a fresh merge agent superseded", async (t) => {
  const { store, integrator, calls } = fixture(t);
  await integrator.assemble("plan-12345678");
  await integrator.settle("plan-12345678");
  integrator.cmux.rpc = async () => { throw new Error("workspace not found"); };
  integrator.cmux.workspaceCreate = async (options) => { calls.push(["workspaceCreate", options]); return { workspace_id: "workspace-merge-2" }; };
  const result = await integrator.assemble("plan-12345678");
  assert.equal(result.mergeWorkspaceId, "workspace-merge-2");
  assert.deepEqual(closedWorkspaces(calls), ["workspace-merge"]);
  assert.deepEqual(store.get("plan-12345678").supersededMergeWorkspaces.map((entry) => entry.workspaceId), ["workspace-merge"]);
});

test("closes a wave merge session once its wave is integrated", async (t) => {
  const { integrator, calls, integrationPath } = fixture(t, { contract: true, workflow: true });
  await integrator.assemble("plan-12345678");
  const git = integrator.repoCatalog.git;
  integrator.repoCatalog.git = async (cwd, args) => {
    if (cwd === integrationPath && args[0] === "log") return `Task 1: Billing API\n\nCmux-Goal-Task: plan-12345678/t1/${TASK_ONE}\n`;
    if (cwd === integrationPath && args[0] === "rev-parse") return `${"d".repeat(40)}\n`;
    return git(cwd, args);
  };
  await integrator.settle("plan-12345678");
  assert.deepEqual(closedWorkspaces(calls).sort(), ["workspace-merge", "workspace-one"]);
});

test("keeps the session that opened the pull request and closes the rest", async (t) => {
  const { store, integrator, calls, integrationPath } = fixture(t, { pullRequest: { number: 42, url: "https://github.test/pr/42" } });
  await integrator.assemble("plan-12345678");
  integrateBoth(integrator, integrationPath);
  const result = await integrator.settle("plan-12345678");
  assert.equal(result.deliveryStatus, "pr_open");
  const closed = closedWorkspaces(calls);
  assert.deepEqual(closed.sort(), ["workspace-one", "workspace-two"]);
  assert.equal(closed.includes(store.get("plan-12345678").mergeWorkspaceId), false);
});

test("a cmux client with no workspaceClose still delivers the pull request", async (t) => {
  const { store, integrator, integrationPath } = fixture(t, { pullRequest: { number: 42, url: "https://github.test/pr/42" } });
  delete integrator.cmux.workspaceClose;
  await integrator.assemble("plan-12345678");
  integrateBoth(integrator, integrationPath);
  const result = await integrator.settle("plan-12345678");
  assert.equal(result.deliveryStatus, "pr_open");
  assert.equal(store.get("plan-12345678").finalPrNumber, 42);
});

test("a rejecting workspaceClose never changes the delivery result", async (t) => {
  const { store, integrator, integrationPath } = fixture(t, { pullRequest: { number: 42, url: "https://github.test/pr/42" } });
  integrator.cmux.workspaceClose = async () => { throw new Error("cmux is down"); };
  await integrator.assemble("plan-12345678");
  integrateBoth(integrator, integrationPath);
  const result = await integrator.settle("plan-12345678");
  assert.equal(result.deliveryStatus, "pr_open");
  assert.equal(store.get("plan-12345678").finalPrNumber, 42);
  // A session cmux merely could not reach stays open and stays retryable.
  assert.equal(store.get("plan-12345678").tasks.some((task) => task.sessionClosedAt), false);
});

// Retirement is durable, so neither a repeated settle nor a restart with a
// fresh integrator over the same store may close a session twice.
test("no session is closed twice across a second settle or a restart", async (t) => {
  const { store, integrator, calls, integrationPath } = fixture(t, { pullRequest: { number: 42, url: "https://github.test/pr/42" } });
  await integrator.assemble("plan-12345678");
  integrateBoth(integrator, integrationPath);
  await integrator.settle("plan-12345678");
  assert.equal(closedWorkspaces(calls).length, 2);
  await integrator.settle("plan-12345678");
  const restarted = new GoalIntegrator({
    store, worktrees: integrator.worktrees, repoCatalog: integrator.repoCatalog,
    cmux: integrator.cmux, execute: integrator.execute, settleMs: 1, briefs: integrator.briefs,
  });
  await restarted.settle("plan-12345678");
  assert.equal(closedWorkspaces(calls).length, 2);
});

test("closes nothing while a task branch is still unpushed", async (t) => {
  const { integrator, calls } = fixture(t, { secondPushed: false });
  await assert.rejects(() => integrator.assemble("plan-12345678"), /Waiting for 1 task branch/);
  assert.equal(closedWorkspaces(calls).length, 0);
});

test("closes nothing new when the merge agent stops without a pull request", async (t) => {
  const { integrator, calls } = fixture(t);
  await integrator.assemble("plan-12345678");
  const result = await integrator.settle("plan-12345678");
  assert.equal(result.mergeStatus, "blocked");
  assert.equal(closedWorkspaces(calls).length, 0);
});

// --- terminal lifecycle guards -------------------------------------------

function eventHub() {
  const listeners = new Set();
  return {
    listeners,
    on: (_name, listener) => listeners.add(listener),
    off: (_name, listener) => listeners.delete(listener),
    addConsumer: () => {},
    removeConsumer: () => {},
    emit: (event) => { for (const listener of listeners) listener(event); },
  };
}

test("an explicit assemble on an aborted goal says the goal was aborted", async (t) => {
  const { store, integrator, calls } = fixture(t);
  store.recordGoalAborted("plan-12345678");
  await assert.rejects(() => integrator.assemble("plan-12345678"), /was aborted/);
  assert.equal(calls.some((call) => call[0] === "workspaceCreate"), false);
  // A stopped goal is not a failed delivery, so no error is written to it.
  assert.equal(store.get("plan-12345678").deliveryError, null);
});

test("an explicit assemble on a merged goal says it is already merged", async (t) => {
  const { store, integrator, calls } = fixture(t);
  store.recordGoalMerged("plan-12345678", { number: 9, url: "https://github.test/pr/9" });
  await assert.rejects(() => integrator.assemble("plan-12345678"), /already merged/);
  assert.equal(calls.some((call) => call[0] === "workspaceCreate"), false);
});

test("a Stop hook on an aborted goal schedules nothing and creates no session", async (t) => {
  const { store, integrator, calls } = fixture(t);
  const events = eventHub();
  const detach = integrator.attach({ hub: events });
  t.after(() => detach());
  store.recordGoalAborted("plan-12345678");
  events.emit({ name: "agent.hook.Stop", workspace_id: "workspace-one" });
  assert.equal(integrator.timers.size, 0, "no timer may be armed for a terminal goal");
  await tick(20);
  assert.equal(calls.some((call) => call[0] === "workspaceCreate"), false);
});

test("startup iteration skips a goal that was aborted while the companion was down", async (t) => {
  const { store, integrator, calls } = fixture(t);
  store.recordGoalAborted("plan-12345678");
  const detach = integrator.attach({ hub: eventHub() });
  t.after(() => detach());
  await tick(20);
  assert.equal(integrator.timers.size, 0);
  assert.equal(integrator.settleTimers.size, 0);
  assert.equal(calls.some((call) => call[0] === "workspaceCreate"), false);
});

test("an abort landing inside a debounce window stops the scheduled assembly", async (t) => {
  const { store, integrator, calls } = fixture(t);
  integrator.schedulePlan("plan-12345678");
  assert.equal(integrator.timers.size, 1, "the timer is armed while the goal is still live");
  // The abort route calls cancel first, then the store records the outcome.
  assert.deepEqual(integrator.cancel("plan-12345678"), { planId: "plan-12345678", cancelled: true });
  store.recordGoalAborted("plan-12345678");
  assert.equal(integrator.timers.size, 0);
  await tick(20);
  assert.equal(calls.some((call) => call[0] === "workspaceCreate"), false);
});

// The dangerous race: the timer already fired and the assembly is inside its
// own async work when the abort lands. The re-read before workspaceCreate is
// the only thing that stops a session being opened for a goal that has ended.
test("an abort racing the point before a merge session is created creates none", async (t) => {
  const { store, integrator, calls } = fixture(t);
  const create = integrator.worktrees.create;
  integrator.worktrees.create = async (repositoryId, options) => {
    const result = await create(repositoryId, options);
    store.recordGoalAborted("plan-12345678");
    return result;
  };
  await assert.rejects(() => integrator.assemble("plan-12345678"), /was aborted/);
  assert.equal(calls.some((call) => call[0] === "workspaceCreate"), false, "no merge session may exist after the abort");
});

test("an abort during a wave merge stops the next wave from launching", async (t) => {
  const { store, integrator, calls } = fixture(t, { contract: true, workflow: true });
  await integrator.assemble("plan-12345678");
  assert.equal(store.get("plan-12345678").mergeStatus, "running");
  const launchedBefore = calls.filter((call) => call[0] === "workspaceCreate").length;
  store.recordGoalAborted("plan-12345678");
  await integrator.settle("plan-12345678");
  assert.equal(calls.filter((call) => call[0] === "workspaceCreate").length, launchedBefore, "the queued wave must not launch");
  assert.equal(store.get("plan-12345678").tasks.find((task) => task.id === "t2").launchStatus, "queued");
});

test("cancel is safe on a plan that has nothing scheduled", async (t) => {
  const { integrator } = fixture(t);
  assert.deepEqual(integrator.cancel("plan-12345678"), { planId: "plan-12345678", cancelled: true });
  assert.deepEqual(integrator.cancel(null), { planId: "", cancelled: true });
});

test("an unreadable lifecycle never blocks delivery", async (t) => {
  const { store, integrator } = fixture(t);
  const warnings = [];
  integrator.log = { warn: (...args) => warnings.push(args) };
  store.get = () => { throw new Error("database is locked"); };
  assert.equal(integrator.timers.size, 0);
  integrator.schedulePlan("plan-12345678");
  assert.equal(integrator.timers.size, 1, "an unreadable lifecycle must not be read as terminal");
  integrator.cancel("plan-12345678");
  assert.equal(warnings.length, 1);
});
