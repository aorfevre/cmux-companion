import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";
import { GoalSessionService } from "../server/goal-session-service.mjs";
import { GoalReviews, reviewCommand } from "../server/goal-reviews.mjs";
import { reviewHook } from "../server/goal-review-hook.mjs";
import { callGoalTool, goalHook, handleGoalRpc } from "../server/goal-session-bridge.mjs";
import { interactiveGoalCommand, goalDiscoveryPrompt } from "../server/goal-session-interactive.mjs";
import { streamExecFile } from "../server/planner-process.mjs";
import { retirableSessions } from "../server/goal-session-reaper.mjs";
import { restoredGoalSessions } from "../server/restored-goal-sessions.mjs";
import { goalBoardState } from "../server/goal-board.mjs";
import { NEW_GOAL_SPEC_OPTIONS, normalizeGoalType, plannerReviewReady } from "../server/goal-options.mjs";

const markdown = "## Evidence\nRepository references: server/app.mjs:1.\n\n## Assumptions\nSingle owner.\n\n## Limitations\nNo live integration checked.\n\n## Recommendations\nAdd validation and test missing input.";
const reportArgs = { revision: 1, expectedVersion: 0, title: "Boundary analysis", markdown };
const proposal = { intendedBehavior: "Examine boundaries", acceptanceCriteria: [{ text: "Evidence", verification: "Read sources" }] };
const head = "a".repeat(40), base = "b".repeat(40);

function setup(t, { goalType = "analysis", reviewer = false, codeReview = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "companion-outcomes-test-"));
  const store = new WorktreePlanStore({ path: join(directory, "goals.db") });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const binding = { planId: "goal", generation: 1, sessionId: "session" };
  store.createPlan({ planId: "goal", repositoryId: "repo", cwd: directory, goal: "Examine boundaries", goalType, engine: { provider: "codex", reviewer }, reviewOptions: { codeReview } });
  store.reserveGoalSession("goal", { branch: "goal-session/test", generation: 1 });
  store.recordGoalSessionBase("goal", { baseRef: "origin/main", baseSha: base });
  store.recordGoalSessionStart("goal", { worktreePath: directory, workspaceId: "workspace", generation: 1 });
  store.recordGoalSessionProviderSession("goal", { generation: 1, providerSessionId: "session" });
  let created = 0;
  const worktrees = { resolveRepository: async (id) => ({ id, primaryPath: directory }), create: async () => { created++; return { worktree: { path: directory } }; } };
  const service = new GoalSessionService({ store, worktrees, cmux: { workspaceListDetailed: async () => ({ workspaces: [] }), workspaceCreate: async () => ({ workspace_id: "child" }), workspaceStartGoalSessionRunner: async () => {} } });
  const publish = () => store.publishProposal("goal", { generation: 1, providerSessionId: "session", proposal });
  const approve = () => store.approveProposal("goal", { generation: 1, revision: store.get("goal").proposalRevision });
  const get = () => store.get("goal");
  const artifact = (patch = {}) => callGoalTool(store, binding, "publish_analysis", { ...reportArgs, ...patch });
  return { directory, store, binding, worktrees, service, publish, approve, get, artifact, created: () => created };
}

test("creation defaults are shared, explicit false persists, and legacy reads stay off", async (t) => {
  const { store, service } = setup(t);
  const fresh = await service.start({ repositoryId: "repo", goal: "Code" });
  assert.equal(fresh.goalType, "coding"); assert.equal(fresh.engine.reviewer, true); assert.equal(fresh.reviewOptions.codeReview, true);
  assert.deepEqual(fresh.specOptions, NEW_GOAL_SPEC_OPTIONS);
  const opted = await service.start({ repositoryId: "repo", goal: "No reviews", engine: { reviewer: false }, reviewOptions: { codeReview: false }, specOptions: { unitTests: false } });
  assert.equal(opted.engine.reviewer, false); assert.equal(opted.reviewOptions.codeReview, false); assert.equal(opted.specOptions.unitTests, false); assert.equal(opted.specOptions.e2eTests, true);
  const legacy = store.createPlan({ planId: "old", repositoryId: "repo", goal: "Old" });
  assert.equal(legacy.goalType, "coding"); assert.equal(legacy.engine.reviewer, false); assert.equal(legacy.specOptions.unitTests, false); assert.equal(legacy.reviewOptions.codeReview, false);
  assert.throws(() => normalizeGoalType(null), /Goal type/);
  for (const patch of [{ goalType: "report" }, { specOptions: [] }, { reviewOptions: { codeReview: "true" } }]) await assert.rejects(service.start({ repositoryId: "repo", goal: "Invalid", ...patch }));
});

