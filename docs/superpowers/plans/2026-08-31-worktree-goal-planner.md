# Worktree Goal Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept a goal on a repository, let a headless Claude session split it into independent tasks, then create one worktree and one agent session per task.

**Architecture:** One new server module, `server/worktree-planner.mjs`, spawns `ccs claude --print --output-format json` and keeps the returned session id for later rounds. Two pure functions inside it (a reply parser and an agent assigner) hold all the logic that needs tests. Four Fastify routes expose a draft that the phone edits before it confirms. The launch reuses `WorktreeDashboard.create` and `CmuxClient.workspaceCreate`, both of which already exist.

**Tech Stack:** Node 22 ESM, Fastify 5, `node:test` with `node --test`, React 19 with Vitest and Testing Library, the `ccs` CLI, and Git.

---

## Background for the engineer

Read these before you start. Each one matters for a task below.

- `server/worktree-dashboard.mjs:201` holds `create(repositoryId, { branch, base })`. It validates the branch name, verifies the base commit, runs `git worktree add`, and returns `{ created, worktree, branchCreated }`. Do not write a second version of it.
- `server/cmux-client.mjs:229` holds `workspaceCreate({ cwd, title, agent, prompt })`. Allowed agents are `shell`, `codex`, and `claude`.
- `server/account-usage.mjs` returns `{ providers: [{ id, available, accounts: [{ status, windows: [{ cadence, category, remainingPercent }] }] }] }`. `status` is one of `ready`, `low`, `exhausted`, `reconnect`, `unavailable`. `cadence` is one of `5h`, `daily`, `weekly`, `monthly`, `other`.
- `server/app.mjs:88` holds the error handler. A `TypeError` becomes an HTTP 400 with its own message. So every input rejection in this feature must throw `TypeError`.
- `server/repo-catalog.mjs:225` holds `git(cwd, args, options)`. It shells out through an injected `execute` function, which is how the tests fake Git.
- Tests use `node:test` with plain fakes passed into constructors. There is no mocking library. Follow that.

The `ccs claude` command prints banner lines on stdout before its JSON. A real reply looks like this:

```
[i] Preparing CLIProxy...
[OK] CLIProxy binary ready
{"duration_api_ms":2029,"stop_reason":"end_turn","session_id":"5774cb49-...","result":"...","usage":{...}}
```

The `result` field holds the model's text. The plan JSON lives inside that text.

---

## File Structure

| File | Responsibility |
|---|---|
| Create `server/worktree-planner.mjs` | The parser, the agent assigner, the draft store, the subprocess calls, and the launch loop. |
| Modify `server/app.mjs` | Four routes under `/api/worktree-plans`, and the planner wiring. |
| Create `app/worktree-planner.tsx` | The goal sheet: the questions state and the plan state. |
| Modify `app/worktree-dashboard.tsx` | A "Plan a goal" button on the repository row, and the sheet mount. |
| Modify `app/features.css` | Styles for the new sheet. |
| Create `tests/worktree-planner.test.mjs` | Unit tests for the module. |
| Modify `tests/api.test.mjs` | Route tests with a fake planner. |
| Modify `tests/ui-features.test.tsx` | Sheet render and interaction tests. |
| Modify `package.json` | Add the new test file to the `test` script. |

---

### Task 1: Parse the planner reply

**Files:**
- Create: `server/worktree-planner.mjs`
- Test: `tests/worktree-planner.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `tests/worktree-planner.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { parsePlannerReply } from "../server/worktree-planner.mjs";

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/worktree-planner.test.mjs`
Expected: FAIL. The error names a missing module, `server/worktree-planner.mjs`.

- [ ] **Step 3: Write the parser**

Create `server/worktree-planner.mjs`:

```javascript
const UNUSABLE = "The planner returned an unusable answer. Try again";

export function parsePlannerReply(stdout) {
  const envelope = extractJson(String(stdout));
  if (!envelope) throw new TypeError(UNUSABLE);
  const sessionId = typeof envelope.session_id === "string" ? envelope.session_id : null;
  const payload = extractJson(unfence(String(envelope.result || "")));
  if (!payload) throw new TypeError(UNUSABLE);

  const hasQuestions = Array.isArray(payload.questions) && payload.questions.length > 0;
  const hasTasks = Array.isArray(payload.tasks) && payload.tasks.length > 0;
  if (hasQuestions === hasTasks) throw new TypeError(UNUSABLE);

  if (hasQuestions) {
    const questions = payload.questions
      .map((item, index) => ({
        id: `q${index + 1}`,
        text: cleanText(item?.text || item?.question),
        options: Array.isArray(item?.options) ? item.options.map(cleanText).filter(Boolean).slice(0, 6) : [],
      }))
      .filter((item) => item.text);
    if (!questions.length) throw new TypeError(UNUSABLE);
    return { sessionId, status: "questions", questions, tasks: [] };
  }

  const tasks = payload.tasks
    .map((item, index) => ({
      id: `t${index + 1}`,
      title: cleanText(item?.title),
      branch: cleanText(item?.branch),
      prompt: cleanText(item?.prompt),
    }))
    .filter((item) => item.title && item.branch && item.prompt);
  if (!tasks.length) throw new TypeError(UNUSABLE);
  return { sessionId, status: "ready", questions: [], tasks };
}

