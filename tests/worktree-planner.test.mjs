import assert from "node:assert/strict";
import test from "node:test";
import { WorktreePlanner, assignAgents, parsePlannerReply } from "../server/worktree-planner.mjs";

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

const REPO_ID = "repository12345678";

function fakeDeps({ replies = [] }) {
  const calls = [];
  const queue = [...replies];
  return {
    calls,
    worktrees: {
      snapshot: async () => ({
        repositories: [{
          id: REPO_ID,
          name: "sample",
          path: "/repo/sample",
          worktrees: [{ id: "worktree1234567890", branch: "main", path: "/repo/sample", isPrimary: true }],
        }],
      }),
    },
    cmux: {
      workspaceCreate: async (options) => { calls.push(["workspace", options]); return { workspace_id: "ws-1" }; },
    },
    accountUsage: { snapshot: async () => usageFor(90, 20) },
    execute: async (bin, args, options) => {
      calls.push([bin, args, options]);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { stdout: next ?? "" };
    },
  };
}

test("a first round returns questions and records the session id", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Which database?"}]}', "sess-a")] });
  const planner = new WorktreePlanner(deps);
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  assert.equal(draft.status, "questions");
  assert.equal(draft.round, 1);
  assert.equal(draft.questions[0].text, "Which database?");
  assert.equal(deps.calls[0][0], "ccs");
  assert.ok(!deps.calls[0][1].includes("--resume"));
  assert.ok(deps.calls[0][1].includes("--print"));
});

test("an answer round resumes the recorded session", async () => {
  const deps = fakeDeps({ replies: [
    envelope('{"questions":[{"text":"Which database?"}]}', "sess-a"),
    envelope('{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}', "sess-a"),
  ] });
  const planner = new WorktreePlanner(deps);
  const first = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  const second = await planner.answer(first.planId, { answers: [{ id: "q1", text: "Postgres" }] });
  assert.equal(second.status, "ready");
  assert.equal(second.round, 2);
  assert.equal(second.tasks[0].agent, "claude");
  assert.equal(second.tasks[0].branch, "feature/billing");
  const resumeArgs = deps.calls.at(-1)[1];
  assert.ok(resumeArgs.includes("--resume"));
  assert.equal(resumeArgs[resumeArgs.indexOf("--resume") + 1], "sess-a");
});

test("the skip action asks the planner to finish on its own assumptions", async () => {
  const deps = fakeDeps({ replies: [
    envelope('{"questions":[{"text":"Which database?"}]}', "sess-a"),
    envelope('{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}', "sess-a"),
  ] });
  const planner = new WorktreePlanner(deps);
  const first = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  const second = await planner.answer(first.planId, { skip: true });
  assert.equal(second.status, "ready");
  const prompt = deps.calls.at(-1)[1].at(-1);
  assert.match(prompt, /Stop asking questions/);
});

test("the round cap forces a ready plan", async () => {
  const questions = envelope('{"questions":[{"text":"Again?"}]}', "sess-a");
  const deps = fakeDeps({ replies: Array.from({ length: 8 }, () => questions) });
  const planner = new WorktreePlanner({ ...deps, maxRounds: 3 });
  let draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  draft = await planner.answer(draft.planId, { answers: [{ id: "q1", text: "yes" }] });
  draft = await planner.answer(draft.planId, { answers: [{ id: "q1", text: "yes" }] });
  assert.equal(draft.round, 3);
  await assert.rejects(
    () => planner.answer(draft.planId, { answers: [{ id: "q1", text: "yes" }] }),
    /could not produce a plan/,
  );
});

test("retries once when the planner returns unusable output", async () => {
  const deps = fakeDeps({ replies: [
    "no json here",
    envelope('{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}', "sess-a"),
  ] });
  const planner = new WorktreePlanner(deps);
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  assert.equal(draft.status, "ready");
  assert.equal(deps.calls.filter((call) => call[0] === "ccs").length, 2);
});

test("gives up after a second unusable answer", async () => {
  const deps = fakeDeps({ replies: ["no json here", "still no json"] });
  const planner = new WorktreePlanner(deps);
  await assert.rejects(() => planner.start({ repositoryId: REPO_ID, goal: "Add billing" }), /unusable answer/);
});

test("reports a missing ccs binary in plain words", async () => {
  const missing = Object.assign(new Error("spawn ccs ENOENT"), { code: "ENOENT" });
  const deps = fakeDeps({ replies: [missing] });
  const planner = new WorktreePlanner(deps);
  await assert.rejects(() => planner.start({ repositoryId: REPO_ID, goal: "Add billing" }), /needs the ccs CLI/);
  assert.equal(deps.calls.filter((call) => call[0] === "ccs").length, 1);
});

test("reports a timeout in plain words and does not run twice", async () => {
  const timedOut = Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM" });
  const deps = fakeDeps({ replies: [timedOut] });
  const planner = new WorktreePlanner(deps);
  await assert.rejects(() => planner.start({ repositoryId: REPO_ID, goal: "Add billing" }), /did not answer in time/);
  assert.equal(deps.calls.filter((call) => call[0] === "ccs").length, 1);
});