test("analysis creation masks coding-only options and includes its type in request identity", async (t) => {
  const { service, store } = setup(t);
  const key = "11111111-1111-4111-8111-111111111111";
  const request = { repositoryId: "repo", goal: "Analyze", goalType: "analysis", idempotencyKey: key };
  const first = await service.start(request);
  assert.equal(first.specOptions.edgeCases, true);
  for (const key of ["unitTests", "e2eTests", "refactorPass"]) assert.equal(first.specOptions[key], false);
  assert.equal(first.reviewOptions.codeReview, false); assert.equal(first.engine.reviewer, true);
  assert.equal((await service.start(request)).planId, first.planId);
  await assert.rejects(service.start({ ...request, goalType: "coding" }), /different goal/);
  assert.equal(store.list().find((entry) => entry.planId === key).goalType, "analysis");
});

test("analysis approval grants only artifact publication, not a code task or writable CLI", (t) => {
  const { store, binding, get, publish, approve, artifact } = setup(t);
  assert.throws(() => artifact(), /approval/);
  publish(); approve();
  const args = interactiveGoalCommand(get(), store.path);
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob,AskUserQuestion");
  assert.match(goalDiscoveryPrompt(get()), /not coding/);
  for (const tool_name of ["Bash", "Write", "Edit", "Agent", "mcp__unknown__write"]) {
    assert.equal(goalHook(store, binding, { hook_event_name: "PreToolUse", session_id: binding.sessionId, tool_name }).hookSpecificOutput.permissionDecision, "deny");
  }
  assert.equal(callGoalTool(store, binding, "get_status").approved, true);
  assert.deepEqual(get().tasks, []); assert.equal(get().status, "draft");
  assert.equal(goalBoardState(get()), "analysis_in_progress");
  const tools = handleGoalRpc(store, binding, { id: 1, method: "tools/list" }).result.tools;
  assert.ok(tools.some((tool) => tool.name === "publish_analysis"));
  const report = artifact().report;
  assert.equal(report.version, 1); assert.match(report.markdown, /Challenge the analysis/); assert.match(report.markdown, /Launch coding goal/);
  assert.equal(goalBoardState(get()), "analysis_ready");
  assert.equal(goalBoardState({ ...get(), boardPrState: "MERGED", health: "dead" }), "analysis_ready");
  assert.equal(get().finalPrUrl, null); assert.deepEqual(get().tasks, []);
  const observed = { ...get(), boardPrState: "MERGED" };
  const cleanup = retirableSessions(observed, { available: true, byId: new Map() });
  assert.deepEqual(cleanup.close, []); assert.equal(cleanup.keep.length, 1);
  const restored = restoredGoalSessions([observed], [{ id: "restored", title: "Goal analysis", current_directory: observed.goalSessionWorktreePath }]);
  assert.equal(restored[0].eligible, false); assert.equal(restored[0].planId, observed.planId);
});

