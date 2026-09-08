import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import * as catalogExports from "../server/repo-catalog.mjs";
import { normalizePullRequest, parseGitHubRepository, parseNameStatus, RepoCatalog } from "../server/repo-catalog.mjs";
import { RepoIdentityStore } from "../server/repo-identity-store.mjs";

const exec = promisify(execFile);

async function git(cwd, ...args) {
  return exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cmux-repos-"));
  const repo = join(root, "sample");
  await mkdir(repo);
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "config", "user.name", "Companion Test");
  await writeFile(join(repo, "tracked.txt"), "before\n");
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test", "safe:dev": "vite" } }));
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "initial");
  t.after(() => exec("rm", ["-rf", root]));
  return { root, repo, catalog: new RepoCatalog({ roots: [root], cacheMs: 0 }) };
}

test("discovers approved repositories and reports live Git changes", async (t) => {
  const { repo, catalog } = await fixture(t);
  await writeFile(join(repo, "tracked.txt"), "after\n");
  await writeFile(join(repo, "staged.txt"), "staged\n");
  await writeFile(join(repo, "untracked.txt"), "new\n");
  await git(repo, "add", "staged.txt");

  const [record] = await catalog.list();
  assert.equal(record.name, "sample");
  assert.equal(record.dirty, true);
  assert.equal(record.githubRepository, null);
  assert.deepEqual(record.scripts, ["test", "safe:dev"]);

  const changes = await catalog.changes(record.id);
  assert.deepEqual(changes.files.map((file) => [file.path, file.area]), [
    ["staged.txt", "staged"], ["tracked.txt", "unstaged"], ["untracked.txt", "untracked"],
  ]);
  assert.match((await catalog.diff(record.id, "tracked.txt")).patch, /-before[\s\S]*\+after/);
  assert.match((await catalog.diff(record.id, "untracked.txt")).patch, /\+new/);
});

test("rejects unknown repositories and hides untracked symlink contents", async (t) => {
  const { root, repo, catalog } = await fixture(t);
  const secret = join(root, "secret.txt");
  await writeFile(secret, "do not expose\n");
  await symlink(secret, join(repo, "outside-link"));
  const [record] = await catalog.list();
  await assert.rejects(() => catalog.get("not-a-repo"), /Unknown repository/);
  const result = await catalog.diff(record.id, "outside-link");
  assert.equal(result.patch, "Untracked symbolic link (content hidden)");
});

