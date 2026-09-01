# Agent-Driven Goal Merge and CMUX Workspace Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `git`/`gh` subprocess merge in the goal integrator with one CMUX agent that can resolve conflicts, and add per-task progress counting plus CMUX workspace groups.

**Architecture:** The companion keeps its git readiness watcher, which decides when each task branch is finished. It no longer merges. When every branch is ready it creates the integration worktree and launches one Claude agent there with a merge prompt. It learns the outcome by reading `gh pr view` on the goal branch after that agent's Stop hook. A new best-effort `CmuxGroups` service groups task workspaces per goal and single workspaces per repository, and carries the `2/5` counter in the group name.

**Tech Stack:** Node 22 with `node:test`, Fastify, `node:sqlite`, React 19 with Vitest and Testing Library, the `cmux` CLI over its JSON RPC.

**Source spec:** `docs/superpowers/specs/2026-09-01-agent-merge-and-goal-groups-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `server/cmux-groups.mjs` (create) | Find-or-create a CMUX workspace group, add a workspace, rename a group. Best-effort: never throws. |
| `tests/cmux-groups.test.mjs` (create) | Unit test for find-or-create, add, rename, and the never-throws guarantee. |
| `server/worktree-plan-store.mjs` (modify) | Three new `plans` columns, two new event kinds, three new record methods, three new `readPlan` fields. |
| `server/cmux-client.mjs` (modify) | One new method: `notify`. |
| `server/goal-integrator.mjs` (rewrite) | Readiness watcher, progress publishing, merge-agent launch, result detection, retry. |
| `server/worktree-planner.mjs` (modify) | Put each launched task workspace in its group. |
| `server/app.mjs` (modify) | Build the groups service, inject it, and group the two dashboard session routes. |
| `app/worktree-planner.tsx` (modify) | Render the counter and the per-task delivery rows. |
| `app/features.css` (modify) | Style the counter and the task rows. |
| `tests/goal-integrator.test.mjs` (rewrite) | Cover launch, success, block, retry, and the group-failure guarantee. |
| `tests/worktree-plan-store.test.mjs` (modify) | Cover the three new record methods. |
| `tests/ui-features.test.tsx` (modify) | Cover the counter and the task rows. |

---

## Task 1: Store columns, event kinds, and record methods

**Files:**
- Modify: `server/worktree-plan-store.mjs`
- Test: `tests/worktree-plan-store.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `tests/worktree-plan-store.test.mjs`:

```javascript
test("records the cmux group, the merge workspace and a merge block", () => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  store.createPlan({ planId: "plan-groups", repositoryId: "repo-1", goal: "Ship it" });
  store.recordRound("plan-groups", {
    round: 1, stage: "ready", sessionId: "session",
    tasks: [
      { id: "t1", title: "One", branch: "feature/one", prompt: "Do", agent: "claude" },
      { id: "t2", title: "Two", branch: "feature/two", prompt: "Do", agent: "claude" },
    ],
  });

  assert.equal(store.recordGroup("plan-groups", "group-abc").cmuxGroupId, "group-abc");

  const launched = store.recordMergeLaunched("plan-groups", "workspace-merge");
  assert.equal(launched.mergeWorkspaceId, "workspace-merge");
  assert.equal(launched.mergeStatus, "running");
  assert.equal(launched.deliveryStatus, "assembling");

  const blocked = store.recordMergeBlocked("plan-groups", "Two tasks disagree about the retry policy");
  assert.equal(blocked.mergeStatus, "blocked");
  assert.equal(blocked.deliveryStatus, "blocked");
  assert.equal(blocked.deliveryError, "Two tasks disagree about the retry policy");
  assert.equal(blocked.mergeWorkspaceId, "workspace-merge");

  const kinds = store.events("plan-groups").map((event) => event.kind);
  assert.ok(kinds.includes("merge_launched"));
  assert.ok(kinds.includes("merge_blocked"));
  store.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/worktree-plan-store.test.mjs`

Expected: FAIL with `store.recordGroup is not a function`.

- [ ] **Step 3: Add the event kinds**

In `server/worktree-plan-store.mjs`, extend the `PLAN_EVENT_KINDS` set:

```javascript
export const PLAN_EVENT_KINDS = new Set([
  "goal", "questions", "answers", "tasks", "edit", "launch",
  "task_ready", "task_pending", "integration_started", "task_integrated", "delivery_failed", "final_pr",
  "merge_launched", "merge_blocked",
]);
```

- [ ] **Step 4: Add the columns to the schema and the migration**

In the `SCHEMA` template string, add three lines to the `plans` table, directly after `verified_at TEXT,`:

```sql
  cmux_group_id TEXT,
  merge_workspace_id TEXT,
  merge_status TEXT,
```

In `#migrate()`, add three lines after `ensure("plans", "verified_at", "TEXT");`:

```javascript
    ensure("plans", "cmux_group_id", "TEXT");
    ensure("plans", "merge_workspace_id", "TEXT");
    ensure("plans", "merge_status", "TEXT");
```

- [ ] **Step 5: Expose the columns on the read model**

In `readPlan(row)`, add three fields after `verifiedAt: row.verified_at,`:

```javascript
    cmuxGroupId: row.cmux_group_id,
    mergeWorkspaceId: row.merge_workspace_id,
    mergeStatus: row.merge_status,
```

- [ ] **Step 6: Add the three record methods**

In `server/worktree-plan-store.mjs`, insert these directly after `recordIntegrationStarted`:

