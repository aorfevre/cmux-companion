import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";

function memoryStore(t) {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  return store;
}

function seed(store, planId = "plan-1") {
  return store.createPlan({
    planId,
    repositoryId: "repository12345678",
    repositoryName: "sample",
    cwd: "/repo/sample",
    goal: "Add billing",
    images: [{ path: "/tmp/one.png", name: "one.png" }],
  });
}

const TASKS = [
  { id: "t1", title: "Billing", branch: "feature/billing", prompt: "Add billing.", agent: "claude", agentReason: "Claude · best account 90% left" },
  { id: "t2", title: "Invoices", branch: "feature/invoices", prompt: "Add invoices.", agent: "codex", agentReason: "Codex · best account 80% left" },
];

test("stores the opening goal with its images and a goal event", (t) => {
  const store = memoryStore(t);
  const plan = seed(store);
  assert.equal(plan.planId, "plan-1");
  assert.equal(plan.goal, "Add billing");
  assert.equal(plan.status, "draft");
  assert.equal(plan.stage, "questions");
  assert.equal(plan.round, 0);
  assert.deepEqual(plan.images, [{ path: "/tmp/one.png", name: "one.png" }]);
  assert.deepEqual(plan.tasks, []);
  const events = store.events("plan-1");
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "goal");
  assert.equal(events[0].payload.goal, "Add billing");
});

test("persists the planner engine for a resumed round", (t) => {
  const store = memoryStore(t);
  const plan = store.createPlan({
    planId: "configured-plan",
    repositoryId: "repository12345678",
    goal: "Add billing",
    engine: { provider: "codex", model: "gpt-5.6-sol", effort: "xhigh", reviewer: true },
  });
  assert.deepEqual(plan.engine, { provider: "codex", model: "gpt-5.6-sol", effort: "xhigh", reviewer: true });
  assert.deepEqual(store.events("configured-plan")[0].payload.engine, plan.engine);
});

test("stores GitHub issue provenance on detail, events, and summaries", (t) => {
  const store = memoryStore(t);
  const plan = store.createPlan({
    planId: "issue-plan", repositoryId: "repository12345678", goal: "Fix editor",
    sourceType: "github_issues", issueNumbers: [54, 55], issueUrls: ["https://github.test/issues/54", "https://github.test/issues/55"], deliveryPolicy: "combined",
  });
  assert.equal(plan.sourceType, "github_issues");
  assert.deepEqual(plan.issueNumbers, [54, 55]);
  assert.deepEqual(plan.issueUrls, ["https://github.test/issues/54", "https://github.test/issues/55"]);
  assert.equal(plan.deliveryPolicy, "combined");
  const ready = store.recordRound("issue-plan", { round: 1, stage: "ready", tasks: [{ id: "t1", title: "Only", branch: "feature/only", prompt: "Fix it", agent: "codex" }] });
  assert.equal(ready.deliveryMode, "combined");
  assert.equal(store.recordEdit("issue-plan", ready.tasks).deliveryMode, "combined");
  assert.deepEqual(store.list()[0].issueNumbers, [54, 55]);
  assert.deepEqual(store.events("issue-plan")[0].payload.issueNumbers, [54, 55]);
});

test("records a questions round with its session id", (t) => {
  const store = memoryStore(t);
  seed(store);
  const plan = store.recordRound("plan-1", {
    round: 1,
    stage: "questions",
    sessionId: "sess-a",
    questions: [{ id: "q1", text: "Which database?", options: ["Postgres"] }],
  });
  assert.equal(plan.round, 1);
  assert.equal(plan.sessionId, "sess-a");
  assert.equal(plan.questions[0].text, "Which database?");
  assert.deepEqual(store.events("plan-1").map((event) => event.kind), ["goal", "questions"]);
});

