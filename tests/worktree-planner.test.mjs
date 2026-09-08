import { seedLegacyPlan } from "./helpers/legacy-plan-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBriefs } from "../server/agent-brief.mjs";
import { selectTaskBranchCandidate, taskBranchCandidates } from "../server/task-branch.mjs";
import { WORKTREE_REASONS, worktreeStateError } from "../server/worktree-errors.mjs";
import { LaunchRuns } from "../server/launch-runs.mjs";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";
import { PLANNER_ENGINES, WorktreePlanner, assignAgents, describeRunFailure, describeTimeout, finalEnvelope, normalizePlannerEngine, parseDiscussionReply, parsePlannerReply, progressEvent, streamExecFile } from "../server/worktree-planner.mjs";

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
  assert.deepEqual(reply.tasks[0], {
    id: "t1", title: "Add API", branch: "feature/api", prompt: "Build the API.", type: "feature",
    criterionIds: ["AC-1"], dependsOn: [], ownedAreas: ["**/*"],
    verification: ["Run the repository verification appropriate for this task"],
  });
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
const DESIGN_OPTIONS = { unitTests: false, e2eTests: false, edgeCases: false, refactorPass: false, screenMocks: true, flowcharts: true };

test("the review request never reaches a planner prompt or a task brief", async () => {
  // A code review happens after the pull request exists. The planner can
  // neither plan for it nor evidence it, so asking would only invite a task
  // and an acceptance criterion for work that is not part of the delivery.
  const reviewOptions = { codeReview: true, reviewer: "codex", reviewerModel: "gpt-5.6-sol" };
  const deps = launchDeps();
  const planner = new WorktreePlanner(deps);
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing", reviewOptions });

  const prompts = deps.calls.filter((call) => call[0] === "ccs").map((call) => String(call[1].at(-1)));
  for (const prompt of prompts) {
    assert.equal(/codeReview|reviewOptions/i.test(prompt), false, "planner prompt names the review request");
  }

  await planner.launch(draft.planId);
  const brief = briefText(deps.calls.find((call) => call[0] === "workspace")[1].prompt);
  assert.equal(/codeReview|reviewOptions/i.test(brief), false, "task brief names the review request");

  // It is still carried on the draft, because the integrator reads it once
  // the pull request exists.
  assert.deepEqual(draft.reviewOptions, reviewOptions);
});

test("parsePlannerReply applies the option-aware contract limits", () => {
  const spec = {
    outcome: "Ship billing",
    acceptanceCriteria: [{ id: "AC-1", text: "Billing works", verification: "npm test" }],
    designArtifacts: [{
      id: "F1",
      kind: "flow",
      title: "Checkout",
      nodes: Array.from({ length: 24 }, (unused, index) => ({ id: `n${index + 1}`, label: "x".repeat(120), kind: "step" })),
      edges: Array.from({ length: 23 }, (unused, index) => ({ from: `n${index + 1}`, to: `n${index + 2}`, label: "y".repeat(120) })),
    }],
  };
  const tasks = [{
    id: "T1", title: "Billing", branch: "feature/billing", prompt: "x".repeat(11_700), type: "feature",
    criterionIds: ["AC-1"], dependsOn: [], ownedAreas: ["server/**"], verification: ["npm test"],
  }];
  const reply = envelope(JSON.stringify({ spec, tasks }));
  // The same reply is fine without the requests and oversized with them, so
  // the option text is what crosses the brief limit.
  assert.equal(parsePlannerReply(reply).status, "ready");
  assert.throws(() => parsePlannerReply(reply, DESIGN_OPTIONS), /oversized brief file/);
});