test("report publication is atomic, revision-bound, bounded and idempotent", (t) => {
  const { store, binding, publish, approve, artifact, get } = setup(t);
  publish(); approve();
  for (const patch of [{ revision: 2 }, { expectedVersion: 8 }, { title: "" }, { markdown: "" }, { markdown: "x".repeat(100_000) }, { markdown: "## Evidence\nOnly evidence" }]) assert.throws(() => artifact(patch));
  for (const patch of [{ generation: 2 }, { sessionId: "other" }]) assert.throws(() => callGoalTool(store, { ...binding, ...patch }, "publish_analysis", reportArgs));
  assert.equal(get().analysisReports.length, 0);
  const first = artifact().report;
  assert.deepEqual(artifact().report, first);
  assert.throws(() => artifact({ title: "Changed without reading version" }), /changed/);
  const second = artifact({ expectedVersion: 1, markdown: markdown + "\nAdditional evidence." }).report;
  assert.equal(second.version, 2); assert.deepEqual(store.outcomes.report("goal", 1), first);
  const reopened = new WorktreePlanStore({ path: store.path });
  try { assert.equal(reopened.get("goal").analysisReports.length, 2); assert.equal(reopened.get("goal").goalType, "analysis"); } finally { reopened.close(); }
});

test("coding sessions do not expose or permit report publication", (t) => {
  const { store, binding, publish, approve, artifact } = setup(t, { goalType: "coding" });
  publish(); approve();
  assert.throws(() => artifact(), /Analysis publication/);
  assert.ok(!handleGoalRpc(store, binding, { id: 1, method: "tools/list" }).result.tools.some((tool) => tool.name === "publish_analysis"));
});

test("planner reviews run independently, gate only completion and cannot approve for the user", async (t) => {
  const { store, worktrees, publish, approve, get } = setup(t, { reviewer: true });
  publish(); assert.equal(get().reviews[0].status, "queued"); assert.equal(goalBoardState(get()), "discovering");
  assert.throws(approve, /Wait for planner review/);
  let calls = 0;
  const reviews = new GoalReviews({ store, worktrees, execute: async (bin, args, options) => {
    if (bin === "git" || bin === "tar") return { stdout: "" };
    assert.equal(bin, "ccs"); assert.equal(args[0], "claude"); assert.ok(args.includes("Read,Grep,Glob")); options.onSpawn(12345); calls++;
    return { stdout: JSON.stringify({ result: "High: evidence does not cover missing input. Advisory only." }) };
  } });
  await reviews.tick(); await reviews.tick();
  assert.equal(calls, 1); assert.equal(get().reviews[0].status, "completed"); assert.equal(get().approvalRevision, null); assert.equal(plannerReviewReady(get()), true);
  approve(); assert.equal(get().goalSessionState, "analyzing");
});

test("planner failure requires explicit acknowledgment or retry and a new revision invalidates old evidence", async (t) => {
  const { store, worktrees, publish, approve, get } = setup(t, { reviewer: true });
  publish();
  const runner = new GoalReviews({ store, worktrees, execute: async (bin) => { if (bin === "ccs") throw new Error("provider timeout"); return { stdout: "" }; } });
  await runner.tick(); const failed = get().reviews[0];
  assert.equal(failed.status, "failed"); assert.throws(approve, /Wait for planner review/);
  store.outcomes.acknowledge("goal", failed.id); assert.equal(plannerReviewReady(get()), true);
  store.requestProposalChanges("goal", { generation: 1, revision: 1, feedback: "Add missing cases" });
  publish(); assert.equal(plannerReviewReady(get()), false);
  assert.throws(() => store.outcomes.acknowledge("goal", failed.id), /no longer current/);
  const current = get().reviews.find((review) => review.target === "2");
  await runner.tick(); store.outcomes.retry("goal", current.id);
  runner.execute = async () => ({ stdout: JSON.stringify({ result: "No additional findings." }) });
  await runner.tick(); approve();
});

test("late planner result cannot mark a newer proposal reviewed", async (t) => {
  const { store, worktrees, publish, get } = setup(t, { reviewer: true });
  publish();
  const runner = new GoalReviews({ store, worktrees, execute: async (bin) => {
    if (bin !== "ccs") return { stdout: "" };
    store.requestProposalChanges("goal", { generation: 1, revision: 1, feedback: "Changed scope" }); publish();
    return { stdout: JSON.stringify({ result: "Old findings" }) };
  } });
  await runner.tick();
  assert.equal(get().reviews.find((review) => review.target === "1").status, "stale");
  assert.equal(plannerReviewReady(get()), false);
});

