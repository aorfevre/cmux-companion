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
