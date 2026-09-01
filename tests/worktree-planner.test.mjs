import assert from "node:assert/strict";
import test from "node:test";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";
import { WorktreePlanner, assignAgents, describeRunFailure, finalEnvelope, parsePlannerReply, progressEvent } from "../server/worktree-planner.mjs";

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

test("names the missing claude CLI when ccs reports E301", async () => {
  const stderr = [
    "   \u001b[31m\u2554\u2550\u2550 ERROR \u2550\u2550\u2557\u001b[0m",
    "   \u2551   Claude CLI not found   \u2551",
    "   \u2551   CCS requires Claude CLI to be installed   \u2551",
    "   \u2551   and available in PATH.   \u2551",
    "   \u255a\u2550\u2550\u2550\u255d",
    "",
    "Error: E301",
    "https://docs.ccs.kaitran.ca/reference/error-codes#e301",
  ].join("\n");
  const failed = Object.assign(new Error("Command failed"), { stderr });
  const deps = fakeDeps({ replies: [failed] });
  const planner = new WorktreePlanner(deps);
  await assert.rejects(
    () => planner.start({ repositoryId: REPO_ID, goal: "Add billing" }),
    /cannot find the claude CLI on PATH/,
  );
  assert.equal(deps.calls.filter((call) => call[0] === "ccs").length, 1);
});

test("describeRunFailure keeps the last real line and drops the docs URL", () => {
  const stderr = "\u2500\u2500 ERROR \u2500\u2500\nThe account is out of quota\nhttps://example.com/docs";
  assert.equal(describeRunFailure(stderr), "The planner could not run: The account is out of quota");
  assert.equal(describeRunFailure(""), "The planner could not run. Try again");
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
  for (const tool of ["Bash", "Write", "Edit", "Task"]) {
    assert.ok(denied.includes(tool), `${tool} must be denied`);
  }
  // Skill needs no entry: --disable-slash-commands loads no skill at all, so the
  // tool is absent from the session rather than merely refused.
  assert.ok(!denied.includes("Skill"));
  const allowed = args[args.indexOf("--allowed-tools") + 1].split(",");
  assert.deepEqual(allowed, ["Read", "Grep", "Glob"]);
});

test("runs the planner with no plugin, no skill and no MCP server", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Q?"}]}', "s")] });
  await new WorktreePlanner(deps).start({ repositoryId: REPO_ID, goal: "Add billing" });
  const args = deps.calls[0][1];
  assert.ok(args.includes("--strict-mcp-config"), "no MCP server may load");
  assert.ok(args.includes("--disable-slash-commands"), "no skill may load");
  assert.ok(args.includes("--setting-sources"), "no settings file may load");
});

test("passes an empty setting source rather than dropping the flag", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Q?"}]}', "s")] });
  await new WorktreePlanner(deps).start({ repositoryId: REPO_ID, goal: "Add billing" });
  const args = deps.calls[0][1];
  // A missing value would silently un-isolate the planner: the next flag would
  // become the source list, and the user's plugins would load again.
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
});

