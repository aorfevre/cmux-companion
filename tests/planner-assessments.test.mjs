import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";
import { GoalReviews } from "../server/goal-reviews.mjs";
import { assessmentCommand, parseAssessment } from "../server/planner-assessments.mjs";
import { plannerReviewReady } from "../server/goal-options.mjs";
import { goalBoardState } from "../server/goal-board.mjs";

const spec = { outcome: "Add billing", inScope: ["Billing"], nonGoals: ["Subscriptions"], assumptions: ["One currency"], acceptanceCriteria: [{ id: "AC-1", text: "Invoice is displayed", verification: "UI test" }] };
const tasks = [{ id: "T1", title: "Billing", branch: "feature/billing", prompt: "Add the invoice UI", criterionIds: ["AC-1"], ownedAreas: ["app/**"], verification: ["npm test"] }];
const finding = { id: "F1", severity: "high", title: "Missing coverage", evidence: "app/billing.ts:1", suggestion: "Add rollback coverage" };
const result = (findings = [finding], patch = {}) => JSON.stringify({ result: JSON.stringify({ spec, tasks, assessment: { summary: "Added rollback coverage.", dispositions: findings.map(({ id }) => ({ findingId: id, disposition: "accept", rationale: "Protect user data" })) }, ...patch }) });

function fixture(t, { completed = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "planner-assessment-test-"));
  const store = new WorktreePlanStore({ path: join(directory, "plans.db") });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.createPlan({ planId: "p", repositoryId: "repo", goal: "Add billing", engine: { provider: "codex", model: "gpt-5.6-sol", effort: "high", reviewer: true } });
  store.reserveGoalSession("p", { branch: "feature/billing", generation: 1 });
  store.recordGoalSessionBase("p", { baseRef: "origin/main", baseSha: "a".repeat(40) });
  store.recordGoalSessionStart("p", { worktreePath: directory, workspaceId: "w", generation: 1 });
  store.recordGoalSessionProviderSession("p", { generation: 1, providerSessionId: "planner-session" });
  const publish = () => store.publishProposal("p", { generation: 1, proposal: { intendedBehavior: spec.outcome, spec, tasks }, providerSessionId: "planner-session" });
  publish();
  const id = store.get("p").reviews[0].id;
  const complete = () => { const claim = store.outcomes.claim(id); store.outcomes.finish(id, claim.attempt, { status: "completed", result: "```json\n" + JSON.stringify({ findings: [finding] }) + "\n```\nComplete critique" }); };
  if (completed) complete();
  const calls = [];
  const reviews = new GoalReviews({ store, worktrees: { resolveRepository: async () => ({ id: "repo" }) }, env: {}, processAlive: () => false,
    execute: async (bin, args, options) => { calls.push({ bin, args }); options.onSpawn?.(12345); return { stdout: result() }; } });
  return { directory, store, reviews, id, publish, complete, calls, get: () => store.get("p"), review: () => store.outcomes.review(id) };
}

test("review completion queues assessment atomically; sweep uses the configured planner and final approval remains human", async (t) => {
  const { store, reviews, get, review, calls } = fixture(t);
  assert.equal(review().assessment.status, "pending");
  assert.equal(plannerReviewReady(get()), false);
  assert.equal(goalBoardState(get()), "discovering");
  assert.equal(store.list()[0].boardState, undefined);
  assert.throws(() => store.approveProposal("p", { generation: 1, revision: 1 }), /assessment/);
  const execute = reviews.execute;
  reviews.execute = async (bin, args, options) => {
    const directory = args[args.indexOf("--add-dir") + 1];
    const context = JSON.parse(readFileSync(join(directory, "context.json"), "utf8"));
    assert.match(context.critique, /Complete critique/); assert.equal(context.revision, "1");
    return execute(bin, args, options);
  };
  await reviews.tick(); await reviews.tick();
  assert.equal(calls.length, 1);
  const args = calls[0].args;
  assert.equal(args[0], "codex"); assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-sol");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.equal(args[args.indexOf("--resume") + 1], "planner-session");
  assert.ok(args.includes("--fork-session")); assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob");
  assert.equal(get().proposalRevision, 2); assert.equal(get().reviews.length, 1);
  assert.equal(review().assessment.finalRevision, 2); assert.equal(review().assessment.sourceRevision, 1);
  assert.equal(plannerReviewReady(get()), true); assert.equal(get().approvalAt, null);
  assert.equal(goalBoardState(get()), "needs_you"); assert.equal(store.list()[0].plannerReviewStatus, "completed");
  store.approveProposal("p", { generation: 1, revision: 2 });
  assert.equal(get().goalSessionState, "implementing");
});