test("a task brief carries the enabled instructions, the evidence and every artifact", async () => {
  const spec = {
    outcome: "Ship billing",
    acceptanceCriteria: [{ id: "AC-1", text: "Billing works", verification: "npm test" }],
    optionEvidence: {
      unitTests: { status: "planned", rationale: "Covered by the billing suite", taskIds: ["T1"], criterionIds: ["AC-1"] },
      screenMocks: { status: "planned", rationale: "", taskIds: ["T1"], criterionIds: ["AC-1"] },
      flowcharts: { status: "not_applicable", rationale: "The goal changes no flow", taskIds: [], criterionIds: [] },
    },
    designArtifacts: [
      { id: "F1", kind: "flow", title: "Checkout", nodes: [{ id: "n1", label: "Open cart", kind: "start" }, { id: "n2", label: "Pay", kind: "end" }], edges: [{ from: "n1", to: "n2", label: "confirms" }] },
      { id: "S1", kind: "screen", title: "Billing page", summary: "The total line moves above the fold.", screen: { name: "Billing", elements: [{ id: "e1", label: "Total due", kind: "text", change: "changed", note: "Now bold" }] } },
    ],
  };
  const options = { unitTests: true, e2eTests: false, edgeCases: false, refactorPass: false, screenMocks: true, flowcharts: true };
  const reply = JSON.stringify({
    spec,
    tasks: [{ id: "T1", title: "Billing", branch: "feature/billing", prompt: "Add billing.", type: "feature", criterionIds: ["AC-1"], dependsOn: [], ownedAreas: ["server/**"], verification: ["npm test"] }],
  });
  const deps = launchDeps({ reply });
  const planner = new WorktreePlanner(deps);
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing", specOptions: options });
  await planner.launch(draft.planId);
  const brief = briefText(deps.calls.find((call) => call[0] === "workspace")[1].prompt);

  assert.match(brief, /Requested specification rigor for this goal:/);
  assert.match(brief, /- Unit tests: Cover the new logic with unit tests\./);
  assert.match(brief, /- Screen wireframes: Return a screen wireframe for each new or changed screen\./);
  assert.equal(brief.includes("End-to-end tests:"), false);

  assert.match(brief, /Specification option evidence:/);
  assert.match(brief, /- unitTests: planned \(tasks T1; criteria AC-1\)/);
  assert.match(brief, /- flowcharts: not_applicable — The goal changes no flow/);

  assert.match(brief, /Design artifacts:/);
  assert.match(brief, /Flow F1: Checkout/);
  assert.match(brief, /- node n1 \(start\): Open cart/);
  assert.match(brief, /- edge n1 -> n2: confirms/);
  assert.match(brief, /Screen S1: Billing page/);
  assert.match(brief, /The total line moves above the fold\./);
  assert.match(brief, /- screen Billing/);
  assert.match(brief, /- changed text e1: Total due \(Now bold\)/);

  // The rigor block sits after the contract and before the finish steps.
  assert.ok(brief.indexOf("Delivery contract for this task:") < brief.indexOf("Requested specification rigor"));
  assert.ok(brief.indexOf("Design artifacts:") < brief.indexOf("Cmux-Goal-Report:"));
});

test("a task brief with no requested option keeps its original shape", async () => {
  const deps = launchDeps();
  const planner = new WorktreePlanner(deps);
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
  await planner.launch(draft.planId);
  const brief = briefText(deps.calls.find((call) => call[0] === "workspace")[1].prompt);
  assert.equal(brief.includes("Requested specification rigor"), false);
  assert.equal(brief.includes("Specification option evidence"), false);
  assert.equal(brief.includes("Design artifacts:"), false);
});

test("normalizes omitted engine fields without coercing invalid input", () => {
  const defaults = { provider: "codex", model: "gpt-6-astra", effort: "default", reviewer: false };
  assert.deepEqual(normalizePlannerEngine(undefined), defaults);
  assert.deepEqual(normalizePlannerEngine({}), defaults);
  assert.deepEqual(normalizePlannerEngine({ provider: "codex" }), defaults);
  assert.deepEqual(normalizePlannerEngine({ provider: "codex", model: "gpt-6-astra" }), defaults);
  assert.deepEqual(normalizePlannerEngine({ provider: "codex", model: "gpt-6" }), defaults);
  assert.deepEqual(normalizePlannerEngine({ provider: "claude" }), { provider: "claude", model: "default", effort: "default", reviewer: false });
  assert.ok(PLANNER_ENGINES.providers.codex.models.some((model) => model.id === "gpt-6-astra" && model.label === "Codex Astra"));
  assert.equal(PLANNER_ENGINES.providers.codex.largestModel, "gpt-5.6-sol");
  assert.throws(() => normalizePlannerEngine({ provider: "codex", model: "bad model" }), /Model must/);
  assert.throws(() => normalizePlannerEngine(null), /must be an object/);
});

test("describeRunFailure keeps the last real line and drops the docs URL", () => {
  const stderr = "\u2500\u2500 ERROR \u2500\u2500\nThe account is out of quota\nhttps://example.com/docs";
  assert.equal(describeRunFailure(stderr), "The planner could not run: The account is out of quota");
  assert.equal(describeRunFailure(""), "The planner could not run. Try again");
});

test("describeTimeout falls back when no limit is named", () => {
  assert.match(describeTimeout("", 60_000, 60_000), /did not answer in time/);
  assert.match(describeTimeout("idle", 60_000, 900_000), /no output for 1 minute\b/);
});

// The regression itself. A child that keeps printing must outlive an idle limit
// shorter than its total run, which the old single wall-clock timer could not do.
test("streamExecFile does not kill a child that keeps printing", async () => {
  const script = "let n = 0; const t = setInterval(() => { console.log(`line ${n += 1}`); if (n === 8) { clearInterval(t); } }, 50);";
  const seen = [];
  const result = await streamExecFile(process.execPath, ["-e", script], { idleTimeout: 200, timeout: 5_000, onLine: (line) => seen.push(line) });
  assert.equal(seen.length, 8);
  assert.match(result.stdout, /line 8/);
});

test("streamExecFile kills a silent child and says the idle limit did it", async () => {
  const script = "console.log('hello'); setTimeout(() => {}, 5_000);";
  await assert.rejects(
    () => streamExecFile(process.execPath, ["-e", script], { idleTimeout: 150, timeout: 5_000 }),
    (cause) => cause.killed === true && cause.reason === "idle",
  );
});