test("records submitted answers next to their question text", (t) => {
  const store = memoryStore(t);
  seed(store);
  store.recordRound("plan-1", { round: 1, stage: "questions", sessionId: "sess-a", questions: [{ id: "q1", text: "Which database?" }] });
  store.recordRound("plan-1", {
    round: 2,
    stage: "ready",
    sessionId: "sess-a",
    tasks: TASKS,
    answers: [{ id: "q1", question: "Which database?", text: "Postgres" }],
  });
  const events = store.events("plan-1");
  assert.deepEqual(events.map((event) => event.kind), ["goal", "questions", "answers", "tasks"]);
  const answers = events.find((event) => event.kind === "answers");
  assert.equal(answers.round, 2);
  assert.equal(answers.payload.answers[0].text, "Postgres");
  assert.equal(answers.payload.skipped, false);
});

test("records a skipped round with no answers", (t) => {
  const store = memoryStore(t);
  seed(store);
  store.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "sess-a", tasks: TASKS, skipped: true });
  const answers = store.events("plan-1").find((event) => event.kind === "answers");
  assert.equal(answers.payload.skipped, true);
  assert.deepEqual(answers.payload.answers, []);
});

test("stores a task list in order and reads it back whole", (t) => {
  const store = memoryStore(t);
  seed(store);
  const plan = store.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "sess-a", tasks: TASKS });
  assert.equal(plan.stage, "ready");
  assert.deepEqual(plan.tasks.map((task) => task.id), ["t1", "t2"]);
  assert.equal(plan.tasks[1].agent, "codex");
  assert.equal(plan.tasks[0].prompt, "Add billing.");
  assert.equal(plan.deliveryMode, "combined");
});

test("round-trips a Delivery Contract, workflow metadata, and task evidence", (t) => {
  const store = memoryStore(t);
  seed(store);
  const spec = {
    version: 2, outcome: "Customers can pay invoices", inScope: ["Billing"], nonGoals: ["Refunds"], constraints: ["Stable API"], assumptions: ["Sandbox available"],
    acceptanceCriteria: [{ id: "AC-1", text: "Invoice payment succeeds", verification: "npm test" }],
    risks: [{ text: "Provider outage", mitigation: "Retry", level: "medium" }],
  };
  const readiness = { ready: true, errors: [], warnings: ["One assumption remains"], waves: [["t1"]], coverage: [{ criterionId: "AC-1", taskIds: ["t1"] }] };
  const task = { ...TASKS[0], type: "backend", criterionIds: ["AC-1"], dependsOn: [], ownedAreas: ["server/**"], verification: ["npm test"], wave: 0 };
  store.recordRound("plan-1", { round: 1, stage: "ready", spec, readiness, tasks: [task] });
  store.recordLaunch("plan-1", { base: "origin/main", baseSha: "a".repeat(40), results: [{ id: "t1", status: "launched", path: "/repo/task", workspace: { workspace_id: "workspace-1" } }] });
  const report = { criteria: ["AC-1"], verification: [{ check: "npm test", status: "passed" }], limitations: ["Sandbox only"] };
  const plan = store.recordTaskReady("plan-1", "t1", "b".repeat(40), { report, changedFiles: ["server/billing.mjs", "README.md"], scopeWarnings: ["README.md"] });

  assert.equal(plan.contractVersion, 2);
  assert.deepEqual(plan.spec, spec);
  assert.deepEqual(plan.readiness, readiness);
  assert.equal(plan.tasks[0].type, "backend");
  assert.deepEqual(plan.tasks[0].criterionIds, ["AC-1"]);
  assert.deepEqual(plan.tasks[0].ownedAreas, ["server/**"]);
  assert.equal(plan.tasks[0].startSha, "a".repeat(40));
  assert.deepEqual(plan.tasks[0].completionReport, report);
  assert.deepEqual(plan.tasks[0].changedFiles, ["server/billing.mjs", "README.md"]);
  assert.deepEqual(plan.tasks[0].scopeWarnings, ["README.md"]);
  const events = store.events("plan-1");
  assert.deepEqual(events.find((event) => event.kind === "tasks").payload.spec, spec);
  assert.deepEqual(events.find((event) => event.kind === "tasks").payload.readiness, readiness);
  assert.ok(events.some((event) => event.kind === "task_evidence"));
});

