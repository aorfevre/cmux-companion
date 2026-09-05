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

const ALL_FALSE = { unitTests: false, e2eTests: false, edgeCases: false, refactorPass: false, screenMocks: false, flowcharts: false };
const ALL_TRUE = { unitTests: true, e2eTests: true, edgeCases: true, refactorPass: true, screenMocks: true, flowcharts: true };

test("round trips the six specification options through detail, list and the goal event", (t) => {
  const store = memoryStore(t);
  const plan = store.createPlan({
    planId: "rigor-plan",
    repositoryId: "repository12345678",
    goal: "Add billing",
    specOptions: ALL_TRUE,
  });
  assert.deepEqual(plan.specOptions, ALL_TRUE);
  assert.deepEqual(store.get("rigor-plan").specOptions, ALL_TRUE);
  assert.deepEqual(store.events("rigor-plan")[0].payload.specOptions, ALL_TRUE);
  assert.deepEqual(store.list().find((item) => item.planId === "rigor-plan").specOptions, ALL_TRUE);
});

test("stores a goal without specification options as all false", (t) => {
  const store = memoryStore(t);
  assert.deepEqual(seed(store).specOptions, ALL_FALSE);
  assert.deepEqual(store.events("plan-1")[0].payload.specOptions, ALL_FALSE);
  assert.deepEqual(store.list()[0].specOptions, ALL_FALSE);
});

const NO_REVIEW = { codeReview: false, reviewer: "claude" };
const WANTS_REVIEW = { codeReview: true, reviewer: "codex" };

test("round trips the review request through detail, list and the goal event", (t) => {
  const store = memoryStore(t);
  const plan = store.createPlan({
    planId: "review-plan",
    repositoryId: "repository12345678",
    goal: "Add billing",
    reviewOptions: WANTS_REVIEW,
  });
  assert.deepEqual(plan.reviewOptions, WANTS_REVIEW);
  assert.deepEqual(store.get("review-plan").reviewOptions, WANTS_REVIEW);
  assert.deepEqual(store.events("review-plan")[0].payload.reviewOptions, WANTS_REVIEW);
  assert.deepEqual(store.list().find((item) => item.planId === "review-plan").reviewOptions, WANTS_REVIEW);
});

test("stores a goal without a review request as no review", (t) => {
  const store = memoryStore(t);
  assert.deepEqual(seed(store).reviewOptions, NO_REVIEW);
  assert.deepEqual(store.events("plan-1")[0].payload.reviewOptions, NO_REVIEW);
  assert.deepEqual(store.list()[0].reviewOptions, NO_REVIEW);
});

test("reads a malformed stored review request as no review", (t) => {
  const store = memoryStore(t);
  seed(store);
  for (const stored of ["", "not json", "[]", '{"unknown":true}', '{"codeReview":"yes"}', '{"reviewer":"gemini"}']) {
    store.db.prepare("UPDATE plans SET review_options = ? WHERE plan_id = ?").run(stored, "plan-1");
    assert.deepEqual(store.get("plan-1").reviewOptions, NO_REVIEW, `stored value ${stored}`);
    assert.deepEqual(store.list()[0].reviewOptions, NO_REVIEW, `stored value ${stored}`);
  }
});

test("only the first caller claims a goal review", (t) => {
  const store = memoryStore(t);
  store.createPlan({ planId: "plan-1", repositoryId: "repository12345678", goal: "Add billing", reviewOptions: WANTS_REVIEW });

  // Two callers race for this: the integrator settling a combined goal, and
  // the merge watcher observing a single-task goal's pull request.
  const claimed = store.claimGoalReview("plan-1", { agent: "codex" });
  assert.equal(claimed.reviewStatus, "claiming");
  assert.equal(store.claimGoalReview("plan-1", { agent: "codex" }), null);
  assert.equal(store.events("plan-1").filter((event) => event.kind === "review_claimed").length, 1);

  const launched = store.recordReviewLaunched("plan-1", { workspaceId: "ws-9", agent: "codex", briefPath: "/tmp/review.md" });
  assert.equal(launched.reviewStatus, "running");
  assert.equal(launched.reviewWorkspaceId, "ws-9");
  assert.equal(launched.reviewBriefPath, "/tmp/review.md");
  assert.ok(launched.reviewLaunchedAt);
  assert.equal(store.list()[0].reviewStatus, "running");

  // A launched review is the terminal claim: no later pass may start a second.
  assert.equal(store.claimGoalReview("plan-1", { agent: "claude" }), null);
  const events = store.events("plan-1").filter((event) => event.kind === "review_launched");
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.workspaceId, "ws-9");
  assert.equal(events[0].payload.agent, "codex");
});