test("rejects an empty goal and an unknown repository", async () => {
  const planner = new WorktreePlanner(fakeDeps({ replies: [] }));
  await assert.rejects(() => planner.start({ repositoryId: REPO_ID, goal: "   " }), /Describe the goal/);
  await assert.rejects(() => planner.start({ repositoryId: "bogus", goal: "Add billing" }), /Invalid repository/);
  await assert.rejects(() => planner.start({ repositoryId: "aaaaaaaaaaaaaaaaaa", goal: "Add billing" }), /Unknown repository/);
});

test("rejects an unknown plan id", async () => {
  const planner = new WorktreePlanner(fakeDeps({ replies: [] }));
  await assert.rejects(() => planner.answer("missing", { skip: true }), /Unknown plan/);
});

test("runs the planner inside the primary worktree", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Which database?"}]}', "sess-a")] });
  const planner = new WorktreePlanner(deps);
  await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  const options = deps.calls.find((call) => call[0] === "ccs")[2];
  assert.equal(options.cwd, "/repo/sample");
});

test("stores edited tasks and rejects a bad branch name", async () => {
  const deps = fakeDeps({ replies: [envelope('{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}', "sess-a")] });
  const planner = new WorktreePlanner(deps);
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  const updated = await planner.update(draft.planId, { tasks: [
    { id: "t1", title: "Billing", branch: "feature/renamed", prompt: "Add billing.", agent: "codex" },
  ] });
  assert.equal(updated.tasks[0].branch, "feature/renamed");
  assert.equal(updated.tasks[0].agent, "codex");
  await assert.rejects(() => planner.update(draft.planId, { tasks: [{ id: "t1", title: "A", branch: "bad branch", prompt: "x" }] }), /valid Git branch name/);
  await assert.rejects(() => planner.update(draft.planId, { tasks: [{ id: "t1", title: "A", branch: "feature/../escape", prompt: "x" }] }), /valid Git branch name/);
  await assert.rejects(() => planner.update(draft.planId, { tasks: [] }), /at least one task/);
  await assert.rejects(() => planner.update(draft.planId, { tasks: [
    { id: "t1", title: "A", branch: "feature/same", prompt: "x" },
    { id: "t2", title: "B", branch: "feature/same", prompt: "y" },
  ] }), /share a branch name/);
});

test("forgets a draft after its time to live", async () => {
  const deps = fakeDeps({ replies: [envelope('{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}', "sess-a")] });
  const planner = new WorktreePlanner({ ...deps, ttlMs: -1 });
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  await assert.rejects(() => planner.update(draft.planId, { tasks: [] }), /Unknown plan/);
});

test("terminates the flags so the prompt is never parsed as one", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Q?"}]}', "s")] });
  await new WorktreePlanner(deps).start({ repositoryId: REPO_ID, goal: "Add billing" });
  const args = deps.calls[0][1];
  assert.equal(args.at(-2), "--", "the prompt must follow a -- terminator");
  assert.ok(args.indexOf("--allowed-tools") < args.indexOf("--"));
});

test("denies every tool that can write or execute", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Q?"}]}', "s")] });
  await new WorktreePlanner(deps).start({ repositoryId: REPO_ID, goal: "Add billing" });
  const args = deps.calls[0][1];
  const denied = args[args.indexOf("--disallowed-tools") + 1].split(",");
  for (const tool of ["Bash", "Write", "Edit", "Task", "Skill"]) {
    assert.ok(denied.includes(tool), `${tool} must be denied`);
  }
  const allowed = args[args.indexOf("--allowed-tools") + 1].split(",");
  assert.deepEqual(allowed, ["Read", "Grep", "Glob"]);
});

test("rejects an answer whose question no longer exists", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Which database?"}]}', "sess-a")] });
  const planner = new WorktreePlanner(deps);
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  await assert.rejects(
    () => planner.answer(draft.planId, { answers: [{ id: "q9", text: "Postgres" }] }),
    /no longer matches the question/,
  );
});

test("refuses to resume a session the planner stopped reporting", async () => {
  const deps = fakeDeps({ replies: [
    envelope('{"questions":[{"text":"Which database?"}]}', "sess-a"),
    JSON.stringify({ result: '{"questions":[{"text":"And the cache?"}]}' }),
  ] });
  const planner = new WorktreePlanner(deps);
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  await assert.rejects(
    () => planner.answer(draft.planId, { answers: [{ id: "q1", text: "Postgres" }] }),
    /lost its session/,
  );
});

test("drops the oldest draft instead of growing without limit", async () => {
  const reply = envelope('{"questions":[{"text":"Q?"}]}', "sess-a");
  const deps = fakeDeps({ replies: Array.from({ length: 60 }, () => reply) });
  const planner = new WorktreePlanner(deps);
  for (let index = 0; index < 60; index += 1) {
    await planner.start({ repositoryId: REPO_ID, goal: `Goal ${index}` });
  }
  assert.ok(planner.drafts.size <= 50, `held ${planner.drafts.size} drafts`);
});
