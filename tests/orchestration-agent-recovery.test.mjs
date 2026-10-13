import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, BASE, contract } from './helpers/orchestration/domain-fixture.mjs';
import { newRecoveryPolicy, recoveryStatus, adoptionSpending } from '../server/orchestration/domain/agent-recovery.mjs';
import { transition } from '../server/orchestration/domain/transitions.mjs';
import { readyWork } from '../server/orchestration/domain/scheduling.mjs';
import { goalView } from '../server/orchestration/domain/state-view.mjs';
import { attention } from '../server/notifications/service.mjs';

function enabled({ approved = true } = {}) {
  const f = fixture();
  if (approved) f.approve();
  f.goal.experienceVersion = 2;
  f.goal.conversation = { messages: [], supervisorAttemptId: null, wake: 1, seenWake: 0, waiting: false, paused: false, dispatchApproved: true };
  f.command('adopt_agent_recovery', {}, f.user);
  return f;
}
function stopped(f, id = 'worker') {
  f.request(id, 'implementer', 'A'); f.dispatch(id);
  f.command('record_stopped', { attemptId: id });
}
function schedule(f, now = 1000) {
  f.command('schedule_goal_recovery', { now });
  return f.goal.recoveryPolicy.decisions.at(-1);
}
function apply(f, decision = f.goal.recoveryPolicy.decisions.at(-1)) {
  return f.command('apply_goal_recovery', { decisionId: decision.id, now: decision.dueAt });
}

test('new conversational goals snapshot the default policy; original goals retain their contract', () => {
  const f = fixture(); assert.equal(f.goal.recoveryPolicy, undefined);
  const result = transition(null, { id: 'create', goalId: 'new', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'Build', baseSha: BASE, experienceVersion: 2 } }, f.user);
  assert.deepEqual(result.goal.recoveryPolicy, newRecoveryPolicy());
  assert.throws(() => f.command('adopt_agent_recovery', {}, f.user), /configured conversational supervisor/);
});

test('stopped worker recovery reserves budget once, waits for its due time and retains evidence', () => {
  const f = enabled(); stopped(f);
  const hold = structuredClone(f.goal.hold), previous = structuredClone(f.goal.attempts);
  assert.equal(recoveryStatus(f.goal).state, 'ready');
  const decision = schedule(f);
  assert.equal(decision.dueAt, 6000); assert.equal(recoveryStatus(f.goal).remaining, 11);
  assert.throws(() => schedule(f), { code: 'NOT_READY' });
  assert.throws(() => f.command('apply_goal_recovery', { decisionId: decision.id, now: 5999 }), { code: 'NOT_READY' });
  apply(f, decision);
  assert.equal(f.goal.hold, null); assert.deepEqual(f.goal.recoveries[0].hold, hold);
  assert.deepEqual(f.goal.attempts, previous);
  assert.equal(f.goal.tasks[0].status, 'pending');
  assert.equal(f.goal.recoveryPolicy.decisions[0].state, 'applied');
  assert.ok(readyWork(f.goal).some(work => work.role === 'implementer' && work.taskId === 'A'));
  assert.throws(() => apply(f, decision), { code: 'NOT_READY' });
});

test('every recovery mutation validates its authority', () => {
  const f = enabled(); stopped(f);
  assert.throws(() => f.command('schedule_goal_recovery', { now: 1 }, f.user), { code: 'FORBIDDEN' });
  const decision = schedule(f);
  assert.throws(() => f.command('apply_goal_recovery', { decisionId: decision.id, now: decision.dueAt }, f.user), { code: 'FORBIDDEN' });
  assert.throws(() => f.command('extend_recovery_budget', { limit: 12 }), { code: 'FORBIDDEN' });
  assert.throws(() => f.command('adopt_agent_recovery', {}), { code: 'FORBIDDEN' });
  assert.throws(() => f.command('supervisor_recovery_strategy', { strategy: 'retry' }, f.user), { code: 'FORBIDDEN' });
});

