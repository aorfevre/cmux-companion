import assert from "node:assert/strict";
import test from "node:test";

import { GoalSessionService } from "../server/goal-session-service.mjs";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";

test("starts one managed workspace and persists its uploaded goal context", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const calls = [];
  const service = new GoalSessionService({
    store,
    modelSettings: { roles: undefined },
    worktrees: {
      resolveRepository: async (id) => ({ id, name: "sample", primaryPath: "/repo/sample" }),
      create: async (id, options) => { calls.push(["create", id, options]); return { worktree: { path: "/repo/sample-goal" } }; },
    },
    cmux: {
      workspaceListDetailed: async () => ({ workspaces: [] }),
      workspaceCreate: async (options) => { calls.push(["workspace", options]); return { workspace_id: "workspace-goal" }; },
      workspaceStartGoalSessionRunner: async (id, options) => { calls.push(["runner", id, options]); },
    },
  });

  const plan = await service.start({
    repositoryId: "repo-1",
    goal: "Implement billing",
    images: [{ path: "/attachments/reference.png", name: "reference.png" }],
  });

  assert.equal(plan.workflow, "goal_session");
  assert.equal(plan.goalSessionWorkspaceId, "workspace-goal");
  assert.deepEqual(plan.images, [{ path: "/attachments/reference.png", name: "reference.png" }]);
  assert.equal(calls.filter(([kind]) => kind === "create").length, 1);
  const runner = calls.find(([kind]) => kind === "runner").slice(1);
  assert.equal(runner[0], "workspace-goal");
  assert.deepEqual({ planId: runner[1].planId, databasePath: runner[1].databasePath, generation: runner[1].generation }, { planId: plan.planId, databasePath: ":memory:", generation: 1 });
  assert.match(runner[1].dispatchId, /^[0-9a-f-]{36}$/);
});

test("rejects malformed goal-session image references before creating a worktree", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  let created = false;
  const service = new GoalSessionService({
    store,
    modelSettings: { roles: undefined },
    worktrees: { resolveRepository: async () => ({ id: "repo-1", name: "sample", primaryPath: "/repo/sample" }), create: async () => { created = true; } },
    cmux: {},
  });
  await assert.rejects(() => service.start({ repositoryId: "repo-1", goal: "Implement billing", images: [{ name: "missing path" }] }), /file path/);
  assert.equal(created, false);
});

test("records the worktree before cmux creates a workspace and recovers the exact workspace", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const calls = [];
  let pathAtWorkspaceCreate = null;
  const service = new GoalSessionService({
    store, modelSettings: { roles: undefined }, processAlive: () => false,
    worktrees: {
      resolveRepository: async (id) => ({ id, name: "sample", primaryPath: "/repo/sample" }),
      create: async (_id, options) => { calls.push(options); return { worktree: { path: "/repo/managed-goal" } }; },
    },
    cmux: {
      workspaceListDetailed: async () => ({ workspaces: [] }),
      workspaceCreate: async () => { pathAtWorkspaceCreate = store.list({ limit: 1 })[0]?.planId ? store.get(store.list({ limit: 1 })[0].planId)?.goalSessionWorktreePath : null; return { workspace_id: "workspace-goal" }; },
      workspaceStartGoalSessionRunner: async () => { throw new Error("runner transport failed"); },
    },
  });
  let planId = null;
  await assert.rejects(() => service.start({ repositoryId: "repo-1", goal: "Implement billing" }), (error) => { planId = error.planId; return /runner transport failed/.test(error.message); });
  assert.equal(pathAtWorkspaceCreate, "/repo/managed-goal");
  assert.equal(calls[0].useDefaultBase, true);
  const failed = store.get(planId);
  assert.equal(failed.goalSessionWorkspaceId, "workspace-goal");

  const restarted = [];
  service.cmux.workspaceStartGoalSessionRunner = async (...args) => { restarted.push(args); };
  await assert.rejects(() => service.recover(planId), /still uncertain/);
  // The cmux transport failure could have delivered the command, so ordinary
  // recovery refuses another writer. This simulates an operator proving it
  // never reached cmux before clearing the dispatch record.
  const dispatchId = store.get(planId).goalSessionRunnerDispatchId;
  assert.ok(dispatchId);
  store.releaseGoalSessionRunnerDispatch(planId, { generation: 1, dispatchId });
  const recovered = await service.recover(planId);
  assert.equal(recovered.goalSessionWorkspaceId, "workspace-goal");
  assert.equal(restarted.length, 1);
  assert.equal(restarted[0][0], "workspace-goal");
});

