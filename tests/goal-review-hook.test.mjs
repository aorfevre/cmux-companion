import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../server/goal-review-hook.mjs", import.meta.url));

// The hook runs as a Claude Code PreToolUse hook: JSON on stdin, JSON on stdout.
function runHook(input, { allowBrokenPipe = false } = {}) {
  const child = spawnSync(process.execPath, [HOOK], { input, encoding: "utf8", timeout: 10_000 });
  // A hook that aborts mid-read closes stdin early; Linux then reports EPIPE
  // to the writer, which is the expected shape of that abort.
  if (!(allowBrokenPipe && child.error?.code === "EPIPE")) assert.equal(child.error, undefined);
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

test("hook CLI allows read-only tools and denies everything else over stdin", () => {
  const allowed = runHook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "x" } }));
  assert.equal(allowed.status, 0);
  assert.deepEqual(JSON.parse(allowed.stdout), {});

  const denied = runHook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /" } }));
  assert.equal(denied.status, 0);
  const output = JSON.parse(denied.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /repository-read-only/);
  assert.doesNotMatch(denied.stdout, /rm -rf/);
});

test("hook CLI exits 2 on invalid JSON without printing a decision", () => {
  const result = runHook("{not json");
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  const empty = runHook("");
  assert.equal(empty.status, 2);
  assert.equal(empty.stdout, "");
});

test("hook CLI aborts with exit 2 once stdin exceeds 256KB", () => {
  const oversized = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", padding: "x".repeat(300 * 1024) });
  const result = runHook(oversized, { allowBrokenPipe: true });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
});
