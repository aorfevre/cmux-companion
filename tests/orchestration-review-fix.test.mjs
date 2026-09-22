import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReviewThreads, parseReviewReplies, activeReviewRound, reviewRoundPhase } from '../server/orchestration/domain/review-round.mjs';
import { readyWork } from '../server/orchestration/domain/scheduling.mjs';
import { parseRoleResult } from '../server/orchestration/domain/role-result.mjs';
import { goalView } from '../server/orchestration/domain/state-view.mjs';
import { actionView } from '../server/orchestration/domain/action-view.mjs';
import { assignmentFor } from '../server/orchestration/domain/teams.mjs';
import { USER_COMMANDS } from '../server/orchestration/domain/commands.mjs';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { OrchestrationService } from '../server/orchestration/service.mjs';
import { ReviewFixCoordinator } from '../server/orchestration/review-fix-coordinator.mjs';
import { fixture, HEAD_B } from './helpers/orchestration/domain-fixture.mjs';
import { DomainError } from '../server/orchestration/domain/contracts.mjs';

const fails = (fn, code) => assert.throws(fn, code ? (error) => error.code === code : undefined);

const thread = (id, extra = {}) => ({ id, path: 'src/a.mjs', line: 3, author: 'coderabbitai', body: 'Do not intercept non-file drops.', isBot: true, ...extra });

test('review threads are bounded, unique and literal', () => {
  const parsed = parseReviewThreads([thread('PRRT_1'), thread('PRRT_2', { line: null, isBot: false, author: 'alex' })]);
  assert.equal(parsed.length, 2); assert.equal(parsed[1].line, null); assert.equal(parsed[1].isBot, false);
  assert.throws(() => parseReviewThreads([thread('PRRT_1'), thread('PRRT_1')]), /Duplicate/);
  assert.throws(() => parseReviewThreads([thread('PRRT_1', { path: '../x' })]));
  assert.throws(() => parseReviewThreads([thread('PRRT_1', { extra: true })]));
  assert.throws(() => parseReviewThreads(Array.from({ length: 201 }, (_, index) => thread(`PRRT_${index}`))));
});

test('replies cover every thread exactly once with a known action', () => {
  const threads = parseReviewThreads([thread('PRRT_1'), thread('PRRT_2')]);
  const ok = parseReviewReplies([{ threadId: 'PRRT_1', action: 'fixed', body: 'Fixed in this commit.' }, { threadId: 'PRRT_2', action: 'declined', body: 'Out of scope.' }], threads);
  assert.equal(ok.length, 2);
  assert.throws(() => parseReviewReplies([{ threadId: 'PRRT_1', action: 'fixed', body: 'x' }], threads), /every thread/);
  assert.throws(() => parseReviewReplies([{ threadId: 'PRRT_1', action: 'fixed', body: 'x' }, { threadId: 'PRRT_1', action: 'fixed', body: 'x' }], threads), /Duplicate/);
  assert.throws(() => parseReviewReplies([{ threadId: 'PRRT_1', action: 'fixed', body: 'x' }, { threadId: 'PRRT_9', action: 'fixed', body: 'x' }], threads), /Unknown thread/);
  assert.throws(() => parseReviewReplies([{ threadId: 'PRRT_1', action: 'merge', body: 'x' }, { threadId: 'PRRT_2', action: 'fixed', body: 'x' }], threads), /action/);
});

test('phase labels follow the round state', () => {
  assert.equal(activeReviewRound({ status: 'delivered' }), null);
  const round = { id: 'r1', prHeadSha: 'a'.repeat(40), threads: [thread('PRRT_1')], state: 'fixing', startedAt: 1 };
  assert.equal(activeReviewRound({ status: 'addressing_review', reviewRound: round }), round);
  assert.equal(reviewRoundPhase({ ...round, state: 'fetching' }), 'Fetching review threads');
  assert.equal(reviewRoundPhase(round), 'Fixing 1 thread');
  assert.equal(reviewRoundPhase({ ...round, state: 'verifying' }), 'Verifying fix');
  assert.equal(reviewRoundPhase({ ...round, state: 'pushing' }), 'Pushing and replying');
  assert.equal(reviewRoundPhase({ ...round, state: 'replying' }), 'Pushing and replying');
});

const HEAD_C = 'd'.repeat(40);
const threads = () => [thread('PRRT_1'), thread('PRRT_2', { isBot: false, author: 'alex' })];
const replies = (action = 'fixed') => [{ threadId: 'PRRT_1', action, body: 'Reply one.' }, { threadId: 'PRRT_2', action: 'declined', body: 'Reply two.' }];