test("puts every isolation flag before the prompt terminator", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Q?"}]}', "s")] });
  await new WorktreePlanner(deps).start({ repositoryId: REPO_ID, goal: "Add billing" });
  const args = deps.calls[0][1];
  const terminator = args.indexOf("--");
  assert.equal(args.at(-2), "--");
  for (const flag of ["--setting-sources", "--strict-mcp-config", "--disable-slash-commands"]) {
    assert.ok(args.indexOf(flag) < terminator, `${flag} must precede the terminator`);
  }
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

function launchDeps({ createFails = null, gitFails = null } = {}) {
  const base = fakeDeps({ replies: [envelope('{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}', "sess-a")] });
  base.worktrees.create = async (repositoryId, options) => {
    base.calls.push(["create", repositoryId, options]);
    if (createFails && options.branch === createFails) throw new TypeError("That branch already has a worktree");
    return { created: true, worktree: { id: "w1", branch: options.branch, path: `/repo/sample-${options.branch.replace(/\W+/g, "-")}` } };
  };
  base.git = async (cwd, args) => {
    base.calls.push(["git", args]);
    if (args[0] === "symbolic-ref") return "origin/main\n";
    if (args[0] === "fetch" && gitFails) throw Object.assign(new Error("fetch failed"), { stderr: "fatal: could not resolve host: github.com" });
    return "";
  };
  return base;
}

async function readyDraft(planner) {
  return planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
}

test("creates one worktree and one session per task", async () => {
  const deps = launchDeps();
  const planner = new WorktreePlanner(deps);
  const draft = await readyDraft(planner, deps);
  const result = await planner.launch(draft.planId);
  assert.equal(result.base, "origin/main");
  assert.deepEqual(result.results.map((item) => item.status), ["launched"]);
  const create = deps.calls.find((call) => call[0] === "create");
  assert.deepEqual(create[2], { branch: "feature/billing", base: "origin/main" });
  const workspace = deps.calls.find((call) => call[0] === "workspace");
  assert.equal(workspace[1].agent, "claude");
  assert.equal(workspace[1].title, "Billing");
  assert.equal(workspace[1].cwd, "/repo/sample-feature-billing");
  assert.match(workspace[1].prompt, /^Add billing\.\n\nFinish with a pull request:/);
});

test("fetches the default branch before it creates anything", async () => {
  const deps = launchDeps();
  const planner = new WorktreePlanner(deps);
  const draft = await readyDraft(planner, deps);
  await planner.launch(draft.planId);
  const fetchAt = deps.calls.findIndex((call) => call[0] === "git" && call[1][0] === "fetch");
  const createAt = deps.calls.findIndex((call) => call[0] === "create");
  assert.ok(fetchAt !== -1, "it must fetch");
  assert.ok(fetchAt < createAt, "the fetch must come first");
  assert.deepEqual(deps.calls[fetchAt][1], ["fetch", "origin", "main"]);
});

test("a failed task does not stop the earlier task", async () => {
  const deps = launchDeps({ createFails: "feature/boom" });
  const planner = new WorktreePlanner(deps);
  const draft = await readyDraft(planner, deps);
  await planner.update(draft.planId, { tasks: [
    { id: "t1", title: "Good", branch: "feature/good", prompt: "Do it.", agent: "claude" },
    { id: "t2", title: "Bad", branch: "feature/boom", prompt: "Do it.", agent: "codex" },
    { id: "t3", title: "After", branch: "feature/after", prompt: "Do it.", agent: "claude" },
  ] });
  const result = await planner.launch(draft.planId);
  assert.deepEqual(result.results.map((item) => item.status), ["launched", "failed", "launched"]);
  assert.match(result.results[1].error, /already has a worktree/);
  assert.equal(deps.calls.filter((call) => call[0] === "workspace").length, 2);
});

test("reports a failed session without losing the worktree", async () => {
  const deps = launchDeps();
  deps.cmux.workspaceCreate = async () => { throw new Error("cmux is not running"); };
  const planner = new WorktreePlanner(deps);
  const draft = await readyDraft(planner, deps);
  const result = await planner.launch(draft.planId);
  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].error, /cmux is not running/);
  assert.equal(result.results[0].path, "/repo/sample-feature-billing");
});

test("stops the launch when the fetch fails", async () => {
  const deps = launchDeps({ gitFails: true });
  const planner = new WorktreePlanner(deps);
  const draft = await readyDraft(planner, deps);
  await assert.rejects(() => planner.launch(draft.planId), /could not fetch/i);
  assert.equal(deps.calls.filter((call) => call[0] === "create").length, 0);
});

test("falls back to main when the default branch cannot be read", async () => {
  const deps = launchDeps();
  deps.git = async (cwd, args) => {
    deps.calls.push(["git", args]);
    if (args[0] === "symbolic-ref") throw new Error("no origin/HEAD");
    return "";
  };
  const planner = new WorktreePlanner(deps);
  const draft = await readyDraft(planner, deps);
  const result = await planner.launch(draft.planId);
  assert.equal(result.base, "origin/main");
});

test("rejects a launch while questions are still open", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Which database?"}]}', "sess-a")] });
  const planner = new WorktreePlanner(deps);
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  await assert.rejects(() => planner.launch(draft.planId), /not ready/i);
});