test("assessment publication checks dispatch ownership and repeated results do not create revisions", async (t) => {
  const { reviews, store, get, review, id } = fixture(t);
  const original = reviews.execute;
  reviews.execute = async (...args) => {
    assert.throws(() => store.publishProposal("p", { generation: 1, proposal: { spec, tasks }, providerSessionId: "planner-session", expectedRevision: 1, expectedFeedback: "", assessment: { reviewId: id, attempt: 1, dispatchId: "wrong" } }), /owned/);
    return original(...args);
  };
  await reviews.tick();
  const saved = review().assessment;
  assert.throws(() => store.publishProposal("p", { generation: 1, proposal: { spec, tasks }, providerSessionId: "planner-session", expectedRevision: 1, expectedFeedback: "", assessment: { reviewId: id, attempt: 1, dispatchId: saved.dispatchId } }), /changed/);
  assert.equal(get().proposalRevision, 2);
});

test("new feedback invalidates an in-flight assessment and starts a fresh cycle on publication", async (t) => {
  const { reviews, store, get, review, publish } = fixture(t);
  reviews.execute = async (_bin, _args, options) => {
    options.onSpawn(12345);
    store.requestProposalChanges("p", { generation: 1, revision: 1, feedback: "Different currency" });
    return { stdout: result() };
  };
  await reviews.tick();
  assert.equal(get().proposalRevision, 1); assert.equal(review().assessment.status, "stale");
  assert.equal(plannerReviewReady(get()), false);
  publish(); assert.equal(get().reviews.length, 2); assert.equal(get().reviews.find((r) => r.target === "2").status, "queued");
});

for (const change of ["abort", "generation", "session", "revision"]) test(`late assessment cannot overwrite ${change}`, async (t) => {
  const { reviews, store, get, review, publish } = fixture(t);
  reviews.execute = async (_bin, _args, options) => {
    options.onSpawn(12345);
    if (change === "abort") store.db.prepare("UPDATE plans SET board_status = 'aborted' WHERE plan_id = 'p'").run();
    if (change === "generation") store.db.prepare("UPDATE plans SET goal_session_generation = 2 WHERE plan_id = 'p'").run();
    if (change === "session") store.recordGoalSessionProviderSession("p", { generation: 1, providerSessionId: "other" });
    if (change === "revision") publish();
    return { stdout: result() };
  };
  await reviews.tick();
  assert.equal(review().assessment.status, "stale"); assert.equal(get().approvalRevision, null);
  assert.equal(get().proposalRevision, change === "revision" ? 2 : 1);
});

test("an explicit retry can recover malformed assessment but never acknowledge it as passed", async (t) => {
  const { reviews, store, get, id, review } = fixture(t);
  reviews.execute = async (_bin, _args, options) => { options.onSpawn(12345); return { stdout: "not json" }; };
  await reviews.tick(); assert.equal(review().assessment.status, "failed"); assert.equal(goalBoardState(get()), "stopped");
  assert.throws(() => store.approveProposal("p", { generation: 1, revision: 1 }), /assessment/);
  assert.throws(() => reviews.assessments.retry("other", id), /cannot/);
  reviews.assessments.retry("p", id);
  reviews.execute = async (_bin, _args, options) => { options.onSpawn(12346); return { stdout: result() }; };
  await reviews.tick(); assert.equal(plannerReviewReady(get()), true);
});

