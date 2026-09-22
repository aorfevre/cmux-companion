# Burst Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One **Burst scan** action reads every starred repository with a read-only agent, proposes one goal per repository as a card on the Goals board, and lets the user start each proposal as an ordinary goal session.

**Architecture:** Burst scan copies GitHub Sync. A JSON file store holds one candidate per starred repository. A service runs one headless read-only `ccs` scan per repository through the existing `streamExecFile`, validates the JSON answer and stores it. The board shows the candidates in one new column beside GitHub Issues. **Start goal** on a card calls the existing `GoalSessionService.start()`, so the goal opens its visible cmux conversation and its spec gate exactly as today. No new goal option, no extra reviewer, no new SQLite table, no side sheet.

**Tech Stack:** Node 22 (`node:test`), Fastify, React 19, Vitest, Cypress. Spec: `docs/superpowers/specs/2026-09-08-burst-mode-design.md`, reduced as stated below.

---

## Scope reduction, decided here

This plan replaces `docs/superpowers/plans/2026-09-08-burst-mode.md`. It keeps the **Burst plan** half of the spec and drops the **Burst flag** half. Fold these deltas into the spec before execution:

| Spec item | Decision | Reason |
| --- | --- | --- |
| Burst flag, task brief block, extra review agents, capacity floor wait | Dropped | New goals are goal sessions. `taskPrompt()` runs only in the combined-workflow integrator, so the flag would not reach the agent. `GoalSessionService.start()` rejects automated reviewers by design (`server/goal-session-service.mjs:25`). Reopen as its own spec after a product decision. |
| `burst_plans` and `burst_candidates` SQLite tables | Replaced by one JSON file `~/.config/cmux-companion/burst-candidates.json` | One candidate per starred repository is the whole state. `GitHubIssueStore` already shows the pattern. |
| `app/burst-plan.tsx` review sheet and Board tools entry | Replaced by one board column **Burst proposals** and one **Burst scan** button in Board tools | The board is the mission-control surface. Issue cards already show "proposal per repository" with a start action. |
| Opportunity banner | Replaced by one **Burst scan** button inside the existing `WeeklyOpportunities` panel | The panel already shows the window. A second banner repeats it. |
| **Approve** action | Renamed **Start goal** | **Approve** is the spec gate on the board. One word, one meaning. |
| Burst history list | Dropped | One current scan. A new scan replaces undecided candidates and keeps started ones. |
| Rescan one repository | Kept | One button per failed or proposed card. |

Candidate `status` is one of `scanning`, `proposed`, `failed`, `dismissed`, `started`.

Success measure, recorded for later validation: the count of `started` candidates whose goal reached a merged PR, per scan. The store keeps `planId`, so the existing plan store can answer this.

## File map

| File | Responsibility |
| --- | --- |
| `server/burst-candidate-store.mjs` (create) | JSON file store. One row per repository. Atomic write, 0o600. |
| `server/burst-scan.mjs` (create) | Scan, read, dismiss, rescan, start goal. Read-only headless agent, validated result. |
| `server/burst-board.mjs` (create) | Frozen column identity and hints shared by server and UI, like `github-issue-board.mjs`. |
| `server/app.mjs` (modify) | Wire the store and service; five routes. |
| `app/burst-column.tsx` (create) | The column and its card. |
| `app/agent-capacity.tsx` (modify) | **Burst scan** button in `WeeklyOpportunities`. |
| `app/worktree-dashboard.tsx` (modify) | Load candidates, render the column, Board tools button. |
| `app/features.css` (modify) | Column and card styles. |
| `tests/burst-candidate-store.test.mjs`, `tests/burst-scan.test.mjs` (create) | Backend tests. |
| `tests/ui-burst-column.test.tsx` (create) | Vitest for the column and card. |
| `cypress/e2e/burst-scan.cy.ts` (create) | Stubbed flow from scan to started goal. |
| `README.md`, `AGENTS.md` (modify) | One feature line, one important-code line. |

Conventions:

- Backend tests: `node --test tests/<name>.test.mjs`. Full: `npm test`.
- UI tests: `npx vitest run --config vitest.config.ts tests/<name>.test.tsx`.
- Before every commit: `npm run typecheck` and `npm run lint`.
- Commit messages: imperative, one line, no prefix.
- The tree is clean at the start. Stage by path.

---

## Phase 1 — Store and column identity

### Task 1: `burst-board.mjs` and `BurstCandidateStore`

**Files:**
- Create: `server/burst-board.mjs`
- Create: `server/burst-candidate-store.mjs`
- Test: `tests/burst-candidate-store.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BurstCandidateStore } from "../server/burst-candidate-store.mjs";
import { BURST_COLUMN, burstCardId } from "../server/burst-board.mjs";

const REPO = "repoAAAAAAAAAAAAAA";
const OTHER = "repoBBBBBBBBBBBBBB";

async function store(t) {
  const directory = await mkdtemp(join(tmpdir(), "cmux-companion-burst-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "burst-candidates.json");
  return { store: new BurstCandidateStore({ path }), path };
}

test("the column identity is frozen and keys one card per repository", () => {
  assert.equal(BURST_COLUMN.id, "burst_proposals");
  assert.equal(BURST_COLUMN.label, "Burst proposals");
  assert.equal(Object.isFrozen(BURST_COLUMN), true);
  assert.equal(burstCardId({ repositoryId: REPO }), `burst_proposals:${REPO}`);
  assert.equal(burstCardId({ repositoryId: "bad" }), "");
});

test("upsert keeps one row per repository and survives a reload", async (t) => {
  const { store: first, path } = await store(t);
  first.upsert({ repositoryId: REPO, repositoryName: "app", status: "scanning" });
  first.upsert({ repositoryId: REPO, repositoryName: "app", status: "proposed", goal: "Cover the store", rationale: "No tests", evidence: ["server/x.mjs"], sizeEstimate: "medium", scannedAt: "2026-09-08T10:00:00Z" });
  assert.equal(first.list().length, 1);
  assert.equal(first.get(REPO).goal, "Cover the store");
  const reloaded = new BurstCandidateStore({ path });
  assert.deepEqual(reloaded.get(REPO), first.get(REPO));
  assert.match(await readFile(path, "utf8"), /"candidates"/);
});

test("retainRepositories drops rows for repositories that are no longer starred", async (t) => {
  const { store: s } = await store(t);
  s.upsert({ repositoryId: REPO, repositoryName: "app", status: "proposed", goal: "g" });
  s.upsert({ repositoryId: OTHER, repositoryName: "site", status: "proposed", goal: "h" });
  s.retainRepositories([REPO]);
  assert.deepEqual(s.list().map((row) => row.repositoryId), [REPO]);
});

test("a malformed row is dropped and an unknown status is rejected", async (t) => {
  const { store: s } = await store(t);
  assert.throws(() => s.upsert({ repositoryId: REPO, repositoryName: "app", status: "weird" }), /status/);
  assert.throws(() => s.upsert({ repositoryId: "bad", repositoryName: "app", status: "scanning" }), /repository/);
  s.upsert({ repositoryId: REPO, repositoryName: "app", status: "failed", reason: "The scan needs the ccs CLI" });
  assert.equal(s.get(REPO).reason, "The scan needs the ccs CLI");
  assert.deepEqual(s.get(REPO).evidence, []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/burst-candidate-store.test.mjs`
Expected: FAIL with `Cannot find module '../server/burst-candidate-store.mjs'`

- [ ] **Step 3: Write `server/burst-board.mjs`**

