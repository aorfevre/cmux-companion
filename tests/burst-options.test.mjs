import assert from "node:assert/strict";
import test from "node:test";
import { BURST_OPTION, burstBriefLines, normalizeBurst } from "../server/burst-options.mjs";

test("the option is data-only and frozen", () => {
  assert.equal(BURST_OPTION.label, "Burst");
  assert.match(BURST_OPTION.hint, /more quota/);
  assert.ok(Object.isFrozen(BURST_OPTION));
});

test("normalization accepts a boolean and rejects everything else", () => {
  assert.equal(normalizeBurst(undefined), false);
  assert.equal(normalizeBurst(null), false);
  assert.equal(normalizeBurst(true), true);
  assert.equal(normalizeBurst(false), false);
  assert.throws(() => normalizeBurst("yes"), /Burst must be true or false/);
  assert.throws(() => normalizeBurst(1), /Burst must be true or false/);
});

test("brief lines appear only when burst is on", () => {
  assert.deepEqual(burstBriefLines(false), []);
  const lines = burstBriefLines(true).join("\n");
  assert.match(lines, /launch subagents/);
  assert.match(lines, /Quota is not a constraint/);
  assert.match(lines, /verify it before you report it/);
});
