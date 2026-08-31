import assert from "node:assert/strict";
import test from "node:test";
import { assignAgents, parsePlannerReply } from "../server/worktree-planner.mjs";

function envelope(text, sessionId = "session-1") {
  return `[i] Preparing CLIProxy...\n[OK] CLIProxy binary ready\n${JSON.stringify({ session_id: sessionId, result: text })}\n`;
}

test("parses a questions reply and keeps the session id", () => {
  const reply = parsePlannerReply(envelope('{"questions":[{"text":"Which API?","options":["REST","GraphQL"]}]}'));
  assert.equal(reply.sessionId, "session-1");
  assert.equal(reply.status, "questions");
  assert.equal(reply.questions.length, 1);
  assert.equal(reply.questions[0].text, "Which API?");
  assert.deepEqual(reply.questions[0].options, ["REST", "GraphQL"]);
  assert.match(reply.questions[0].id, /^q[0-9]+$/);
});

test("parses a tasks reply wrapped in a fenced code block", () => {
  const text = 'Here is the split.\n```json\n{"tasks":[{"title":"Add API","branch":"feature/api","prompt":"Build the API."}]}\n```';
  const reply = parsePlannerReply(envelope(text));
  assert.equal(reply.status, "ready");
  assert.equal(reply.tasks.length, 1);
  assert.deepEqual(reply.tasks[0], { id: "t1", title: "Add API", branch: "feature/api", prompt: "Build the API." });
});

test("rejects a reply that holds both questions and tasks", () => {
  const text = '{"questions":[{"text":"a"}],"tasks":[{"title":"b","branch":"feature/b","prompt":"c"}]}';
  assert.throws(() => parsePlannerReply(envelope(text)), /unusable answer/);
});

test("rejects a reply that holds neither key", () => {
  assert.throws(() => parsePlannerReply(envelope('{"notes":"hello"}')), /unusable answer/);
});

test("rejects an envelope with no JSON at all", () => {
  assert.throws(() => parsePlannerReply("[i] Preparing CLIProxy...\n"), /unusable answer/);
});

test("drops a task that is missing a branch", () => {
  const text = '{"tasks":[{"title":"Good","branch":"feature/good","prompt":"Do it."},{"title":"Bad","prompt":"No branch."}]}';
  const reply = parsePlannerReply(envelope(text));
  assert.equal(reply.tasks.length, 1);
  assert.equal(reply.tasks[0].branch, "feature/good");
});

test("ignores a stray brace in the prose before the plan", () => {
  const text = 'Use { key } style.\n{"tasks":[{"title":"A","branch":"feature/a","prompt":"Do it."}]}';
  const reply = parsePlannerReply(envelope(text));
  assert.equal(reply.tasks.length, 1);
  assert.equal(reply.tasks[0].branch, "feature/a");
});

test("prefers the last fenced block when the model shows an example first", () => {
  const text = 'Shape:\n```json\n{"tasks":[{"title":"Example","branch":"example","prompt":"Sample."}]}\n```\nReal plan:\n```json\n{"tasks":[{"title":"Real","branch":"feature/real","prompt":"Do the real work."}]}\n```';
  const reply = parsePlannerReply(envelope(text));
  assert.equal(reply.tasks.length, 1);
  assert.equal(reply.tasks[0].branch, "feature/real");
});

test("ignores a brace that sits inside a JSON string value", () => {
  const text = '{"tasks":[{"title":"A","branch":"feature/a","prompt":"Write a { brace } in the docs."}]}';
  const reply = parsePlannerReply(envelope(text));
  assert.equal(reply.tasks[0].prompt, "Write a { brace } in the docs.");
});

test("stays fast on a large reply that ends in brace-heavy prose", () => {
  let deep = '{"a":1';
  for (let index = 0; index < 4_000; index += 1) deep += `,"k${index}":"v${index}"`;
  deep += "}";
  const text = `${deep}\n${"prose } more } text } ".repeat(4_000)}`;
  const started = Date.now();
  assert.throws(() => parsePlannerReply(envelope(text)), /unusable answer/);
  assert.ok(Date.now() - started < 1_000, `parse took ${Date.now() - started}ms`);
});

