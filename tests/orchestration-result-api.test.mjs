import assert from 'node:assert/strict';
import test from 'node:test';
import { apiFixture, HEADERS } from './helpers/orchestration/api-fixture.mjs';

test('result intake requires scoped credential and same-origin enforcement, including encoded routes', async (t) => {
  const { app, planner, store } = await apiFixture(t, { resultIntake: true }); const credential = planner();
  const payload = { id: 'result', raw: '{}' };
  for (const url of ['/api/orchestration/agent/results', '/api/%6frchestration/agent/results']) {
    assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url, headers: HEADERS, payload })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${credential}`, origin: 'https://attacker.test' }, payload })).statusCode, 403);
  }
  const response = await app.inject({ method: 'POST', url: '/api/orchestration/agent/results', headers: { authorization: `Bearer ${credential}` }, payload: { ...payload, authority: { kind: 'system' } } });
  assert.equal(response.statusCode, 400); assert.equal(store.get('goal').results, undefined);
});

test('raw result identity cannot redirect intake to another goal or elevate the submitting role', async (t) => {
  const { app, planner, store, results, artifacts } = await apiFixture(t, { resultIntake: true }); const credential = planner();
  const raw = JSON.stringify({ schemaVersion: 1, goalId: 'other', attemptId: 'reviewer', operationId: 'op', generation: 1, revision: 0, role: 'reviewer', target: 'contract:1:0', output: { disposition: 'accept' } });
  const response = await app.inject({ method: 'POST', url: '/api/orchestration/agent/results', headers: { authorization: `Bearer ${credential}` }, payload: { id: 'spoof', raw } });
  assert.equal(response.statusCode, 202); assert.equal(store.get('other'), null);
  results.drain(); const result = store.get('goal').results[0];
  assert.equal(result.status, 'rejected'); assert.equal(result.code, 'FORBIDDEN');
  assert.equal(artifacts.get(result.artifactId).toString(), raw);
  assert.equal(store.get('goal').approvedRevision, null);
});

test('unconfigured result intake fails closed and oversized input leaves no durable receipt', async (t) => {
  const missing = await apiFixture(t), credential = missing.planner();
  const url = '/api/orchestration/agent/results';
  assert.equal((await missing.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${credential}` }, payload: { id: 'r', raw: '{}' } })).json().code, 'UNSUPPORTED_CAPABILITY');
  const configured = await apiFixture(t, { resultIntake: true }), secret = configured.planner();
  assert.equal((await configured.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${secret}` }, payload: { id: 'large', raw: 'x'.repeat(2 * 1024 * 1024) } })).statusCode, 413);
  assert.equal(configured.store.get('goal').results, undefined);
});

test('rejected receipt replay is read-only while explicit revocation and abort remain enforced', async (t) => {
  const { app, planner, store, results, service, bridgeAuth } = await apiFixture(t, { resultIntake: true }); const credential = planner();
  const url = '/api/orchestration/agent/results', headers = { authorization: `Bearer ${credential}` }, payload = { id: 'invalid', raw: 'not structured output' };
  assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 202);
  results.drain(); const version = store.get('goal').version;
  assert.deepEqual((await app.inject({ method: 'POST', url, headers, payload })).json(), { id: 'invalid', status: 'rejected', code: 'MALFORMED_RESULT' });
  assert.equal(store.get('goal').version, version);
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, raw: '{}' } })).statusCode, 403);
  service.execute({ id: 'abort', goalId: 'goal', expectedVersion: version, type: 'abort', payload: {} }, { kind: 'user' });
  assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 403);
  bridgeAuth.revoke('goal', 'planner');
  assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 401);
});