test("streamExecFile kills a chatty child at the ceiling", async () => {
  const script = "setInterval(() => console.log('tick'), 20);";
  await assert.rejects(
    () => streamExecFile(process.execPath, ["-e", script], { idleTimeout: 5_000, timeout: 250 }),
    (cause) => cause.killed === true && cause.reason === "ceiling",
  );
});

test("stores edited tasks and rejects a bad branch name", async () => {
  const deps = fakeDeps({ replies: [envelope('{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}', "sess-a")] });
  const planner = new WorktreePlanner(deps);
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
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

// cmux caps a prompt at this many characters, so a launched session gets a
// pointer and the brief itself lives in a file.
const MAX_PROMPT = 8_000;

const briefRoots = [];
process.on("exit", () => { for (const root of briefRoots) rmSync(root, { recursive: true, force: true }); });

// The prompt names the brief file. The brief content is what the agent reads.
function briefText(prompt) {
  const path = String(prompt).match(/^Read the file (.+?) in full/m)?.[1];
  assert.ok(path, `the prompt must name a brief file, got: ${prompt}`);
  return readFileSync(path, "utf8");
}

function assertPointer(prompt) {
  assert.ok(prompt.length <= MAX_PROMPT, `the prompt must stay under ${MAX_PROMPT} characters, got ${prompt.length}`);
  assert.match(prompt, /^Read the file .+ in full/m);
}

function launchDeps({ createFails = null, gitFails = null, reply = '{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}' } = {}) {
  const base = fakeDeps({ replies: [envelope(reply, "sess-a")] });
  const root = mkdtempSync(join(tmpdir(), "planner-briefs-"));
  briefRoots.push(root);
  base.briefs = new AgentBriefs({ directory: join(root, "briefs") });
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
  return seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
}

test("creates one worktree and one session per task", async () => {
  const deps = launchDeps();
  const planner = new WorktreePlanner(deps);
  const draft = await readyDraft(planner, deps);
  const result = await planner.launch(draft.planId);
  assert.equal(result.base, "origin/main");
  assert.deepEqual(result.results.map((item) => item.status), ["launched"]);
  const create = deps.calls.find((call) => call[0] === "create");
  assert.deepEqual(create[2], {
    branch: "feature/billing", base: "origin/main", reuseIfAtBase: true,
    requireFreshAtBase: true, workspaces: [], workspacesAvailable: false,
  });
  const workspace = deps.calls.find((call) => call[0] === "workspace");
  assert.equal(workspace[1].agent, "claude");
  // The session name is the scheme, not the bare task title: project code,
  // goal with its id fragment, task-part code, then the title.
  assert.match(workspace[1].title, /^SMP \u00b7 Add billing \([a-z0-9]{4}\) \u00b7 T1-feat \u00b7 Billing$/);
  // The same identity is stamped into the session's own shell, so it survives
  // a rename by the user.
  assert.equal(workspace[1].env.COMPANION_PROJECT, "SMP");
  assert.equal(workspace[1].env.COMPANION_TASK, "T1");
  assert.equal(workspace[1].env.COMPANION_PART, "feat");
  // The env fragment is the same one the title shows, so a sweep can match a
  // session to its goal without parsing the name.
  assert.ok(workspace[1].title.includes(`(${workspace[1].env.COMPANION_GOAL})`), workspace[1].title);
  assert.equal(workspace[1].cwd, "/repo/sample-feature-billing");
  assertPointer(workspace[1].prompt);
  const brief = briefText(workspace[1].prompt);
  assert.match(brief, /^Add billing\.\n\nDelivery contract for this task:/);
  assert.match(brief, /Cmux-Goal-Report:/);
  assert.match(brief, /Finish with a pull request:/);
});

test("retries an eligible initial acquisition once on the first fresh branch and persists it", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const deps = launchDeps();
  let first = true;
  deps.worktrees.create = async (repositoryId, options) => {
    deps.calls.push(["create", repositoryId, options]);
    if (first) {
      first = false;
      throw worktreeStateError("That branch already has a worktree with a running session", WORKTREE_REASONS.RUNNING_SESSION);
    }
    return { created: true, branchCreated: true, worktree: { id: "w2", branch: options.branch, path: "/repo/sample-feature-billing-2" } };
  };
  const planner = new WorktreePlanner({ ...deps, store });
  const draft = await readyDraft(planner);
  const result = await planner.launch(draft.planId);

  assert.deepEqual(deps.calls.filter((call) => call[0] === "create").map((call) => call[2].branch), ["feature/billing", "feature/billing-2"]);
  assert.equal(result.results[0].branch, "feature/billing-2");
  assert.equal(result.results[0].launchReason, null);
  assert.equal(store.get(draft.planId).tasks[0].branch, "feature/billing-2");
  assert.equal(store.get(draft.planId).tasks[0].launchReason, null);
});

test("does not retry an initial acquisition for a generic Git add failure", async () => {
  const deps = launchDeps();
  deps.worktrees.create = async (repositoryId, options) => {
    deps.calls.push(["create", repositoryId, options]);
    throw worktreeStateError("Git could not create this worktree", WORKTREE_REASONS.ADD_FAILURE);
  };
  const planner = new WorktreePlanner(deps);
  const draft = await readyDraft(planner);
  const result = await planner.launch(draft.planId);

  assert.equal(deps.calls.filter((call) => call[0] === "create").length, 1);
  assert.equal(result.results[0].branch, "feature/billing");
  assert.equal(result.results[0].launchReason, WORKTREE_REASONS.ADD_FAILURE);
});

test("persists the effective branch and path when workspace creation fails after fallback", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const deps = launchDeps();
  let originalAttempts = 0;
  deps.worktrees.create = async (repositoryId, options) => {
    deps.calls.push(["create", repositoryId, options]);
    if (options.branch === "feature/billing" && originalAttempts++ === 0) {
      throw worktreeStateError("That branch already has a worktree", WORKTREE_REASONS.REGISTERED_WORKTREE);
    }
    return { created: true, branchCreated: true, worktree: { id: "w2", branch: options.branch, path: "/repo/sample-feature-billing-2" } };
  };
  let workspaceAttempts = 0;
  deps.cmux.workspaceCreate = async () => {
    workspaceAttempts += 1;
    if (workspaceAttempts === 1) throw new Error("cmux is not running");
    return { workspace_id: "ws-2" };
  };
  const planner = new WorktreePlanner({ ...deps, store });
  const draft = await readyDraft(planner);
  const failed = await planner.launch(draft.planId);

  assert.equal(failed.results[0].branch, "feature/billing-2");
  assert.equal(failed.results[0].path, "/repo/sample-feature-billing-2");
  assert.equal(store.get(draft.planId).tasks[0].branch, "feature/billing-2");
  await planner.launch(draft.planId);
  assert.deepEqual(deps.calls.filter((call) => call[0] === "create").map((call) => call[2].branch), [
    "feature/billing", "feature/billing-2", "feature/billing-2",
  ]);
});

