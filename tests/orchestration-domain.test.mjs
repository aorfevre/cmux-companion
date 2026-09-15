import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, integer, sha } from '../server/orchestration/domain/contracts.mjs';
import { parseContract, ownedArea, readyTasks } from '../server/orchestration/domain/graph.mjs';
import { parseReview } from '../server/orchestration/domain/review.mjs';
import { transition, planTarget } from '../server/orchestration/domain/transitions.mjs';
import { readyWork } from '../server/orchestration/domain/scheduling.mjs';
import { goalView } from '../server/orchestration/domain/state-view.mjs';
import { requireCapability } from '../server/orchestration/ports.mjs';
import { fixture, contract, BASE, HEAD_A, HEAD_B } from './helpers/orchestration/domain-fixture.mjs';

const fails = (fn, code) => assert.throws(fn, code ? (error) => error.code === code : undefined);

test('contract accepts a parallel graph and rejects cyclic, unknown and unowned work', () => {
  const good = parseContract(contract()); assert.equal(good.tasks.length, 3);
  for (const mutate of [
    (c) => { c.tasks[0].dependsOn = ['C']; },
    (c) => { c.tasks[0].dependsOn = ['missing']; },
    (c) => { c.tasks[0].id = 'B'; },
    (c) => { c.criteria.push({ id: 'unowned', text: 'unowned', verification: 'unit' }); },
    (c) => { c.tasks[0].criterionIds = ['missing']; },
    (c) => { c.criteria[0].verification = 'missing'; },
    (c) => { c.verification[0].argv = []; },
    (c) => { c.tasks[0].ownedAreas = []; },
  ]) { const c = contract(); mutate(c); fails(() => parseContract(c)); }
});

test('overlapping ownership requires dependency ordering or explicit bilateral integration policy', () => {
  const c = contract(); c.tasks[0].ownedAreas = ['src'];
  fails(() => parseContract(c));
  c.tasks[1].dependsOn = ['A']; assert.equal(parseContract(c).tasks.length, 3);
  c.tasks[1].dependsOn = []; c.tasks[0].integrationPolicy = 'serialize';
  fails(() => parseContract(c));
  c.tasks[1].integrationPolicy = 'serialize'; assert.equal(parseContract(c).tasks.length, 3);
  for (const path of ['/tmp', '../x', 'x/../y', '.git/config', 'src/**', 'C:\\repo', 'src//a', 'src/./a']) fails(() => ownedArea(path));
  assert.equal(ownedArea('src/'), 'src');
});

test('canonical receipts distinguish payloads while ignoring object-key order', () => {
  assert.equal(canonicalJson({ b: [1, null], a: true }), canonicalJson({ a: true, b: [1, null] }));
  for (const input of [NaN, undefined, new Date(), { x: undefined }]) fails(() => canonicalJson(input));
  fails(() => integer(1.1)); fails(() => sha('a'.repeat(41)));
});

test('reviews require explicit consistent disposition and exact target', () => {
  const good = { schemaVersion: 1, target: BASE, disposition: 'accept', findings: [] };
  assert.equal(parseReview(good, BASE).disposition, 'accept');
  fails(() => parseReview(good, HEAD_A), 'STALE_TARGET');
  fails(() => parseReview({ ...good, disposition: 'request_changes' }, BASE));
  fails(() => parseReview('### Overall: PASS', BASE));
  const finding = { id: 'F1', severity: 'high', blocking: true, title: 'Fix', evidence: 'file:1', suggestion: 'Change' };
  fails(() => parseReview({ ...good, findings: [finding] }, BASE));
  fails(() => parseReview({ ...good, disposition: 'request_changes', findings: [finding, finding] }, BASE));
});