test('a review round is offered only to a delivered goal with an open pull request and settled workers', () => {
  const f = fixture();
  fails(() => f.command('request_review_fix', {}, f.user), 'NOT_READY');
  f.deliver();
  fails(() => f.command('request_review_fix', {}), 'FORBIDDEN');
  const before = f.goal.generation;
  const started = f.command('request_review_fix', {}, f.user);
  assert.equal(f.goal.status, 'addressing_review'); assert.equal(f.goal.generation, before + 1);
  assert.equal(started.events.at(-1).kind, 'review_fix_requested');
  assert.equal(f.goal.reviewRound.state, 'fetching'); assert.equal(f.goal.reviewRound.prHeadSha, HEAD_B);
  fails(() => f.command('request_review_fix', {}, f.user), 'NOT_READY');
  fails(() => f.command('request_revision', { message: 'Change it' }, f.user), 'INVALID_STATE');
});

test('a closed pull request and a terminal goal refuse a round', () => {
  const f = fixture(); f.deliver();
  f.command('record_merge_sync', { number: 1, url: 'https://example.test/pr/1', state: 'closed', checkedAt: 5 });
  fails(() => f.command('request_review_fix', {}, f.user), 'NOT_READY');
  const g = fixture(); g.deliver(); g.command('record_merged');
  fails(() => g.command('request_review_fix', {}, g.user), 'TERMINAL_GOAL');
});

test('zero threads settle the round at once and an unavailable read fails it with a hold', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  f.command('record_review_threads', { roundId: f.goal.reviewRound.id, threads: [], mergeable: 'mergeable' });
  assert.equal(f.goal.status, 'delivered'); assert.equal(f.goal.reviewRound, null);
  assert.equal(f.goal.reviewRounds[0].outcome, 'nothing_to_address');
  const g = fixture(); g.deliver(); g.command('request_review_fix', {}, g.user);
  g.command('fail_review_fix', { roundId: g.goal.reviewRound.id, code: 'GITHUB_UNAVAILABLE', message: 'GitHub review threads were unavailable.' });
  assert.equal(g.goal.status, 'addressing_review'); assert.equal(g.goal.reviewRound.state, 'failed');
  assert.equal(g.goal.hold.reasons[0].kind, 'review_fix');
  g.recover();
  assert.equal(g.goal.status, 'delivered'); assert.equal(g.goal.reviewRounds[0].outcome, 'failed'); assert.equal(g.goal.pr.headSha, HEAD_B);
});

test('threads move the round to fixing and expose review_fixer work at the pull request head', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  f.command('record_review_threads', { roundId: f.goal.reviewRound.id, threads: threads(), mergeable: 'mergeable' });
  assert.equal(f.goal.reviewRound.state, 'fixing');
  assert.deepEqual(readyWork(f.goal).map((entry) => [entry.role, entry.target]), [['review_fixer', HEAD_B]]);
  f.request('fx', 'review_fixer'); const attempt = f.goal.attempts.at(-1);
  assert.equal(attempt.baseSha, HEAD_B); assert.equal(attempt.target, HEAD_B); assert.equal(attempt.mode, 'background');
  assert.equal(f.goal.reviewRound.attemptId, 'fx');
  assert.equal(readyWork(f.goal).length, 0);
  fails(() => f.request('fx2', 'review_fixer'), 'ALREADY_RUNNING');
});

test('a fix result with a new head needs verification; replies only skip to replying', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  f.command('record_review_threads', { roundId: f.goal.reviewRound.id, threads: threads(), mergeable: 'mergeable' });
  f.request('fx', 'review_fixer'); f.dispatch('fx');
  fails(() => f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_B, summary: 's', replies: replies('fixed') }), 'STALE_TARGET');
  fails(() => f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 's', replies: replies('declined') }), 'STALE_TARGET');
  fails(() => f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 's', replies: [replies()[0]] }));
  f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 'Fixed drop handling', replies: replies('fixed') });
  assert.equal(f.goal.reviewRound.state, 'verifying'); assert.equal(f.goal.reviewRound.fixHeadSha, HEAD_C);
  assert.equal(f.goal.attempts.at(-1).status, 'succeeded');
  const g = fixture(); g.deliver(); g.command('request_review_fix', {}, g.user);
  g.command('record_review_threads', { roundId: g.goal.reviewRound.id, threads: threads(), mergeable: 'mergeable' });
  g.request('fx', 'review_fixer'); g.dispatch('fx');
  g.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_B, summary: 'No code change', replies: replies('comment') });
  assert.equal(g.goal.reviewRound.state, 'replying'); assert.equal(g.goal.reviewRound.fixHeadSha, undefined);
});