test("branch candidates continue suffixes, truncate long stems, and stay bounded", async () => {
  assert.deepEqual(taskBranchCandidates("feature/payments-2").slice(0, 2), ["feature/payments-3", "feature/payments-4"]);
  const long = `feature/${"x".repeat(73)}`;
  const candidate = taskBranchCandidates(long)[0];
  assert.equal(candidate.length, 81);
  assert.equal(candidate.endsWith("-2"), true);
  assert.equal(candidate.includes(".."), false);

  const occupied = Array.from({ length: 19 }, (_, index) => `feature/payments-${index + 2}`).join("\n");
  await assert.rejects(
    () => selectTaskBranchCandidate({
      branch: "feature/payments",
      cwd: "/repo/sample",
      git: async (cwd, args) => args[0] === "for-each-ref" ? occupied : "",
    }),
    /exhausted through -20/,
  );
});

test("branch selection skips local and registered candidates without mutating Git", async () => {
  const calls = [];
  const selected = await selectTaskBranchCandidate({
    branch: "feature/payments",
    cwd: "/repo/sample",
    registeredBranches: ["feature/payments-3"],
    git: async (cwd, args) => {
      calls.push(args);
      return args[0] === "for-each-ref" ? "feature/payments-2\n" : "";
    },
  });
  assert.equal(selected, "feature/payments-4");
  assert.deepEqual(calls.map((args) => args[0]), ["for-each-ref", "check-ref-format"]);
});