test("challenge is version-bound, independent, idempotent and never rewrites the report", async (t) => {
  const { store, service, worktrees, publish, approve, artifact, get } = setup(t);
  publish(); approve(); const first = artifact().report;
  const [a, b] = await Promise.all([service.challenge("goal", 1), service.challenge("goal", 1)]);
  assert.equal(a.id, b.id);
  artifact({ expectedVersion: 1, markdown: markdown + "\nRevision two" });
  const runner = new GoalReviews({ store, worktrees, execute: async () => ({ stdout: JSON.stringify({ result: "Critique of version one: consider competing explanations." }) }) });
  await runner.tick();
  const critique = get().reviews[0]; assert.equal(critique.target, "1"); assert.equal(critique.status, "completed");
  assert.deepEqual(store.outcomes.report("goal", 1), first); assert.equal(get().analysisReports[0].version, 2);
  await assert.rejects(service.challenge("goal", 99), /unavailable/);
});

test("linked coding discovery is durable across duplicate clicks and requires fresh approval", async (t) => {
  const { service, publish, approve, artifact, get, created, store } = setup(t);
  publish(); approve(); artifact();
  const [first, second] = await Promise.all([service.launchCoding("goal", 1), service.launchCoding("goal", 1)]);
  assert.equal(first.planId, second.planId); assert.equal(created(), 1);
  assert.equal(first.goalType, "coding"); assert.deepEqual(first.sourceAnalysis, { planId: "goal", version: 1 });
  assert.equal(first.approvalRevision, null); assert.equal(first.engine.reviewer, true); assert.deepEqual(first.specOptions, NEW_GOAL_SPEC_OPTIONS);
  assert.equal(first.discoveryContext.analysisReport.markdown, get().analysisReports[0].markdown);
  assert.equal(store.outcomes.report("goal", 1).codingGoalId, first.planId);
  assert.equal((await service.launchCoding("goal", 1)).planId, first.planId);
  assert.equal(get().goalSessionState, "analysis_ready");
});

test("failed child startup retains one child and original report for explicit recovery", async (t) => {
  const { service, publish, approve, artifact, get, created } = setup(t);
  publish(); approve(); artifact();
  service.cmux.workspaceCreate = async () => { throw new Error("cmux unavailable"); };
  let id;
  await assert.rejects(service.launchCoding("goal", 1), (cause) => { id = cause.planId; return /cmux unavailable/.test(cause.message); });
  const retry = await service.launchCoding("goal", 1);
  assert.equal(retry.planId, id); assert.match(retry.goalSessionError, /cmux unavailable/); assert.equal(created(), 1);
  assert.equal(get().analysisReports.length, 1);
});

test("reviewer hooks and command surface deny all mutations and unknown tools", () => {
  for (const tool_name of ["Bash", "Write", "Edit", "mcp__companion_goal__publish_proposal", "Agent"]) assert.equal(reviewHook({ hook_event_name: "PreToolUse", tool_name }).hookSpecificOutput.permissionDecision, "deny");
  for (const tool_name of ["Read", "Grep", "Glob"]) assert.deepEqual(reviewHook({ hook_event_name: "PreToolUse", tool_name }), {});
  const args = reviewCommand({ provider: "claude", model: "claude-fable-5-1" }, "/tmp/context.json");
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob"); assert.ok(args.includes("--strict-mcp-config")); assert.ok(args.find((arg) => arg.startsWith("--settings=")));
});

test("orphaned runs fail only with dead-process proof; unknown dispatch cannot be duplicated", async (t) => {
  const { store, worktrees, publish, get } = setup(t, { reviewer: true });
  publish(); const review = store.outcomes.claim(get().reviews[0].id);
  const runner = new GoalReviews({ store, worktrees, processAlive: () => false, execute: async () => { throw new Error("Must not run"); } });
  await runner.tick(); assert.equal(get().reviews[0].status, "uncertain");
  await assert.rejects(runner.reconcile("goal", review.id), /still uncertain/);
  assert.throws(() => store.outcomes.retry("goal", review.id), /reconcile/);
});