test("recovery queues a failed turn for its live owner without starting another runner", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  store.createPlan({ planId: "managed-plan", repositoryId: "repo", goal: "Ship billing" });
  store.reserveGoalSession("managed-plan", { branch: "goal-session/managed", generation: 1 });
  store.recordGoalSessionStart("managed-plan", { worktreePath: "/repo/managed", workspaceId: "workspace-managed", generation: 1 });
  store.publishProposal("managed-plan", { generation: 1, providerSessionId: "provider", proposal: { intendedBehavior: "Ship billing" } });
  store.requestProposalChanges("managed-plan", { generation: 1, revision: 1, feedback: "Keep exports stable." });
  store.consumeGoalSessionInput("managed-plan", { generation: 1 });
  store.recordGoalSessionInputFailure("managed-plan", { generation: 1, error: "provider timed out" });
  const dispatchId = "00000000-0000-4000-8000-000000000010";
  store.claimGoalSessionRunnerDispatch("managed-plan", { generation: 1, dispatchId });
  store.claimGoalSessionRunner("managed-plan", { generation: 1, dispatchId, pid: process.pid });
  let started = false;
  const service = new GoalSessionService({
    store, modelSettings: { roles: undefined }, processAlive: () => true,
    worktrees: {}, cmux: { workspaceStartGoalSessionRunner: async () => { started = true; } },
  });
  const recovered = await service.recover("managed-plan");
  assert.equal(started, false);
  assert.equal(recovered.goalSessionActiveInput, null);
  assert.equal(recovered.goalSessionPendingInput, "Keep exports stable.");
  assert.equal(recovered.goalSessionError, null);
});

test("restarts aborted discovery once, retaining context and moving GitHub ownership", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  let created = 0;
  const service = new GoalSessionService({ store, worktrees: {
    resolveRepository: async (id) => ({ id, name: "sample", primaryPath: "/repo/sample" }),
    create: async () => { created++; return { worktree: { path: "/repo/restarted" } }; },
  }, cmux: { workspaceListDetailed: async () => ({ workspaces: [] }), workspaceCreate: async () => ({ workspace_id: "fresh" }), workspaceStartGoalSessionRunner: async () => {} } });
  const source = store.createPlan({ planId: "old", repositoryId: "repo", goal: "Fix issue eight", issueNumbers: [8], issueUrls: ["https://github.com/example/sample/issues/8"], images: [{ path: "/attachments/shot.png", name: "shot.png" }], engine: { provider: "codex", model: "gpt-5.4", effort: "high", reviewer: true }, specOptions: { unitTests: true, edgeCases: true }, reviewOptions: { codeReview: true }, burst: true });
  await assert.rejects(() => service.restart("old"), /Abort the old goal/);
  assert.equal(created, 0);
  assert.equal(store.get("old").issuesReturnedAt, null);
  store.recordGoalAborted("old");
  const [first, repeated] = await Promise.all([service.restart("old"), service.restart("old")]);
  assert.equal(first.planId, repeated.planId);
  assert.equal(created, 1);
  assert.equal((await service.restart("old")).planId, first.planId);
  assert.equal(created, 1);
  assert.equal(first.workflow, "goal_session");
  for (const key of ["goal", "images", "specOptions", "issueNumbers", "issueUrls", "burst"]) assert.deepEqual(first[key], source[key]);
  assert.deepEqual(first.engine, source.engine);
  assert.equal(first.reviewOptions.codeReview, true);
  assert.equal(store.get("old").boardStatus, "aborted");
  assert.ok(store.get("old").issuesReturnedAt);
  assert.throws(() => store.createPlan({ planId: "duplicate", repositoryId: "repo", goal: "Duplicate", issueNumbers: [8] }), /already belongs/);
});

