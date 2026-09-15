import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRoleResult } from '../server/orchestration/domain/role-result.mjs';
import { roleContext, rolePrompt } from '../server/orchestration/adapters/role-prompts.mjs';
import { acceptedReview } from '../server/orchestration/domain/review.mjs';
import { readyWork } from '../server/orchestration/domain/scheduling.mjs';
import { planTarget } from '../server/orchestration/domain/transitions.mjs';
import { contract, fixture, BASE, HEAD_A } from './helpers/orchestration/domain-fixture.mjs';

function result(role, output) {
  const attempt = { id: 'a', operationId: 'op', generation: 1, revision: 1, role, target: BASE };
  return { expected: { goalId: 'g', attempt }, envelope: { schemaVersion: 1, goalId: 'g', attemptId: 'a', operationId: 'op', generation: 1, revision: 1, role, target: BASE, output } };
}
const review = () => ({ schemaVersion: 1, target: BASE, disposition: 'accept', findings: [] });
const candidate = () => ({ headSha: HEAD_A, summary: 'Implemented module', evidence: [{ path: 'src/a.mjs', line: 1, description: 'Returns the required value' }] });

test('every role has a versioned exact-identity structured result contract', () => {
  for (const [role, output] of [['planner', { contract: contract() }], ['reviewer', review()], ['implementer', candidate()], ['integrator', { ...candidate(), operationId: 'integration_op' }]]) {
    const { envelope, expected } = result(role, output);
    const parsed = parseRoleResult(envelope, expected);
    assert.equal(parsed.role, role); assert.equal(parsed.attemptId, 'a');
    assert.equal(parsed.output.headSha ?? parsed.output.target ?? parsed.output.contract.schemaVersion, output.headSha ?? output.target ?? output.contract.schemaVersion);
    for (const key of ['goalId', 'attemptId', 'operationId', 'role']) assert.throws(() => parseRoleResult({ ...envelope, [key]: 'other' }, expected), { code: 'FORBIDDEN' });
    for (const key of ['generation', 'revision', 'target']) assert.throws(() => parseRoleResult({ ...envelope, [key]: 'other' }, expected), { code: 'STALE_TARGET' });
    assert.throws(() => parseRoleResult({ ...envelope, schemaVersion: 2 }, expected));
    assert.throws(() => parseRoleResult({ ...envelope, approve: true }, expected));
  }
});

test('missing/prose/conflicting reviews and unsafe evidence cannot become accepted output', () => {
  const { envelope, expected } = result('reviewer', review());
  for (const output of ['PASS', null, {}, { ...review(), disposition: 'request_changes' }, { ...review(), findings: Array(41).fill({}) }]) assert.throws(() => parseRoleResult({ ...envelope, output }, expected));
  const input = result('implementer', candidate());
  for (const path of ['../secret', '/outside', '.git/config', 'src/*.mjs']) assert.throws(() => parseRoleResult({ ...input.envelope, output: { ...candidate(), evidence: [{ path, line: 1, description: 'proof' }] } }, input.expected));
  assert.throws(() => parseRoleResult({ ...input.envelope, output: { ...candidate(), headSha: 'not-a-sha' } }, input.expected));
  assert.throws(() => parseRoleResult({ ...input.envelope, output: { ...candidate(), evidence: [{ path: 'src/a.mjs', line: 0, description: 'proof' }] } }, input.expected));
});

test('review context is an independent pinned copy and role prompts grant no approval', () => {
  const f = fixture(); f.command('publish_contract', { contract: contract() }, f.user); f.request('r', 'reviewer');
  const attempt = f.goal.attempts[0], context = roleContext(f.goal, attempt);
  assert.equal(context.requiredAccess, 'isolated-read-only-snapshot'); assert.equal(context.target, attempt.target);
  context.contract.tasks[0].prompt = 'changed'; assert.notEqual(f.goal.contracts[0].contract.tasks[0].prompt, 'changed');
  const prompt = rolePrompt(f.goal, attempt);
  assert.match(prompt, /untrusted evidence/); assert.match(prompt, /Never write workflow storage/); assert.match(prompt, /No prose or PASS fallback/);
  f.command('request_revision', { message: 'Address findings' }, f.user);
  assert.throws(() => roleContext(f.goal, attempt), { code: 'STALE_ATTEMPT' });
});

function acceptedTask() {
  const f = fixture(), plan = contract(); plan.tasks = [plan.tasks[0]]; f.approve(plan);
  f.request('a', 'implementer', 'A'); f.dispatch('a'); f.command('confirm_candidate', { attemptId: 'a', headSha: HEAD_A }); f.command('record_stopped', { attemptId: 'a' });
  f.request('r', 'reviewer', 'A'); f.dispatch('r'); f.review('r', HEAD_A);
  f.command('request_integration', { operationId: 'integrate', taskId: 'A' });
  return f;
}

