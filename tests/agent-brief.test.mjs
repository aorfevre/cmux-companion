import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, dirname } from "node:path";
import test from "node:test";
import { AgentBriefs } from "../server/agent-brief.mjs";

const BRIEF = ["# Task T1", "", "## Delivery contract", "Outcome: the brief lives in a file.", "", "```bash", "npm run lint", "```", ""].join("\n");

test("writes the full brief to a private file inside the brief directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmux-briefs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const briefs = new AgentBriefs({ directory: root });
  const { path } = await briefs.write({ planId: "bf93348d-7320", taskId: "T1", markdown: BRIEF });
  assert.ok(isAbsolute(path));
  assert.equal(dirname(path), root);
  assert.equal(await readFile(path, "utf8"), BRIEF);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("rejects identifiers that try to escape the brief directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmux-briefs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const briefs = new AgentBriefs({ directory: root });
  await assert.rejects(() => briefs.write({ planId: "../escape", taskId: "T1", markdown: BRIEF }), TypeError);
  await assert.rejects(() => briefs.write({ planId: "plan", taskId: "../../etc/passwd", markdown: BRIEF }), TypeError);
  await assert.rejects(() => briefs.write({ planId: "  ", taskId: "T1", markdown: BRIEF }), TypeError);
});

test("points the agent at the brief file with a short prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmux-briefs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const briefs = new AgentBriefs({ directory: root });
  const { path } = await briefs.write({ planId: "plan", taskId: "T1", markdown: BRIEF });
  const prompt = briefs.pointerPrompt({ title: "Brief store".padEnd(600, "!"), outcome: "Long brief in a file".padEnd(900, "?"), path });
  assert.ok(prompt.length < 2_000, `prompt is ${prompt.length} characters`);
  assert.ok(prompt.includes(path));
  assert.ok(prompt.split("\n")[0].includes(path));
  assert.ok(!prompt.includes("npm run lint"));
});

test("removes brief files that are older than the cutoff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmux-briefs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const briefs = new AgentBriefs({ directory: root });
  const aged = await briefs.write({ planId: "old", taskId: "T0", markdown: BRIEF });
  const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
  await utimes(aged.path, past, past);
  const fresh = await briefs.write({ planId: "new", taskId: "T1", markdown: BRIEF });
  await briefs.cleanup();
  await assert.rejects(() => stat(aged.path));
  assert.ok((await stat(fresh.path)).isFile());
});