function codeFixture(t) {
  const fixture = setup(t, { goalType: "coding", codeReview: true });
  fixture.publish(); fixture.approve();
  fixture.store.recordGoalPullRequest("goal", { number: 12, url: "https://github.com/example/repo/pull/12", state: "OPEN" });
  const pr = { number: 12, url: "https://github.com/example/repo/pull/12", state: "OPEN", headRefName: "goal-session/test", headRefOid: head, baseRefOid: base };
  fixture.worktrees.pullRequestObservations = () => ({ available: true, observations: [{ number: pr.number, url: pr.url, state: pr.state, headSha: pr.headRefOid }] });
  const comments = []; let executions = 0, postings = 0;
  const execute = async (bin, args, options) => {
    if (bin === "ccs") { executions++; options.onSpawn(12345); return { stdout: JSON.stringify({ result: "Advisory: add a missing-input test." }) }; }
    if (bin === "gh" && args[1] === "comment") { postings++; comments.push({ body: args.at(-1) }); return { stdout: "" }; }
    if (bin === "gh") return { stdout: JSON.stringify(args.at(-1) === "comments" ? { comments } : pr) };
    return { stdout: bin === "git" && args[0] === "diff" ? "diff --git a/a b/a\n+safe" : "" };
  };
  return { ...fixture, pr, execute, comments, executions: () => executions, postings: () => postings };
}

test("code review uses observed PR commit, posts once, and changed heads need explicit review", async (t) => {
  const { store, worktrees, execute, get, pr, executions, postings } = codeFixture(t);
  const runner = new GoalReviews({ store, worktrees, execute });
  await runner.tick(); await runner.tick();
  assert.equal(executions(), 1); assert.equal(postings(), 1); assert.equal(get().reviews[0].status, "completed");
  pr.headRefOid = "c".repeat(40);
  await runner.tick(); assert.equal(executions(), 1); assert.equal(get().reviews[0].status, "stale");
  await runner.requestCode("goal"); await runner.tick(); assert.equal(executions(), 2); assert.equal(postings(), 2);
});

test("lost GitHub posting response reconciles the saved comment without reposting or rerunning", async (t) => {
  const { store, worktrees, execute, get, executions, postings } = codeFixture(t);
  let fail = true;
  const runner = new GoalReviews({ store, worktrees, execute: async (...args) => {
    const result = await execute(...args);
    if (args[0] === "gh" && args[1][1] === "comment" && fail) { fail = false; throw new Error("Lost response after posting"); }
    return result;
  } });
  await runner.tick(); const review = get().reviews[0];
  assert.equal(review.status, "uncertain"); assert.equal(postings(), 1);
  await runner.reconcile("goal", review.id);
  assert.equal(get().reviews[0].status, "completed"); assert.equal(postings(), 1); assert.equal(executions(), 1);
});

test("concurrent reconciliation across store instances owns one GitHub post", async (t) => {
  const fixture = codeFixture(t);
  const { store, worktrees, execute, get, postings } = fixture;
  const secondStore = new WorktreePlanStore({ path: store.path });
  t.after(() => secondStore.close());
  const runner = new GoalReviews({ store, worktrees, execute });
  await runner.observeCode();
  const review = store.outcomes.claim(get().reviews[0].id);
  store.outcomes.finish(review.id, review.attempt, { status: "posting", result: "Saved critique" });
  let release, entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  runner.execute = async (...args) => {
    if (args[0] === "gh" && args[1].at(-1) === "comments") { entered(); await gate; }
    return execute(...args);
  };
  const first = runner.reconcile("goal", review.id);
  await waiting;
  const other = new GoalReviews({ store: secondStore, worktrees, execute });
  await assert.rejects(other.reconcile("goal", review.id), /still running|already owned/);
  release(); await first;
  assert.equal(postings(), 1); assert.equal(get().reviews[0].status, "completed");
});

test("live dispatch owner prevents recovery in the claim-to-PID gap", async (t) => {
  const { store, worktrees, publish, get } = setup(t, { reviewer: true });
  publish(); store.outcomes.claim(get().reviews[0].id);
  const runner = new GoalReviews({ store, worktrees, processAlive: (pid) => pid === process.pid });
  await runner.tick(); assert.equal(get().reviews[0].status, "running");
});