test('verification of the fix head gates the push and a failed check holds the goal', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  f.command('record_review_threads', { roundId, threads: threads(), mergeable: 'mergeable' });
  f.request('fx', 'review_fixer'); f.dispatch('fx');
  f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 's', replies: replies('fixed') }); f.command('record_stopped', { attemptId: 'fx' });
  const requested = f.command('request_review_fix_verification', { roundId, operationId: 'verify_fix' });
  assert.equal(requested.intents[0].kind, 'verify'); assert.equal(requested.intents[0].payload.headSha, HEAD_C);
  fails(() => f.command('record_review_fix_push', { roundId }), 'NOT_READY');
  f.command('record_verification_result', { operationId: 'verify_fix', result: { verification: { headSha: HEAD_C, checks: [{ id: 'unit', passed: false, artifactId: 'log' }] }, workerState: 'stopped', artifactId: 'a'.repeat(64) } });
  f.command('record_review_fix_verification', { roundId, operationId: 'verify_fix' });
  assert.equal(f.goal.reviewRound.state, 'failed'); assert.equal(f.goal.hold.reasons.at(-1).kind, 'review_fix');
  assert.equal(f.goal.pr.headSha, HEAD_B);
  f.recover(); assert.equal(f.goal.status, 'delivered'); assert.equal(f.goal.reviewRounds[0].outcome, 'failed');
});

test('a passed fix verification, push and settlement advance the head and clear merge sync', () => {
  const f = fixture(); f.deliver();
  f.command('record_merge_sync', { number: 1, url: 'https://example.test/pr/1', state: 'open', checkedAt: 5 });
  f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  f.command('record_review_threads', { roundId, threads: threads(), mergeable: 'mergeable' });
  f.request('fx', 'review_fixer'); f.dispatch('fx');
  f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 's', replies: replies('fixed') }); f.command('record_stopped', { attemptId: 'fx' });
  f.command('request_review_fix_verification', { roundId, operationId: 'verify_fix' });
  f.command('record_verification_result', { operationId: 'verify_fix', result: { verification: { headSha: HEAD_C, checks: [{ id: 'unit', passed: true, artifactId: 'log' }] }, workerState: 'stopped', artifactId: 'a'.repeat(64) } });
  f.command('record_review_fix_verification', { roundId, operationId: 'verify_fix' });
  assert.equal(f.goal.reviewRound.state, 'pushing');
  f.command('record_review_fix_push', { roundId });
  assert.equal(f.goal.reviewRound.state, 'replying'); assert.equal(f.goal.pr.headSha, HEAD_C);
  assert.equal(f.goal.publication.headSha, HEAD_B, 'the saved publication operation keeps its approved head');
  assert.equal(f.goal.publication.plan.headSha, HEAD_B); assert.equal(f.goal.mergeSync, undefined);
  f.command('settle_review_fix', { roundId, posted: ['PRRT_1', 'PRRT_2'], unconfirmed: [], resolved: ['PRRT_1'] });
  assert.equal(f.goal.status, 'delivered'); assert.equal(f.goal.reviewRound, null);
  assert.equal(f.goal.reviewRounds[0].outcome, 'addressed'); assert.deepEqual(f.goal.reviewRounds[0].resolved, ['PRRT_1']);
  fails(() => f.command('settle_review_fix', { roundId, posted: [], unconfirmed: [], resolved: [] }), 'STALE_OPERATION');
});

test('an uncertain push holds the round until the remote head confirms one outcome', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  f.command('record_review_threads', { roundId, threads: threads(), mergeable: 'mergeable' });
  f.request('fx', 'review_fixer'); f.dispatch('fx');
  f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 's', replies: replies('fixed') }); f.command('record_stopped', { attemptId: 'fx' });
  f.command('request_review_fix_verification', { roundId, operationId: 'verify_fix' });
  f.command('record_verification_result', { operationId: 'verify_fix', result: { verification: { headSha: HEAD_C, checks: [{ id: 'unit', passed: true, artifactId: 'log' }] }, workerState: 'stopped', artifactId: 'a'.repeat(64) } });
  f.command('record_review_fix_verification', { roundId, operationId: 'verify_fix' });
  f.command('fail_review_fix', { roundId, code: 'PUSH_UNCERTAIN', message: 'Push outcome is uncertain.' });
  assert.equal(f.goal.reviewRound.state, 'unknown'); assert.ok(f.goal.hold);
  fails(() => f.command('recover_goal', { holdId: f.goal.hold.id }, f.user), 'OWNERSHIP_UNCERTAIN');
  f.command('record_review_fix_push', { roundId });
  assert.equal(f.goal.hold, null); assert.equal(f.goal.reviewRound.state, 'replying'); assert.equal(f.goal.pr.headSha, HEAD_C);
});