function unfence(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fence ? fence[1] : text;
}

function extractJson(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // Keep shrinking: trailing prose after the object is common.
    }
  }
  return null;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim().slice(0, 4_000) : "";
}
```

Note the id renumbering: the tasks in the fixture that survive the filter keep their original index, so a dropped first task would leave `t2`. The test above drops the second task, so `t1` is correct. Leave the behaviour as written.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/worktree-planner.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add server/worktree-planner.mjs tests/worktree-planner.test.mjs
git commit -m "Parse headless planner replies"
```

---

### Task 2: Assign an agent from live account usage

**Files:**
- Modify: `server/worktree-planner.mjs`
- Test: `tests/worktree-planner.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/worktree-planner.test.mjs`. Also add `assignAgents` to the existing import at the top of the file, so the first line becomes:

```javascript
import { assignAgents, parsePlannerReply } from "../server/worktree-planner.mjs";
```

Then append:

```javascript
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
  assert.match(tasks[0].agentReason, /90% left/);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/worktree-planner.test.mjs`
Expected: FAIL with `assignAgents is not a function`.

- [ ] **Step 3: Write the assigner**

Append to `server/worktree-planner.mjs`:

```javascript
const USABLE_STATUS = new Set(["ready", "low"]);
const MIN_HEADROOM = 5;
const CLOSE_ENOUGH = 10;
const LABELS = { claude: "Claude", codex: "Codex" };

export function assignAgents(tasks, usage) {
  const claude = providerHeadroom(usage, "claude");
  const codex = providerHeadroom(usage, "codex");
  const list = Array.isArray(tasks) ? tasks : [];

  if (claude === null && codex === null) {
    return list.map((task) => ({ ...task, agent: "claude", agentReason: "Account usage is unavailable" }));
  }
  if (claude === null) return list.map((task) => ({ ...task, ...describe("codex", codex) }));
  if (codex === null) return list.map((task) => ({ ...task, ...describe("claude", claude) }));

  const roomier = codex > claude ? "codex" : "claude";
  const other = roomier === "codex" ? "claude" : "codex";
  const headroom = { claude, codex };
  if (Math.abs(codex - claude) > CLOSE_ENOUGH) {
    return list.map((task) => ({ ...task, ...describe(roomier, headroom[roomier]) }));
  }
  return list.map((task, index) => {
    const agent = index % 2 === 0 ? roomier : other;
    return { ...task, ...describe(agent, headroom[agent]) };
  });
}

function describe(agent, percent) {
  return { agent, agentReason: `${LABELS[agent]} · ${Math.round(percent)}% left` };
}

// Returns the best headroom across a provider's usable accounts, or null when
// the provider cannot take work right now.
function providerHeadroom(usage, id) {
  const provider = (usage?.providers || []).find((item) => item?.id === id);
  if (!provider) return null;
  const scores = (provider.accounts || [])
    .filter((account) => USABLE_STATUS.has(account?.status))
    .map(accountHeadroom)
    .filter((value) => value !== null);
  if (!scores.length) return null;
  const best = Math.max(...scores);
  return best > MIN_HEADROOM ? best : null;
}

function accountHeadroom(account) {
  const percents = (account?.windows || [])
    .filter((window) => window?.category === "usage" && (window.cadence === "5h" || window.cadence === "weekly"))
    .map((window) => window.remainingPercent)
    .filter((value) => Number.isFinite(value));
  return percents.length ? Math.min(...percents) : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/worktree-planner.test.mjs`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add server/worktree-planner.mjs tests/worktree-planner.test.mjs