test("shutdown during observation never launches a queued reviewer", async (t) => {
  const { store, worktrees, publish, get } = setup(t, { reviewer: true });
  publish(); let calls = 0;
  const runner = new GoalReviews({ store, worktrees, execute: async () => { calls++; } });
  const stop = runner.start();
  let release;
  runner.observeCode = () => new Promise((resolve) => { release = resolve; });
  const tick = runner.tick(); const stopped = stop(); release(); await tick; await stopped;
  assert.equal(calls, 0); assert.equal(get().reviews[0].status, "queued");
});

test("safe mode fails visibly rather than running without reviewer hooks", async (t) => {
  const { store, worktrees, publish, get } = setup(t, { reviewer: true }); publish();
  const runner = new GoalReviews({ store, worktrees, env: { CLAUDE_CODE_SAFE_MODE: "1" }, execute: async () => { assert.fail("Must not launch"); } });
  await runner.tick(); assert.equal(get().reviews[0].status, "failed"); assert.match(get().reviews[0].error, /safe\/bare/);
});

test("empty analysis sections and total artifact overflow are rejected", (t) => {
  const { publish, approve, artifact } = setup(t); publish(); approve();
  assert.throws(() => artifact({ markdown: markdown.replace("Single owner.", "") }), /populated ## Assumptions/);
  assert.throws(() => artifact({ markdown: markdown + "x".repeat(96 * 1024 - Buffer.byteLength(markdown)) }), /including next steps/);
});

test("analysis can request broader scope without rewriting or reauthorizing old reports", (t) => {
  const { publish, approve, artifact, get } = setup(t); publish(); approve(); const first = artifact().report;
  publish(); assert.equal(get().proposalRevision, 2); assert.equal(get().goalSessionState, "awaiting_approval");
  assert.throws(() => artifact({ expectedVersion: 1 }), /approval/);
  approve(); artifact({ revision: 2, expectedVersion: 1 });
  assert.deepEqual(get().analysisReports[1], first);
});

test("a real Git snapshot places review context inside its restricted checkout and excludes mutable owner changes", async (t) => {
  const { directory, store, worktrees, publish, get } = setup(t, { reviewer: true });
  const git = (args) => streamExecFile("git", args, { cwd: directory, timeout: 5000 });
  await git(["init"]);
  writeFileSync(join(directory, "evidence.txt"), "Pinned repository evidence");
  await git(["add", "evidence.txt"]);
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "Record local test evidence\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>"]);
  const { stdout } = await git(["rev-parse", "HEAD"]);
  store.db.prepare("UPDATE plans SET base_sha = ? WHERE plan_id = 'goal'").run(stdout.trim());
  publish(); writeFileSync(join(directory, "evidence.txt"), "Uncommitted owner change");
  const runner = new GoalReviews({ store, worktrees, execute: async (bin, args, options) => {
    if (bin !== "ccs") return streamExecFile(bin, args, options);
    const context = args.at(-1).match(/^Read (.+?)\. Independently/)[1];
    assert.ok(context.startsWith(options.cwd + "/"));
    assert.equal(readFileSync(join(options.cwd, "evidence.txt"), "utf8"), "Pinned repository evidence");
    assert.equal(JSON.parse(readFileSync(context, "utf8")).kind, "planner");
    return { stdout: JSON.stringify({ result: "Pinned evidence reviewed" }) };
  } });
  await runner.tick(); assert.equal(get().reviews[0].status, "completed");
  assert.equal(readFileSync(join(directory, "evidence.txt"), "utf8"), "Uncommitted owner change");
});

test("strict process output limits reject even one oversized unterminated line", async () => {
  await assert.rejects(streamExecFile(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000));"], { strictBuffer: true, maxBuffer: 1024, timeout: 3000 }), (cause) => cause.reason === "buffer");
});