test('abort during a round terminates the fixer and keeps the old pull request head', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  f.command('record_review_threads', { roundId: f.goal.reviewRound.id, threads: threads(), mergeable: 'mergeable' });
  f.request('fx', 'review_fixer'); f.dispatch('fx');
  const aborted = f.command('abort', {}, f.user);
  assert.equal(aborted.intents[0].kind, 'terminate'); assert.equal(f.goal.status, 'aborted'); assert.equal(f.goal.pr.headSha, HEAD_B);
  fails(() => f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 's', replies: replies() }), 'TERMINAL_GOAL');
});

test('review fixer results carry a head, summary and replies', () => {
  const attempt = { id: 'fx', operationId: 'op', generation: 2, revision: 1, role: 'review_fixer', target: HEAD_B };
  const envelope = { schemaVersion: 1, goalId: 'g', attemptId: 'fx', operationId: 'op', generation: 2, revision: 1, role: 'review_fixer', target: HEAD_B, output: { headSha: HEAD_C, summary: 'Fixed', replies: replies() } };
  const parsed = parseRoleResult(envelope, { goalId: 'g', attempt });
  assert.equal(parsed.role, 'review_fixer'); assert.equal(parsed.output.replies.length, 2);
  assert.throws(() => parseRoleResult({ ...envelope, output: { headSha: HEAD_C, summary: 'x' } }, { goalId: 'g', attempt }));
  assert.throws(() => parseRoleResult({ ...envelope, output: { ...envelope.output, replies: [{ threadId: 'PRRT_1', action: 'push', body: 'x' }] } }, { goalId: 'g', attempt }));
});

test('the action view offers the round to the user and the projection exposes its phase', () => {
  const f = fixture();
  assert.ok(!actionView(f.goal).actions.some((action) => action.type === 'request_review_fix'));
  f.deliver();
  assert.equal(actionView(f.goal).actions.find((action) => action.type === 'request_review_fix').label, 'Address review comments');
  assert.ok(USER_COMMANDS.has('request_review_fix'));
  f.command('request_review_fix', {}, f.user);
  assert.ok(!actionView(f.goal).actions.some((action) => action.type === 'request_review_fix'));
  const view = goalView(f.goal);
  assert.equal(view.status, 'addressing_review'); assert.equal(view.reviewRound.state, 'fetching');
  assert.equal(view.reviewRound.phase, 'Fetching review threads'); assert.deepEqual(view.reviewRounds, []);
});

test('the fixer inherits the integrator team assignment', () => {
  const f = fixture(); f.deliver();
  const configured = { ...f.goal,
    teamConfiguration: { capturedAt: 'now', defaults: { planner: 'p', implementer: 'p', reviewer: 'p', integrator: 'p' }, profiles: [{ id: 'p', label: 'P', provider: 'claude', model: 'm', roles: ['planner', 'implementer', 'reviewer', 'integrator'], ready: true, reason: '', capacity: { remainingPercent: null, source: 's', checkedAt: null, reason: '' } }] },
    team: { revision: 1, approved: true, assignments: [{ key: 'integrator:*', role: 'integrator', taskId: null, profileId: 'p', manual: false, reason: '' }], changes: [] } };
  const assignment = assignmentFor(configured, 'review_fixer', null);
  assert.equal(assignment.profileId, 'p'); assert.equal(assignment.role, 'integrator');
});

test('a fixer result with the pull request head and replies only is accepted without Git proof', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  f.command('record_review_threads', { roundId: f.goal.reviewRound.id, threads: threads(), mergeable: 'mergeable' });
  f.request('fx', 'review_fixer'); f.dispatch('fx');
  f.command('receive_role_result', { resultId: 'res1', attemptId: 'fx', artifactId: 'b'.repeat(64) });
  f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_B, summary: 'Answered', replies: replies('comment') });
  f.command('mark_result_accepted', { resultId: 'res1' });
  assert.equal(f.goal.results[0].status, 'accepted'); assert.equal(f.goal.reviewRound.state, 'replying');
});