test("a later round replaces the previous task list", (t) => {
  const store = memoryStore(t);
  seed(store);
  store.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "s", tasks: TASKS });
  const plan = store.recordRound("plan-1", {
    round: 2,
    stage: "ready",
    sessionId: "s",
    tasks: [{ id: "t1", title: "Only", branch: "feature/only", prompt: "Do it.", agent: "claude" }],
  });
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].branch, "feature/only");
});

test("records a user edit without changing the round", (t) => {
  const store = memoryStore(t);
  seed(store);
  store.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "s", tasks: TASKS });
  const plan = store.recordEdit("plan-1", [{ id: "t1", title: "Renamed", branch: "feature/renamed", prompt: "Add billing.", agent: "codex" }]);
  assert.equal(plan.round, 1);
  assert.equal(plan.stage, "ready");
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].title, "Renamed");
  assert.equal(store.events("plan-1").at(-1).kind, "edit");
});

test("records the launch outcome for each task", (t) => {
  const store = memoryStore(t);
  seed(store);
  store.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "s", tasks: TASKS });
  const plan = store.recordLaunch("plan-1", {
    base: "origin/main",
    results: [
      { id: "t1", status: "launched", path: "/repo/sample-billing", workspace: { workspace_id: "ws-1" } },
      { id: "t2", status: "failed", error: "Branch feature/invoices already exists" },
    ],
  });
  assert.equal(plan.status, "launched");
  assert.equal(plan.baseRef, "origin/main");
  assert.ok(plan.launchedAt);
  assert.equal(plan.tasks[0].launchStatus, "launched");
  assert.equal(plan.tasks[0].workspaceId, "ws-1");
  assert.equal(plan.tasks[0].worktreePath, "/repo/sample-billing");
  assert.equal(plan.tasks[1].launchStatus, "failed");
  assert.match(plan.tasks[1].launchError, /already exists/);
  assert.equal(store.events("plan-1").at(-1).payload.launched, 1);
});

test("tracks immutable task heads through one combined pull request", (t) => {
  const store = memoryStore(t);
  seed(store);
  store.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "s", tasks: TASKS });
  store.recordLaunch("plan-1", {
    base: "origin/main", baseSha: "a".repeat(40),
    results: TASKS.map((task, index) => ({ id: task.id, status: "launched", path: `/repo/task-${index}`, workspace: { workspace_id: `workspace-${index}` } })),
  });
  assert.equal(store.findTaskByWorkspace("workspace-1").task.id, "t2");
  store.recordTaskReady("plan-1", "t1", "b".repeat(40));
  store.recordTaskReady("plan-1", "t2", "c".repeat(40));
  store.recordIntegrationStarted("plan-1", { branch: "goal/billing-plan1", path: "/repo/goal" });
  store.recordTaskIntegrated("plan-1", "t1", "d".repeat(40));
  store.recordTaskIntegrated("plan-1", "t2", "e".repeat(40));
  const plan = store.recordFinalPr("plan-1", { number: 42, url: "https://github.test/pr/42", verifiedAt: "2026-09-01T12:00:00.000Z" });
  assert.equal(plan.deliveryMode, "combined");
  assert.equal(plan.deliveryStatus, "pr_open");
  assert.equal(plan.finalPrNumber, 42);
  assert.equal(plan.finalPrUrl, "https://github.test/pr/42");
  assert.deepEqual(plan.tasks.map((task) => task.deliveryStatus), ["integrated", "integrated"]);
  assert.deepEqual(store.events("plan-1").slice(-6).map((event) => event.kind), ["task_ready", "task_ready", "integration_started", "task_integrated", "task_integrated", "final_pr"]);
});