```js
// The Burst proposals column identity. The server keys candidates and the
// board renders cards with the same values, so a rename happens in one place.
export const BURST_COLUMN = Object.freeze({
  id: "burst_proposals",
  label: "Burst proposals",
  description: "One proposed goal per starred repository, read by a read-only agent. Start goal opens an ordinary goal session.",
});

export const BURST_EMPTY_HINT = "No burst proposals yet. Star a repository, then choose Burst scan to read every starred repository.";
export const BURST_NO_FAVORITES = "No starred repositories. Star a repository first; Burst scan reads starred repositories only.";
export const BURST_SCAN_NO_FAVORITES = "no_starred_repositories";
export const BURST_SCAN_RUNNING = "scanning";

export const BURST_STATUSES = Object.freeze(["scanning", "proposed", "failed", "dismissed", "started"]);
export const BURST_SIZES = Object.freeze(["small", "medium", "large"]);

const REPOSITORY_ID = /^[A-Za-z0-9_-]{18}$/;

export function burstCardId({ repositoryId } = {}) {
  return typeof repositoryId === "string" && REPOSITORY_ID.test(repositoryId) ? `${BURST_COLUMN.id}:${repositoryId}` : "";
}

// A card is visible while the user still has a decision to make on it, or
// while its scan runs. Started and dismissed candidates leave the column: the
// started goal is on the board in its own lifecycle column.
export function visibleBurstCandidates(candidates) {
  return (Array.isArray(candidates) ? candidates : []).filter((candidate) => ["scanning", "proposed", "failed"].includes(candidate?.status));
}
```

- [ ] **Step 4: Write `server/burst-candidate-store.mjs`**

```js
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readPrivateJson } from "./private-json-state.mjs";
import { BURST_SIZES, BURST_STATUSES } from "./burst-board.mjs";

const DEFAULT_PATH = join(homedir(), ".config", "cmux-companion", "burst-candidates.json");
const REPOSITORY_ID = /^[A-Za-z0-9_-]{18}$/;

// The durable half of Burst scan. One row per starred repository, rebuilt from
// this file after a reload or a companion restart. The write is atomic and
// private (0o700 directory, 0o600 file) like server/github-issue-store.mjs,
// because a proposed goal names private repository content.
export class BurstCandidateStore {
  constructor({ path = DEFAULT_PATH } = {}) {
    this.path = path;
    this.candidates = new Map();
    this.scannedAt = null;
    this.load();
  }

  load() {
    const value = readPrivateJson(this.path, { candidates: [], scannedAt: null }, (v) => v !== null && typeof v === "object" && Array.isArray(v.candidates));
    this.candidates = new Map();
    for (const row of Array.isArray(value?.candidates) ? value.candidates : []) {
      const candidate = normalize(row);
      if (candidate) this.candidates.set(candidate.repositoryId, candidate);
    }
    this.scannedAt = text(value?.scannedAt, 100) || null;
  }

  list() { return [...this.candidates.values()].sort((a, b) => a.repositoryName.localeCompare(b.repositoryName)); }

  get(repositoryId) { return this.candidates.get(repositoryId) || null; }

  // Replaces the row for one repository. Throws on a malformed candidate so a
  // caller bug is loud, unlike load(), which drops a corrupted file row.
  upsert(row) {
    const candidate = normalize(row);
    if (!candidate) throw new TypeError("Invalid burst candidate repository");
    if (!BURST_STATUSES.includes(candidate.status)) throw new TypeError(`Invalid burst candidate status: ${String(row?.status)}`);
    this.candidates.set(candidate.repositoryId, candidate);
    this.save();
    return candidate;
  }

  retainRepositories(repositoryIds) {
    const keep = new Set(repositoryIds);
    for (const id of [...this.candidates.keys()]) if (!keep.has(id)) this.candidates.delete(id);
    this.save();
  }

  markScanned(scannedAt) { this.scannedAt = scannedAt; this.save(); }

  save() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ scannedAt: this.scannedAt, candidates: this.list() }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }
}

function normalize(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const repositoryId = text(row.repositoryId, 100);
  if (!REPOSITORY_ID.test(repositoryId)) return null;
  const status = text(row.status, 20);
  if (!BURST_STATUSES.includes(status)) return { repositoryId, status };
  return {
    repositoryId,
    repositoryName: text(row.repositoryName, 200) || repositoryId,
    status,
    goal: text(row.goal, 8_000) || null,
    rationale: text(row.rationale, 4_000) || null,
    evidence: (Array.isArray(row.evidence) ? row.evidence : []).map((item) => text(item, 500)).filter(Boolean).slice(0, 20),
    sizeEstimate: BURST_SIZES.includes(row.sizeEstimate) ? row.sizeEstimate : null,
    reason: text(row.reason, 2_000) || null,
    planId: text(row.planId, 200) || null,
    scannedAt: text(row.scannedAt, 100) || null,
  };
}

function text(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
```

Note: `normalize()` returns `{ repositoryId, status }` for an unknown status so `upsert()` can name the status in its error. `load()` filters that case because `BURST_STATUSES.includes(candidate.status)` is false; add that check to the `load()` loop: `if (candidate && BURST_STATUSES.includes(candidate.status))`.

- [ ] **Step 5: Run to verify it passes**

Run: `node --test tests/burst-candidate-store.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 6: Commit**

```bash
git add server/burst-board.mjs server/burst-candidate-store.mjs tests/burst-candidate-store.test.mjs
git commit -m "Add the burst candidate store and column identity"
```

---

## Phase 2 — The scan service

### Task 2: `BurstScan`

**Files:**
- Create: `server/burst-scan.mjs`
- Test: `tests/burst-scan.test.mjs`

The command shape is the one the retired headless planner used (`git show eaa9bcc^:server/worktree-planner.mjs`, `#spawn`). `--allowed-tools` only auto-approves; `--disallowed-tools` enforces. Both are passed.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BurstCandidateStore } from "../server/burst-candidate-store.mjs";
import { BurstScan, scanPrompt, parseScanResult } from "../server/burst-scan.mjs";
import { BURST_SCAN_NO_FAVORITES } from "../server/burst-board.mjs";

const STARRED = "starredRepoABCDEFG";
const SECOND = "secondRepoABCDEFGH";
const OTHER = "plainRepoABCDEFGHI";
const envelope = (result) => `${JSON.stringify({ type: "system" })}\n${JSON.stringify({ type: "result", result: JSON.stringify(result) })}\n`;
const proposal = { goal: "Cover the store", rationale: "No tests", evidence: ["server/x.mjs"], sizeEstimate: "medium" };

async function harness(t, { resultsByPath = {}, failPaths = [], repositories = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cmux-companion-burst-scan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const starts = [];
  let inFlight = 0; let peak = 0;
  const execute = async (bin, args, options) => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    calls.push({ bin, args, cwd: options?.cwd });
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    if (failPaths.includes(options?.cwd)) throw new Error("ccs: command not found");
    return { stdout: resultsByPath[options?.cwd] ?? envelope(proposal) };
  };
  const worktrees = { snapshot: async () => ({ repositories: repositories || [
    { id: STARRED, name: "app", path: "/repo/app", favorite: true, archived: false },
    { id: SECOND, name: "site", path: "/repo/site", favorite: true, archived: false },
    { id: OTHER, name: "plain", path: "/repo/plain", favorite: false, archived: false },
  ] }) };
  const goalSessions = { start: async (input) => { starts.push(input); return { planId: `plan-${starts.length}`, workflow: "goal_session", goalSessionWorkspaceId: "ws-1" }; } };
  const accountUsage = { snapshot: async () => ({ providers: [
    { id: "claude", available: true, accounts: [{ id: "a", status: "ready", windows: [{ cadence: "weekly", remainingPercent: 80 }] }] },
    { id: "codex", available: true, accounts: [{ id: "b", status: "ready", windows: [{ cadence: "weekly", remainingPercent: 80 }] }] },
  ] }) };
  const modelSettings = { engine: (role, provider) => ({ provider, model: "default", effort: "default" }) };
  const store = new BurstCandidateStore({ path: join(directory, "burst-candidates.json") });
  const service = new BurstScan({ worktrees, goalSessions, store, accountUsage, modelSettings, execute, maxParallel: 3 });
  return { service, store, calls, starts, peak: () => peak };
}