test("a claim that never became a session is released and can be retried", (t) => {
  const store = memoryStore(t);
  store.createPlan({ planId: "plan-1", repositoryId: "repository12345678", goal: "Add billing", reviewOptions: WANTS_REVIEW });
  store.claimGoalReview("plan-1", { agent: "codex" });

  assert.equal(store.releaseGoalReview("plan-1").reviewStatus, null);
  assert.ok(store.claimGoalReview("plan-1", { agent: "codex" }));

  // Releasing must never undo a review that really launched, or a crash in a
  // later pass would start a second reviewer on the same pull request.
  store.recordReviewLaunched("plan-1", { workspaceId: "ws-9", agent: "codex", briefPath: "/tmp/review.md" });
  const kept = store.releaseGoalReview("plan-1");
  assert.equal(kept.reviewStatus, "running");
  assert.equal(kept.reviewWorkspaceId, "ws-9");
});

test("records when the review session is closed", (t) => {
  const store = memoryStore(t);
  store.createPlan({ planId: "plan-1", repositoryId: "repository12345678", goal: "Add billing", reviewOptions: WANTS_REVIEW });
  store.claimGoalReview("plan-1", { agent: "claude" });
  store.recordReviewLaunched("plan-1", { workspaceId: "ws-9", agent: "claude", briefPath: "/tmp/review.md" });
  assert.equal(store.get("plan-1").reviewSessionClosedAt, null);
  assert.ok(store.recordReviewSessionClosed("plan-1").reviewSessionClosedAt);
});

test("reads malformed stored specification options as all false", (t) => {
  const store = memoryStore(t);
  seed(store);
  for (const stored of ["", "not json", "[]", '{"unknown":true}', '{"unitTests":"yes"}']) {
    store.db.prepare("UPDATE plans SET spec_options = ? WHERE plan_id = ?").run(stored, "plan-1");
    assert.deepEqual(store.get("plan-1").specOptions, ALL_FALSE, `stored value ${stored}`);
    assert.deepEqual(store.list()[0].specOptions, ALL_FALSE, `stored value ${stored}`);
  }
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

test("keeps follow-up launches in order and reports their count", (t) => {
  const store = memoryStore(t);
  seed(store);
  store.recordFollowupLaunched("plan-1", {
    workspaceId: "followup-1", actions: ["question"], agent: "claude",
    branch: "goal/billing", worktreePath: "/repo/goal", briefPath: "/briefs/followup-1.md",
  });
  store.recordFollowupLaunched("plan-1", {
    workspaceId: "followup-2", actions: ["tests", "review"], agent: "codex",
    branch: "goal/billing", worktreePath: "/repo/goal", briefPath: "/briefs/followup-2.md",
  });

  const plan = store.get("plan-1");
  assert.deepEqual(plan.followups.map((followup) => followup.workspaceId), ["followup-1", "followup-2"]);
  assert.deepEqual(plan.followups[1].actions, ["tests", "review"]);
  assert.equal(plan.followups[0].agent, "claude");
  assert.ok(plan.followups.every((followup) => followup.launchedAt));
  assert.equal(store.list()[0].followupCount, 2);
  const events = store.events("plan-1").filter((event) => event.kind === "followup_launched");
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.payload.workspaceId), ["followup-1", "followup-2"]);
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
  for (const column of ["contract_version", "spec", "readiness", "last_error", "last_error_at", "spec_options", "review_options", "review_workspace_id", "review_status", "review_brief_path", "review_launched_at", "review_session_closed_at"]) legacy.exec(`ALTER TABLE plans DROP COLUMN ${column}`);
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
  // A database that predates the column reads as no request at all, rather
  // than making every saved plan unreadable.
  assert.deepEqual(plan.specOptions, ALL_FALSE);
  assert.deepEqual(plan.reviewOptions, NO_REVIEW);
  assert.equal(plan.reviewStatus, null);
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

  const [summary] = store.list({ status: "all" });
  assert.equal(summary.deliveryError, "Two tasks disagree about the retry policy");
  assert.equal(summary.mergeStatus, "blocked");
  assert.equal(summary.mergeWorkspaceId, "workspace-merge");

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

// The retirement of the live merge session is plan-level state: it has no task
// row to stamp. A caller that names the kind decides which column moves.
test("records the live merge session and a superseded merge as retired", (t) => {
  const store = memoryStore(t);
  seed(store);
  store.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "s", tasks: TASKS });
  store.recordLaunch("plan-1", {
    base: "origin/main", baseSha: "a".repeat(40),
    results: TASKS.map((task, index) => ({ id: task.id, status: "launched", path: `/repo/task-${index}`, workspace: { workspace_id: `workspace-${index}` } })),
  });
  store.recordMergeLaunched("plan-1", "workspace-merge");
  store.recordMergeLaunched("plan-1", "workspace-merge-2");
  assert.equal(store.get("plan-1").mergeSessionClosedAt, null);

  // A task whose delivery status is still pending is retired all the same: the
  // reaper decides what is finished, and the store only records it.
  store.recordSessionsRetired("plan-1", [
    { workspaceId: "workspace-0", taskId: "t1", kind: "task" },
    { workspaceId: "workspace-merge", kind: "superseded" },
    { workspaceId: "workspace-merge-2", kind: "merge" },
  ]);

  const plan = store.get("plan-1");
  assert.equal(plan.tasks[0].deliveryStatus, "pending");
  assert.ok(plan.tasks[0].sessionClosedAt);
  assert.equal(plan.tasks[1].sessionClosedAt, null);
  assert.ok(plan.mergeSessionClosedAt);
  assert.deepEqual(plan.supersededMergeWorkspaces.map((entry) => Boolean(entry.retiredAt)), [true]);
  // The event keeps the shape every existing reader expects.
  const retired = store.events("plan-1").at(-1);
  assert.equal(retired.kind, "session_retired");
  assert.deepEqual(retired.payload.sessions, [
    { workspaceId: "workspace-0", taskId: "t1" },
    { workspaceId: "workspace-merge", taskId: null },
    { workspaceId: "workspace-merge-2", taskId: null },
  ]);
});