function coordinatorFixture(t) {
  const store = new OrchestrationStore({ path: ':memory:' }); t.after(() => store.close());
  const agents = { capabilities: [{ role: 'planner', mode: 'interactive' }, ...['implementer', 'reviewer', 'integrator', 'review_fixer'].map((role) => ({ role, mode: 'background' }))] };
  const service = new OrchestrationService({ store, agents, repositoryIds: new Set(['repo']), ownership: { assertOwned() {} } });
  const seed = fixture(); seed.deliver();
  store.apply({ id: 'seed', goalId: 'goal', expectedVersion: 0, type: 'create_goal', payload: {} }, { kind: 'user' }, () => ({ goal: { ...seed.goal, id: 'goal' }, events: [], intents: [] }));
  const calls = { threads: 0, pushes: [], replies: [] };
  const publisher = {
    threads: threads(), mergeable: 'mergeable', threadsError: null, pushResult: 'pushed', replyOutcome: { posted: ['PRRT_1', 'PRRT_2'], unconfirmed: [], resolved: ['PRRT_1'] },
    async reviewThreads() { calls.threads++; if (publisher.threadsError) throw publisher.threadsError; return { threads: publisher.threads, mergeable: publisher.mergeable }; },
    async pushFix(plan, fix) { calls.pushes.push(fix); return publisher.pushResult; },
    async replyAndResolve(plan, fix) { calls.replies.push(fix); return publisher.replyOutcome; },
  };
  let sequence = 0;
  const coordinator = new ReviewFixCoordinator({ service, publisher, ownership: { assertOwned() {} }, now: () => 1000, id: () => `id${++sequence}` });
  const send = (type, payload = {}, kind = 'system') => service.execute({ id: `c${++sequence}`, goalId: 'goal', expectedVersion: store.get('goal').version, type, payload }, { kind });
  return { store, service, publisher, coordinator, calls, send };
}
const settle = (coordinator) => Promise.all([...coordinator.active.values()]);
async function fix(f) {
  f.send('request_attempt', { attemptId: 'fx', operationId: 'opfx', role: 'review_fixer', taskId: null, conversationId: 'cfx' });
  f.send('record_dispatch', { attemptId: 'fx', identity: 'w', worktree: '/tmp/fx', branch: 'companion/goal/fx' });
}

test('the coordinator fetches threads once and settles an empty round without an attempt', async (t) => {
  const f = coordinatorFixture(t); f.publisher.threads = [];
  f.send('request_review_fix', {}, 'user');
  await f.coordinator.run(); await settle(f.coordinator); await f.coordinator.run(); await settle(f.coordinator);
  assert.equal(f.calls.threads, 1);
  const goal = f.store.get('goal');
  assert.equal(goal.status, 'delivered'); assert.equal(goal.reviewRounds[0].outcome, 'nothing_to_address');
  assert.equal(goal.attempts.filter((attempt) => attempt.role === 'review_fixer').length, 0);
});

test('an unavailable GitHub read fails the round with a sanitized hold', async (t) => {
  const f = coordinatorFixture(t); f.publisher.threadsError = new Error('secret token in output');
  f.send('request_review_fix', {}, 'user');
  await f.coordinator.run(); await settle(f.coordinator);
  const goal = f.store.get('goal');
  assert.equal(goal.reviewRound.state, 'failed'); assert.equal(goal.hold.reasons.at(-1).kind, 'review_fix');
  assert.doesNotMatch(JSON.stringify(goal), /secret token/);
});