test("reads safe Markdown and image assets without escaping the repository", async (t) => {
  const { root, repo, catalog } = await fixture(t);
  await mkdir(join(repo, "docs"));
  await writeFile(join(repo, "docs", "guide.md"), "# Guide\n\n![Flow](flow.png)\n");
  await writeFile(join(repo, "docs", "flow.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const secret = join(root, "secret.md");
  await writeFile(secret, "private\n");
  await symlink(secret, join(repo, "docs", "outside.md"));
  const [record] = await catalog.list();
  const markdown = await catalog.markdown(record.id, "docs/guide.md");
  assert.equal(markdown.path, "docs/guide.md");
  assert.match(markdown.content, /# Guide/);
  const image = await catalog.asset(record.id, "docs/flow.png");
  assert.equal(image.mime, "image/png");
  await writeFile(join(repo, "docs", "fake.png"), "not an image");
  await assert.rejects(() => catalog.asset(record.id, "docs/fake.png"), /does not match/);
  await assert.rejects(() => catalog.markdown(record.id, "docs/outside.md"), /outside the approved roots/);
  await assert.rejects(() => catalog.markdown(record.id, "../secret.md"), /outside the approved roots/);
  await assert.rejects(() => catalog.markdown(record.id, "package.json"), /not supported/);
});

test("parses NUL-delimited rename status", () => {
  assert.deepEqual(parseNameStatus("R100\0old.txt\0new.txt\0M\0same.txt\0", "staged"), [
    { path: "new.txt", status: "R", area: "staged" },
    { path: "same.txt", status: "M", area: "staged" },
  ]);
});

test("recognizes HTTPS and SSH GitHub remotes without accepting other hosts", () => {
  assert.equal(parseGitHubRepository("remote.origin.url https://github.com/karven/companion.git\n"), "karven/companion");
  assert.equal(parseGitHubRepository("remote.origin.url git@github.com:karven/companion.git\n"), "karven/companion");
  assert.equal(parseGitHubRepository("remote.origin.url ssh://git@github.com/karven/companion\n"), "karven/companion");
  assert.equal(parseGitHubRepository("remote.origin.url https://gitlab.com/karven/companion.git\n"), null);
});

test("normalizes open pull request review and check state", () => {
  const pullRequest = normalizePullRequest({
    number: 42,
    title: "Improve mobile workflow",
    url: "https://github.com/example/repo/pull/42",
    state: "OPEN",
    reviewDecision: "APPROVED",
    mergeStateStatus: "UNSTABLE",
    headRefName: "feature/mobile",
    baseRefName: "main",
    author: { login: "agent" },
    statusCheckRollup: [
      { conclusion: "SUCCESS" },
      { conclusion: "FAILURE" },
      { status: "IN_PROGRESS" },
    ],
  });
  assert.equal(pullRequest.number, 42);
  assert.equal(pullRequest.reviewDecision, "APPROVED");
  assert.deepEqual(pullRequest.checks, { passed: 1, failed: 1, pending: 1, total: 3 });
});

// The dashboard groups aliases of one repository by its common Git directory.
// It used to spawn a process per candidate to learn it, while the catalog was
// already one rev-parse away from the same answer.
test("reports each repository's common Git directory without a second process", async (t) => {
  const { catalog } = await fixture(t);
  const spawned = [];
  const run = catalog.git.bind(catalog);
  catalog.git = async (cwd, args, options) => { spawned.push(args.slice(0, 2).join(" ")); return run(cwd, args, options); };

  const [record] = await catalog.list();
  // Compared against the record's own canonical path: on macOS the temporary
  // directory is reached through a symlink, and the record is canonicalized.
  assert.equal(record.commonDir, join(record.path, ".git"));
  assert.equal(record.path.endsWith("/sample"), true);
  assert.equal(spawned.filter((call) => call === "rev-parse --git-common-dir").length, 0,
    "the common directory must come from the call that already runs, not a second one");
});

test("a linked worktree reports the shared common directory of its repository", async (t) => {
  const { root, repo, catalog } = await fixture(t);
  const linked = join(root, "sample-feature");
  await git(repo, "worktree", "add", "-q", "-b", "feature", linked);

  const records = await catalog.list();
  const primary = records.find((item) => item.name === "sample");
  const worktree = records.find((item) => item.name === "sample-feature");
  // Both are separate checkouts, and both must resolve to one shared Git
  // directory. That is exactly what lets the dashboard collapse the alias.
  assert.equal(worktree.commonDir, primary.commonDir);
});

// `git status --porcelain=v2 --branch` already prints the commit this checkout
// points at. A commit's time is part of what its sha hashes, so storing that
// pair removes a whole `git log` process per repository and cannot go stale.
test("a repository whose commit is already known runs no git log", async (t) => {
  const { catalog } = await fixture(t);
  catalog.identityStore = new RepoIdentityStore({ path: ":memory:" });
  t.after(() => catalog.identityStore.close());
  const spawned = [];
  const run = catalog.git.bind(catalog);
  catalog.git = async (cwd, args, options) => { spawned.push(args.slice(0, 2).join(" ")); return run(cwd, args, options); };

  await catalog.list({ refresh: true });
  assert.equal(spawned.filter((call) => call === "log -1").length, 1, "the first scan has to read it once");

  spawned.length = 0;
  await catalog.list({ refresh: true });
  assert.equal(spawned.filter((call) => call === "log -1").length, 0, "the second scan must read the stored answer");
});

// The bound on how stale a card can be. A repository's status and its activity
// time are read together and served together, so both lag by at most the status
// window and never by more. Beyond it, a new commit must be visible.
test("a new commit is reported once the status window has passed", async (t) => {
  const { repo, catalog } = await fixture(t);
  let clock = 1_000_000;
  catalog.identityStore = new RepoIdentityStore({ path: ":memory:", statusTtlMs: 30_000, now: () => clock });
  t.after(() => catalog.identityStore.close());

  const [before] = await catalog.list({ refresh: true });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await git(repo, "commit", "-qm", "second", "--allow-empty");

  // Inside the window the card deliberately shows the moment it last read.
  const [during] = await catalog.list({ refresh: true });
  assert.equal(during.lastActivity, before.lastActivity, "inside the window a card shows one consistent moment");

  clock += 30_001;
  const [after] = await catalog.list({ refresh: true });
  assert.ok(after.lastActivity > before.lastActivity, `${after.lastActivity} must be later than ${before.lastActivity}`);
});

// The same guarantee for the half a person acts on. A card may say "Clean" for
// up to the window, but it must never say so afterwards.
test("a file written into a clean worktree is reported once the window has passed", async (t) => {
  const { repo, catalog } = await fixture(t);
  let clock = 1_000_000;
  catalog.identityStore = new RepoIdentityStore({ path: ":memory:", statusTtlMs: 30_000, now: () => clock });
  t.after(() => catalog.identityStore.close());

  const [before] = await catalog.list({ refresh: true });
  assert.equal(before.dirty, false, "the fixture starts clean");

  await writeFile(join(repo, "tracked.txt"), "changed by an agent\n");
  const [during] = await catalog.list({ refresh: true });
  assert.equal(during.dirty, false, "inside the window the card is deliberately behind");

  clock += 30_001;
  const [after] = await catalog.list({ refresh: true });
  assert.equal(after.dirty, true, "past the window the card must tell the truth");
});

// A cache that never expires is the failure this whole design guards against.
test("a store with no window configured always reads git", async (t) => {
  const { repo, catalog } = await fixture(t);
  catalog.identityStore = new RepoIdentityStore({ path: ":memory:", statusTtlMs: 0 });
  t.after(() => catalog.identityStore.close());

  const [before] = await catalog.list({ refresh: true });
  assert.equal(before.dirty, false);
  await writeFile(join(repo, "tracked.txt"), "changed by an agent\n");
  const [after] = await catalog.list({ refresh: true });
  assert.equal(after.dirty, true);
});

test("a repository with no commit yet still reports an activity of zero", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmux-repos-unborn-"));
  t.after(() => exec("rm", ["-rf", root]));
  const repo = join(root, "fresh");
  await mkdir(repo);
  await git(repo, "init", "-q");
  // An unborn branch has no sha at all: git prints "# branch.oid (initial)".
  // The store must refuse that rather than key anything on it.
  const catalog = new RepoCatalog({ roots: [root], cacheMs: 0, identityStore: new RepoIdentityStore({ path: ":memory:" }) });
  t.after(() => catalog.identityStore.close());
  const [record] = await catalog.list();
  assert.equal(record.lastActivity, 0);
});

test("a catalog with no store behaves exactly as one that never had one", async (t) => {
  const { catalog } = await fixture(t);
  assert.equal(catalog.identityStore, null, "the default must stay fully live");
  const [record] = await catalog.list();
  assert.ok(record.lastActivity > 0);
});

test("concurrent cold and forced catalog reads share one scan; invalidation survives an active scan", async (t) => {
  const { catalog } = await fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let scans = 0;
  const original = catalog.scan.bind(catalog);
  catalog.scan = async (generation) => { scans++; await gate; return original(generation); };
  const reads = [catalog.list(), catalog.list(), catalog.list({ refresh: true })];
  release();
  const results = await Promise.all(reads);
  assert.equal(scans, 1);
  assert.equal(results[0], results[2]);
  let unblock;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  catalog.scan = async (generation) => { scans++; await blocked; return original(generation); };
  const pending = catalog.list({ refresh: true });
  catalog.invalidate();
  unblock();
  await pending;
  assert.equal(catalog.cache, null);
  await catalog.list();
  assert.equal(scans, 3);
});

test("Git process limit is shared across callers and releases slots after failures", async () => {
  let active = 0, maximum = 0;
  const catalog = new RepoCatalog({ roots: [], gitConcurrency: 2, execute: async (_cmd, args) => {
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    if (args.includes("fail")) throw new Error("Git failed");
    return { stdout: "ok" };
  } });
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => catalog.git("/fixture", [index === 0 ? "fail" : "status"])));
  assert.equal(maximum, 2);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 11);
  assert.equal(catalog.gitActive, 0);
  assert.equal(catalog.gitQueue.length, 0);
});

