import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, contract, BASE, HEAD_A, HEAD_B } from './helpers/orchestration/domain-fixture.mjs';
import { parseContract, readyTasks } from '../server/orchestration/domain/graph.mjs';
import { currentWave, waveChecks } from '../server/orchestration/domain/waves.mjs';
import { readyWork } from '../server/orchestration/domain/scheduling.mjs';
const proposed = () => ({ ...contract(), schemaVersion: 2,
  tasks: contract().tasks.map(task => ({ ...task, resources: [] })),
  verification: [{ id: 'modules', argv: ['node', '--test', 'modules.test.mjs'] }, ...contract().verification],
  waves: [{ id: 'modules', title: 'Independent modules', taskIds: ['A', 'B'], checkIds: ['modules'] }, { id: 'composition', title: 'Compose outputs', taskIds: ['C'], checkIds: ['modules', 'unit'] }],
});
function finish(f, taskId, head) {
  const id = taskId.toLowerCase();
  f.command('confirm_candidate', { attemptId: id, headSha: head }); f.command('record_stopped', { attemptId: id });
  f.request(`${id}r`, 'reviewer', taskId); f.dispatch(`${id}r`); f.review(`${id}r`, head);
  f.command('request_integration', { taskId, operationId: `i${id}` }); f.command('record_integration', { operationId: `i${id}`, headSha: head });
}
function modules() {
  const f = fixture(); f.approve(proposed());
  for (const id of ['A', 'B']) { f.request(id.toLowerCase(), 'implementer', id); f.dispatch(id.toLowerCase()); }
  finish(f, 'A', HEAD_A); finish(f, 'B', HEAD_B); return f;
}
function result(f, operationId, passed = true, headSha = f.goal.integrationHead) {
  return { operationId, result: { verification: { headSha, checks: waveChecks(f.goal).map(check => ({ id: check.id, passed, artifactId: 'log' })) }, workerState: 'stopped', artifactId: 'f'.repeat(64) } };
}
test('wave contracts reject missing coverage, dependencies, overlapping paths and shared resources', () => {
  assert.equal(parseContract(proposed()).waves.length, 2);
  for (const mutate of [
    value => { delete value.waves; },
    value => { value.waves[0].taskIds = ['A']; },
    value => { value.waves[1].taskIds.push('A'); },
    value => { value.waves[0].taskIds.push('C'); value.waves.pop(); },
    value => { value.tasks[1].ownedAreas = ['src/a.mjs']; value.tasks[0].integrationPolicy = value.tasks[1].integrationPolicy = 'serialize'; },
    value => { value.tasks[0].resources = value.tasks[1].resources = ['shared-api']; },
    value => { value.waves[0].checkIds = []; },
    value => { value.waves[0].checkIds = ['unknown']; },
    value => { value.waves[1].checkIds = ['modules']; },
  ]) { const value = proposed(); mutate(value); assert.throws(() => parseContract(value)); }
});
test('siblings overlap but the next wave waits for checks of their exact integrated output', () => {
  const f = fixture(); f.approve(proposed());
  assert.deepEqual(readyTasks(f.goal).map(task => task.id), ['A', 'B']);
  f.request('a', 'implementer', 'A'); f.dispatch('a'); f.request('b', 'implementer', 'B'); f.dispatch('b');
  assert.equal(f.goal.attempts.filter(attempt => attempt.role === 'implementer' && attempt.status === 'running').length, 2);
  finish(f, 'A', HEAD_A);
  assert.throws(() => f.command('request_verification', { operationId: 'early' }), { code: 'NOT_READY' });
  finish(f, 'B', HEAD_B);
  assert.deepEqual(readyTasks(f.goal), []);
  assert.throws(() => f.request('c', 'implementer', 'C'), { code: 'NOT_READY' });
  const request = f.command('request_verification', { operationId: 'checks' });
  assert.deepEqual(request.intents[0].payload.checks, [{ id: 'modules', argv: ['node', '--test', 'modules.test.mjs'] }]);
  assert.throws(() => f.command('record_verification_result', result(f, 'checks', true, BASE)), { code: 'STALE_TARGET' });
  f.command('record_verification_result', result(f, 'checks'));
  assert.equal(currentWave(f.goal).id, 'composition'); assert.equal(f.goal.waveResults[0].headSha, HEAD_B);
  f.request('c', 'implementer', 'C'); assert.equal(f.goal.attempts.at(-1).baseSha, HEAD_B);
  f.dispatch('c'); finish(f, 'C', 'd'.repeat(40));
  assert.equal(f.goal.waveResults[0].headSha, HEAD_B, 'later integration retains the prior barrier evidence');
  const final = f.command('request_verification', { operationId: 'final' });
  assert.deepEqual(final.intents[0].payload.checks.map(check => check.id), ['modules', 'unit']);
  f.command('record_verification_result', result(f, 'final'));
  assert.equal(currentWave(f.goal), null);
  assert.ok(readyWork(f.goal).some(work => work.role === 'reviewer' && work.taskId === null));
});
test('a failed wave holds the goal until manual recovery and supports a bounded integrated repair', () => {
  const f = modules(); f.command('request_verification', { operationId: 'failed' });
  f.command('record_verification_result', result(f, 'failed', false));
  assert.ok(f.goal.hold); assert.deepEqual(readyWork(f.goal), []);
  f.recover(); assert.deepEqual(readyWork(f.goal).map(work => work.role), ['integrator']);
  f.request('repair', 'integrator'); f.dispatch('repair');
  const repaired = 'e'.repeat(40); f.command('confirm_integration_repair', { attemptId: 'repair', headSha: repaired }); f.command('record_stopped', { attemptId: 'repair' });
  f.command('request_verification', { operationId: 'repaired' }); f.command('record_verification_result', result(f, 'repaired'));
  f.request('c', 'implementer', 'C'); assert.equal(f.goal.attempts.at(-1).baseSha, repaired);
});
test('same-head wave verification does not reuse the prior wave receipt', () => {
  const f = modules(); f.command('request_verification', { operationId: 'first' }); f.command('record_verification_result', result(f, 'first'));
  f.request('c', 'implementer', 'C'); f.dispatch('c'); finish(f, 'C', HEAD_B);
  f.command('request_verification', { operationId: 'second' });
  assert.equal(f.goal.verificationRuns.at(-1).waveId, 'composition');
  assert.throws(() => f.command('record_verification_result', { ...result(f, 'second'), result: { ...result(f, 'second').result, verification: { headSha: HEAD_B, checks: [{ id: 'modules', passed: true, artifactId: 'log' }] } } }), /every required check/);
});