// A second retirement of the same merge session must not move the stamp. The
// first time it was closed is the durable answer.
test("keeps the first merge retirement stamp when the same session is recorded twice", (t) => {
  const store = memoryStore(t);
  seed(store);
  store.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "s", tasks: TASKS });
  store.recordMergeLaunched("plan-1", "workspace-merge");
  store.recordSessionsRetired("plan-1", [{ workspaceId: "workspace-merge", kind: "merge" }]);
  const first = store.get("plan-1").mergeSessionClosedAt;
  assert.ok(first);
  store.recordSessionsRetired("plan-1", [{ workspaceId: "workspace-merge", kind: "merge" }]);
  assert.equal(store.get("plan-1").mergeSessionClosedAt, first);
});

// An entry that names no kind is the shape the relaunch caller writes. A taskId
// still means a task, so that caller keeps working unchanged.
test("reads a retirement entry with no kind the way its original caller wrote it", (t) => {
  const store = memoryStore(t);
  seed(store);
  store.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "s", tasks: TASKS });
  store.recordLaunch("plan-1", {
    base: "origin/main", baseSha: "a".repeat(40),
    results: TASKS.map((task, index) => ({ id: task.id, status: "launched", path: `/repo/task-${index}`, workspace: { workspace_id: `workspace-${index}` } })),
  });
  store.recordMergeLaunched("plan-1", "workspace-merge");
  store.recordSessionsRetired("plan-1", [{ workspaceId: "workspace-0", taskId: "t1" }]);
  assert.ok(store.get("plan-1").tasks[0].sessionClosedAt);
  assert.equal(store.get("plan-1").mergeSessionClosedAt, null);
});

// The merge retirement column arrived after goals were already on disk. A
// database that predates it must open and read the field as null.
test("migrates a database that predates the merge retirement column", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "merge-retire-plan-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "goal-plans.db");
  const first = new WorktreePlanStore({ path });
  seed(first);
  first.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "s", tasks: TASKS });
  first.recordMergeLaunched("plan-1", "workspace-merge");
  first.close();

  const legacy = new DatabaseSync(path);
  legacy.exec("ALTER TABLE plans DROP COLUMN merge_session_closed_at");
  legacy.close();

  const migrated = new WorktreePlanStore({ path });
  t.after(() => migrated.close());
  const plan = migrated.get("plan-1");
  assert.equal(plan.goal, "Add billing");
  assert.equal(plan.mergeWorkspaceId, "workspace-merge");
  assert.equal(plan.mergeSessionClosedAt, null);
  assert.deepEqual(plan.tasks.map((task) => task.id), ["t1", "t2"]);

  // And the migrated database still accepts the write the column exists for.
  migrated.recordSessionsRetired("plan-1", [{ workspaceId: "workspace-merge", kind: "merge" }]);
  assert.ok(migrated.get("plan-1").mergeSessionClosedAt);
});

// The board columns arrived after goals were already on disk. A database that
// predates them must open, keep its plan, its tasks and its events, and read
// every new field as null.
test("migrates a database that predates the board columns", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "board-plan-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "goal-plans.db");
  const first = new WorktreePlanStore({ path });
  seed(first);
  first.recordRound("plan-1", { round: 1, stage: "ready", sessionId: "board-session", tasks: TASKS });
  first.close();

  const legacy = new DatabaseSync(path);
  for (const column of ["board_status", "board_changed_at", "board_pr_number", "board_pr_url", "board_pr_state", "board_pr_observed_at"]) {
    legacy.exec(`ALTER TABLE plans DROP COLUMN ${column}`);
  }
  legacy.close();

  const migrated = new WorktreePlanStore({ path });
  t.after(() => migrated.close());
  const plan = migrated.get("plan-1");
  assert.equal(plan.goal, "Add billing");
  assert.equal(plan.sessionId, "board-session");
  assert.deepEqual(plan.tasks.map((task) => task.id), ["t1", "t2"]);
  assert.equal(plan.boardStatus, null);
  assert.equal(plan.boardChangedAt, null);
  assert.equal(plan.boardPrNumber, null);
  assert.equal(plan.boardPrUrl, null);
  assert.equal(plan.boardPrState, null);
  assert.equal(plan.boardPrObservedAt, null);
  assert.deepEqual(migrated.events("plan-1").map((event) => event.kind), ["goal", "tasks"]);
  const [summary] = migrated.list();
  assert.equal(summary.boardStatus, null);
  assert.equal(summary.boardPrState, null);
});