test("forgets the plan after a launch so it cannot run twice", async () => {
  const deps = launchDeps();
  const planner = new WorktreePlanner(deps);
  const draft = await readyDraft(planner);
  const result = await planner.launch(draft.planId);
  assert.equal(result.launched, 1);
  await assert.rejects(() => planner.launch(draft.planId), /Unknown plan/);
});

test("keeps the plan when every task failed", async () => {
  const deps = launchDeps();
  deps.cmux.workspaceCreate = async () => { throw new Error("cmux is not running"); };
  const planner = new WorktreePlanner(deps);
  const draft = await readyDraft(planner);
  const first = await planner.launch(draft.planId);
  assert.equal(first.launched, 0);
  assert.equal(first.results[0].status, "failed");
  const second = await planner.launch(draft.planId);
  assert.equal(second.results[0].status, "failed");
});

test("handles a full ref path from symbolic-ref", async () => {
  const deps = launchDeps();
  deps.git = async (cwd, args) => {
    deps.calls.push(["git", args]);
    if (args[0] === "symbolic-ref") return "refs/remotes/origin/develop\n";
    return "";
  };
  const planner = new WorktreePlanner(deps);
  const draft = await readyDraft(planner);
  const result = await planner.launch(draft.planId);
  assert.equal(result.base, "origin/develop");
  assert.deepEqual(deps.calls.find((call) => call[0] === "git" && call[1][0] === "fetch")[1], ["fetch", "origin", "develop"]);
});

test("refuses a task whose branch already exists", async () => {
  const deps = launchDeps();
  deps.worktrees.create = async (repositoryId, options) => {
    deps.calls.push(["create", repositoryId, options]);
    return { created: true, branchCreated: false, worktree: { id: "w1", branch: options.branch, path: "/repo/sample-old" } };
  };
  const planner = new WorktreePlanner(deps);
  const draft = await readyDraft(planner);
  const result = await planner.launch(draft.planId);
  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].error, /already exists/);
  assert.equal(result.launched, 0);
  assert.equal(deps.calls.filter((call) => call[0] === "workspace").length, 0);
});

test("shows the first git line when the fetch fails", async () => {
  const deps = launchDeps();
  deps.git = async (cwd, args) => {
    if (args[0] === "symbolic-ref") return "origin/main\n";
    throw Object.assign(new Error("fetch failed"), {
      stderr: "fatal: 'origin' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n",
    });
  };
  const planner = new WorktreePlanner(deps);
  const draft = await readyDraft(planner);
  await assert.rejects(() => planner.launch(draft.planId), /does not appear to be a git repository/);
});

test("asks the remote for the default branch when no local ref exists", async () => {
  const deps = launchDeps();
  deps.git = async (cwd, args) => {
    deps.calls.push(["git", args]);
    if (args[0] === "symbolic-ref") throw new Error("no origin/HEAD");
    if (args[0] === "ls-remote") return "ref: refs/heads/master\tHEAD\nabc123\tHEAD\n";
    return "";
  };
  const planner = new WorktreePlanner(deps);
  const draft = await readyDraft(planner);
  const result = await planner.launch(draft.planId);
  assert.equal(result.base, "origin/master");
  assert.deepEqual(deps.calls.find((call) => call[0] === "git" && call[1][0] === "fetch")[1], ["fetch", "origin", "master"]);
});

const IMAGES = [
  { path: "/attachments/one.png", name: "one.png" },
  { path: "/attachments/two.png", name: "two.png" },
];

test("rejects more than four attached images", async () => {
  const planner = new WorktreePlanner(fakeDeps({ replies: [] }));
  const images = Array.from({ length: 5 }, (_, index) => ({ path: `/attachments/${index}.png`, name: `${index}.png` }));
  await assert.rejects(() => planner.start({ repositoryId: REPO_ID, goal: "Add billing", images }), /at most 4 images/);
});

test("rejects an images value that is not a list", async () => {
  const planner = new WorktreePlanner(fakeDeps({ replies: [] }));
  await assert.rejects(() => planner.start({ repositoryId: REPO_ID, goal: "Add billing", images: "one.png" }), /must be a list/);
});

