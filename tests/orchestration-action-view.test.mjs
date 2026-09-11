import assert from 'node:assert/strict';
import test from 'node:test';
import { actionView } from '../server/orchestration/domain/action-view.mjs';
import { fixture } from './helpers/orchestration/domain-fixture.mjs';
import { apiFixture, HEADERS, create } from './helpers/orchestration/api-fixture.mjs';

test('public actions follow review authority without mutating durable state', () => {
  const f = fixture();
  const original = structuredClone(f.goal);
  assert.ok(!actionView(f.goal).actions.some(a => a.type === 'approve'));
  assert.deepEqual(f.goal, original);
  f.approve();
  assert.ok(!actionView(f.goal).actions.some(a => a.type === 'approve'));
  assert.ok(actionView(f.goal).actions.some(a => a.type === 'abort'));
  f.command('abort', {}, f.user);
  assert.ok(!actionView(f.goal).actions.some(a => a.type === 'approve'));
});
test('retry history exposes only latest eligible attempt without quadratic projection work', () => {
  const f = fixture(); f.request('planner', 'planner');
  const attempt = f.goal.attempts[0];
  f.goal.attempts = Array.from({ length: 1000 }, (_, i) => ({ ...attempt, id: `planner${i}`, status: 'failed', workerState: 'stopped', retryRequested: i < 999 }));
  const start = performance.now();
  const actions = actionView(f.goal).actions.filter(a => a.type === 'retry_attempt');
  assert.equal(actions.length, 1); assert.equal(actions[0].payload.attemptId, 'planner999');
  assert.ok(performance.now() - start < 500, '1000 retries should not block the event loop for seconds');
});
test('configuration is authenticated and reconciliation checks readonly and exact version', async t => {
  let calls = 0;
  const { app } = await apiFixture(t, { configuration: async () => [{ id: 'repo', baseBranch: 'main', baseSha: 'a'.repeat(40) }], reconcile: async () => { calls++; } });
  assert.equal((await app.inject({ url: '/api/orchestration/configuration' })).statusCode, 401);
  const config = await app.inject({ url: '/api/orchestration/configuration', headers: HEADERS });
  assert.equal(config.json().repositories[0].id, 'repo');
  await app.inject({ method: 'POST', url: '/api/orchestration/commands', headers: HEADERS, payload: create });
  const reconcile = expectedVersion => app.inject({ method: 'POST', url: '/api/orchestration/goals/goal/reconcile', headers: HEADERS, payload: { expectedVersion } });
  assert.equal((await reconcile(0)).statusCode, 409); assert.equal(calls, 0);
  assert.equal((await reconcile(1)).statusCode, 200); assert.equal(calls, 1);
  const readonly = await apiFixture(t, { readOnly: true, reconcile: async () => { calls++; } });
  assert.equal((await readonly.app.inject({ method: 'POST', url: '/api/orchestration/goals/goal/reconcile', headers: HEADERS, payload: { expectedVersion: 1 } })).statusCode, 403);
  assert.equal(calls, 1);
});