test("process timeout escalates when a reviewer ignores SIGTERM", async () => {
  await assert.rejects(streamExecFile(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 100);"], { idleTimeout: 300, killGrace: 50, timeout: 3000 }), (cause) => cause.reason === "idle" && cause.signal === "SIGKILL");
});

test("PR head changes during code review preserve stale findings without posting", async (t) => {
  const { store, worktrees, execute, get, pr, postings } = codeFixture(t);
  const runner = new GoalReviews({ store, worktrees, execute: async (...args) => {
    const result = await execute(...args);
    if (args[0] === "ccs") pr.headRefOid = "c".repeat(40);
    return result;
  } });
  await runner.tick(); assert.equal(get().reviews[0].status, "stale"); assert.equal(postings(), 0);
});

test("a queued review whose target moved on before its turn is marked stale without running", async (t) => {
  const { store, worktrees, publish, get } = setup(t, { reviewer: true });
  publish();
  store.requestProposalChanges("goal", { generation: 1, revision: 1, feedback: "Cover the missing case" });
  let launched = 0;
  const runner = new GoalReviews({ store, worktrees, execute: async () => { launched++; return { stdout: "" }; } });
  await runner.tick();
  assert.equal(launched, 0);
  const review = get().reviews.find((entry) => entry.target === "1");
  assert.equal(review.status, "stale"); assert.match(review.error, /changed before review/);
});

test("an uncertain reviewer whose recorded process is dead is failed on reconcile so retry becomes available", async (t) => {
  const { store, worktrees, publish, get } = setup(t, { reviewer: true });
  publish();
  const claimed = store.outcomes.claim(get().reviews[0].id);
  store.outcomes.recordPid(claimed.id, claimed.attempt, 987_654);
  store.outcomes.finish(claimed.id, claimed.attempt, { status: "uncertain", error: "Lost track of the reviewer" });
  const stillRunning = new GoalReviews({ store, worktrees, processAlive: () => true });
  await assert.rejects(stillRunning.reconcile("goal", claimed.id), /still uncertain/);
  await assert.rejects(stillRunning.reconcile("other", claimed.id), /no uncertain action/);
  const runner = new GoalReviews({ store, worktrees, processAlive: () => false });
  await runner.reconcile("goal", claimed.id);
  assert.equal(get().reviews[0].status, "failed"); assert.match(get().reviews[0].error, /retry is available/);
  store.outcomes.retry("goal", claimed.id);
  assert.equal(get().reviews[0].status, "queued");
});

test("a posting owner that died before recording its process is resolved only by the exact saved comment", async (t) => {
  const { store, worktrees, execute, get, comments, postings, pr } = codeFixture(t);
  const runner = new GoalReviews({ store, worktrees, execute, processAlive: () => false });
  await runner.observeCode();
  const claimed = store.outcomes.claim(get().reviews[0].id);
  store.outcomes.finish(claimed.id, claimed.attempt, { status: "posting", result: "Saved critique" });
  assert.equal(store.outcomes.claimPost(claimed.id, claimed.attempt), true);
  store.outcomes.finish(claimed.id, claimed.attempt, { status: "uncertain", error: "Crashed between spawn and pid" });
  await assert.rejects(runner.reconcile("goal", claimed.id), /Posting dispatch remains uncertain/);
  assert.equal(postings(), 0, "no second comment is ever sent on a guess");
  assert.equal(get().reviews[0].status, "uncertain");
  comments.push({ body: `<!-- companion-review:${claimed.id} -->\n## Advisory code review\n\nReviewed commit: ${claimed.target}\n\nSaved critique` });
  await runner.reconcile("goal", claimed.id);
  assert.equal(get().reviews[0].status, "completed"); assert.equal(postings(), 0);
  // The same evidence on a moved head records the review as stale, not done.
  // A completed review is final, so the crashed owner is restored directly.
  store.outcomes.db.prepare("UPDATE goal_reviews SET status = 'uncertain', post_owner = 4242, post_pid = NULL WHERE id = ?").run(claimed.id);
  pr.headRefOid = "c".repeat(40);
  await runner.reconcile("goal", claimed.id);
  assert.equal(get().reviews[0].status, "stale");
});

test("a dead posting process with a recorded pid releases ownership and the post is retried once", async (t) => {
  const { store, worktrees, execute, get, postings } = codeFixture(t);
  const runner = new GoalReviews({ store, worktrees, execute, processAlive: () => false });
  await runner.observeCode();
  const claimed = store.outcomes.claim(get().reviews[0].id);
  store.outcomes.finish(claimed.id, claimed.attempt, { status: "posting", result: "Saved critique" });
  assert.equal(store.outcomes.claimPost(claimed.id, claimed.attempt), true);
  store.outcomes.recordPostPid(claimed.id, claimed.attempt, 987_654);
  store.outcomes.finish(claimed.id, claimed.attempt, { status: "uncertain", error: "Lost the posting process" });
  await runner.reconcile("goal", claimed.id);
  assert.equal(get().reviews[0].status, "completed"); assert.equal(postings(), 1);
  assert.equal(store.outcomes.review(claimed.id).postOwner, null);
});

test("a head that moves while comments are reconciled leaves the review stale and unposted", async (t) => {
  const { store, worktrees, execute, get, pr, postings } = codeFixture(t);
  const runner = new GoalReviews({ store, worktrees, execute: async (...args) => {
    const result = await execute(...args);
    if (args[0] === "gh" && args[1].at(-1) === "comments") pr.headRefOid = "d".repeat(40);
    return result;
  } });
  await runner.tick();
  assert.equal(get().reviews[0].status, "stale"); assert.match(get().reviews[0].error, /while reconciling comments/);
  assert.equal(postings(), 0);
  assert.equal(get().reviews[0].result, "Advisory: add a missing-input test.", "the findings are kept for the person");
});

test("reviewers stream their progress so a long silent review is not killed as idle", async (t) => {
  const args = reviewCommand({ provider: "codex", model: "gpt-5.6-sol" }, "/tmp/context.json");
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(args.includes("--verbose"), "stream-json needs --verbose to emit every event line");
  const { store, worktrees, publish, get } = setup(t, { reviewer: true }); publish();
  let options;
  const runner = new GoalReviews({ store, worktrees, execute: async (bin, _args, given) => {
    if (bin !== "ccs") return { stdout: "" };
    options = given;
    return { stdout: ['{"type":"assistant","message":{"content":[]}}', '{"type":"result","is_error":false,"result":"Advisory: fine"}', ""].join("\n") };
  } });
  await runner.tick();
  assert.equal(get().reviews[0].status, "completed"); assert.equal(get().reviews[0].result, "Advisory: fine");
  assert.equal(options.strictBuffer, undefined, "stream events are transport noise and must not fail the review by volume");
  assert.ok(options.maxBuffer >= 4 * 1024 * 1024);
});

test("a reviewer that is killed or exits non-zero reports why instead of 'Command failed'", async (t) => {
  const red = String.fromCharCode(27) + "[31m"; const reset = String.fromCharCode(27) + "[0m";
  const cases = [
    [{ killed: true, reason: "idle", signal: "SIGTERM" }, /stopped answering: no output for 3 minutes/],
    [{ killed: true, reason: "ceiling", signal: "SIGTERM" }, /ran for 15 minutes without finishing/],
    [{ killed: true, reason: "aborted", signal: "SIGTERM" }, /interrupted/],
    [{ code: 1, stderr: "[i] Preparing CLIProxy...\nERROR\nhttps://example.test/docs\nE301 Claude CLI not found" }, /cannot find the claude CLI/],
    [{ code: 2, stderr: `${red}Something specific broke${reset}\n` }, /could not run: Something specific broke/],
  ];
  for (const [failure, expected] of cases) {
    const { store, worktrees, publish, get } = setup(t, { reviewer: true }); publish();
    const runner = new GoalReviews({ store, worktrees, execute: async (bin) => { if (bin !== "ccs") return { stdout: "" }; throw Object.assign(new Error("Command failed"), failure); } });
    await runner.tick();
    assert.equal(get().reviews[0].status, "failed"); assert.match(get().reviews[0].error, expected);
  }
});