test("rejects an image entry with no string path", async () => {
  const planner = new WorktreePlanner(fakeDeps({ replies: [] }));
  await assert.rejects(() => planner.start({ repositoryId: REPO_ID, goal: "Add billing", images: [{ name: "one.png" }] }), /needs a file path/);
});

test("puts the image paths into the planner prompt", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Which database?"}]}', "sess-a")] });
  const planner = new WorktreePlanner(deps);
  await planner.start({ repositoryId: REPO_ID, goal: "Add billing", images: IMAGES });
  const prompt = deps.calls.find((call) => call[0] === "ccs")[1].at(-1);
  assert.match(prompt, /Attached images:/);
  assert.match(prompt, /- \/attachments\/one\.png/);
  assert.match(prompt, /- \/attachments\/two\.png/);
  assert.match(prompt, /Read each image with the Read tool/);
});

test("a goal with no images produces the prompt that exists today", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Which database?"}]}', "sess-a")] });
  const planner = new WorktreePlanner(deps);
  await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  const prompt = deps.calls.find((call) => call[0] === "ccs")[1].at(-1);
  assert.ok(!prompt.includes("Attached image"));
  assert.match(prompt, /Repository: sample at \/repo\/sample\nGoal: Add billing\n\nRead the repository/);
});

test("appends the image paths to every launched task prompt", async () => {
  const deps = launchDeps();
  const planner = new WorktreePlanner(deps);
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing", images: IMAGES });
  await planner.update(draft.planId, { tasks: [
    { id: "t1", title: "Good", branch: "feature/good", prompt: "Do it.", agent: "claude" },
    { id: "t2", title: "Also", branch: "feature/also", prompt: "Do that.", agent: "codex" },
  ] });
  await planner.launch(draft.planId);
  const prompts = deps.calls.filter((call) => call[0] === "workspace").map((call) => call[1].prompt);
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    assert.match(prompt, /Attached images:\n- \/attachments\/one\.png\n- \/attachments\/two\.png\n\nFinish your task branch for combined delivery:/);
    assert.match(prompt, /Do not open a pull request/);
  }
  assert.ok(prompts[0].startsWith("Do it.\n\n"));
});

test("a launched task keeps its own prompt when no image is attached", async () => {
  const deps = launchDeps();
  const planner = new WorktreePlanner(deps);
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  await planner.launch(draft.planId);
  const workspace = deps.calls.find((call) => call[0] === "workspace");
  assert.ok(workspace[1].prompt.startsWith("Add billing."));
  assert.ok(!workspace[1].prompt.includes("Attached image"));
});

test("multi-task goals push task branches without opening individual pull requests", async () => {
  const deps = launchDeps();
  const planner = new WorktreePlanner(deps);
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  await planner.update(draft.planId, { tasks: [
    { id: "t1", title: "Good", branch: "feature/good", prompt: "Do it.", agent: "claude" },
    { id: "t2", title: "Also", branch: "feature/also", prompt: "Do that.", agent: "codex" },
  ] });
  await planner.launch(draft.planId);
  const prompts = deps.calls.filter((call) => call[0] === "workspace").map((call) => call[1].prompt);
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    assert.match(prompt, /Finish your task branch for combined delivery:/);
    assert.match(prompt, /Push this task branch to origin/);
    assert.match(prompt, /Do not open a pull request/);
    assert.match(prompt, /Cmux-Goal-Ready: .+\/t[12]/);
    assert.ok(!prompt.includes("gh pr create"));
  }
});

test("single-task goals keep the direct pull request workflow", async () => {
  const deps = launchDeps();
  const planner = new WorktreePlanner(deps);
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  const result = await planner.launch(draft.planId);
  const prompt = deps.calls.find((call) => call[0] === "workspace")[1].prompt;
  assert.equal(result.deliveryMode, "single");
  assert.match(prompt, /Finish with a pull request:/);
  assert.match(prompt, /gh pr create/);
  assert.match(prompt, /pull request against main\b/);
});

