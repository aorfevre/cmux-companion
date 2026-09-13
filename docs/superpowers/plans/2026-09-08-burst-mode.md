# Burst Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a detected quota window into launched work: a cross-repository burst plan that proposes one goal per starred repository, plus a per-goal burst flag that adds review agents and permits subagents.

**Architecture:** A new `BurstStore` (own SQLite file) holds bursts and candidates. `BurstScanner` runs one headless read-only `ccs` agent per starred repository through `streamExecFile`. `BurstService` owns create, scan, approve, decline and rescan; approve calls the existing `GoalSessionService.start()`. The burst flag is a `plans.burst` column read by `taskPrompt()` and by a new `BurstReview` module that launches one reviewer session per finished task and per opened goal pull request.

**Tech Stack:** Node 22 (`node:sqlite`, `node:test`), Fastify, React 19, Vitest, Cypress. Spec: `docs/superpowers/specs/2026-09-08-burst-mode-design.md`.

**One deviation from the spec, decided here:** the spec places the burst flag in `specOptions`. That is not possible without a false warning. `specOptionCoverage()` in `server/delivery-contract.mjs:338` marks every requested `SPEC_OPTIONS` entry "missing" when no task and no criterion evidence it, and `tests/spec-options.test.mjs` asserts exactly six options. `server/review-options.mjs` documents the same trap for `codeReview`. So the flag is a separate boolean: request body `burst`, column `plans.burst`, module `server/burst-options.mjs`. Every user-visible behaviour in the spec is unchanged. **A second, smaller one:** the spec has burst-created goals set the flag by default and lets the user clear it before starting. Here a goal approved from a burst candidate always carries the flag, and the approval sheet has no per-candidate opt-out: an approved candidate is by definition burst work, and the extra review is the point of approving it there. The flag can still be set, or left off, on a hand-typed goal.

---

## File map

| File | Responsibility |
| --- | --- |
| `server/burst-options.mjs` (create) | Data-only: `normalizeBurst()`, `burstBriefLines()`, the toggle hint. Browser-safe. |
| `server/worktree-plan-schema.mjs` (modify) | `plans.burst` column and `plan_tasks.burst_review_*` columns. |
| `server/worktree-plan-store.mjs` (modify) | Persist and read `burst`; record burst review state on a task. |
| `server/worktree-planner.mjs` (modify) | `taskPrompt()` appends the burst block. |
| `server/goal-session-service.mjs` (modify) | Accept `burst`, pass it to `createPlan`, include in idempotency compare. |
| `server/request-schemas.mjs` (modify) | `burst` boolean on `createGoal`; new `burstApprove` schema. |
| `server/burst-store.mjs` (create) | `burst_plans` and `burst_candidates` tables. |
| `server/burst-scanner.mjs` (create) | One read-only headless scan per repository; schema-validated result. |
| `server/burst-service.mjs` (create) | Create, background scan, approve, decline, rescan. |
| `server/burst-routes.mjs` (create) | `/api/bursts` route group. |
| `server/burst-review.mjs` (create) | Reviewer session launch and verdict handling for burst goals. |
| `server/goal-integrator.mjs` (modify) | Gate ready tasks on burst review; trigger reviews. |
| `server/goal-merge-watch.mjs` (modify) | Trigger the goal-level review when a burst plan's PR opens. |
| `server/app.mjs` (modify) | Wire the burst store, service, routes and review. |
| `app/burst-plan.tsx` (create) | `BurstBanner` and `BurstPlanSheet`. |
| `app/worktree-planner.tsx` (modify) | Burst toggle on the goal form; `burst` in `PlanDraft`. |
| `app/worktree-dashboard.tsx` (modify) | Board tools entry, banner, badge, `readOnly` prop. |
| `app/page.tsx` (modify) | Pass `readOnly` to the dashboard. |
| `app/features.css` (modify) | Styles for the sheet, banner and badge. |
| `tests/burst-options.test.mjs`, `tests/burst-store.test.mjs`, `tests/burst-scanner.test.mjs`, `tests/burst-service.test.mjs`, `tests/burst-review.test.mjs`, `tests/burst-routes.test.mjs` (create) | Backend tests. |
| `tests/ui-burst-plan.test.tsx` (create) | Vitest for the sheet and banner. |
| `cypress/e2e/burst-plan.cy.ts` (create) | Stubbed end-to-end flow. |

Conventions every task follows:

- Backend tests: `node --test tests/<name>.test.mjs`. Full: `npm test`.
- UI tests: `npx vitest run --config vitest.config.ts tests/<name>.test.tsx`.
- Before every commit in a phase: `npm run typecheck` and `npm run lint`.
- Commit messages: imperative, one line, no prefix, as in `git log`.
- Never commit `.claude/` or the pre-existing modified files (`app/features.css` hunks you did not write, `app/page.tsx`, `app/worktree-planner.tsx`, `cypress/e2e/goal-sessions.cy.ts`, `app/proposal-review.tsx`). Stage by path. If a task modifies one of those files, stage with `git add -p` and pick only your hunks.

---

## Phase 1 — The burst flag on a goal

### Task 1: `burst-options.mjs` and its test

**Files:**
- Create: `server/burst-options.mjs`
- Test: `tests/burst-options.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/burst-options.test.mjs`
Expected: FAIL with `Cannot find module '../server/burst-options.mjs'`

- [ ] **Step 3: Write the module**