test("migrates a database that predates durable follow-ups and records one", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "followup-plan-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "goal-plans.db");
  const first = new WorktreePlanStore({ path });
  seed(first);
  first.close();

  const legacy = new DatabaseSync(path);
  legacy.exec("ALTER TABLE plans DROP COLUMN followups");
  legacy.close();

  const migrated = new WorktreePlanStore({ path });
  t.after(() => migrated.close());
  assert.deepEqual(migrated.get("plan-1").followups, []);
  const recorded = migrated.recordFollowupLaunched("plan-1", {
    workspaceId: "followup-1", actions: ["custom"], agent: "codex",
    branch: "goal/billing", worktreePath: "/repo/goal", briefPath: "/briefs/followup-1.md",
  });
  assert.equal(recorded.followups[0].workspaceId, "followup-1");
  assert.equal(migrated.list()[0].followupCount, 1);
});

test("records an open pull request and only re-records a changed one", (t) => {
  const store = memoryStore(t);
  seed(store);
  const opened = store.recordGoalPullRequest("plan-1", {
    number: 7, url: "https://github.test/pr/7", state: "OPEN", observedAt: "2026-09-01T10:00:00.000Z",
  });
  assert.equal(opened.boardStatus, null);
  assert.equal(opened.boardPrNumber, 7);
  assert.equal(opened.boardPrUrl, "https://github.test/pr/7");
  assert.equal(opened.boardPrState, "OPEN");
  assert.equal(opened.boardPrObservedAt, "2026-09-01T10:00:00.000Z");
  const [summary] = store.list();
  assert.equal(summary.boardPrNumber, 7);
  assert.equal(summary.boardPrState, "OPEN");
  assert.equal(summary.boardStatus, null);

  // The same pull request seen again, only later. Nothing changed, so the goal
  // neither gains an event nor moves to the top of the list.
  const before = store.get("plan-1").updatedAt;
  const again = store.recordGoalPullRequest("plan-1", {
    number: 7, url: "https://github.test/pr/7", state: "OPEN", observedAt: "2026-09-01T11:00:00.000Z",
  });
  assert.equal(again.boardPrObservedAt, "2026-09-01T10:00:00.000Z");
  assert.equal(again.updatedAt, before);
  assert.equal(store.events("plan-1").filter((event) => event.kind === "board_pull_request").length, 1);

  const closed = store.recordGoalPullRequest("plan-1", { number: 7, url: "https://github.test/pr/7", state: "CLOSED" });
  assert.equal(closed.boardPrState, "CLOSED");
  assert.equal(closed.boardStatus, null);
  assert.equal(store.events("plan-1").filter((event) => event.kind === "board_pull_request").length, 2);
});

test("rejects a pull request state that GitHub never reports", (t) => {
  const store = memoryStore(t);
  seed(store);
  assert.throws(() => store.recordGoalPullRequest("plan-1", { state: "DRAFT" }), /Unknown pull request state/);
  assert.equal(store.get("plan-1").boardPrState, null);
  assert.equal(store.events("plan-1").length, 1);
});

test("a MERGED observation is terminal and never leaves the status null", (t) => {
  const store = memoryStore(t);
  seed(store);
  const merged = store.recordGoalPullRequest("plan-1", {
    number: 9, url: "https://github.test/pr/9", state: "MERGED", observedAt: "2026-09-02T08:00:00.000Z",
  });
  assert.equal(merged.boardStatus, "merged");
  assert.equal(merged.boardPrState, "MERGED");
  assert.equal(merged.boardPrNumber, 9);
  assert.ok(merged.boardChangedAt);
  assert.equal(merged.boardPrObservedAt, "2026-09-02T08:00:00.000Z");
  assert.equal(store.events("plan-1").filter((event) => event.kind === "board_merged").length, 1);

  // Repeating the same merge changes nothing and adds no second event.
  const repeated = store.recordGoalMerged("plan-1", { number: 9, url: "https://github.test/pr/9" });
  assert.equal(repeated.boardChangedAt, merged.boardChangedAt);
  assert.equal(store.events("plan-1").filter((event) => event.kind === "board_merged").length, 1);

  // A stale OPEN read arriving after the merge must not move the board back.
  const stale = store.recordGoalPullRequest("plan-1", { number: 9, url: "https://github.test/pr/9", state: "OPEN" });
  assert.equal(stale.boardStatus, "merged");
  assert.equal(stale.boardPrState, "MERGED");
  assert.equal(store.events("plan-1").filter((event) => event.kind === "board_pull_request").length, 0);
});