test("restart refuses live discovery owners and retains failed successors for recovery", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  let attempts = 0;
  const service = new GoalSessionService({ store, worktrees: {
    resolveRepository: async (id) => ({ id, name: "sample", primaryPath: "/repo/sample" }),
    create: async () => { attempts++; throw new Error("Checkout failed"); },
  }, cmux: { workspaceListDetailed: async () => ({ workspaces: [] }) } });
  store.createPlan({ planId: "old", repositoryId: "repo", goal: "Retry discovery" });
  store.reserveGoalSession("old", { branch: "old", generation: 1 });
  store.recordGoalSessionStart("old", { worktreePath: "/repo/old", workspaceId: "old-workspace", generation: 1 });
  store.recordGoalAborted("old");
  service.cmux.workspaceListDetailed = async () => ({ workspaces: [{ id: "old-workspace" }] });
  await assert.rejects(() => service.restart("old"), /Close the old discovery workspace/);
  assert.equal(attempts, 0);
  service.cmux.workspaceListDetailed = async () => ({ workspaces: [] });
  let failedId;
  await assert.rejects(() => service.restart("old"), (error) => { failedId = error.planId; return /Checkout failed/.test(error.message); });
  const saved = await service.restart("old");
  assert.equal(saved.planId, failedId);
  assert.match(saved.goalSessionError, /Checkout failed/);
  assert.equal(attempts, 1);
});

test("restart refuses terminal completions, development tasks and live runner PIDs", async () => {
  for (const [source, message] of [
    [{ boardStatus: "merged" }, /Abort the old goal/],
    [{ boardStatus: "aborted", tasks: [{ id: "T1", worktreePath: "/repo/task" }] }, /before development tasks/],
    [{ boardStatus: "aborted", status: "launched" }, /before development tasks/],
    [{ planId: "old", boardStatus: "aborted", goalSessionRunnerPid: 123 }, /still active/],
  ]) {
    const service = new GoalSessionService({ store: { get: (id) => id === "old" ? source : null }, worktrees: {}, cmux: {}, processAlive: () => true });
    await assert.rejects(() => service.restart("old"), message);
  }
});

test("continuing legacy discovery stops it once and preserves its full unapproved context", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" }); t.after(() => store.close());
  const source = store.createPlan({ planId: "legacy", repositoryId: "repo", goal: "Fix the old issue", images: [{ path: "/images/context.png", name: "context.png" }], issueNumbers: [8], engine: { provider: "codex", model: "gpt-6-astra", effort: "high", reviewer: true } });
  store.recordRound("legacy", { round: 1, stage: "ready", spec: { outcome: "Saved outcome" }, tasks: [{ id: "T1", title: "Saved task", branch: "old/t1", prompt: "Saved instructions", agent: "codex" }] });
  store.recordDiscussion("legacy", { question: "Keep history?", answer: "Yes", contractImpact: "none", round: 1 });
  let stopped = 0, started = 0;
  const service = new GoalSessionService({ store, worktrees: { resolveRepository: async (id) => ({ id, name: "Repo", primaryPath: "/repo" }), create: async () => { started++; return { worktree: { path: "/repo-new" } }; } }, cmux: { workspaceListDetailed: async () => ({ workspaces: [] }), workspaceCreate: async () => ({ workspace_id: "new" }), workspaceStartGoalSessionRunner: async () => {} }, stopGoal: async (id) => { stopped++; store.recordGoalAborted(id); return { failedSessionIds: [] }; } });
  const next = await service.continueDiscovery("legacy");
  assert.equal(next.workflow, "goal_session"); assert.equal(next.approvalRevision, null);
  assert.equal(next.discoveryContext.sourcePlanId, "legacy");
  assert.equal(next.discoveryContext.spec.outcome, "Saved outcome");
  assert.equal(next.discoveryContext.tasks[0].title, "Saved task");
  assert.equal(next.discoveryContext.discussion[0].answer, "Yes");
  assert.deepEqual(next.images, source.images); assert.deepEqual(next.issueNumbers, [8]);
  assert.equal(next.engine.reviewer, true);
  assert.equal(store.get("legacy").boardStatus, "aborted");
  assert.equal((await service.continueDiscovery("legacy")).planId, next.planId);
  assert.equal((await service.continueDiscovery(next.planId)).planId, next.planId);
  assert.equal(stopped, 1); assert.equal(started, 1);
});