test("keeps a plan in draft when every task failed to launch", (t) => {
  const store = memoryStore(t);
  seed(store);
  store.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "s", tasks: TASKS });
  const plan = store.recordLaunch("plan-1", { base: "origin/main", results: [{ id: "t1", status: "failed", error: "cmux is down" }] });
  assert.equal(plan.status, "draft");
  assert.equal(plan.launchedAt, null);
});

test("rolls a whole round back when one of its writes fails", (t) => {
  const store = memoryStore(t);
  seed(store);
  store.recordRound("plan-1", { round: 1, stage: "questions", sessionId: "sess-a", questions: [{ id: "q1", text: "Which?" }] });
  const broken = { get id() { throw new Error("bad task"); }, title: "x", branch: "feature/x", prompt: "y" };
  assert.throws(() => store.recordRound("plan-1", { round: 2, stage: "ready", sessionId: "sess-b", tasks: [broken] }), /bad task/);
  const plan = store.get("plan-1");
  assert.equal(plan.round, 1);
  assert.equal(plan.sessionId, "sess-a");
  assert.equal(plan.stage, "questions");
  assert.equal(plan.tasks.length, 0);
  assert.deepEqual(store.events("plan-1").map((event) => event.kind), ["goal", "questions"]);
});

test("lists plans newest first and filters by repository", (t) => {
  const store = memoryStore(t);
  let tick = 0;
  store.now = () => new Date(1_700_000_000_000 + (tick += 1_000));
  seed(store, "plan-1");
  store.createPlan({ planId: "plan-2", repositoryId: "repositoryABCDEFGH", goal: "Other goal" });
  seed(store, "plan-3");
  const all = store.list();
  assert.deepEqual(all.map((plan) => plan.planId), ["plan-3", "plan-2", "plan-1"]);
  const mine = store.list({ repositoryId: "repository12345678" });
  assert.deepEqual(mine.map((plan) => plan.planId), ["plan-3", "plan-1"]);
});

test("the list carries a task count but no prompt", (t) => {
  const store = memoryStore(t);
  seed(store);
  store.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "s", tasks: TASKS });
  const [plan] = store.list();
  assert.equal(plan.taskCount, 2);
  assert.equal(plan.goal, "Add billing");
  assert.equal(plan.tasks, undefined);
});

test("filters the list by status", (t) => {
  const store = memoryStore(t);
  seed(store, "plan-1");
  seed(store, "plan-2");
  store.recordLaunch("plan-2", { base: "origin/main", results: [{ id: "t1", status: "launched" }] });
  assert.deepEqual(store.list({ status: "draft" }).map((plan) => plan.planId), ["plan-1"]);
  assert.deepEqual(store.list({ status: "launched" }).map((plan) => plan.planId), ["plan-2"]);
  assert.equal(store.list({ status: "all" }).length, 2);
});

test("caps the list length", (t) => {
  const store = memoryStore(t);
  for (let index = 0; index < 5; index += 1) seed(store, `plan-${index}`);
  assert.equal(store.list({ limit: 2 }).length, 2);
});

test("deleting a plan removes its tasks and events", (t) => {
  const store = memoryStore(t);
  seed(store);
  store.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "s", tasks: TASKS });
  assert.equal(store.delete("plan-1"), true);
  assert.equal(store.get("plan-1"), null);
  assert.deepEqual(store.events("plan-1"), []);
  assert.equal(store.delete("plan-1"), false);
});

test("returns null for an unknown plan", (t) => {
  assert.equal(memoryStore(t).get("nope"), null);
});

test("rejects a round with an unknown stage", (t) => {
  const store = memoryStore(t);
  seed(store);
  assert.throws(() => store.recordRound("plan-1", { round: 1, stage: "elsewhere", tasks: [] }), /Unknown plan stage/);
  assert.equal(store.get("plan-1").round, 0);
});