test("an empty starred set is a stated reason, not an empty success", async (t) => {
  const { service } = await harness(t, { repositories: [{ id: OTHER, name: "plain", path: "/repo/plain", favorite: false }] });
  const result = await service.scan();
  assert.equal(result.status, BURST_SCAN_NO_FAVORITES);
  assert.match(result.message, /starred/);
  assert.deepEqual(result.candidates, []);
});

test("scan writes one scanning row per starred repository at once, then one proposal each", async (t) => {
  const { service, store, calls } = await harness(t);
  const started = await service.scan();
  assert.equal(started.status, "scanning");
  assert.deepEqual(store.list().map((row) => row.status), ["scanning", "scanning"]);
  await service.settle();
  assert.deepEqual(store.list().map((row) => [row.repositoryName, row.status, row.goal]), [["app", "proposed", "Cover the store"], ["site", "proposed", "Cover the store"]]);
  assert.equal(store.get(OTHER), null);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].bin, "ccs");
  assert.ok(["claude", "codex"].includes(calls[0].args[0]));
  assert.ok(calls[0].args.includes("--print"));
  assert.equal(calls[0].args[calls[0].args.indexOf("--allowed-tools") + 1], "Read,Grep,Glob");
  assert.match(calls[0].args[calls[0].args.indexOf("--disallowed-tools") + 1], /Bash/);
  assert.equal(calls[0].args.at(-2), "--");
  assert.match(calls[0].args.at(-1), /one JSON object/);
  assert.deepEqual(calls.map((call) => call.cwd).sort(), ["/repo/app", "/repo/site"]);
});

test("one failed repository never aborts the others and keeps its reason", async (t) => {
  const { service, store } = await harness(t, { failPaths: ["/repo/site"] });
  await service.scan();
  await service.settle();
  assert.equal(store.get(STARRED).status, "proposed");
  assert.equal(store.get(SECOND).status, "failed");
  assert.match(store.get(SECOND).reason, /ccs: command not found/);
});

test("invalid agent output marks the candidate failed instead of storing an empty proposal", async (t) => {
  const { service, store } = await harness(t, { resultsByPath: { "/repo/site": envelope({ goal: "", sizeEstimate: "huge" }) } });
  await service.scan();
  await service.settle();
  assert.equal(store.get(SECOND).status, "failed");
  assert.match(store.get(SECOND).reason, /goal/);
});

test("a second scan while one runs returns the running scan; a scan after settle replaces undecided rows and keeps started ones", async (t) => {
  const { service, store, calls } = await harness(t);
  await service.scan();
  const again = await service.scan();
  assert.equal(again.status, "scanning");
  await service.settle();
  assert.equal(calls.length, 2);
  await service.startGoal(STARRED, {});
  await service.scan();
  assert.equal(store.get(STARRED).status, "started");
  assert.equal(store.get(SECOND).status, "scanning");
  await service.settle();
});

test("startGoal calls the goal session with the edited goal, records the plan, and is idempotent", async (t) => {
  const { service, store, starts } = await harness(t);
  await service.scan();
  await service.settle();
  const first = await service.startGoal(STARRED, { goal: "Cover the store fully" });
  assert.equal(first.created, true);
  assert.deepEqual(starts, [{ repositoryId: STARRED, goal: "Cover the store fully" }]);
  assert.equal(store.get(STARRED).status, "started");
  assert.equal(store.get(STARRED).planId, "plan-1");
  const second = await service.startGoal(STARRED, { goal: "Something else" });
  assert.equal(second.created, false);
  assert.equal(second.plan.planId, "plan-1");
  assert.equal(starts.length, 1);
  await assert.rejects(() => service.startGoal(SECOND, { goal: "   " }), /goal/i);
});

test("dismiss and rescan act on one repository only", async (t) => {
  const { service, store, calls } = await harness(t);
  await service.scan();
  await service.settle();
  await service.dismiss(STARRED);
  assert.equal(store.get(STARRED).status, "dismissed");
  await service.rescan(SECOND);
  assert.equal(store.get(SECOND).status, "scanning");
  await service.settle();
  assert.equal(calls.length, 3);
  assert.equal(store.get(SECOND).status, "proposed");
  assert.equal(store.get(STARRED).status, "dismissed");
});

test("the scan never runs more than maxParallel agents at once", async (t) => {
  const many = Array.from({ length: 6 }, (_, index) => ({ id: `repo${String(index).padStart(14, "0")}`, name: `r${index}`, path: `/repo/r${index}`, favorite: true, archived: false }));
  const { service, peak } = await harness(t, { repositories: many });
  await service.scan();
  await service.settle();
  assert.ok(peak() <= 3, `peak was ${peak()}`);
});

