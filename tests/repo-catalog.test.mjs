import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parseNameStatus, RepoCatalog } from "../server/repo-catalog.mjs";

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

test("parses NUL-delimited rename status", () => {
  assert.deepEqual(parseNameStatus("R100\0old.txt\0new.txt\0M\0same.txt\0", "staged"), [
    { path: "new.txt", status: "R", area: "staged" },
    { path: "same.txt", status: "M", area: "staged" },
  ]);
});
