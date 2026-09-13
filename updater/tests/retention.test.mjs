import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/process.mjs";
import { addWorktree } from "../src/git.mjs";
import { recordRelease, retainedReleases, retention } from "../src/retention.mjs";
import { acquireLock } from "../src/lock.mjs";

const activity = async () => ({ available: true, paths: [] });
async function fixture(t) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "updater-retention-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repo = join(temp, "repo"); const root = join(temp, "store");
  await mkdir(join(root, "releases"), { recursive: true });
  const paths = { stateRoot: join(temp, "state"), lock: join(temp, "state", "lock"), transaction: join(temp, "state", "transaction.json") };
  await mkdir(paths.stateRoot);
  const git = async (args, cwd = repo) => (await run("git", ["-C", cwd, ...args])).stdout.trim();
  await run("git", ["init", "-b", "main", repo]);
  await git(["config", "user.email", "test@example.test"]); await git(["config", "user.name", "Retention test"]);
  await writeFile(join(repo, ".gitignore"), "node_modules/\ndist/\n.env\n");
  const target = { name: "companion", repositoryPath: repo, releaseRoot: root, entryPoints: [] };
  const config = { targets: [target] };
  const create = async (name, outcome = "success") => {
    await writeFile(join(repo, "file"), name); await git(["add", "."]); await git(["commit", "-m", name]);
    const sha = await git(["rev-parse", "HEAD"]); const path = join(root, "releases", sha);
    await addWorktree(target, path, sha);
    await writeFile(join(path, "release-manifest.json"), JSON.stringify({ schemaVersion: 1, target: target.name, gitSha: sha, entryPoints: [] }));
    if (outcome) { if (outcome === "failed") await recordRelease(paths, target, sha, "staging"); await recordRelease(paths, target, sha, outcome); }
    return { sha, path };
  };
  const releases = [];
  for (let i = 0; i < 6; i++) releases.push(await create(`release-${i}`));
  await symlink(`releases/${releases[5].sha}`, join(root, "current"));
  await symlink(`releases/${releases[4].sha}`, join(root, "previous"));
  const call = (options = {}) => retention(paths, config, { activity, ...options });
  return { temp, paths, repo, root, target, config, releases, create, call, git };
}

test("retention preserves current, rollback, two additional successes, latest failure and pending engine", () => {
  const records = [0, 1, 2, 3, 4, 5].map((i) => ({ sha: String(i), at: new Date(i * 1000).toISOString(), outcome: "success" }));
  records.push({ sha: "f1", outcome: "failed", at: "2026-01-01" }, { sha: "f2", outcome: "failed", at: "2026-01-02" });
  const keep = retainedReleases(records, { current: "5", previous: "4", pending: "pending", running: "engine" });
  assert.deepEqual([...keep.keys()].sort(), ["2", "3", "4", "5", "engine", "f2", "pending"]);
});

test("disabled scheduling is inert; reviewed retention unlocks only owned releases and removes build artifacts", async (t) => {
  const f = await fixture(t);
  const old = f.releases[0];
  await mkdir(join(old.path, "node_modules")); await writeFile(join(old.path, "node_modules", "build"), "artifact");
  await writeFile(join(f.repo, ".git", "info", "exclude"), ".wrangler/\n");
  await mkdir(join(old.path, ".wrangler", "deploy"), { recursive: true });
  await writeFile(join(old.path, ".wrangler", "deploy", "config.json"), "{}");
  assert.equal((await f.call({ command: "status" })).policy.enabled, false);
  assert.equal((await f.call({ command: "scheduled" })).disabledOrNotDue, true);
  const preview = await f.call();
  assert.deepEqual(preview.entries.filter((entry) => entry.eligible).map((entry) => entry.sha).sort(), f.releases.slice(0, 2).map((entry) => entry.sha).sort());
  const result = await f.call({ command: "run", previewId: preview.previewId, ids: [old.path] });
  assert.equal(result.results[0].outcome, "removed");
  await assert.rejects(readFile(join(old.path, "node_modules", "build")), { code: "ENOENT" });
  assert.equal(await f.git(["branch", "--show-current"]), "main");
  assert.equal((await f.call({ command: "status" })).history.length, 1);
  await assert.rejects(f.call({ command: "run", previewId: preview.previewId, ids: [old.path] }), /fresh retention preview/);
});

test("foreign locks, unknown legacy outcomes, active processes and dirty releases stay protected", async (t) => {
  const f = await fixture(t);
  const [foreign, dirty] = f.releases;
  await f.git(["worktree", "unlock", foreign.path]); await f.git(["worktree", "lock", "--reason", "Claude agent", foreign.path]);
  await writeFile(join(dirty.path, "notes"), "keep");
  const legacy = await f.create("legacy", null);
  let preview = await f.call();
  assert.match(preview.entries.find((row) => row.path === foreign.path).reasons.join(), /foreign lock/);
  assert.match(preview.entries.find((row) => row.path === dirty.path).reasons.join(), /untracked/);
  assert.match(preview.entries.find((row) => row.path === legacy.path).reasons.join(), /No verified deployment outcome/);
  preview = await f.call({ activity: async () => ({ available: false, paths: [] }) });
  assert.equal(preview.entries.some((row) => row.eligible), false);
});

test("revalidate changed files and links; overlapping updater operations refuse cleanup", async (t) => {
  const f = await fixture(t); const old = f.releases[0];
  let preview = await f.call();
  await writeFile(join(old.path, "file"), "changed after preview");
  const result = await f.call({ command: "run", previewId: preview.previewId, ids: [old.path] });
  assert.equal(result.results[0].outcome, "failed");
  assert.match(await f.git(["worktree", "list", "--porcelain"]), /cmux-companion managed deployment/);
  const release = await acquireLock(f.paths.lock);
  await assert.rejects(f.call(), /Updater transaction is running/);
  await release();
  await rm(join(f.root, "current")); await symlink(f.repo, join(f.root, "current"));
  preview = await f.call();
  assert.equal(preview.entries.length, 0);
  assert.match(preview.errors[0].error, /Invalid current release link/);
});

test("latest failed release is retained and older verified failure can be collected", async (t) => {
  const f = await fixture(t);
  const older = await f.create("failed-old", "failed"); const latest = await f.create("failed-latest", "failed");
  const preview = await f.call();
  assert.equal(preview.entries.find((row) => row.path === older.path).eligible, true);
  assert.match(preview.entries.find((row) => row.path === latest.path).reasons.join(), /Latest failed/);
});