git commit -m "Assign planner tasks from live account usage"
```

---

### Task 3: Run the planner rounds

**Files:**
- Modify: `server/worktree-planner.mjs`
- Test: `tests/worktree-planner.test.mjs`

The class takes every collaborator as an argument, so the tests never spawn a real process.

- [ ] **Step 1: Write the failing tests**

Extend the import line at the top of `tests/worktree-planner.test.mjs`:

```javascript
import { WorktreePlanner, assignAgents, parsePlannerReply } from "../server/worktree-planner.mjs";
```

Append to the file:

```javascript
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
      create: async (repositoryId, options) => {
        calls.push(["create", repositoryId, options]);
        if (options.branch === "feature/boom") throw new TypeError("That branch already has a worktree");
        return { created: true, worktree: { id: "w1", branch: options.branch, path: `/repo/sample-${options.branch.replace(/\W+/g, "-")}` } };
      },
    },
    cmux: {
      workspaceCreate: async (options) => { calls.push(["workspace", options]); return { workspace_id: "ws-1" }; },
    },
    accountUsage: { snapshot: async () => usageFor(90, 20) },
    execute: async (bin, args) => {
      calls.push([bin, args]);
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
  const resumeArgs = deps.calls.at(-1)[1];
  assert.ok(resumeArgs.includes("--resume"));
  assert.equal(resumeArgs[resumeArgs.indexOf("--resume") + 1], "sess-a");
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

test("reports a missing ccs binary in plain words", async () => {
  const missing = Object.assign(new Error("spawn ccs ENOENT"), { code: "ENOENT" });
  const deps = fakeDeps({ replies: [missing, missing] });
  const planner = new WorktreePlanner(deps);
  await assert.rejects(() => planner.start({ repositoryId: REPO_ID, goal: "Add billing" }), /needs the ccs CLI/);
});

test("rejects an unknown plan id", async () => {
  const planner = new WorktreePlanner(fakeDeps({ replies: [] }));
  await assert.rejects(() => planner.answer("missing", { skip: true }), /Unknown plan/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/worktree-planner.test.mjs`
Expected: FAIL with `WorktreePlanner is not a constructor`.

- [ ] **Step 3: Write the class**

Add these imports at the very top of `server/worktree-planner.mjs`:

```javascript
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
```

Then append the class to the same file:

```javascript
const DRAFT_TTL_MS = 30 * 60_000;
const ROUND_TIMEOUT_MS = 180_000;
const ALLOWED_TOOLS = "Read,Grep,Glob,Skill";

export class WorktreePlanner {
  constructor({ worktrees, cmux, accountUsage, execute = execFileAsync, maxRounds = 6, timeoutMs = ROUND_TIMEOUT_MS, ttlMs = DRAFT_TTL_MS } = {}) {
    if (!worktrees) throw new TypeError("A worktree dashboard is required");
    if (!cmux) throw new TypeError("A cmux client is required");
    this.worktrees = worktrees;
    this.cmux = cmux;
    this.accountUsage = accountUsage;
    this.execute = execute;
    this.maxRounds = maxRounds;
    this.timeoutMs = timeoutMs;
    this.ttlMs = ttlMs;
    this.drafts = new Map();
  }

  async start({ repositoryId, goal }) {
    const text = String(goal || "").trim();
    if (!text) throw new TypeError("Describe the goal for this repository");
    if (text.length > 4_000) throw new TypeError("That goal is too long");
    const repository = await this.#repository(repositoryId);
    const draft = {
      planId: randomUUID(),
      repositoryId: repository.id,
      repositoryName: repository.name,
      cwd: repository.primaryPath,
      goal: text,
      sessionId: null,
      round: 0,
      at: Date.now(),
      status: "questions",
      questions: [],
      tasks: [],
    };
    this.drafts.set(draft.planId, draft);
    return this.#round(draft, openingPrompt(draft));
  }

  async answer(planId, { answers = [], skip = false } = {}) {
    const draft = this.#draft(planId);
    if (draft.round >= this.maxRounds) {
      throw new TypeError("The planner could not produce a plan. Start again with a narrower goal");
    }
    return this.#round(draft, skip ? SKIP_PROMPT : answerPrompt(draft, answers));
  }

  async update(planId, { tasks }) {
    const draft = this.#draft(planId);
    if (!Array.isArray(tasks) || !tasks.length) throw new TypeError("Keep at least one task");
    if (tasks.length > 8) throw new TypeError("A plan can hold at most 8 tasks");
    draft.tasks = tasks.map((task, index) => {
      const branch = String(task?.branch || "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/.test(branch) || branch.includes("..")) {
        throw new TypeError(`Task ${index + 1} needs a valid Git branch name`);
      }
      const title = String(task?.title || "").trim();
      const prompt = String(task?.prompt || "").trim();
      if (!title || !prompt) throw new TypeError(`Task ${index + 1} needs a title and a prompt`);
      const agent = task?.agent === "codex" ? "codex" : "claude";
      return { id: task?.id || `t${index + 1}`, title, branch, prompt, agent, agentReason: String(task?.agentReason || "") };
    });
    const branches = new Set(draft.tasks.map((task) => task.branch));
    if (branches.size !== draft.tasks.length) throw new TypeError("Two tasks share a branch name");
    draft.at = Date.now();
    return publicDraft(draft);
  }

  async #round(draft, prompt) {
    let reply;
    try {
      reply = parsePlannerReply(await this.#spawn(draft, prompt));
    } catch (cause) {
      if (!(cause instanceof TypeError)) throw cause;
      reply = parsePlannerReply(await this.#spawn(draft, prompt));
    }
    draft.round += 1;
    draft.at = Date.now();
    if (reply.sessionId) draft.sessionId = reply.sessionId;
    draft.status = reply.status;
    draft.questions = reply.questions;
    draft.tasks = reply.status === "ready" ? assignAgents(reply.tasks, await this.#usage()) : [];
    return publicDraft(draft);
  }

  async #spawn(draft, prompt) {
    const args = ["claude", "--print", "--output-format", "json", "--allowed-tools", ALLOWED_TOOLS];
    if (draft.sessionId) args.push("--resume", draft.sessionId);
    args.push(prompt);
    try {
      const { stdout = "" } = await this.execute("ccs", args, {
        cwd: draft.cwd,
        encoding: "utf8",
        timeout: this.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
      });
      return stdout;
    } catch (cause) {
      if (cause?.code === "ENOENT") throw new TypeError("The planner needs the ccs CLI. Install it, then try again");
      if (cause?.killed || cause?.signal === "SIGTERM") throw new TypeError("The planner did not answer in time. Try again");
      throw new TypeError("The planner could not run. Try again");
    }
  }

  async #usage() {
    try {
      return await this.accountUsage?.snapshot();
    } catch {
      return null;
    }
  }

  async #repository(repositoryId) {
    if (typeof repositoryId !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(repositoryId)) throw new TypeError("Invalid repository");
    const dashboard = await this.worktrees.snapshot({ refresh: true });
    const repository = dashboard.repositories.find((item) => item.id === repositoryId);
    if (!repository) throw new TypeError("Unknown repository");
    const primary = repository.worktrees.find((item) => item.isPrimary) || repository.worktrees[0];
    return { id: repository.id, name: repository.name, path: repository.path, primaryPath: primary?.path || repository.path };
  }

  #draft(planId) {
    this.#sweep();
    const draft = this.drafts.get(String(planId || ""));
    if (!draft) throw new TypeError("Unknown plan. Start a new goal");
    return draft;
  }

  #sweep() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, draft] of this.drafts) if (draft.at < cutoff) this.drafts.delete(id);
  }
}

function publicDraft(draft) {
  return {
    planId: draft.planId,
    repositoryId: draft.repositoryId,
    goal: draft.goal,
    round: draft.round,
    status: draft.status,
    questions: draft.questions,
    tasks: draft.tasks,
  };
}
```

Now add the prompt builders at the end of the file:

```javascript
const SKIP_PROMPT = "Stop asking questions. Decide the remaining details yourself and reply now with the tasks JSON object.";

const CONTRACT = [
  "Reply with exactly one JSON object and no other prose.",
  'It holds either {"questions": [{"text": "...", "options": ["..."]}]} or {"tasks": [{"title": "...", "branch": "feature/...", "prompt": "..."}]}.',
  "It never holds both keys.",
  "Ask questions only while a real ambiguity would change the split. Otherwise return the tasks.",
  "Each task must be independent of every other task, because the agents run in separate worktrees and never see each other.",
  "Each task branch starts with feature/ and uses only letters, digits, dots, dashes and slashes.",
  "Each task prompt is self-contained: it states the outcome, the files or areas to touch, and how to verify the work.",
  "Return one task when the goal is a single unit of work. That is a valid answer.",
  "Do not include an agent field. The server assigns the agent.",
].join("\n");

const OVERRIDES = [
  "Overrides for this run, which take priority over any skill instruction:",
  "Write no file. Create no design document. Create no plan document. Ask for no approval gate.",
  "Your only output is the JSON object described above.",
].join("\n");

function openingPrompt(draft) {
  return [
    `Repository: ${draft.repositoryName} at ${draft.cwd}`,
    `Goal: ${draft.goal}`,
    "",
    "Use /brainstorming for the question rounds. Use /dispatching-parallel-agents to decide whether this goal splits into independent tasks.",
    "",
    OVERRIDES,
    "",
    CONTRACT,
  ].join("\n");
}

function answerPrompt(draft, answers) {
  const lines = (Array.isArray(answers) ? answers : [])
    .map((answer) => {
      const question = draft.questions.find((item) => item.id === answer?.id);
      const text = String(answer?.text || "").trim().slice(0, 2_000);
      return question && text ? `Q: ${question.text}\nA: ${text}` : "";
    })
    .filter(Boolean);
  return [lines.length ? lines.join("\n\n") : "No answers were given.", "", CONTRACT].join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/worktree-planner.test.mjs`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add server/worktree-planner.mjs tests/worktree-planner.test.mjs
git commit -m "Run capped planner rounds over a resumed ccs session"
```

---

### Task 4: Launch the plan

**Files:**
- Modify: `server/worktree-planner.mjs`
- Test: `tests/worktree-planner.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/worktree-planner.test.mjs`:

```javascript
function readyPlanner(extra = {}) {
  const deps = fakeDeps({ replies: [envelope('{"tasks":[{"title":"Billing","branch":"feature/billing","prompt":"Add billing."}]}', "sess-a")] });
  deps.git = async (cwd, args) => {
    deps.calls.push(["git", args]);
    if (args[0] === "symbolic-ref") return "refs/remotes/origin/main\n";
    return "";
  };
  return { deps: { ...deps, ...extra }, make: (overrides = {}) => new WorktreePlanner({ ...deps, ...extra, ...overrides }) };
}

test("creates one worktree and one session per task", async () => {
  const { deps, make } = readyPlanner();
  const planner = make();
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  const result = await planner.launch(draft.planId);
  assert.equal(result.base, "origin/main");
  assert.deepEqual(result.results.map((item) => item.status), ["launched"]);
  const create = deps.calls.find((call) => call[0] === "create");
  assert.deepEqual(create[2], { branch: "feature/billing", base: "origin/main" });
  const workspace = deps.calls.find((call) => call[0] === "workspace");
  assert.equal(workspace[1].agent, "claude");
  assert.equal(workspace[1].title, "Billing");
  assert.ok(deps.calls.some((call) => call[0] === "git" && call[1][0] === "fetch"));
});

test("a failed task does not stop the earlier task", async () => {
  const { make } = readyPlanner();
  const planner = make();
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  await planner.update(draft.planId, { tasks: [
    { id: "t1", title: "Good", branch: "feature/good", prompt: "Do it.", agent: "claude" },
    { id: "t2", title: "Bad", branch: "feature/boom", prompt: "Do it.", agent: "codex" },
  ] });
  const result = await planner.launch(draft.planId);
  assert.deepEqual(result.results.map((item) => item.status), ["launched", "failed"]);
  assert.match(result.results[1].error, /already has a worktree/);
});

test("stops the launch when the fetch fails", async () => {
  const { make } = readyPlanner();
  const planner = make({
    git: async (cwd, args) => {
      if (args[0] === "symbolic-ref") return "refs/remotes/origin/main\n";
      throw new Error("Could not resolve host: github.com");
    },
  });
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  await assert.rejects(() => planner.launch(draft.planId), /could not fetch/i);
});

test("rejects a launch while questions are still open", async () => {
  const deps = fakeDeps({ replies: [envelope('{"questions":[{"text":"Which database?"}]}', "sess-a")] });
  const planner = new WorktreePlanner(deps);
  const draft = await planner.start({ repositoryId: REPO_ID, goal: "Add billing" });
  await assert.rejects(() => planner.launch(draft.planId), /not ready/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/worktree-planner.test.mjs`
Expected: FAIL with `planner.launch is not a function`.

- [ ] **Step 3: Write the launch method**

The class needs the Git helper. Change the constructor signature line and add one field:

```javascript
  constructor({ worktrees, cmux, accountUsage, git = null, execute = execFileAsync, maxRounds = 6, timeoutMs = ROUND_TIMEOUT_MS, ttlMs = DRAFT_TTL_MS } = {}) {
```

and inside the constructor body, after `this.worktrees = worktrees;`:

```javascript
    this.git = git || ((cwd, args, options) => worktrees.repoCatalog.git(cwd, args, options));
```

Then add the two methods to the class, after `update`:

```javascript
  async launch(planId) {
    const draft = this.#draft(planId);
    if (draft.status !== "ready" || !draft.tasks.length) throw new TypeError("This plan is not ready to launch yet");
    const base = await this.#baseRef(draft);
    const results = [];
    for (const task of draft.tasks) {
      try {
        const created = await this.worktrees.create(draft.repositoryId, { branch: task.branch, base });
        const workspace = await this.cmux.workspaceCreate({
          cwd: created.worktree.path,
          title: task.title,
          agent: task.agent,
          prompt: task.prompt,
        });
        results.push({ id: task.id, title: task.title, branch: task.branch, agent: task.agent, status: "launched", path: created.worktree.path, workspace });
      } catch (cause) {
        results.push({ id: task.id, title: task.title, branch: task.branch, agent: task.agent, status: "failed", error: cause?.message || "Could not launch this task" });
      }
    }
    this.drafts.delete(draft.planId);
    return { planId: draft.planId, base, results };
  }

  // Branch every task from the up-to-date default remote branch, so the tasks
  // never inherit each other's work or a stale local commit.
  async #baseRef(draft) {
    const repositoryPath = await this.#repositoryPath(draft);
    let branch = "main";
    try {
      const output = await this.git(repositoryPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      branch = String(output).trim().replace(/^origin\//, "") || "main";
    } catch {
      branch = "main";
    }
    try {
      await this.git(repositoryPath, ["fetch", "origin", branch], { timeout: 120_000 });
    } catch (cause) {
      const detail = String(cause?.stderr || cause?.message || "").trim().split("\n").at(-1)?.slice(0, 160);
      throw new TypeError(detail ? `Git could not fetch origin/${branch}: ${detail}` : `Git could not fetch origin/${branch}`);
    }
    return `origin/${branch}`;
  }

  async #repositoryPath(draft) {
    const dashboard = await this.worktrees.snapshot({ refresh: false });
    const repository = dashboard.repositories.find((item) => item.id === draft.repositoryId);
    if (!repository) throw new TypeError("Unknown repository");
    return repository.path;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/worktree-planner.test.mjs`
Expected: PASS, 21 tests.

- [ ] **Step 5: Commit**

```bash
git add server/worktree-planner.mjs tests/worktree-planner.test.mjs
git commit -m "Launch a confirmed plan into fresh worktrees"
```

---

### Task 5: Expose the four routes

**Files:**
- Modify: `server/app.mjs:9` (import), `server/app.mjs:31` (option), `server/app.mjs:49` (wiring), and after `server/app.mjs:258` (routes)
- Test: `tests/api.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/api.test.mjs`:

```javascript
function fakePlanner() {
  const calls = [];
  const draft = {
    planId: "plan-1",
    repositoryId: "repository12345678",
    goal: "Add billing",
    round: 1,
    status: "ready",
    questions: [],
    tasks: [{ id: "t1", title: "Billing", branch: "feature/billing", prompt: "Add billing.", agent: "claude", agentReason: "Claude · 90% left" }],
  };
  return {
    calls,
    start: async (options) => { calls.push(["start", options]); return draft; },
    answer: async (planId, options) => { calls.push(["answer", planId, options]); return { ...draft, round: 2 }; },
    update: async (planId, options) => { calls.push(["update", planId, options]); return { ...draft, tasks: options.tasks }; },
    launch: async (planId) => { calls.push(["launch", planId]); return { planId, base: "origin/main", results: [{ id: "t1", status: "launched" }] }; },
  };
}

test("drives a worktree plan from goal to launch", async () => {
  const planner = fakePlanner();
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner });
  t_after(app);
  const headers = { authorization: `Bearer ${TOKEN}`, origin: "http://localhost" };

  const started = await app.inject({ method: "POST", url: "/api/worktree-plans", headers, payload: { repositoryId: "repository12345678", goal: "Add billing" } });
  assert.equal(started.statusCode, 201);
  assert.equal(started.json().planId, "plan-1");

  const answered = await app.inject({ method: "POST", url: "/api/worktree-plans/plan-1/answers", headers, payload: { answers: [{ id: "q1", text: "Postgres" }] } });
  assert.equal(answered.statusCode, 200);
  assert.equal(answered.json().round, 2);

  const patched = await app.inject({ method: "PATCH", url: "/api/worktree-plans/plan-1", headers, payload: { tasks: [{ id: "t1", title: "Billing", branch: "feature/billing", prompt: "Add billing.", agent: "codex" }] } });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().tasks[0].agent, "codex");

  const launched = await app.inject({ method: "POST", url: "/api/worktree-plans/plan-1/launch", headers, payload: {} });
  assert.equal(launched.statusCode, 200);
  assert.equal(launched.json().base, "origin/main");
  assert.deepEqual(planner.calls.map((call) => call[0]), ["start", "answer", "update", "launch"]);
});

test("turns a planner rejection into a 400", async () => {
  const planner = fakePlanner();
  planner.start = async () => { throw new TypeError("Describe the goal for this repository"); };
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner });
  t_after(app);
  const response = await app.inject({
    method: "POST",
    url: "/api/worktree-plans",
    headers: { authorization: `Bearer ${TOKEN}`, origin: "http://localhost" },
    payload: { repositoryId: "repository12345678", goal: "" },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "Describe the goal for this repository");
});
```

Before you write those two tests, look at how the existing tests in `tests/api.test.mjs` close the app. Copy that exact pattern and replace every `t_after(app)` call above with it. If the file uses `t.after(() => app.close())` inside `test("name", async (t) => {...})`, then change both new tests to take the `t` argument and use that line.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/api.test.mjs`
Expected: FAIL with a 404 on `/api/worktree-plans`.

- [ ] **Step 3: Wire the planner and add the routes**

In `server/app.mjs`, add the import beside the other server imports near line 9:

```javascript
import { WorktreePlanner } from "./worktree-planner.mjs";
```

Add the option to the `buildApp` argument list, beside `worktreeDashboard`:

```javascript
  worktreePlanner = null,
```

Add the wiring right after the line that builds `worktrees`:

```javascript
  const planner = worktreePlanner || new WorktreePlanner({ worktrees, cmux, accountUsage });
```

Add the four routes after the archive route:

```javascript
  app.post("/api/worktree-plans", async (request, reply) => (
    reply.code(201).send(await planner.start({ repositoryId: request.body?.repositoryId, goal: request.body?.goal }))
  ));

  app.post("/api/worktree-plans/:planId/answers", async (request) => (
    planner.answer(request.params.planId, { answers: request.body?.answers, skip: request.body?.skip === true })
  ));

  app.patch("/api/worktree-plans/:planId", async (request) => (
    planner.update(request.params.planId, { tasks: request.body?.tasks })
  ));

  app.post("/api/worktree-plans/:planId/launch", async (request) => {
    const result = await planner.launch(request.params.planId);
    bootstrapSnapshot = null;
    worktrees.invalidate();
    return result;
  });
```

The app already sets `bodyLimit: 32 * 1024`. A plan with 8 tasks fits inside it, so no change is needed there.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/api.test.mjs`
Expected: PASS. The two new tests are included.

- [ ] **Step 5: Add the new test file to the test script**

In `package.json`, in the `test` script, add `tests/worktree-planner.test.mjs` right after `tests/worktree-dashboard.test.mjs`.

- [ ] **Step 6: Run the whole server suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/app.mjs tests/api.test.mjs package.json
git commit -m "Expose the worktree plan routes"
```

---

### Task 6: Build the goal sheet

**Files:**
- Create: `app/worktree-planner.tsx`
- Modify: `app/worktree-dashboard.tsx`
- Modify: `app/features.css`
- Test: `tests/ui-features.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `tests/ui-features.test.tsx`, matching the import style already used at the top of that file:

```tsx
import { WorktreePlannerSheet } from "../app/worktree-planner";

const PLAN_REPO = { id: "repository12345678", name: "sample" };

test("answers a planner question, then launches the plan", async () => {
  const user = userEvent.setup();
  const posts: Array<[string, unknown]> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    posts.push([url, init?.body ? JSON.parse(String(init.body)) : null]);
    if (url === "/api/worktree-plans") {
      return jsonResponse({ planId: "plan-1", goal: "Add billing", round: 1, status: "questions", questions: [{ id: "q1", text: "Which database?", options: [] }], tasks: [] });
    }
    if (url === "/api/worktree-plans/plan-1/answers") {
      return jsonResponse({ planId: "plan-1", goal: "Add billing", round: 2, status: "ready", questions: [], tasks: [{ id: "t1", title: "Billing", branch: "feature/billing", prompt: "Add billing.", agent: "claude", agentReason: "Claude · 90% left" }] });
    }
    if (url === "/api/worktree-plans/plan-1/launch") {
      return jsonResponse({ planId: "plan-1", base: "origin/main", results: [{ id: "t1", title: "Billing", status: "launched" }] });
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<WorktreePlannerSheet repository={PLAN_REPO} onClose={() => {}} onLaunched={async () => {}} onNotice={() => {}} />);

  await user.type(screen.getByLabelText("Goal"), "Add billing");
  await user.click(screen.getByRole("button", { name: "Plan this goal" }));

  const answer = await screen.findByLabelText("Which database?");
  await user.type(answer, "Postgres");
  await user.click(screen.getByRole("button", { name: "Answer" }));

  await screen.findByText("feature/billing");
  await user.click(screen.getByRole("button", { name: "Launch 1 session" }));

  await screen.findByText(/Billing · launched/);
  assert.deepEqual(posts.map(([url]) => url), [
    "/api/worktree-plans",
    "/api/worktree-plans/plan-1/answers",
    "/api/worktree-plans/plan-1/launch",
  ]);
});
```

Look at the top of `tests/ui-features.test.tsx` first. Reuse the file's existing helper for a JSON response instead of `jsonResponse` if one exists, and reuse its assertion style (`expect` or `assert`). Do not add a second helper with the same job.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:ui`
Expected: FAIL. The error names the missing module `../app/worktree-planner`.

- [ ] **Step 3: Write the sheet**

Create `app/worktree-planner.tsx`:

```tsx
"use client";

import { FormEvent, useState } from "react";

type PlanQuestion = { id: string; text: string; options: string[] };
type PlanTask = { id: string; title: string; branch: string; prompt: string; agent: "claude" | "codex"; agentReason: string };
type PlanDraft = { planId: string; goal: string; round: number; status: "questions" | "ready"; questions: PlanQuestion[]; tasks: PlanTask[] };
type LaunchResult = { planId: string; base: string; results: Array<{ id: string; title: string; status: "launched" | "failed"; error?: string }> };
type PlannerRepository = { id: string; name: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(init?.body != null ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error || `Request failed (${response.status})`);
  return body as T;
}

export function WorktreePlannerSheet({ repository, onClose, onLaunched, onNotice }: {
  repository: PlannerRepository;
  onClose: () => void;
  onLaunched: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [goal, setGoal] = useState("");
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [launched, setLaunched] = useState<LaunchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run<T>(work: () => Promise<T>, apply: (value: T) => void) {
    setBusy(true);
    setError("");
    try { apply(await work()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The planner failed"); }
    finally { setBusy(false); }
  }

  function receive(next: PlanDraft) {
    setDraft(next);
    setAnswers({});
  }

  async function startPlan(event: FormEvent) {
    event.preventDefault();
    await run(() => request<PlanDraft>("/api/worktree-plans", { method: "POST", body: JSON.stringify({ repositoryId: repository.id, goal }) }), receive);
  }

  async function sendAnswers(skip: boolean) {
    if (!draft) return;
    const payload = skip ? { skip: true } : { answers: draft.questions.map((question) => ({ id: question.id, text: answers[question.id] || "" })) };
    await run(() => request<PlanDraft>(`/api/worktree-plans/${draft.planId}/answers`, { method: "POST", body: JSON.stringify(payload) }), receive);
  }

  async function editTasks(tasks: PlanTask[]) {
    if (!draft) return;
    await run(() => request<PlanDraft>(`/api/worktree-plans/${draft.planId}`, { method: "PATCH", body: JSON.stringify({ tasks }) }), receive);
  }

  async function launch() {
    if (!draft) return;
    await run(() => request<LaunchResult>(`/api/worktree-plans/${draft.planId}/launch`, { method: "POST", body: "{}" }), async (result) => {
      setLaunched(result);
      setDraft(null);
      await onLaunched();
      onNotice(`Launched ${result.results.filter((item) => item.status === "launched").length} session(s)`);
    });
  }

  return <>
    <button className="session-menu-backdrop" aria-label="Close goal planner" onClick={onClose} />
    <section className="worktree-launcher worktree-planner" role="dialog" aria-modal="true" aria-label="Plan a goal">
      <header>
        <div><strong>Plan a goal</strong><span>{repository.name}{draft ? ` · round ${draft.round}` : ""}</span></div>
        <button type="button" onClick={onClose}>×</button>
      </header>

      {error && <p className="worktree-action-error">{error}</p>}

      {!draft && !launched && <form onSubmit={startPlan}>
        <label className="worktree-task">
          <span>Goal</span>
          <textarea value={goal} onChange={(event) => setGoal(event.target.value)} rows={5} maxLength={4_000} placeholder="Describe the outcome. The planner splits it into independent tasks." />
        </label>
        <button className="primary-button" disabled={busy || !goal.trim()}>{busy ? "Planning…" : "Plan this goal"}</button>
      </form>}

      {draft?.status === "questions" && <div className="planner-questions">
        {draft.questions.map((question) => <label key={question.id} className="worktree-task">
          <span>{question.text}</span>
          <textarea aria-label={question.text} rows={2} value={answers[question.id] || ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />
          {question.options.length > 0 && <div className="planner-options">{question.options.map((option) => (
            <button key={option} type="button" onClick={() => setAnswers((current) => ({ ...current, [question.id]: option }))}>{option}</button>
          ))}</div>}
        </label>)}
        <div className="worktree-launch-actions">
          <button type="button" className="worktree-add-images" disabled={busy} onClick={() => sendAnswers(true)}>Skip questions</button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => sendAnswers(false)}>{busy ? "Planning…" : "Answer"}</button>
        </div>
      </div>}

      {draft?.status === "ready" && <div className="planner-tasks">
        {draft.tasks.map((task) => <article key={task.id} className="planner-task">
          <header>
            <strong>{task.title}</strong>
            <button type="button" aria-label={`Remove ${task.title}`} disabled={busy || draft.tasks.length < 2} onClick={() => editTasks(draft.tasks.filter((item) => item.id !== task.id))}>×</button>
          </header>
          <code>{task.branch}</code>
          <div className="planner-agent">
            {(["codex", "claude"] as const).map((agent) => <button
              key={agent}
              type="button"
              className={task.agent === agent ? "selected" : ""}
              disabled={busy}
              onClick={() => editTasks(draft.tasks.map((item) => (item.id === task.id ? { ...item, agent } : item)))}
            >{agent === "claude" ? "Claude" : "Codex"}</button>)}
            <small>{task.agentReason}</small>
          </div>
          <details><summary>Prompt</summary><p>{task.prompt}</p></details>
        </article>)}
        <button type="button" className="primary-button" disabled={busy} onClick={launch}>
          {busy ? "Launching…" : `Launch ${draft.tasks.length} session${draft.tasks.length > 1 ? "s" : ""}`}
        </button>
      </div>}

      {launched && <div className="planner-results">
        <p>Base: {launched.base}</p>
        {launched.results.map((item) => <p key={item.id}>{item.title} · {item.status}{item.error ? ` · ${item.error}` : ""}</p>)}
        <button type="button" className="primary-button" onClick={onClose}>Done</button>
      </div>}
    </section>
  </>;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:ui`
Expected: PASS.

- [ ] **Step 5: Mount the sheet on the dashboard**

In `app/worktree-dashboard.tsx`, add the import beside the other app imports:

```tsx
import { WorktreePlannerSheet } from "./worktree-planner";
```

Add the state beside `createTarget`:

```tsx
  const [planTarget, setPlanTarget] = useState<DashboardRepository | null>(null);
```

In the repository `<summary>` block, next to the archive button, add:

```tsx
<button type="button" className="repo-archive-button" onClick={(event) => { event.preventDefault(); setPlanTarget(repository); }}>Plan a goal</button>
```

Beside the existing launcher mount at the end of the component, add:

```tsx
{planTarget && <WorktreePlannerSheet
  repository={{ id: planTarget.id, name: planTarget.name }}
  onClose={() => setPlanTarget(null)}
  onLaunched={() => load(true)}
  onNotice={onNotice}
/>}
```

- [ ] **Step 6: Add the styles**

Append to `app/features.css`:

```css
.worktree-planner .planner-questions,.worktree-planner .planner-tasks,.worktree-planner .planner-results{display:flex;flex-direction:column;gap:10px}
.worktree-planner .planner-options{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.worktree-planner .planner-options button{border:1px solid var(--line);border-radius:8px;background:#191e24;color:#b8c0c8;padding:7px 9px;font-size:9px}
.planner-task{border:1px solid #252d34;border-radius:13px;background:#171c21;padding:11px}
.planner-task>header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.planner-task>header strong{font-size:11px}
.planner-task>header button{width:28px;height:28px;border:1px solid transparent;border-radius:8px;background:transparent;color:#7d8690;font-size:16px}
.planner-task>header button:disabled{opacity:.4}
.planner-task>code{display:block;margin:7px 0;color:#78818b;font:8px ui-monospace,monospace}
.planner-agent{display:flex;align-items:center;gap:6px}
.planner-agent button{border:1px solid var(--line);border-radius:8px;background:#191e24;color:#b8c0c8;padding:6px 10px;font-size:9px}
.planner-agent button.selected{border-color:#586d31;background:#18200f;color:var(--lime)}
.planner-agent small{color:var(--muted);font-size:7px}
.planner-task details{margin-top:8px}
.planner-task summary{cursor:pointer;color:var(--muted);font-size:8px}
.planner-task details p{margin:6px 0 0;color:#b8c0c8;font-size:9px;line-height:1.5}
.planner-results p{margin:0;color:#b8c0c8;font-size:9px}
```

- [ ] **Step 7: Run the UI tests again**

Run: `npm run test:ui`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/worktree-planner.tsx app/worktree-dashboard.tsx app/features.css tests/ui-features.test.tsx
git commit -m "Add the goal planner sheet to the worktree dashboard"
```

---

### Task 7: Verify the whole feature

**Files:** none changed unless a check fails.

- [ ] **Step 1: Run the full verification**

Run: `npm run verify`
Expected: PASS. It runs `npm test`, `npm run test:ui`, `npm run lint`, `npm run typecheck`, and `npm run build`.

- [ ] **Step 2: Fix every reported error**

Do not report the feature as done while any of the five stages fails. Type errors in `app/worktree-planner.tsx` are the most likely, because the sheet is the only new TypeScript file.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "Fix verification findings for the goal planner"
```

- [ ] **Step 4: One manual check against the real CLI**

The suite fakes the `ccs` subprocess, so one live check is needed. Start the companion with `npm run companion:dev`. Open the worktree dashboard. Press "Plan a goal" on this repository. Enter a two-part goal, for example: "Add a health endpoint and write its README section." Confirm three things:

1. The planner answers within 180 seconds, with questions or with tasks.
2. Each task card names a `feature/` branch and shows an agent reason with a percentage.
3. A launch creates the sibling worktree directories and the cmux sessions.

Remove the created worktrees afterwards with the dashboard's own remove action.