for (const [name, change, expected] of [
  ['paused', g => { g.conversation.paused = true; }, 'waiting'],
  ['unknown worker', g => { g.attempts.at(-1).workerState = 'unknown'; }, 'waiting'],
  ['late result', g => { g.results = [{ id: 'late', status: 'pending' }]; }, 'waiting'],
  ['unsettled check', g => { g.verificationRuns = [{ workerState: 'unknown' }]; }, 'waiting'],
  ['authentication', g => { g.attempts.at(-1).failureCode = 'CMUX_AUTH_REJECTED'; }, 'blocked'],
  ['unclassified failure', g => { delete g.attempts.at(-1).failureCode; g.attempts.at(-1).status = 'failed'; }, 'blocked'],
  ['question', g => { g.clarification = { question: 'Which API?' }; }, 'blocked'],
  ['external effect', g => { g.hold.reasons.push({ kind: 'publication', target: 'push', message: 'Unknown' }); }, 'blocked'],
  ['episode exhaustion', g => { g.recoveryPolicy.priorSpent = 3; g.recoveryPolicy.priorEpisodes = { 'revision:1:implementer:A': 3 }; }, 'blocked'],
  ['goal exhaustion', g => { g.recoveryPolicy.priorSpent = 12; }, 'blocked'],
]) test(`recovery refuses ${name} without spending budget`, () => {
  const f = enabled(); stopped(f); change(f.goal);
  assert.equal(recoveryStatus(f.goal).state, expected);
  assert.throws(() => schedule(f), { code: 'NOT_READY' });
  assert.equal(f.goal.recoveryPolicy.decisions.length, 0);
});

test('unchanged failures require a changed strategy and never reset their ledger', () => {
  const f = enabled();
  stopped(f, 'one'); apply(f, schedule(f));
  stopped(f, 'two');
  assert.equal(recoveryStatus(f.goal).state, 'strategy');
  assert.throws(() => schedule(f), { code: 'NOT_READY' });
  f.goal.recoveryPolicy.strategy = { holdId: f.goal.hold.id, strategy: 'reconstruct', rationale: 'Rebuild context from the saved result validation evidence.' };
  const second = schedule(f); assert.equal(second.dueAt, 16000); apply(f, second);
  stopped(f, 'three');
  const third = schedule(f); assert.equal(third.dueAt, 46000); apply(f, third);
  stopped(f, 'four');
  assert.match(recoveryStatus(f.goal).reason, /budget is exhausted/);
  f.command('extend_recovery_budget', { limit: 12 }, f.user);
  assert.equal(f.goal.recoveryPolicy.limit, 15); assert.equal(f.goal.recoveryPolicy.episodeLimit, 4);
  assert.equal(f.goal.recoveryPolicy.decisions.length, 3);
});

test('changed mixed evidence supersedes a reservation without refunding it', () => {
  const f = enabled(); stopped(f); schedule(f);
  f.goal.hold.reasons.push({ kind: 'attempt', target: 'missing', message: 'Unknown worker' });
  assert.equal(recoveryStatus(f.goal).state, 'blocked');
  assert.throws(() => apply(f), { code: 'NOT_READY' });
  f.goal.hold.reasons.pop(); f.goal.attempts.at(-1).failureCode = 'EXIT_FAILED';
  assert.equal(recoveryStatus(f.goal).state, 'ready'); schedule(f);
  assert.equal(f.goal.recoveryPolicy.decisions[0].state, 'superseded');
  assert.equal(f.goal.recoveryPolicy.decisions.length, 1);
  schedule(f); assert.equal(f.goal.recoveryPolicy.decisions.length, 2);
});

test('stopped supervisor and worker recover together from their durable conversation', () => {
  const f = enabled(); f.request('supervisor', 'planner'); f.dispatch('supervisor');
  stopped(f); f.command('record_stopped', { attemptId: 'supervisor', failureCode: 'SUPERVISOR_TURN_TIMEOUT' });
  const conversation = structuredClone(f.goal.conversation.messages);
  const decision = schedule(f); assert.equal(decision.evidence.length, 2); apply(f, decision);
  assert.equal(f.goal.attempts.find(attempt => attempt.id === 'supervisor').retryRequested, true);
  assert.deepEqual(f.goal.conversation.messages.slice(0, conversation.length), conversation);
  assert.ok(readyWork(f.goal).some(work => work.role === 'planner'));
});