test('a replies-only result skips verification, pushes nothing and settles', async (t) => {
  const f = coordinatorFixture(t);
  f.send('request_review_fix', {}, 'user'); await f.coordinator.run(); await settle(f.coordinator);
  assert.equal(f.store.get('goal').reviewRound.state, 'fixing'); assert.equal(f.store.ready().length, 1);
  await fix(f);
  f.send('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_B, summary: 's', replies: replies('comment') });
  f.send('record_stopped', { attemptId: 'fx' });
  await f.coordinator.run(); await settle(f.coordinator);
  const goal = f.store.get('goal');
  assert.equal(f.calls.pushes.length, 0); assert.equal(f.calls.replies.length, 1);
  assert.equal(goal.status, 'delivered'); assert.equal(goal.pr.headSha, HEAD_B); assert.equal(goal.reviewRounds[0].outcome, 'addressed');
});

test('a fixed result requests verification, then pushes and replies after the checks pass', async (t) => {
  const f = coordinatorFixture(t);
  f.send('request_review_fix', {}, 'user'); await f.coordinator.run(); await settle(f.coordinator);
  await fix(f);
  f.send('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 's', replies: replies('fixed') });
  f.send('record_stopped', { attemptId: 'fx' });
  await f.coordinator.run(); await settle(f.coordinator);
  let goal = f.store.get('goal');
  const operationId = goal.reviewRound.verificationOperationId;
  assert.equal(goal.reviewRound.state, 'verifying'); assert.ok(operationId);
  assert.equal(f.store.operations().find((operation) => operation.id === operationId)?.kind, 'verify');
  assert.equal(f.calls.pushes.length, 0);
  f.send('record_verification_result', { operationId, result: { verification: { headSha: HEAD_C, checks: [{ id: 'unit', passed: true, artifactId: 'log' }] }, workerState: 'stopped', artifactId: 'a'.repeat(64) } });
  for (let pass = 0; pass < 3; pass++) { await f.coordinator.run(); await settle(f.coordinator); }
  goal = f.store.get('goal');
  assert.deepEqual(f.calls.pushes[0], { roundId: goal.reviewRounds[0].id, expectedHead: HEAD_B, headSha: HEAD_C });
  assert.equal(goal.status, 'delivered'); assert.equal(goal.pr.headSha, HEAD_C); assert.deepEqual(goal.reviewRounds[0].resolved, ['PRRT_1']);
});

test('a moved remote head fails the round before any reply, and an unknown push holds until confirmed', async (t) => {
  for (const [result, state] of [['remote_moved', 'failed'], ['unknown', 'unknown']]) {
    const f = coordinatorFixture(t); f.publisher.pushResult = result;
    f.send('request_review_fix', {}, 'user'); await f.coordinator.run(); await settle(f.coordinator);
    await fix(f);
    f.send('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 's', replies: replies('fixed') });
    f.send('record_stopped', { attemptId: 'fx' });
    await f.coordinator.run(); await settle(f.coordinator);
    const operationId = f.store.get('goal').reviewRound.verificationOperationId;
    f.send('record_verification_result', { operationId, result: { verification: { headSha: HEAD_C, checks: [{ id: 'unit', passed: true, artifactId: 'log' }] }, workerState: 'stopped', artifactId: 'a'.repeat(64) } });
    for (let pass = 0; pass < 3; pass++) { await f.coordinator.run(); await settle(f.coordinator); }
    const goal = f.store.get('goal');
    assert.equal(goal.reviewRound.state, state); assert.equal(f.calls.replies.length, 0);
    assert.equal(goal.pr.headSha, HEAD_B); assert.ok(goal.hold);
    if (result === 'unknown') {
      f.publisher.pushResult = 'pushed';
      for (let pass = 0; pass < 3; pass++) { await f.coordinator.run(); await settle(f.coordinator); }
      assert.equal(f.store.get('goal').status, 'delivered'); assert.equal(f.store.get('goal').pr.headSha, HEAD_C);
    }
  }
});

test('a composition without the review round capability reports a configuration fault, not an offline Mac', async (t) => {
  const f = coordinatorFixture(t);
  delete f.publisher.reviewThreads;
  f.send('request_review_fix', {}, 'user');
  await f.coordinator.run(); await settle(f.coordinator);
  const round = f.store.get('goal').reviewRound;
  assert.equal(round.state, 'failed');
  assert.match(round.error, /unavailable in this configuration/);
  assert.doesNotMatch(round.error, /online|offline/i);
});

test('a publisher resolving to an object without threads fails as a configuration fault, not a parse error', async (t) => {
  const f = coordinatorFixture(t);
  f.publisher.reviewThreads = async () => { f.calls.threads++; return {}; };
  f.send('request_review_fix', {}, 'user');
  await f.coordinator.run(); await settle(f.coordinator);
  const round = f.store.get('goal').reviewRound;
  assert.equal(round.state, 'failed');
  assert.match(round.error, /unavailable/);
  assert.doesNotMatch(round.error, /online|offline/i);
});

test('a capability fault raised inside the thread read is not reported as an offline Mac', async (t) => {
  const f = coordinatorFixture(t);
  f.publisher.threadsError = Object.assign(new Error('Publication capability reviewThreads is unavailable in this configuration'), { code: 'UNSUPPORTED_CAPABILITY' });
  Object.setPrototypeOf(f.publisher.threadsError, DomainError.prototype);
  f.send('request_review_fix', {}, 'user');
  await f.coordinator.run(); await settle(f.coordinator);
  const round = f.store.get('goal').reviewRound;
  assert.equal(round.state, 'failed');
  assert.match(round.error, /unavailable in this configuration/);
  assert.doesNotMatch(round.error, /online|offline/i);
});

test('a missing thread write capability is reported before any reply is posted', async (t) => {
  const f = coordinatorFixture(t);
  delete f.publisher.replyAndResolve;
  f.send('request_review_fix', {}, 'user'); await f.coordinator.run(); await settle(f.coordinator);
  await fix(f);
  f.send('receive_role_result', { resultId: 'res1', attemptId: 'fx', artifactId: 'b'.repeat(64) });
  f.send('accept_review_fix_result', { attemptId: 'fx', headSha: f.store.get('goal').pr.headSha, summary: 'Answered', replies: replies('comment') });
  f.send('mark_result_accepted', { resultId: 'res1' });
  assert.equal(f.store.get('goal').reviewRound.state, 'replying');
  await f.coordinator.run(); await settle(f.coordinator);
  const round = f.store.get('goal').reviewRound;
  assert.equal(round.state, 'failed');
  assert.match(round.error, /unavailable in this configuration/);
  assert.equal(f.calls.replies.length, 0);
});

test('a round whose fixer cannot be dispatched reports a configuration fault instead of waiting in silence', async (t) => {
  const f = coordinatorFixture(t);
  f.service.agents.capabilities = f.service.agents.capabilities.filter((capability) => capability.role !== 'review_fixer');
  f.send('request_review_fix', {}, 'user');
  await f.coordinator.run(); await settle(f.coordinator);
  assert.equal(f.store.get('goal').reviewRound.state, 'fixing');
  await f.coordinator.run(); await settle(f.coordinator);
  const round = f.store.get('goal').reviewRound;
  assert.equal(round.state, 'failed');
  assert.match(round.error, /cannot start a review fixer/);
  assert.match(round.error, /Waiting will not help/);
});

test('a declared fixer capability leaves the round fixing so the scheduler can dispatch it', async (t) => {
  const f = coordinatorFixture(t);
  f.send('request_review_fix', {}, 'user');
  await f.coordinator.run(); await settle(f.coordinator);
  await f.coordinator.run(); await settle(f.coordinator);
  const round = f.store.get('goal').reviewRound;
  assert.equal(round.state, 'fixing');
  assert.equal(round.error, undefined);
  assert.equal(f.store.ready().filter((work) => work.role === 'review_fixer').length, 1);
});

test('the publication adapter returns the mergeable verdict with the threads', async () => {
  const calls = [];
  const github = {
    identity: () => 'fake',
    async readPull(repositoryId, number) { calls.push(['readPull', number]); return { number, url: 'https://example.test/pr/1', state: 'open', mergeable: 'conflicting' }; },
    async listReviewThreads() { calls.push(['threads']); return [thread('PRRT_1')]; },
    async find() { return []; },
    async create() {},
  };
  const { GitHubPublication } = await import('../server/orchestration/adapters/github.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'companion-pub-'));
  try {
    const publication = new GitHubPublication({ directory, remote: { identity: () => 'r', async head() { return null; }, async push() {} }, github });
    const observed = await publication.reviewThreads({ repositoryId: 'repo' }, { number: 1, url: 'https://example.test/pr/1', headSha: HEAD_B });
    assert.equal(observed.mergeable, 'conflicting');
    assert.equal(observed.threads.length, 1);
    assert.deepEqual(calls, [['readPull', 1], ['threads']]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a conflicting or unknown verdict merges rather than settling', () => {
  const clean = fixture(); clean.deliver(); clean.command('request_review_fix', {}, clean.user);
  clean.command('record_review_threads', { roundId: clean.goal.reviewRound.id, threads: [], mergeable: 'mergeable' });
  assert.equal(clean.goal.status, 'delivered');
  assert.equal(clean.goal.reviewRounds[0].outcome, 'nothing_to_address');

  const conflicting = fixture(); conflicting.deliver(); conflicting.command('request_review_fix', {}, conflicting.user);
  conflicting.command('record_review_threads', { roundId: conflicting.goal.reviewRound.id, threads: [], mergeable: 'conflicting' });
  assert.equal(conflicting.goal.status, 'addressing_review');
  assert.equal(conflicting.goal.reviewRound.state, 'merging');
  assert.equal(conflicting.goal.reviewRound.mergeable, 'conflicting');
  assert.equal(reviewRoundPhase(conflicting.goal.reviewRound), 'Merging the target branch');

  const unknown = fixture(); unknown.deliver(); unknown.command('request_review_fix', {}, unknown.user);
  unknown.command('record_review_threads', { roundId: unknown.goal.reviewRound.id, threads: threads(), mergeable: 'unknown' });
  assert.equal(unknown.goal.reviewRound.state, 'merging', 'an uncomputed verdict is decided by the local merge');
  assert.equal(readyWork(unknown.goal).length, 0, 'no fixer runs before the merge is recorded');

  const threadsOnly = fixture(); threadsOnly.deliver(); threadsOnly.command('request_review_fix', {}, threadsOnly.user);
  threadsOnly.command('record_review_threads', { roundId: threadsOnly.goal.reviewRound.id, threads: threads(), mergeable: 'mergeable' });
  assert.equal(threadsOnly.goal.reviewRound.state, 'fixing');
});

test('a missing or unknown mergeable verdict is refused', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  fails(() => f.command('record_review_threads', { roundId, threads: [] }));
  fails(() => f.command('record_review_threads', { roundId, threads: [], mergeable: 'maybe' }));
  assert.equal(f.goal.reviewRound.state, 'fetching', 'a refused record leaves the round untouched');
});

const MERGE_COMMIT = 'e'.repeat(40);
const BASE_HEAD = 'f'.repeat(40);

test('a clean merge with no threads skips the agent and verifies the merge commit', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  f.command('record_review_threads', { roundId, threads: [], mergeable: 'conflicting' });
  f.command('record_review_merge', { roundId, mergedBaseSha: BASE_HEAD, mergeCommitSha: MERGE_COMMIT, conflictPaths: [] });
  assert.equal(f.goal.reviewRound.state, 'verifying');
  assert.equal(f.goal.reviewRound.fixHeadSha, MERGE_COMMIT);
  assert.equal(f.goal.reviewRound.mergedBaseSha, BASE_HEAD);
  assert.equal(readyWork(f.goal).length, 0, 'no fixer is dispatched for a clean merge with no threads');
});

test('a conflicted merge dispatches the fixer against the merge commit', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  f.command('record_review_threads', { roundId, threads: [], mergeable: 'conflicting' });
  f.command('record_review_merge', { roundId, mergedBaseSha: BASE_HEAD, mergeCommitSha: MERGE_COMMIT, conflictPaths: ['src/a.mjs', 'package-lock.json'] });
  assert.equal(f.goal.reviewRound.state, 'fixing');
  assert.deepEqual(f.goal.reviewRound.conflictPaths, ['src/a.mjs', 'package-lock.json']);
  assert.deepEqual(readyWork(f.goal).map((entry) => [entry.role, entry.target]), [['review_fixer', MERGE_COMMIT]]);
  f.request('fx', 'review_fixer'); const attempt = f.goal.attempts.at(-1);
  assert.equal(attempt.target, MERGE_COMMIT);
  assert.equal(attempt.baseSha, MERGE_COMMIT, 'the fixer worktree starts on the merge, with its conflict markers');
  assert.equal(reviewRoundPhase(f.goal.reviewRound), 'Fixing 0 threads and 2 conflicts');
});

test('a merged round with threads also targets the merge commit', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  f.command('record_review_threads', { roundId, threads: threads(), mergeable: 'conflicting' });
  f.command('record_review_merge', { roundId, mergedBaseSha: BASE_HEAD, mergeCommitSha: MERGE_COMMIT, conflictPaths: [] });
  assert.equal(f.goal.reviewRound.state, 'fixing');
  assert.deepEqual(readyWork(f.goal).map((entry) => entry.target), [MERGE_COMMIT]);
  f.request('fx', 'review_fixer');
  assert.equal(f.goal.attempts.at(-1).target, MERGE_COMMIT);
});

test('an unmerged round still targets the pull request head', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  f.command('record_review_threads', { roundId: f.goal.reviewRound.id, threads: threads(), mergeable: 'mergeable' });
  assert.deepEqual(readyWork(f.goal).map((entry) => entry.target), [HEAD_B]);
  f.request('fx', 'review_fixer');
  assert.equal(f.goal.attempts.at(-1).target, HEAD_B);
});

test('a merge record is refused outside the merging state and rejects an unowned path', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  fails(() => f.command('record_review_merge', { roundId, mergedBaseSha: BASE_HEAD, mergeCommitSha: MERGE_COMMIT, conflictPaths: [] }), 'NOT_READY');
  f.command('record_review_threads', { roundId, threads: [], mergeable: 'conflicting' });
  fails(() => f.command('record_review_merge', { roundId, mergedBaseSha: BASE_HEAD, mergeCommitSha: MERGE_COMMIT, conflictPaths: ['../outside'] }));
  fails(() => f.command('record_review_merge', { roundId, mergedBaseSha: BASE_HEAD, mergeCommitSha: HEAD_B, conflictPaths: [] }), 'STALE_TARGET');
  assert.equal(f.goal.reviewRound.state, 'merging', 'a refused record leaves the round untouched');
});