```js
// The per-goal execution intensity. Like review-options.mjs, this is
// deliberately NOT a SPEC_OPTIONS entry: specOptionCoverage marks a requested
// spec option "missing" when no task evidences it, and no task can evidence
// "use more quota". The module is data-only so the browser sheet imports it.

export const BURST_OPTION = Object.freeze({
  id: "burst",
  label: "Burst",
  hint: "Uses more quota: extra reviewers and subagents.",
});

export function normalizeBurst(value) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new TypeError("Burst must be true or false");
  return value;
}

// Appended to every task brief of a burst goal. The last sentence matters:
// a subagent result the owner never read is the one way parallel work hides a
// regression.
export function burstBriefLines(burst) {
  if (burst !== true) return [];
  return [
    "Burst mode is on for this goal:",
    "- You may launch subagents for independent slices, for exploration and for review. Prefer parallel work where it is safe.",
    "- Quota is not a constraint for this task.",
    "- Every subagent result is your responsibility: verify it before you report it.",
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/burst-options.test.mjs`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add server/burst-options.mjs tests/burst-options.test.mjs
git commit -m "Add the burst option catalog"
```

### Task 2: Persist `burst` on a plan

**Files:**
- Modify: `server/worktree-plan-schema.mjs` (the `ensure(...)` block ending near line 223)
- Modify: `server/worktree-plan-store.mjs:67-90` (`createPlan`), `:1224` (list mapper), `:1358` (`readPlan`)
- Test: `tests/worktree-plan-store.test.mjs`

- [ ] **Step 1: Write the failing test** (append to `tests/worktree-plan-store.test.mjs`)

```js
test("burst is stored, read back and listed; it defaults to off", (t) => {
  const store = memoryStore(t);
  const plain = seed(store, "plan-plain");
  assert.equal(plain.burst, false);
  const burst = store.createPlan({ planId: "plan-burst", repositoryId: "repository12345678", goal: "Burst goal", burst: true });
  assert.equal(burst.burst, true);
  assert.equal(store.get("plan-burst").burst, true);
  const listed = store.list({}).plans.find((plan) => plan.planId === "plan-burst");
  assert.equal(listed.burst, true);
  assert.throws(() => store.createPlan({ planId: "plan-bad", repositoryId: "repository12345678", goal: "x", burst: "yes" }), /Burst must be true or false/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/worktree-plan-store.test.mjs`
Expected: FAIL on `assert.equal(plain.burst, false)` with `undefined !== false`

- [ ] **Step 3: Add the column**

In `server/worktree-plan-schema.mjs`, add after the line `ensure("plan_tasks", "session_closed_at", "TEXT");`:

```js
    ensure("plans", "burst", "INTEGER NOT NULL DEFAULT 0");
```

- [ ] **Step 4: Write and read the column**

In `server/worktree-plan-store.mjs`:

1. Add the import at the top, next to the `safeSpecOptions` import:

```js
import { normalizeBurst } from "./burst-options.mjs";
```

2. Change the `createPlan` signature to accept `burst = false`, and inside, before the transaction:

```js
    const burstOn = normalizeBurst(burst);
```

3. Change the INSERT to include the column. The statement becomes:

```js
      this.db.prepare(`
        INSERT INTO plans (plan_id, repository_id, repository_name, cwd, goal, images, source_type, issue_numbers, issue_urls, delivery_policy, engine_provider, engine_model, engine_effort, engine_reviewer, spec_options, review_options, burst, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(planId, repositoryId, repositoryName, cwd, goal, json(images), text(sourceType), json(issueNumbers), json(issueUrls), policy(deliveryPolicy), engine.provider || "claude", engine.model || "default", engine.effort || "default", engine.reviewer === true ? 1 : 0, json(options), json(review), burstOn ? 1 : 0, at, at);
```

4. Add `burst: burstOn` to the `goal` event payload object on the `#insertEvent` line.

5. In the `list()` mapper (the object starting `planId: row.plan_id,` near line 1206) add, after `reviewOptions:`:

```js
      burst: row.burst === 1,
```

6. In `readPlan(row)` add, after `reviewOptions:`:

```js
    burst: row.burst === 1,
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test tests/worktree-plan-store.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/worktree-plan-schema.mjs server/worktree-plan-store.mjs tests/worktree-plan-store.test.mjs
git commit -m "Persist the burst flag on goal plans"
```

### Task 3: Brief block, request schema and goal-session intake

**Files:**
- Modify: `server/worktree-planner.mjs:1108-1132` (`taskPrompt`)
- Modify: `server/request-schemas.mjs` (`createGoal`)
- Modify: `server/goal-session-service.mjs:15-35` (`start`)
- Test: `tests/worktree-planner.test.mjs`, `tests/goal-session-service.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/worktree-planner.test.mjs`:

```js
test("taskPrompt appends the burst block only when burst is on", () => {
  const task = { id: "T1", title: "Do it", type: "feature", prompt: "Build it.", ownedAreas: ["src/"], verification: ["npm test"], criterionIds: [] };
  const spec = { outcome: "Done", acceptanceCriteria: [] };
  const plain = taskPrompt(task, spec, [], "origin/main", "single", "", [], undefined, false);
  const burst = taskPrompt(task, spec, [], "origin/main", "single", "", [], undefined, true);
  assert.ok(!plain.includes("Burst mode is on"));
  assert.ok(burst.includes("Burst mode is on for this goal:"));
  assert.ok(burst.indexOf("Burst mode is on") < burst.indexOf("Completion report"), "the burst block sits before the completion instruction");
});
```

Check the import line of that test file includes `taskPrompt`; add it if missing.

Append to `tests/goal-session-service.test.mjs`:

```js
test("start persists burst and includes it in the idempotency identity", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const service = new GoalSessionService({
    store, modelSettings: { roles: undefined },
    worktrees: { resolveRepository: async (id) => ({ id, name: "sample", primaryPath: "/repo/sample" }), create: async () => ({ worktree: { path: "/repo/sample-goal" } }) },
    cmux: { workspaceListDetailed: async () => ({ workspaces: [] }), workspaceCreate: async () => ({ workspace_id: "ws" }), workspaceStartGoalSessionRunner: async () => {} },
  });
  const key = "11111111-1111-4111-8111-111111111111";
  const plan = await service.start({ repositoryId: "repo-1", goal: "Burst it", burst: true, idempotencyKey: key });
  assert.equal(plan.burst, true);
  await assert.rejects(() => service.start({ repositoryId: "repo-1", goal: "Burst it", burst: false, idempotencyKey: key }), /belongs to a different goal/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/worktree-planner.test.mjs tests/goal-session-service.test.mjs`
Expected: FAIL. The planner test fails on `burst.includes("Burst mode is on for this goal:")`. The service test fails on `plan.burst === true` or does not reject.

- [ ] **Step 3: Append the block in `taskPrompt`**

In `server/worktree-planner.mjs`, add the import next to the `spec-options` import:

```js
import { burstBriefLines, normalizeBurst } from "./burst-options.mjs";
```

Change the signature and the `rigor` list:

```js
export function taskPrompt(task, spec, images, base, deliveryMode = "single", readyToken = "", issueNumbers = [], specOptions = undefined, burst = false) {
```

```js
  const rigor = [
    specOptionsBriefLines(safeSpecOptions(specOptions)).join("\n"),
    burstBriefLines(normalizeBurst(burst === true)).join("\n"),
    formatOptionEvidence(spec?.optionEvidence),
    formatDesignArtifacts(spec?.designArtifacts),
  ].filter(Boolean);
```

Then update every `taskPrompt(` call site to pass the plan's flag as the ninth argument. There are four in `server/worktree-planner.mjs` (lines ~419, ~472, ~518, ~730) and one in `server/goal-integrator.mjs:593`. Each becomes `..., plan.specOptions, plan.burst)` (or `draft.specOptions, draft.burst` on line ~730). Run `grep -n "taskPrompt(" server/*.mjs` and confirm five call sites carry the new argument.

- [ ] **Step 4: Schema and service**

In `server/request-schemas.mjs`, inside `createGoal`'s properties, add after `specOptions: { type: "object" }, reviewOptions: { type: "object" },`:

```js
    burst: { type: "boolean" },
```

In `server/goal-session-service.mjs`:

1. Import: `import { normalizeBurst } from "./burst-options.mjs";`
2. `start` signature: add `burst = false` after `discoveryContext = null`.
3. After `const selectedEngine = ...` add `const burstOn = normalizeBurst(burst);`
4. In the idempotency comparison (line ~29) add `|| existing.burst !== burstOn` before the closing `)`.
5. In `this.store.createPlan({ ... })` add `burst: burstOn,`.
6. In the `restart`/continue paths that call `this.start({ ... })` (line ~97) add `burst: source.burst,`.

- [ ] **Step 5: Run to verify they pass**

Run: `node --test tests/worktree-planner.test.mjs tests/goal-session-service.test.mjs`
Expected: PASS

- [ ] **Step 6: Phase verification and commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

```bash
git add server/worktree-planner.mjs server/goal-integrator.mjs server/request-schemas.mjs server/goal-session-service.mjs tests/worktree-planner.test.mjs tests/goal-session-service.test.mjs
git commit -m "Carry the burst flag into task briefs and goal sessions"
```

### Task 4: The Burst toggle on the goal form and the board badge

**Files:**
- Modify: `app/worktree-planner.tsx` (types near line 56; form state near line 344; POST near line 403; Spec depth section near line 578)
- Modify: `app/worktree-dashboard.tsx:962-965` (`GoalBoardCard`)
- Modify: `app/features.css` (append)
- Test: `tests/ui-features.test.tsx`

This file has pre-existing uncommitted hunks. Read it first, edit, then stage only your hunks with `git add -p`.

- [ ] **Step 1: Write the failing test** (append inside the `describe("contextual mobile features")` block, or as a new `describe("burst")` at the end of `tests/ui-features.test.tsx`)

```js
describe("burst", () => {
  test("the goal form sends burst when the toggle is on", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/settings/models")) return new Response(JSON.stringify({ roles: DEFAULT_MODEL_ROLES, defaults: DEFAULT_MODEL_ROLES, warning: null }), { status: 200 });
      if (url.endsWith("/api/goal-sessions") && init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ planId: "p1", repositoryId: "r1", goal: "x", round: 0, status: "questions", questions: [], tasks: [], workflow: "goal_session" }), { status: 201 }); }
      return new Response("{}", { status: 200 });
    }));
    render(<WorktreePlannerSheet repository={{ id: "r1", name: "Repo" }} onClose={() => {}} onLaunched={async () => {}} />);
    await userEvent.type(await screen.findByLabelText("Goal"), "Ship burst");
    await userEvent.click(screen.getByLabelText("Burst"));
    await userEvent.click(screen.getByRole("button", { name: "Start goal session" }));
    await waitFor(() => assert.equal(posts.length, 1));
    assert.equal((posts[0] as { burst: boolean }).burst, true);
  });
});
```

Add `import { DEFAULT_MODEL_ROLES } from "../server/model-options.mjs";` at the top of the test file if it is not already imported. Check `WorktreePlannerSheet`'s required props with `grep -n "export function WorktreePlannerSheet" app/worktree-planner.tsx` and pass exactly those; the three above are the minimum in the current signature and any extra required prop must be added with a `vi.fn()`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --config vitest.config.ts tests/ui-features.test.tsx -t burst`
Expected: FAIL with `Unable to find a label with the text of: Burst`

- [ ] **Step 3: Add the toggle and the request field**

In `app/worktree-planner.tsx`:

1. Import: `import { BURST_OPTION } from "../server/burst-options.mjs";`
2. In the `PlanDraft` type (line ~56) add `burst?: boolean;` after `specOptions?: SpecOptions;`.
3. Next to `const [specOptions, setSpecOptions] = useState...` add:

```tsx
  const [burst, setBurst] = useState(false);
```

4. In the POST body on line ~403 add `burst,` after `reviewOptions,`.
5. After the `<section className="planner-spec-options" aria-label="Spec depth">...</section>` block add:

```tsx
      <section className="planner-spec-options planner-burst" aria-label="Execution intensity">
        <header><strong>{BURST_OPTION.label}</strong><span>{BURST_OPTION.hint}</span></header>
        <label><input type="checkbox" aria-label={BURST_OPTION.label} checked={burst} onChange={(event) => setBurst(event.target.checked)} /><span><b>{BURST_OPTION.label}</b><small>Extra independent reviewers on every finished task and on the goal pull request. Every task agent may run subagents.</small></span></label>
      </section>
```

- [ ] **Step 4: Add the badge**

In `app/worktree-dashboard.tsx`, inside `GoalBoardCard`, change the line

```tsx
    <strong>{plan.goal}</strong>
```

to

```tsx
    <strong>{plan.goal}{plan.burst && <em className="goal-burst-badge" aria-label="Burst goal">Burst</em>}</strong>
```

Check the type of the `plan` prop in `GoalBoardCard`: it must be `PlanDraft` or a type that extends it. If it is a narrower type, add `burst?: boolean` to that type.

Append to `app/features.css`:

```css
.planner-burst label{display:flex;gap:10px;align-items:flex-start}
.goal-burst-badge{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:8px;background:#5a3c12;color:#ffd58a;font-size:10px;font-style:normal;vertical-align:middle}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run --config vitest.config.ts tests/ui-features.test.tsx -t burst`
Expected: PASS

- [ ] **Step 6: Phase verification and commit**

Run: `npm run test:ui && npm run typecheck && npm run lint`
Expected: pass.

```bash
git add -p app/worktree-planner.tsx app/worktree-dashboard.tsx app/features.css
git add tests/ui-features.test.tsx
git commit -m "Add the Burst toggle to the goal form and a board badge"
```

When `git add -p` asks about pre-existing hunks you did not write, answer `n`.

---

## Phase 2 — Burst store and service

### Task 5: `BurstStore`

**Files:**
- Create: `server/burst-store.mjs`
- Test: `tests/burst-store.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { BurstStore } from "../server/burst-store.mjs";

const REPO_A = "repoAAAAAAAAAAAAAA";
const REPO_B = "repoBBBBBBBBBBBBBB";

function memoryStore(t) {
  const store = new BurstStore({ path: ":memory:" });
  t.after(() => store.close());
  return store;
}

test("creates a burst with one scanning candidate per repository", (t) => {
  const store = memoryStore(t);
  const burst = store.create({ burstId: "burst-1", capacitySnapshot: { next: "claude" }, repositories: [{ id: REPO_A, name: "a" }, { id: REPO_B, name: "b" }] });
  assert.equal(burst.status, "scanning");
  assert.deepEqual(burst.candidates.map((c) => [c.repositoryId, c.status]), [[REPO_A, "scanning"], [REPO_B, "scanning"]]);
  assert.deepEqual(burst.capacitySnapshot, { next: "claude" });
});

test("a proposal moves a candidate to proposed; a failure records its reason", (t) => {
  const store = memoryStore(t);
  store.create({ burstId: "burst-1", repositories: [{ id: REPO_A, name: "a" }, { id: REPO_B, name: "b" }] });
  store.recordProposal("burst-1", REPO_A, { goal: "Cover the store", rationale: "No tests", evidence: ["server/x.mjs"], sizeEstimate: "medium" });
  store.recordFailure("burst-1", REPO_B, "Invalid JSON");
  const burst = store.get("burst-1");
  assert.equal(burst.status, "ready");
  const a = burst.candidates.find((c) => c.repositoryId === REPO_A);
  assert.equal(a.status, "proposed");
  assert.equal(a.goal, "Cover the store");
  assert.deepEqual(a.evidence, ["server/x.mjs"]);
  const b = burst.candidates.find((c) => c.repositoryId === REPO_B);
  assert.equal(b.status, "failed");
  assert.equal(b.reason, "Invalid JSON");
});

test("approve stores the plan id once; a second approve keeps the first", (t) => {
  const store = memoryStore(t);
  store.create({ burstId: "burst-1", repositories: [{ id: REPO_A, name: "a" }] });
  store.recordProposal("burst-1", REPO_A, { goal: "g", rationale: "r", evidence: [], sizeEstimate: "small" });
  const first = store.recordApproval("burst-1", REPO_A, { planId: "plan-1", goal: "g edited" });
  assert.equal(first.status, "approved");
  assert.equal(first.planId, "plan-1");
  assert.equal(first.goal, "g edited");
  assert.throws(() => store.recordApproval("burst-1", REPO_A, { planId: "plan-2", goal: "g" }), /already approved/);
  assert.equal(store.get("burst-1").status, "closed");
});

test("decline and rescan change one candidate only", (t) => {
  const store = memoryStore(t);
  store.create({ burstId: "burst-1", repositories: [{ id: REPO_A, name: "a" }, { id: REPO_B, name: "b" }] });
  store.recordProposal("burst-1", REPO_A, { goal: "g", rationale: "r", evidence: [], sizeEstimate: "small" });
  store.recordFailure("burst-1", REPO_B, "boom");
  assert.equal(store.recordDecline("burst-1", REPO_A).status, "declined");
  assert.equal(store.resetForScan("burst-1", REPO_B).status, "scanning");
  const burst = store.get("burst-1");
  assert.equal(burst.status, "scanning");
  assert.equal(burst.candidates.find((c) => c.repositoryId === REPO_A).status, "declined");
});

test("list is newest first and unknown ids return null", (t) => {
  const store = memoryStore(t);
  store.create({ burstId: "burst-1", repositories: [{ id: REPO_A, name: "a" }] });
  store.create({ burstId: "burst-2", repositories: [{ id: REPO_A, name: "a" }] });
  assert.deepEqual(store.list().map((b) => b.burstId), ["burst-2", "burst-1"]);
  assert.equal(store.get("nope"), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/burst-store.test.mjs`
Expected: FAIL with `Cannot find module '../server/burst-store.mjs'`

- [ ] **Step 3: Write the store**

```js
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// One burst is one scan of the starred repositories. Its candidates live in
// their own file, separate from goal-plans.db: a burst is a proposal set, and
// a goal it approves is an ordinary plan row over there.
const DEFAULT_PATH = join(homedir(), ".config", "cmux-companion", "bursts.db");
const CANDIDATE_STATUSES = new Set(["scanning", "proposed", "failed", "approved", "declined"]);
const SIZE_ESTIMATES = new Set(["small", "medium", "large"]);
const REPOSITORY_ID = /^[A-Za-z0-9_-]{18}$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS burst_plans (
  burst_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  capacity_snapshot TEXT
);
CREATE TABLE IF NOT EXISTS burst_candidates (
  burst_id TEXT NOT NULL REFERENCES burst_plans(burst_id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  goal TEXT,
  rationale TEXT,
  evidence TEXT NOT NULL DEFAULT '[]',
  size_estimate TEXT,
  status TEXT NOT NULL DEFAULT 'scanning',
  reason TEXT,
  plan_id TEXT,
  position INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (burst_id, repository_id)
);
`;

export class BurstStore {
  constructor({ path = process.env.CMUX_COMPANION_BURSTS_DB || DEFAULT_PATH, now = () => new Date() } = {}) {
    this.now = now;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    if (path !== ":memory:") { try { chmodSync(path, 0o600); } catch { /* filesystem without modes */ } }
  }

  create({ burstId, capacitySnapshot = null, repositories = [] }) {
    const id = identifier(burstId);
    const list = repositories.map((repository) => {
      if (!REPOSITORY_ID.test(String(repository?.id || ""))) throw new TypeError("Invalid repository");
      return { id: repository.id, name: String(repository.name || repository.id).slice(0, 200) };
    });
    if (!list.length) throw new TypeError("A burst needs at least one starred repository");
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare("INSERT INTO burst_plans (burst_id, created_at, updated_at, capacity_snapshot) VALUES (?, ?, ?, ?)").run(id, at, at, capacitySnapshot ? JSON.stringify(capacitySnapshot) : null);
      const insert = this.db.prepare("INSERT INTO burst_candidates (burst_id, repository_id, repository_name, position, updated_at) VALUES (?, ?, ?, ?, ?)");
      list.forEach((repository, index) => insert.run(id, repository.id, repository.name, index, at));
    });
    return this.get(id);
  }

  recordProposal(burstId, repositoryId, proposal) {
    const clean = normalizeProposal(proposal);
    return this.#updateCandidate(burstId, repositoryId, ["scanning"], "proposed", {
      goal: clean.goal, rationale: clean.rationale, evidence: JSON.stringify(clean.evidence), size_estimate: clean.sizeEstimate, reason: null,
    });
  }

  recordFailure(burstId, repositoryId, reason) {
    return this.#updateCandidate(burstId, repositoryId, ["scanning"], "failed", { reason: String(reason || "The scan failed").slice(0, 2_000) });
  }

  recordApproval(burstId, repositoryId, { planId, goal }) {
    const current = this.#candidate(burstId, repositoryId);
    if (!current) throw new TypeError("Unknown burst candidate");
    if (current.status === "approved") throw new TypeError("This candidate is already approved");
    if (current.status !== "proposed") throw new TypeError("Only a proposed candidate can be approved");
    const text = String(goal ?? current.goal ?? "").trim();
    if (!text) throw new TypeError("An approved candidate needs a goal");
    return this.#updateCandidate(burstId, repositoryId, ["proposed"], "approved", { plan_id: String(planId), goal: text.slice(0, 8_000) });
  }

  recordDecline(burstId, repositoryId) {
    return this.#updateCandidate(burstId, repositoryId, ["proposed", "failed"], "declined", {});
  }

  resetForScan(burstId, repositoryId) {
    return this.#updateCandidate(burstId, repositoryId, ["proposed", "failed", "declined"], "scanning", { reason: null, plan_id: null });
  }

  get(burstId) {
    const row = this.db.prepare("SELECT * FROM burst_plans WHERE burst_id = ?").get(String(burstId || ""));
    if (!row) return null;
    const candidates = this.db.prepare("SELECT * FROM burst_candidates WHERE burst_id = ? ORDER BY position").all(row.burst_id).map(readCandidate);
    return readBurst(row, candidates);
  }

  list({ limit = 20 } = {}) {
    const rows = this.db.prepare("SELECT burst_id FROM burst_plans ORDER BY created_at DESC, burst_id DESC LIMIT ?").all(Math.max(1, Math.min(100, Number(limit) || 20)));
    return rows.map((row) => this.get(row.burst_id));
  }

  close() { this.db.close(); }

  #candidate(burstId, repositoryId) {
    const row = this.db.prepare("SELECT * FROM burst_candidates WHERE burst_id = ? AND repository_id = ?").get(String(burstId || ""), String(repositoryId || ""));
    return row ? readCandidate(row) : null;
  }

  #updateCandidate(burstId, repositoryId, fromStatuses, toStatus, fields) {
    if (!CANDIDATE_STATUSES.has(toStatus)) throw new TypeError(`Unknown candidate status ${toStatus}`);
    const at = this.#stamp();
    const keys = Object.keys(fields);
    const assignments = ["status = ?", "updated_at = ?", ...keys.map((key) => `${key} = ?`)].join(", ");
    const placeholders = fromStatuses.map(() => "?").join(", ");
    let changed = 0;
    this.#transaction(() => {
      changed = this.db.prepare(`UPDATE burst_candidates SET ${assignments} WHERE burst_id = ? AND repository_id = ? AND status IN (${placeholders})`)
        .run(toStatus, at, ...keys.map((key) => fields[key]), String(burstId || ""), String(repositoryId || ""), ...fromStatuses).changes;
      if (changed) this.db.prepare("UPDATE burst_plans SET updated_at = ? WHERE burst_id = ?").run(at, String(burstId || ""));
    });
    if (changed !== 1) throw new TypeError(`This candidate cannot move to ${toStatus} from its current state`);
    return this.#candidate(burstId, repositoryId);
  }

  #transaction(run) {
    this.db.exec("BEGIN IMMEDIATE");
    try { run(); this.db.exec("COMMIT"); }
    catch (cause) { this.db.exec("ROLLBACK"); throw cause; }
  }

  #stamp() { return this.now().toISOString(); }
}

export function normalizeProposal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("The scan returned no proposal object");
  const goal = String(value.goal || "").trim();
  if (!goal || goal.length > 8_000) throw new TypeError("The scan returned no usable goal");
  const rationale = String(value.rationale || "").trim().slice(0, 4_000);
  if (!rationale) throw new TypeError("The scan returned no rationale");
  const evidence = Array.isArray(value.evidence) ? value.evidence.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20) : [];
  const sizeEstimate = SIZE_ESTIMATES.has(value.sizeEstimate) ? value.sizeEstimate : "medium";
  return { goal, rationale, evidence, sizeEstimate };
}

function identifier(value) {
  const id = String(value || "");
  if (!/^burst-[A-Za-z0-9-]{4,64}$/.test(id)) throw new TypeError("Invalid burst id");
  return id;
}

// Burst status is derived, never stored: the candidates are the truth.
function readBurst(row, candidates) {
  const status = candidates.some((c) => c.status === "scanning") ? "scanning"
    : candidates.every((c) => ["approved", "declined", "failed"].includes(c.status)) ? "closed" : "ready";
  let capacitySnapshot = null;
  try { capacitySnapshot = row.capacity_snapshot ? JSON.parse(row.capacity_snapshot) : null; } catch { capacitySnapshot = null; }
  return { burstId: row.burst_id, createdAt: row.created_at, updatedAt: row.updated_at, status, capacitySnapshot, candidates };
}