test('journal restart retains wave admission and cannot reuse a previous revision barrier', async t => {
  const { OrchestrationStore } = await import('../server/orchestration/storage/store.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'companion-waves-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = modules(); f.command('request_verification', { operationId: 'before-restart' });
  f.command('record_verification_result', result(f, 'before-restart'));
  const path = join(directory, 'state.sqlite'); let store = new OrchestrationStore({ path });
  store.apply({ id: 'seed', goalId: 'goal', expectedVersion: 0, type: 'create_goal', payload: {} }, { kind: 'user' }, () => ({ goal: f.goal, events: [], intents: [] }));
  store.close(); store = new OrchestrationStore({ path }); t.after(() => store.close());
  assert.deepEqual(readyTasks(store.get('goal')).map(task => task.id), ['C']);
  assert.equal(currentWave(store.get('goal')).id, 'composition');
  f.command('request_revision', { message: 'Change the scope' }, f.user);
  f.command('publish_contract', { contract: proposed() }, f.user);
  assert.equal(currentWave(f.goal).id, 'modules', 'old barrier evidence cannot approve a revised plan');
  assert.deepEqual(readyTasks(f.goal), []);
});

test('the public creation boundary requires explicit waves for all new goals', async t => {
  const { apiFixture, HEADERS, create } = await import('./helpers/orchestration/api-fixture.mjs');
  const { app, service, store } = await apiFixture(t);
  const created = await app.inject({ method: 'POST', url: '/api/orchestration/commands', headers: HEADERS, payload: create });
  assert.equal(created.statusCode, 200); assert.equal(store.get('goal').contractSchema, 2);
  const publish = value => service.execute({ id: 'plan', goalId: 'goal', expectedVersion: 1, type: 'publish_contract', payload: { contract: value } }, { kind: 'user' });
  assert.throws(() => publish(contract()), /explicit waves/);
  publish(proposed()); assert.equal(store.get('goal').contracts[0].contract.schemaVersion, 2);
});