test('approval requires independent current plan review and user authority', () => {
  const f = fixture(); f.command('publish_contract', { contract: contract() }, f.user);
  fails(() => f.command('approve', { revision: 1 }, f.user), 'REVIEW_REQUIRED');
  f.request('r', 'reviewer'); f.dispatch('r'); f.review('r', planTarget(f.goal));
  fails(() => f.command('approve', { revision: 1 }), 'FORBIDDEN');
  fails(() => f.command('approve', { revision: 2 }, f.user), 'STALE_TARGET');
  f.command('approve', { revision: 1 }, f.user);
  assert.equal(f.goal.status, 'building');
});

test('parallel siblings are ready but a dependent waits for integration, not worker completion', () => {
  const f = fixture(); f.approve();
  assert.deepEqual(readyTasks(f.goal).map((task) => task.id), ['A', 'B']);
  f.request('a', 'implementer', 'A'); f.dispatch('a');
  f.request('b', 'implementer', 'B'); f.dispatch('b');
  fails(() => f.request('c', 'implementer', 'C'), 'NOT_READY');
  fails(() => f.request('a2', 'implementer', 'A'), 'NOT_READY');
  f.command('confirm_candidate', { attemptId: 'a', headSha: HEAD_A }); f.command('record_stopped', { attemptId: 'a' });
  f.request('ar', 'reviewer', 'A'); f.dispatch('ar'); f.review('ar', HEAD_A);
  assert.deepEqual(readyTasks(f.goal), []);
  f.command('request_integration', { taskId: 'A', operationId: 'ia' });
  fails(() => f.command('request_integration', { taskId: 'A', operationId: 'duplicate' }), 'NOT_READY');
  fails(() => f.command('record_integration', { operationId: 'other', headSha: HEAD_A }), 'STALE_TARGET');
  f.command('record_integration', { operationId: 'ia', headSha: HEAD_A });
  assert.deepEqual(readyTasks(f.goal), []);
  f.command('confirm_candidate', { attemptId: 'b', headSha: HEAD_B });
  f.request('br', 'reviewer', 'B'); f.dispatch('br'); f.review('br', HEAD_B);
  f.command('request_integration', { taskId: 'B', operationId: 'ib' });
  f.command('record_integration', { operationId: 'ib', headSha: HEAD_B });
  f.request('c', 'implementer', 'C');
  assert.equal(f.goal.attempts.at(-1).baseSha, HEAD_B);
});

test('two task repair attempts require a human to authorize additional work and preserve lineage', () => {
  const f = fixture(); f.approve();
  for (let index = 0; index < 3; index++) {
    const id = `a${index}`; f.request(id, 'implementer', 'A'); f.dispatch(id);
    f.command('confirm_candidate', { attemptId: id, headSha: [BASE, HEAD_A, HEAD_B][index] });
    f.command('record_stopped', { attemptId: id }); f.request(`r${index}`, 'reviewer', 'A'); f.dispatch(`r${index}`); f.review(`r${index}`, [BASE, HEAD_A, HEAD_B][index], true);
  }
  fails(() => f.request('extra', 'implementer', 'A'), 'NOT_READY');
  fails(() => f.command('authorize_repair', { taskId: 'A' }), 'FORBIDDEN');
  f.command('authorize_repair', { taskId: 'A' }, f.user);
  f.request('extra', 'implementer', 'A'); assert.equal(f.goal.tasks[0].repairCount, 3);
});

test('scoped reviewer cannot approve, submit implementation evidence or impersonate a different attempt', () => {
  const f = fixture(); f.command('publish_contract', { contract: contract() }, f.user);
  f.request('r', 'reviewer'); f.dispatch('r');
  const agent = { kind: 'agent', goalId: f.goal.id, generation: f.goal.generation, revision: f.goal.revision, attemptId: 'r', role: 'reviewer' };
  fails(() => f.command('approve', { revision: 1 }, agent), 'FORBIDDEN');
  fails(() => f.command('confirm_candidate', { attemptId: 'r', headSha: BASE }, agent), 'FORBIDDEN');
  fails(() => f.command('record_review', { attemptId: 'r' }, { ...agent, goalId: 'other' }), 'FORBIDDEN');
  f.command('record_review', { attemptId: 'r', reviewId: 'valid', review: { schemaVersion: 1, target: planTarget(f.goal), disposition: 'accept', findings: [] } }, agent);
  fails(() => f.command('record_review', {}, agent), 'FORBIDDEN');
});