test("launches only the first dependency wave and queues downstream tasks", async () => {
  const reply = JSON.stringify({
    spec: { outcome: "Ship billing", inScope: ["API and UI"], nonGoals: [], constraints: [], assumptions: [], risks: [], acceptanceCriteria: [
      { id: "AC-1", text: "API works", verification: "npm test -- api" },
      { id: "AC-2", text: "UI works", verification: "npm test -- ui" },
    ] },
    tasks: [
      { id: "T1", title: "Billing API", branch: "feature/billing-api", prompt: "Build API.", criterionIds: ["AC-1"], dependsOn: [], ownedAreas: ["server/**"], verification: ["npm test -- api"] },
      { id: "T2", title: "Billing UI", branch: "feature/billing-ui", prompt: "Build UI.", criterionIds: ["AC-2"], dependsOn: ["T1"], ownedAreas: ["app/**"], verification: ["npm test -- ui"] },
    ],
  });
  const deps = launchDeps({ reply });
  const planner = new WorktreePlanner(deps);
  const draft = await readyDraft(planner);
  assert.deepEqual(draft.readiness.waves, [["T1"], ["T2"]]);
  const result = await planner.launch(draft.planId);

  assert.deepEqual(result.results.map((item) => item.status), ["launched", "queued"]);
  assert.equal(deps.calls.filter((call) => call[0] === "create").length, 1);
  assert.equal(deps.calls.filter((call) => call[0] === "workspace").length, 1);
  assert.equal(result.results[1].wave, 1);
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
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
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

test("appends the image paths to every launched task prompt", async () => {
  const deps = launchDeps();
  const planner = new WorktreePlanner(deps);
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing", images: IMAGES });
  await planner.update(draft.planId, { tasks: [
    { id: "t1", title: "Good", branch: "feature/good", prompt: "Do it.", agent: "claude" },
    { id: "t2", title: "Also", branch: "feature/also", prompt: "Do that.", agent: "codex" },
  ] });
  await planner.launch(draft.planId);
  const briefs = deps.calls.filter((call) => call[0] === "workspace").map((call) => {
    assertPointer(call[1].prompt);
    return briefText(call[1].prompt);
  });
  assert.equal(briefs.length, 2);
  for (const brief of briefs) {
    assert.match(brief, /Attached images:\n- \/attachments\/one\.png\n- \/attachments\/two\.png\n\nDelivery contract for this task:/);
    assert.match(brief, /Do not open a pull request/);
  }
  assert.ok(briefs[0].startsWith("Do it.\n\n"));
});

test("a launched task keeps its own prompt when no image is attached", async () => {
  const deps = launchDeps();
  const planner = new WorktreePlanner(deps);
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
  await planner.launch(draft.planId);
  const workspace = deps.calls.find((call) => call[0] === "workspace");
  const brief = briefText(workspace[1].prompt);
  assert.ok(brief.startsWith("Add billing."));
  assert.ok(!brief.includes("Attached image"));
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

// --- persistence ---------------------------------------------------------

function storedPlanner(options = {}) {
  const store = new WorktreePlanStore({ path: ":memory:" });
  const deps = fakeDeps({ replies: options.replies || [] });
  const planner = new WorktreePlanner({ ...deps, ...options.planner, store });
  return { store, deps, planner };
}

const TASKS_REPLY = envelope('{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}', "sess-a");
const QUESTIONS_REPLY = envelope('{"questions":[{"text":"Which database?"}]}', "sess-a");

test("saves the assigned tasks of a ready round", async (t) => {
  const { store, planner } = storedPlanner({ replies: [TASKS_REPLY] });
  t.after(() => store.close());
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
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
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
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
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
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
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
  await planner.launch(draft.planId);
  const saved = store.get(draft.planId);
  assert.equal(saved.status, "draft");
  assert.equal(saved.tasks[0].launchStatus, "failed");
  assert.match(saved.tasks[0].launchError, /already has a worktree/);
});

test("refuses to resume a plan that already launched", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const planner = new WorktreePlanner({ ...launchDeps(), store });
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
  await planner.launch(draft.planId);
  await assert.rejects(() => planner.resume(draft.planId), /already launched/);
});

test("lists saved plans newest first", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  let tick = 0;
  store.now = () => new Date(1_700_000_000_000 + (tick += 1_000));
  const planner = new WorktreePlanner({ ...fakeDeps({ replies: [QUESTIONS_REPLY, QUESTIONS_REPLY] }), store });
  const first = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
  const second = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add invoices" });
  const { plans } = await planner.list();
  assert.deepEqual(plans.map((plan) => plan.planId), [second.planId, first.planId]);
  assert.equal(plans[0].goal, "Add invoices");
  assert.equal(plans[0].taskCount, 0);
});

test("deletes a plan and forgets it", async (t) => {
  const { store, planner } = storedPlanner({ replies: [QUESTIONS_REPLY] });
  t.after(() => store.close());
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
  assert.deepEqual(await planner.remove(draft.planId), { planId: draft.planId, deleted: true });
  assert.equal(store.get(draft.planId), null);
  await assert.rejects(() => planner.remove(draft.planId), /Unknown plan/);
  await assert.rejects(() => planner.resume(draft.planId), /Unknown plan/);
});

test("a retry launches a task whose worktree a failed launch left behind", async () => {
  const deps = launchDeps();
  const seen = [];
  deps.cmux.workspaceListDetailed = async () => ({ workspaces: [{ id: "ws-old", current_directory: "/repo/other" }] });
  deps.worktrees.create = async (repositoryId, options) => {
    seen.push(options);
    return { created: false, reused: true, branchCreated: false, worktree: { id: "w1", branch: options.branch, path: "/repo/sample-feature-billing" } };
  };
  const planner = new WorktreePlanner(deps);
  const draft = await readyDraft(planner);
  const result = await planner.launch(draft.planId);
  assert.equal(result.results[0].status, "launched");
  assert.equal(result.launched, 1);
  assert.equal(seen[0].reuseIfAtBase, true);
  assert.deepEqual(seen[0].workspaces, [{ id: "ws-old", current_directory: "/repo/other" }]);
});

test("an unreachable cmux workspace list still lets a launch run", async () => {
  const deps = launchDeps();
  const seen = [];
  deps.cmux.workspaceListDetailed = async () => { throw new Error("cmux is not running"); };
  deps.worktrees.create = async (repositoryId, options) => {
    seen.push(options);
    return { created: true, reused: false, branchCreated: true, worktree: { id: "w1", branch: options.branch, path: "/repo/sample-feature-billing" } };
  };
  const planner = new WorktreePlanner(deps);
  const draft = await readyDraft(planner);
  const result = await planner.launch(draft.planId);
  assert.equal(result.results[0].status, "launched");
  assert.deepEqual(seen[0].workspaces, []);
});

// --- lifecycle state, cancellation and abort -----------------------------

const READY_TASKS = '{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}';

// A durable planner that can also launch: launchDeps supplies the git runner,
// the worktree creator and a temporary brief directory that a launch needs.
function launchablePlanner(replies = 1) {
  const store = new WorktreePlanStore({ path: ":memory:" });
  const deps = launchDeps();
  deps.execute = async () => ({ stdout: envelope(READY_TASKS, "sess-a") });
  const planner = new WorktreePlanner({ ...deps, store });
  return { store, deps, planner, replies };
}

test("list and detail place a launched, a merged and an aborted goal in their own columns", async (t) => {
  const { store, planner } = launchablePlanner();
  t.after(() => store.close());
  const launched = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Launch this" });
  await planner.launch(launched.planId);
  const merged = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Merge this" });
  await planner.launch(merged.planId);
  store.recordGoalMerged(merged.planId, { number: 5, url: "https://github.test/pr/5" });
  const aborted = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Abort this" });
  store.recordGoalAborted(aborted.planId);

  const byId = new Map((await planner.list({ status: "all" })).plans.map((plan) => [plan.planId, plan]));
  assert.equal(byId.get(launched.planId).boardState, "dev_in_progress");
  assert.equal(byId.get(merged.planId).boardState, "merged");
  assert.equal(byId.get(aborted.planId).boardState, "aborted");
  assert.equal(byId.get(merged.planId).boardStatus, "merged");
  assert.equal(byId.get(merged.planId).boardPrNumber, 5);
  assert.equal((await planner.detail(aborted.planId)).boardState, "aborted");
  assert.equal((await planner.detail(merged.planId)).boardState, "merged");
});

test("abort closes every distinct task and merge session exactly once", async (t) => {
  const { store, planner, deps } = launchablePlanner();
  t.after(() => store.close());
  const closed = [];
  deps.cmux.workspaceClose = async (id) => { closed.push(id); };
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
  await planner.launch(draft.planId);
  store.recordIntegrationStarted(draft.planId, { branch: "goal/billing", path: "/repo/sample-goal" });
  store.recordMergeLaunched(draft.planId, "merge-one");
  store.recordMergeLaunched(draft.planId, "merge-two");
  const result = await planner.abort(draft.planId);
  // ws-1 is the launched task session; merge-one was superseded by merge-two.
  assert.deepEqual(closed.slice().sort(), ["merge-one", "merge-two", "ws-1"]);
  assert.deepEqual(result.closedSessionIds.slice().sort(), ["merge-one", "merge-two", "ws-1"]);
  assert.deepEqual(result.failedSessionIds, []);
  assert.equal(new Set(closed).size, closed.length, "no session id may be closed twice");
});

test("abort reports the sessions cmux refused to close", async (t) => {
  const { store, planner, deps } = launchablePlanner();
  t.after(() => store.close());
  deps.cmux.workspaceClose = async (id) => { if (id === "merge-one") throw new Error("cmux is down"); };
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
  await planner.launch(draft.planId);
  store.recordIntegrationStarted(draft.planId, { branch: "goal/billing", path: "/repo/sample-goal" });
  store.recordMergeLaunched(draft.planId, "merge-one");
  const result = await planner.abort(draft.planId);
  assert.deepEqual(result.closedSessionIds, ["ws-1"]);
  assert.deepEqual(result.failedSessionIds, ["merge-one"]);
  assert.equal(store.get(draft.planId).boardStatus, "aborted", "a failed closure still ends the goal");
});

test("a repeated abort retries the closures and appends no second event", async (t) => {
  const { store, planner, deps } = launchablePlanner();
  t.after(() => store.close());
  let attempts = 0;
  deps.cmux.workspaceClose = async () => { attempts += 1; if (attempts === 1) throw new Error("cmux is down"); };
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
  await planner.launch(draft.planId);
  const first = await planner.abort(draft.planId);
  assert.deepEqual(first.failedSessionIds, ["ws-1"]);
  const second = await planner.abort(draft.planId);
  assert.equal(second.alreadyAborted, true);
  assert.deepEqual(second.closedSessionIds, ["ws-1"], "a repeat retries what failed before");
  const events = store.events(draft.planId).filter((event) => event.kind === "board_aborted");
  assert.equal(events.length, 1, "one abort event, however many calls");
});

test("abort leaves the worktrees, the branches and the plan row untouched", async (t) => {
  const { store, planner, deps } = launchablePlanner();
  t.after(() => store.close());
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
  await planner.launch(draft.planId);
  const before = store.get(draft.planId);
  deps.worktrees.remove = () => { throw new Error("a worktree must never be removed by an abort"); };
  deps.worktrees.removeCleanWorktrees = () => { throw new Error("a worktree must never be removed by an abort"); };
  await planner.abort(draft.planId);
  const after = store.get(draft.planId);
  assert.deepEqual(after.tasks.map((task) => [task.branch, task.worktreePath, task.launchStatus]), before.tasks.map((task) => [task.branch, task.worktreePath, task.launchStatus]));
  assert.equal(after.status, before.status);
  assert.equal(after.goal, before.goal);
});

// --- the launch registry -------------------------------------------------

// The launch registry is deliberately not the PlannerRuns registry. That one
// holds one entry per plan and carries a specification stage, so a launch
// stored there would replace the round entry and move the card.
test("the launch registry admits one launch per plan and releases it", () => {
  const launches = new LaunchRuns();
  assert.equal(launches.begin("plan-1"), true);
  assert.equal(launches.begin("plan-1"), false);
  assert.equal(launches.isLaunching("plan-1"), true);
  // A different plan is free to launch at the same time.
  assert.equal(launches.begin("plan-2"), true);
  assert.deepEqual(launches.list().map((entry) => entry.planId).sort(), ["plan-1", "plan-2"]);

  launches.finish("plan-1");
  assert.equal(launches.isLaunching("plan-1"), false);
  assert.equal(launches.begin("plan-1"), true);

  launches.clear();
  assert.deepEqual(launches.list(), []);
});

test("the launch registry refuses an empty plan id", () => {
  const launches = new LaunchRuns();
  assert.equal(launches.begin(""), false);
  assert.equal(launches.isLaunching(""), false);
});

// --- delivery contract discussions ----------------------------------------

function discussionEnvelope(payload, sessionId = "discussion-session") {
  return envelope(typeof payload === "string" ? payload : JSON.stringify(payload), sessionId);
}

const GOOD_ANSWER = { answer: "T2 waits for T1 because both write the invoice model.", contractImpact: "none" };

test("parses a valid discussion answer and normalizes an absent suggestion", () => {
  const reply = parseDiscussionReply(discussionEnvelope(GOOD_ANSWER));
  assert.deepEqual(reply, { answer: GOOD_ANSWER.answer, contractImpact: "none", suggestion: "" });
});

test("keeps the suggestion of a revision verdict", () => {
  const reply = parseDiscussionReply(discussionEnvelope({ answer: "T1 owns two areas.", contractImpact: "revision_suggested", suggestion: "Split T1 into schema and API." }));
  assert.deepEqual(reply, { answer: "T1 owns two areas.", contractImpact: "revision_suggested", suggestion: "Split T1 into schema and API." });
});

test("refuses every unusable discussion payload", () => {
  const refused = [
    ["no answer", { answer: "", contractImpact: "none" }],
    ["a missing answer", { contractImpact: "none" }],
    ["an oversized answer", { answer: "x".repeat(4_001), contractImpact: "none" }],
    ["a non-string answer", { answer: 12, contractImpact: "none" }],
    ["a missing verdict", { answer: "Fine." }],
    ["an unknown verdict", { answer: "Fine.", contractImpact: "maybe" }],
    ["a suggestion on a none verdict", { answer: "Fine.", contractImpact: "none", suggestion: "Split T1." }],
    ["a revision with no suggestion", { answer: "Wrong.", contractImpact: "revision_suggested" }],
    ["a revision with an empty suggestion", { answer: "Wrong.", contractImpact: "revision_suggested", suggestion: "   " }],
    ["an oversized suggestion", { answer: "Wrong.", contractImpact: "revision_suggested", suggestion: "y".repeat(2_001) }],
    ["a non-string suggestion", { answer: "Fine.", contractImpact: "none", suggestion: 5 }],
    ["an additional key", { answer: "Fine.", contractImpact: "none", suggestion: "", notes: "extra" }],
    ["questions", { answer: "Fine.", contractImpact: "none", questions: [{ text: "Which?" }] }],
    ["tasks", { answer: "Fine.", contractImpact: "none", tasks: [{ title: "A", branch: "feature/a", prompt: "Do it." }] }],
  ];
  for (const [label, payload] of refused) {
    assert.throws(() => parseDiscussionReply(discussionEnvelope(payload)), /unusable answer/, label);
  }
  assert.throws(() => parseDiscussionReply("no json at all"), /unusable answer/);
});

test("coder defaults reach task workspace launches", async () => {
  const deps = launchDeps();
  const planner = new WorktreePlanner(deps);
  planner.modelSettings.configure({ roles: { coder: { models: { claude: "custom-coder", codex: "custom-coder" } } } });
  const draft = await readyDraft(planner);
  await planner.launch(draft.planId);
  assert.equal(deps.calls.find(([kind]) => kind === "workspace")[1].model, "custom-coder");
});

test("paused accounts cannot win assignment even with the largest balance", () => {
  const usage = usageFor(90, 40);
  usage.providers[0].accounts[0].paused = true;
  assert.equal(assignAgents(THREE, usage)[0].agent, "codex");
});

test("known exhaustion cannot fall back to Claude", () => {
  assert.throws(() => assignAgents(THREE, usageFor(0, 0)), /No provider has usable quota/);
  assert.deepEqual(assignAgents([], usageFor(0, 0)), []);
  const usage = usageFor(0, null);
  assert.equal(assignAgents(THREE, usage)[0].agent, "codex");
  assert.match(assignAgents(THREE, usage)[0].agentReason, /quota unverified/);
});

test("provider fetch failure cannot advertise retained windows as usable", () => {
  const usage = usageFor(90, 40);
  usage.providers[0].available = false;
  assert.equal(assignAgents(THREE, usage)[0].agent, "codex");
});

test("a saved task whose provider became blocked fails before creating a worktree", async () => {
  const deps = launchDeps();
  const planner = new WorktreePlanner(deps);
  const draft = await readyDraft(planner);
  let refreshed = false;
  deps.accountUsage.snapshot = async (options) => { refreshed = options.refresh; return usageFor(0, 90); };
  const result = await planner.launch(draft.planId);
  assert.equal(refreshed, true);
  assert.equal(result.launched, 0);
  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].error, /no usable quota/);
  assert.equal(deps.calls.some((call) => ["create", "workspace"].includes(call[0])), false);
});