function readCandidate(row) {
  let evidence = [];
  try { evidence = JSON.parse(row.evidence || "[]"); } catch { evidence = []; }
  return {
    repositoryId: row.repository_id, repositoryName: row.repository_name, goal: row.goal ?? null, rationale: row.rationale ?? null,
    evidence: Array.isArray(evidence) ? evidence : [], sizeEstimate: row.size_estimate ?? null, status: row.status,
    reason: row.reason ?? null, planId: row.plan_id ?? null, updatedAt: row.updated_at,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/burst-store.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add server/burst-store.mjs tests/burst-store.test.mjs
git commit -m "Add the burst store"
```

### Task 6: `BurstService` with a fake scanner

**Files:**
- Create: `server/burst-service.mjs`
- Test: `tests/burst-service.test.mjs`

The scanner contract this task depends on, implemented in Task 7: `scanner.scan({ repository, provider }) → Promise<{ goal, rationale, evidence, sizeEstimate }>`. It throws on failure.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { BurstStore } from "../server/burst-store.mjs";
import { BurstService } from "../server/burst-service.mjs";

const REPO_A = "repoAAAAAAAAAAAAAA";
const REPO_B = "repoBBBBBBBBBBBBBB";
const PLAIN = "repoPPPPPPPPPPPPPP";

function harness(t, { proposals = {}, failures = {}, repositories = null, usage = null } = {}) {
  const store = new BurstStore({ path: ":memory:" });
  t.after(() => store.close());
  const scans = [];
  const starts = [];
  const service = new BurstService({
    store,
    worktrees: { snapshot: async () => ({ repositories: repositories || [
      { id: REPO_A, name: "a", path: "/r/a", favorite: true, archived: false },
      { id: REPO_B, name: "b", path: "/r/b", favorite: true, archived: false },
      { id: PLAIN, name: "p", path: "/r/p", favorite: false, archived: false },
    ] }) },
    scanner: { scan: async ({ repository, provider }) => {
      scans.push({ id: repository.id, provider });
      if (failures[repository.id]) throw new Error(failures[repository.id]);
      return proposals[repository.id] || { goal: `Goal for ${repository.name}`, rationale: "because", evidence: ["README.md"], sizeEstimate: "small" };
    } },
    goalSessions: { start: async (input) => { starts.push(input); return { planId: `plan-${starts.length}` }; } },
    accountUsage: { snapshot: async () => usage || { providers: [{ id: "claude", available: true, accounts: [{ status: "ready", windows: [{ category: "usage", remainingPercent: 60 }] }] }] } },
    concurrency: 1,
  });
  return { store, service, scans, starts };
}

test("create writes one scanning candidate per starred repository and scans in the background", async (t) => {
  const { service, scans } = harness(t);
  const created = await service.create();
  assert.equal(created.status, "scanning");
  assert.deepEqual(created.candidates.map((c) => c.repositoryId), [REPO_A, REPO_B]);
  await service.settled(created.burstId);
  const burst = service.get(created.burstId);
  assert.equal(burst.status, "ready");
  assert.deepEqual(burst.candidates.map((c) => c.status), ["proposed", "proposed"]);
  assert.deepEqual(scans.map((s) => s.provider), ["claude", "claude"]);
});

test("an empty starred set is a stated reason, not a burst", async (t) => {
  const { service } = harness(t, { repositories: [] });
  const result = await service.create();
  assert.equal(result.status, "no_starred_repositories");
  assert.match(result.message, /Star a repository/);
  assert.equal(service.list().length, 0);
});

test("one failed scan never aborts the others", async (t) => {
  const { service } = harness(t, { failures: { [REPO_A]: "boom" } });
  const created = await service.create();
  await service.settled(created.burstId);
  const burst = service.get(created.burstId);
  assert.equal(burst.candidates.find((c) => c.repositoryId === REPO_A).status, "failed");
  assert.equal(burst.candidates.find((c) => c.repositoryId === REPO_A).reason, "boom");
  assert.equal(burst.candidates.find((c) => c.repositoryId === REPO_B).status, "proposed");
});

test("approve starts a burst goal session once and returns the same plan on a repeat", async (t) => {
  const { service, starts } = harness(t);
  const created = await service.create();
  await service.settled(created.burstId);
  const first = await service.approve(created.burstId, REPO_A, { goal: "Edited goal" });
  assert.equal(first.status, "approved");
  assert.equal(first.planId, "plan-1");
  assert.deepEqual(starts[0], { repositoryId: REPO_A, goal: "Edited goal", burst: true });
  const again = await service.approve(created.burstId, REPO_A, {});
  assert.equal(again.planId, "plan-1");
  assert.equal(starts.length, 1);
});

test("decline and rescan act on one candidate", async (t) => {
  const { service, scans } = harness(t);
  const created = await service.create();
  await service.settled(created.burstId);
  assert.equal(service.decline(created.burstId, REPO_A).status, "declined");
  const rescanned = await service.rescan(created.burstId, REPO_B);
  assert.equal(rescanned.status, "scanning");
  await service.settled(created.burstId);
  assert.equal(service.get(created.burstId).candidates.find((c) => c.repositoryId === REPO_B).status, "proposed");
  assert.equal(scans.length, 3);
});

test("a second create while one burst scans returns the running burst", async (t) => {
  const { service } = harness(t);
  const first = await service.create();
  const second = await service.create();
  assert.equal(second.burstId, first.burstId);
  await service.settled(first.burstId);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/burst-service.test.mjs`
Expected: FAIL with `Cannot find module '../server/burst-service.mjs'`

- [ ] **Step 3: Write the service**

```js
import { randomUUID } from "node:crypto";
import { agentCapacity } from "./agent-capacity.mjs";
import { assignAgents } from "./worktree-planner.mjs";

export const BURST_NO_FAVORITES = "No starred repositories. Star a repository first; Burst scans starred repositories only.";
const REPOSITORY_ID = /^[A-Za-z0-9_-]{18}$/;

// Owns one burst at a time. Scans run after the request returns; `settled`
// exists so a test, or a route that wants to wait, can join the running scan.
export class BurstService {
  constructor({ store, worktrees, scanner, goalSessions, accountUsage = null, concurrency = 3, log = null } = {}) {
    if (!store || !worktrees || !scanner || !goalSessions) throw new TypeError("Burst needs a store, worktrees, a scanner and goal sessions");
    this.store = store; this.worktrees = worktrees; this.scanner = scanner; this.goalSessions = goalSessions;
    this.accountUsage = accountUsage; this.concurrency = Math.max(1, Number(concurrency) || 3); this.log = log;
    // burstId -> Promise. One entry per burst whose scan is in flight.
    this.pending = new Map();
  }

  async create() {
    const running = this.list().find((burst) => burst.status === "scanning");
    if (running) return running;
    const repositories = await this.#favorites();
    if (!repositories.length) return { status: "no_starred_repositories", message: BURST_NO_FAVORITES, burstId: null };
    const usage = await this.#usage();
    const burst = this.store.create({ burstId: `burst-${randomUUID()}`, capacitySnapshot: usage ? agentCapacity(usage) : null, repositories });
    this.#scan(burst.burstId, burst.candidates.map((c) => c.repositoryId), usage);
    return burst;
  }

  get(burstId) { return this.store.get(burstId); }
  list() { return this.store.list(); }

  async approve(burstId, repositoryId, { goal = undefined } = {}) {
    const burst = this.#require(burstId);
    const candidate = burst.candidates.find((c) => c.repositoryId === repositoryId);
    if (!candidate) throw new TypeError("Unknown burst candidate");
    // Idempotent: the plan already exists, so hand it back rather than start a second session.
    if (candidate.status === "approved") return candidate;
    if (candidate.status !== "proposed") throw new TypeError("Only a proposed candidate can be approved");
    const text = String(goal ?? candidate.goal ?? "").trim();
    if (!text) throw new TypeError("An approved candidate needs a goal");
    const plan = await this.goalSessions.start({ repositoryId, goal: text, burst: true });
    return this.store.recordApproval(burstId, repositoryId, { planId: plan.planId, goal: text });
  }

  decline(burstId, repositoryId) {
    this.#require(burstId);
    return this.store.recordDecline(burstId, repositoryId);
  }

  async rescan(burstId, repositoryId) {
    this.#require(burstId);
    const candidate = this.store.resetForScan(burstId, repositoryId);
    this.#scan(burstId, [repositoryId], await this.#usage());
    return candidate;
  }

  settled(burstId) { return this.pending.get(String(burstId)) || Promise.resolve(); }

  #require(burstId) {
    const burst = this.store.get(burstId);
    if (!burst) throw new TypeError("Unknown burst");
    return burst;
  }

  // Bounded parallel scan. The chain joins any scan already in flight for this
  // burst so a rescan never runs beside the original scan of the same row.
  #scan(burstId, repositoryIds, usage) {
    const previous = this.pending.get(burstId) || Promise.resolve();
    const run = previous.then(async () => {
      const repositories = await this.#favorites();
      const targets = repositoryIds.map((id) => repositories.find((r) => r.id === id)).filter(Boolean);
      let next = 0;
      const worker = async () => {
        for (let index = next++; index < targets.length; index = next++) await this.#scanOne(burstId, targets[index], usage);
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, targets.length) }, worker));
      // A repository that left the starred set mid-scan still has a scanning row.
      for (const id of repositoryIds.filter((id) => !targets.some((t) => t.id === id))) {
        try { this.store.recordFailure(burstId, id, "This repository is no longer starred"); } catch { /* already settled */ }
      }
    }).catch((cause) => this.log?.warn?.({ err: cause, burstId }, "burst scan failed"));
    this.pending.set(burstId, run);
    run.finally(() => { if (this.pending.get(burstId) === run) this.pending.delete(burstId); });
  }

  async #scanOne(burstId, repository, usage) {
    let provider = "claude";
    try { provider = assignAgents([{ id: repository.id }], usage)[0].agent; }
    catch (cause) { this.store.recordFailure(burstId, repository.id, cause.message); return; }
    try {
      const proposal = await this.scanner.scan({ repository, provider });
      this.store.recordProposal(burstId, repository.id, proposal);
    } catch (cause) {
      try { this.store.recordFailure(burstId, repository.id, cause?.message || "The scan failed"); }
      catch (recordError) { this.log?.warn?.({ err: recordError, burstId, repositoryId: repository.id }, "burst failure could not be recorded"); }
    }
  }

  async #usage() {
    try { return await this.accountUsage?.snapshot?.({ refresh: true }) || null; }
    catch (cause) { this.log?.warn?.({ err: cause }, "burst usage snapshot failed"); return null; }
  }

  // The same starred set GitHubIssueSync reads.
  async #favorites() {
    const dashboard = await this.worktrees.snapshot({ refresh: true });
    return (Array.isArray(dashboard?.repositories) ? dashboard.repositories : [])
      .filter((r) => r?.favorite === true && r?.archived !== true && REPOSITORY_ID.test(String(r.id || "")) && typeof r.path === "string" && r.path)
      .map((r) => ({ id: r.id, name: String(r.name || r.id).slice(0, 200), path: r.path }));
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/burst-service.test.mjs`
Expected: PASS, 6 tests. If `assignAgents` returns `codex` for the fake usage, check the fake: only `claude` has an eligible account with headroom 60, so `claude` is expected.

- [ ] **Step 5: Phase verification and commit**

Run: `npm test && npm run typecheck && npm run lint`

```bash
git add server/burst-service.mjs tests/burst-service.test.mjs
git commit -m "Add the burst service with background scans"
```

---

## Phase 3 — The scanner

### Task 7: `BurstScanner` on the headless planner path

**Files:**
- Create: `server/burst-scanner.mjs`
- Test: `tests/burst-scanner.test.mjs`

The command shape is the one the retired headless planner used (commit `eaa9bcc^`, `#spawn`): `ccs <provider> --print --output-format stream-json --verbose --setting-sources "" --strict-mcp-config --disable-slash-commands --allowed-tools Read,Grep,Glob --disallowed-tools Bash,Write,Edit,MultiEdit,NotebookEdit,Task,WebFetch,WebSearch [--model X] [--effort Y] -- <prompt>`.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/burst-scanner.test.mjs`
Expected: FAIL with `Cannot find module '../server/burst-scanner.mjs'`

- [ ] **Step 3: Write the scanner**

```js
import { finalEnvelope, streamExecFile } from "./planner-process.mjs";
import { describeRunFailure, describeTimeout } from "./worktree-planner.mjs";
import { normalizeProposal } from "./burst-store.mjs";
import { PLANNER_ENGINES } from "./worktree-planner-options.mjs";
import { ModelSettings } from "./model-settings.mjs";

// Read-only by construction: the same tool lists the retired headless planner
// used, so the scan can read a repository and never touch it.
const ALLOWED_TOOLS = "Read,Grep,Glob";
const DENIED_TOOLS = "Bash,Write,Edit,MultiEdit,NotebookEdit,Task,WebFetch,WebSearch";
const ISOLATION = ["--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"];
const IDLE_TIMEOUT_MS = Number(process.env.CMUX_BURST_IDLE_TIMEOUT_MS) || 240_000;
const CEILING_MS = Number(process.env.CMUX_BURST_CEILING_MS) || 900_000;
const UNUSABLE = "The scan returned an unusable answer";

export class BurstScanner {
  constructor({ execute = streamExecFile, modelSettings = new ModelSettings(), idleTimeoutMs = IDLE_TIMEOUT_MS, ceilingMs = CEILING_MS } = {}) {
    this.execute = execute; this.modelSettings = modelSettings; this.idleTimeoutMs = idleTimeoutMs; this.ceilingMs = ceilingMs;
  }

  async scan({ repository, provider }) {
    if (provider !== "claude" && provider !== "codex") throw new TypeError("Unknown scan provider");
    const engine = this.modelSettings.engine("planner", provider);
    const args = [provider, "--print", "--output-format", "stream-json", "--verbose", ...ISOLATION, "--allowed-tools", ALLOWED_TOOLS, "--disallowed-tools", DENIED_TOOLS];
    if (engine.model && engine.model !== PLANNER_ENGINES.passthroughModel) args.push("--model", engine.model);
    if (engine.effort && engine.effort !== PLANNER_ENGINES.defaultEffort) args.push("--effort", engine.effort);
    // `--` is required: --disallowed-tools is variadic and would swallow the prompt.
    args.push("--", scanPrompt(repository));
    let stdout = "";
    try {
      ({ stdout = "" } = await this.execute("ccs", args, { cwd: repository.path, encoding: "utf8", timeout: this.ceilingMs, idleTimeout: this.idleTimeoutMs, maxBuffer: 4 * 1024 * 1024, env: process.env }));
    } catch (cause) {
      if (cause?.code === "ENOENT") throw new Error("The scan needs the ccs CLI. Install it, then try again");
      if (cause?.killed || cause?.signal === "SIGTERM") throw new Error(describeTimeout(cause?.reason, this.idleTimeoutMs, this.ceilingMs));
      throw new Error(describeRunFailure(cause?.stderr));
    }
    return parseScanReply(finalEnvelope(stdout));
  }
}

export function scanPrompt(repository) {
  return [
    `You are scanning the repository "${repository.name}" to propose one goal for a coding agent.`,
    "1. Read AGENTS.md or CLAUDE.md if present, then the README.",
    "2. Find the largest tractable increment worth one goal: a missing test area, a stale module, a documented TODO, an unfinished feature. Prefer work with observable verification.",
    "3. Do not write files. Do not run commands. Read only.",
    'Answer with exactly one JSON object and nothing else: {"goal":"one sentence a developer can act on","rationale":"why this, in two to four sentences","evidence":["path/or/command", "..."],"sizeEstimate":"small|medium|large"}',
  ].join("\n");
}

export function parseScanReply(stdout) {
  const envelope = extractJson(String(stdout));
  if (!envelope) throw new TypeError(UNUSABLE);
  const payload = extractJson(String(envelope.result ?? ""));
  if (!payload) throw new TypeError(UNUSABLE);
  return normalizeProposal(payload);
}

// The result line holds JSON, or prose around JSON. Take the outermost object.
function extractJson(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/burst-scanner.test.mjs`
Expected: PASS, 5 tests. If `describeTimeout("idle", ...)` wording differs from `/stopped answering/`, read `server/worktree-planner.mjs:135-140` and match the test to the real string.

- [ ] **Step 5: Commit**

```bash
git add server/burst-scanner.mjs tests/burst-scanner.test.mjs
git commit -m "Add the read-only burst scanner"
```

---

## Phase 4 — Routes and review screen

### Task 8: Routes and app wiring

**Files:**
- Create: `server/burst-routes.mjs`
- Modify: `server/request-schemas.mjs` (add `burstApprove`)
- Modify: `server/app.mjs` (imports; wiring after `issueSyncScheduler`; route registration after `registerPlannerRoutes`; `onClose`)
- Test: `tests/burst-routes.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerBurstRoutes } from "../server/burst-routes.mjs";
import { schemaErrorFormatter } from "../server/request-schemas.mjs";

const REPO = "repoAAAAAAAAAAAAAA";

function fakeService() {
  const burst = { burstId: "burst-1", status: "ready", candidates: [{ repositoryId: REPO, status: "proposed", goal: "g" }] };
  return {
    calls: [],
    async create() { this.calls.push(["create"]); return burst; },
    list() { return [burst]; },
    get(id) { return id === "burst-1" ? burst : null; },
    async approve(id, repo, body) { this.calls.push(["approve", id, repo, body]); return { ...burst.candidates[0], status: "approved", planId: "plan-1" }; },
    decline(id, repo) { this.calls.push(["decline", id, repo]); return { ...burst.candidates[0], status: "declined" }; },
    async rescan(id, repo) { this.calls.push(["rescan", id, repo]); return { ...burst.candidates[0], status: "scanning" }; },
  };
}

async function app(t, service) {
  const instance = Fastify({ schemaErrorFormatter, ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  instance.setErrorHandler((error, _request, reply) => reply.code(error instanceof TypeError ? 400 : 500).send({ error: error.message }));
  const invalidated = [];
  registerBurstRoutes(instance, { bursts: service, invalidate: () => invalidated.push(1) });
  t.after(() => instance.close());
  return { instance, invalidated };
}

test("create, list and read", async (t) => {
  const service = fakeService();
  const { instance } = await app(t, service);
  assert.equal((await instance.inject({ method: "POST", url: "/api/bursts" })).statusCode, 201);
  assert.equal((await instance.inject({ url: "/api/bursts" })).json().bursts.length, 1);
  assert.equal((await instance.inject({ url: "/api/bursts/burst-1" })).json().burstId, "burst-1");
  assert.equal((await instance.inject({ url: "/api/bursts/nope" })).statusCode, 404);
});

test("approve passes the goal override and invalidates dashboard caches", async (t) => {
  const service = fakeService();
  const { instance, invalidated } = await app(t, service);
  const response = await instance.inject({ method: "POST", url: `/api/bursts/burst-1/candidates/${REPO}/approve`, payload: { goal: "Edited" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().planId, "plan-1");
  assert.deepEqual(service.calls.at(-1), ["approve", "burst-1", REPO, { goal: "Edited" }]);
  assert.equal(invalidated.length, 1);
  assert.equal((await instance.inject({ method: "POST", url: `/api/bursts/burst-1/candidates/${REPO}/approve`, payload: { goal: 7 } })).statusCode, 400);
  assert.equal((await instance.inject({ method: "POST", url: `/api/bursts/burst-1/candidates/bad/approve`, payload: {} })).statusCode, 400);
});

test("decline and rescan", async (t) => {
  const service = fakeService();
  const { instance } = await app(t, service);
  assert.equal((await instance.inject({ method: "POST", url: `/api/bursts/burst-1/candidates/${REPO}/decline` })).json().status, "declined");
  assert.equal((await instance.inject({ method: "POST", url: `/api/bursts/burst-1/candidates/${REPO}/rescan` })).json().status, "scanning");
});

test("routes are unavailable without a service", async (t) => {
  const instance = Fastify();
  instance.setErrorHandler((error, _request, reply) => reply.code(error.statusCode || 500).send({ error: error.message }));
  registerBurstRoutes(instance, { bursts: null, invalidate: () => {} });
  t.after(() => instance.close());
  assert.equal((await instance.inject({ url: "/api/bursts" })).statusCode, 503);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/burst-routes.test.mjs`
Expected: FAIL with `Cannot find module '../server/burst-routes.mjs'`

- [ ] **Step 3: Add the schema and the routes**

In `server/request-schemas.mjs` add to `WRITE_SCHEMAS`:

```js
  burstApprove: body({ goal: { type: "string", maxLength: 8000 } }),
```

Create `server/burst-routes.mjs`:

```js
import { WRITE_SCHEMAS } from "./request-schemas.mjs";

const REPOSITORY_ID = /^[A-Za-z0-9_-]{18}$/;
const BURST_ID = /^burst-[A-Za-z0-9-]{4,64}$/;

export function registerBurstRoutes(app, { bursts, invalidate }) {
  const unavailable = () => Object.assign(new Error("Burst is unavailable"), { statusCode: 503 });
  const ids = (request) => {
    const burstId = String(request.params.burstId || "");
    const repositoryId = String(request.params.repositoryId || "");
    if (!BURST_ID.test(burstId)) throw new TypeError("Invalid burst id");
    if (!REPOSITORY_ID.test(repositoryId)) throw new TypeError("Invalid repository");
    return { burstId, repositoryId };
  };

  app.post("/api/bursts", async (_request, reply) => {
    if (!bursts) throw unavailable();
    const result = await bursts.create();
    return reply.code(result.burstId ? 201 : 200).send(result);
  });

  app.get("/api/bursts", async () => {
    if (!bursts) throw unavailable();
    return { bursts: bursts.list() };
  });

  app.get("/api/bursts/:burstId", async (request, reply) => {
    if (!bursts) throw unavailable();
    const burst = BURST_ID.test(String(request.params.burstId || "")) ? bursts.get(request.params.burstId) : null;
    if (!burst) return reply.code(404).send({ error: "Unknown burst", code: "NOT_FOUND" });
    return burst;
  });

  // Approval creates a goal, so the dashboard caches that list goals go stale.
  app.post("/api/bursts/:burstId/candidates/:repositoryId/approve", { schema: WRITE_SCHEMAS.burstApprove }, async (request) => {
    if (!bursts) throw unavailable();
    const { burstId, repositoryId } = ids(request);
    const candidate = await bursts.approve(burstId, repositoryId, request.body || {});
    invalidate();
    return candidate;
  });

  app.post("/api/bursts/:burstId/candidates/:repositoryId/decline", async (request) => {
    if (!bursts) throw unavailable();
    const { burstId, repositoryId } = ids(request);
    return bursts.decline(burstId, repositoryId);
  });

  app.post("/api/bursts/:burstId/candidates/:repositoryId/rescan", async (request) => {
    if (!bursts) throw unavailable();
    const { burstId, repositoryId } = ids(request);
    return bursts.rescan(burstId, repositoryId);
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/burst-routes.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 5: Wire into `app.mjs`**

Read `server/app.mjs:1-70` and `:140-200` again before this edit.

1. Imports, next to the planner-routes import:

```js
import { registerBurstRoutes } from "./burst-routes.mjs";
import { BurstStore } from "./burst-store.mjs";
import { BurstScanner } from "./burst-scanner.mjs";
import { BurstService } from "./burst-service.mjs";
```

2. `buildApp` options: add `burstStore = null,` and `burstService = null,` after `githubIssueSyncScheduler = null,`.

3. After the `issueSyncScheduler` declaration:

```js
  // Burst reuses the goal session path for every approved candidate, so a test
  // that builds an app without goal sessions gets no burst service and 503s.
  const burstPlans = burstStore || (goalSessions && !burstService ? new BurstStore() : null);
  const bursts = burstService
    || (goalSessions && burstPlans ? new BurstService({ store: burstPlans, worktrees, goalSessions, accountUsage, log: app.log, scanner: new BurstScanner({ modelSettings }) }) : null);
```

4. After the `registerPlannerRoutes(...)` call:

```js
  registerBurstRoutes(app, { bursts, invalidate: () => { bootstrapSnapshot = null; worktrees.invalidate(); } });
```

5. In the `onClose` hook, next to `if (!worktreePlanStore && planStore) planStore.close();`:

```js
    if (!burstStore && burstPlans) burstPlans.close();
```

Caution: `new BurstStore()` opens `~/.config/cmux-companion/bursts.db`. `tests/api.test.mjs` builds apps without injecting stores; the condition above creates a burst store only when `goalSessions` exists, which happens only when `planStore` exists, which `buildApp` creates when no `worktreePlanner` is injected. Check `tests/api.test.mjs` `buildApp` helper: if it does not inject `worktreePlanner` or `worktreePlanStore`, add `burstStore: new BurstStore({ path: ":memory:" })` to that helper so tests never open the real file.

- [ ] **Step 6: Phase verification and commit**

Run: `npm test && npm run typecheck && npm run lint`

```bash
git add server/burst-routes.mjs server/request-schemas.mjs server/app.mjs tests/burst-routes.test.mjs tests/api.test.mjs
git commit -m "Expose burst plans through the companion API"
```

### Task 9: `BurstPlanSheet` and `BurstBanner`

**Files:**
- Create: `app/burst-plan.tsx`
- Modify: `app/features.css` (append)
- Test: `tests/ui-burst-plan.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import assert from "node:assert/strict";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, test, vi } from "vitest";
import { BurstBanner, BurstPlanSheet } from "../app/burst-plan";
import type { AgentCapacity } from "../app/agent-capacity";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const REPO = "repoAAAAAAAAAAAAAA";
const burst = { burstId: "burst-1", status: "ready", createdAt: "2026-09-08T10:00:00Z", updatedAt: "2026-09-08T10:05:00Z", capacitySnapshot: null,
  candidates: [
    { repositoryId: REPO, repositoryName: "trust-layer", goal: "Cover the plan store", rationale: "35 modules have no test", evidence: ["server/burst-store.mjs"], sizeEstimate: "medium", status: "proposed", reason: null, planId: null, updatedAt: "2026-09-08T10:05:00Z" },
    { repositoryId: "repoBBBBBBBBBBBBBB", repositoryName: "ledger", goal: null, rationale: null, evidence: [], sizeEstimate: null, status: "failed", reason: "The scan needs the ccs CLI", planId: null, updatedAt: "2026-09-08T10:05:00Z" },
  ] };

function stubFetch(handlers: Record<string, (init?: RequestInit) => unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, "");
    calls.push({ url, init });
    const key = `${(init?.method || "GET").toUpperCase()} ${url}`;
    const handler = handlers[key];
    if (!handler) return new Response(JSON.stringify({ error: `no handler for ${key}` }), { status: 501 });
    return new Response(JSON.stringify(handler(init)), { status: 200 });
  }));
  return calls;
}

test("lists candidates with rationale, evidence and a stated failure", async () => {
  stubFetch({ "GET /api/bursts": () => ({ bursts: [burst] }), "GET /api/bursts/burst-1": () => burst });
  render(<BurstPlanSheet readOnly={false} onClose={() => {}} onOpenGoal={() => {}} />);
  assert.ok(await screen.findByText("Cover the plan store"));
  assert.ok(screen.getByText("35 modules have no test"));
  assert.ok(screen.getByText("server/burst-store.mjs"));
  assert.ok(screen.getByText("The scan needs the ccs CLI"));
  assert.ok(screen.getByRole("button", { name: "Approve trust-layer" }));
  assert.ok(screen.getByRole("button", { name: "Rescan ledger" }));
});

test("approve sends the edited goal and shows the created goal link", async () => {
  const calls = stubFetch({
    "GET /api/bursts": () => ({ bursts: [burst] }),
    "GET /api/bursts/burst-1": () => burst,
    [`POST /api/bursts/burst-1/candidates/${REPO}/approve`]: () => ({ ...burst.candidates[0], status: "approved", planId: "plan-9", goal: "Cover the plan store fully" }),
  });
  const open = vi.fn();
  render(<BurstPlanSheet readOnly={false} onClose={() => {}} onOpenGoal={open} />);
  const goal = await screen.findByLabelText("Goal for trust-layer");
  await userEvent.clear(goal);
  await userEvent.type(goal, "Cover the plan store fully");
  await userEvent.click(screen.getByRole("button", { name: "Approve trust-layer" }));
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Open goal for trust-layer" })));
  const post = calls.find((c) => c.init?.method === "POST");
  assert.deepEqual(JSON.parse(String(post?.init?.body)), { goal: "Cover the plan store fully" });
  await userEvent.click(screen.getByRole("button", { name: "Open goal for trust-layer" }));
  assert.deepEqual(open.mock.calls[0], [REPO, "plan-9"]);
});

test("read-only disables approve, decline and rescan", async () => {
  stubFetch({ "GET /api/bursts": () => ({ bursts: [burst] }), "GET /api/bursts/burst-1": () => burst });
  render(<BurstPlanSheet readOnly onClose={() => {}} onOpenGoal={() => {}} />);
  assert.ok((await screen.findByRole("button", { name: "Approve trust-layer" })).hasAttribute("disabled"));
  assert.ok(screen.getByRole("button", { name: "Decline trust-layer" }).hasAttribute("disabled"));
  assert.ok(screen.getByRole("button", { name: "Rescan ledger" }).hasAttribute("disabled"));
  assert.ok(screen.getByText(/Enable input in Settings/));
});

test("start a burst when none exists", async () => {
  const calls = stubFetch({ "GET /api/bursts": () => ({ bursts: [] }), "POST /api/bursts": () => ({ ...burst, status: "scanning" }), "GET /api/bursts/burst-1": () => ({ ...burst, status: "scanning" }) });
  render(<BurstPlanSheet readOnly={false} onClose={() => {}} onOpenGoal={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "Start a burst" }));
  await waitFor(() => assert.ok(calls.some((c) => c.init?.method === "POST" && c.url === "/api/bursts")));
  assert.ok(await screen.findByText(/Scanning starred repositories/));
});

test("the banner shows only for a live weekly opportunity", () => {
  const now = Date.parse("2026-09-08T12:00:00Z");
  const weekly = { cadence: "weekly", label: "Weekly", remainingPercent: 60, resetAt: "2026-09-09T06:00:00Z" };
  const capacity: AgentCapacity = { available: true, next: "claude", reason: "", nextReset: weekly.resetAt, providers: [{ id: "claude", label: "Claude", available: true, headroom: 60, bestPercent: 60, accounts: [{ id: "w", label: "Work", status: "ready", headroom: 60, windows: [weekly], opportunity: weekly }] }] };
  const start = vi.fn();
  const { rerender } = render(<BurstBanner capacity={capacity} now={now} onStart={start} />);
  assert.ok(screen.getByRole("button", { name: "Start a burst" }));
  rerender(<BurstBanner capacity={capacity} now={Date.parse(weekly.resetAt)} onStart={start} />);
  assert.equal(screen.queryByRole("button", { name: "Start a burst" }), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --config vitest.config.ts tests/ui-burst-plan.test.tsx`
Expected: FAIL with `Failed to resolve import "../app/burst-plan"`

- [ ] **Step 3: Write the component**

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { request } from "./api-request";
import type { AgentCapacity } from "./agent-capacity";

export type BurstCandidate = { repositoryId: string; repositoryName: string; goal: string | null; rationale: string | null; evidence: string[]; sizeEstimate: string | null; status: "scanning" | "proposed" | "failed" | "approved" | "declined"; reason: string | null; planId: string | null; updatedAt: string };
export type Burst = { burstId: string; status: "scanning" | "ready" | "closed"; createdAt: string; updatedAt: string; capacitySnapshot: unknown; candidates: BurstCandidate[] };
type CreateResult = Burst | { status: "no_starred_repositories"; message: string; burstId: null };

const READ_ONLY_HINT = "Read-only mode is on. Enable input in Settings to approve, decline or rescan.";

// A live weekly window is the one signal worth a banner. The banner is a
// shortcut to the same create action the sheet has; nothing starts by itself.
export function BurstBanner({ capacity, now, onStart }: { capacity: AgentCapacity | null; now: number; onStart: () => void }) {
  const live = (capacity?.providers || []).some((provider) => provider.accounts.some((account) => account.opportunity && Date.parse(account.opportunity.resetAt || "") > now));
  if (!live) return null;
  return <section className="burst-banner" role="region" aria-label="Burst opportunity">
    <div><strong>Quota window open</strong><p>At least 20% weekly quota resets within 24 hours. Scan every starred repository and propose one goal each.</p></div>
    <button type="button" className="primary-button" onClick={onStart}>Start a burst</button>
  </section>;
}

export function BurstPlanSheet({ readOnly, onClose, onOpenGoal, autoStart = false }: { readOnly: boolean; onClose: () => void; onOpenGoal: (repositoryId: string, planId: string) => void; autoStart?: boolean }) {
  const [burst, setBurst] = useState<Burst | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [goals, setGoals] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await request<{ bursts: Burst[] }>("/api/bursts");
      const latest = list.bursts[0] || null;
      if (!latest) { setBurst(null); return; }
      const detail = await request<Burst>(`/api/bursts/${latest.burstId}`);
      setBurst(detail);
      setGoals((current) => Object.fromEntries(detail.candidates.map((c) => [c.repositoryId, current[c.repositoryId] ?? c.goal ?? ""])));
    } catch (cause) { setError((cause as Error).message); }
    finally { setLoaded(true); }
  }, []);

  const start = useCallback(async () => {
    setBusy("create"); setError(""); setNotice("");
    try {
      const result = await request<CreateResult>("/api/bursts", { method: "POST", body: "{}" });
      if (result.status === "no_starred_repositories") { setNotice(result.message); return; }
      await load();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(""); }
  }, [load]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (autoStart && loaded && !burst) void start(); }, [autoStart, loaded, burst, start]);
  useEffect(() => {
    if (burst?.status !== "scanning") return;
    const poll = setInterval(() => { void load(); }, 5_000);
    return () => clearInterval(poll);
  }, [burst?.status, load]);

  async function act(candidate: BurstCandidate, action: "approve" | "decline" | "rescan") {
    setBusy(`${action}:${candidate.repositoryId}`); setError("");
    try {
      const body = action === "approve" ? JSON.stringify({ goal: goals[candidate.repositoryId] || candidate.goal || "" }) : "{}";
      const updated = await request<BurstCandidate>(`/api/bursts/${burst!.burstId}/candidates/${candidate.repositoryId}/${action}`, { method: "POST", body });
      setBurst((current) => current ? { ...current, candidates: current.candidates.map((c) => c.repositoryId === updated.repositoryId ? updated : c) } : current);
      if (action === "rescan") await load();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(""); }
  }

  return <><div className="session-menu-backdrop" onClick={onClose} /><section className="worktree-launcher worktree-planner-sheet burst-sheet" role="dialog" aria-modal="true" aria-label="Burst plan">
    <header className="worktree-launcher-header"><div><h2>Burst</h2><p>One proposed goal per starred repository. Approve a candidate to start its goal session; the spec still needs your approval there.</p></div><button type="button" className="text-button" onClick={onClose}>Close</button></header>
    {readOnly && <p className="burst-readonly" role="status">{READ_ONLY_HINT}</p>}
    {error && <p className="worktree-action-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!loaded && <p>Reading bursts…</p>}
    {loaded && !burst && <div className="empty-card"><span>⚡</span><strong>No burst yet</strong><p>Scan every starred repository and propose one goal each.</p><button type="button" className="primary-button" disabled={busy === "create"} onClick={() => { void start(); }}>{busy === "create" ? "Starting…" : "Start a burst"}</button></div>}
    {burst && <>
      <p className="burst-status" role="status">{burst.status === "scanning" ? "Scanning starred repositories… this page refreshes every 5 seconds." : burst.status === "closed" ? "Every candidate is decided." : "Review each candidate below."}</p>
      <ul className="burst-candidates">{burst.candidates.map((candidate) => {
        const name = candidate.repositoryName;
        const proposed = candidate.status === "proposed";
        return <li key={candidate.repositoryId} className={`burst-candidate ${candidate.status}`}>
          <header><span className="repo-icon">{name.slice(0, 1).toUpperCase()}</span><strong>{name}</strong><em>{candidateLabel(candidate)}</em></header>
          {candidate.status === "scanning" && <p>Reading the repository…</p>}
          {candidate.status === "failed" && <p className="burst-reason">{candidate.reason}</p>}
          {(proposed || candidate.status === "approved" || candidate.status === "declined") && <>
            {proposed ? <label className="worktree-task"><span>Goal</span><textarea aria-label={`Goal for ${name}`} rows={3} maxLength={8_000} value={goals[candidate.repositoryId] ?? ""} onChange={(event) => setGoals((current) => ({ ...current, [candidate.repositoryId]: event.target.value }))} /></label> : <p className="burst-goal">{candidate.goal}</p>}
            {candidate.rationale && <p className="burst-rationale">{candidate.rationale}</p>}
            {candidate.evidence.length > 0 && <ul className="burst-evidence">{candidate.evidence.map((item, index) => <li key={index}><code>{item}</code></li>)}</ul>}
            {candidate.sizeEstimate && <small>Estimated size: {candidate.sizeEstimate}</small>}
          </>}
          <footer>
            {candidate.status === "approved" && candidate.planId && <button type="button" className="text-button" aria-label={`Open goal for ${name}`} onClick={() => onOpenGoal(candidate.repositoryId, candidate.planId!)}>Open goal</button>}
            {proposed && <button type="button" className="primary-button" aria-label={`Approve ${name}`} disabled={readOnly || busy !== "" || !(goals[candidate.repositoryId] || "").trim()} onClick={() => { void act(candidate, "approve"); }}>{busy === `approve:${candidate.repositoryId}` ? "Starting goal…" : "Approve"}</button>}
            {(proposed || candidate.status === "failed") && <button type="button" className="text-button" aria-label={`Decline ${name}`} disabled={readOnly || busy !== ""} onClick={() => { void act(candidate, "decline"); }}>Decline</button>}
            {candidate.status !== "scanning" && candidate.status !== "approved" && <button type="button" className="text-button" aria-label={`Rescan ${name}`} disabled={readOnly || busy !== ""} onClick={() => { void act(candidate, "rescan"); }}>Rescan</button>}
          </footer>
        </li>;
      })}</ul>
      {burst.status !== "scanning" && <button type="button" className="text-button" disabled={readOnly || busy === "create"} onClick={() => { void start(); }}>Start a new burst</button>}
    </>}
  </section></>;
}

function candidateLabel(candidate: BurstCandidate) {
  if (candidate.status === "scanning") return "Scanning";
  if (candidate.status === "proposed") return "Proposed";
  if (candidate.status === "approved") return "Goal started";
  if (candidate.status === "declined") return "Declined";
  return "Scan failed";
}
```

Append to `app/features.css`:

```css
.burst-banner{margin-top:14px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;border:1px solid #7a5a1e;border-radius:14px;background:#21190c;padding:14px}
.burst-banner p{margin:4px 0 0;font-size:13px;line-height:1.5;color:#d8c7a3}
.burst-sheet .burst-candidates{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:12px}
.burst-candidate{border:1px solid #2c343c;border-radius:12px;padding:12px;background:#151a1f}
.burst-candidate>header{display:flex;align-items:center;gap:8px}
.burst-candidate>header em{margin-left:auto;font-style:normal;font-size:12px;color:#96a0aa}
.burst-candidate.failed{border-color:#6a2b2b}
.burst-candidate.approved{border-color:#3d6b3d}
.burst-reason{color:#ff9d9d}
.burst-rationale{font-size:13px;line-height:1.5;color:#c9d1d9}
.burst-evidence{margin:6px 0;padding-left:18px;font-size:12px}
.burst-candidate>footer{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.burst-readonly,.burst-status{font-size:13px;color:#96a0aa}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --config vitest.config.ts tests/ui-burst-plan.test.tsx`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add app/burst-plan.tsx tests/ui-burst-plan.test.tsx
git add -p app/features.css
git commit -m "Add the burst review sheet and opportunity banner"
```

### Task 10: Wire the sheet, the banner and `readOnly` into the dashboard

**Files:**
- Modify: `app/worktree-dashboard.tsx` (signature at line 268; Board tools near line 826; opportunities near line 842; sheet render near line 918)
- Modify: `app/page.tsx:143` (pass `readOnly`)
- Test: `tests/ui-worktree-overview.test.tsx` or `tests/ui-features.test.tsx` (one render assertion)

Both files carry pre-existing uncommitted hunks. Re-read them before editing; stage with `git add -p`.

- [ ] **Step 1: Write the failing test** (append to `tests/ui-features.test.tsx`, inside `describe("burst")`)

```tsx
  test("Board tools offers Burst and opens the sheet", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/bursts")) return new Response(JSON.stringify({ bursts: [] }), { status: 200 });
      if (url.includes("/api/worktree-dashboard")) return new Response(JSON.stringify({ generatedAt: "2026-09-08T00:00:00Z", github: { status: "ready" }, summary: { repositories: 0 }, repositories: [], orphanSessions: [] }), { status: 200 });
      if (url.includes("/api/worktree-plans")) return new Response(JSON.stringify({ plans: [] }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    render(<WorktreeDashboardView readOnly={false} onOpenWorkspace={() => {}} onLaunched={async () => {}} onNotice={() => {}} />);
    await userEvent.click(await screen.findByText("Board tools"));
    await userEvent.click(screen.getByRole("button", { name: "Burst" }));
    assert.ok(await screen.findByRole("dialog", { name: "Burst plan" }));
  });
```

If the dashboard fetches more endpoints than the stub answers and the test hangs, extend the catch-all `Response` above; every unmatched call already returns `{}` with 200.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --config vitest.config.ts tests/ui-features.test.tsx -t "Board tools offers Burst"`
Expected: FAIL with `Unable to find role="button" and name "Burst"`

- [ ] **Step 3: Edit the dashboard**

In `app/worktree-dashboard.tsx`:

1. Import: `import { BurstBanner, BurstPlanSheet } from "./burst-plan";`
2. Signature: add `readOnly = false` to the destructured props and `readOnly?: boolean` to the type.
3. State, next to `const [capacityOpen, setCapacityOpen] = useState(false);`:

```tsx
  const [burstSheet, setBurstSheet] = useState<null | { autoStart: boolean }>(null);
```

4. In Board tools (`board-secondary-actions` div), after the GitHub Sync button:

```tsx
<button type="button" className="text-button" onClick={() => setBurstSheet({ autoStart: false })}>Burst</button>
```

5. Directly before `{isBoardView && <WeeklyOpportunities ... />}`:

```tsx
      {isBoardView && <BurstBanner capacity={capacity} now={nowTick} onStart={() => setBurstSheet({ autoStart: true })} />}
```

6. Next to the `GitHubIssuePicker` render:

```tsx
    {burstSheet && <BurstPlanSheet readOnly={readOnly} autoStart={burstSheet.autoStart} onClose={() => { setBurstSheet(null); void loadGoalPlans(); }} onOpenGoal={(repositoryId, planId) => { const repo = (dashboard?.repositories || []).find((item) => item.id === repositoryId); setBurstSheet(null); if (repo) openGoalPopup({ repository: repo, planId }); }} />}
```

In `app/page.tsx:143`, add `readOnly={readOnly}` to the `<WorktreeDashboardView ... />` element.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --config vitest.config.ts tests/ui-features.test.tsx -t "Board tools offers Burst"`
Expected: PASS

- [ ] **Step 5: Phase verification and commit**

Run: `npm run test:ui && npm run typecheck && npm run lint`

```bash
git add -p app/worktree-dashboard.tsx app/page.tsx
git add tests/ui-features.test.tsx
git commit -m "Open the burst sheet from Board tools and the capacity banner"
```

---

## Phase 5 — Extra review agents

### Task 11: Burst review state on tasks

**Files:**
- Modify: `server/worktree-plan-schema.mjs`
- Modify: `server/worktree-plan-store.mjs` (task row mapper near line 1441; new methods after `recordTaskPending`)
- Test: `tests/worktree-plan-store.test.mjs`

- [ ] **Step 1: Write the failing test** (append)

```js
test("burst review state moves running → pass or block, and the second block is final", (t) => {
  const store = memoryStore(t);
  store.createPlan({ planId: "plan-b", repositoryId: "repository12345678", goal: "g", burst: true });
  store.recordRound("plan-b", { round: 1, stage: "ready", tasks: TASKS });
  store.recordLaunch("plan-b", { results: TASKS.map((task) => ({ id: task.id, branch: task.branch, status: "launched", workspace: { workspace_id: `ws-${task.id}` } })) });
  let plan = store.recordBurstReviewLaunched("plan-b", "t1", { workspaceId: "review-1" });
  let task = plan.tasks.find((item) => item.id === "t1");
  assert.equal(task.burstReviewStatus, "running");
  assert.equal(task.burstReviewRound, 1);
  assert.equal(task.burstReviewWorkspaceId, "review-1");
  plan = store.recordBurstReviewVerdict("plan-b", "t1", { verdict: "block", findings: ["No test for the empty case"] });
  task = plan.tasks.find((item) => item.id === "t1");
  assert.equal(task.burstReviewStatus, "block");
  assert.deepEqual(task.burstReviewFindings, ["No test for the empty case"]);
  plan = store.recordBurstReviewLaunched("plan-b", "t1", { workspaceId: "review-2" });
  assert.equal(plan.tasks.find((item) => item.id === "t1").burstReviewRound, 2);
  plan = store.recordBurstReviewVerdict("plan-b", "t1", { verdict: "block", findings: ["Still missing"] });
  assert.equal(plan.tasks.find((item) => item.id === "t1").burstReviewStatus, "blocked_twice");
  assert.throws(() => store.recordBurstReviewLaunched("plan-b", "t1", { workspaceId: "review-3" }), /no further review/);
  plan = store.recordBurstReviewVerdict("plan-b", "t2", { verdict: "pass", findings: [] });
  assert.equal(plan.tasks.find((item) => item.id === "t2").burstReviewStatus, "pass");
  assert.deepEqual(store.findTaskByBurstReviewWorkspace("review-2"), { planId: "plan-b", taskId: "t1" });
});
```

Check how existing tests in this file call `recordRound` and `recordLaunch`; copy their argument shapes exactly if they differ from the above.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/worktree-plan-store.test.mjs`
Expected: FAIL with `store.recordBurstReviewLaunched is not a function`

- [ ] **Step 3: Add the columns and methods**

In `server/worktree-plan-schema.mjs`, after the `plans.burst` line:

```js
    ensure("plan_tasks", "burst_review_status", "TEXT");
    ensure("plan_tasks", "burst_review_round", "INTEGER NOT NULL DEFAULT 0");
    ensure("plan_tasks", "burst_review_workspace_id", "TEXT");
    ensure("plan_tasks", "burst_review_findings", "TEXT NOT NULL DEFAULT '[]'");
```

In `server/worktree-plan-store.mjs`, after `recordTaskPending`:

```js
  // One reviewer per finished task, at most twice. The second block is final:
  // the task waits for a person, and no third session is ever opened.
  recordBurstReviewLaunched(planId, taskId, { workspaceId }) {
    const at = this.#stamp();
    const id = String(planId);
    this.#transaction(() => {
      const row = this.db.prepare("SELECT burst_review_status, burst_review_round FROM plan_tasks WHERE plan_id = ? AND task_id = ?").get(id, String(taskId));
      if (!row) throw new TypeError("Unknown task");
      if (row.burst_review_status === "blocked_twice" || row.burst_review_status === "pass") throw new TypeError("This task needs no further review");
      if (row.burst_review_status === "running") throw new TypeError("A burst review is already running for this task");
      this.db.prepare(`UPDATE plan_tasks SET burst_review_status = 'running', burst_review_round = ?, burst_review_workspace_id = ?, updated_at = ? WHERE plan_id = ? AND task_id = ?`)
        .run(Number(row.burst_review_round) + 1, text(workspaceId), at, id, String(taskId));
      this.#insertEvent(id, null, "burst_review_launched", { taskId, workspaceId: text(workspaceId), round: Number(row.burst_review_round) + 1 }, at);
    });
    return this.get(id);
  }

  recordBurstReviewVerdict(planId, taskId, { verdict, findings = [] }) {
    if (verdict !== "pass" && verdict !== "block") throw new TypeError("A burst review verdict is pass or block");
    const at = this.#stamp();
    const id = String(planId);
    const list = (Array.isArray(findings) ? findings : []).map((item) => String(item || "").slice(0, 1_000)).filter(Boolean).slice(0, 50);
    this.#transaction(() => {
      const row = this.db.prepare("SELECT burst_review_round FROM plan_tasks WHERE plan_id = ? AND task_id = ?").get(id, String(taskId));
      if (!row) throw new TypeError("Unknown task");
      const status = verdict === "pass" ? "pass" : Number(row.burst_review_round) >= 2 ? "blocked_twice" : "block";
      this.db.prepare(`UPDATE plan_tasks SET burst_review_status = ?, burst_review_findings = ?, updated_at = ? WHERE plan_id = ? AND task_id = ?`)
        .run(status, json(list), at, id, String(taskId));
      this.#insertEvent(id, null, "burst_review_verdict", { taskId, verdict, status, findings: list }, at);
    });
    return this.get(id);
  }

  findTaskByBurstReviewWorkspace(workspaceId) {
    const value = text(workspaceId);
    if (!value) return null;
    const row = this.db.prepare("SELECT plan_id, task_id FROM plan_tasks WHERE burst_review_workspace_id = ? LIMIT 1").get(value);
    return row ? { planId: row.plan_id, taskId: row.task_id } : null;
  }
```

Confirm `plan_tasks` has an `updated_at` column with `grep -n "updated_at" server/worktree-plan-schema.mjs`. If it does not, drop `updated_at = ?` and its bound `at` from both UPDATE statements.

In the task row mapper (the object near line 1441 that has `launchStatus: row.launch_status,`), add:

```js
    burstReviewStatus: row.burst_review_status ?? null,
    burstReviewRound: Number(row.burst_review_round) || 0,
    burstReviewWorkspaceId: row.burst_review_workspace_id ?? null,
    burstReviewFindings: parse(row.burst_review_findings, []),
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/worktree-plan-store.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/worktree-plan-schema.mjs server/worktree-plan-store.mjs tests/worktree-plan-store.test.mjs
git commit -m "Record burst review rounds on plan tasks"
```

### Task 12: `BurstReview` — launch, verdict, and the gate

**Files:**
- Create: `server/burst-review.mjs`
- Test: `tests/burst-review.test.mjs`

The reviewer is an interactive cmux session on the task's worktree, with the other provider. Its brief asks for a verdict file. On the reviewer's `agent.hook.Stop`, the verdict file is read. Verdict file path: `<briefs directory>/<planId>-<taskId>-burst-review-<round>.json`, shape `{"verdict":"pass"|"block","findings":["..."]}`.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BurstReview, burstReviewPrompt, reviewerProvider } from "../server/burst-review.mjs";

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "burst-review-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function plan(overrides = {}) {
  return { planId: "plan-1", repositoryName: "sample", goal: "Ship it", burst: true, baseRef: "origin/main", spec: { outcome: "Done", acceptanceCriteria: [{ id: "AC-1", text: "It works", verification: "npm test" }] },
    tasks: [{ id: "t1", title: "Do", branch: "feature/do", agent: "claude", workspaceId: "ws-t1", worktreePath: "/wt/t1", launchStatus: "launched", deliveryStatus: "ready", criterionIds: ["AC-1"], ownedAreas: ["src/"], burstReviewStatus: null, burstReviewRound: 0, burstReviewFindings: [] }], ...overrides };
}

function harness(t, dir, current) {
  const calls = [];
  const store = {
    plan: current,
    get(id) { return id === this.plan.planId ? this.plan : null; },
    recordBurstReviewLaunched(id, taskId, { workspaceId }) { calls.push(["launched", taskId, workspaceId]); const task = this.plan.tasks.find((x) => x.id === taskId); task.burstReviewStatus = "running"; task.burstReviewRound += 1; task.burstReviewWorkspaceId = workspaceId; return this.plan; },
    recordBurstReviewVerdict(id, taskId, { verdict, findings }) { calls.push(["verdict", taskId, verdict, findings]); const task = this.plan.tasks.find((x) => x.id === taskId); task.burstReviewStatus = verdict === "pass" ? "pass" : task.burstReviewRound >= 2 ? "blocked_twice" : "block"; task.burstReviewFindings = findings; return this.plan; },
    recordTaskPending(id, taskId, value) { calls.push(["pending", taskId, value.error]); return this.plan; },
    findTaskByBurstReviewWorkspace(ws) { const task = this.plan.tasks.find((x) => x.burstReviewWorkspaceId === ws); return task ? { planId: this.plan.planId, taskId: task.id } : null; },
  };
  const cmux = { workspaceCreate: async (options) => { calls.push(["create", options]); return { workspace_id: `review-${calls.length}` }; }, sendWorkspacePrompt: async (ws, text) => { calls.push(["prompt", ws, text]); } };
  const briefs = { directory: dir, async write({ planId, taskId, markdown }) { const path = join(dir, `${planId}-${taskId}.md`); await writeFile(path, markdown); return { path }; }, pointerPrompt: ({ path }) => `Read ${path}` };
  const review = new BurstReview({ store, cmux, briefs, modelSettings: { workspace: (role, agent) => ({ agent, model: "default" }) } });
  return { review, calls, store, cmux };
}

test("the reviewer uses the other provider", () => {
  assert.equal(reviewerProvider("claude"), "codex");
  assert.equal(reviewerProvider("codex"), "claude");
});

test("launches one reviewer on a ready task and records it", async (t) => {
  const dir = await directory(t);
  const { review, calls } = harness(t, dir, plan());
  const launched = await review.reviewTask("plan-1", "t1");
  assert.equal(launched, true);
  const create = calls.find(([kind]) => kind === "create")[1];
  assert.equal(create.cwd, "/wt/t1");
  assert.equal(create.agent, "codex");
  assert.match(create.title, /Burst review/);
  assert.deepEqual(calls.find(([kind]) => kind === "launched").slice(1), ["t1", "review-2"]);
  const brief = burstReviewPrompt(plan(), plan().tasks[0], join(dir, "plan-1-t1-burst-review-1.json"));
  assert.match(brief, /verdict/);
  assert.match(brief, /Do not edit/);
});

test("a pass verdict is recorded and the owner is not prompted", async (t) => {
  const dir = await directory(t);
  const { review, calls } = harness(t, dir, plan());
  await review.reviewTask("plan-1", "t1");
  await writeFile(join(dir, "plan-1-t1-burst-review-1.json"), JSON.stringify({ verdict: "pass", findings: [] }));
  const handled = await review.onWorkspaceStopped("review-2");
  assert.equal(handled, true);
  assert.deepEqual(calls.find(([kind]) => kind === "verdict").slice(1), ["t1", "pass", []]);
  assert.equal(calls.some(([kind]) => kind === "prompt"), false);
});

test("a first block returns findings to the owner and marks the task pending; a second block stops", async (t) => {
  const dir = await directory(t);
  const { review, calls, store } = harness(t, dir, plan());
  await review.reviewTask("plan-1", "t1");
  await writeFile(join(dir, "plan-1-t1-burst-review-1.json"), JSON.stringify({ verdict: "block", findings: ["Missing empty-case test"] }));
  await review.onWorkspaceStopped("review-2");
  const prompt = calls.find(([kind]) => kind === "prompt");
  assert.equal(prompt[1], "ws-t1");
  assert.match(prompt[2], /Missing empty-case test/);
  assert.equal(calls.find(([kind]) => kind === "pending")[2].includes("Burst review"), true);
  store.plan.tasks[0].burstReviewStatus = "block";
  await review.reviewTask("plan-1", "t1");
  await writeFile(join(dir, "plan-1-t1-burst-review-2.json"), JSON.stringify({ verdict: "block", findings: ["Still missing"] }));
  await review.onWorkspaceStopped(store.plan.tasks[0].burstReviewWorkspaceId);
  assert.equal(store.plan.tasks[0].burstReviewStatus, "blocked_twice");
  const pendings = calls.filter(([kind]) => kind === "pending");
  assert.match(pendings.at(-1)[2], /blocked twice/);
});

test("a missing or malformed verdict file blocks with a stated reason", async (t) => {
  const dir = await directory(t);
  const { review, calls } = harness(t, dir, plan());
  await review.reviewTask("plan-1", "t1");
  await review.onWorkspaceStopped("review-2");
  assert.match(calls.find(([kind]) => kind === "verdict")[3][0], /no verdict file/);
});

test("gate: a burst task counts as ready only after a pass", () => {
  const { review } = harness({ after() {} }, "/tmp", plan());
  assert.equal(review.taskReady({ burst: true }, { deliveryStatus: "ready", burstReviewStatus: null }), false);
  assert.equal(review.taskReady({ burst: true }, { deliveryStatus: "ready", burstReviewStatus: "pass" }), true);
  assert.equal(review.taskReady({ burst: false }, { deliveryStatus: "ready", burstReviewStatus: null }), true);
});

test("an unrelated workspace stop is ignored", async (t) => {
  const dir = await directory(t);
  const { review } = harness(t, dir, plan());
  assert.equal(await review.onWorkspaceStopped("ws-other"), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/burst-review.test.mjs`
Expected: FAIL with `Cannot find module '../server/burst-review.mjs'`

- [ ] **Step 3: Write the module**

```js
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionEnv } from "./session-name.mjs";

// The extra reviewer a burst goal buys. One session per finished task, on the
// task's own worktree, with the other provider. It writes a verdict file and
// stops; the Stop hook brings the verdict back here. Twice at most.
export class BurstReview {
  constructor({ store, cmux, briefs, modelSettings, log = null } = {}) {
    if (!store || !cmux || !briefs || !modelSettings) throw new TypeError("Burst review needs a store, cmux, briefs and model settings");
    this.store = store; this.cmux = cmux; this.briefs = briefs; this.modelSettings = modelSettings; this.log = log;
  }

  // The integrator asks this before it treats a ready task as ready.
  taskReady(plan, task) {
    if (task.deliveryStatus !== "ready") return false;
    if (plan?.burst !== true) return true;
    return task.burstReviewStatus === "pass";
  }

  // Returns true when a reviewer session was opened, false when nothing was
  // needed. It never throws for a task that is simply not reviewable yet.
  async reviewTask(planId, taskId) {
    const plan = this.store.get(planId);
    const task = plan?.tasks?.find((item) => item.id === taskId);
    if (!plan || !task || plan.burst !== true) return false;
    if (task.deliveryStatus !== "ready" || !task.worktreePath) return false;
    if (["running", "pass", "blocked_twice"].includes(task.burstReviewStatus)) return false;
    const round = (Number(task.burstReviewRound) || 0) + 1;
    const verdictPath = this.verdictPath(plan.planId, task.id, round);
    const brief = await this.briefs.write({ planId: plan.planId, taskId: `${task.id}-burst-review-${round}`, markdown: burstReviewPrompt(plan, task, verdictPath) });
    const provider = reviewerProvider(task.agent);
    const created = await this.cmux.workspaceCreate({
      cwd: task.worktreePath,
      title: `Burst review ${round}: ${String(task.title || task.id).slice(0, 60)}`,
      ...this.modelSettings.workspace("codeReviewer", provider),
      env: sessionEnv(plan, task),
      prompt: this.briefs.pointerPrompt({ title: `Burst review: ${task.title || task.id}`, outcome: plan.spec?.outcome || plan.goal, path: brief.path }),
    });
    const workspaceId = created?.workspace_id || created?.workspaceId || created?.id || null;
    if (!workspaceId) throw new TypeError("cmux created the review session but did not return its id");
    this.store.recordBurstReviewLaunched(plan.planId, task.id, { workspaceId });
    return true;
  }

  // Called for every agent Stop. Returns false when the workspace is not one
  // of ours, so the caller can hand it to the integrator's own path.
  async onWorkspaceStopped(workspaceId) {
    const found = this.store.findTaskByBurstReviewWorkspace?.(workspaceId);
    if (!found) return false;
    const plan = this.store.get(found.planId);
    const task = plan?.tasks?.find((item) => item.id === found.taskId);
    if (!plan || !task || task.burstReviewStatus !== "running") return false;
    const verdict = await this.#readVerdict(this.verdictPath(plan.planId, task.id, task.burstReviewRound));
    const updated = this.store.recordBurstReviewVerdict(plan.planId, task.id, verdict);
    const after = updated.tasks.find((item) => item.id === task.id);
    if (verdict.verdict === "pass") return true;
    const summary = verdict.findings.map((item) => `- ${item}`).join("\n");
    if (after.burstReviewStatus === "blocked_twice") {
      this.store.recordTaskPending(plan.planId, task.id, { error: `Burst review blocked twice. Findings:\n${summary}` });
      return true;
    }
    this.store.recordTaskPending(plan.planId, task.id, { error: `Burst review found blocking issues (round ${task.burstReviewRound})` });
    if (task.workspaceId && this.cmux.sendWorkspacePrompt) {
      await this.cmux.sendWorkspacePrompt(task.workspaceId, [
        `An independent burst review of your branch found blocking issues:`, summary,
        "Address each finding, amend the final commit so it keeps the Cmux-Goal-Ready and Cmux-Goal-Report trailers, force-push with lease, then stop again. A second review follows.",
      ].join("\n")).catch((cause) => this.log?.warn?.({ err: cause, taskId: task.id }, "burst review findings could not reach the owner"));
    }
    return true;
  }

  verdictPath(planId, taskId, round) {
    return join(this.briefs.directory, `${planId}-${taskId}-burst-review-${round}.json`);
  }

  async #readVerdict(path) {
    let raw;
    try { raw = await readFile(path, "utf8"); }
    catch { return { verdict: "block", findings: ["The reviewer stopped without writing a verdict file; no verdict file was found"] }; }
    try {
      const value = JSON.parse(raw);
      if (value?.verdict !== "pass" && value?.verdict !== "block") throw new Error("verdict must be pass or block");
      const findings = Array.isArray(value.findings) ? value.findings.map((item) => String(item || "").trim()).filter(Boolean) : [];
      return { verdict: value.verdict, findings };
    } catch (cause) {
      return { verdict: "block", findings: [`The verdict file is malformed: ${String(cause?.message || cause).slice(0, 200)}`] };
    }
  }
}

export function reviewerProvider(agent) {
  return agent === "codex" ? "claude" : "codex";
}

export function burstReviewPrompt(plan, task, verdictPath) {
  const criteria = (plan.spec?.acceptanceCriteria || []).filter((criterion) => (task.criterionIds || []).includes(criterion.id));
  return [
    `# Burst review: ${task.title || task.id}`,
    `Goal: ${plan.goal}`,
    `Outcome: ${plan.spec?.outcome || plan.goal}`,
    `Branch: ${task.branch} against ${plan.baseRef || "origin/main"}`,
    `Owned areas: ${(task.ownedAreas || []).join(", ") || "(unspecified)"}`,
    "",
    "## Acceptance criteria this task owns",
    ...criteria.map((criterion) => `- ${criterion.id}: ${criterion.text}\n  Verify: ${criterion.verification}`),
    "",
    "## Your job",
    "1. Read the diff of this branch against its base.",
    "2. Run the repository's own verification if it is documented (README or AGENTS.md).",
    "3. Judge correctness, regressions, missing tests, security and scope drift outside the owned areas.",
    "Do not edit files. Do not commit. Do not push. You review only.",
    "",
    "## Verdict",
    `Write exactly one JSON file at ${verdictPath} with this shape and then stop:`,
    '{"verdict":"pass","findings":[]} or {"verdict":"block","findings":["one concrete, actionable finding", "..."]}',
    "Use block only for a finding that must change before merge. Put advisory notes in findings with a pass verdict.",
  ].join("\n");
}
```

Check `server/agent-brief.mjs`: `AgentBriefs` has `this.directory`. Good; the fake in the test sets `directory` too.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/burst-review.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add server/burst-review.mjs tests/burst-review.test.mjs
git commit -m "Add the burst reviewer session and verdict handling"
```

### Task 13: Hook the reviewer into the integrator and wire it

**Files:**
- Modify: `server/goal-integrator.mjs` (constructor; `attach`; `#assemble` pending calculation near line 251; after `#refreshTaskHeads`)
- Modify: `server/app.mjs` (construct `BurstReview`, pass to integrator)
- Test: `tests/goal-integrator.test.mjs`

Read `tests/goal-integrator.test.mjs` first to copy its harness for a combined plan with one ready task.

- [ ] **Step 1: Write the failing test** (append; adapt the harness names to the file's own helpers)

```js
test("a burst plan launches a reviewer on a ready task and waits for its pass before assembly", async (t) => {
  // Build a combined plan with one launched task whose branch evidence is ready.
  // Use this file's existing harness for that; then:
  const reviews = [];
  const burstReview = {
    taskReady: (plan, task) => task.deliveryStatus === "ready" && (plan.burst !== true || task.burstReviewStatus === "pass"),
    reviewTask: async (planId, taskId) => { reviews.push([planId, taskId]); return true; },
    onWorkspaceStopped: async () => false,
  };
  // integrator = harness({ ..., burstReview }) with plan.burst = true
  // await assert.rejects(() => integrator.assemble(plan.planId), /waiting for burst review/i);
  // assert.deepEqual(reviews, [[plan.planId, "t1"]]);
  // Then set the task's burstReviewStatus to "pass" in the fake store and assert assemble proceeds past the pending check.
});
```

Fill the commented lines with the real harness calls from the file. The assertions are the contract: `assemble` on a burst plan with a ready-but-unreviewed task calls `reviewTask` once and throws a `TypeError` whose message matches `/burst review/i`; after a pass it proceeds.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/goal-integrator.test.mjs`
Expected: FAIL — `reviews` is empty, or assemble proceeds without the review.

- [ ] **Step 3: Edit the integrator**

1. Constructor: accept `burstReview = null` and store `this.burstReview = burstReview;`.
2. In `attach`, change the Stop handler so review workspaces are handled first:

```js
    const onEvent = (event) => {
      if (event?.name !== "agent.hook.Stop") return;
      const workspaceId = event.workspace_id || event.payload?.workspace_id || event.data?.workspace_id;
      if (!workspaceId) return;
      Promise.resolve(this.burstReview?.onWorkspaceStopped?.(workspaceId)).then((handled) => {
        // A reviewer's own stop schedules the plan again, so a pass leads
        // straight into assembly and a block leads to the owner's next turn.
        const found = handled ? this.store.findTaskByBurstReviewWorkspace?.(workspaceId) : null;
        if (found) this.schedulePlan(found.planId);
        else this.scheduleWorkspace(workspaceId);
      }).catch((cause) => this.log?.warn?.({ err: cause, workspaceId }, "burst review stop handling failed"));
    };
```

3. In `#assemble`, after `plan = await this.#guard(plan, () => this.#refreshTaskHeads(plan));` and `await this.#publish(plan);`, add:

```js
    // A burst goal buys an independent review of every finished task. Launch
    // one for each ready task that has none, then wait: the reviewer's Stop
    // schedules this assemble again.
    if (plan.burst === true && this.burstReview) {
      for (const task of plan.tasks) {
        if (task.launchStatus === "launched" && task.deliveryStatus === "ready" && !task.burstReviewStatus) {
          try { await this.burstReview.reviewTask(plan.planId, task.id); }
          catch (cause) { this.log?.warn?.({ err: cause, planId: plan.planId, taskId: task.id }, "burst review launch failed"); }
        }
      }
      plan = this.store.get(plan.planId);
    }
```

4. Change the `pending` filter so a burst task is pending until it passes review:

```js
    const ready = (task) => this.burstReview ? this.burstReview.taskReady(plan, task) : task.deliveryStatus === "ready";
    const pending = plan.tasks.filter((task) => task.launchStatus === "launched" && !ready(task) && task.deliveryStatus !== "integrated");
```

5. Change the pending message so it names the cause:

```js
    if (pending.length) {
      const reviewing = pending.filter((task) => task.deliveryStatus === "ready");
      const message = reviewing.length === pending.length
        ? `Waiting for burst review of ${reviewing.length} task${reviewing.length === 1 ? "" : "s"}`
        : `Waiting for ${pending.length} task branch${pending.length === 1 ? "" : "es"} in wave ${activeWave(plan) + 1} to be committed, pushed, and evidenced`;
      if (automatic) throw new TasksNotReadyError(message);
      throw new TypeError(message);
    }
```

6. `#refreshTaskHeads` flips a blocked task back to ready when the head is unchanged. Guard it: in that method, change the first condition to skip a task whose burst review is `block` or `blocked_twice` and whose head has not moved:

```js
      if (evidence.headSha && (task.headSha !== evidence.headSha || task.deliveryStatus !== "ready" || task.evidenceStatus !== "ready")) {
        if (["block", "blocked_twice"].includes(task.burstReviewStatus) && task.headSha === evidence.headSha) continue;
        current = this.store.recordTaskReady(plan.planId, task.id, evidence.headSha, evidence);
```

A new head (the owner amended and force-pushed) resets nothing here; the store's `recordBurstReviewLaunched` starts round 2 because `burstReviewStatus` is `block`, not `running`. Add to the loop in step 3 above: also review a task whose status is `block` **and** whose head changed since the verdict. Simplest correct rule: review when `!task.burstReviewStatus || (task.burstReviewStatus === "block" && task.deliveryStatus === "ready")`. Use that expression in the `if` of step 3.

- [ ] **Step 4: Wire in `app.mjs`**

Import `BurstReview` from `./burst-review.mjs`. Construct before the integrator:

```js
  const burstReview = planStore ? new BurstReview({ store: planStore, cmux, briefs, modelSettings, log: app.log }) : null;
```

Pass `burstReview` into the `new GoalIntegrator({ ... })` call.

- [ ] **Step 5: Run to verify it passes**

Run: `node --test tests/goal-integrator.test.mjs tests/burst-review.test.mjs`
Expected: PASS

- [ ] **Step 6: Phase verification and commit**

Run: `npm test && npm run typecheck && npm run lint`

```bash
git add server/goal-integrator.mjs server/app.mjs tests/goal-integrator.test.mjs
git commit -m "Gate burst goal assembly on an independent task review"
```

### Task 14: Goal-level review when a burst goal session opens its PR

**Files:**
- Modify: `server/burst-review.mjs` (add `reviewGoal`)
- Modify: `server/goal-merge-watch.mjs` (constructor `burstReview`; call after an OPEN record)
- Modify: `server/app.mjs` (pass `burstReview` to `GoalMergeWatch`)
- Test: `tests/burst-review.test.mjs`, `tests/goal-merge-watch.test.mjs`

A goal session has no task worktrees; its agent implements in `goalSessionWorktreePath` and opens one PR. The review runs there when the PR becomes OPEN. Findings go to the goal session's own conversation through `sendWorkspacePrompt(plan.goalSessionWorkspaceId, ...)`. Store state reuses the existing plan-level `claimGoalReview` / `recordReviewLaunched` / `releaseGoalReview` methods at `server/worktree-plan-store.mjs:728-775`; those exist and nothing else uses them.

- [ ] **Step 1: Write the failing tests**

Append to `tests/burst-review.test.mjs`:

```js
test("reviewGoal launches once on the goal session worktree and prompts the owner on block", async (t) => {
  const dir = await directory(t);
  const calls = [];
  const current = { planId: "plan-g", repositoryName: "sample", goal: "Ship", burst: true, workflow: "goal_session", goalSessionWorkspaceId: "ws-goal", goalSessionWorktreePath: "/wt/goal", goalSessionBranch: "goal/ship", baseRef: "origin/main", engine: { provider: "claude" }, boardPrUrl: "https://github.test/pr/1", reviewStatus: null, reviewWorkspaceId: null, spec: null, tasks: [] };
  const store = {
    get: () => current,
    claimGoalReview(id, { agent }) { calls.push(["claim", agent]); if (current.reviewStatus) return null; current.reviewStatus = "claiming"; return current; },
    recordReviewLaunched(id, { workspaceId, agent }) { calls.push(["review-launched", workspaceId, agent]); current.reviewStatus = "running"; current.reviewWorkspaceId = workspaceId; return current; },
    releaseGoalReview() { calls.push(["release"]); current.reviewStatus = null; return current; },
    recordReviewSessionClosed() { calls.push(["closed"]); current.reviewStatus = "done"; return current; },
    findTaskByBurstReviewWorkspace: () => null,
    findPlanByReviewWorkspace(ws) { return current.reviewWorkspaceId === ws ? current : null; },
  };
  const cmux = { workspaceCreate: async (options) => { calls.push(["create", options.cwd, options.agent]); return { workspace_id: "review-g" }; }, sendWorkspacePrompt: async (ws, text) => { calls.push(["prompt", ws, text]); } };
  const briefs = { directory: dir, async write({ planId, taskId, markdown }) { const path = join(dir, `${planId}-${taskId}.md`); await writeFile(path, markdown); return { path }; }, pointerPrompt: ({ path }) => `Read ${path}` };
  const review = new BurstReview({ store, cmux, briefs, modelSettings: { workspace: (role, agent) => ({ agent, model: "default" }) } });
  assert.equal(await review.reviewGoal("plan-g"), true);
  assert.deepEqual(calls.find(([k]) => k === "create").slice(1), ["/wt/goal", "codex"]);
  assert.equal(await review.reviewGoal("plan-g"), false, "a second call while one runs is a no-op");
  await writeFile(join(dir, "plan-g-goal-burst-review-1.json"), JSON.stringify({ verdict: "block", findings: ["Missing changelog"] }));
  assert.equal(await review.onWorkspaceStopped("review-g"), true);
  const prompt = calls.find(([k]) => k === "prompt");
  assert.equal(prompt[1], "ws-goal");
  assert.match(prompt[2], /Missing changelog/);
  assert.ok(calls.some(([k]) => k === "closed"));
});
```

Append to `tests/goal-merge-watch.test.mjs` (copy the file's own harness for an OPEN observation on a launched plan; then):

```js
test("an OPEN pull request on a burst goal session asks for a goal review", async () => {
  // harness with plan { burst: true, workflow: "goal_session", ... } and one OPEN observation
  const reviewed = [];
  // pass burstReview: { reviewGoal: async (planId) => { reviewed.push(planId); return true; } } to GoalMergeWatch
  // await watch.reconcile(...)   // the method this file calls on the watch
  // assert.deepEqual(reviewed, [plan.planId]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/burst-review.test.mjs tests/goal-merge-watch.test.mjs`
Expected: FAIL — `review.reviewGoal is not a function`; the merge-watch test records no review.

- [ ] **Step 3: Add `reviewGoal` and the goal-level stop path**

In `server/burst-review.mjs` add to the class:

```js
  // The goal-session counterpart of reviewTask: one reviewer on the goal's own
  // worktree once its pull request is open. The plan-level review columns
  // hold the claim, so two watch passes cannot open two reviewers.
  async reviewGoal(planId) {
    const plan = this.store.get(planId);
    if (!plan || plan.burst !== true || plan.workflow !== "goal_session") return false;
    if (!plan.goalSessionWorktreePath || !(plan.boardPrUrl || plan.finalPrUrl)) return false;
    if (plan.reviewStatus) return false;
    const claimed = this.store.claimGoalReview(plan.planId, { agent: reviewerProvider(plan.engine?.provider) });
    if (!claimed) return false;
    try {
      const verdictPath = this.verdictPath(plan.planId, "goal", 1);
      const task = { id: "goal", title: plan.goal, branch: plan.goalSessionBranch, criterionIds: (plan.spec?.acceptanceCriteria || []).map((c) => c.id), ownedAreas: [] };
      const brief = await this.briefs.write({ planId: plan.planId, taskId: "goal-burst-review-1", markdown: burstReviewPrompt(plan, task, verdictPath) });
      const provider = reviewerProvider(plan.engine?.provider);
      const created = await this.cmux.workspaceCreate({
        cwd: plan.goalSessionWorktreePath,
        title: `Burst review: ${String(plan.goal).slice(0, 60)}`,
        ...this.modelSettings.workspace("codeReviewer", provider),
        env: sessionEnv(plan, null),
        prompt: this.briefs.pointerPrompt({ title: `Burst review: ${plan.goal}`, outcome: plan.spec?.outcome || plan.goal, path: brief.path }),
      });
      const workspaceId = created?.workspace_id || created?.workspaceId || created?.id || null;
      if (!workspaceId) throw new TypeError("cmux created the review session but did not return its id");
      this.store.recordReviewLaunched(plan.planId, { workspaceId, agent: provider, briefPath: brief.path });
      return true;
    } catch (cause) {
      this.store.releaseGoalReview(plan.planId);
      throw cause;
    }
  }
```

Extend `onWorkspaceStopped`: before `return false` at the top, add a goal-level branch:

```js
    const found = this.store.findTaskByBurstReviewWorkspace?.(workspaceId);
    if (!found) return this.#onGoalReviewStopped(workspaceId);
```

and the private method:

```js
  async #onGoalReviewStopped(workspaceId) {
    const plan = this.store.findPlanByReviewWorkspace?.(workspaceId);
    if (!plan || plan.burst !== true || plan.reviewStatus !== "running") return false;
    const verdict = await this.#readVerdict(this.verdictPath(plan.planId, "goal", 1));
    this.store.recordReviewSessionClosed(plan.planId);
    if (verdict.verdict === "pass" || !plan.goalSessionWorkspaceId || !this.cmux.sendWorkspacePrompt) return true;
    await this.cmux.sendWorkspacePrompt(plan.goalSessionWorkspaceId, [
      "An independent burst review of your pull request found blocking issues:",
      verdict.findings.map((item) => `- ${item}`).join("\n"),
      "Address each finding on the same branch and push. Companion observes the pull request; do not merge.",
    ].join("\n")).catch((cause) => this.log?.warn?.({ err: cause, planId: plan.planId }, "burst goal review findings could not reach the owner"));
    return true;
  }
```

Add to `server/worktree-plan-store.mjs`, next to `findPlanByMergeWorkspace`:

```js
  findPlanByReviewWorkspace(workspaceIdValue) {
    const id = text(workspaceIdValue);
    if (!id) return null;
    const row = this.db.prepare("SELECT * FROM plans WHERE review_workspace_id = ? LIMIT 1").get(id);
    return row ? readPlan(row) : null;
  }
```

In `server/goal-merge-watch.mjs`: constructor accepts `burstReview = null`; after a recorded OPEN state in the reconcile loop (the block that pushes to `recorded`), add:

```js
        if (written.state === "OPEN") {
          Promise.resolve(this.burstReview?.reviewGoal?.(plan.planId))
            .catch((cause) => this.log?.warn?.({ err: cause, planId: plan.planId }, "burst goal review could not start"));
        }
```

In `server/app.mjs`, pass `burstReview` into `new GoalMergeWatch({ ... })`. `burstReview` must be constructed before `mergeWatch`; move its construction up if needed.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/burst-review.test.mjs tests/goal-merge-watch.test.mjs tests/worktree-plan-store.test.mjs`
Expected: PASS

- [ ] **Step 5: Phase verification and commit**

Run: `npm test && npm run typecheck && npm run lint`

```bash
git add server/burst-review.mjs server/goal-merge-watch.mjs server/worktree-plan-store.mjs server/app.mjs tests/burst-review.test.mjs tests/goal-merge-watch.test.mjs
git commit -m "Review a burst goal session once its pull request opens"
```

---

## Phase 6 — End-to-end coverage and docs

### Task 15: Cypress flow from banner to approved candidate

**Files:**
- Create: `cypress/e2e/burst-plan.cy.ts`

- [ ] **Step 1: Write the spec**

```ts
// Burst, end to end through the real UI against deterministic fixtures: the
// capacity banner appears, Start a burst creates one, the sheet polls until
// the scan settles, and Approve starts a goal session. No gh, no cmux, no ccs.
const now = "2026-09-08T12:00:00.000Z";
const REPO_A = "repoBurstE2E000001";
const REPO_B = "repoBurstE2E000002";

function repository(id: string, name: string) {
  return { id, name, root: "projects", path: `/Users/test/Developers/projects/${name}`, favorite: true, archived: false, pullRequestsAvailable: true,
    summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 },
    worktrees: [{ id: `wt-${id}`, repoId: id, path: `/Users/test/Developers/projects/${name}`, name, branch: "main", isPrimary: true, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }], releases: [] };
}

const weekly = { cadence: "weekly", label: "Weekly", remainingPercent: 55, resetAt: "2026-09-09T06:00:00.000Z" };
const capacity = { available: true, next: "claude", reason: "Claude has the most reported headroom.", nextReset: weekly.resetAt, state: "eligible",
  providers: [{ id: "claude", label: "Claude", available: true, headroom: 55, bestPercent: 55, resetAt: weekly.resetAt, accounts: [{ id: "acc", label: "Work", status: "ready", paused: false, updatedAt: now, freshness: "fresh", eligibility: "eligible", headroom: 55, windows: [weekly], opportunity: weekly }] }] };

function scenario() {
  const state = { burst: null as null | Record<string, unknown>, polls: 0, starts: [] as unknown[] };
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing local fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [], refreshedAt: now });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/github-issues*", { syncedAt: null, issues: [] });
  cy.intercept("GET", "**/api/goals/capacity*", capacity);
  cy.intercept("GET", "**/api/goals/health", { checkedAt: now, goals: [], summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0 } });
  cy.intercept("GET", "**/api/goals/sessions/retirable*", { count: 0, sessions: [] });
  cy.intercept("GET", "**/api/worktree-dashboard*", { generatedAt: now, github: { status: "ready" }, summary: { repositories: 2, worktrees: 2, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 }, repositories: [repository(REPO_A, "trust-layer"), repository(REPO_B, "ledger")], orphanSessions: [] });
  cy.intercept("GET", "**/api/worktree-plans*", { plans: [] });
  cy.intercept("GET", "**/api/settings/models", { roles: {}, defaults: {}, warning: null });
  cy.intercept("GET", "**/api/bursts", (request) => request.reply({ bursts: state.burst ? [state.burst] : [] })).as("listBursts");
  cy.intercept("POST", "**/api/bursts", (request) => {
    state.burst = { burstId: "burst-e2e", status: "scanning", createdAt: now, updatedAt: now, capacitySnapshot: capacity,
      candidates: [
        { repositoryId: REPO_A, repositoryName: "trust-layer", goal: null, rationale: null, evidence: [], sizeEstimate: null, status: "scanning", reason: null, planId: null, updatedAt: now },
        { repositoryId: REPO_B, repositoryName: "ledger", goal: null, rationale: null, evidence: [], sizeEstimate: null, status: "scanning", reason: null, planId: null, updatedAt: now },
      ] };
    request.reply({ statusCode: 201, body: state.burst });
  }).as("createBurst");
  cy.intercept("GET", "**/api/bursts/burst-e2e", (request) => {
    state.polls += 1;
    if (state.polls >= 2 && state.burst && state.burst.status === "scanning") {
      const candidates = state.burst.candidates as Record<string, unknown>[];
      candidates[0] = { ...candidates[0], status: "proposed", goal: "Cover the plan store with tests", rationale: "35 server modules have no test file.", evidence: ["server/worktree-plan-store.mjs"], sizeEstimate: "medium" };
      candidates[1] = { ...candidates[1], status: "failed", reason: "The scan needs the ccs CLI. Install it, then try again" };
      state.burst = { ...state.burst, status: "ready" };
    }
    request.reply(state.burst);
  }).as("readBurst");
  cy.intercept("POST", `**/api/bursts/burst-e2e/candidates/${REPO_A}/approve`, (request) => {
    state.starts.push(request.body);
    const candidates = state.burst!.candidates as Record<string, unknown>[];
    candidates[0] = { ...candidates[0], status: "approved", planId: "plan-e2e", goal: request.body.goal };
    request.reply(candidates[0]);
  }).as("approve");
  return state;
}

describe("burst plan", () => {
  it("starts from the capacity banner, reviews candidates and approves one", () => {
    const state = scenario();
    cy.clock(Date.parse(now), ["Date"]);
    cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); window.localStorage.setItem("cmux-companion-read-only", "false"); } });
    cy.findByRole("region", { name: "Burst opportunity" }).should("be.visible");
    cy.findByRole("button", { name: "Start a burst" }).click();
    cy.wait("@createBurst");
    cy.findByRole("dialog", { name: "Burst plan" }).should("be.visible");
    cy.contains("Scanning starred repositories").should("be.visible");
    cy.tick(5_000); cy.wait("@readBurst");
    cy.tick(5_000); cy.wait("@readBurst");
    cy.findByText("Cover the plan store with tests").should("be.visible");
    cy.findByText("The scan needs the ccs CLI. Install it, then try again").should("be.visible");
    cy.findByLabelText("Goal for trust-layer").clear().type("Cover the plan store with tests, starting with createPlan");
    cy.findByRole("button", { name: "Approve trust-layer" }).click();
    cy.wait("@approve").then(() => expect(state.starts[0]).to.deep.equal({ goal: "Cover the plan store with tests, starting with createPlan" }));
    cy.findByRole("button", { name: "Open goal for trust-layer" }).should("be.visible");
    cy.findByRole("button", { name: "Rescan ledger" }).should("be.enabled");
  });

  it("read-only mode disables every burst decision", () => {
    const state = scenario();
    state.burst = { burstId: "burst-e2e", status: "ready", createdAt: now, updatedAt: now, capacitySnapshot: null,
      candidates: [{ repositoryId: REPO_A, repositoryName: "trust-layer", goal: "g", rationale: "r", evidence: [], sizeEstimate: "small", status: "proposed", reason: null, planId: null, updatedAt: now }] };
    cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); window.localStorage.setItem("cmux-companion-read-only", "true"); } });
    cy.findByText("Board tools").click();
    cy.findByRole("button", { name: "Burst" }).click();
    cy.findByRole("button", { name: "Approve trust-layer" }).should("be.disabled");
    cy.findByRole("button", { name: "Decline trust-layer" }).should("be.disabled");
    cy.contains("Enable input in Settings").should("be.visible");
  });
});
```

If `cy.clock` interferes with the dashboard's own 10-second poll, drop the `cy.clock`/`cy.tick` calls and rely on `cy.wait("@readBurst")` twice with the real 5-second poll; the total wait stays under Cypress's default 60-second timeout.

- [ ] **Step 2: Run it**

Run: `npm run test:e2e:local -- --spec cypress/e2e/burst-plan.cy.ts` (if Electron fails: `CMUX_COMPANION_CYPRESS_BROWSER=chrome npm run test:e2e:local -- --spec cypress/e2e/burst-plan.cy.ts`)
Expected: 2 passing. Check `scripts/run-local-cypress.mjs` for how it forwards `--spec`; if it does not, run the whole local suite.

- [ ] **Step 3: Commit**

```bash
git add cypress/e2e/burst-plan.cy.ts
git commit -m "Cover the burst plan flow end to end"
```

### Task 16: README and AGENTS.md

**Files:**
- Modify: `README.md` (feature list under "What it does"; a new "Burst" subsection after "Visible goal sessions"; configuration table for `CMUX_COMPANION_BURSTS_DB`, `CMUX_BURST_IDLE_TIMEOUT_MS`, `CMUX_BURST_CEILING_MS`)
- Modify: `AGENTS.md` ("Important code" list)

- [ ] **Step 1: Add the feature bullets** under "What it does":

```md
- Detects a weekly quota window and offers **Start a burst**: one read-only scan agent per starred repository proposes one goal each; you approve, decline or rescan every candidate, and an approved candidate starts an ordinary goal session
- Marks any goal as **Burst**: every task brief permits subagents, an independent reviewer with the other provider checks each finished task (twice at most) before assembly, and a goal session gets one review when its pull request opens
```

- [ ] **Step 2: Add the subsection**

```md
## Burst

Burst has two independent parts. A **burst plan** scans every starred
repository with a read-only agent and proposes one goal per repository. Review
the goal, rationale and evidence on the Burst sheet (Board tools → Burst, or the
banner that appears when a weekly quota window is open). Approve a candidate to
start its goal session; the spec still needs your approval in that session.
Decline or rescan any candidate. One repository's scan failure is recorded on
that candidate and never aborts the others. Burst never launches work by itself.

The **Burst** toggle on the goal form is the second part. Every task brief of a
burst goal tells the agent it may launch subagents and that quota is not a
constraint. After a task reports finished, an independent reviewer with the
other provider reads the branch and writes a pass or block verdict. A block
returns the findings to the task agent for one more round; a second block marks
the task for your attention. A burst goal session gets the same review once its
pull request opens. Burst still respects the quota floor.
```

- [ ] **Step 3: Configuration rows** (match the table format in the README):

```md
| `CMUX_COMPANION_BURSTS_DB` | Path of the burst SQLite file. Default `~/.config/cmux-companion/bursts.db`. |
| `CMUX_BURST_IDLE_TIMEOUT_MS` | Silence limit for one burst scan. Default 240000. |
| `CMUX_BURST_CEILING_MS` | Absolute limit for one burst scan. Default 900000. |
```

- [ ] **Step 4: AGENTS.md** — add to "Important code":

```md
- `server/burst-service.mjs`, `server/burst-scanner.mjs`, `server/burst-store.mjs`: burst plans, the read-only per-repository scan and their storage.
- `server/burst-review.mjs`: the extra reviewer sessions a burst goal buys.
```

- [ ] **Step 5: Final verification and commit**

Run: `npm run verify`
Expected: backend, UI, lint, types and build all pass.

```bash
git add README.md AGENTS.md
git commit -m "Document Burst"
```

---

## Self-review

**Spec coverage.**
- Burst plan create/scan/review/approve/decline/rescan → Tasks 5–10.
- One candidate per repository, failure isolation, invalid output → failed → Tasks 5, 6, 7.
- Concurrency cap 3, provider from `assignAgents` → Task 6.
- Idempotent approve → Tasks 5, 6, 8.
- Read-only protection → Tasks 9, 10, 15.
- Capacity banner, Board tools entry, badge, form toggle → Tasks 4, 9, 10.
- Burst flag persisted, brief block → Tasks 1–3.
- Extra reviewer per task, two-round loop, blocked-twice attention → Tasks 11–13.
- Goal-branch review for goal sessions → Task 14.
- Capacity floor: the spec says burst launches wait at `MIN_HEADROOM`. The existing `assignAgents` already throws at the floor, and every burst launch (scan and approve) goes through it or through `GoalSessionService.start`, which uses the same policy. No separate wait state was added; the card shows the thrown reason. This is a narrower reading of "Waiting for quota" than the spec's wording and is stated here as such. Reviewer sessions (`BurstReview.reviewTask` and `reviewGoal`) bypass the floor entirely: they open through `cmux.workspaceCreate` without consulting `assignAgents` or the account usage, so a burst goal can add review sessions after the quota window has closed. That is a documented follow-up, not a decision. There is also no user action yet to waive a `blocked_twice` review other than aborting the goal; the task waits for a person, and the only path forward is abort.
- Tests listed in the spec → Tasks 1, 2, 3, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15. The spec named `tests/worktree-planner-options.test.mjs`; the flag lives in `burst-options.mjs`, so that test is `tests/burst-options.test.mjs`.

**Placeholder scan.** Task 13 step 1 and Task 14 step 1 contain commented harness lines because those test files own private helpers whose exact names the plan cannot assert without reading them. The contract each test must enforce is written out in prose beside the code. The implementer reads the file's harness and fills the calls.

**Type consistency.** `burst` boolean: request body → `GoalSessionService.start({ burst })` → `createPlan({ burst })` → `plan.burst` → `taskPrompt(..., plan.burst)`. Task review fields: `burstReviewStatus | burstReviewRound | burstReviewWorkspaceId | burstReviewFindings` in store, review module and integrator. Candidate fields identical in store, service, routes, sheet and Cypress fixtures.