test("aborts a goal once and refuses to overwrite either terminal state", (t) => {
  const store = memoryStore(t);
  seed(store, "plan-abort");
  seed(store, "plan-merge");

  const aborted = store.recordGoalAborted("plan-abort", { reason: "The goal was replaced" });
  assert.equal(aborted.boardStatus, "aborted");
  assert.ok(aborted.boardChangedAt);
  assert.equal(store.events("plan-abort").filter((event) => event.kind === "board_aborted").length, 1);
  assert.equal(store.events("plan-abort").at(-1).payload.reason, "The goal was replaced");

  const repeated = store.recordGoalAborted("plan-abort");
  assert.equal(repeated.boardChangedAt, aborted.boardChangedAt);
  assert.equal(store.events("plan-abort").filter((event) => event.kind === "board_aborted").length, 1);

  // A merge that arrives after an abort leaves the aborted goal alone.
  const stillAborted = store.recordGoalMerged("plan-abort", { number: 3, url: "https://github.test/pr/3" });
  assert.equal(stillAborted.boardStatus, "aborted");
  assert.equal(stillAborted.boardPrNumber, null);
  assert.equal(store.events("plan-abort").filter((event) => event.kind === "board_merged").length, 0);
  assert.equal(store.recordGoalPullRequest("plan-abort", { number: 3, url: "https://github.test/pr/3", state: "OPEN" }).boardPrState, null);

  // And an abort that arrives after a merge leaves the merged goal alone.
  const merged = store.recordGoalMerged("plan-merge", { number: 4, url: "https://github.test/pr/4" });
  assert.equal(merged.boardStatus, "merged");
  const stillMerged = store.recordGoalAborted("plan-merge", { reason: "too late" });
  assert.equal(stillMerged.boardStatus, "merged");
  assert.equal(stillMerged.boardChangedAt, merged.boardChangedAt);
  assert.equal(store.events("plan-merge").filter((event) => event.kind === "board_aborted").length, 0);
});

test("returns null for a board transition on an unknown plan", (t) => {
  const store = memoryStore(t);
  assert.equal(store.recordGoalAborted("nope"), null);
  assert.equal(store.recordGoalMerged("nope"), null);
  assert.equal(store.recordGoalPullRequest("nope", { state: "OPEN" }), null);
});

// A terminal goal is finished work. Leaving it in the active lookups would let
// the integrator keep opening sessions for a goal the user already closed.
test("a terminal goal is no longer active work", (t) => {
  const store = memoryStore(t);
  for (const planId of ["plan-open", "plan-merged", "plan-aborted"]) {
    seed(store, planId);
    store.recordRound(planId, { round: 1, stage: "ready", sessionId: "s", tasks: TASKS });
    store.recordLaunch(planId, {
      base: "origin/main",
      results: TASKS.map((task, index) => ({ id: task.id, status: "launched", path: `/repo/${planId}-${index}`, workspace: { workspace_id: `${planId}-workspace-${index}` } })),
    });
    store.recordMergeLaunched(planId, `${planId}-merge`);
  }
  assert.deepEqual(store.activeCombinedPlans().map((plan) => plan.planId).sort(), ["plan-aborted", "plan-merged", "plan-open"]);

  store.recordGoalMerged("plan-merged", { number: 11, url: "https://github.test/pr/11" });
  store.recordGoalAborted("plan-aborted");

  assert.deepEqual(store.activeCombinedPlans().map((plan) => plan.planId), ["plan-open"]);
  assert.equal(store.findTaskByWorkspace("plan-open-workspace-0").task.id, "t1");
  assert.equal(store.findTaskByWorkspace("plan-merged-workspace-0"), null);
  assert.equal(store.findTaskByWorkspace("plan-aborted-workspace-0"), null);
  assert.equal(store.findPlanByMergeWorkspace("plan-open-merge").planId, "plan-open");
  assert.equal(store.findPlanByMergeWorkspace("plan-merged-merge"), null);
  assert.equal(store.findPlanByMergeWorkspace("plan-aborted-merge"), null);

  // Merge confirmation finishes delivery while preserving session associations.
  const merged = store.get("plan-merged");
  assert.equal(merged.status, "launched");
  assert.equal(merged.deliveryStatus, "pr_open");
  assert.equal(merged.mergeStatus, "done");
  assert.equal(merged.mergeWorkspaceId, "plan-merged-merge");
  assert.deepEqual(merged.tasks.map((task) => task.workspaceId), ["plan-merged-workspace-0", "plan-merged-workspace-1"]);
});

// --- one task starts again, or is dropped --------------------------------

