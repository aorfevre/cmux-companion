import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
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