test('rejected plan plus stopped supervisor revise autonomously and still require user approval', () => {
  const f = enabled({ approved: false });
  f.command('publish_contract', { contract: contract() }, f.user);
  f.request('supervisor', 'planner'); f.dispatch('supervisor');
  f.request('review', 'reviewer'); f.dispatch('review'); f.review('review', `contract:${f.goal.generation}:${f.goal.revision}`, true);
  f.command('record_stopped', { attemptId: 'supervisor', failureCode: 'NATIVE_TERMINAL_FAILED' });
  const decision = schedule(f); assert.equal(decision.strategy, 'repair'); apply(f, decision);
  assert.equal(f.goal.status, 'discovering'); assert.equal(f.goal.approvedRevision, null);
  assert.equal(f.goal.planRevisionCount, 1); assert.equal(f.goal.hold, null);
  assert.equal(f.goal.recoveries[0].hold.reasons.length, 2);
  assert.throws(() => f.command('approve', { revision: f.goal.revision }), { code: 'FORBIDDEN' });
});

test('adoption counts prior automatic repairs and refuses duplicate adoption', () => {
  const f = enabled();
  f.goal.tasks[0].repairCount = 2; f.goal.planRevisionCount = 1;
  f.goal.recoveries = [{}, {}, {}];
  f.goal.attempts[0].launchFailure = { scheduled: true };
  assert.equal(adoptionSpending(f.goal), 4);
  assert.throws(() => f.command('adopt_agent_recovery', {}, f.user), { code: 'NOT_READY' });
});

test('adoption does not give repeated historical attempts a fresh zero budget', () => {
  const f = enabled(); stopped(f);
  const old = f.goal.attempts.at(-1);
  for (let i = 0; i < 4; i++) f.goal.attempts.push({ ...old, id: `historical-${i}`, operationId: `historical-${i}` });
  assert.equal(adoptionSpending(f.goal), 4);
});

test('a stopped supervisor can diagnose repeated failures without releasing workers or resetting spending', () => {
  const f = enabled();
  stopped(f, 'one'); apply(f, schedule(f)); stopped(f, 'two');
  f.command('schedule_recovery_diagnosis', { now: 1000 });
  const decision = f.goal.recoveryPolicy.decisions.at(-1);
  assert.equal(decision.purpose, 'diagnosis'); apply(f, decision);
  assert.ok(f.goal.hold); assert.equal(f.goal.recoveryPolicy.decisions.length, 2);
  assert.deepEqual(readyWork(f.goal).map(entry => entry.role), ['planner']);
  assert.throws(() => f.request('forbidden', 'implementer', 'A'), { code: 'NOT_READY' });
  f.request('diagnosis', 'planner'); f.dispatch('diagnosis');
  const planner = f.goal.attempts.at(-1);
  const authority = { kind: 'agent', goalId: f.goal.id, attemptId: planner.id, role: 'planner', generation: planner.generation, revision: planner.revision };
  assert.throws(() => f.command('supervisor_recovery_strategy', { holdId: f.goal.hold.id, strategy: 'retry', rationale: 'Try again' }, authority), { code: 'NOT_READY' });
  f.command('supervisor_recovery_strategy', { holdId: f.goal.hold.id, strategy: 'reconstruct', rationale: 'Reconstruct the result protocol from the saved validation evidence before resubmission.' }, authority);
  apply(f, schedule(f)); assert.equal(f.goal.hold, null);
  assert.equal(f.goal.recoveryPolicy.decisions.length, 3);
  assert.equal(f.goal.recoveryPolicy.diagnosisHoldId, undefined);
});

test('automatic recovery stays Active and quiet; setup blockers retain a specific action', () => {
  const f = enabled(); stopped(f);
  const view = goalView(f.goal);
  assert.equal(view.decision.rank, 1); assert.equal(view.decision.stage, 'Recovering');
  assert.equal(view.decision.primary, null); assert.equal(attention(f.goal), null);
  assert.ok(!view.actions.some(action => action.type === 'recover_goal'));
  f.goal.attempts.at(-1).failureCode = 'CMUX_SOCKET_MISSING';
  const blocked = goalView(f.goal);
  assert.equal(blocked.decision.rank, 0); assert.match(blocked.decision.reason, /CMUX_SOCKET_MISSING/);
  assert.ok(attention(f.goal)); assert.equal(blocked.decision.primary.type, 'recover_goal');
});