// A launched plan with two tasks: t1 carries a full set of evidence, t2 is
// untouched. Every relaunch test below asserts against both, because the
// failure this writer exists to avoid is resetting the whole plan.
function launchedPair(store, planId = "plan-1") {
  seed(store, planId);
  store.recordRound(planId, { round: 1, stage: "ready", sessionId: "s", tasks: TASKS });
  store.recordLaunch(planId, {
    base: "origin/main", baseSha: "a".repeat(40),
    results: TASKS.map((task, index) => ({ id: task.id, status: "launched", path: `/repo/task-${index}`, workspace: { workspace_id: `workspace-${index}` } })),
  });
  return store.get(planId);
}

test("a relaunch clears every trace of the dead agent's run", (t) => {
  const store = memoryStore(t);
  launchedPair(store);
  const report = { criteria: ["AC-1"], verification: [{ check: "npm test", status: "passed" }] };
  store.recordTaskReady("plan-1", "t1", "b".repeat(40), { report, changedFiles: ["server/billing.mjs"], scopeWarnings: ["README.md"] });
  store.recordIntegrationStarted("plan-1", { branch: "goal/billing", path: "/repo/goal" });
  store.recordTaskIntegrated("plan-1", "t1", "d".repeat(40));
  store.recordSessionsRetired("plan-1", [{ workspaceId: "workspace-0", taskId: "t1" }]);

  const plan = store.recordTaskRelaunch("plan-1", "t1", {
    status: "launched", path: "/repo/task-0", workspace: { workspace_id: "workspace-new" }, startSha: "f".repeat(40),
  });
  const task = plan.tasks.find((item) => item.id === "t1");

  // The new session and its worktree are written.
  assert.equal(task.launchStatus, "launched");
  assert.equal(task.launchError, null);
  assert.equal(task.worktreePath, "/repo/task-0");
  assert.equal(task.workspaceId, "workspace-new");
  assert.equal(task.startSha, "f".repeat(40));

  // And every field the previous run produced is gone. A stale head or a stale
  // report would let the integrator merge work the new agent never wrote.
  assert.equal(task.headSha, null);
  assert.equal(task.deliveryStatus, "pending");
  assert.equal(task.completionReport, null);
  assert.equal(task.evidenceStatus, null);
  assert.equal(task.evidenceError, null);
  assert.deepEqual(task.changedFiles, []);
  assert.deepEqual(task.scopeWarnings, []);
  assert.equal(task.integratedCommitSha, null);
  assert.equal(task.sessionClosedAt, null);
});

// This is the whole reason the writer exists. `recordWaveLaunch` resets the
// plan's delivery state because a wave is a plan-wide transition; a relaunch is
// one task, and the sibling's evidence is the work the goal is waiting on.
test("a relaunch touches only the named task and leaves its siblings intact", (t) => {
  const store = memoryStore(t);
  launchedPair(store);
  const report = { criteria: ["AC-2"], verification: [{ check: "npm test -- invoices", status: "passed" }] };
  store.recordTaskReady("plan-1", "t2", "c".repeat(40), { report, changedFiles: ["server/invoices.mjs"], scopeWarnings: ["docs/api.md"] });

  store.recordTaskRelaunch("plan-1", "t1", { status: "launched", path: "/repo/task-0", workspace: { workspace_id: "workspace-new" } });

  const sibling = store.get("plan-1").tasks.find((item) => item.id === "t2");
  assert.equal(sibling.headSha, "c".repeat(40));
  assert.equal(sibling.deliveryStatus, "ready");
  assert.equal(sibling.evidenceStatus, "ready");
  assert.deepEqual(sibling.completionReport, report);
  assert.deepEqual(sibling.changedFiles, ["server/invoices.mjs"]);
  assert.deepEqual(sibling.scopeWarnings, ["docs/api.md"]);
  assert.equal(sibling.workspaceId, "workspace-1");
  assert.equal(sibling.worktreePath, "/repo/task-1");
});

// The two reasons a launched plan blocks are "a task never launched" and "a
// task is not ready". A relaunch answers both, so the goal must leave the merge
// column while its new agent works.
test("a relaunch clears a blocked plan and drops the delivery error", (t) => {
  const store = memoryStore(t);
  launchedPair(store);
  const blocked = store.recordDeliveryFailure("plan-1", "t1 never produced a head");
  assert.equal(blocked.deliveryStatus, "blocked");

  const plan = store.recordTaskRelaunch("plan-1", "t1", { status: "launched", path: "/repo/task-0", workspace: { workspace_id: "workspace-new" } });
  assert.equal(plan.deliveryStatus, "implementing");
  assert.equal(plan.deliveryError, null);
});