test("failed stop never creates another writer or releases issue ownership", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" }); t.after(() => store.close());
  store.createPlan({ planId: "legacy", repositoryId: "repo", goal: "Keep work", issueNumbers: [8] });
  const service = new GoalSessionService({ store, worktrees: { resolveRepository: async () => ({ id: "repo" }), create: () => { throw new Error("Must not create"); } }, cmux: {}, stopGoal: async () => ({ failedSessionIds: ["old"] }) });
  await assert.rejects(() => service.continueDiscovery("legacy"), /could not be stopped/);
  assert.equal(store.get("legacy").issuesReturnedAt, null);
  assert.equal(store.list().length, 1);
});

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

// The goal form asks three questions that map to the contract: the outcome, what
// must not change, and how the user will know it worked. The last two are
// optional. They persist with the plan, reach the discovery prompt, and count
// in the idempotency identity so a retry with different answers is refused.
test("start persists the intake answers and puts them in the discovery prompt", async (t) => {
  const { goalDiscoveryPrompt } = await import("../server/goal-session-interactive.mjs");
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const service = new GoalSessionService({
    store,
    modelSettings: { roles: undefined },
    worktrees: { resolveRepository: async (id) => ({ id, name: "sample", primaryPath: "/repo/sample" }), create: async () => ({ worktree: { path: "/repo/sample-goal" } }) },
    cmux: { workspaceListDetailed: async () => ({ workspaces: [] }), workspaceCreate: async () => ({ workspace_id: "ws" }), workspaceStartGoalSessionRunner: async () => {} },
  });
  const key = "11111111-2222-4333-8444-555555555555";
  const plan = await service.start({ repositoryId: "repo-1", goal: "Add card payments", idempotencyKey: key,
    intake: { exclusions: " Do not touch the invoice PDF \n\nNo schema change ", verification: "A sandbox payment succeeds" } });
  assert.deepEqual(plan.intake, { exclusions: ["Do not touch the invoice PDF", "No schema change"], verification: ["A sandbox payment succeeds"] });
  assert.deepEqual(store.get(plan.planId).intake, plan.intake);
  const prompt = goalDiscoveryPrompt(store.get(plan.planId));
  assert.match(prompt, /must not change:\n- Do not touch the invoice PDF\n- No schema change/);
  assert.match(prompt, /know it worked:\n- A sandbox payment succeeds/);
  assert.match(prompt, /Confirm these with the user/);
  // The same key with the same answers is the same goal; different answers are not.
  assert.equal((await service.start({ repositoryId: "repo-1", goal: "Add card payments", idempotencyKey: key, intake: { exclusions: "Do not touch the invoice PDF\nNo schema change", verification: ["A sandbox payment succeeds"] } })).planId, plan.planId);
  await assert.rejects(() => service.start({ repositoryId: "repo-1", goal: "Add card payments", idempotencyKey: key, intake: { exclusions: "Something else" } }), /different goal/);
});

test("a goal with no intake answers stores an empty intake and an unchanged prompt", async (t) => {
  const { goalDiscoveryPrompt } = await import("../server/goal-session-interactive.mjs");
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const service = new GoalSessionService({
    store,
    modelSettings: { roles: undefined },
    worktrees: { resolveRepository: async (id) => ({ id, name: "sample", primaryPath: "/repo/sample" }), create: async () => ({ worktree: { path: "/repo/sample-goal" } }) },
    cmux: { workspaceListDetailed: async () => ({ workspaces: [] }), workspaceCreate: async () => ({ workspace_id: "ws" }), workspaceStartGoalSessionRunner: async () => {} },
  });
  const plan = await service.start({ repositoryId: "repo-1", goal: "Add card payments" });
  assert.deepEqual(plan.intake, { exclusions: [], verification: [] });
  assert.doesNotMatch(goalDiscoveryPrompt(store.get(plan.planId)), /must not change/);
  await assert.rejects(() => service.start({ repositoryId: "repo-1", goal: "x", intake: { exclusions: "a".repeat(5_000) } }), /intake/i);
});