test("a killed or non-zero planner process fails with a readable message and stays retryable", async (t) => {
  const { reviews, id, review, get } = fixture(t);
  reviews.execute = async (_bin, _args, options) => { options.onSpawn(12345); throw Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM", reason: "idle" }); };
  await reviews.tick();
  assert.equal(review().assessment.status, "failed"); assert.match(review().assessment.error, /^The planner assessment/);
  assert.match(review().assessment.error, /idle|minutes/);
  reviews.assessments.retry("p", id);
  reviews.execute = async (_bin, _args, options) => { options.onSpawn(12346); throw Object.assign(new Error("exit"), { code: 1, stderr: "boom" }); };
  await reviews.tick();
  assert.equal(review().assessment.status, "failed"); assert.match(review().assessment.error, /^The planner assessment could not run/);
  assert.equal(plannerReviewReady(get()), false);
});

test("crash recovery keeps uncertain ownership blocked and never duplicates a running process", async (t) => {
  const { reviews, id, review, calls } = fixture(t);
  reviews.assessments.update(review(), { ...review().assessment, status: "running", ownerPid: 987, pid: null, dispatchId: "lost" });
  reviews.processAlive = () => true;
  await reviews.tick(); assert.equal(review().assessment.status, "running"); assert.equal(calls.length, 0);
  reviews.processAlive = () => false;
  await reviews.tick(); assert.equal(review().assessment.status, "uncertain");
  assert.throws(() => reviews.assessments.retry("p", id, true), /uncertain/);
  reviews.assessments.update(review(), { ...review().assessment, pid: 12345 });
  reviews.processAlive = (pid) => pid === 12345;
  assert.throws(() => reviews.assessments.retry("p", id, true), /uncertain/);
  reviews.processAlive = () => false;
  reviews.assessments.retry("p", id, true);
  await reviews.tick(); assert.equal(calls.length, 1);
});

test("known dead assessment remains failed until explicit retry", async (t) => {
  const { reviews, id, review, calls } = fixture(t);
  reviews.assessments.update(review(), { ...review().assessment, status: "running", ownerPid: 987, pid: 12345 });
  await reviews.tick(); assert.equal(review().assessment.status, "failed"); assert.equal(calls.length, 0);
  reviews.assessments.retry("p", id); await reviews.tick(); assert.equal(calls.length, 1);
});

test("upgrade queues eligible completed reviews once and preserves historical decisions", async (t) => {
  const { store, reviews, review, id, get } = fixture(t);
  store.db.prepare("UPDATE goal_reviews SET assessment = NULL WHERE id = ?").run(id);
  store.db.prepare("INSERT INTO goal_review_decisions VALUES (?, 'F1', 'agree', 'Old comment', '2026-09-09')").run(id);
  await reviews.tick(); await reviews.tick();
  assert.equal(get().proposalRevision, 2); assert.equal(review().decisions[0].comment, "Old comment");
  store.db.prepare("UPDATE goal_reviews SET assessment = NULL WHERE id = ?").run(id);
  await reviews.tick(); assert.equal(review().assessment, null, "historical revision is not backfilled");
});

test("upgrade never queues already approved or aborted goals", async (t) => {
  const { store, reviews, review, id } = fixture(t);
  store.db.prepare("UPDATE goal_reviews SET assessment = NULL WHERE id = ?").run(id);
  store.db.prepare("UPDATE plans SET goal_session_state = 'implementing', approval_revision = 1 WHERE plan_id = 'p'").run();
  await reviews.tick(); assert.equal(review().assessment, null);
  store.db.prepare("UPDATE plans SET goal_session_state = 'awaiting_approval', board_status = 'aborted' WHERE plan_id = 'p'").run();
  await reviews.tick(); assert.equal(review().assessment, null);
});

test("input overflow and missing planner context fail without dispatch or lost evidence", async (t) => {
  const { store, reviews, review, id, calls } = fixture(t);
  store.db.prepare("UPDATE goal_reviews SET snapshot = ? WHERE id = ?").run(JSON.stringify({ proposal: { note: "x".repeat(256 * 1024) } }), id);
  await reviews.tick(); assert.match(review().assessment.error, /256 KiB/); assert.equal(calls.length, 0);
  store.db.prepare("UPDATE goal_reviews SET assessment = NULL WHERE id = ?").run(id);
  store.db.prepare("UPDATE plans SET goal_session_provider_session_id = NULL WHERE plan_id = 'p'").run();
  await reviews.tick(); assert.match(review().assessment.error, /no saved conversation/);
});

test("unsafe CLI modes and denied repositories never dispatch planner assessment", async (t) => {
  const { reviews, review, id, calls } = fixture(t);
  reviews.env = { CLAUDE_CODE_SAFE_MODE: "1" };
  await reviews.tick(); assert.match(review().assessment.error, /read-only hooks/); assert.equal(calls.length, 0);
  reviews.env = {}; reviews.assessments.retry("p", id);
  reviews.worktrees.resolveRepository = async () => { throw new Error("Repository not allowed"); };
  await reviews.tick(); assert.match(review().assessment.error, /not allowed/); assert.equal(calls.length, 0);
});

test("assessment parser requires a complete contract and one reason per finding", () => {
  const review = { findings: [finding] };
  assert.equal(parseAssessment(result(), review).proposal.intendedBehavior, "Add billing");
  assert.equal(parseAssessment(result([]), { findings: [] }).dispositions.length, 0);
  const dispositions = [{ findingId: "F1", disposition: "accept", rationale: "Reason" }];
  for (const patch of [{ spec: null }, { tasks: [] }, { assessment: {} }, { assessment: { summary: "Summary", dispositions: [] } },
    { assessment: { summary: "Summary", dispositions: [...dispositions, ...dispositions] } },
    { assessment: { summary: "Summary", dispositions: [{ findingId: "F2", disposition: "accept", rationale: "Reason" }] } },
    { error: "Which currency should be supported?" }]) assert.throws(() => parseAssessment(result([finding], patch), review));
  assert.throws(() => parseAssessment(JSON.stringify({ is_error: true, result: "{}" }), review), /failed/);
  assert.throws(() => parseAssessment(JSON.stringify({ result: "x".repeat(128 * 1024 + 1) }), review), /oversized/);
  const command = assessmentCommand({ engine: { provider: "claude", model: "default", effort: "default" }, goalSessionProviderSessionId: "session" }, "/tmp/input");
  assert.equal(command.includes("--effort"), false);
});