test("multi-task goals push task branches without opening individual pull requests", async () => {
  const deps = launchDeps();
  const planner = new WorktreePlanner(deps);
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
  await planner.update(draft.planId, { tasks: [
    { id: "t1", title: "Good", branch: "feature/good", prompt: "Do it.", agent: "claude" },
    { id: "t2", title: "Also", branch: "feature/also", prompt: "Do that.", agent: "codex" },
  ] });
  await planner.launch(draft.planId);
  const briefs = deps.calls.filter((call) => call[0] === "workspace").map((call) => {
    assertPointer(call[1].prompt);
    return briefText(call[1].prompt);
  });
  assert.equal(briefs.length, 2);
  for (const brief of briefs) {
    assert.match(brief, /Finish your task branch for combined delivery:/);
    assert.match(brief, /Push this task branch to origin/);
    assert.match(brief, /Do not open a pull request/);
    assert.match(brief, /Cmux-Goal-Ready: .+\/t[12]/);
    assert.ok(!brief.includes("gh pr create"));
  }
});

test("single-task goals keep the direct pull request workflow", async () => {
  const deps = launchDeps();
  const planner = new WorktreePlanner(deps);
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
  const result = await planner.launch(draft.planId);
  const brief = briefText(deps.calls.find((call) => call[0] === "workspace")[1].prompt);
  assert.equal(result.deliveryMode, "single");
  assert.match(brief, /Finish with a pull request:/);
  assert.match(brief, /gh pr create/);
  assert.match(brief, /pull request against main\b/);
});