function usageFor(claudePercent, codexPercent) {
  const provider = (id, percent) => ({
    id,
    available: percent !== null,
    accounts: percent === null ? [] : [{
      status: "ready",
      windows: [
        { cadence: "5h", category: "usage", remainingPercent: percent },
        { cadence: "weekly", category: "usage", remainingPercent: percent + 5 },
      ],
    }],
  });
  return { providers: [provider("claude", claudePercent), provider("codex", codexPercent)] };
}

const THREE = [{ id: "t1" }, { id: "t2" }, { id: "t3" }];

test("sends every task to the roomier provider when headroom is far apart", () => {
  const tasks = assignAgents(THREE, usageFor(20, 90));
  assert.deepEqual(tasks.map((task) => task.agent), ["codex", "codex", "codex"]);
  assert.match(tasks[0].agentReason, /Codex/);
  assert.match(tasks[0].agentReason, /best account 90% left/);
});

test("alternates when the two providers are within ten points", () => {
  const tasks = assignAgents(THREE, usageFor(70, 75));
  assert.deepEqual(tasks.map((task) => task.agent), ["codex", "claude", "codex"]);
});

test("skips a provider with no headroom left", () => {
  const tasks = assignAgents(THREE, usageFor(70, 3));
  assert.deepEqual(tasks.map((task) => task.agent), ["claude", "claude", "claude"]);
});

test("falls back to claude when no usage is available", () => {
  const tasks = assignAgents(THREE, usageFor(null, null));
  assert.deepEqual(tasks.map((task) => task.agent), ["claude", "claude", "claude"]);
  assert.match(tasks[0].agentReason, /usage is unavailable/i);
});

test("ignores accounts that need a reconnect", () => {
  const usage = usageFor(70, 90);
  usage.providers[1].accounts[0].status = "reconnect";
  const tasks = assignAgents(THREE, usage);
  assert.deepEqual(tasks.map((task) => task.agent), ["claude", "claude", "claude"]);
});

test("keeps the original task fields and does not mutate the input", () => {
  const input = [{ id: "t1", title: "Billing", branch: "feature/billing", prompt: "Add billing." }];
  const tasks = assignAgents(input, usageFor(90, 20));
  assert.equal(tasks[0].title, "Billing");
  assert.equal(tasks[0].branch, "feature/billing");
  assert.equal(tasks[0].agent, "claude");
  assert.equal(input[0].agent, undefined);
});

test("survives a null usage snapshot", () => {
  const tasks = assignAgents(THREE, null);
  assert.deepEqual(tasks.map((task) => task.agent), ["claude", "claude", "claude"]);
});

test("takes the best usable account when a provider has several", () => {
  const usage = usageFor(30, 20);
  usage.providers[0].accounts.push({
    status: "ready",
    windows: [
      { cadence: "5h", category: "usage", remainingPercent: 95 },
      { cadence: "weekly", category: "usage", remainingPercent: 95 },
    ],
  });
  usage.providers[0].accounts.unshift({ status: "exhausted", windows: [{ cadence: "5h", category: "usage", remainingPercent: 0 }] });
  const tasks = assignAgents(THREE, usage);
  assert.deepEqual(tasks.map((task) => task.agent), ["claude", "claude", "claude"]);
  assert.match(tasks[0].agentReason, /best account 95% left/);
});

test("treats headroom of exactly five percent as unusable", () => {
  const tasks = assignAgents(THREE, usageFor(60, 5));
  assert.deepEqual(tasks.map((task) => task.agent), ["claude", "claude", "claude"]);
});

test("alternates when the gap is exactly ten points", () => {
  const tasks = assignAgents(THREE, usageFor(60, 70));
  assert.deepEqual(tasks.map((task) => task.agent), ["codex", "claude", "codex"]);
});
