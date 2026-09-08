import assert from "node:assert/strict";
import test from "node:test";
import { BurstScanner, scanPrompt } from "../server/burst-scanner.mjs";

const repository = { id: "repoAAAAAAAAAAAAAA", name: "sample", path: "/repo/sample" };
const envelope = (result) => `${JSON.stringify({ type: "system" })}\n${JSON.stringify({ type: "result", result: JSON.stringify(result) })}\n`;

function scanner(execute, overrides = {}) {
  return new BurstScanner({ execute, modelSettings: { engine: (role, provider) => ({ provider, model: "default", effort: "default" }) }, ...overrides });
}

test("runs a read-only headless scan and returns the validated proposal", async () => {
  const calls = [];
  const scan = scanner(async (bin, args, options) => {
    calls.push({ bin, args, options });
    return { stdout: envelope({ goal: "Cover the store", rationale: "Zero tests", evidence: ["server/x.mjs"], sizeEstimate: "medium" }) };
  });
  const proposal = await scan.scan({ repository, provider: "codex" });
  assert.deepEqual(proposal, { goal: "Cover the store", rationale: "Zero tests", evidence: ["server/x.mjs"], sizeEstimate: "medium" });
  assert.equal(calls[0].bin, "ccs");
  assert.equal(calls[0].args[0], "codex");
  assert.ok(calls[0].args.includes("--print"));
  assert.equal(calls[0].args[calls[0].args.indexOf("--allowed-tools") + 1], "Read,Grep,Glob");
  assert.ok(calls[0].args[calls[0].args.indexOf("--disallowed-tools") + 1].includes("Bash"));
  assert.equal(calls[0].args.at(-2), "--");
  assert.match(calls[0].args.at(-1), /one JSON object/);
  assert.equal(calls[0].options.cwd, "/repo/sample");
});

test("passes a concrete model and effort, never the passthrough values", async () => {
  const calls = [];
  const scan = scanner(async (bin, args) => { calls.push(args); return { stdout: envelope({ goal: "g", rationale: "r" }) }; },
    { modelSettings: { engine: () => ({ provider: "claude", model: "claude-fable-5-1", effort: "high" }) } });
  await scan.scan({ repository, provider: "claude" });
  assert.equal(calls[0][calls[0].indexOf("--model") + 1], "claude-fable-5-1");
  assert.equal(calls[0][calls[0].indexOf("--effort") + 1], "high");
});

test("rejects an unusable answer with a stated reason", async () => {
  const scan = scanner(async () => ({ stdout: "not json at all\n" }));
  await assert.rejects(() => scan.scan({ repository, provider: "claude" }), /unusable answer/);
  const noGoal = scanner(async () => ({ stdout: envelope({ rationale: "r" }) }));
  await assert.rejects(() => noGoal.scan({ repository, provider: "claude" }), /no usable goal/);
});

test("names a missing CLI, a timeout and a failed run", async () => {
  await assert.rejects(() => scanner(async () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); }).scan({ repository, provider: "claude" }), /needs the ccs CLI/);
  await assert.rejects(() => scanner(async () => { throw Object.assign(new Error("x"), { killed: true, reason: "idle" }); }).scan({ repository, provider: "claude" }), /stopped answering/);
  await assert.rejects(() => scanner(async () => { throw Object.assign(new Error("x"), { stderr: "E301 Claude CLI not found" }); }).scan({ repository, provider: "claude" }), /cannot find the claude CLI/);
});

test("the prompt names the files to read and the exact JSON shape", () => {
  const prompt = scanPrompt(repository);
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /README/);
  assert.match(prompt, /"goal"/);
  assert.match(prompt, /"sizeEstimate"/);
  assert.match(prompt, /Do not write/);
});
