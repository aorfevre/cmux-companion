import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { inspectTaskAssociation, applyTaskAssociation } from "../server/task-association.mjs";

test("recovery verifies repository, branch, exact pushed identity, cleanliness and agent activity", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "task-association-")));
  const previousHome = process.env.CMUX_COMPANION_HOME;
  process.env.CMUX_COMPANION_HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CMUX_COMPANION_HOME;
    else process.env.CMUX_COMPANION_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "user.name", "Fixture");
  git(root, "commit", "--allow-empty", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");
  const checkout = join(root, "task");
  git(root, "worktree", "add", "-b", "feature/task", checkout);
  git(root, "commit", "--allow-empty", "-m", "repository advances");
  git(checkout, "commit", "--allow-empty", "-m", "finished\n\nCmux-Goal-Ready: plan/T1");
  git(root, "init", "--bare", join(root, "remote.git"));
  git(root, "remote", "add", "origin", join(root, "remote.git"));
  git(checkout, "push", "origin", "feature/task");
  let branch = "feature/task", busy = false, applied = false;
  const options = { planId: "plan", taskId: "T1", workspaceId: "ws",
    store: {
      get: () => ({ status: "launched", cwd: root, baseSha: base, tasks: [{ id: "T1", launchStatus: "failed", branch }] }),
      recordTaskAssociation: () => { applied = true; },
    },
    cmux: { workspaceList: async () => ({ workspaces: [{ id: "ws", current_directory: checkout }] }),
      workspaceStatus: async () => ({ signals: { any_agent_running: busy, any_agent_needs_input: false } }) },
  };
  const list = options.cmux.workspaceList;
  options.cmux.workspaceList = async () => ({ workspaces: [{ id: "ws", current_directory: checkout }, { id: "other", current_directory: checkout }] });
  await assert.rejects(inspectTaskAssociation(options), /Multiple/);
  options.cmux.workspaceList = list;
  const candidate = await inspectTaskAssociation(options);
  assert.equal(candidate.path, checkout);
  assert.equal(applied, false);
  busy = true;
  await assert.rejects(inspectTaskAssociation(options), /active/);
  busy = false; branch = "feature/wrong";
  await assert.rejects(inspectTaskAssociation(options), /branch/);
  branch = "feature/task";
  writeFileSync(join(checkout, "untracked"), "keep");
  await assert.rejects(inspectTaskAssociation(options), /uncommitted/);
  rmSync(join(checkout, "untracked"));
  git(checkout, "commit", "--allow-empty", "-m", "different work");
  await assert.rejects(inspectTaskAssociation(options), /identity/);
  git(checkout, "commit", "--allow-empty", "-m", "finished again\n\nCmux-Goal-Ready: plan/T1");
  await assert.rejects(inspectTaskAssociation(options), /not pushed/);
  git(checkout, "push", "origin", "feature/task");
  // Stale review must not apply after HEAD changed.
  await assert.rejects(applyTaskAssociation(options, candidate), /changed since review/);
  assert.equal(applied, false);
  await applyTaskAssociation(options, await inspectTaskAssociation(options));
  assert.equal(applied, true);
});

