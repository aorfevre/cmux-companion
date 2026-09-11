import assert from "node:assert/strict";



import test from "node:test";
import { parseWorktreePorcelain, runGit } from "../server/worktree-operations.mjs";


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