test('old conversational goals keep manual recovery until the explicit adoption action', () => {
  const f = enabled(); delete f.goal.recoveryPolicy; stopped(f);
  let view = goalView(f.goal);
  assert.equal(view.decision.primary.type, 'recover_goal');
  const adoption = view.actions.find(action => action.type === 'adopt_agent_recovery');
  f.command(adoption.type, adoption.payload, f.user);
  view = goalView(f.goal); assert.equal(view.decision.primary, null);
  assert.equal(view.recovery.state, 'ready'); assert.equal(view.approvedRevision, f.goal.revision);
});

test('failed integrated checks recover as repair while retaining exact-head evidence', () => {
  const f = enabled();
  f.goal.tasks.forEach(task => { task.status = 'integrated'; task.integratedSha = BASE; });
  f.command('request_verification', { operationId: 'checks' });
  f.command('record_verification_result', { operationId: 'checks', result: { workerState: 'stopped', artifactId: 'f'.repeat(64), verification: { headSha: BASE, checks: [{ id: 'unit', passed: false, artifactId: 'e'.repeat(64), code: 'EXIT_FAILED' }] } } });
  const evidence = structuredClone(f.goal.verification);
  apply(f, schedule(f));
  assert.deepEqual(f.goal.verification, evidence);
  assert.ok(readyWork(f.goal).some(entry => entry.role === 'integrator'));
  assert.throws(() => f.command('request_publication', { operationId: 'forbidden' }), { code: 'NOT_READY' });
});

test('pause and abort fence an already reserved recovery without refunding its budget', () => {
  const f = enabled(); stopped(f); const decision = schedule(f);
  f.command('pause_goal', {}, f.user);
  assert.throws(() => apply(f, decision), { code: 'NOT_READY' });
  assert.equal(f.goal.recoveryPolicy.decisions.length, 1);
  f.command('resume_goal', {}, f.user); f.command('abort', {}, f.user);
  assert.throws(() => apply(f, decision), { code: 'TERMINAL_GOAL' });
  assert.equal(f.goal.recoveryPolicy.decisions[0].state, 'superseded');
  assert.deepEqual(readyWork(f.goal), []);
});

test('a confirmed stopped accepted worker releases its old ownership hold without repeating successful work', () => {
  const f = enabled(); stopped(f);
  f.goal.attempts.at(-1).status = 'succeeded'; f.goal.tasks[0].status = 'in_review'; f.goal.tasks[0].candidateSha = BASE;
  delete f.goal.attempts.at(-1).failureCode;
  apply(f, schedule(f));
  assert.equal(f.goal.tasks[0].status, 'in_review');
  assert.ok(!readyWork(f.goal).some(work => work.role === 'implementer' && work.taskId === 'A'));
});

test('one explicit budget decision can admit recovery after substantial adopted history without resetting spending', () => {
  const f = enabled(); stopped(f); f.goal.recoveryPolicy.priorSpent = 20;
  f.command('extend_recovery_budget', { limit: 12 }, f.user);
  assert.equal(f.goal.recoveryPolicy.priorSpent, 20);
  assert.equal(f.goal.recoveryPolicy.limit, 23);
  assert.equal(recoveryStatus(f.goal).state, 'ready');
});

for (const code of ['NATIVE_TERMINAL_FAILED', 'OUTPUT_LIMIT']) test(`confirmed stopped ${code} recovers within the same bounded policy`, () => {
  const f = enabled(); stopped(f); f.goal.attempts.at(-1).failureCode = code;
  assert.equal(recoveryStatus(f.goal).state, 'ready');
  apply(f, schedule(f));
  assert.equal(f.goal.recoveryPolicy.decisions.length, 1);
  assert.equal(f.goal.hold, null);
});