test('revision and direct publication preserve unresolved integration and PR operation ownership', () => {
  const f = acceptedTask();
  const revisions = () => {
    const before = structuredClone(f.goal);
    assert.throws(() => f.command('request_revision', { message: 'Change scope' }, f.user), { code: 'OWNERSHIP_UNCERTAIN' });
    assert.throws(() => f.command('publish_contract', { contract: contract() }, f.user), { code: 'OWNERSHIP_UNCERTAIN' });
    assert.deepEqual(f.goal, before);
  };
  revisions(); f.command('record_integration', { operationId: 'integrate', headSha: HEAD_A });
  f.request('final', 'reviewer'); f.dispatch('final'); f.review('final', HEAD_A);
  f.command('record_verification', { headSha: HEAD_A, checks: [{ id: 'unit', passed: true, artifactId: 'checked' }] });
  f.command('request_publication', { operationId: 'publish' });
  f.command('approve_publication', { operationId: 'publish', headSha: HEAD_A }, f.user); revisions();
  f.command('abort', {}, f.user);
  f.command('record_pr', { operationId: 'publish', headSha: HEAD_A, number: 1, url: 'https://example.test/pr/1' });
  assert.equal(f.goal.status, 'aborted'); assert.equal(f.goal.pr.number, 1);
});

test('a failed-check-only repair receives exact verification evidence without fabricated review findings', () => {
  const f = acceptedTask(); f.command('record_integration', { operationId: 'integrate', headSha: HEAD_A });
  f.command('record_verification', { headSha: HEAD_A, checks: [{ id: 'unit', passed: false, artifactId: 'failed_check_log' }] });
  f.request('repair', 'integrator');
  const context = roleContext(f.goal, f.goal.attempts.at(-1));
  assert.deepEqual(context.verification, { headSha: HEAD_A, checks: [{ id: 'unit', passed: false, artifactId: 'failed_check_log' }] });
  assert.ok(!context.reviews.some((entry) => entry.kind === 'integration'));
  assert.match(rolePrompt(f.goal, f.goal.attempts.at(-1)), /failed_check_log/);
});

test('revised scope cannot reuse a historical final verdict even at the identical commit SHA', () => {
  for (const blocking of [false, true]) {
    const f = acceptedTask(); f.command('record_integration', { operationId: 'integrate', headSha: HEAD_A });
    f.request('final', 'reviewer'); f.dispatch('final'); f.review('final', HEAD_A, blocking);
    assert.equal(acceptedReview(f.goal, HEAD_A, 'integration'), !blocking);
    f.command('request_revision', { message: 'Change the acceptance scope' }, f.user);
    const revised = contract(); revised.tasks = [revised.tasks[0]];
    f.command('publish_contract', { contract: revised }, f.user);
    f.request('plan_review2', 'reviewer'); f.dispatch('plan_review2'); f.review('plan_review2', planTarget(f.goal));
    f.command('approve', { revision: f.goal.revision }, f.user);
    f.request('a2', 'implementer', 'A'); f.dispatch('a2'); f.command('confirm_candidate', { attemptId: 'a2', headSha: HEAD_A }); f.command('record_stopped', { attemptId: 'a2' });
    f.request('r2', 'reviewer', 'A'); f.dispatch('r2'); f.review('r2', HEAD_A);
    f.command('request_integration', { taskId: 'A', operationId: 'integrate2' }); f.command('record_integration', { operationId: 'integrate2', headSha: HEAD_A });
    assert.equal(acceptedReview(f.goal, HEAD_A, 'integration'), false);
    assert.equal(readyWork(f.goal).at(-1).role, 'reviewer');
    assert.throws(() => f.request('repair', 'integrator'), { code: 'NOT_READY' });
    f.command('record_verification', { headSha: HEAD_A, checks: [{ id: 'unit', passed: true, artifactId: 'new_checks' }] });
    assert.throws(() => f.command('request_publication', { operationId: 'publish' }), { code: 'NOT_READY' });
  }
});


test('planner context instructs MCP payload submission without the background result-envelope directive', () => {
  const f = fixture(); f.request('planner', 'planner');
  const prompt = rolePrompt(f.goal, f.goal.attempts[0]);
  assert.match(prompt, /companion.submit_result with exactly \{id,output\}/);
  assert.match(prompt, /"id":"question-1","output":\{"question"/);
  assert.match(prompt, /Do not nest a role envelope inside output/);
  assert.doesNotMatch(prompt, /Return one JSON object with exactly schemaVersion/);
  assert.match(prompt, /INVALID_PLANNER_OUTPUT/);
  assert.match(prompt, /same id and exact payload because delivery may be uncertain/);
  const background = { ...f.goal.attempts[0], mode: 'background' };
  assert.match(rolePrompt({ ...f.goal, attempts: [background] }, background), /Return one JSON object with exactly schemaVersion/);
});