test('abort revokes authority and late results cannot reactivate the goal', () => {
  const f = fixture(); f.approve(); f.request('a', 'implementer', 'A'); f.dispatch('a');
  const original = structuredClone(f.goal);
  const aborted = f.command('abort', {}, f.user);
  assert.equal(aborted.intents[0].kind, 'terminate'); assert.equal(f.goal.status, 'aborted');
  assert.equal(original.status, 'building', 'transition does not mutate the old aggregate');
  fails(() => f.command('confirm_candidate', { attemptId: 'a', headSha: BASE }), 'TERMINAL_GOAL');
  f.command('record_stopped', { attemptId: 'a' }); assert.equal(f.goal.status, 'aborted');
  assert.equal(f.goal.attempts.at(-1).status, 'cancelled');
});

test('replacement contract fences prior workers and waits for their confirmed termination', () => {
  const f = fixture(); f.approve(); f.request('a', 'implementer', 'A'); f.dispatch('a');
  f.command('publish_contract', { contract: contract() }, f.user);
  f.request('newreview', 'reviewer'); f.dispatch('newreview'); f.review('newreview', planTarget(f.goal));
  fails(() => f.command('approve', { revision: 2 }, f.user), 'OWNERSHIP_UNCERTAIN');
  f.command('record_stopped', { attemptId: 'a' }); f.command('approve', { revision: 2 }, f.user);
  assert.equal(f.goal.approvedRevision, 2);
  fails(() => f.command('confirm_candidate', { attemptId: 'a', headSha: BASE }), 'STALE_ATTEMPT');
});

test('failed tasks require stopped proof and explicit retry while uncertain workers retain ownership', () => {
  const f = fixture(); f.approve(); f.request('a', 'implementer', 'A'); f.dispatch('a');
  fails(() => f.command('record_failure', { attemptId: 'a', error: 'lost' }));
  f.command('record_failure', { attemptId: 'a', error: 'lost', uncertain: true });
  fails(() => f.command('retry_task', { taskId: 'A' }, f.user));
  f.command('record_failure', { attemptId: 'a', error: 'stopped', confirmedStopped: true });
  f.command('retry_task', { taskId: 'A' }, f.user);
  assert.equal(f.goal.tasks[0].status, 'pending');
});

test('final review and all verification checks gate publication at the current integration head', () => {
  const f = fixture(); const c = contract(); c.tasks = [c.tasks[0]]; f.approve(c);
  f.request('a', 'implementer', 'A'); f.dispatch('a'); f.command('confirm_candidate', { attemptId: 'a', headSha: HEAD_A }); f.command('record_stopped', { attemptId: 'a' });
  f.request('ar', 'reviewer', 'A'); f.dispatch('ar'); f.review('ar', HEAD_A);
  f.command('request_integration', { taskId: 'A', operationId: 'integrate' });
  f.command('record_integration', { operationId: 'integrate', headSha: HEAD_B });
  fails(() => f.command('request_publication', { operationId: 'publish' }), 'NOT_READY');
  f.request('final', 'reviewer'); f.dispatch('final'); f.review('final', HEAD_B);
  fails(() => f.command('record_verification', { headSha: HEAD_A, checks: [] }), 'STALE_TARGET');
  fails(() => f.command('record_verification', { headSha: HEAD_B, checks: [] }));
  f.command('record_verification', { headSha: HEAD_B, checks: [{ id: 'unit', passed: false, artifactId: 'log' }] });
  fails(() => f.command('request_publication', { operationId: 'publish' }), 'NOT_READY');
  f.command('record_verification', { headSha: HEAD_B, checks: [{ id: 'unit', passed: true, artifactId: 'log2' }] });
  const pending = f.command('request_publication', { operationId: 'publish' }); assert.equal(pending.intents.length, 0);
  fails(() => f.command('approve_publication', { operationId: 'publish', headSha: HEAD_B }), 'FORBIDDEN');
  fails(() => f.command('approve_publication', { operationId: 'publish', headSha: HEAD_A }, f.user), 'STALE_TARGET');
  fails(() => f.command('record_pr', { operationId: 'publish', number: 1, url: 'https://example.test/pr/1', headSha: HEAD_B }), 'STALE_OPERATION');
  const result = f.command('approve_publication', { operationId: 'publish', headSha: HEAD_B }, f.user); assert.equal(result.intents[0].kind, 'publish');
  fails(() => f.command('record_pr', { operationId: 'publish', number: 1, url: 'https://example.test/pr/1', headSha: HEAD_A }), 'STALE_TARGET');
  f.command('record_pr', { operationId: 'publish', number: 1, url: 'https://example.test/pr/1', headSha: HEAD_B });
  f.command('record_merged'); assert.equal(f.goal.status, 'merged');
});

