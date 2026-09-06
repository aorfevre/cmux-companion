import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseWorktreePorcelain, runGit, withWorkspaceLaunch } from "../server/worktree-operations.mjs";
import { git, parseWorktrees } from "../server/worktree-inventory.mjs";
import { WorktreeDashboard, parseWorktreeList } from "../server/worktree-dashboard.mjs";
import { RepoCatalog } from "../server/repo-catalog.mjs";

const row = (overrides = {}) => ({
  path: "/repo", head: null, branch: null, detached: false, bare: false,
  locked: false, lockReason: null, prunable: false, pruneReason: null, ...overrides,
});
const parse = (fields) => parseWorktreePorcelain(`worktree /repo\0${fields}`);

test("parser: empty output", () => assert.deepEqual(parseWorktreePorcelain(""), []));
test("parser: a single record without a trailing NUL", () => {
  assert.deepEqual(parseWorktreePorcelain("worktree /repo\0HEAD abc"), [row({ head: "abc" })]);
});
test("parser: multiple records with preserved order", () => {
  assert.deepEqual(parseWorktreePorcelain("worktree /z\0\0worktree /a\0\0"), [row({ path: "/z" }), row({ path: "/a" })]);
});
for (const [name, fields, expected] of [
  ["a bare repository record", "bare", { bare: true }],
  ["detached HEAD", "HEAD abc\0detached", { head: "abc", detached: true }],
  ["locked without a reason", "locked", { locked: true }],
  ["locked with a reason", "locked keep this checkout", { locked: true, lockReason: "keep this checkout" }],
  ["prunable without a reason", "prunable", { prunable: true }],
  ["prunable with a reason", "prunable gitdir missing", { prunable: true, pruneReason: "gitdir missing" }],
  ["refs/heads/ prefix stripping", "branch refs/heads/feature/mobile", { branch: "feature/mobile" }],
  ["unknown keys", "future something\0HEAD abc", { head: "abc" }],
]) {
  test(`parser: ${name}`, () => assert.deepEqual(parse(fields), [row(expected)]));
}
test("parser: fields before the first worktree key being ignored", () => {
  assert.deepEqual(parseWorktreePorcelain("HEAD ignored\0locked\0unknown field\0worktree /repo"), [row()]);
});
test("parser: repeated separators and spaces, LF and CRLF inside paths and reasons", () => {
  const path = "/repo with spaces\nline\r\nend";
  assert.deepEqual(parseWorktreePorcelain(`\0\0worktree ${path}\0locked   reason\nline\0\0\0`), [row({ path, locked: true, lockReason: "  reason\nline" })]);
});
test("adapters: exact inventory and dashboard shapes and marker defaults", () => {
  const output = "worktree /repo\0bare\0\0worktree /feature\0HEAD abc\0branch refs/heads/topic\0detached\0locked\0prunable\0\0worktree /other\0locked   keep\0prunable missing\0";
  assert.deepEqual(parseWorktrees(output), [
    { path: "/repo", head: undefined, branch: null, primary: true, bare: true, locked: false, lockReason: null, prunable: false },
    { path: "/feature", head: "abc", branch: "topic", primary: false, bare: false, locked: true, lockReason: null, prunable: true },
    { path: "/other", head: undefined, branch: null, primary: false, bare: false, locked: true, lockReason: "keep", prunable: true },
  ]);
  assert.deepEqual(parseWorktreeList(output), [
    { path: "/repo", head: null, branch: null, detached: false, locked: null, prunable: null },
    { path: "/feature", head: "abc", branch: "topic", detached: true, locked: "Locked", prunable: "Prunable" },
    { path: "/other", head: null, branch: null, detached: false, locked: "  keep", prunable: "missing" },
  ]);
});
test("adapters: inventory whitespace normalization and dashboard empty marker reasons", () => {
  const output = "worktree  /repo\0HEAD  abc\0branch  refs/heads/topic\0locked \0prunable ";
  assert.deepEqual(parseWorktrees(output), [
    { path: "/repo", head: "abc", branch: "topic", primary: true, bare: false, locked: true, lockReason: null, prunable: true },
  ]);
  assert.deepEqual(parseWorktreeList(output), [
    { path: " /repo", head: " abc", branch: " refs/heads/topic", detached: false, locked: "", prunable: "" },
  ]);
});
test("runner: argument and explicit option forwarding", async () => {
  const options = { encoding: "buffer", timeout: 123, maxBuffer: 456, env: { CUSTOM: "value" }, windowsHide: true };
  const result = { stdout: Buffer.from("output"), stderr: "diagnostic" };
  assert.equal(await runGit("/repo with spaces", ["show", "branch;literal"], options, async (...args) => {
    assert.deepEqual(args, ["git", ["-C", "/repo with spaces", "show", "branch;literal"], options]);
    assert.equal(args[2], options);
    return result;
  }), result);
});
test("runner: implicit process options remain undefined for launch lookup", async () => {
  await runGit("/repo", ["rev-parse"], undefined, async (_command, _args, options) => {
    assert.equal(options, undefined);
    return { stdout: "" };
  });
});
test("runner: inventory Git environment flags and stdout return", async () => {
  const output = "  raw stdout\0\n";
  assert.equal(await git("/repo", ["status"], async (command, args, options) => {
    assert.equal(command, "git");
    assert.deepEqual(args, ["-C", "/repo", "status"]);
    assert.deepEqual(options, { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
    return { stdout: output };
  }), output);
});
test("runner: catalog defaults and per-call timeout and maxBuffer overrides", async () => {
  const calls = [];
  const catalog = new RepoCatalog({ roots: [], execute: async (...args) => {
    calls.push(args);
    return { stdout: " raw\n" };
  } });
  for (const options of [{}, { timeout: 321, maxBuffer: 654 }, { timeout: 0, maxBuffer: 0 }]) {
    assert.equal(await catalog.git("/repo", ["status"], options), " raw\n");
  }
  for (const [index, [command, args, options]] of calls.entries()) {
    assert.equal(command, "git");
    assert.deepEqual(args, ["-C", "/repo", "status"]);
    assert.deepEqual(options, { encoding: "utf8", timeout: index === 1 ? 321 : 8_000, maxBuffer: index === 1 ? 654 : 1024 * 1024, env: process.env });
    assert.equal(options.env, process.env);
  }
});
test("runner: caller-specific empty and missing stdout handling", async () => {
  for (const stdout of ["", undefined, null]) {
    const execute = async () => ({ stdout });
    assert.equal((await runGit("/repo", [], {}, execute)).stdout, stdout);
    assert.equal(await git("/repo", [], execute), stdout);
    assert.equal(await new RepoCatalog({ roots: [], execute }).git("/repo", []), stdout === undefined ? "" : stdout);
  }
});
test("runner: rejection preserves message, code, stdout and stderr", async () => {
  for (const code of [128, "ETIMEDOUT"]) {
    const error = Object.assign(new Error("original Git failure"), { code, stdout: "partial", stderr: "fatal: diagnostic" });
    const execute = async () => { throw error; };
    const catalog = new RepoCatalog({ roots: [], execute });
    for (const invoke of [
      () => runGit("/repo", [], {}, execute),
      () => git("/repo", [], execute),
      () => catalog.git("/repo", []),
    ]) {
      await assert.rejects(invoke, (actual) => {
        assert.equal(actual, error);
        assert.equal(actual.message, "original Git failure");
        assert.equal(actual.code, code);
        assert.equal(actual.stdout, "partial");
        assert.equal(actual.stderr, "fatal: diagnostic");
        return true;
      });
    }
    assert.equal(catalog.gitActive, 0);
  }
});
test("backend: raw locked/prunable porcelain reaches WorktreeDashboard fields", async () => {
  const repo = { id: "fixture", name: "repo", root: "/", path: "/repo" };
  const output = "worktree /repo\0HEAD abc\0branch refs/heads/main\0\0worktree /feature\0HEAD def\0branch refs/heads/feature/mobile\0locked\0prunable\0\0worktree /other\0HEAD ghi\0detached\0locked keep me\0prunable gitdir missing\0\0";
  const catalog = new RepoCatalog({ roots: [], execute: async (_command, args) => {
    const [, cwd, command] = args;
    if (command === "worktree") return { stdout: output };
    if (command === "rev-parse") return { stdout: args.includes("--git-common-dir") ? "/repo/.git" : cwd };
    if (command === "status") return { stdout: cwd === "/other" ? "# branch.head (detached)\n" : `# branch.head ${cwd === "/repo" ? "main" : "feature/mobile"}\n` };
    if (command === "log") return { stdout: "100" };
    throw new Error(`Unexpected Git call: ${args}`);
  } });
  catalog.list = async () => [repo];
  const dashboard = new WorktreeDashboard({
    repoCatalog: catalog, canonicalize: async (path) => path, managedReleaseRoots: [],
    repositoryArchive: { has: () => false }, repositoryFavorites: { has: () => false },
  });
  const snapshot = await dashboard.snapshot();
  const rows = snapshot.repositories[0].worktrees;
  assert.equal(rows.length, 3);
  const feature = rows.find((item) => item.path === "/feature");
  assert.equal(feature.branch, "feature/mobile");
  assert.equal(feature.locked, "Locked");
  assert.equal(feature.prunable, "Prunable");
  assert.equal(feature.detached, false);
  const other = rows.find((item) => item.path === "/other");
  assert.equal(other.locked, "keep me");
  assert.equal(other.prunable, "gitdir missing");
  assert.equal(other.detached, true);
  await assert.rejects(() => dashboard.remove(feature.id), /Unlock this Git worktree/);
});
test("runner: real Git porcelain and launch no-lock fallback outside a repository", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cmux-git-runner-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await withWorkspaceLaunch(directory, async () => "fallback result"), "fallback result");
  await git(directory, ["init", "--bare"]);
  const output = await git(directory, ["worktree", "list", "--porcelain", "-z"]);
  assert.deepEqual(parseWorktreePorcelain(output), [row({ path: directory, bare: true })]);
});

test("adapters: strip the branch prefix exactly once even when the branch starts with refs/heads/", () => {
  const output = "worktree /repo\0branch refs/heads/refs/heads/topic";
  assert.equal(parseWorktreePorcelain(output)[0].branch, "refs/heads/topic");
  assert.equal(parseWorktrees(output)[0].branch, "refs/heads/topic");
  assert.equal(parseWorktreeList(output)[0].branch, "refs/heads/topic");
});

test("strict removal locking shares the launch lock and never falls back without Git evidence", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cmux-removal-lock-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockDirectory = join(directory, "locks");
  let called = false;
  await assert.rejects(() => withWorkspaceLaunch(directory, () => { called = true; }, { requireRepository: true, lockDirectory }));
  assert.equal(called, false);
  await git(directory, ["init"]);
  await withWorkspaceLaunch(directory, async () => {
    await assert.rejects(() => withWorkspaceLaunch(directory, () => { called = true; }, { requireRepository: true, lockDirectory }), /holds this lock/);
  }, { lockDirectory });
  assert.equal(called, false);
  assert.equal(await withWorkspaceLaunch(directory, () => "removed", { requireRepository: true, lockDirectory }), "removed");
});