test("survives a reopen of the same file and keeps mode 0600", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "plan-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "nested", "goal-plans.db");
  const first = new WorktreePlanStore({ path });
  seed(first);
  first.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "sess-a", tasks: TASKS });
  first.close();

  assert.equal(statSync(path).mode & 0o777, 0o600);
  const second = new WorktreePlanStore({ path });
  t.after(() => second.close());
  const plan = second.get("plan-1");
  assert.equal(plan.sessionId, "sess-a");
  assert.equal(plan.round, 1);
  assert.deepEqual(plan.tasks.map((task) => task.branch), ["feature/billing", "feature/invoices"]);
});

test("migrates a pre-contract database without losing legacy plans", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "legacy-plan-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "goal-plans.db");
  const first = new WorktreePlanStore({ path });
  seed(first);
  first.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "legacy-session", tasks: [TASKS[0]] });
  first.close();

  const legacy = new DatabaseSync(path);
  for (const column of ["contract_version", "spec", "readiness", "last_error", "last_error_at"]) legacy.exec(`ALTER TABLE plans DROP COLUMN ${column}`);
  for (const column of ["task_type", "criterion_ids", "depends_on", "owned_areas", "verification", "wave", "start_sha", "completion_report", "evidence_status", "evidence_error", "changed_files", "scope_warnings"]) {
    legacy.exec(`ALTER TABLE plan_tasks DROP COLUMN ${column}`);
  }
  legacy.close();

  const migrated = new WorktreePlanStore({ path });
  t.after(() => migrated.close());
  const plan = migrated.get("plan-1");
  assert.equal(plan.goal, "Add billing");
  assert.equal(plan.sessionId, "legacy-session");
  assert.equal(plan.contractVersion, 1);
  assert.equal(plan.spec, null);
  assert.equal(plan.tasks[0].title, "Billing");
  assert.equal(plan.tasks[0].type, "feature");
  assert.deepEqual(plan.tasks[0].criterionIds, []);
  assert.deepEqual(plan.tasks[0].changedFiles, []);
  assert.equal(plan.lastError, null);
  assert.equal(plan.lastErrorAt, null);
});

// A failed round is plan state, not a turn of the conversation, so it survives
// a reopen and is answered by the next round rather than accumulating.
test("stores a failed round and clears it on the next one", (t) => {
  const store = memoryStore(t);
  seed(store);
  assert.equal(store.get("plan-1").lastError, null);

  const failed = store.recordRoundFailure("plan-1", "The planner stopped answering: no output for 4 minutes. Try again");
  assert.match(failed.lastError, /no output for 4 minutes/);
  assert.ok(Date.parse(failed.lastErrorAt) > 0);
  assert.equal(store.list({ status: "all" })[0].lastError, failed.lastError);
  // A failure is not a round: it changes neither the round number nor the stage.
  assert.equal(failed.round, 0);
  assert.equal(failed.stage, "questions");
  // And it writes no event, because PLAN_EVENT_KINDS is a closed set.
  assert.equal(store.events("plan-1").length, 1);

  const cleared = store.recordRound("plan-1", { round: 1, stage: "questions", sessionId: "sess-a", questions: [{ id: "q1", text: "Which database?", options: [] }] });
  assert.equal(cleared.lastError, null);
  assert.equal(cleared.lastErrorAt, null);
});

test("truncates an over-long failure instead of storing it whole", (t) => {
  const store = memoryStore(t);
  seed(store);
  assert.equal(store.recordRoundFailure("plan-1", "x".repeat(5_000)).lastError.length, 2_000);
  assert.match(store.recordRoundFailure("plan-1", "").lastError, /planner round failed/);
});