test("a fresh cache is served without a scan, a missing root is skipped, and nested directories are not repositories", async (t) => {
  const { root, repo, catalog } = await fixture(t);
  await mkdir(join(root, "not-a-repo"));
  await mkdir(join(repo, "nested"));
  const [record] = await catalog.list();
  assert.equal(record.name, "sample");
  catalog.roots.push(join(root, "missing-root"));
  catalog.cacheMs = 60_000;
  let scans = 0;
  const original = catalog.scan.bind(catalog);
  catalog.scan = async (generation) => { scans++; return original(generation); };
  assert.equal(await catalog.list(), await catalog.list());
  assert.equal(scans, 0, "a warm cache answers without a scan");
  const refreshed = await catalog.list({ refresh: true });
  assert.equal(scans, 1);
  assert.deepEqual(refreshed.map((item) => item.name), ["sample"], "plain directories, nested paths and missing roots are not repositories");
  assert.equal(await catalog.inspect({ root, path: join(root, "not-a-repo") }), null);
});

test("a read that joins a scan already invalidated by a newer generation scans again", async (t) => {
  const { catalog } = await fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let scans = 0;
  const original = catalog.scan.bind(catalog);
  catalog.scan = async (generation) => { scans++; if (scans === 1) await gate; return original(generation); };
  const first = catalog.list();
  const second = catalog.list();
  catalog.invalidate();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(scans, 2, "the joined reader noticed the invalidation and scanned again");
  assert.deepEqual(a.map((item) => item.name), ["sample"]);
  assert.deepEqual(b.map((item) => item.name), ["sample"]);
});