test("a one-task issue topic is forced through Companion's combined delivery branch", async () => {
  const deps = launchDeps();
  const planner = new WorktreePlanner(deps);
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Fix linked issues", issueNumbers: [54, 55], issueUrls: ["https://github.com/acme/app/issues/54"], deliveryPolicy: "combined" });
  assert.deepEqual(draft.issueNumbers, [54, 55]);
  assert.equal(draft.deliveryMode, "combined");
  const result = await planner.launch(draft.planId);
  const prompt = deps.calls.find((call) => call[0] === "workspace")[1].prompt;
  assert.equal(result.deliveryMode, "combined");
  assert.match(prompt, /Finish your task branch for combined delivery/);
  assert.doesNotMatch(prompt, /Closes #54|gh pr create/);
});

test("names a master default branch rather than assuming main", async () => {
  const deps = launchDeps();
  deps.git = async (cwd, args) => {
    deps.calls.push(["git", args]);
    if (args[0] === "symbolic-ref") return "origin/master\n";
    return "";
  };
  const planner = new WorktreePlanner(deps);
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  const result = await planner.launch(draft.planId);
  assert.equal(result.base, "origin/master");
  assert.match(deps.calls.find((call) => call[0] === "workspace")[1].prompt, /pull request against master\b/);
});

test("tells the planner not to write its own pull request instructions", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Which database?"}]}', "sess-a")] });
  const planner = new WorktreePlanner(deps);
  await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  const prompt = deps.calls.find((call) => call[0] === "ccs")[1].at(-1);
  assert.match(prompt, /Do not tell a task to commit, push, or open a pull request/);
});

function streamLine(value) { return JSON.stringify(value); }
function assistantLine(...content) { return streamLine({ type: "assistant", message: { content } }); }
function resultLine(text, sessionId = "sess-a") { return streamLine({ type: "result", subtype: "success", session_id: sessionId, result: text }); }

test("turns a tool_use line into a short label and never the whole input", () => {
  const read = progressEvent(assistantLine({ type: "tool_use", name: "Read", input: { file_path: "/repo/sample/server/app.mjs", offset: 40, limit: 200 } }));
  assert.deepEqual(read, { k: "tool", t: "Read server/app.mjs" });
  const grep = progressEvent(assistantLine({ type: "tool_use", name: "Grep", input: { pattern: "worktree-plans", path: "/repo/secret" } }));
  assert.deepEqual(grep, { k: "tool", t: 'Grep "worktree-plans"' });
  assert.ok(!grep.t.includes("secret"));
  assert.ok(!read.t.includes("200"));
});

test("reports prose without repeating what the planner is thinking", () => {
  assert.deepEqual(progressEvent(assistantLine({ type: "text", text: "The billing module lives in server/billing.mjs and holds the secret key" })), { k: "text", t: "Thinking…" });
});

test("names an unknown tool without inventing a detail", () => {
  assert.deepEqual(progressEvent(assistantLine({ type: "tool_use", name: "Skill", input: { command: "anything" } })), { k: "tool", t: "Skill" });
});

test("drops system, hook and user lines", () => {
  for (const line of [
    streamLine({ type: "system", subtype: "init", session_id: "sess-a" }),
    streamLine({ type: "system", subtype: "hook_started" }),
    streamLine({ type: "system", subtype: "hook_response" }),
    streamLine({ type: "system", subtype: "notification" }),
    streamLine({ type: "user", message: { content: [] } }),
    resultLine("{}"),
    "not json at all",
    "",
  ]) assert.equal(progressEvent(line), null, `line should be dropped: ${line.slice(0, 40)}`);
});

test("reads the plan from the final stream-json result line", () => {
  const stdout = [
    streamLine({ type: "system", subtype: "init", session_id: "sess-a" }),
    assistantLine({ type: "tool_use", name: "Read", input: { file_path: "/repo/sample/package.json" } }),
    resultLine('{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}'),
    "",
  ].join("\n");
  const reply = parsePlannerReply(finalEnvelope(stdout));
  assert.equal(reply.sessionId, "sess-a");
  assert.equal(reply.status, "ready");
  assert.equal(reply.tasks[0].branch, "feature/billing");
});