test("records the cmux group, the merge workspace and a merge block", (t) => {
  const store = memoryStore(t);
  store.createPlan({ planId: "plan-groups", repositoryId: "repo-1", goal: "Ship it" });
  store.recordRound("plan-groups", {
    round: 1, stage: "ready", sessionId: "session",
    tasks: [
      { id: "t1", title: "One", branch: "feature/one", prompt: "Do", agent: "claude" },
      { id: "t2", title: "Two", branch: "feature/two", prompt: "Do", agent: "claude" },
    ],
  });

  assert.equal(store.recordGroup("plan-groups", "group-abc").cmuxGroupId, "group-abc");
  assert.equal(store.get("plan-groups").cmuxNoticeKey, null);
  assert.equal(store.recordNoticeKey("plan-groups", "merging").cmuxNoticeKey, "merging");
  assert.equal(store.recordNoticeKey("plan-groups", "pr:42").cmuxNoticeKey, "pr:42");

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
});


// A closed session must stay closed across a restart. Without a durable
// record, a reopened companion would ask cmux to close ids that are gone and
// would never know which sessions it had already retired.
test("persists retired goal sessions across a reopen", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "retired-plan-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "goal-plans.db");
  const first = new WorktreePlanStore({ path });
  seed(first);
  first.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "s", tasks: TASKS });
  first.recordLaunch("plan-1", {
    base: "origin/main", baseSha: "a".repeat(40),
    results: TASKS.map((task, index) => ({ id: task.id, status: "launched", path: `/repo/task-${index}`, workspace: { workspace_id: `workspace-${index}` } })),
  });
  first.recordMergeLaunched("plan-1", "workspace-merge");
  // A second merge agent supersedes the first, and a wave integration retires
  // the one that is running. Both ids must survive the columns being cleared.
  first.recordMergeLaunched("plan-1", "workspace-merge-2");
  first.recordWaveIntegrated("plan-1", 0);
  first.recordTaskIntegrated("plan-1", "t1", "d".repeat(40));
  assert.deepEqual(first.pendingSessionClosures("plan-1"), [
    { workspaceId: "workspace-0", taskId: "t1" },
    { workspaceId: "workspace-merge", taskId: null },
    { workspaceId: "workspace-merge-2", taskId: null },
  ]);
  first.recordSessionsRetired("plan-1", [
    { workspaceId: "workspace-0", taskId: "t1" },
    { workspaceId: "workspace-merge", taskId: null },
  ]);
  first.close();

  const second = new WorktreePlanStore({ path });
  t.after(() => second.close());
  assert.deepEqual(second.pendingSessionClosures("plan-1"), [{ workspaceId: "workspace-merge-2", taskId: null }]);
  const plan = second.get("plan-1");
  assert.ok(plan.tasks[0].sessionClosedAt);
  assert.equal(plan.tasks[1].sessionClosedAt, null);
  assert.deepEqual(plan.supersededMergeWorkspaces.map((entry) => entry.workspaceId), ["workspace-merge", "workspace-merge-2"]);
  assert.ok(second.events("plan-1").some((event) => event.kind === "session_retired"));
});

// An unintegrated task is still working, and the live merge session is the one
// the user is watching. Neither may be offered for closure.
test("offers no session for a task that is not integrated or for the live merge", (t) => {
  const store = memoryStore(t);
  seed(store);
  store.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "s", tasks: TASKS });
  store.recordLaunch("plan-1", {
    base: "origin/main",
    results: TASKS.map((task, index) => ({ id: task.id, status: "launched", path: `/repo/task-${index}`, workspace: { workspace_id: `workspace-${index}` } })),
  });
  store.recordMergeLaunched("plan-1", "workspace-merge");
  assert.deepEqual(store.pendingSessionClosures("plan-1"), []);
  // A resumed merge records the same id again, which continues the session
  // rather than replacing it.
  store.recordMergeLaunched("plan-1", "workspace-merge");
  assert.deepEqual(store.pendingSessionClosures("plan-1"), []);
});