test("parses tracking information and ignores an unborn branch oid", () => {
  const { parsePorcelainV2 } = catalogExports;
  const tracked = parsePorcelainV2("# branch.oid " + "a".repeat(40) + "\n# branch.head feature/x\n# branch.upstream origin/feature/x\n# branch.ab +3 -2\n1 .M N... 100644 100644 100644 abc def file.txt\n? new.txt\n");
  assert.deepEqual(tracked, { branch: "feature/x", ahead: 3, behind: 2, changedFiles: 2, oid: "a".repeat(40) });
  assert.deepEqual(parsePorcelainV2("# branch.oid (initial)\n# branch.head main\n# branch.ab garbage\n"), { branch: "main", ahead: 0, behind: 0, changedFiles: 0, oid: null });
});

test("merges a file that is staged and unstaged into one row marked staged", async (t) => {
  const { repo, catalog } = await fixture(t);
  await writeFile(join(repo, "tracked.txt"), "staged part\n");
  await git(repo, "add", "tracked.txt");
  await writeFile(join(repo, "tracked.txt"), "staged part\nunstaged part\n");
  const [record] = await catalog.list();
  const changes = await catalog.changes(record.id);
  const tracked = changes.files.find((file) => file.path === "tracked.txt");
  assert.equal(tracked.area, "staged");
  assert.deepEqual(tracked.areas, ["unstaged", "staged"]);
  assert.equal(tracked.status, "M");
  assert.match((await catalog.diff(record.id, "tracked.txt", { staged: true })).patch, /\+staged part/);
  assert.equal(changes.recentCommit.subject, "initial");
  await assert.rejects(catalog.diff(record.id, "missing.txt"), /not part of the current changes/);
});