test('version conflicts and unknown commands fail without mutating state', () => {
  const f = fixture();
  fails(() => transition(f.goal, { id: 'stale', goalId: 'goal', expectedVersion: 0, type: 'abort', payload: {} }, f.user), 'VERSION_CONFLICT');
  fails(() => f.command('unknown'), 'UNKNOWN_COMMAND');
  assert.equal(f.goal.version, 1);
});

test('public projection excludes contracts, provider conversation and local runtime identities', () => {
  const f = fixture(); f.approve(); f.request('a', 'implementer', 'A'); f.dispatch('a');
  const output = goalView(f.goal); const serialized = JSON.stringify(output);
  assert.ok(!serialized.includes('conversation_a')); assert.ok(!serialized.includes('/tmp/a'));
  assert.equal(output.attempts.at(-1).status, 'running'); assert.equal(output.tasks.length, 3);
});

test('adapter capabilities distinguish interactive and background role support', () => {
  const port = { capabilities: [{ role: 'planner', mode: 'interactive' }] };
  requireCapability(port, 'planner', 'interactive');
  fails(() => requireCapability(port, 'planner', 'background'), 'UNSUPPORTED_CAPABILITY');
});

test('reviewer result preserves physical ownership until a separate stopped observation', () => {
  const f = fixture(); f.command('publish_contract', { contract: contract() }, f.user);
  f.request('r', 'reviewer'); f.dispatch('r');
  f.command('record_review', { attemptId: 'r', reviewId: 'review', review: { schemaVersion: 1, target: planTarget(f.goal), disposition: 'accept', findings: [] } });
  assert.equal(f.goal.attempts[0].status, 'succeeded');
  assert.equal(f.goal.attempts[0].workerState, 'running');
  fails(() => f.request('second', 'reviewer'), 'ALREADY_RUNNING');
  f.command('record_stopped', { attemptId: 'r' });
  assert.equal(f.goal.attempts[0].workerState, 'stopped');
  assert.equal(f.goal.attempts[0].status, 'succeeded');
});

test('abort retains dispatch-gap ownership and terminates a late observed child', () => {
  const f = fixture(); f.approve(); f.request('a', 'implementer', 'A');
  f.command('abort', {}, f.user);
  assert.equal(f.goal.attempts.at(-1).workerState, 'unknown');
  const result = f.dispatch('a');
  assert.equal(result.intents[0].kind, 'terminate');
  assert.equal(f.goal.status, 'aborted');
  f.command('record_stopped', { attemptId: 'a' });
  assert.equal(f.goal.attempts.at(-1).workerState, 'stopped');
});