test("recovery refuses tasks, plans and workspaces that are not eligible before touching git", async () => {
  const listed = [];
  const cmux = { workspaceList: async () => { listed.push("list"); return { workspaces: [{ id: "ws", current_directory: null }] }; }, workspaceStatus: async () => ({}) };
  const task = { id: "T1", launchStatus: "failed", branch: "feature/task" };
  const cases = [
    { plan: null, reason: /unassociated failed task/ },
    { plan: { status: "draft", tasks: [task] }, reason: /unassociated failed task/ },
    { plan: { status: "launched", boardStatus: "done", tasks: [task] }, reason: /unassociated failed task/ },
    { plan: { status: "launched", finalPrUrl: "https://example.test/pr/1", tasks: [task] }, reason: /unassociated failed task/ },
    { plan: { status: "launched", tasks: [{ ...task, launchStatus: "launched" }] }, reason: /unassociated failed task/ },
    { plan: { status: "launched", tasks: [{ ...task, workspaceId: "ws" }] }, reason: /unassociated failed task/ },
    { plan: { status: "launched", tasks: [{ ...task, worktreePath: "/tmp/elsewhere" }] }, reason: /unassociated failed task/ },
  ];
  for (const { plan, reason } of cases) {
    await assert.rejects(inspectTaskAssociation({ store: { get: () => plan }, cmux, planId: "plan", taskId: "T1", workspaceId: "ws" }), reason);
  }
  assert.equal(listed.length, 0, "ineligible plans never reach cmux");
  const eligible = { get: () => ({ status: "launched", cwd: "/tmp", tasks: [task] }) };
  await assert.rejects(inspectTaskAssociation({ store: eligible, cmux, planId: "plan", taskId: "T1", workspaceId: "ws" }), /missing or has no checkout/);
  await assert.rejects(inspectTaskAssociation({ store: eligible, cmux, planId: "plan", taskId: "T1", workspaceId: "absent" }), /missing or has no checkout/);
  assert.equal(listed.length, 2);
});

test("recovery rejects a checkout from another repository and a contract-2 task without valid completion evidence", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "task-association-contract-")));
  const previousHome = process.env.CMUX_COMPANION_HOME;
  process.env.CMUX_COMPANION_HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CMUX_COMPANION_HOME;
    else process.env.CMUX_COMPANION_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const repository = join(root, "repo");
  const foreign = join(root, "foreign");
  for (const directory of [repository, foreign]) {
    git(root, "init", "-b", "main", directory);
    git(directory, "config", "user.email", "fixture@example.test");
    git(directory, "config", "user.name", "Fixture");
    git(directory, "commit", "--allow-empty", "-m", "base");
  }
  const base = git(repository, "rev-parse", "HEAD");
  const checkout = join(root, "task");
  git(repository, "worktree", "add", "-b", "feature/task", checkout);
  git(repository, "init", "--bare", join(root, "remote.git"));
  git(repository, "remote", "add", "origin", join(root, "remote.git"));
  git(foreign, "checkout", "-b", "feature/task");
  let report = '{"criteria":["AC-1"],"verification":[{"check":"npm test","status":"passed"}],"limitations":[]}';
  const commitReady = () => {
    git(checkout, "commit", "--allow-empty", "-m", `finished\n\nCmux-Goal-Report: ${report}\nCmux-Goal-Ready: plan/T1`);
    git(checkout, "push", "-f", "origin", "feature/task");
  };
  commitReady();
  const task = { id: "T1", launchStatus: "failed", branch: "feature/task", criterionIds: ["AC-1"], verification: ["npm test"] };
  let directory = foreign;
  const options = { planId: "plan", taskId: "T1", workspaceId: "ws",
    store: { get: () => ({ status: "launched", cwd: repository, baseSha: base, contractVersion: 2, tasks: [task] }), recordTaskAssociation: () => {} },
    cmux: { workspaceList: async () => ({ workspaces: [{ id: "ws", current_directory: directory }] }),
      workspaceStatus: async () => ({ signals: { any_agent_running: false, any_agent_needs_input: false }, effective: "idle" }) },
  };
  await assert.rejects(inspectTaskAssociation(options), /different repository/);
  directory = checkout;
  const verified = await inspectTaskAssociation(options);
  assert.equal(verified.branch, "feature/task");
  report = '{"criteria":["AC-1"],"verification":[{"check":"npm test","status":"failed"}],"limitations":[]}';
  commitReady();
  await assert.rejects(inspectTaskAssociation(options), /must pass/);
  report = "not json";
  commitReady();
  await assert.rejects(inspectTaskAssociation(options), /not valid JSON/);
  git(checkout, "commit", "--allow-empty", "-m", "finished\n\nCmux-Goal-Ready: plan/T1");
  git(checkout, "push", "-f", "origin", "feature/task");
  await assert.rejects(inspectTaskAssociation(options), /no Cmux-Goal-Report trailer/);
});