```javascript
  // The cmux group is presentation, so it is stored on its own and never joins
  // a delivery transition. A lost group id only costs a fresh lookup by name.
  recordGroup(planId, groupId) {
    const at = this.#stamp();
    this.db.prepare("UPDATE plans SET cmux_group_id = ?, updated_at = ? WHERE plan_id = ?")
      .run(text(groupId), at, String(planId));
    return this.get(planId);
  }

  recordMergeLaunched(planId, workspaceId) {
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plans SET merge_workspace_id = ?, merge_status = 'running',
          delivery_status = 'assembling', delivery_error = NULL, updated_at = ? WHERE plan_id = ?
      `).run(text(workspaceId), at, String(planId));
      this.#insertEvent(String(planId), null, "merge_launched", { workspaceId }, at);
    });
    return this.get(planId);
  }

  // The merge agent stopped without a pull request. The worktree and the live
  // session are both kept, because a retry continues them rather than restarting.
  recordMergeBlocked(planId, reason) {
    const at = this.#stamp();
    const message = String(reason || "The merge agent stopped without opening a pull request").slice(0, 2_000);
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plans SET merge_status = 'blocked', delivery_status = 'blocked',
          delivery_error = ?, updated_at = ? WHERE plan_id = ?
      `).run(message, at, String(planId));
      this.#insertEvent(String(planId), null, "merge_blocked", { error: message }, at);
    });
    return this.get(planId);
  }
```

- [ ] **Step 7: Mark a finished merge**

`recordFinalPr` must also close the merge. In `server/worktree-plan-store.mjs`, change its UPDATE statement from:

```javascript
        UPDATE plans SET delivery_status = 'pr_open', final_pr_number = ?, final_pr_url = ?,
          delivery_error = NULL, verified_at = ?, updated_at = ? WHERE plan_id = ?
```

to:

```javascript
        UPDATE plans SET delivery_status = 'pr_open', merge_status = 'done', final_pr_number = ?,
          final_pr_url = ?, delivery_error = NULL, verified_at = ?, updated_at = ? WHERE plan_id = ?
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `node --test tests/worktree-plan-store.test.mjs`

Expected: PASS, every test in the file.

- [ ] **Step 9: Commit**

```bash
git add server/worktree-plan-store.mjs tests/worktree-plan-store.test.mjs
git commit -m "feat: store the cmux group and the merge workspace on a goal plan"
```

---

## Task 2: A cmux notification method

**Files:**
- Modify: `server/cmux-client.mjs`
- Test: `tests/cmux-client.test.mjs`

The capability list confirms `notification.create_for_target`. The client has no send method today, only `notifications()` and `markNotificationRead`.

- [ ] **Step 1: Write the failing test**

Append to `tests/cmux-client.test.mjs`. Match the existing fixture style in that file: it asserts on a recorded `calls` array of CLI argument lists.

```javascript
test("sends a workspace notification through the rpc surface", async () => {
  const calls = [];
  const client = new CmuxClient({
    bin: "/bin/true",
    execute: async (bin, args) => { calls.push(args); return { stdout: "{}" }; },
  });
  await client.notify("workspace-one", { title: "Goal ready", body: "3 of 3 branches ready" });
  assert.equal(calls[0][1], "rpc");
  assert.equal(calls[0][2], "notification.create_for_target");
  const params = JSON.parse(calls[0][3]);
  assert.equal(params.workspace_id, "workspace-one");
  assert.equal(params.title, "Goal ready");
  assert.equal(params.body, "3 of 3 branches ready");
});
```

If the fixture in `tests/cmux-client.test.mjs` builds its client differently, copy that file's own construction pattern instead of the two lines above. The assertions stay the same.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/cmux-client.test.mjs`

Expected: FAIL with `client.notify is not a function`.

- [ ] **Step 3: Add the method**

In `server/cmux-client.mjs`, insert directly after `markNotificationRead`:

```javascript
  // A notification is a courtesy, not a delivery step, so its input is clamped
  // rather than rejected. A long agent message must never fail a merge.
  async notify(workspaceId, { title, body = "" }) {
    assertTarget(workspaceId);
    const heading = String(title || "").trim().slice(0, 100);
    if (!heading) throw new TypeError("A notification needs a title");
    return this.rpc("notification.create_for_target", {
      workspace_id: workspaceId,
      title: heading,
      body: String(body || "").trim().slice(0, 500),
    });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/cmux-client.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/cmux-client.mjs tests/cmux-client.test.mjs
git commit -m "feat: send a cmux notification for a workspace"
```

---

## Task 3: The CmuxGroups service

**Files:**
- Create: `server/cmux-groups.mjs`
- Test: `tests/cmux-groups.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/cmux-groups.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { CmuxGroups } from "../server/cmux-groups.mjs";

function fake({ groups = [], fail = null } = {}) {
  const calls = [];
  const cmux = {
    rpc: async (method, params) => {
      calls.push([method, params]);
      if (fail === method) throw new Error("cmux is unavailable");
      if (method === "workspace.group.list") return { groups };
      if (method === "workspace.group.create") return { group: { id: "group-new" } };
      return {};
    },
  };
  return { cmux, calls, service: new CmuxGroups({ cmux }) };
}

test("creates a group anchored on the first workspace when no group carries the name", async () => {
  const { service, calls } = fake();
  const id = await service.ensure("companion", "workspace-one");
  assert.equal(id, "group-new");
  const create = calls.find((call) => call[0] === "workspace.group.create");
  assert.equal(create[1].workspace_ids[0], "workspace-one");
  assert.equal(calls.find((call) => call[0] === "workspace.group.rename")[1].name, "companion");
});

test("reuses a group that already carries the name and adds the workspace to it", async () => {
  const { service, calls } = fake({ groups: [{ id: "group-old", name: "companion", member_workspace_ids: ["workspace-zero"] }] });
  const id = await service.ensure("companion", "workspace-one");
  assert.equal(id, "group-old");
  assert.equal(calls.some((call) => call[0] === "workspace.group.create"), false);
  const add = calls.find((call) => call[0] === "workspace.group.add");
  assert.deepEqual([add[1].group_id, add[1].workspace_id], ["group-old", "workspace-one"]);
});

test("does not add a workspace that is already a member", async () => {
  const { service, calls } = fake({ groups: [{ id: "group-old", name: "companion", member_workspace_ids: ["workspace-one"] }] });
  assert.equal(await service.ensure("companion", "workspace-one"), "group-old");
  assert.equal(calls.some((call) => call[0] === "workspace.group.add"), false);
});

test("reuses a known group id without listing every group", async () => {
  const { service, calls } = fake({ groups: [{ id: "group-old", name: "companion", member_workspace_ids: [] }] });
  const id = await service.ensure("companion", "workspace-one", { groupId: "group-old" });
  assert.equal(id, "group-old");
  assert.equal(calls.some((call) => call[0] === "workspace.group.create"), false);
});

test("swallows every failure so grouping can never break a launch", async () => {
  const { service } = fake({ fail: "workspace.group.list" });
  assert.equal(await service.ensure("companion", "workspace-one"), null);
  assert.equal(await service.rename("group-old", "companion — 2/5"), false);
});

test("renames a group to carry the counter", async () => {
  const { service, calls } = fake();
  assert.equal(await service.rename("group-old", "Ship it — 2/5"), true);
  const rename = calls.find((call) => call[0] === "workspace.group.rename");
  assert.deepEqual([rename[1].group_id, rename[1].name], ["group-old", "Ship it — 2/5"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/cmux-groups.test.mjs`

Expected: FAIL with `Cannot find module '../server/cmux-groups.mjs'`.

- [ ] **Step 3: Write the service**

Create `server/cmux-groups.mjs`:

```javascript
const MAX_NAME = 80;

// A workspace group is how cmux shows that several sessions belong to one goal.
// Every method here is best-effort on purpose: a companion that cannot group a
// workspace must still launch it, and a cmux without group support must not
// turn a working delivery into a failed one.
export class CmuxGroups {
  constructor({ cmux, log = null } = {}) {
    if (!cmux) throw new TypeError("A cmux client is required");
    this.cmux = cmux;
    this.log = log;
  }

  // Returns the group id, or null when cmux could not be reached. `groupId` is
  // a hint from a stored plan: it saves a list call, and a stale one falls back
  // to the name lookup rather than failing.
  async ensure(name, workspaceId, { groupId = null } = {}) {
    const label = clamp(name);
    if (!label || !workspaceId) return null;
    try {
      const groups = await this.#list();
      const found = (groupId && groups.find((group) => group.id === groupId))
        || groups.find((group) => String(group.name || "") === label);
      if (!found) return this.#create(label, workspaceId);
      const members = Array.isArray(found.member_workspace_ids) ? found.member_workspace_ids : [];
      if (!members.includes(workspaceId)) {
        await this.cmux.rpc("workspace.group.add", { group_id: found.id, workspace_id: workspaceId });
      }
      return found.id;
    } catch (cause) {
      this.log?.warn?.({ err: cause, name: label }, "cmux group assignment failed");
      return null;
    }
  }

  async rename(groupId, name) {
    const label = clamp(name);
    if (!groupId || !label) return false;
    try {
      await this.cmux.rpc("workspace.group.rename", { group_id: groupId, name: label });
      return true;
    } catch (cause) {
      this.log?.warn?.({ err: cause, groupId }, "cmux group rename failed");
      return false;
    }
  }

  async #list() {
    const answer = await this.cmux.rpc("workspace.group.list", {});
    return Array.isArray(answer?.groups) ? answer.groups : [];
  }

  // create anchors the group on the workspaces it is given, so the first
  // workspace of a goal is what brings its group into existence.
  async #create(label, workspaceId) {
    const created = await this.cmux.rpc("workspace.group.create", { workspace_ids: [workspaceId] });
    const id = created?.group?.id || created?.group_id || null;
    if (!id) return null;
    await this.rename(id, label);
    return id;
  }
}

function clamp(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/cmux-groups.test.mjs`

Expected: PASS, 6 tests.

- [ ] **Step 5: Register the test file**

In `package.json`, add `tests/cmux-groups.test.mjs` to the `test` script, directly after `tests/cmux-client.test.mjs`.

- [ ] **Step 6: Run the whole server suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/cmux-groups.mjs tests/cmux-groups.test.mjs package.json
git commit -m "feat: add a best-effort cmux workspace group service"
```

---

## Task 4: The merge prompt

**Files:**
- Modify: `server/goal-integrator.mjs`
- Test: `tests/goal-integrator.test.mjs`

This task adds and tests the prompt on its own, before any wiring changes. The prompt is the contract with the agent, so it is worth isolating.

- [ ] **Step 1: Write the failing test**

Append to `tests/goal-integrator.test.mjs`, and add `mergePrompt` to the import from `../server/goal-integrator.mjs`:

```javascript
test("the merge prompt pins every task commit and states the conflict rule", () => {
  const plan = {
    planId: "plan-12345678",
    goal: "Ship combined billing",
    baseRef: "origin/main",
    integrationBranch: "goal/ship-combined-billing-plan1234",
    issueNumbers: [54, 55],
    tasks: [
      { id: "t1", title: "Billing API", branch: "feature/billing-api", headSha: "a".repeat(40), launchStatus: "launched" },
      { id: "t2", title: "Billing UI", branch: "feature/billing-ui", headSha: "b".repeat(40), launchStatus: "launched" },
    ],
  };
  const prompt = mergePrompt(plan);
  assert.ok(prompt.includes("a".repeat(40)));
  assert.ok(prompt.includes("b".repeat(40)));
  assert.ok(prompt.includes("feature/billing-api"));
  assert.ok(prompt.includes("Cmux-Goal-Task: plan-12345678/t1/" + "a".repeat(40)));
  assert.match(prompt, /Closes #54/);
  assert.match(prompt, /Conflicts resolved/);
  assert.match(prompt, /Do not guess/);
  assert.match(prompt, /gh pr create/);
  assert.match(prompt, /--base main/);
  assert.ok(prompt.length <= 8_000);
});

test("the merge prompt skips a task that failed to launch", () => {
  const plan = {
    planId: "plan-12345678", goal: "Ship it", baseRef: "origin/main",
    integrationBranch: "goal/ship-it-plan1234", issueNumbers: [],
    tasks: [
      { id: "t1", title: "Kept", branch: "feature/kept", headSha: "a".repeat(40), launchStatus: "launched" },
      { id: "t2", title: "Dropped", branch: "feature/dropped", headSha: null, launchStatus: "failed" },
    ],
  };
  const prompt = mergePrompt(plan);
  assert.ok(prompt.includes("feature/kept"));
  assert.equal(prompt.includes("feature/dropped"), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/goal-integrator.test.mjs`

Expected: FAIL with `mergePrompt is not defined`.

- [ ] **Step 3: Write the prompt builder**

In `server/goal-integrator.mjs`, add this exported function at module scope, beside the other helpers:

```javascript
const MAX_PROMPT = 8_000;

// The whole merge contract lives here. The agent gets pinned commits, not
// branch names to resolve itself: a task agent that pushes again mid-merge must
// not silently change what is delivered.
export function mergePrompt(plan) {
  const base = baseBranch(plan);
  const tasks = plan.tasks.filter((task) => task.launchStatus === "launched" && task.headSha);
  const list = tasks.map((task, index) => [
    `${index + 1}. ${oneLine(task.title, 100)}`,
    `   branch: ${task.branch}`,
    `   commit: ${task.headSha}`,
    `   trailer: Cmux-Goal-Task: ${plan.planId}/${task.id}/${task.headSha}`,
  ].join("\n")).join("\n");
  const closing = [...new Set(plan.issueNumbers || [])].map((number) => `Closes #${number}`).join("\n");

  return [
    `You are assembling one pull request for this goal: ${oneLine(plan.goal, 400)}`,
    "",
    `You are already in a fresh worktree on branch \`${plan.integrationBranch}\`, cut from \`origin/${base}\`.`,
    `Each task below was built by its own agent in its own worktree. Merge them here.`,
    "",
    "## Tasks to merge, in this order",
    list,
    "",
    "## How to merge",
    "Merge the exact commit listed above for each task, never the branch tip. A task agent may push again while you work, and the listed commit is the one that was reviewed as ready.",
    "For each task, in order:",
    "1. Check `git log` on this branch for that task's trailer. Skip the task when its trailer is already there. This makes a retry safe.",
    "2. Run `git merge --squash --no-commit <commit>`.",
    "3. Resolve whatever it reports (see the conflict rule below).",
    "4. Commit. The commit message must be a one-line subject, a blank line, then exactly that task's trailer line.",
    "",
    "## The conflict rule",
    "Resolve a mechanical conflict yourself. Imports, adjacent edits, formatting, a lockfile, and two tasks appending to the same list are all mechanical.",
    "Resolve a semantic conflict when the goal above makes the intent clear. Record every such choice.",
    "Stop when two tasks genuinely disagree about behaviour and the goal does not settle it. Do not guess. Leave the worktree exactly as it is, do not open a pull request, and state plainly which decision you cannot make and what the two options are.",
    "",
    "## Verification",
    "When every task is merged, run this repository's own verification. Use `npm run verify` when package.json declares it. Otherwise run whichever of `test`, `lint`, `typecheck` and `build` it declares. Install dependencies first when a lockfile is present.",
    "Fix what your merge broke. Do not fix a failure that is already present on the base branch: report it in the pull request body instead.",
    "",
    "## Finish",
    `Push this branch, then open one pull request against \`${base}\` with \`gh pr create --base ${base}\`. Do not mark it a draft.`,
    "The body must contain, in this order:",
    "- A `## Goal` section with the goal text.",
    "- An `## Integrated tasks` section listing each task title, its branch and its short commit.",
    "- A `## Conflicts resolved` section. This section is required. Write `None` when you resolved nothing. Otherwise describe every choice you made that the task authors did not make for you.",
    "- A `## Verification` section with what you ran and what it reported.",
    ...(closing ? ["- A `## Linked issues` section containing exactly these lines:", closing] : []),
    "",
    "Open exactly one pull request. Do not open a pull request for any individual task branch.",
  ].join("\n").slice(0, MAX_PROMPT);
}

function baseBranch(plan) {
  return String(plan.baseRef || "origin/main").replace(/^origin\//, "") || "main";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/goal-integrator.test.mjs`

Expected: The two new tests PASS. Older tests in the file still pass, because nothing else changed yet.

- [ ] **Step 5: Commit**

```bash
git add server/goal-integrator.mjs tests/goal-integrator.test.mjs
git commit -m "feat: build the goal merge prompt from pinned task commits"
```

---

## Task 5: Launch the merge agent instead of merging

**Files:**
- Modify: `server/goal-integrator.mjs`
- Test: `tests/goal-integrator.test.mjs:1-200`

This is the core change. The old merge path is deleted here.

- [ ] **Step 1: Rewrite the test fixture**

Replace the whole `fixture` function and the first three tests in `tests/goal-integrator.test.mjs` with this. Keep the `mergePrompt` tests from Task 4 at the end of the file.

The third old test is `selects one declared verify script instead of guessing model-generated commands`. Delete it. `qualityCommands` is deleted in Step 4 of this task, because the verification gate moves into the prompt. Also drop `qualityCommands` from the file's import, and drop the now-unused `writeFileSync` import along with the `package.json` and `package-lock.json` fixture writes.

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalIntegrator, mergePrompt } from "../server/goal-integrator.mjs";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";

const REPO_ID = "repository12345678";
const TASK_ONE = "a".repeat(40);
const TASK_TWO = "b".repeat(40);
const BASE = "c".repeat(40);

function fixture(t, { secondPushed = true, pullRequest = null, groupsFail = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "goal-integrator-"));
  const integrationPath = join(root, "sample-goal");
  mkdirSync(integrationPath);
  const store = new WorktreePlanStore({ path: ":memory:" });
  store.createPlan({ planId: "plan-12345678", repositoryId: REPO_ID, repositoryName: "sample", cwd: root, goal: "Ship combined billing", sourceType: "github_issues", issueNumbers: [54, 55], issueUrls: ["https://github.test/issues/54"] });
  store.recordRound("plan-12345678", {
    round: 1, stage: "ready", sessionId: "session",
    tasks: [
      { id: "t1", title: "Billing API", branch: "feature/billing-api", prompt: "Build it", agent: "codex" },
      { id: "t2", title: "Billing UI", branch: "feature/billing-ui", prompt: "Build it", agent: "claude" },
    ],
  });
  store.recordLaunch("plan-12345678", {
    base: "origin/main", baseSha: BASE,
    results: [
      { id: "t1", status: "launched", path: join(root, "task-one"), workspace: { workspace_id: "workspace-one" } },
      { id: "t2", status: "launched", path: join(root, "task-two"), workspace: { workspace_id: "workspace-two" } },
    ],
  });
  const calls = [];
  const repoCatalog = {
    git: async (cwd, args) => {
      calls.push(["git", cwd, args]);
      if (args[0] === "status") return "";
      if (args[0] === "rev-list") return "1\n";
      if (args[0] === "log") {
        const taskId = cwd.endsWith("task-one") ? "t1" : "t2";
        return `Finish task\n\nCmux-Goal-Ready: plan-12345678/${taskId}\n`;
      }
      if (args[0] === "ls-remote") {
        if (!secondPushed && cwd.endsWith("task-two")) return "";
        return `${cwd.endsWith("task-one") ? TASK_ONE : TASK_TWO}\t${args[2]}\n`;
      }
      if (args[0] === "rev-parse" && cwd.endsWith("task-one")) return `${TASK_ONE}\n`;
      if (args[0] === "rev-parse" && cwd.endsWith("task-two")) return `${TASK_TWO}\n`;
      return "";
    },
  };
  const worktrees = {
    create: async (repositoryId, options) => {
      calls.push(["create", repositoryId, options]);
      return { branchCreated: true, worktree: { path: integrationPath, branch: options.branch } };
    },
    snapshot: async () => ({ repositories: [] }),
  };
  const execute = async (bin, args, options) => {
    calls.push([bin, args, options]);
    if (bin === "gh" && args[1] === "view") {
      if (!pullRequest) throw new Error("no pull request found");
      return { stdout: JSON.stringify(pullRequest) };
    }
    return { stdout: "" };
  };
  const cmux = {
    workspaceCreate: async (options) => { calls.push(["workspaceCreate", options]); return { workspace_id: "workspace-merge" }; },
    rpc: async (method, params) => { calls.push(["rpc", method, params]); return {}; },
    notify: async (workspaceId, body) => { calls.push(["notify", workspaceId, body]); return {}; },
  };
  const groups = {
    ensure: async (...args) => { calls.push(["ensure", ...args]); if (groupsFail) throw new Error("cmux is down"); return "group-1"; },
    rename: async (...args) => { calls.push(["rename", ...args]); if (groupsFail) throw new Error("cmux is down"); return true; },
  };
  const integrator = new GoalIntegrator({ store, worktrees, repoCatalog, cmux, groups, execute, settleMs: 1 });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, integrator, calls, integrationPath };
}
```

- [ ] **Step 2: Write the failing behaviour tests**

Add these directly after the fixture, replacing the three old tests:

```javascript
test("launches one merge agent in a fresh goal worktree when every branch is ready", async (t) => {
  const { store, integrator, calls, integrationPath } = fixture(t);
  const result = await integrator.assemble("plan-12345678");
  assert.equal(result.deliveryStatus, "assembling");
  assert.equal(result.mergeStatus, "running");
  assert.equal(calls.filter((call) => call[0] === "create").length, 1);
  const created = calls.find((call) => call[0] === "workspaceCreate")[1];
  assert.equal(created.cwd, integrationPath);
  assert.equal(created.agent, "claude");
  assert.ok(created.prompt.includes(TASK_ONE));
  assert.ok(created.prompt.includes(TASK_TWO));
  assert.equal(calls.some((call) => call[0] === "git" && call[2][0] === "merge"), false);
  assert.equal(calls.some((call) => call[0] === "git" && call[2][0] === "push"), false);
  assert.equal(calls.some((call) => call[0] === "gh" && call[1][1] === "create"), false);
  assert.equal(store.get("plan-12345678").mergeWorkspaceId, "workspace-merge");
});

test("does not launch a second merge agent while one is already running", async (t) => {
  const { integrator, calls } = fixture(t);
  await integrator.assemble("plan-12345678");
  await integrator.assemble("plan-12345678");
  assert.equal(calls.filter((call) => call[0] === "workspaceCreate").length, 1);
});

test("waits without creating a goal worktree until every task branch is pushed", async (t) => {
  const { store, integrator, calls } = fixture(t, { secondPushed: false });
  await assert.rejects(() => integrator.assemble("plan-12345678"), /Waiting for 1 task branch/);
  assert.equal(calls.filter((call) => call[0] === "create").length, 0);
  assert.equal(calls.some((call) => call[0] === "workspaceCreate"), false);
  assert.equal(store.get("plan-12345678").tasks[0].deliveryStatus, "ready");
  assert.equal(store.get("plan-12345678").tasks[1].deliveryStatus, "pending");
});

test("records the final pull request when the merge agent stops and a pull request exists", async (t) => {
  const { store, integrator } = fixture(t, { pullRequest: { number: 42, url: "https://github.test/pr/42" } });
  await integrator.assemble("plan-12345678");
  const result = await integrator.settle("plan-12345678");
  assert.equal(result.deliveryStatus, "pr_open");
  assert.equal(result.finalPrNumber, 42);
  const saved = store.get("plan-12345678");
  assert.equal(saved.finalPrUrl, "https://github.test/pr/42");
  assert.equal(saved.mergeStatus, "done");
});

test("blocks the plan when the merge agent stops without a pull request", async (t) => {
  const { store, integrator } = fixture(t);
  await integrator.assemble("plan-12345678");
  const result = await integrator.settle("plan-12345678");
  assert.equal(result.deliveryStatus, "blocked");
  assert.equal(result.mergeStatus, "blocked");
  const saved = store.get("plan-12345678");
  assert.match(saved.deliveryError, /workspace/i);
  assert.equal(saved.mergeWorkspaceId, "workspace-merge");
});

test("retries a blocked merge in the same workspace instead of opening a second one", async (t) => {
  const { integrator, calls } = fixture(t);
  await integrator.assemble("plan-12345678");
  await integrator.settle("plan-12345678");
  await integrator.assemble("plan-12345678");
  assert.equal(calls.filter((call) => call[0] === "workspaceCreate").length, 1);
  const sent = calls.filter((call) => call[0] === "rpc" && call[1] === "surface.send_text");
  assert.equal(sent.length, 1);
  assert.equal(sent[0][2].workspace_id, "workspace-merge");
  assert.match(sent[0][2].text, /Continue the merge/);
});

test("a cmux group failure never blocks the merge", async (t) => {
  const { store, integrator, calls } = fixture(t, { groupsFail: true });
  await integrator.assemble("plan-12345678");
  assert.equal(calls.filter((call) => call[0] === "workspaceCreate").length, 1);
  assert.equal(store.get("plan-12345678").mergeStatus, "running");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/goal-integrator.test.mjs`

Expected: FAIL with `integrator.settle is not a function`, and failures on the merge-agent assertions.

- [ ] **Step 4: Rewrite the integrator**

Replace the whole class body in `server/goal-integrator.mjs`. Delete `#integratedCommit`, the squash-merge loop, `qualityCommands`, `#pullRequest`, `pullRequestBody`, and `taskCommitMessage`. Keep `#refreshTaskHeads`, `#readyHead`, `#integrationWorktree`, `integrationBranch`, `parsePullRequest`, `conciseError`, and `oneLine` unchanged. Keep `mergePrompt` and `baseBranch` from Task 4.

Replace the constructor and add the new methods:

```javascript
export class GoalIntegrator {
  constructor({ store, worktrees, repoCatalog, cmux = null, groups = null, execute = null, log = null, settleMs = TASK_SETTLE_MS } = {}) {
    if (!store) throw new TypeError("A goal plan store is required");
    if (!worktrees) throw new TypeError("A worktree dashboard is required");
    if (!repoCatalog) throw new TypeError("A repository catalog is required");
    this.store = store;
    this.worktrees = worktrees;
    this.repoCatalog = repoCatalog;
    this.cmux = cmux;
    this.groups = groups;
    this.execute = execute || ((bin, args, options) => repoCatalog.execute(bin, args, options));
    this.log = log;
    this.settleMs = settleMs;
    this.locks = new Map();
    this.timers = new Map();
  }
```

Replace `scheduleWorkspace` so a Stop on the merge workspace settles instead of assembling:

```javascript
  scheduleWorkspace(workspaceId) {
    const merging = this.store.findPlanByMergeWorkspace?.(workspaceId);
    if (merging) return this.scheduleSettle(merging.planId);
    const found = this.store.findTaskByWorkspace(workspaceId);
    if (found?.plan) this.schedulePlan(found.plan.planId);
  }

  scheduleSettle(planId) {
    clearTimeout(this.timers.get(planId));
    const timer = setTimeout(() => {
      this.timers.delete(planId);
      this.settle(planId).catch((cause) => this.log?.warn?.({ err: cause, planId }, "merge settle failed"));
    }, this.settleMs);
    timer.unref?.();
    this.timers.set(planId, timer);
  }
```

Replace the body of `#assemble` after its guards. Everything from `try {` to the end of the method becomes:

```javascript
    try {
      // A merge already in flight owns this plan. Its own Stop hook settles it.
      if (plan.mergeStatus === "running") return deliveryResult(plan);
      // Without a cmux client there is no agent to merge with, and a half-made
      // worktree would be worse than a clear refusal.
      if (!this.cmux) throw new TypeError("Combined goal delivery needs a cmux connection");
      plan = await this.#integrationWorktree(plan);
      // A blocked merge keeps its worktree and its live session, so a retry
      // continues the partial merge instead of throwing that work away.
      if (plan.mergeWorkspaceId && plan.mergeStatus === "blocked") {
        const nudge = `Continue the merge. ${remaining(plan)}`;
        await this.cmux?.rpc("surface.send_text", { workspace_id: plan.mergeWorkspaceId, text: `${nudge}\n` });
        plan = this.store.recordMergeLaunched(plan.planId, plan.mergeWorkspaceId);
      } else {
        const created = await this.cmux.workspaceCreate({
          cwd: plan.integrationWorktreePath,
          title: oneLine(`Merge: ${plan.goal}`, 100),
          agent: "claude",
          prompt: mergePrompt(plan),
        });
        const workspaceId = created?.workspace_id || created?.workspaceId || created?.id || null;
        if (!workspaceId) throw new TypeError("cmux created the merge session but did not return its id");
        plan = this.store.recordMergeLaunched(plan.planId, workspaceId);
      }
      await this.#publish(plan, { workspaceId: plan.mergeWorkspaceId });
      return deliveryResult(plan);
    } catch (cause) {
      const message = conciseError(cause);
      this.store.recordDeliveryFailure(plan.planId, message);
      throw new TypeError(message);
    }
```

Add `settle` as a public method, beside `assemble`:

```javascript
  // The merge agent stopped. A pull request on the goal branch is the only
  // proof of success, so it is read rather than reported.
  async settle(planId) {
    const id = String(planId || "");
    if (this.locks.has(id)) return this.locks.get(id);
    const running = this.#settle(id).finally(() => this.locks.delete(id));
    this.locks.set(id, running);
    return running;
  }

  async #settle(planId) {
    const plan = this.store.get(planId);
    if (!plan || plan.mergeStatus !== "running") return plan ? deliveryResult(plan) : null;
    const found = await this.#openPullRequest(plan);
    if (found) {
      const settled = this.store.recordFinalPr(plan.planId, { ...found, verifiedAt: new Date().toISOString() });
      await this.#publish(settled);
      return deliveryResult(settled);
    }
    const blocked = this.store.recordMergeBlocked(
      plan.planId,
      "The merge agent stopped without opening a pull request. Open its cmux workspace to read what blocked it, then retry.",
    );
    await this.#publish(blocked);
    return deliveryResult(blocked);
  }

  async #openPullRequest(plan) {
    return this.#run("gh", ["pr", "view", plan.integrationBranch, "--json", "number,url"], {
      cwd: plan.integrationWorktreePath, timeout: 20_000,
    }).then(({ stdout }) => parsePullRequest(stdout), () => null);
  }
```

- [ ] **Step 5: Add the store lookup the Stop hook needs**

In `server/worktree-plan-store.mjs`, add this beside `findTaskByWorkspace`:

```javascript
  findPlanByMergeWorkspace(workspaceIdValue) {
    const id = text(workspaceIdValue);
    if (!id) return null;
    const row = this.db.prepare(
      "SELECT plan_id FROM plans WHERE merge_workspace_id = ? AND merge_status = 'running' LIMIT 1",
    ).get(id);
    return row ? this.get(row.plan_id) : null;
  }
```

- [ ] **Step 6: Extend the delivery result**

In `server/goal-integrator.mjs`, add three fields to `deliveryResult(plan)`, after `verifiedAt`:

```javascript
    mergeStatus: plan.mergeStatus,
    mergeWorkspaceId: plan.mergeWorkspaceId,
    deliveryError: plan.deliveryError,
```

- [ ] **Step 7: Add the `remaining` helper**

At module scope in `server/goal-integrator.mjs`:

```javascript
// A retry prompt is a nudge, not the contract again. The agent still has the
// full brief in its own session.
function remaining(plan) {
  const unmerged = plan.tasks
    .filter((task) => task.launchStatus === "launched" && task.headSha)
    .map((task) => `${task.branch} at ${task.headSha.slice(0, 8)}`)
    .join(", ");
  return unmerged
    ? `Check this branch's log for the Cmux-Goal-Task trailers, merge whatever is still missing from: ${unmerged}, then verify and open the pull request.`
    : "Verify this branch and open the pull request.";
}
```

- [ ] **Step 8: Settle a merge that finished while the server was down**

`attach()` sweeps every active combined plan at startup, and `activeCombinedPlans()` returns any plan with no final pull request. A merge whose agent stopped during a restart would otherwise stay `running` for ever, because its Stop event is gone. In `attach()`, change the startup timer body from:

```javascript
      for (const plan of this.store.activeCombinedPlans()) this.schedulePlan(plan.planId);
```

to:

```javascript
      for (const plan of this.store.activeCombinedPlans()) {
        // A merge left running across a restart lost its Stop event, so check
        // for its pull request rather than waiting for an event that is gone.
        if (plan.mergeStatus === "running") this.scheduleSettle(plan.planId);
        else this.schedulePlan(plan.planId);
      }
```

- [ ] **Step 9: Add a temporary no-op `#publish`**

Task 6 fills it in. For now, so this task's tests pass on their own, add:

```javascript
  async #publish() { /* Task 6 fills this in */ }
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `node --test tests/goal-integrator.test.mjs`

Expected: PASS, all 9 tests.

- [ ] **Step 11: Run the whole server suite**

Run: `npm test`

Expected: PASS. `tests/api.test.mjs` exercises the assemble route with an injected integrator, so it should be unaffected. If it fails because it asserts on `pr_open`, update that assertion to `assembling` and to a `workspaceCreate` call.

- [ ] **Step 12: Commit**

```bash
git add server/goal-integrator.mjs server/worktree-plan-store.mjs tests/goal-integrator.test.mjs tests/api.test.mjs
git commit -m "feat: merge a multi-task goal with a cmux agent instead of git subprocesses"
```

---

## Task 6: Publish progress to every surface

**Files:**
- Modify: `server/goal-integrator.mjs`
- Test: `tests/goal-integrator.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `tests/goal-integrator.test.mjs`:

```javascript
test("renames the goal group with the counter and notifies at the three milestones", async (t) => {
  const { integrator, calls } = fixture(t, { pullRequest: { number: 42, url: "https://github.test/pr/42" } });
  await integrator.assemble("plan-12345678");
  await integrator.settle("plan-12345678");
  const names = calls.filter((call) => call[0] === "rename").map((call) => call[2]);
  assert.ok(names.some((name) => name.includes("merging")));
  assert.ok(names.some((name) => name.includes("PR #42")));
  const notices = calls.filter((call) => call[0] === "notify").map((call) => call[2].title);
  assert.equal(notices.length, 2);
  assert.ok(notices.some((title) => /merg/i.test(title)));
  assert.ok(notices.some((title) => /pull request/i.test(title)));
});

test("names a counting group with the ready count over the launched count", async (t) => {
  const { integrator, calls } = fixture(t, { secondPushed: false });
  await assert.rejects(() => integrator.assemble("plan-12345678"), /Waiting for 1 task branch/);
  assert.deepEqual(calls.filter((call) => call[0] === "rename").map((call) => call[2]), ["Ship combined billing — 1/2"]);
});

test("a notification failure never blocks the merge", async (t) => {
  const { store, integrator } = fixture(t, { pullRequest: { number: 42, url: "https://github.test/pr/42" } });
  integrator.cmux.notify = async () => { throw new Error("cmux is down"); };
  await integrator.assemble("plan-12345678");
  await integrator.settle("plan-12345678");
  assert.equal(store.get("plan-12345678").finalPrNumber, 42);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/goal-integrator.test.mjs`

Expected: FAIL. No `rename` or `notify` call is recorded, because `#publish` is a no-op.

- [ ] **Step 3: Replace the no-op `#publish`**

In `server/goal-integrator.mjs`, replace `async #publish() {}` with:

```javascript
  // One function drives every surface, and it runs after the store commits.
  // A failed cmux call therefore cannot roll back a delivery transition, and
  // the next change re-sends the correct current count.
  async #publish(plan, { workspaceId = null } = {}) {
    const name = groupName(plan);
    if (plan.cmuxGroupId) await this.groups?.rename(plan.cmuxGroupId, name);
    else if (workspaceId && this.groups) {
      const groupId = await this.groups.ensure(name, workspaceId, { groupId: plan.cmuxGroupId });
      if (groupId) this.store.recordGroup(plan.planId, groupId);
    }
    const notice = milestone(plan);
    if (!notice) return;
    const target = plan.mergeWorkspaceId || plan.tasks.find((task) => task.workspaceId)?.workspaceId;
    if (!target) return;
    try { await this.cmux?.notify(target, notice); }
    catch (cause) { this.log?.warn?.({ err: cause, planId: plan.planId }, "goal notification failed"); }
  }
```

Note the `catch` on the notify call only. `groups.rename` and `groups.ensure` already swallow their own failures, as Task 3 guarantees.

- [ ] **Step 4: Add the naming and milestone helpers**

At module scope in `server/goal-integrator.mjs`:

```javascript
export function readyCount(plan) {
  const launched = plan.tasks.filter((task) => task.launchStatus === "launched");
  const ready = launched.filter((task) => task.deliveryStatus === "ready" || task.deliveryStatus === "integrated");
  return { ready: ready.length, total: launched.length };
}

function groupName(plan) {
  const goal = oneLine(plan.goal, 48);
  if (plan.finalPrNumber) return `${goal} — PR #${plan.finalPrNumber}`;
  if (plan.mergeStatus === "blocked") return `${goal} — blocked`;
  if (plan.mergeStatus === "running") return `${goal} — merging`;
  const { ready, total } = readyCount(plan);
  return `${goal} — ${ready}/${total}`;
}

// Three notifications only. A chatty agent stops many times, so a per-task
// notice would be noise on a five-task goal.
function milestone(plan) {
  if (plan.finalPrNumber) {
    return { title: `Pull request #${plan.finalPrNumber} is open`, body: oneLine(plan.goal, 200) };
  }
  if (plan.mergeStatus === "blocked") {
    return { title: "The goal merge is blocked", body: oneLine(plan.deliveryError || plan.goal, 200) };
  }
  if (plan.mergeStatus === "running") {
    const { total } = readyCount(plan);
    return { title: `Merging ${total} task branch${total === 1 ? "" : "es"}`, body: oneLine(plan.goal, 200) };
  }
  return null;
}
```

- [ ] **Step 5: Publish the counter while tasks are still landing**

`#refreshTaskHeads` is where the count changes. At the end of `#assemble`'s readiness phase, publish before the pending check throws. In `#assemble`, change:

```javascript
    plan = await this.#refreshTaskHeads(plan);
    const pending = plan.tasks.filter(...);
```

to:

```javascript
    plan = await this.#refreshTaskHeads(plan);
    await this.#publish(plan);
    const pending = plan.tasks.filter(...);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/goal-integrator.test.mjs`

Expected: PASS, all 12 tests.

- [ ] **Step 7: Commit**

```bash
git add server/goal-integrator.mjs tests/goal-integrator.test.mjs
git commit -m "feat: publish goal progress to the cmux group name and notifications"
```

---

## Task 7: Group every launched workspace

**Files:**
- Modify: `server/worktree-planner.mjs:392-440`
- Modify: `server/app.mjs:60-90`, `server/app.mjs:247-262`, `server/app.mjs:295-315`
- Test: `tests/worktree-planner.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `tests/worktree-planner.test.mjs`. Match that file's own fixture construction; the assertions below are what matters.

```javascript
test("puts a multi-task goal's workspaces in a goal group and a single task in the project group", async (t) => {
  const grouped = [];
  const groups = { ensure: async (name, workspaceId) => { grouped.push([name, workspaceId]); return "group-1"; }, rename: async () => true };
  const planner = plannerFixture(t, { groups, tasks: 2 });
  await planner.launch(planner.planId);
  assert.equal(grouped.length, 2);
  assert.ok(grouped.every(([name]) => name.startsWith("Ship it")));

  const solo = plannerFixture(t, { groups, tasks: 1 });
  grouped.length = 0;
  await solo.launch(solo.planId);
  assert.deepEqual(grouped.map(([name]) => name), ["sample"]);
});

test("a group failure never fails a task launch", async (t) => {
  const groups = { ensure: async () => { throw new Error("cmux is down"); }, rename: async () => true };
  const planner = plannerFixture(t, { groups, tasks: 2 });
  const result = await planner.launch(planner.planId);
  assert.equal(result.launched, 2);
});
```

`plannerFixture` is the helper this plan expects you to extract from the existing repeated setup in `tests/worktree-planner.test.mjs`. It takes `{ groups, tasks }`, builds a `WorktreePlanner` with fake `worktrees` and `cmux`, seeds a ready draft whose goal is `Ship it` in repository `sample`, and returns the planner with its `planId` attached. Extract it as its own step before writing these tests if the file has no such helper yet.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/worktree-planner.test.mjs`

Expected: FAIL. Nothing calls `groups.ensure`.

- [ ] **Step 3: Accept the groups service in the planner**

In `server/worktree-planner.mjs`, add `groups = null` to the constructor options and assign `this.groups = groups;` beside `this.cmux = cmux;`.

- [ ] **Step 4: Group each launched workspace**

In `#launchTask`, after the `workspaceCreate` call and before the `return`, add:

```javascript
      // Grouping is presentation. It runs after the workspace exists and it
      // never fails the launch, so a cmux without groups still delivers.
      await this.#group(draft, workspace);
```

Then add the method to the class:

```javascript
  // A multi-task goal owns its own group. Every other workspace joins the
  // shared group for its repository, so a dashboard session lands there too.
  async #group(draft, workspace) {
    if (!this.groups) return;
    const id = workspace?.workspace_id || workspace?.workspaceId || workspace?.id;
    if (!id) return;
    const multi = draft.tasks.length > 1;
    const name = multi ? oneLine(draft.goal, 48) : draft.repositoryName || "";
    if (!name) return;
    const stored = multi ? this.#read(() => this.store?.get(draft.planId))?.cmuxGroupId : null;
    const groupId = await this.groups.ensure(name, id, { groupId: stored || null });
    if (multi && groupId) this.#persist(() => this.store?.recordGroup(draft.planId, groupId), draft.planId, "group");
  }
```

`oneLine` already exists in this module. If it does not, add the same three-line helper used in `server/goal-integrator.mjs`.

- [ ] **Step 5: Build and inject the service**

In `server/app.mjs`, add the import beside the others:

```javascript
import { CmuxGroups } from "./cmux-groups.mjs";
```

Then, directly after the `worktrees` line at `server/app.mjs:69`:

```javascript
  const groups = cmuxGroups || new CmuxGroups({ cmux, log: app.log });
```

Add `cmuxGroups = null` to `buildApp`'s destructured options, beside `goalIntegrator`.

Pass it into both constructors:

```javascript
  const planner = worktreePlanner
    || new WorktreePlanner({ worktrees, cmux, accountUsage, log: app.log, store: planStore, groups });
  const integrator = goalIntegrator
    || (planStore ? new GoalIntegrator({ store: planStore, worktrees, repoCatalog, cmux, groups, log: app.log }) : null);
```

- [ ] **Step 6: Group the two dashboard session routes**

In `server/app.mjs`, in the `POST /api/workspaces` handler, after `const created = await cmux.workspaceCreate({...});`:

```javascript
    await groups.ensure(repo.name, created.workspace_id);
```

In the `POST /api/worktree-dashboard/:id/launch` handler, after its `workspaceCreate` call:

```javascript
    await groups.ensure(target.repoName, created.workspace_id);
```

Both are safe without a `try`, because `ensure` swallows its own failures.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/worktree-planner.test.mjs tests/api.test.mjs`

Expected: PASS.

- [ ] **Step 8: Run the whole server suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/worktree-planner.mjs server/app.mjs tests/worktree-planner.test.mjs
git commit -m "feat: group goal workspaces and single sessions in cmux"
```

---

## Task 8: Show the counter and the task rows

**Files:**
- Modify: `app/worktree-planner.tsx:10-14`, `app/worktree-planner.tsx:232`, `app/worktree-planner.tsx:252-257`
- Modify: `app/features.css:131`
- Test: `tests/ui-features.test.tsx:536-558`

- [ ] **Step 1: Write the failing test**

Add this to `tests/ui-features.test.tsx`, beside the existing combined-delivery test:

```javascript
test("counts ready task branches and lists each task's delivery state", async () => {
  const now = new Date().toISOString();
  const summary = { planId: "plan-count", repositoryId: "repo-1", repositoryName: "companion", goal: "Ship together", status: "launched", stage: "ready", deliveryMode: "combined", deliveryStatus: "assembling", round: 2, taskCount: 3, launchedCount: 3, createdAt: now, updatedAt: now, launchedAt: now };
  const draft = {
    ...readyDraft, planId: "plan-count", repositoryName: "companion", goal: summary.goal,
    planStatus: "launched", deliveryMode: "combined", deliveryStatus: "assembling",
    createdAt: now, updatedAt: now, launchedAt: now,
    tasks: [
      { id: "t1", title: "API", branch: "feature/api", prompt: "Do", agent: "claude", agentReason: "", launchStatus: "launched", deliveryStatus: "ready" },
      { id: "t2", title: "UI", branch: "feature/ui", prompt: "Do", agent: "claude", agentReason: "", launchStatus: "launched", deliveryStatus: "pending" },
      { id: "t3", title: "Docs", branch: "feature/docs", prompt: "Do", agent: "claude", agentReason: "", launchStatus: "launched", deliveryStatus: "integrated" },
    ],
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("?repositoryId=")) return new Response(JSON.stringify({ plans: [summary] }), { status: 200 });
    if (url.endsWith("/plan-count")) return new Response(JSON.stringify(draft), { status: 200 });
    return new Response(JSON.stringify({ error: "Unexpected request" }), { status: 400 });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<WorktreePlannerSheet repository={repository} onClose={() => {}} onLaunched={async () => {}} onNotice={() => {}} />);

  await userEvent.click(await screen.findByRole("button", { name: "View Ship together" }));
  assert.ok(await screen.findByText("2 of 3 branches ready"));
  const rows = screen.getByRole("list", { name: "Task delivery" });
  assert.ok(within(rows).getByText("API"));
  assert.ok(within(rows).getByText("Waiting"));
  assert.ok(within(rows).getByText("Merged"));
});
```

Add `within` to the `@testing-library/react` import at the top of the file if it is not there.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --config vitest.config.ts -t "counts ready task branches"`

Expected: FAIL. No element matches `2 of 3 branches ready`.

- [ ] **Step 3: Extend the task type**

In `app/worktree-planner.tsx:8`, change:

```typescript
export type PlanTask = { id: string; title: string; branch: string; prompt: string; agent: PlanAgent; agentReason: string };
```

to:

```typescript
export type PlanTask = { id: string; title: string; branch: string; prompt: string; agent: PlanAgent; agentReason: string; launchStatus?: string; deliveryStatus?: string };
```

- [ ] **Step 4: Add the counter and row helpers**

Add these beside `deliveryLabel` at the bottom of `app/worktree-planner.tsx`:

```typescript
function readyCount(tasks: PlanTask[]) {
  const launched = tasks.filter((task) => task.launchStatus === "launched");
  const ready = launched.filter((task) => task.deliveryStatus === "ready" || task.deliveryStatus === "integrated");
  return { ready: ready.length, total: launched.length };
}

function taskState(task: PlanTask) {
  if (task.launchStatus && task.launchStatus !== "launched") return "Not launched";
  if (task.deliveryStatus === "integrated") return "Merged";
  if (task.deliveryStatus === "ready") return "Ready";
  return "Waiting";
}
```

- [ ] **Step 5: Render them**

In `app/worktree-planner.tsx:232`, inside the `planner-delivery-status` section, insert directly after the `<strong>` element and before the `integrationBranch` code element:

```tsx
{draft.tasks.length > 0 && <>
  <p className="planner-delivery-count">{readyCount(draft.tasks).ready} of {readyCount(draft.tasks).total} branches ready</p>
  <ul className="planner-delivery-tasks" aria-label="Task delivery">{draft.tasks.map((task) => <li key={task.id}>
    <span>{task.title}</span><code>{task.branch}</code><em className={`delivery-${taskState(task).toLowerCase().replace(/\s+/g, "-")}`}>{taskState(task)}</em>
  </li>)}</ul>
</>}
```

- [ ] **Step 6: Add the styles**

Append to the existing `.worktree-planner-sheet .planner-delivery-status` rule block in `app/features.css:131`:

```css
.worktree-planner-sheet .planner-delivery-count{margin:0;color:#c6dcff;font:9px/1.4 -apple-system,sans-serif;font-weight:700}.worktree-planner-sheet .planner-delivery-tasks{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none}.worktree-planner-sheet .planner-delivery-tasks li{display:grid;grid-template-columns:1fr auto;gap:2px 8px;align-items:baseline}.worktree-planner-sheet .planner-delivery-tasks span{color:#dbe6f4;font-size:9px}.worktree-planner-sheet .planner-delivery-tasks code{grid-column:1;color:#7f93ab;font-size:8px;overflow-wrap:anywhere}.worktree-planner-sheet .planner-delivery-tasks em{grid-row:1;grid-column:2;font-size:8px;font-style:normal;font-weight:700}.worktree-planner-sheet .planner-delivery-tasks .delivery-waiting{color:#93a2b2}.worktree-planner-sheet .planner-delivery-tasks .delivery-ready{color:#9fc4ff}.worktree-planner-sheet .planner-delivery-tasks .delivery-merged{color:var(--lime)}.worktree-planner-sheet .planner-delivery-tasks .delivery-not-launched{color:#e0796b}
```

- [ ] **Step 7: Update the delivery label for the merge states**

In `deliveryLabel`, change the `assembling` line so it reads as an agent running, not a subprocess:

```typescript
function deliveryLabel(status?: string) {
  if (status === "assembling") return "A merge agent is assembling this goal";
  if (status === "blocked") return "Combined delivery needs attention";
  if (status === "pr_open") return "Combined PR ready";
  return "Waiting for task branches";
}
```

The existing test at `tests/ui-features.test.tsx:554` asserts on the `blocked` label, which does not change.

- [ ] **Step 8: Run the UI tests to verify they pass**

Run: `npm run test:ui`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add app/worktree-planner.tsx app/features.css tests/ui-features.test.tsx
git commit -m "feat: show the ready branch count and each task's delivery state"
```

---

## Task 9: Update the README and run the full gate

**Files:**
- Modify: `README.md:96`

- [ ] **Step 1: Find the paragraph that describes combined delivery**

Run: `grep -n "combined" README.md`

- [ ] **Step 2: Replace the description of how a combined goal is delivered**

The current text says the companion assembles the branches and runs the verification gate itself. Replace that sentence with:

```markdown
When every task branch is committed and pushed, Companion cuts one goal branch from the base and starts a single Claude session in it. That agent squash-merges each pinned task commit, resolves the conflicts it can, runs the repository's own verification, and opens one pull request. It stops and asks when two tasks genuinely disagree, and the goal's cmux workspace group carries the live count of ready branches.
```

- [ ] **Step 3: Run the full verification gate**

Run: `npm run verify`

Expected: PASS. This runs `npm test`, `npm run test:ui`, `npm run lint`, `npm run typecheck`, and `npm run build`.

- [ ] **Step 4: Fix whatever it reports**

Do not skip a failure. Do not add a lint suppression to pass this step.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: describe the agent-driven combined goal merge"
```

---

## Deliberately not built

The spec lists a CMUX progress bar through `cmux set-progress <fraction> --label "2/5"` as optional polish. It is not in this plan. `set-progress` is a CLI command with no RPC method, so it needs a second code path through `CmuxClient.run` for a surface that duplicates the group name. Build it only after the group counter proves useful in daily use.

## Manual verification

The automated tests use fakes for cmux, so run this once against the real application before you consider the work done.

- [ ] Plan a goal with 2 small tasks in a scratch repository, and launch it.
- [ ] Confirm a workspace group appears in cmux, named for the goal, with `0/2`.
- [ ] Let one task agent finish. Confirm the group name becomes `1/2`, and confirm the planner panel shows `1 of 2 branches ready`.
- [ ] Let the second finish. Confirm a third workspace opens in the same group with the merge prompt, and confirm a notification arrives.
- [ ] Confirm the merge agent opens one pull request, and confirm the group name becomes `PR #N`.
- [ ] Start a `+ Session` from the dashboard for the same repository. Confirm it joins a group named for the repository.