test("still parses the plain envelope a non-streaming run produces", () => {
  const plain = envelope('{"questions":[{"text":"Which database?"}]}', "sess-a");
  assert.equal(finalEnvelope(plain), plain);
  assert.equal(parsePlannerReply(finalEnvelope(plain)).status, "questions");
});

test("asks ccs for stream-json with verbose and still terminates the flags", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Which database?"}]}', "sess-a")] });
  const planner = new WorktreePlanner(deps);
  await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  const args = deps.calls.find((call) => call[0] === "ccs")[1];
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(args.includes("--verbose"));
  assert.equal(args.at(-2), "--");
});

// A fake execute that feeds NDJSON lines through onLine, the way the real
// streaming runner does, then resolves with the whole buffer.
function streamingDeps(lines) {
  const deps = fakeDeps({ replies: [] });
  deps.execute = async (bin, args, options) => {
    deps.calls.push([bin, args, options]);
    for (const line of lines) options.onLine?.(line);
    return { stdout: `${lines.join("\n")}\n` };
  };
  return deps;
}

test("reports each tool call before the round resolves", async () => {
  const lines = [
    streamLine({ type: "system", subtype: "init", session_id: "sess-a" }),
    assistantLine({ type: "tool_use", name: "Read", input: { file_path: "/repo/sample/server/app.mjs" } }),
    assistantLine({ type: "tool_use", name: "Grep", input: { pattern: "worktree-plans" } }),
    resultLine('{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}'),
  ];
  const seen = [];
  let resolved = false;
  const planner = new WorktreePlanner(streamingDeps(lines));
  const pending = planner.start({ repositoryId: REPO_ID, goal: "Add billing", onEvent: (event) => { seen.push([event, resolved]); } });
  const draft = await pending;
  resolved = true;
  assert.equal(draft.status, "ready");
  assert.deepEqual(seen.map(([event]) => event.t), ["Read server/app.mjs", 'Grep "worktree-plans"']);
  assert.deepEqual(seen.map(([, after]) => after), [false, false], "every step must arrive before the round resolves");
});

test("sends no progress when the caller asked for none", async () => {
  const deps = streamingDeps([resultLine('{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}')]);
  const planner = new WorktreePlanner(deps);
  await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  assert.equal(deps.calls.find((call) => call[0] === "ccs")[2].onLine, undefined);
});

test("a throwing progress consumer never fails the round", async () => {
  const lines = [
    assistantLine({ type: "tool_use", name: "Read", input: { file_path: "/repo/sample/package.json" } }),
    resultLine('{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}'),
  ];
  const planner = new WorktreePlanner(streamingDeps(lines));
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing", onEvent: () => { throw new Error("the browser went away"); } });
  assert.equal(draft.status, "ready");
});

test("says it is retrying when the first sample was unusable", async () => {
  const deps = fakeDeps({ replies: [envelope("no json here"), envelope('{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}', "sess-a")] });
  const planner = new WorktreePlanner(deps);
  const seen = [];
  await planner.start({ repositoryId: REPO_ID, goal: "Add billing", onEvent: (event) => seen.push(event.t) });
  assert.deepEqual(seen, ["Retrying…"]);
});

// --- persistence ---------------------------------------------------------

function storedPlanner(options = {}) {
  const store = new WorktreePlanStore({ path: ":memory:" });
  const deps = fakeDeps({ replies: options.replies || [] });
  const planner = new WorktreePlanner({ ...deps, ...options.planner, store });
  return { store, deps, planner };
}

const TASKS_REPLY = envelope('{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}', "sess-a");
const QUESTIONS_REPLY = envelope('{"questions":[{"text":"Which database?"}]}', "sess-a");

test("saves the goal, the session id and the questions of a first round", async (t) => {
  const { store, planner } = storedPlanner({ replies: [QUESTIONS_REPLY] });
  t.after(() => store.close());
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  const saved = store.get(draft.planId);
  assert.equal(saved.goal, "Add billing");
  assert.equal(saved.repositoryId, REPO_ID);
  assert.equal(saved.cwd, "/repo/sample");
  assert.equal(saved.sessionId, "sess-a");
  assert.equal(saved.round, 1);
  assert.equal(saved.stage, "questions");
  assert.equal(saved.questions[0].text, "Which database?");
  assert.deepEqual(store.events(draft.planId).map((event) => event.kind), ["goal", "questions"]);
});