// Approval delivery: the user never types "continue". One prompt reaches the
// recorded conversation; every blocker leaves the approval pending with a
// reason; a transport error is uncertain and never resent by itself.
function approvedFixture(t, { alive = true, workspaces = null, sendError = null } = {}) {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  store.createPlan({ planId: "goal", repositoryId: "repo", goal: "Ship billing" });
  store.reserveGoalSession("goal", { branch: "goal-session/goal", generation: 1 });
  store.recordGoalSessionStart("goal", { worktreePath: "/repo/goal", workspaceId: "ws-goal", generation: 1 });
  store.recordGoalSessionProviderSession("goal", { generation: 1, providerSessionId: "provider" });
  const dispatchId = "00000000-0000-4000-8000-000000000020";
  store.claimGoalSessionRunnerDispatch("goal", { generation: 1, dispatchId });
  store.claimGoalSessionRunner("goal", { generation: 1, dispatchId, pid: 4242 });
  store.publishProposal("goal", { generation: 1, providerSessionId: "provider", proposal: { intendedBehavior: "Ship billing" } });
  const sent = [];
  const cmux = {
    workspaceListDetailed: async () => ({ workspaces: workspaces ?? [{ id: "ws-goal", status: { signals: {} } }] }),
    sendWorkspacePrompt: async (workspaceId, text) => { sent.push([workspaceId, text]); if (sendError) throw new Error(sendError); },
  };
  const service = new GoalSessionService({ store, worktrees: { resolveRepository: async () => ({ id: "repo" }) }, cmux, processAlive: () => alive });
  return { store, service, sent, get: () => store.get("goal") };
}

test("approval sends exactly one prompt to the recorded conversation and the first write tool marks it delivered", async (t) => {
  const { service, sent, get, store } = approvedFixture(t);
  const plan = await service.approve("goal", { generation: 1, revision: 1 });
  assert.equal(plan.transitionStatus, "sent");
  assert.equal(plan.approvalDelivery.status, "sent"); assert.ok(plan.approvalDelivery.sentAt);
  assert.equal(sent.length, 1); assert.equal(sent[0][0], "ws-goal");
  assert.match(sent[0][1], /revision 1 of generation 1 is approved/); assert.match(sent[0][1], /get_status/);
  assert.ok(!sent[0][1].includes("Ship billing"), "the prompt carries no user or repository text");
  await assert.rejects(service.resendApproval("goal"), /already delivered/);
  await service.sweepApprovals(); assert.equal(sent.length, 1, "the sweep never sends a second prompt");
  assert.equal(store.claimGoalSessionTransition("goal", { generation: 1, revision: 1 }).transitionStatus, "dispatching");
  store.recordGoalSessionTransition("goal", { generation: 1, revision: 1 });
  assert.equal(get().transitionStatus, "delivered");
});

for (const [name, options, reason] of [
  ["a dead runner", { alive: false }, /conversation is closed/],
  ["a missing workspace", { workspaces: [] }, /no longer open in cmux/],
  ["an on-screen native prompt", { workspaces: [{ id: "ws-goal", status: { signals: { any_agent_needs_input: true } } }] }, /showing a prompt/],
]) test(`${name} leaves the approval pending with a reason and sends nothing`, async (t) => {
  const { service, sent, get } = approvedFixture(t, options);
  const plan = await service.approve("goal", { generation: 1, revision: 1 });
  assert.equal(plan.transitionStatus, "pending"); assert.match(plan.approvalDelivery.reason, reason);
  assert.equal(sent.length, 0);
  assert.equal(plan.approvalRevision, 1, "the approval itself is kept");
  await service.sweepApprovals(); assert.equal(sent.length, 0, "a deferred approval waits for an explicit resend");
  assert.equal(get().goalSessionState, "implementing");
});