test("a one-task issue topic is forced through Companion's combined delivery branch", async () => {
  const deps = launchDeps();
  const planner = new WorktreePlanner(deps);
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Fix linked issues", issueNumbers: [54, 55], issueUrls: ["https://github.com/acme/app/issues/54"], deliveryPolicy: "combined" });
  assert.deepEqual(draft.issueNumbers, [54, 55]);
  assert.equal(draft.deliveryMode, "combined");
  const result = await planner.launch(draft.planId);
  const brief = briefText(deps.calls.find((call) => call[0] === "workspace")[1].prompt);
  assert.equal(result.deliveryMode, "combined");
  assert.match(brief, /Finish your task branch for combined delivery/);
  assert.doesNotMatch(brief, /Closes #54|gh pr create/);
});

test("names a master default branch rather than assuming main", async () => {
  const deps = launchDeps();
  deps.git = async (cwd, args) => {
    deps.calls.push(["git", args]);
    if (args[0] === "symbolic-ref") return "origin/master\n";
    return "";
  };
  const planner = new WorktreePlanner(deps);
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
  const result = await planner.launch(draft.planId);
  assert.equal(result.base, "origin/master");
  assert.match(briefText(deps.calls.find((call) => call[0] === "workspace")[1].prompt), /pull request against master\b/);
});

test("an aborted goal refuses every mutation and stays readable and deletable", async (t) => {
  const { store, planner } = storedPlanner({ replies: [QUESTIONS_REPLY] });
  t.after(() => store.close());
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
  await planner.abort(draft.planId);
  const refused = /This goal was aborted/;
  await assert.rejects(() => planner.resume(draft.planId), refused);
  await assert.rejects(() => planner.update(draft.planId, { tasks: [{ id: "t1", title: "x", branch: "feature/x", prompt: "x" }] }), refused);
  await assert.rejects(() => planner.launch(draft.planId), refused);
  assert.equal((await planner.detail(draft.planId)).boardState, "aborted");
  assert.deepEqual(await planner.remove(draft.planId), { planId: draft.planId, deleted: true });
});

test("a merged goal refuses every mutation and refuses to be aborted", async (t) => {
  const { store, planner } = launchablePlanner();
  t.after(() => store.close());
  const draft = await seedLegacyPlan(planner, { repositoryId: REPO_ID, goal: "Add billing" });
  await planner.launch(draft.planId);
  store.recordGoalMerged(draft.planId, { number: 7, url: "https://github.test/pr/7" });
  await assert.rejects(() => planner.resume(draft.planId), /already merged/);
  await assert.rejects(() => planner.launch(draft.planId), /already merged/);
  await assert.rejects(() => planner.abort(draft.planId), /already merged, so it cannot be aborted/);
  assert.equal((await planner.detail(draft.planId)).boardState, "merged");
});

test("abort refuses a plan that does not exist", async (t) => {
  const { store, planner } = storedPlanner({ replies: [] });
  t.after(() => store.close());
  await assert.rejects(() => planner.abort("no-such-plan"), /Unknown plan/);
});