test("saves the submitted answers with their question text", async (t) => {
  const { store, planner } = storedPlanner({ replies: [QUESTIONS_REPLY, TASKS_REPLY] });
  t.after(() => store.close());
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  await planner.answer(draft.planId, { answers: [{ id: "q1", text: "Postgres" }] });
  const answers = store.events(draft.planId).find((event) => event.kind === "answers");
  assert.equal(answers.payload.answers[0].question, "Which database?");
  assert.equal(answers.payload.answers[0].text, "Postgres");
  assert.equal(answers.payload.skipped, false);
});

test("saves a skipped round as skipped", async (t) => {
  const { store, planner } = storedPlanner({ replies: [QUESTIONS_REPLY, TASKS_REPLY] });
  t.after(() => store.close());
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  await planner.answer(draft.planId, { skip: true });
  const answers = store.events(draft.planId).find((event) => event.kind === "answers");
  assert.equal(answers.payload.skipped, true);
});

test("saves the assigned tasks of a ready round", async (t) => {
  const { store, planner } = storedPlanner({ replies: [TASKS_REPLY] });
  t.after(() => store.close());
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  const saved = store.get(draft.planId);
  assert.equal(saved.stage, "ready");
  assert.equal(saved.tasks.length, 1);
  assert.equal(saved.tasks[0].branch, "feature/billing");
  assert.equal(saved.tasks[0].agent, "claude");
  assert.match(saved.tasks[0].agentReason, /Claude/);
});

test("saves a user edit as its own event", async (t) => {
  const { store, planner } = storedPlanner({ replies: [TASKS_REPLY] });
  t.after(() => store.close());
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  await planner.update(draft.planId, { tasks: [{ id: "t1", title: "Renamed", branch: "feature/renamed", prompt: "Add billing.", agent: "codex" }] });
  const saved = store.get(draft.planId);
  assert.equal(saved.tasks[0].title, "Renamed");
  assert.equal(saved.tasks[0].agent, "codex");
  assert.equal(store.events(draft.planId).at(-1).kind, "edit");
});

test("saves the launch outcome of each task", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const planner = new WorktreePlanner({ ...launchDeps(), store });
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  await planner.launch(draft.planId);
  const saved = store.get(draft.planId);
  assert.equal(saved.status, "launched");
  assert.equal(saved.baseRef, "origin/main");
  assert.ok(saved.launchedAt);
  assert.equal(saved.tasks[0].launchStatus, "launched");
  assert.equal(saved.tasks[0].worktreePath, "/repo/sample-feature-billing");
  assert.equal(saved.tasks[0].workspaceId, "ws-1");
  assert.equal(store.events(draft.planId).at(-1).kind, "launch");
});

test("saves a failed launch with its reason and keeps the plan a draft", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const planner = new WorktreePlanner({ ...launchDeps({ createFails: "feature/billing" }), store });
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  await planner.launch(draft.planId);
  const saved = store.get(draft.planId);
  assert.equal(saved.status, "draft");
  assert.equal(saved.tasks[0].launchStatus, "failed");
  assert.match(saved.tasks[0].launchError, /already has a worktree/);
});

test("answers a plan the memory cache has forgotten", async (t) => {
  const { store, planner } = storedPlanner({ replies: [QUESTIONS_REPLY, TASKS_REPLY], planner: { ttlMs: -1 } });
  t.after(() => store.close());
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  const next = await planner.answer(draft.planId, { answers: [{ id: "q1", text: "Postgres" }] });
  assert.equal(next.status, "ready");
  assert.equal(next.round, 2);
});

test("resumes a forgotten plan on the same ccs session", async (t) => {
  const { store, deps, planner } = storedPlanner({ replies: [QUESTIONS_REPLY, TASKS_REPLY], planner: { ttlMs: -1 } });
  t.after(() => store.close());
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  const resumed = await planner.resume(draft.planId);
  assert.equal(resumed.planId, draft.planId);
  assert.equal(resumed.goal, "Add billing");
  assert.equal(resumed.round, 1);
  assert.equal(resumed.questions[0].text, "Which database?");
  await planner.answer(draft.planId, { skip: true });
  const args = deps.calls.filter((call) => call[0] === "ccs").at(-1)[1];
  assert.ok(args.includes("--resume"));
  assert.equal(args[args.indexOf("--resume") + 1], "sess-a");
});

