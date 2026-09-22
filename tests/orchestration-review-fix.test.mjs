import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReviewThreads, parseReviewReplies, activeReviewRound, reviewRoundPhase } from '../server/orchestration/domain/review-round.mjs';
import { readyWork } from '../server/orchestration/domain/scheduling.mjs';
import { parseRoleResult } from '../server/orchestration/domain/role-result.mjs';
import { goalView } from '../server/orchestration/domain/state-view.mjs';
import { actionView } from '../server/orchestration/domain/action-view.mjs';
import { assignmentFor } from '../server/orchestration/domain/teams.mjs';
import { USER_COMMANDS } from '../server/orchestration/domain/commands.mjs';
import { fixture, HEAD_B } from './helpers/orchestration/domain-fixture.mjs';

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
  f.command('record_review_threads', { roundId: f.goal.reviewRound.id, threads: [] });
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
  f.command('record_review_threads', { roundId: f.goal.reviewRound.id, threads: threads() });
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
  f.command('record_review_threads', { roundId: f.goal.reviewRound.id, threads: threads() });
  f.request('fx', 'review_fixer'); f.dispatch('fx');
  fails(() => f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_B, summary: 's', replies: replies('fixed') }), 'STALE_TARGET');
  fails(() => f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 's', replies: replies('declined') }), 'STALE_TARGET');
  fails(() => f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 's', replies: [replies()[0]] }));
  f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 'Fixed drop handling', replies: replies('fixed') });
  assert.equal(f.goal.reviewRound.state, 'verifying'); assert.equal(f.goal.reviewRound.fixHeadSha, HEAD_C);
  assert.equal(f.goal.attempts.at(-1).status, 'succeeded');
  const g = fixture(); g.deliver(); g.command('request_review_fix', {}, g.user);
  g.command('record_review_threads', { roundId: g.goal.reviewRound.id, threads: threads() });
  g.request('fx', 'review_fixer'); g.dispatch('fx');
  g.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_B, summary: 'No code change', replies: replies('comment') });
  assert.equal(g.goal.reviewRound.state, 'replying'); assert.equal(g.goal.reviewRound.fixHeadSha, undefined);
});

test('verification of the fix head gates the push and a failed check holds the goal', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  f.command('record_review_threads', { roundId, threads: threads() });
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
  f.command('record_review_threads', { roundId, threads: threads() });
  f.request('fx', 'review_fixer'); f.dispatch('fx');
  f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 's', replies: replies('fixed') }); f.command('record_stopped', { attemptId: 'fx' });
  f.command('request_review_fix_verification', { roundId, operationId: 'verify_fix' });
  f.command('record_verification_result', { operationId: 'verify_fix', result: { verification: { headSha: HEAD_C, checks: [{ id: 'unit', passed: true, artifactId: 'log' }] }, workerState: 'stopped', artifactId: 'a'.repeat(64) } });
  f.command('record_review_fix_verification', { roundId, operationId: 'verify_fix' });
  assert.equal(f.goal.reviewRound.state, 'pushing');
  f.command('record_review_fix_push', { roundId });
  assert.equal(f.goal.reviewRound.state, 'replying'); assert.equal(f.goal.pr.headSha, HEAD_C);
  assert.equal(f.goal.publication.headSha, HEAD_C); assert.equal(f.goal.mergeSync, undefined);
  f.command('settle_review_fix', { roundId, posted: ['PRRT_1', 'PRRT_2'], unconfirmed: [], resolved: ['PRRT_1'] });
  assert.equal(f.goal.status, 'delivered'); assert.equal(f.goal.reviewRound, null);
  assert.equal(f.goal.reviewRounds[0].outcome, 'addressed'); assert.deepEqual(f.goal.reviewRounds[0].resolved, ['PRRT_1']);
  fails(() => f.command('settle_review_fix', { roundId, posted: [], unconfirmed: [], resolved: [] }), 'STALE_OPERATION');
});

test('an uncertain push holds the round until the remote head confirms one outcome', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  f.command('record_review_threads', { roundId, threads: threads() });
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
  f.command('record_review_threads', { roundId: f.goal.reviewRound.id, threads: threads() });
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
  f.command('record_review_threads', { roundId: f.goal.reviewRound.id, threads: threads() });
  f.request('fx', 'review_fixer'); f.dispatch('fx');
  f.command('receive_role_result', { resultId: 'res1', attemptId: 'fx', artifactId: 'b'.repeat(64) });
  f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_B, summary: 'Answered', replies: replies('comment') });
  f.command('mark_result_accepted', { resultId: 'res1' });
  assert.equal(f.goal.results[0].status, 'accepted'); assert.equal(f.goal.reviewRound.state, 'replying');
});