// Only `blocked` is a state a relaunch resolves. Promoting an assembling plan
// back to implementing, or demoting an open pull request, would rewrite a
// delivery stage this writer knows nothing about.
test("a relaunch leaves a delivery status that is not blocked alone", (t) => {
  const store = memoryStore(t);
  launchedPair(store);
  assert.equal(store.get("plan-1").deliveryStatus, "implementing");
  assert.equal(store.recordTaskRelaunch("plan-1", "t1", { status: "launched", path: "/repo/task-0" }).deliveryStatus, "implementing");

  launchedPair(store, "plan-2");
  store.recordTaskReady("plan-2", "t1", "b".repeat(40));
  store.recordTaskReady("plan-2", "t2", "c".repeat(40));
  store.recordFinalPr("plan-2", { number: 7, url: "https://github.test/pr/7" });
  assert.equal(store.get("plan-2").deliveryStatus, "pr_open");
  const stillOpen = store.recordTaskRelaunch("plan-2", "t1", { status: "launched", path: "/repo/task-0" });
  assert.equal(stillOpen.deliveryStatus, "pr_open");
  assert.equal(stillOpen.finalPrNumber, 7);
});

test("a relaunch writes one task_relaunched event carrying the result", (t) => {
  const store = memoryStore(t);
  launchedPair(store);
  const result = { status: "launched", path: "/repo/task-0", workspace: { workspace_id: "workspace-new" }, startSha: "f".repeat(40) };
  store.recordTaskRelaunch("plan-1", "t1", result);
  const event = store.events("plan-1").at(-1);
  assert.equal(event.kind, "task_relaunched");
  assert.equal(event.payload.taskId, "t1");
  assert.deepEqual(event.payload.result, result);
});

// A relaunch that failed at the cmux call is still recorded, so the board says
// why instead of showing a task that silently stayed dead.
test("a failed relaunch is stored with its reason and no session", (t) => {
  const store = memoryStore(t);
  launchedPair(store);
  const plan = store.recordTaskRelaunch("plan-1", "t1", { status: "failed", path: "/repo/task-0", error: "cmux is not running" });
  const task = plan.tasks.find((item) => item.id === "t1");
  assert.equal(task.launchStatus, "failed");
  assert.equal(task.launchError, "cmux is not running");
  assert.equal(task.workspaceId, null);
  // Even a failed relaunch clears the blocked flag, because the user has been
  // told what happened and the plan is no longer waiting on an absent answer.
  assert.equal(plan.deliveryStatus, "implementing");
});

// A result with no status at all still has to leave a launched row behind:
// writing an empty launch_status would drop the task out of every reader that
// counts launched work.
test("a relaunch with no status defaults to launched", (t) => {
  const store = memoryStore(t);
  launchedPair(store);
  const plan = store.recordTaskRelaunch("plan-1", "t1", {});
  assert.equal(plan.tasks.find((item) => item.id === "t1").launchStatus, "launched");
});

// A skipped task keeps its row and its reason. A silent disappearance is what
// made the old failures impossible to diagnose.
test("a skip marks the task skipped, keeps the row, and records why", (t) => {
  const store = memoryStore(t);
  launchedPair(store);
  store.recordTaskPending("plan-1", "t1", { error: "the agent never answered" });
  const plan = store.recordTaskSkipped("plan-1", "t1", "duplicated by t2");
  const task = plan.tasks.find((item) => item.id === "t1");

  assert.equal(plan.tasks.length, 2, "the row must stay");
  assert.equal(task.launchStatus, "skipped");
  assert.equal(task.launchError, "duplicated by t2");
  assert.equal(task.deliveryStatus, "pending");
  assert.equal(task.evidenceStatus, null);
  assert.equal(task.evidenceError, null);
  // The worktree and the branch survive: the work stays on disk to read.
  assert.equal(task.worktreePath, "/repo/task-0");
  assert.equal(task.branch, "feature/billing");
  const event = store.events("plan-1").at(-1);
  assert.equal(event.kind, "task_skipped");
  assert.deepEqual(event.payload, { taskId: "t1", reason: "duplicated by t2" });
});

// Skipping is the answer to "one dead task blocks the merge for every other
// task that finished", so it too has to clear the blocked flag.
test("a skip clears a blocked plan", (t) => {
  const store = memoryStore(t);
  launchedPair(store);
  store.recordDeliveryFailure("plan-1", "t1 is not ready");
  const plan = store.recordTaskSkipped("plan-1", "t1");
  assert.equal(plan.deliveryStatus, "implementing");
  assert.equal(plan.deliveryError, null);
  assert.equal(plan.tasks.find((item) => item.id === "t1").launchError, null);
  assert.equal(store.events("plan-1").at(-1).payload.reason, null);
});

test("a skip leaves a plan that is not blocked at its own delivery status", (t) => {
  const store = memoryStore(t);
  launchedPair(store);
  store.recordIntegrationStarted("plan-1", { branch: "goal/billing", path: "/repo/goal" });
  assert.equal(store.recordTaskSkipped("plan-1", "t2").deliveryStatus, "assembling");
});

// A reason a user pasted from a terminal must not become an unbounded column.
test("a skip reason is clipped to the stored bound", (t) => {
  const store = memoryStore(t);
  launchedPair(store);
  const plan = store.recordTaskSkipped("plan-1", "t1", "x".repeat(5_000));
  assert.equal(plan.tasks.find((item) => item.id === "t1").launchError.length, 2_000);
});

