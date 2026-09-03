import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { normalizePullRequest, parseGitHubRepository, parseNameStatus, RepoCatalog } from "../server/repo-catalog.mjs";

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