test("parseScanResult reads the result line and validates the shape", () => {
  assert.deepEqual(parseScanResult(envelope(proposal)), proposal);
  assert.throws(() => parseScanResult("not json\n"), /result/);
  assert.throws(() => parseScanResult(envelope({ goal: "x".repeat(600), rationale: "r", evidence: [], sizeEstimate: "small" })), /goal/);
  assert.throws(() => parseScanResult(envelope({ goal: "g", rationale: "r", evidence: "nope", sizeEstimate: "small" })), /evidence/);
  assert.match(scanPrompt({ name: "app" }), /AGENTS\.md/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/burst-scan.test.mjs`
Expected: FAIL with `Cannot find module '../server/burst-scan.mjs'`

- [ ] **Step 3: Write `server/burst-scan.mjs`**

```js
import { streamExecFile } from "./planner-process.mjs";
import { assignAgents } from "./worktree-planner.mjs";
import { BURST_NO_FAVORITES, BURST_SCAN_NO_FAVORITES, BURST_SCAN_RUNNING, BURST_SIZES } from "./burst-board.mjs";

const REPOSITORY_ID = /^[A-Za-z0-9_-]{18}$/;
// Same enforcement note as the retired planner: --allowed-tools only
// auto-approves. --disallowed-tools is the list that restricts.
const ALLOWED_TOOLS = "Read,Grep,Glob";
const DENIED_TOOLS = "Bash,Write,Edit,MultiEdit,NotebookEdit,Task,WebFetch,WebSearch";
const ISOLATION = ["--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"];
const IDLE_TIMEOUT_MS = Number(process.env.CMUX_BURST_IDLE_TIMEOUT_MS) || 240_000;
const CEILING_MS = Number(process.env.CMUX_BURST_CEILING_MS) || 900_000;

// Burst scan: one read-only headless agent per starred repository, one
// proposed goal each. It proposes; it never starts work. Start goal hands the
// text to the ordinary goal session, so the spec gate is unchanged.
export class BurstScan {
  constructor({ worktrees, goalSessions, store, accountUsage, modelSettings, execute = streamExecFile, log = null, maxParallel = 3, idleTimeoutMs = IDLE_TIMEOUT_MS, ceilingMs = CEILING_MS }) {
    this.worktrees = worktrees;
    this.goalSessions = goalSessions;
    this.store = store;
    this.accountUsage = accountUsage;
    this.modelSettings = modelSettings;
    this.execute = execute;
    this.log = log;
    this.maxParallel = maxParallel;
    this.idleTimeoutMs = idleTimeoutMs;
    this.ceilingMs = ceilingMs;
    this.running = null;
    this.goalStarts = new Map();
  }

  read() {
    return { scannedAt: this.store.scannedAt, status: this.running ? BURST_SCAN_RUNNING : "idle", candidates: this.store.list() };
  }

  // Returns as soon as every starred repository has a `scanning` row. The
  // agents run in the background; settle() awaits them (tests and shutdown).
  async scan() {
    if (this.running) return { ...this.read(), status: BURST_SCAN_RUNNING };
    const repositories = await this.#favorites();
    if (!repositories.length) {
      this.store.retainRepositories([]);
      return { ...this.read(), status: BURST_SCAN_NO_FAVORITES, message: BURST_NO_FAVORITES };
    }
    this.store.retainRepositories(repositories.map((repository) => repository.id));
    const pending = repositories.filter((repository) => this.store.get(repository.id)?.status !== "started");
    for (const repository of pending) this.store.upsert({ repositoryId: repository.id, repositoryName: repository.name, status: "scanning" });
    this.#run(pending);
    return { ...this.read(), status: BURST_SCAN_RUNNING };
  }

  async rescan(repositoryId) {
    const repository = (await this.#favorites()).find((item) => item.id === repositoryId);
    if (!repository) throw new TypeError("That repository is not starred");
    if (this.store.get(repositoryId)?.status === "started") throw new TypeError("This proposal already started a goal");
    this.store.upsert({ repositoryId, repositoryName: repository.name, status: "scanning" });
    this.#run([repository]);
    return this.store.get(repositoryId);
  }

  async dismiss(repositoryId) {
    const candidate = this.#candidate(repositoryId);
    if (candidate.status === "started") throw new TypeError("This proposal already started a goal");
    return this.store.upsert({ ...candidate, status: "dismissed" });
  }

  // Same shape and same idempotency as GitHubIssueSync.startGoal: a repeat
  // returns the existing plan and never starts a second session.
  async startGoal(repositoryId, options = {}) {
    if (this.goalStarts.has(repositoryId)) return this.goalStarts.get(repositoryId).then((result) => ({ ...result, created: false }));
    const run = this.#startGoal(repositoryId, options);
    this.goalStarts.set(repositoryId, run);
    try { return await run; } finally { if (this.goalStarts.get(repositoryId) === run) this.goalStarts.delete(repositoryId); }
  }

  async #startGoal(repositoryId, options) {
    const candidate = this.#candidate(repositoryId);
    if (candidate.status === "started" && candidate.planId) return { candidate, plan: { planId: candidate.planId }, created: false };
    if (candidate.status !== "proposed") throw new TypeError("Only a proposed candidate can start a goal");
    const goal = typeof options.goal === "string" && options.goal.trim() ? options.goal.trim() : candidate.goal || "";
    if (!goal) throw new TypeError("A goal is required");
    const plan = await this.goalSessions.start({ repositoryId, goal });
    const updated = this.store.upsert({ ...candidate, goal, status: "started", planId: plan.planId });
    return { candidate: updated, plan, created: true };
  }

  settle() { return this.running || Promise.resolve(); }

  #candidate(repositoryId) {
    const candidate = REPOSITORY_ID.test(String(repositoryId)) ? this.store.get(repositoryId) : null;
    if (!candidate) throw new TypeError("Unknown burst candidate");
    return candidate;
  }

  #run(repositories) {
    const previous = this.running || Promise.resolve();
    const work = previous.then(() => this.#scanAll(repositories)).catch((cause) => { this.log?.warn?.({ err: cause }, "burst scan failed"); });
    this.running = work.finally(() => { if (this.running === work) this.running = null; });
  }

  async #scanAll(repositories) {
    const usage = await this.accountUsage.snapshot().catch(() => null);
    const agents = assignAgents(repositories.map((repository) => ({ id: repository.id })), usage);
    const provider = new Map(agents.map((task) => [task.id, task.agent]));
    let next = 0;
    const worker = async () => {
      for (let index = next++; index < repositories.length; index = next++) {
        const repository = repositories[index];
        try {
          const proposal = await this.#scanOne(repository, provider.get(repository.id) || "claude");
          this.store.upsert({ repositoryId: repository.id, repositoryName: repository.name, status: "proposed", ...proposal, scannedAt: new Date().toISOString() });
        } catch (cause) {
          this.store.upsert({ repositoryId: repository.id, repositoryName: repository.name, status: "failed", reason: cause?.message || String(cause), scannedAt: new Date().toISOString() });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.maxParallel, repositories.length) }, worker));
    this.store.markScanned(new Date().toISOString());
  }

  async #scanOne(repository, providerId) {
    const engine = this.modelSettings.engine("planner", providerId);
    const args = [engine.provider, "--print", "--output-format", "stream-json", "--verbose", ...ISOLATION, "--allowed-tools", ALLOWED_TOOLS, "--disallowed-tools", DENIED_TOOLS];
    if (engine.model && engine.model !== "default") args.push("--model", engine.model);
    if (engine.effort && engine.effort !== "default") args.push("--effort", engine.effort);
    // `--` is required: --allowed-tools is variadic and would swallow the prompt.
    args.push("--", scanPrompt(repository));
    const { stdout = "" } = await this.execute("ccs", args, { cwd: repository.path, timeout: this.ceilingMs, idleTimeout: this.idleTimeoutMs, maxBuffer: 4 * 1024 * 1024, env: process.env });
    return parseScanResult(stdout);
  }

  async #favorites() {
    const dashboard = await this.worktrees.snapshot({ refresh: true });
    return (Array.isArray(dashboard?.repositories) ? dashboard.repositories : [])
      .filter((repository) => repository?.favorite === true && repository?.archived !== true)
      .filter((repository) => typeof repository.id === "string" && REPOSITORY_ID.test(repository.id) && typeof repository.path === "string" && repository.path)
      .map((repository) => ({ id: repository.id, name: String(repository.name || repository.id).slice(0, 200), path: repository.path }));
  }
}

export function scanPrompt(repository) {
  return [
    `You are reading the repository "${repository.name}" to propose one goal. You may not change anything.`,
    "1. Read AGENTS.md or CLAUDE.md, then the README.",
    "2. Find the largest tractable increment worth one goal in this repository: a feature, a gap or a debt with clear value.",
    "3. Answer with exactly one JSON object and nothing else, with these keys:",
    '   "goal": one sentence a person could hand to an engineer;',
    '   "rationale": why this is the best next increment, at most three sentences;',
    '   "evidence": a list of file paths or commands that support the rationale;',
    '   "sizeEstimate": one of "small", "medium", "large".',
    "Do not propose more than one goal. Do not write files.",
  ].join("\n");
}