test("a new planner reloads a plan the previous process started", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const first = new WorktreePlanner({ ...fakeDeps({ replies: [QUESTIONS_REPLY] }), store });
  const draft = await first.start({ repositoryId: REPO_ID, goal: "Add billing" });

  const second = new WorktreePlanner({ ...fakeDeps({ replies: [TASKS_REPLY] }), store });
  const resumed = await second.resume(draft.planId);
  assert.equal(resumed.goal, "Add billing");
  assert.equal(resumed.status, "questions");
  const next = await second.answer(draft.planId, { answers: [{ id: "q1", text: "Postgres" }] });
  assert.equal(next.status, "ready");
  assert.equal(next.tasks[0].branch, "feature/billing");
});

test("refuses to resume a plan that already launched", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const planner = new WorktreePlanner({ ...launchDeps(), store });
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  await planner.launch(draft.planId);
  await assert.rejects(() => planner.resume(draft.planId), /already launched/);
});

test("lists saved plans newest first", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  let tick = 0;
  store.now = () => new Date(1_700_000_000_000 + (tick += 1_000));
  const planner = new WorktreePlanner({ ...fakeDeps({ replies: [QUESTIONS_REPLY, QUESTIONS_REPLY] }), store });
  const first = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  const second = await planner.start({ repositoryId: REPO_ID, goal: "Add invoices" });
  const { plans } = await planner.list();
  assert.deepEqual(plans.map((plan) => plan.planId), [second.planId, first.planId]);
  assert.equal(plans[0].goal, "Add invoices");
  assert.equal(plans[0].taskCount, 0);
});

test("returns a saved plan with its whole event log", async (t) => {
  const { store, planner } = storedPlanner({ replies: [QUESTIONS_REPLY, TASKS_REPLY] });
  t.after(() => store.close());
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  await planner.answer(draft.planId, { answers: [{ id: "q1", text: "Postgres" }] });
  const detail = await planner.detail(draft.planId);
  assert.equal(detail.goal, "Add billing");
  assert.equal(detail.tasks[0].branch, "feature/billing");
  assert.deepEqual(detail.events.map((event) => event.kind), ["goal", "questions", "answers", "tasks"]);
});

test("deletes a plan and forgets it", async (t) => {
  const { store, planner } = storedPlanner({ replies: [QUESTIONS_REPLY] });
  t.after(() => store.close());
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  assert.deepEqual(await planner.remove(draft.planId), { planId: draft.planId, deleted: true });
  assert.equal(store.get(draft.planId), null);
  await assert.rejects(() => planner.remove(draft.planId), /Unknown plan/);
  await assert.rejects(() => planner.resume(draft.planId), /Unknown plan/);
});

test("rejects an unknown plan id", async (t) => {
  const { store, planner } = storedPlanner({ replies: [] });
  t.after(() => store.close());
  await assert.rejects(() => planner.detail("nope"), /Unknown plan/);
  await assert.rejects(() => planner.resume("nope"), /Unknown plan/);
});

test("still answers the round when the store write fails", async (t) => {
  const warnings = [];
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  store.recordRound = () => { throw new Error("disk is full"); };
  const planner = new WorktreePlanner({
    ...fakeDeps({ replies: [QUESTIONS_REPLY] }),
    store,
    log: { warn: (...args) => warnings.push(args) },
  });
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  assert.equal(draft.status, "questions");
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][1]), /plan store write failed/);
});

test("runs without a store at all", async () => {
  const planner = new WorktreePlanner(fakeDeps({ replies: [QUESTIONS_REPLY] }));
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  assert.equal(draft.status, "questions");
  assert.deepEqual((await planner.list()).plans, []);
  await assert.rejects(() => planner.detail(draft.planId), /Unknown plan/);
});
