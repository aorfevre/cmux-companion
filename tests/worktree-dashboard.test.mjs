import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RepositoryArchive } from "../server/repository-archive.mjs";
import { WorktreeDashboard, countUpdaterArtifacts, parseWorktreeList, worktreePath } from "../server/worktree-dashboard.mjs";

const REPO = { id: "repo-1234567890123", name: "sample", root: "karven", path: "/repo/sample", branch: "main" };

test("persists archived repository ids across instances", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-companion-archive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "archive.json");
  const id = "repository12345678";
  const archive = new RepositoryArchive({ path });
  assert.equal(archive.set(id, true), true);
  assert.equal(new RepositoryArchive({ path }).has(id), true);
  assert.equal(archive.set(id, false), false);
  assert.equal(new RepositoryArchive({ path }).has(id), false);
});

test("parses Git's NUL-delimited worktree inventory", () => {
  const output = "worktree /repo/sample\0HEAD aaaaaaaa\0branch refs/heads/main\0\0worktree /repo/sample-feature\0HEAD bbbbbbbb\0branch refs/heads/feature/mobile\0locked testing\0\0";
  assert.deepEqual(parseWorktreeList(output), [
    { path: "/repo/sample", head: "aaaaaaaa", branch: "main", detached: false, locked: null, prunable: null },
    { path: "/repo/sample-feature", head: "bbbbbbbb", branch: "feature/mobile", detached: false, locked: "testing", prunable: null },
  ]);
});