// Both writers address one row by its composite key. An unknown task id must
// leave every row alone rather than falling back to the first task.
test("a relaunch or a skip of an unknown task changes no task row", (t) => {
  const store = memoryStore(t);
  launchedPair(store);
  const before = store.get("plan-1").tasks;
  const relaunched = store.recordTaskRelaunch("plan-1", "nope", { status: "launched", path: "/repo/ghost" });
  assert.deepEqual(relaunched.tasks, before);
  const skipped = store.recordTaskSkipped("plan-1", "nope", "ghost");
  assert.deepEqual(skipped.tasks, before);
});

test("a duplicate failed wave cannot erase a launched task or reset its ready evidence and merge", (t) => {
  const store = memoryStore(t);
  seed(store);
  store.recordRound("plan-1", { round: 1, stage: "ready", tasks: TASKS });
  store.recordLaunch("plan-1", { base: "origin/main", baseSha: "a".repeat(40), results: [
    { id: "t1", status: "launched", path: "/repo/t1", workspace: { workspace_id: "ws1" } },
    { id: "t2", status: "queued" },
  ] });
  store.recordWaveLaunch("plan-1", { wave: 1, startSha: "a".repeat(40), results: [{ id: "t2", status: "launched", path: "/repo/t2", workspace: { workspace_id: "ws2" } }] });
  store.recordTaskReady("plan-1", "t2", "b".repeat(40));
  store.recordMergeLaunched("plan-1", "merge-session");
  const before = store.get("plan-1");
  const after = store.recordWaveLaunch("plan-1", { wave: 1, startSha: "a".repeat(40), results: [{ id: "t2", status: "failed", path: null, error: "already exists" }] });
  assert.deepEqual(after.tasks, before.tasks);
  assert.equal(after.mergeWorkspaceId, "merge-session");
  assert.equal(after.mergeStatus, "running");
  assert.equal(store.events("plan-1").at(-1).kind, "wave_launched");
});

test("association repairs only a still-unassociated failed task and records an audit event", (t) => {
  const store = memoryStore(t);
  seed(store);
  store.recordRound("plan-1", { round: 1, stage: "ready", tasks: TASKS });
  store.recordLaunch("plan-1", { base: "origin/main", baseSha: "a".repeat(40), results: [
    { id: "t1", status: "launched", path: "/repo/t1", workspace: { workspace_id: "ws1" } },
    { id: "t2", status: "failed", error: "already exists" },
  ] });
  const candidate = { branch: TASKS[1].branch, path: "/repo/t2", workspaceId: "ws2", headSha: "b".repeat(40) };
  assert.throws(() => store.recordTaskAssociation("plan-1", "t2", { ...candidate, workspaceId: "ws1" }), /already associated/);
  assert.throws(() => store.recordTaskAssociation("plan-1", "t2", { ...candidate, branch: "wrong" }), /changed/);
  const plan = store.recordTaskAssociation("plan-1", "t2", candidate);
  assert.equal(plan.tasks[1].workspaceId, "ws2");
  assert.equal(plan.tasks[1].launchStatus, "launched");
  assert.equal(plan.tasks[1].launchError, null);
  assert.equal(plan.tasks[1].deliveryStatus, "pending");
  assert.equal(store.events("plan-1").at(-1).kind, "task_associated");
  assert.throws(() => store.recordTaskAssociation("plan-1", "t2", candidate), /changed/);
});

test("reobserving an open PR heals stale delivery failures idempotently", (t) => {
  const store = memoryStore(t);
  seed(store);
  const pr = { number: 73, url: "https://github.test/pr/73", state: "OPEN" };
  store.recordGoalPullRequest("plan-1", pr);
  store.recordMergeBlocked("plan-1", "Another worktree operation holds this lock");
  const healed = store.recordGoalPullRequest("plan-1", pr);
  assert.equal(healed.deliveryError, null);
  assert.equal(healed.mergeStatus, "done");
  assert.equal(healed.deliveryStatus, "pr_open");
  const count = store.events("plan-1").length;
  store.recordGoalPullRequest("plan-1", pr);
  assert.equal(store.events("plan-1").length, count);
});

test("a merged PR clears stale delivery errors on existing terminal records", (t) => {
  const store = memoryStore(t);
  seed(store);
  const pr = { number: 73, url: "https://github.test/pr/73", state: "MERGED" };
  store.recordGoalPullRequest("plan-1", pr);
  // Simulate a record persisted by the older Companion.
  store.db.prepare("UPDATE plans SET merge_status = 'blocked', delivery_error = 'stale lock' WHERE plan_id = ?").run("plan-1");
  const healed = store.recordGoalPullRequest("plan-1", pr);
  assert.equal(healed.boardStatus, "merged");
  assert.equal(healed.deliveryError, null);
  assert.equal(healed.mergeStatus, "done");
});