test("pull request lookups use gh, distinguish no pull request from a broken gh, and cache the answer", async (t) => {
  const { catalog } = await fixture(t);
  const calls = [];
  let behaviour = "open";
  catalog.execute = async (command, args, options) => {
    calls.push([command, args[0], options.cwd]);
    if (command === "git") return exec("git", args, { encoding: "utf8" });
    if (behaviour === "open") return { stdout: JSON.stringify({ number: 3, title: "Open", url: "https://github.com/x/y/pull/3", state: "OPEN", headRefOid: "b".repeat(40), statusCheckRollup: [{ state: "SUCCESS" }, { conclusion: "TIMED_OUT" }] }) };
    if (behaviour === "none") throw Object.assign(new Error("gh failed"), { stderr: "no pull requests found for branch" });
    throw new Error("gh: command not found");
  };
  const [record] = await catalog.list();
  const open = await catalog.pullRequest(record.id);
  assert.equal(open.available, true);
  assert.equal(open.pullRequest.number, 3);
  assert.equal(open.pullRequest.headSha, "b".repeat(40));
  assert.deepEqual(open.pullRequest.checks, { passed: 1, failed: 1, pending: 0, total: 2 });
  assert.equal(calls.filter(([command]) => command === "gh").length, 1);
  behaviour = "none";
  assert.equal((await catalog.pullRequest(record.id)).pullRequest.number, 3, "a fresh answer is served from the cache");
  assert.deepEqual(await catalog.pullRequest(record.id, { refresh: true }), { available: true, pullRequest: null });
  behaviour = "broken";
  assert.deepEqual(await catalog.pullRequest(record.id, { refresh: true }), { available: false, pullRequest: null });
  assert.equal(calls.filter(([command]) => command === "gh").length, 3);
});

test("normalizes a minimal pull request payload with defaults", () => {
  const pullRequest = normalizePullRequest({ number: "8", headRefOid: "short" });
  assert.equal(pullRequest.number, 8);
  assert.equal(pullRequest.title, "Untitled pull request");
  assert.equal(pullRequest.state, "OPEN");
  assert.equal(pullRequest.reviewDecision, "REVIEW_REQUIRED");
  assert.equal(pullRequest.mergeState, "UNKNOWN");
  assert.equal(pullRequest.headSha, null);
  assert.equal(pullRequest.author, null);
  assert.deepEqual(pullRequest.checks, { passed: 0, failed: 0, pending: 0, total: 0 });
});

test("repository roots come from the environment when configured", async (t) => {
  const previous = process.env.CMUX_COMPANION_REPO_ROOTS;
  t.after(() => { if (previous === undefined) delete process.env.CMUX_COMPANION_REPO_ROOTS; else process.env.CMUX_COMPANION_REPO_ROOTS = previous; });
  process.env.CMUX_COMPANION_REPO_ROOTS = " /tmp/one : :/tmp/two ";
  assert.deepEqual(new RepoCatalog().roots, ["/tmp/one", "/tmp/two"]);
  process.env.CMUX_COMPANION_REPO_ROOTS = " : ";
  assert.equal(new RepoCatalog().roots.length, 2, "an empty list falls back to the defaults");
  delete process.env.CMUX_COMPANION_REPO_ROOTS;
  assert.equal(new RepoCatalog({ inspectConcurrency: 0, gitConcurrency: "x" }).inspectConcurrency, 8);
});

test("rejects unsafe file arguments and refuses non-regular or oversized files", async (t) => {
  const { repo, catalog } = await fixture(t);
  await mkdir(join(repo, "docs"));
  await writeFile(join(repo, "docs", "big.md"), "x".repeat(768 * 1024 + 1));
  const [record] = await catalog.list();
  for (const file of ["", "   ", "docs/\0.md", "x".repeat(1_025), 42]) await assert.rejects(catalog.markdown(record.id, file), /Invalid repository file/);
  await assert.rejects(catalog.markdown(record.id, "docs/missing.md"), /does not exist/);
  await assert.rejects(catalog.markdown(record.id, "docs/big.md"), /too large/);
  await assert.rejects(catalog.asset(record.id, "docs/big.md"), /asset type is not supported/);
  await assert.rejects(catalog.markdown(record.id, "docs"), /not supported/);
});
