import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, assertFastForward, discover, fetchExact, primaryWorktree, verifyRepository } from "../src/git.mjs";
import { run } from "../src/process.mjs";
import { buildCandidate } from "../src/manifest.mjs";

test("discovers and stages a remote commit without touching a dirty primary checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmux-updater-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bare = join(root, "remote.git");
  const repo = join(root, "checkout");
  const releases = join(root, "releases");
  await mkdir(releases);
  await run("/usr/bin/git", ["init", "--bare", "--initial-branch=main", bare]);
  await run("/usr/bin/git", ["init", "--initial-branch=main", repo]);
  await run("/usr/bin/git", ["-C", repo, "remote", "add", "origin", bare]);
  await writeFile(join(repo, "tracked.txt"), "one\n");
  await run("/usr/bin/git", ["-C", repo, "add", "tracked.txt"]);
  await run("/usr/bin/git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "one"]);
  await run("/usr/bin/git", ["-C", repo, "push", "-u", "origin", "main"]);
  const target = { name: "fixture", repositoryPath: repo, expectedRemote: bare, remote: "origin", branch: "main" };
  await verifyRepository(target);
  const first = await discover(target);
  await fetchExact(target, first);
  await writeFile(join(repo, "tracked.txt"), "dirty developer work\n");
  const release = join(releases, first);
  await addWorktree(target, release, first);
  assert.equal(await readFile(join(release, "tracked.txt"), "utf8"), "one\n");
  assert.equal(await readFile(join(repo, "tracked.txt"), "utf8"), "dirty developer work\n");
  const inventory = (await run("/usr/bin/git", ["-C", repo, "worktree", "list", "--porcelain"])).stdout;
  assert.match(inventory, /locked cmux-companion managed deployment/);
  const removal = await run("/usr/bin/git", ["-C", repo, "worktree", "remove", "--force", release], { allowFailure: true });
  assert.notEqual(removal.code, 0);
  assert.match(removal.stderr, /locked/);

  await writeFile(join(repo, "second.txt"), "two\n");
  await run("/usr/bin/git", ["-C", repo, "add", "second.txt"]);
  await run("/usr/bin/git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "two"]);
  const second = (await run("/usr/bin/git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  await assertFastForward(target, first, second);
});

test("accepts squash-equivalent history but rejects unrelated divergence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmux-updater-squash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "checkout");
  await run("/usr/bin/git", ["init", "--initial-branch=main", repo]);
  await writeFile(join(repo, "tracked.txt"), "base\n");
  await run("/usr/bin/git", ["-C", repo, "add", "tracked.txt"]);
  await run("/usr/bin/git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "base"]);
  const base = (await run("/usr/bin/git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();

  await run("/usr/bin/git", ["-C", repo, "switch", "-c", "feature"]);
  await writeFile(join(repo, "tracked.txt"), "feature\n");
  await run("/usr/bin/git", ["-C", repo, "add", "tracked.txt"]);
  await run("/usr/bin/git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "feature"]);
  const deployed = (await run("/usr/bin/git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  const deployedTree = (await run("/usr/bin/git", ["-C", repo, "rev-parse", `${deployed}^{tree}`])).stdout.trim();
  const squash = (await run("/usr/bin/git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit-tree", deployedTree, "-p", base, "-m", "squash feature"])).stdout.trim();
  const target = { name: "fixture", repositoryPath: repo };
  await assertFastForward(target, deployed, squash);

  await run("/usr/bin/git", ["-C", repo, "switch", "--detach", base]);
  await writeFile(join(repo, "tracked.txt"), "divergent\n");
  await run("/usr/bin/git", ["-C", repo, "add", "tracked.txt"]);
  await run("/usr/bin/git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "divergent"]);
  const divergent = (await run("/usr/bin/git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  await assert.rejects(assertFastForward(target, deployed, divergent), /Unsafe non-fast-forward history/);
});

test("resolves the stable primary checkout from a linked worktree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmux-updater-primary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "checkout");
  const linked = join(root, "feature-worktree");
  await run("/usr/bin/git", ["init", "--initial-branch=main", repo]);
  await writeFile(join(repo, "tracked.txt"), "ready\n");
  await run("/usr/bin/git", ["-C", repo, "add", "tracked.txt"]);
  await run("/usr/bin/git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "ready"]);
  await run("/usr/bin/git", ["-C", repo, "worktree", "add", "-b", "feature", linked]);
  assert.equal(await primaryWorktree(linked), await realpath(repo));
});

test("builds a candidate whose build needs a dev dependency while the service runs in production mode", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmux-updater-devdeps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = join(root, "release");
  await mkdir(join(release, "build-tool"), { recursive: true });
  await writeFile(join(release, "build-tool", "package.json"), `${JSON.stringify({ name: "fixture-build-tool", version: "1.0.0", main: "index.js" })}\n`);
  await writeFile(join(release, "build-tool", "index.js"), 'module.exports = "ok";\n');
  await writeFile(join(release, "package.json"), `${JSON.stringify({
    name: "fixture-release",
    version: "1.0.0",
    private: true,
    scripts: { build: "node -e \"require('fixture-build-tool')\" && node -e \"require('node:fs').writeFileSync('built.txt', 'built')\"" },
    devDependencies: { "fixture-build-tool": "file:build-tool" },
  }, null, 2)}\n`);
  await writeFile(join(release, "package-lock.json"), `${JSON.stringify({
    name: "fixture-release",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "fixture-release", version: "1.0.0", devDependencies: { "fixture-build-tool": "file:build-tool" } },
      "build-tool": { name: "fixture-build-tool", version: "1.0.0", dev: true },
      "node_modules/fixture-build-tool": { resolved: "build-tool", link: true },
    },
  }, null, 2)}\n`);

  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });

  const target = {
    name: "companion",
    npmPath: join(dirname(process.execPath), "npm"),
    entryPoints: ["built.txt"],
    verificationCommands: [[process.execPath, "-e", "process.exit(process.env.NODE_ENV === 'production' ? 0 : 1)"]],
  };
  const sha = "b".repeat(40);
  const manifest = await buildCandidate(target, release, sha);
  assert.equal(manifest.gitSha, sha);
  assert.equal(await readFile(join(release, "built.txt"), "utf8"), "built");
  assert.equal(process.env.NODE_ENV, "production");
});