test('historical spending stays goal-wide and only charges the work episode that incurred it', () => {
  const f = enabled(); stopped(f);
  delete f.goal.recoveryPolicy.priorEpisodes;
  f.goal.recoveryPolicy.priorSpent = 4;
  const original = f.goal.attempts.at(-1);
  for (let i = 0; i < 5; i++) f.goal.attempts.push({ ...original, id: `previous-${i}`, revision: 0, generation: 1 });
  f.command('attribute_recovery_history', {});
  assert.equal(f.goal.recoveryPolicy.priorSpent, 4);
  assert.equal(recoveryStatus(f.goal).state, 'ready', 'an unrelated revision does not exhaust current work');
  assert.equal(f.goal.recoveryPolicy.priorEpisodes['planning:implementer:A'], 4);
  assert.throws(() => f.command('attribute_recovery_history', {}), { code: 'NOT_READY' });
});

test('historical attribution cannot reset spending after new policy recovery decisions', () => {
  const f = enabled(); stopped(f); schedule(f); delete f.goal.recoveryPolicy.priorEpisodes;
  assert.throws(() => f.command('attribute_recovery_history', {}), { code: 'NOT_READY' });
  assert.throws(() => f.command('attribute_recovery_history', {}, f.user), { code: 'FORBIDDEN' });
});

test('unattributable adoption history still needs an explicit budget decision', () => {
  const f = enabled(); stopped(f);
  delete f.goal.recoveryPolicy.priorEpisodes;
  f.goal.recoveries = [{}, {}, {}, {}];
  f.command('attribute_recovery_history', {});
  assert.equal(f.goal.recoveryPolicy.priorSpent, 4);
  assert.equal(recoveryStatus(f.goal).state, 'blocked');
  f.command('extend_recovery_budget', { limit: 12 }, f.user);
  assert.equal(recoveryStatus(f.goal).state, 'ready');
  assert.equal(f.goal.recoveryPolicy.priorSpent, 4);
});

test('recorded spending without matching history cannot become a fresh episode allowance', () => {
  const f = enabled(); stopped(f);
  delete f.goal.recoveryPolicy.priorEpisodes; f.goal.recoveryPolicy.priorSpent = 4;
  f.command('attribute_recovery_history', {});
  assert.deepEqual(f.goal.recoveryPolicy.priorEpisodes, { '*': 4 });
  assert.equal(recoveryStatus(f.goal).state, 'blocked');
});

test('historical review and check receipts remain charged to their own episodes', () => {
  const f = enabled(); stopped(f);
  delete f.goal.recoveryPolicy.priorEpisodes;
  const worker = f.goal.attempts.at(-1);
  f.goal.reviews.push({ id: 'old-review', attemptId: worker.id, kind: 'task', taskId: 'A' });
  f.goal.verificationRuns = [{ operationId: 'old-check', revision: 1, attemptId: worker.id }];
  f.goal.recoveries = [
    { hold: { reasons: [{ kind: 'review', target: 'old-review' }] } },
    { hold: { reasons: [{ kind: 'verification', target: 'old-check' }] } },
  ];
  f.command('attribute_recovery_history', {});
  assert.equal(f.goal.recoveryPolicy.priorSpent, 2);
  assert.equal(f.goal.recoveryPolicy.priorEpisodes['revision:1:review:task:A'], 1);
  assert.equal(f.goal.recoveryPolicy.priorEpisodes['revision:1:checks:A'], 1);
  assert.equal(f.goal.recoveryPolicy.priorEpisodes['revision:1:implementer:A'], 0);
});


test('pre-approval reviewer retries consume the planning episode budget', () => {
  const f = enabled({ approved: false });
  f.command('publish_contract', { contract: contract() }, f.user);
  f.request('reviewer', 'reviewer'); f.dispatch('reviewer');
  f.command('record_stopped', { attemptId: 'reviewer' });
  const attempt = f.goal.attempts.at(-1);
  attempt.failureCode = 'NATIVE_TERMINAL_FAILED';
  assert.equal(attempt.revision, 1);
  assert.equal(f.goal.approvedRevision, null);
  for (let i = 0; i < 3; i++) f.goal.attempts.push({ ...attempt, id: `old-reviewer-${i}` });
  delete f.goal.recoveryPolicy.priorEpisodes;
  f.command('attribute_recovery_history', {});
  assert.equal(f.goal.recoveryPolicy.priorEpisodes['planning:reviewer:'], 3);
  assert.equal(f.goal.recoveryPolicy.priorSpent, 3);
  assert.equal(recoveryStatus(f.goal).state, 'blocked');
});