test('confirmed termination of an incomplete current task enables an explicit retry', () => {
  const f = fixture(); f.approve(); f.request('a', 'implementer', 'A'); f.dispatch('a');
  f.command('record_stopped', { attemptId: 'a' });
  assert.equal(f.goal.tasks[0].status, 'failed');
  f.command('retry_task', { taskId: 'A' }, f.user); f.request('a2', 'implementer', 'A');
});

test('aborted goals cannot acquire a PR without a saved publication operation', () => {
  const f = fixture(); f.command('abort', {}, f.user);
  fails(() => f.command('record_pr', { operationId: 'invented', number: 1, url: 'https://example.test/pr/1', headSha: BASE }), 'STALE_OPERATION');
});

test('conflict resolution and failed-check repair both produce new integration heads requiring new evidence', () => {
  const f = fixture(); const c = contract(); c.tasks = [c.tasks[0]]; f.approve(c);
  f.request('a', 'implementer', 'A'); f.dispatch('a'); f.command('confirm_candidate', { attemptId: 'a', headSha: HEAD_A }); f.command('record_stopped', { attemptId: 'a' });
  f.request('ar', 'reviewer', 'A'); f.dispatch('ar'); f.review('ar', HEAD_A);
  f.command('request_integration', { taskId: 'A', operationId: 'integrate' });
  f.command('record_integration_conflict', { operationId: 'integrate' });
  f.request('conflict', 'integrator'); f.dispatch('conflict');
  f.command('confirm_integration_repair', { attemptId: 'conflict', operationId: 'integrate', headSha: HEAD_B });
  f.command('record_stopped', { attemptId: 'conflict' });
  assert.equal(f.goal.tasks[0].status, 'integrated');
  f.request('final', 'reviewer'); f.dispatch('final'); f.review('final', HEAD_B);
  f.command('record_verification', { headSha: HEAD_B, checks: [{ id: 'unit', passed: false, artifactId: 'failure' }] });
  f.request('repair', 'integrator'); f.dispatch('repair');
  f.command('record_failure', { attemptId: 'repair', error: 'process failed', confirmedStopped: true });
  f.request('repair2', 'integrator'); f.dispatch('repair2');
  const repaired = 'd'.repeat(40);
  f.command('confirm_integration_repair', { attemptId: 'repair2', headSha: repaired });
  f.command('record_stopped', { attemptId: 'repair2' });
  assert.equal(f.goal.verification, null);
  fails(() => f.command('request_publication', { operationId: 'publish' }), 'NOT_READY');
  f.request('review2', 'reviewer'); f.dispatch('review2'); f.review('review2', repaired);
  f.command('record_verification', { headSha: repaired, checks: [{ id: 'unit', passed: true, artifactId: 'passed' }] });
  f.command('request_publication', { operationId: 'publish' });
  f.command('approve_publication', { operationId: 'publish', headSha: repaired }, f.user);
  f.command('abort', {}, f.user);
  f.command('record_pr', { operationId: 'publish', number: 1, url: 'https://example.test/pr/1', headSha: repaired });
  assert.equal(f.goal.status, 'aborted'); assert.equal(f.goal.pr.number, 1);
});

test('task ownership survives head advancement, and late liveness failure preserves candidate evidence', () => {
  const f = fixture(); f.approve();
  f.request('a', 'implementer', 'A'); f.dispatch('a');
  f.command('confirm_candidate', { attemptId: 'a', headSha: HEAD_A });
  f.request('ar', 'reviewer', 'A'); f.dispatch('ar'); f.review('ar', HEAD_A, true);
  f.request('b', 'implementer', 'B'); f.dispatch('b');
  f.command('confirm_candidate', { attemptId: 'b', headSha: HEAD_B });
  f.request('br', 'reviewer', 'B'); f.dispatch('br'); f.review('br', HEAD_B);
  f.command('request_integration', { operationId: 'integrate_b', taskId: 'B' });
  f.command('record_integration', { operationId: 'integrate_b', headSha: HEAD_B });
  fails(() => f.request('a2', 'implementer', 'A'), 'ALREADY_RUNNING');
  f.command('record_failure', { attemptId: 'a', confirmedStopped: true, error: 'worker exited after result' });
  assert.equal(f.goal.tasks[0].status, 'repair_required');
  assert.equal(f.goal.attempts.find((attempt) => attempt.id === 'a').status, 'succeeded');
  f.request('a2', 'implementer', 'A');
  f.command('record_failure', { attemptId: 'b', confirmedStopped: true, error: 'worker exited after result' });
  assert.equal(f.goal.tasks[1].status, 'integrated');
});