// stream-json: the last `result` line holds the model's final text. The text
// must be one JSON object with the documented keys; anything else is a stated
// failure for that repository, never a silent empty proposal.
export function parseScanResult(stdout) {
  const lines = String(stdout).split("\n").filter(Boolean);
  let final = null;
  for (const line of lines) {
    try { const event = JSON.parse(line); if (event?.type === "result") final = event; } catch { /* progress noise */ }
  }
  if (!final || typeof final.result !== "string") throw new TypeError("The scan returned no result line");
  const match = final.result.match(/\{[\s\S]*\}/);
  if (!match) throw new TypeError("The scan result is not a JSON object");
  let value;
  try { value = JSON.parse(match[0]); } catch { throw new TypeError("The scan result is not valid JSON"); }
  const goal = typeof value.goal === "string" ? value.goal.trim() : "";
  if (!goal || goal.length > 500) throw new TypeError("The scan result needs a goal of at most 500 characters");
  const rationale = typeof value.rationale === "string" ? value.rationale.trim().slice(0, 2_000) : "";
  if (!rationale) throw new TypeError("The scan result needs a rationale");
  if (!Array.isArray(value.evidence) || !value.evidence.every((item) => typeof item === "string")) throw new TypeError("The scan result evidence must be a list of strings");
  if (!BURST_SIZES.includes(value.sizeEstimate)) throw new TypeError("The scan result sizeEstimate must be small, medium or large");
  return { goal, rationale, evidence: value.evidence.map((item) => item.trim()).filter(Boolean).slice(0, 20), sizeEstimate: value.sizeEstimate };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/burst-scan.test.mjs`
Expected: PASS, 9 tests. If `assignAgents` throws when both providers are at the floor, the test usage has 80% headroom, so it does not. If it throws for a `null` usage, wrap the call: `let agents; try { agents = assignAgents(...) } catch { agents = repositories.map((r) => ({ id: r.id, agent: "claude" })); }` and keep the failure reason for the card out of it: quota is checked again by `GoalSessionService.start()`.

- [ ] **Step 5: Commit**

```bash
git add server/burst-scan.mjs tests/burst-scan.test.mjs
git commit -m "Add the burst scan service"
```

---

## Phase 3 — Routes

### Task 3: Wire the store, the service and five routes

**Files:**
- Modify: `server/app.mjs` (imports; wiring near line 164 where `issueSync` is built; routes after the GitHub issue routes near line 757)
- Test: `tests/burst-scan.test.mjs` covers the service; the routes are exercised by the Cypress spec in Task 6 and by `npm run typecheck`.

- [ ] **Step 1: Add the imports and wiring**

Imports at the top of `server/app.mjs`:

```js
import { BurstCandidateStore } from "./burst-candidate-store.mjs";
import { BurstScan } from "./burst-scan.mjs";
```

Constructor options: add `burstScan = null, burstCandidateStore = null` beside `githubIssueSync`.

After `issueSync` is built:

```js
  const burst = burstScan
    || (goalSessions ? new BurstScan({ worktrees, goalSessions, store: burstCandidateStore || new BurstCandidateStore(), accountUsage, modelSettings, log: app.log }) : null);
```

- [ ] **Step 2: Add the routes** (after the `/api/github-issues/:repositoryId/:number/goal` route)

```js
  // Burst scan: one proposed goal per starred repository. Read is a file read
  // and never runs an agent. Scan returns as soon as every row says scanning.
  const burstRepositoryId = (value) => {
    const id = String(value || "");
    if (!/^[A-Za-z0-9_-]{18}$/.test(id)) throw new TypeError("Invalid repository");
    return id;
  };
  app.get("/api/burst", async () => {
    if (!burst) throw serviceUnavailable("Burst scan is unavailable");
    return burst.read();
  });
  app.post("/api/burst/scan", async () => {
    if (!burst) throw serviceUnavailable("Burst scan is unavailable");
    return burst.scan();
  });
  app.post("/api/burst/:repositoryId/rescan", async (request) => {
    if (!burst) throw serviceUnavailable("Burst scan is unavailable");
    return burst.rescan(burstRepositoryId(request.params.repositoryId));
  });
  app.post("/api/burst/:repositoryId/dismiss", async (request) => {
    if (!burst) throw serviceUnavailable("Burst scan is unavailable");
    return burst.dismiss(burstRepositoryId(request.params.repositoryId));
  });
  app.post("/api/burst/:repositoryId/start", { schema: WRITE_SCHEMAS.burstStart }, async (request) => {
    if (!burst) throw serviceUnavailable("Burst scan is unavailable");
    const result = await burst.startGoal(burstRepositoryId(request.params.repositoryId), request.body || {});
    bootstrapSnapshot = null;
    worktrees.invalidate();
    return result;
  });
```

Add to `server/request-schemas.mjs` inside `WRITE_SCHEMAS`:

```js
  burstStart: body({ goal: { type: "string", maxLength: 8000 } }),
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass. Then start the backend with a disposable token per AGENTS.md and confirm:

```sh
curl -s -H "Authorization: Bearer $CMUX_COMPANION_TOKEN" http://127.0.0.1:3210/api/burst
```

Expected: `{"scannedAt":null,"status":"idle","candidates":[]}`. Do not run a real scan against personal repositories in this step.

- [ ] **Step 4: Commit**

```bash
git add server/app.mjs server/request-schemas.mjs
git commit -m "Serve burst scan reads, scans and proposal actions"
```

---

## Phase 4 — The board column

### Task 4: `BurstColumn` and `BurstCard`

**Files:**
- Create: `app/burst-column.tsx`
- Modify: `app/features.css` (append)
- Test: `tests/ui-burst-column.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import assert from "node:assert/strict";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, test, vi } from "vitest";
import { BurstColumn, type BurstCandidate } from "../app/burst-column";

afterEach(() => cleanup());

const REPO = "repoAAAAAAAAAAAAAA";
const candidates: BurstCandidate[] = [
  { repositoryId: REPO, repositoryName: "trust-layer", status: "proposed", goal: "Cover the plan store", rationale: "35 modules have no test", evidence: ["server/plan-store.mjs"], sizeEstimate: "medium", reason: null, planId: null, scannedAt: "2026-09-08T10:05:00Z" },
  { repositoryId: "repoBBBBBBBBBBBBBB", repositoryName: "ledger", status: "failed", goal: null, rationale: null, evidence: [], sizeEstimate: null, reason: "The scan needs the ccs CLI", planId: null, scannedAt: "2026-09-08T10:05:00Z" },
  { repositoryId: "repoCCCCCCCCCCCCCC", repositoryName: "site", status: "scanning", goal: null, rationale: null, evidence: [], sizeEstimate: null, reason: null, planId: null, scannedAt: null },
  { repositoryId: "repoDDDDDDDDDDDDDD", repositoryName: "done", status: "started", goal: "x", rationale: null, evidence: [], sizeEstimate: null, reason: null, planId: "plan-1", scannedAt: null },
];

function renderColumn(overrides: Partial<Parameters<typeof BurstColumn>[0]> = {}) {
  const props = { candidates, scanning: false, busy: {}, collapsed: false, onToggle: vi.fn(), onStart: vi.fn(), onDismiss: vi.fn(), onRescan: vi.fn(), ...overrides };
  render(<BurstColumn {...props} />);
  return props;
}

test("shows one card per undecided candidate with goal, rationale, evidence and a stated failure", () => {
  renderColumn();
  assert.equal(screen.getAllByRole("listitem").length, 3);
  assert.ok(screen.getByDisplayValue("Cover the plan store"));
  assert.ok(screen.getByText("35 modules have no test"));
  assert.ok(screen.getByText("server/plan-store.mjs"));
  assert.ok(screen.getByText("The scan needs the ccs CLI"));
  assert.ok(screen.getByText("Reading the repository…"));
  assert.equal(screen.queryByText("done"), null);
});

test("start sends the edited goal; dismiss and rescan name the repository", async () => {
  const props = renderColumn();
  const goal = screen.getByLabelText("Goal for trust-layer");
  await userEvent.clear(goal);
  await userEvent.type(goal, "Cover the plan store fully");
  await userEvent.click(screen.getByRole("button", { name: "Start goal for trust-layer" }));
  assert.deepEqual(props.onStart.mock.calls[0], [candidates[0], "Cover the plan store fully"]);
  await userEvent.click(screen.getByRole("button", { name: "Dismiss trust-layer" }));
  assert.deepEqual(props.onDismiss.mock.calls[0], [candidates[0]]);
  await userEvent.click(screen.getByRole("button", { name: "Rescan ledger" }));
  assert.deepEqual(props.onRescan.mock.calls[0], [candidates[1]]);
});

test("an empty goal cannot start, and a busy card disables its actions", async () => {
  renderColumn({ busy: { [`burst_proposals:${REPO}`]: true } });
  assert.ok(screen.getByRole("button", { name: "Start goal for trust-layer" }).hasAttribute("disabled"));
  assert.ok(screen.getByRole("button", { name: "Dismiss trust-layer" }).hasAttribute("disabled"));
});

test("the column states scanning and the empty hint", () => {
  renderColumn({ candidates: [], scanning: true });
  assert.ok(screen.getByText(/Scanning starred repositories/));
  cleanup();
  renderColumn({ candidates: [] });
  assert.ok(screen.getByText(/No burst proposals yet/));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --config vitest.config.ts tests/ui-burst-column.test.tsx`
Expected: FAIL with `Failed to resolve import "../app/burst-column"`

- [ ] **Step 3: Write `app/burst-column.tsx`**

```tsx
"use client";
import { useState } from "react";
import { BURST_COLUMN, BURST_EMPTY_HINT, burstCardId, visibleBurstCandidates } from "../server/burst-board.mjs";

export type BurstCandidate = { repositoryId: string; repositoryName: string; status: "scanning" | "proposed" | "failed" | "dismissed" | "started"; goal: string | null; rationale: string | null; evidence: string[]; sizeEstimate: "small" | "medium" | "large" | null; reason: string | null; planId: string | null; scannedAt: string | null };
export type BurstPayload = { scannedAt: string | null; status: "idle" | "scanning" | "no_starred_repositories"; message?: string; candidates: BurstCandidate[] };

type Props = { candidates: BurstCandidate[]; scanning: boolean; busy: Record<string, boolean>; collapsed: boolean; onToggle: () => void; onStart: (candidate: BurstCandidate, goal: string) => void; onDismiss: (candidate: BurstCandidate) => void; onRescan: (candidate: BurstCandidate) => void };

// The Burst proposals column. Same shape as the GitHub Issues column: one card
// per repository with a start action, and a started card leaves the column
// because its goal is now on the board in its own lifecycle column.
export function BurstColumn({ candidates, scanning, busy, collapsed, onToggle, onStart, onDismiss, onRescan }: Props) {
  const visible = visibleBurstCandidates(candidates) as BurstCandidate[];
  return <section className={`goal-board-column burst-column${collapsed ? " collapsed" : ""}`} aria-labelledby={`goal-board-${BURST_COLUMN.id}`}>
    <header><h3 id={`goal-board-${BURST_COLUMN.id}`}>{BURST_COLUMN.label}</h3><button type="button" className="goal-board-column-toggle" aria-label={`${collapsed ? "Expand" : "Collapse"} ${BURST_COLUMN.label}`} aria-expanded={!collapsed} onClick={onToggle}>{collapsed ? "›" : "‹"}</button><b aria-label={`${visible.length} proposal${visible.length === 1 ? "" : "s"}`}>{visible.length}</b></header>
    {!collapsed && scanning && <p className="goal-board-empty burst-scanning" role="status">Scanning starred repositories… cards fill in as each agent answers.</p>}
    {!collapsed && (visible.length === 0
      ? (!scanning && <p className="goal-board-empty">{BURST_EMPTY_HINT}</p>)
      : <ul className="goal-board-cards" aria-label={`${BURST_COLUMN.label} cards`}>{visible.map((candidate) => <li key={burstCardId(candidate)}><BurstCard candidate={candidate} busy={busy[burstCardId(candidate)] === true} onStart={onStart} onDismiss={onDismiss} onRescan={onRescan} /></li>)}</ul>)}
  </section>;
}

// Every field is agent output about a private repository: rendered as text
// children only, never as markup and never as an instruction to another agent.
function BurstCard({ candidate, busy, onStart, onDismiss, onRescan }: { candidate: BurstCandidate; busy: boolean; onStart: Props["onStart"]; onDismiss: Props["onDismiss"]; onRescan: Props["onRescan"] }) {
  const [goal, setGoal] = useState(candidate.goal ?? "");
  const name = candidate.repositoryName;
  const proposed = candidate.status === "proposed";
  return <article className={`goal-board-card burst-card ${candidate.status}`}>
    <div className="github-issue-head"><span className="github-issue-repository">{name}</span><b className="burst-state">{candidate.status === "scanning" ? "Scanning" : candidate.status === "failed" ? "Scan failed" : candidate.sizeEstimate ? `Size: ${candidate.sizeEstimate}` : "Proposed"}</b></div>
    {candidate.status === "scanning" && <p className="burst-muted">Reading the repository…</p>}
    {candidate.status === "failed" && <p className="burst-reason">{candidate.reason}</p>}
    {proposed && <>
      <label className="burst-goal"><span>Goal</span><textarea aria-label={`Goal for ${name}`} rows={3} maxLength={8_000} value={goal} onChange={(event) => setGoal(event.target.value)} /></label>
      {candidate.rationale && <p className="burst-rationale">{candidate.rationale}</p>}
      {candidate.evidence.length > 0 && <ul className="burst-evidence" aria-label={`Evidence for ${name}`}>{candidate.evidence.map((item, index) => <li key={index}><code>{item}</code></li>)}</ul>}
    </>}
    {candidate.status !== "scanning" && <footer>
      {proposed && <button type="button" className="github-issue-start" aria-label={`Start goal for ${name}`} disabled={busy || !goal.trim()} onClick={() => onStart(candidate, goal.trim())}>{busy ? "Starting a goal…" : "Start goal"}</button>}
      <div className="burst-secondary">
        {proposed && <button type="button" className="text-button" aria-label={`Dismiss ${name}`} disabled={busy} onClick={() => onDismiss(candidate)}>Dismiss</button>}
        <button type="button" className="text-button" aria-label={`Rescan ${name}`} disabled={busy} onClick={() => onRescan(candidate)}>Rescan</button>
      </div>
    </footer>}
  </article>;
}
```

Append to `app/features.css`:

```css
.burst-column{border-color:rgba(255,200,120,.24)}
.burst-card{border-color:rgba(255,200,120,.22)}
.burst-card.failed{border-color:#6a2b2b}
.burst-card .burst-state{font-size:10px;color:#96a0aa}
.burst-card .burst-goal{display:flex;flex-direction:column;gap:4px;font-size:11px}
.burst-card .burst-goal textarea{width:100%;min-height:56px;border:1px solid #2c343c;border-radius:8px;background:#0f1418;color:inherit;padding:6px;font:inherit;font-size:12px}
.burst-card .burst-rationale{margin:0;font-size:12px;line-height:1.45;color:#c9d1d9}
.burst-card .burst-evidence{margin:0;padding-left:16px;font-size:11px}
.burst-card .burst-reason{margin:0;color:#ff9d9d;font-size:12px}
.burst-card .burst-muted{margin:0;color:#96a0aa;font-size:12px}
.burst-card>footer{display:flex;flex-direction:column;gap:6px;border-top:1px solid #232c35;padding-top:8px}
.burst-card>footer .github-issue-start{width:100%;min-height:32px;border:1px solid #52632f;border-radius:8px;background:#18200f;color:var(--lime);padding:6px 8px;font-size:8px;font-weight:800}
.burst-card>footer .github-issue-start:disabled{opacity:.5}
.burst-card .burst-secondary{display:flex;justify-content:space-between;gap:8px}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --config vitest.config.ts tests/ui-burst-column.test.tsx`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add app/burst-column.tsx app/features.css tests/ui-burst-column.test.tsx
git commit -m "Add the Burst proposals board column"
```

### Task 5: Wire the column, Board tools and the weekly panel

**Files:**
- Modify: `app/worktree-dashboard.tsx` (imports near line 18; state near line 305; loaders near line 379; Board tools at line 826; board render at line 861)
- Modify: `app/agent-capacity.tsx:32-49` (`WeeklyOpportunities`)
- Test: `tests/ui-features.test.tsx` (append), `tests/ui-agent-capacity.test.tsx` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/ui-agent-capacity.test.tsx` (copy the `capacity` fixture shape already used in that file for a live weekly window):

```tsx
test("the weekly panel offers Burst scan when a window is live", () => {
  const now = Date.parse("2026-09-08T12:00:00Z");
  const weekly = { cadence: "weekly", label: "Weekly", remainingPercent: 60, resetAt: "2026-09-09T06:00:00Z" };
  const capacity = { available: true, next: "claude", reason: "", nextReset: weekly.resetAt, providers: [{ id: "claude", label: "Claude", available: true, headroom: 60, bestPercent: 60, accounts: [{ id: "w", label: "Work", status: "ready", headroom: 60, windows: [weekly], opportunity: weekly }] }] } as AgentCapacity;
  const scan = vi.fn();
  render(<WeeklyOpportunities capacity={capacity} error="" now={now} onBurstScan={scan} />);
  fireEvent.click(screen.getByRole("button", { name: "Burst scan" }));
  assert.equal(scan.mock.calls.length, 1);
});
```

Append to `tests/ui-features.test.tsx`, inside a new `describe("burst scan")`:

```tsx
  test("Board tools offers Burst scan, and the board shows the Burst proposals column", async () => {
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") { posts.push(url); return new Response(JSON.stringify({ scannedAt: null, status: "scanning", candidates: [] }), { status: 200 }); }
      if (url.includes("/api/burst")) return new Response(JSON.stringify({ scannedAt: null, status: "idle", candidates: [] }), { status: 200 });
      if (url.includes("/api/worktree-dashboard")) return new Response(JSON.stringify({ generatedAt: "2026-09-08T00:00:00Z", github: { status: "ready" }, summary: { repositories: 0 }, repositories: [], orphanSessions: [] }), { status: 200 });
      if (url.includes("/api/worktree-plans")) return new Response(JSON.stringify({ plans: [] }), { status: 200 });
      if (url.includes("/api/github-issues")) return new Response(JSON.stringify({ syncedAt: null, issues: [] }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    render(<WorktreeDashboardView onOpenWorkspace={() => {}} onLaunched={async () => {}} onNotice={() => {}} />);
    assert.ok(await screen.findByRole("heading", { name: "Burst proposals" }));
    await userEvent.click(await screen.findByText("Board tools"));
    await userEvent.click(screen.getByRole("button", { name: "Burst scan" }));
    await waitFor(() => assert.ok(posts.some((url) => url.endsWith("/api/burst/scan"))));
  });
```

If `WorktreeDashboardView` needs other required props in this file's existing tests, copy them from the nearest existing render of that component.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --config vitest.config.ts tests/ui-agent-capacity.test.tsx tests/ui-features.test.tsx -t "Burst"`
Expected: FAIL. The panel has no `Burst scan` button; the board has no `Burst proposals` heading.

- [ ] **Step 3: Edit `app/agent-capacity.tsx`**

Change the `WeeklyOpportunities` signature and header:

```tsx
export function WeeklyOpportunities({ capacity, error, now, onUsage, onBurstScan }: { capacity: AgentCapacity | null; error: string; now: number; onUsage?: () => void; onBurstScan?: () => void }) {
```

Replace the `<header>` line with:

```tsx
    <header><h3>Weekly reset soon</h3><div className="weekly-opportunity-actions">{onBurstScan && <button type="button" className="primary-button" onClick={onBurstScan}>Burst scan</button>}<button type="button" className="text-button" onClick={onUsage}>All account usage</button></div></header>
```

Append to `app/features.css`: `.weekly-opportunity-actions{display:flex;gap:8px;align-items:center}`

- [ ] **Step 4: Edit `app/worktree-dashboard.tsx`**

1. Import: `import { BurstColumn, type BurstCandidate, type BurstPayload } from "./burst-column";` and add `BURST_COLUMN, burstCardId` to the import from `../server/burst-board.mjs` (new import line).
2. State next to `issueCards`:

```tsx
  const [burstCandidates, setBurstCandidates] = useState<BurstCandidate[]>([]);
  const [burstScanning, setBurstScanning] = useState(false);
```

3. Loader next to `loadIssues`, and add `void loadBurst();` to the same kickoff and 10-second poll that call `loadIssues()`:

```tsx
  // The stored proposals. A file read only: it never runs an agent.
  const loadBurst = useCallback(async () => {
    try {
      const payload = await request<BurstPayload>("/api/burst");
      setBurstCandidates(Array.isArray(payload?.candidates) ? payload.candidates : []);
      setBurstScanning(payload?.status === "scanning");
    } catch {
      // A failed read leaves the last cards on screen, like the issue column.
    }
  }, []);
```

4. Actions near `startIssueGoal`:

```tsx
  async function burstScan() {
    await runBoardAction("burst:scan", async () => {
      try {
        const payload = await request<BurstPayload>("/api/burst/scan", { method: "POST", body: "{}" });
        if (payload.status === "no_starred_repositories") { onNotice(payload.message || "No starred repositories."); return; }
        setBurstScanning(true);
        setBurstCandidates(payload.candidates);
        onNotice("Burst scan started. Proposals appear in the Burst proposals column.");
      } catch (cause) { onNotice(cause instanceof Error ? cause.message : "Burst scan failed"); }
    });
  }
  async function burstAction(candidate: BurstCandidate, action: "dismiss" | "rescan" | "start", goal = "") {
    await runBoardAction(burstCardId(candidate), async () => {
      try {
        const body = action === "start" ? JSON.stringify({ goal }) : "{}";
        const result = await request<{ plan?: { planId: string }; created?: boolean } & BurstCandidate>(`/api/burst/${encodeURIComponent(candidate.repositoryId)}/${action}`, { method: "POST", body });
        await loadBurst();
        if (action === "start") { await loadGoalPlans(); onNotice(result.created === false ? `${candidate.repositoryName} already has a goal from this proposal.` : `Started a planning conversation for ${candidate.repositoryName}.`); }
      } catch (cause) { onNotice(cause instanceof Error ? cause.message : "Burst action failed"); }
    });
  }
```

5. Board tools, after the GitHub Sync button:

```tsx
<button type="button" className="text-button" disabled={boardBusy["burst:scan"] === true || burstScanning} onClick={() => { void burstScan(); }}>{burstScanning ? "Burst scanning…" : "Burst scan"}</button>
```

6. `WeeklyOpportunities` render: add `onBurstScan={() => { void burstScan(); }}`.
7. Board render: directly after the GitHub Issues `</section>` and before `{BOARD_COLUMNS.map(...)`:

```tsx
<BurstColumn candidates={burstCandidates} scanning={burstScanning} busy={boardBusy} collapsed={collapsedBoardColumns.has(BURST_COLUMN.id)} onToggle={() => toggleBoardColumn(BURST_COLUMN.id)} onStart={(candidate, goal) => { void burstAction(candidate, "start", goal); }} onDismiss={(candidate) => { void burstAction(candidate, "dismiss"); }} onRescan={(candidate) => { void burstAction(candidate, "rescan"); }} />
```

If `toggleBoardColumn` or `collapsedBoardColumns` types the column id as a union, widen that type to `string` or add `BURST_COLUMN.id`.

- [ ] **Step 5: Run to verify they pass, then the full UI suite**

Run: `npx vitest run --config vitest.config.ts tests/ui-agent-capacity.test.tsx tests/ui-features.test.tsx -t "Burst"`
Expected: PASS
Run: `npm run test:ui && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/worktree-dashboard.tsx app/agent-capacity.tsx app/features.css tests/ui-features.test.tsx tests/ui-agent-capacity.test.tsx
git commit -m "Show burst proposals on the board and offer Burst scan"
```

---

## Phase 5 — End-to-end coverage and docs

### Task 6: Cypress flow from scan to started goal

**Files:**
- Create: `cypress/e2e/burst-scan.cy.ts`

Copy the `scenario()` intercept list from `cypress/e2e/goal-sessions.cy.ts:1-30` for every endpoint the board reads, then add the burst intercepts below.

- [ ] **Step 1: Write the spec**

```ts
import { DEFAULT_MODEL_ROLES } from "../../server/model-options.mjs";

const now = "2026-09-08T12:00:00Z";
const REPO = "repoAAAAAAAAAAAAAA";
const repo = { id: REPO, name: "trust-layer", root: "fixture", path: "/fixture", favorite: true, pullRequestsAvailable: true, summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 }, worktrees: [] };
const proposed = { repositoryId: REPO, repositoryName: "trust-layer", status: "proposed", goal: "Cover the plan store", rationale: "35 modules have no test", evidence: ["server/plan-store.mjs"], sizeEstimate: "medium", reason: null, planId: null, scannedAt: now };
const plan = { planId: "plan-burst", repositoryId: REPO, repositoryName: "trust-layer", goal: "Cover the plan store fully", workflow: "goal_session", goalSessionWorkspaceId: "ws-burst", status: "draft", stage: "questions", taskCount: 0, launchedCount: 0, createdAt: now, updatedAt: now };

describe("burst scan", () => {
  it("scans, shows a proposal, and starts it as a goal session", () => {
    let phase: "idle" | "scanning" | "proposed" | "started" = "idle";
    cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing local fixture" } });
    cy.intercept("GET", "**/api/auth/status", { paired: true });
    cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "Fixture Mac" }, workspaces: [], refreshedAt: now });
    cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
    cy.intercept("GET", "**/api/repos", { repos: [] });
    cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
    cy.intercept("GET", "**/api/updater/status", { available: false });
    cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
    cy.intercept("GET", "**/api/github-issues*", { syncedAt: null, issues: [] });
    cy.intercept("GET", "**/api/goals/capacity*", { providers: [], next: null, available: false });
    cy.intercept("GET", "**/api/goals/health", { checkedAt: now, goals: [], summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0 } });
    cy.intercept("GET", "**/api/worktree-dashboard*", { generatedAt: now, github: { status: "ready" }, summary: { repositories: 1, ...repo.summary }, repositories: [repo], orphanSessions: [] });
    cy.intercept("GET", "**/api/settings/models", { roles: DEFAULT_MODEL_ROLES, defaults: DEFAULT_MODEL_ROLES, warning: null });
    cy.intercept("GET", "**/api/worktree-plans*", (request) => request.reply({ plans: phase === "started" ? [plan] : [] }));
    cy.intercept("GET", "**/api/burst", (request) => request.reply(
      phase === "idle" ? { scannedAt: null, status: "idle", candidates: [] }
        : phase === "scanning" ? { scannedAt: null, status: "scanning", candidates: [{ ...proposed, status: "scanning", goal: null }] }
          : { scannedAt: now, status: "idle", candidates: [phase === "started" ? { ...proposed, status: "started", planId: plan.planId } : proposed] },
    )).as("burst");
    cy.intercept("POST", "**/api/burst/scan", (request) => { phase = "scanning"; setTimeout(() => { phase = "proposed"; }, 300); request.reply({ scannedAt: null, status: "scanning", candidates: [{ ...proposed, status: "scanning", goal: null }] }); }).as("scan");
    cy.intercept("POST", `**/api/burst/${REPO}/start`, (request) => {
      expect(request.body).to.deep.equal({ goal: "Cover the plan store fully" });
      phase = "started";
      request.reply({ candidate: { ...proposed, status: "started", planId: plan.planId }, plan, created: true });
    }).as("start");

    cy.visit("/");
    cy.contains("h3", "Burst proposals").should("be.visible");
    cy.contains("summary", "Board tools").click();
    cy.contains("button", "Burst scan").click();
    cy.wait("@scan");
    cy.contains("Scanning starred repositories").should("be.visible");
    cy.contains("Cover the plan store", { timeout: 15_000 }).should("exist");
    cy.get('textarea[aria-label="Goal for trust-layer"]').clear().type("Cover the plan store fully");
    cy.get('button[aria-label="Start goal for trust-layer"]').click();
    cy.wait("@start");
    cy.contains("Started a planning conversation for trust-layer").should("be.visible");
    cy.get('button[aria-label="Start goal for trust-layer"]').should("not.exist");
  });
});
```

The dashboard polls `/api/burst` every 10 seconds, so the `{ timeout: 15_000 }` wait covers the scanning→proposed transition. If the poll interval differs, match the timeout.

- [ ] **Step 2: Run**

Run: `npm run test:e2e:local -- --spec cypress/e2e/burst-scan.cy.ts`
Expected: 1 passing. If Electron fails: `CMUX_COMPANION_CYPRESS_BROWSER=chrome npm run test:e2e:local -- --spec cypress/e2e/burst-scan.cy.ts`.

- [ ] **Step 3: Commit**

```bash
git add cypress/e2e/burst-scan.cy.ts
git commit -m "Cover burst scan from Board tools to a started goal"
```

### Task 7: README, AGENTS.md and the spec

**Files:**
- Modify: `README.md` ("What it does" list after the GitHub issues line; the Board tools sentence)
- Modify: `AGENTS.md` ("Important code")
- Modify: `docs/superpowers/specs/2026-09-08-burst-mode-design.md`

- [ ] **Step 1: README**

Add one bullet after the GitHub issues bullet:

```markdown
- Runs a **Burst scan** on demand: one read-only agent per starred repository proposes one goal each in the Burst proposals column, and **Start goal** opens it as an ordinary goal session with the same spec gate
```

In the Board tools sentence, add "Burst scan" after "GitHub refresh/sync".

- [ ] **Step 2: AGENTS.md**

Add under "Important code":

```markdown
- `server/burst-scan.mjs`: read-only per-repository goal proposals; `server/burst-candidate-store.mjs` holds them.
```

- [ ] **Step 3: Spec**

Add a dated section at the top of the spec, "Revision 2026-09-08 (reduced scope)", with the table from "Scope reduction, decided here" in this plan, and mark the "Burst flag on a goal" section as deferred.

- [ ] **Step 4: Full verification and commit**

Run: `npm run verify`
Expected: PASS

```bash
git add README.md AGENTS.md docs/superpowers/specs/2026-09-08-burst-mode-design.md
git commit -m "Document Burst scan and reduce the burst spec scope"
```

---

## Self-review

**Spec coverage (reduced scope).**
- Create with empty starred set → stated reason: Task 2 `scan()`, Task 5 notice.
- One candidate per repository, failure isolation, invalid output → failed: Tasks 1, 2.
- Concurrency cap 3, provider from `assignAgents`: Task 2.
- Review with goal, rationale, evidence, size, scan state; edit goal; start; dismiss; rescan: Tasks 4, 5.
- Idempotent start: Task 2 `startGoal`.
- Capacity link: the **Burst scan** button in `WeeklyOpportunities`, Task 5. Quota at the floor is enforced by `GoalSessionService.start()` on start, not by a wait state.
- Read-only phone protection: not added. The board's existing controls (GitHub issue **Start a goal**) are not gated by `readOnly` either, and `WorktreeDashboardView` has no `readOnly` prop. Adding it is a separate, board-wide change. State this in the PR.
- Board tools entry: Task 5.
- Burst flag, extra reviewers, badge, toggle, banner, sheet, SQLite tables, burst history: dropped, see the scope table.

**Placeholder scan.** Task 3 relies on Cypress and typecheck instead of a route unit test; stated in the task. Task 5 tells the implementer to copy required props from an existing render; the props used match `app/worktree-dashboard.tsx:268`.

**Type consistency.** `BurstCandidate` fields are identical in `normalize()` (Task 1), the scan service (Task 2), `app/burst-column.tsx` (Task 4) and the Cypress fixture (Task 6): `repositoryId, repositoryName, status, goal, rationale, evidence, sizeEstimate, reason, planId, scannedAt`. `BurstPayload.status` is `idle | scanning | no_starred_repositories` in `read()`, `scan()` and the UI. Route paths `/api/burst`, `/api/burst/scan`, `/api/burst/:repositoryId/{start,dismiss,rescan}` match between Task 3, Task 5 and Task 6. `startGoal` returns `{ candidate, plan, created }` in Task 2, Task 3 and Task 5.
