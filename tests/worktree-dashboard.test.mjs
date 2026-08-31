import assert from "node:assert/strict";
import test from "node:test";
import { WorktreeDashboard, parseWorktreeList } from "../server/worktree-dashboard.mjs";

const REPO = { id: "repo-1234567890123", name: "sample", root: "karven", path: "/repo/sample", branch: "main" };

test("parses Git's NUL-delimited worktree inventory", () => {
  const output = "worktree /repo/sample\0HEAD aaaaaaaa\0branch refs/heads/main\0\0worktree /repo/sample-feature\0HEAD bbbbbbbb\0branch refs/heads/feature/mobile\0locked testing\0\0";
  assert.deepEqual(parseWorktreeList(output), [
    { path: "/repo/sample", head: "aaaaaaaa", branch: "main", detached: false, locked: null, prunable: null },
    { path: "/repo/sample-feature", head: "bbbbbbbb", branch: "feature/mobile", detached: false, locked: "testing", prunable: null },
  ]);
});

test("groups cmux sessions by registered worktree and exposes delivery state", async () => {
  const git = async (cwd, args) => {
    if (args[0] === "worktree") return "worktree /repo/sample\0HEAD aaaaaaaa\0branch refs/heads/main\0\0worktree /repo/sample-feature\0HEAD bbbbbbbb\0branch refs/heads/feature/mobile\0\0";
    if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return "/repo/sample/.git\n";
    if (args[0] === "rev-parse") return `${cwd}\n`;
    if (args[0] === "status") return cwd.endsWith("feature") ? "# branch.head feature/mobile\n# branch.ab +2 -0\n1 .M N... file.ts\n" : "# branch.head main\n# branch.ab +0 -0\n";
    if (args[0] === "log") return cwd.endsWith("feature") ? "200\n" : "100\n";
    throw new Error("unexpected git call");
  };
  const repoCatalog = {
    list: async () => [REPO],
    git,
    execute: async () => ({ stdout: JSON.stringify([{ number: 7, title: "Feature", url: "https://github.test/pr/7", state: "OPEN", headRefName: "feature/mobile", baseRefName: "main", statusCheckRollup: [] }]) }),
  };
  const dashboard = new WorktreeDashboard({ repoCatalog, cacheMs: 0, canonicalize: async (path) => path });
  const value = await dashboard.snapshot({ workspaces: [{
    id: "11111111-2222-4333-8444-555555555555", title: "mobile agent", current_directory: "/repo/sample-feature/app", preview: "Editing app/page.tsx", last_activity_at: 300,
    status: { effective: "working", signals: { any_agent_running: true } }, terminals: [{ id: "terminal", title: "xcodex" }],
  }] });
  assert.equal(value.summary.repositories, 1);
  assert.equal(value.summary.worktrees, 2);
  assert.equal(value.summary.working, 1);
  const feature = value.repositories[0].worktrees.find((item) => item.branch === "feature/mobile");
  assert.equal(feature.sessions[0].provider, "Codex");
  assert.equal(feature.state.tone, "working");
  assert.equal(feature.changedFiles, 1);
  assert.equal(feature.ahead, 2);
  assert.equal(feature.pullRequest.number, 7);
  assert.match(feature.id, /^[A-Za-z0-9_-]{18}$/);
  assert.equal((await dashboard.resolve(feature.id)).path, "/repo/sample-feature");
});

test("refreshes the registered inventory before resolving a launch target", async () => {
  let present = true;
  const repoCatalog = {
    list: async () => present ? [REPO] : [],
    git: async (cwd, args) => {
      if (args[0] === "worktree") return `worktree ${cwd}\0HEAD aaaaaaaa\0branch refs/heads/main\0\0`;
      if (args[1] === "--git-common-dir") return `${cwd}/.git\n`;
      if (args[1] === "--show-toplevel") return `${cwd}\n`;
      if (args[0] === "status") return "# branch.head main\n";
      if (args[0] === "log") return "100\n";
      throw new Error("unexpected git call");
    },
    execute: async () => ({ stdout: "[]" }),
  };
  const dashboard = new WorktreeDashboard({ repoCatalog, cacheMs: 60_000, canonicalize: async (path) => path });
  const first = await dashboard.snapshot();
  const id = first.repositories[0].worktrees[0].id;
  present = false;
  await assert.rejects(() => dashboard.resolve(id), /Unknown worktree/);
});