test('reconciliation can adopt an uncertain launch identity and restore result authority', () => {
  const f = fixture(); f.approve(); f.request('a', 'implementer', 'A');
  f.command('record_failure', { attemptId: 'a', uncertain: true, error: 'response lost' });
  f.dispatch('a'); assert.equal(f.goal.attempts.at(-1).workerState, 'running');
  f.command('confirm_candidate', { attemptId: 'a', headSha: HEAD_A });
  assert.equal(f.goal.tasks[0].status, 'in_review');
});

test('a completed conflict result does not release the integration checkout while its worker lives', () => {
  const f = fixture(); f.approve();
  for (const [id, taskId, head] of [['a', 'A', HEAD_A], ['b', 'B', HEAD_B]]) {
    f.request(id, 'implementer', taskId); f.dispatch(id); f.command('confirm_candidate', { attemptId: id, headSha: head });
    f.command('record_stopped', { attemptId: id }); f.request(`${id}r`, 'reviewer', taskId); f.dispatch(`${id}r`); f.review(`${id}r`, head);
  }
  f.command('request_integration', { taskId: 'A', operationId: 'ia' });
  f.command('record_integration_conflict', { operationId: 'ia' });
  f.request('conflict', 'integrator'); f.dispatch('conflict');
  f.command('confirm_integration_repair', { attemptId: 'conflict', operationId: 'ia', headSha: HEAD_A });
  fails(() => f.command('request_integration', { taskId: 'B', operationId: 'ib' }), 'NOT_READY');
  f.command('record_stopped', { attemptId: 'conflict' });
  f.command('request_integration', { taskId: 'B', operationId: 'ib' });
});


for (const final of [false, true]) test(`stopped repair results block duplicate admission until disposition; final=${final}`, () => {
  const f = fixture(), c = contract(); c.tasks = [c.tasks[0]]; f.approve(c);
  f.request('a', 'implementer', 'A'); f.dispatch('a'); f.command('confirm_candidate', { attemptId: 'a', headSha: HEAD_A }); f.command('record_stopped', { attemptId: 'a' });
  f.request('ar', 'reviewer', 'A'); f.dispatch('ar'); f.review('ar', HEAD_A);
  f.command('request_integration', { taskId: 'A', operationId: 'integrate' });
  if (final) {
    f.command('record_integration', { operationId: 'integrate', headSha: HEAD_A });
    f.command('record_verification', { headSha: HEAD_A, checks: [{ id: 'unit', passed: false, artifactId: 'failure' }] });
  } else f.command('record_integration_conflict', { operationId: 'integrate' });
  f.request('repair', 'integrator'); f.dispatch('repair');
  f.command('receive_role_result', { resultId: 'result', attemptId: 'repair', artifactId: 'a'.repeat(64) });
  f.command('record_stopped', { attemptId: 'repair' });
  const before = structuredClone(f.goal);
  assert.equal(readyWork(f.goal).some(work => work.role === 'integrator'), false);
  fails(() => f.request('duplicate', 'integrator'), 'NOT_READY');
  assert.deepEqual(f.goal, before, 'Refused admission must not consume repair budget or create an attempt');
  f.command('reject_role_result', { resultId: 'result', code: 'MALFORMED_RESULT' });
  assert.equal(readyWork(f.goal).some(work => work.role === 'integrator'), true);
  f.request('replacement', 'integrator');
});