test("groups cmux sessions by registered worktree and exposes delivery state", async () => {
  const archived = new Set();
  const repositoryArchive = { has: (id) => archived.has(id), set: (id, value) => { if (value) archived.add(id); else archived.delete(id); return value; } };
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
  const dashboard = new WorktreeDashboard({ repoCatalog, cacheMs: 0, canonicalize: async (path) => path, repositoryArchive });
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
  const repositoryId = value.repositories[0].id;
  assert.equal(value.repositories[0].archived, false);
  assert.equal((await dashboard.setRepositoryArchived(repositoryId, true)).repository.archived, true);
  assert.equal((await dashboard.snapshot()).repositories[0].archived, true);
  assert.equal((await dashboard.setRepositoryArchived(repositoryId, false)).repository.archived, false);
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

test("creates a sibling worktree from a validated branch and base revision", async () => {
  const calls = [];
  const targetPath = "/repo/sample-feature-safe-name";
  let inventory = "worktree /repo/sample\0HEAD aaaaaaaa\0branch refs/heads/main\0\0";
  const repoCatalog = {
    cache: {},
    list: async () => [REPO],
    git: async (cwd, args, options) => {
      calls.push([cwd, args, options]);
      if (args[0] === "worktree" && args[1] === "add") {
        inventory += `worktree ${targetPath}\0HEAD bbbbbbbb\0branch refs/heads/feature/safe-name\0\0`;
        return "";
      }
      if (args[0] === "worktree") return inventory;
      if (args[0] === "check-ref-format") return "feature/safe-name\n";
      if (args[0] === "show-ref") throw new Error("missing branch");
      if (args[0] === "rev-parse" && args[1] === "--verify") return "aaaaaaaa\n";
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return "/repo/sample/.git\n";
      if (args[0] === "rev-parse") return `${cwd}\n`;
      if (args[0] === "status") return `# branch.head ${cwd === targetPath ? "feature/safe-name" : "main"}\n`;
      if (args[0] === "log") return "100\n";
      throw new Error("unexpected git call");
    },
    execute: async () => ({ stdout: "[]" }),
  };
  const dashboard = new WorktreeDashboard({ repoCatalog, cacheMs: 0, canonicalize: async (path) => path });
  const repositoryId = (await dashboard.snapshot()).repositories[0].id;
  const result = await dashboard.create(repositoryId, { branch: "feature/safe-name", base: "main" });
  assert.equal(result.branchCreated, true);
  assert.equal(result.worktree.path, targetPath);
  assert.equal(result.worktree.branch, "feature/safe-name");
  assert.equal(repoCatalog.cache, null);
  const add = calls.find(([, args]) => args[0] === "worktree" && args[1] === "add");
  assert.deepEqual(add, ["/repo/sample", ["worktree", "add", "-b", "feature/safe-name", targetPath, "main"], { timeout: 120_000 }]);
  assert.equal(worktreePath("/repo/sample", "feature/safe-name"), targetPath);
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
  let removalError = false;
  let removalOptions = null;
  const inventory = "worktree /repo/sample\0HEAD aaaaaaaa\0branch refs/heads/main\0\0worktree /repo/sample-feature\0HEAD bbbbbbbb\0branch refs/heads/feature/mobile\0\0";
  const repoCatalog = {
    cache: null,
    list: async () => [{ id: "repo-safe", name: "sample", root: "repo", path: "/repo/sample", branch: "main" }],
    git: async (cwd, args, options) => {
      calls.push([cwd, ...args]);
      if (args[0] === "worktree" && args[1] === "remove") removalOptions = options;
      if (args[0] === "worktree" && args[1] === "remove" && removalError) throw Object.assign(new Error("git failed"), { stderr: "warning: cleanup\nfatal: worktree metadata is locked\n" });
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
  removalError = true;
  await assert.rejects(() => dashboard.remove(feature.id), /Git could not remove this worktree: fatal: worktree metadata is locked/);
  removalError = false;
  const result = await dashboard.remove(feature.id);
  assert.equal(result.branchPreserved, true);
  assert.deepEqual(calls.at(-1), ["/repo/sample", "worktree", "remove", "--force", "/repo/sample-feature"]);
  assert.deepEqual(removalOptions, { timeout: 120_000 });
});

// A release checkout under ~/.local/share/cmux-companion/releases/<sha> is
// detached, and the updater drops release-manifest.json into it after checkout.
// Git reports that as untracked, so the card read "1 changed" forever.
function releaseRepoCatalog({ status, sessions = [], locked = false } = {}) {
  const calls = [];
  const lockField = locked ? "locked release pinned\0" : "";
  const inventory = `worktree /repo/sample\0HEAD aaaaaaaa\0branch refs/heads/main\0\0worktree /releases/abc\0HEAD bbbbbbbb\0detached\0${lockField}\0`;
  const repoCatalog = {
    cache: {},
    calls,
    list: async () => [{ id: "repo-safe", name: "sample", root: "repo", path: "/repo/sample", branch: "main" }],
    git: async (cwd, args) => {
      calls.push([cwd, ...args]);
      if (args[0] === "worktree" && args[1] === "list") return inventory;
      if (args[0] === "worktree" && args[1] === "remove") return "";
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return "/repo/sample/.git\n";
      if (args[0] === "rev-parse") return `${cwd}\n`;
      if (args[0] === "status") return cwd === "/releases/abc" ? status : "# branch.head main\n";
      if (args[0] === "log") return "1\n";
      return "";
    },
    execute: async () => { throw new Error("gh unavailable"); },
  };
  return { repoCatalog, sessions };
}

test("ignores the updater's own artifacts when counting changes in a detached release checkout", async () => {
  assert.equal(countUpdaterArtifacts("# branch.head (detached)\n? release-manifest.json\n? notes.md\n"), 1);
  assert.equal(countUpdaterArtifacts("1 .M N... release-manifest.json\n"), 0);
  const { repoCatalog } = releaseRepoCatalog({ status: "# branch.head (detached)\n? release-manifest.json\n" });
  const dashboard = new WorktreeDashboard({ repoCatalog, cacheMs: 0, canonicalize: async (path) => path });
  const release = (await dashboard.snapshot()).repositories[0].worktrees.find((item) => !item.isPrimary);
  assert.equal(release.detached, true);
  assert.equal(release.updaterArtifacts, 1);
  assert.equal(release.changedFiles, 0);
  assert.equal(release.dirty, false);
  const result = await dashboard.remove(release.id);
  assert.equal(result.removed, true);
  assert.equal(result.branchPreserved, true);
  assert.equal(result.discardedChanges, false);
});

test("removes a dirty detached worktree only when the client asks to discard its changes", async () => {
  const status = "# branch.head (detached)\n? release-manifest.json\n1 .M N... server/index.mjs\n";
  const { repoCatalog } = releaseRepoCatalog({ status });
  const dashboard = new WorktreeDashboard({ repoCatalog, cacheMs: 0, canonicalize: async (path) => path });
  const release = (await dashboard.snapshot()).repositories[0].worktrees.find((item) => !item.isPrimary);
  assert.equal(release.changedFiles, 1);
  assert.equal(release.dirty, true);
  await assert.rejects(() => dashboard.remove(release.id), /Commit or stash/);
  const result = await dashboard.remove(release.id, { discardChanges: true });
  assert.equal(result.discardedChanges, true);
  assert.deepEqual(repoCatalog.calls.at(-1), ["/repo/sample", "worktree", "remove", "--force", "/releases/abc"]);
});

test("refuses a discard removal for a dirty worktree that still has a branch", async () => {
  const inventory = "worktree /repo/sample\0HEAD aaaaaaaa\0branch refs/heads/main\0\0worktree /repo/sample-feature\0HEAD bbbbbbbb\0branch refs/heads/feature/mobile\0\0";
  const repoCatalog = {
    cache: {},
    list: async () => [{ id: "repo-safe", name: "sample", root: "repo", path: "/repo/sample", branch: "main" }],
    git: async (cwd, args) => {
      if (args[0] === "worktree" && args[1] === "list") return inventory;
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return "/repo/sample/.git\n";
      if (args[0] === "rev-parse") return `${cwd}\n`;
      if (args[0] === "status") return cwd.endsWith("feature") ? "# branch.head feature/mobile\n1 .M N... file.ts\n" : "# branch.head main\n";
      if (args[0] === "log") return "1\n";
      return "";
    },
    execute: async () => { throw new Error("gh unavailable"); },
  };
  const dashboard = new WorktreeDashboard({ repoCatalog, cacheMs: 0, canonicalize: async (path) => path });
  const feature = (await dashboard.snapshot()).repositories[0].worktrees.find((item) => !item.isPrimary);
  await assert.rejects(() => dashboard.remove(feature.id, { discardChanges: true }), /Only a detached worktree/);
});

test("never removes the primary worktree, a locked worktree, or one with an active session", async () => {
  const clean = "# branch.head (detached)\n? release-manifest.json\n";
  const locked = releaseRepoCatalog({ status: clean, locked: true });
  const lockedDashboard = new WorktreeDashboard({ repoCatalog: locked.repoCatalog, cacheMs: 0, canonicalize: async (path) => path });
  const lockedSnapshot = await lockedDashboard.snapshot();
  const primary = lockedSnapshot.repositories[0].worktrees.find((item) => item.isPrimary);
  const lockedRelease = lockedSnapshot.repositories[0].worktrees.find((item) => !item.isPrimary);
  await assert.rejects(() => lockedDashboard.remove(primary.id), /primary worktree cannot be removed/);
  await assert.rejects(() => lockedDashboard.remove(primary.id, { discardChanges: true }), /primary worktree cannot be removed/);
  await assert.rejects(() => lockedDashboard.remove(lockedRelease.id), /Unlock this Git worktree/);
  await assert.rejects(() => lockedDashboard.remove(lockedRelease.id, { discardChanges: true }), /Unlock this Git worktree/);

  const busy = releaseRepoCatalog({ status: clean });
  const busyDashboard = new WorktreeDashboard({ repoCatalog: busy.repoCatalog, cacheMs: 0, canonicalize: async (path) => path });
  const workspaces = [{ id: "11111111-2222-4333-8444-555555555555", title: "release agent", current_directory: "/releases/abc", last_activity_at: 5, terminals: [] }];
  const release = (await busyDashboard.snapshot({ workspaces })).repositories[0].worktrees.find((item) => !item.isPrimary);
  await assert.rejects(() => busyDashboard.remove(release.id, { workspaces }), /sessions before removing it/);
  await assert.rejects(() => busyDashboard.remove(release.id, { workspaces, discardChanges: true }), /sessions before removing it/);
});

test("bulk removal keeps only clean, unlocked, idle, non-primary worktrees and tolerates a per-worktree failure", async () => {
  const removed = [];
  const inventory = [
    "worktree /repo/sample\0HEAD a1\0branch refs/heads/main\0\0",
    "worktree /repo/sample-clean\0HEAD b1\0branch refs/heads/chore/clean\0\0",
    "worktree /repo/sample-stubborn\0HEAD c1\0branch refs/heads/chore/stubborn\0\0",
    "worktree /repo/sample-dirty\0HEAD d1\0branch refs/heads/feature/dirty\0\0",
    "worktree /repo/sample-locked\0HEAD e1\0branch refs/heads/chore/locked\0locked pinned\0\0",
    "worktree /repo/sample-busy\0HEAD f1\0branch refs/heads/chore/busy\0\0",
  ].join("");
  const branches = {
    "/repo/sample": "main",
    "/repo/sample-clean": "chore/clean",
    "/repo/sample-stubborn": "chore/stubborn",
    "/repo/sample-dirty": "feature/dirty",
    "/repo/sample-locked": "chore/locked",
    "/repo/sample-busy": "chore/busy",
  };
  const repoCatalog = {
    cache: {},
    list: async () => [{ id: "repo-safe", name: "sample", root: "repo", path: "/repo/sample", branch: "main" }],
    git: async (cwd, args) => {
      if (args[0] === "worktree" && args[1] === "list") return inventory;
      if (args[0] === "worktree" && args[1] === "remove") {
        if (args[3] === "/repo/sample-stubborn") throw Object.assign(new Error("git failed"), { stderr: "fatal: worktree is dirty\n" });
        removed.push(args[3]);
        return "";
      }
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return "/repo/sample/.git\n";
      if (args[0] === "rev-parse") return `${cwd}\n`;
      if (args[0] === "status") return `# branch.head ${branches[cwd]}\n${cwd === "/repo/sample-dirty" ? "1 .M N... file.ts\n" : ""}`;
      if (args[0] === "log") return "1\n";
      return "";
    },
    execute: async () => { throw new Error("gh unavailable"); },
  };
  const dashboard = new WorktreeDashboard({ repoCatalog, cacheMs: 0, canonicalize: async (path) => path });
  const workspaces = [{ id: "11111111-2222-4333-8444-555555555555", title: "busy agent", current_directory: "/repo/sample-busy", last_activity_at: 5, terminals: [] }];
  const repositoryId = (await dashboard.snapshot({ workspaces })).repositories[0].id;
  const result = await dashboard.removeCleanWorktrees(repositoryId, { workspaces });
  assert.equal(result.requested, 2);
  assert.equal(result.removed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.branchPreserved, true);
  assert.deepEqual(removed, ["/repo/sample-clean"]);
  assert.deepEqual(result.results.map((entry) => entry.branch).sort(), ["chore/clean", "chore/stubborn"]);
  const failure = result.results.find((entry) => !entry.removed);
  assert.equal(failure.branch, "chore/stubborn");
  assert.match(failure.error, /Git could not remove this worktree: fatal: worktree is dirty/);
  assert.equal(repoCatalog.cache, null);
  await assert.rejects(() => dashboard.removeCleanWorktrees("not-a-valid-id"), /Invalid repository/);
});