test("resend delivers a deferred approval once the blocker is gone and refuses other states", async (t) => {
  const { service, sent, get } = approvedFixture(t, { workspaces: [] });
  await service.approve("goal", { generation: 1, revision: 1 });
  assert.equal(sent.length, 0);
  service.cmux.workspaceListDetailed = async () => ({ workspaces: [{ id: "ws-goal", status: { signals: {} } }] });
  const plan = await service.resendApproval("goal");
  assert.equal(plan.transitionStatus, "sent"); assert.equal(plan.approvalDelivery.reason, null); assert.equal(sent.length, 1);
  await assert.rejects(service.resendApproval("goal"), /already delivered/);
  assert.equal(get().transitionStatus, "sent");
});

test("a transport failure is uncertain, not retried, and blocks resend", async (t) => {
  const { service, sent, get } = approvedFixture(t, { sendError: "socket closed" });
  const plan = await service.approve("goal", { generation: 1, revision: 1 });
  assert.equal(plan.transitionStatus, "uncertain"); assert.match(plan.approvalDelivery.error, /socket closed/); assert.match(plan.goalSessionError, /may not have reached/);
  assert.equal(sent.length, 1);
  await assert.rejects(service.resendApproval("goal"), /uncertain/);
  await service.sweepApprovals(); assert.equal(sent.length, 1);
  assert.equal(get().transitionStatus, "uncertain");
});

test("abort or a change request between claim and send cancels delivery, and a crash before send is resent once by the sweep", async (t) => {
  const { service, sent, get, store } = approvedFixture(t);
  service.cmux.workspaceListDetailed = async () => { store.recordGoalAborted("goal"); return { workspaces: [{ id: "ws-goal", status: { signals: {} } }] }; };
  const aborted = await service.approve("goal", { generation: 1, revision: 1 });
  assert.equal(aborted.boardStatus, "aborted"); assert.equal(sent.length, 0);
  assert.equal(get().transitionStatus, "sending", "an aborted goal keeps its last record and is never delivered");
  await service.sweepApprovals(); assert.equal(sent.length, 0);

  const second = approvedFixture(t);
  second.store.approveProposal("goal", { generation: 1, revision: 1 });
  // Simulate a crash after the claim: the record says sending but nothing was sent.
  second.store.claimApprovalDelivery("goal", { generation: 1, revision: 1, dispatchId: "00000000-0000-4000-8000-000000000099" });
  await second.service.sweepApprovals(); assert.equal(second.sent.length, 0, "a sending claim is owned; the sweep does not race it");
  second.store.deferApprovalDelivery("goal", { generation: 1, revision: 1, dispatchId: "00000000-0000-4000-8000-000000000099", reason: "" });
  assert.equal(second.get().transitionStatus, "pending");
  second.store.db.prepare("UPDATE plans SET approval_delivery = NULL WHERE plan_id = 'goal'").run();
  await second.service.sweepApprovals(); assert.equal(second.sent.length, 1, "a fresh pending approval is delivered once by the sweep");
  await second.service.sweepApprovals(); assert.equal(second.sent.length, 1);
});

test("a duplicate approve request cannot send twice and a delivered transition is never demoted", async (t) => {
  const { service, sent, store, get } = approvedFixture(t);
  await service.approve("goal", { generation: 1, revision: 1 });
  await assert.rejects(service.approve("goal", { generation: 1, revision: 1 }), /no longer current|already approved/);
  assert.equal(sent.length, 1);
  store.claimGoalSessionTransition("goal", { generation: 1, revision: 1 });
  store.recordGoalSessionTransition("goal", { generation: 1, revision: 1 });
  assert.equal(store.recordApprovalDelivery("goal", { generation: 1, revision: 1, dispatchId: get().approvalDelivery.dispatchId }).transitionStatus, "delivered");
});
