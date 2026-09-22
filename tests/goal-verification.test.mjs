import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, contract } from './helpers/orchestration/domain-fixture.mjs';
const HEAD_C = 'd'.repeat(40);
import { resolveGoalCheck } from '../server/goal-verification.mjs';
import { rolePrompt } from '../server/orchestration/adapters/role-prompts.mjs';
const resolve = (goal, check = contract().verification[0], repositoryId = 'repo') => resolveGoalCheck({ goal, check, repositoryId, env: {}, environmentId: 'test', policy: {} });
test('planned checks need current approval and exact repository, id and argv', () => {
  const f = fixture();
  assert.throws(() => resolve(f.goal), { code: 'NOT_READY' });
  f.approve();
  const result = resolve(f.goal);
  assert.match(result.bin, /node$/); assert.deepEqual(result.argv, ['--test']);
  assert.match(result.environmentId, /goal-goal-revision-1$/);
  assert.throws(() => resolve(f.goal, { id: 'unit', argv: ['node', '--version'] }), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.throws(() => resolve(f.goal, { id: 'other', argv: ['node', '--test'] }), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.throws(() => resolve(f.goal, undefined, 'other'), { code: 'FORBIDDEN' });
  assert.throws(() => resolve(null), { code: 'FORBIDDEN' });
  assert.deepEqual(resolve(JSON.parse(JSON.stringify(f.goal))), result);
  f.command('publish_contract', { contract: contract() }, f.user);
  assert.throws(() => resolve(f.goal), { code: 'NOT_READY' });
});
test('plan approval does not enable shell wrappers, RPC or missing executables', () => {
  for (const executable of ['sh', '/bin/bash', 'env', 'cmux', 'cmux-nonexistent-verification-command', 'node;echo', './script']) {
    const f = fixture(), plan = contract(); plan.verification[0].argv = [executable, '--version']; f.approve(plan);
    assert.throws(() => resolve(f.goal, plan.verification[0]));
  }
});
test('planner discovers goal checks and reports gaps instead of requiring repository configuration', () => {
  const f = fixture(); f.request('planner', 'planner');
  const prompt = rolePrompt(f.goal, f.goal.attempts.at(-1));
  assert.match(prompt, /Inspect repository instructions, scripts and CI/);
  assert.match(prompt, /If no checks exist, explicitly report the gap/);
  assert.match(prompt, /Approval of this exact plan/);
});

test('a review round resolves its planned checks at the head it recorded, and nothing else', () => {
  const f = fixture(); f.deliver();
  // Refused while the round has not recorded a fix head to verify.
  f.command('request_review_fix', {}, f.user);
  assert.throws(() => resolve(f.goal), { code: 'NOT_READY' });
  f.command('record_review_threads', { roundId: f.goal.reviewRound.id, threads: [{ id: 'PRRT_1', path: 'src/a.mjs', line: 1, author: 'coderabbitai', body: 'Explain this.', isBot: true }], at: 1 });
  f.request('fx', 'review_fixer'); f.dispatch('fx');
  assert.throws(() => resolve(f.goal), { code: 'NOT_READY' });
  f.command('receive_role_result', { resultId: 'res1', attemptId: 'fx', artifactId: 'b'.repeat(64) });
  f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 'Answered', replies: [{ threadId: 'PRRT_1', action: 'fixed', body: 'Done.' }] });
  f.command('mark_result_accepted', { resultId: 'res1' });
  f.command('record_stopped', { attemptId: 'fx' });
  f.command('request_review_fix_verification', { roundId: f.goal.reviewRound.id, operationId: 'verify_fix' });
  assert.equal(f.goal.reviewRound.state, 'verifying');
  // The plan still decides the command; the round only decides the head.
  const result = resolve(f.goal);
  assert.match(result.bin, /node$/); assert.deepEqual(result.argv, ['--test']);
  assert.throws(() => resolve(f.goal, { id: 'unit', argv: ['node', '--version'] }), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.throws(() => resolve(f.goal, undefined, 'other'), { code: 'FORBIDDEN' });
});

test('a delivered goal outside a verifying round resolves no check', () => {
  const f = fixture(); f.deliver();
  assert.throws(() => resolve(f.goal), { code: 'NOT_READY' });
  f.command('request_review_fix', {}, f.user);
  assert.equal(f.goal.reviewRound.state, 'fetching');
  assert.throws(() => resolve(f.goal), { code: 'NOT_READY' });
});