test("coalesces catalog entries that belong to one linked-worktree repository", async () => {
  const linked = { ...REPO, id: "linked-repo-id", name: "sample-feature", path: "/repo/sample-feature", branch: "feature/mobile" };
  const inventory = "worktree /repo/sample\0HEAD aaaaaaaa\0branch refs/heads/main\0\0worktree /repo/sample-feature\0HEAD bbbbbbbb\0branch refs/heads/feature/mobile\0\0";
  const repoCatalog = {
    list: async () => [REPO, linked],
    git: async (cwd, args) => {
      if (args[0] === "worktree") return inventory;
      if (args[1] === "--git-common-dir") return "/repo/sample/.git\n";
      if (args[1] === "--show-toplevel") return `${cwd}\n`;
      if (args[0] === "status") return `# branch.head ${cwd.endsWith("feature") ? "feature/mobile" : "main"}\n`;
      if (args[0] === "log") return "100\n";
      throw new Error("unexpected git call");
    },
    execute: async () => ({ stdout: "[]" }),
  };
  const dashboard = new WorktreeDashboard({ repoCatalog, cacheMs: 0, canonicalize: async (path) => path });
  const value = await dashboard.snapshot();
  assert.equal(value.repositories.length, 1);
  assert.equal(value.repositories[0].name, "sample");
  assert.equal(value.repositories[0].worktrees.length, 2);
  assert.equal(value.repositories[0].worktrees.filter((item) => item.isPrimary).length, 1);
});

test("removes only clean, idle, non-primary worktrees while preserving their branch", async () => {
  const calls = [];
  let lateChange = false;
  const inventory = "worktree /repo/sample\0HEAD aaaaaaaa\0branch refs/heads/main\0\0worktree /repo/sample-feature\0HEAD bbbbbbbb\0branch refs/heads/feature/mobile\0\0";
  const repoCatalog = {
    cache: null,
    list: async () => [{ id: "repo-safe", name: "sample", root: "repo", path: "/repo/sample", branch: "main" }],
    git: async (cwd, args) => {
      calls.push([cwd, ...args]);
      if (args[0] === "worktree" && args[1] === "list") return inventory;
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return "/repo/sample/.git\n";
      if (args[0] === "rev-parse") return `${cwd}\n`;
      if (args[0] === "status") return `${`# branch.head ${cwd.endsWith("feature") ? "feature/mobile" : "main"}\n`}${lateChange && args.includes("--untracked-files=all") ? "? new-file.ts\n" : ""}`;
      if (args[0] === "log") return "1\n";
      return "";
    },
    execute: async () => { throw new Error("gh unavailable"); },
  };
  const dashboard = new WorktreeDashboard({ repoCatalog, cacheMs: 0, canonicalize: async (path) => path });
  const snapshot = await dashboard.snapshot({ workspaces: [] });
  const primary = snapshot.repositories[0].worktrees.find((item) => item.isPrimary);
  const feature = snapshot.repositories[0].worktrees.find((item) => !item.isPrimary);
  await assert.rejects(() => dashboard.remove(primary.id), /primary worktree/);
  lateChange = true;
  await assert.rejects(() => dashboard.remove(feature.id), /worktree changed/);
  lateChange = false;
  const result = await dashboard.remove(feature.id);
  assert.equal(result.branchPreserved, true);
  assert.deepEqual(calls.at(-1), ["/repo/sample", "worktree", "remove", "--force", "/repo/sample-feature"]);
});
