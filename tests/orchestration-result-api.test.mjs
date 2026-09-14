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
  await results.drain(); const result = store.get('goal').results[0];
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
  await results.drain(); const version = store.get('goal').version;
  assert.deepEqual((await app.inject({ method: 'POST', url, headers, payload })).json(), { id: 'invalid', status: 'rejected', code: 'MALFORMED_RESULT' });
  assert.equal(store.get('goal').version, version);
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, raw: '{}' } })).statusCode, 403);
  service.execute({ id: 'abort', goalId: 'goal', expectedVersion: version, type: 'abort', payload: {} }, { kind: 'user' });
  assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 403);
  bridgeAuth.revoke('goal', 'planner');
  assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 401);
});

test('accepted planner question receipt survives lost response but cannot revive after answer', async t => {
  const { app, planner, store, results, service } = await apiFixture(t, { resultIntake: true });
  const credential = planner(), attempt = store.get('goal').attempts[0];
  const url = '/api/orchestration/agent/results', headers = { authorization: `Bearer ${credential}` };
  const raw = JSON.stringify({ schemaVersion: 1, goalId: 'goal', attemptId: attempt.id, operationId: attempt.operationId,
    generation: attempt.generation, revision: attempt.revision, role: 'planner', target: attempt.target, output: { question: 'Which audience?' } });
  const payload = { id: 'question', raw };
  assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 202);
  await results.drain();
  assert.equal(store.get('goal').results[0].status, 'accepted');
  const version = store.get('goal').version;
  const replay = await app.inject({ method: 'POST', url, headers, payload });
  assert.equal(replay.statusCode, 202); assert.equal(replay.json().status, 'accepted');
  assert.equal(store.get('goal').version, version);
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, raw: raw.replace('Which audience?', 'Changed question') } })).statusCode, 403);
  service.execute({ id: 'answer', goalId: 'goal', expectedVersion: version, type: 'answer_clarification', payload: { answer: 'Beginners' } }, { kind: 'user' });
  assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 403);
});

test('MCP malformed planner payload is correctable with the same id before durable intake', async t => {
  const { agentMcpRequest } = await import('../server/orchestration/agent-mcp.mjs');
  const { contract } = await import('./helpers/orchestration/domain-fixture.mjs');
  const { app, planner, store, results } = await apiFixture(t, { resultIntake: true });
  const credential = planner(), goal = store.get('goal'), attempt = goal.attempts[0];
  const binding = { goalId: goal.id, attemptId: attempt.id, operationId: attempt.operationId, generation: attempt.generation, revision: attempt.revision, role: 'planner', target: attempt.target };
  let submissions = 0;
  const bridge = { submitResult: async payload => {
    submissions++;
    const response = await app.inject({ method: 'POST', url: '/api/orchestration/agent/results', headers: { authorization: `Bearer ${credential}` }, payload });
    assert.equal(response.statusCode, 202, response.body); return response.json();
  } };
  const invoke = args => agentMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'submit_result', arguments: args } }, { binding, bridge });
  const call = output => invoke({ id: 'same-result', output });
  const nested = { schemaVersion: 1, ...binding, output: { question: 'private question must not appear in errors' } };
  for (const output of [nested, { output: { question: 'Nested' } }, { question: '' }, { question: 'Which audience?', contract: contract() }, { contract: {} }, { question: 'Question', goalId: 'other' }]) {
    const response = await call(output); assert.equal(response.result.isError, true);
    const error = JSON.parse(response.result.content[0].text); assert.equal(error.code, 'INVALID_PLANNER_OUTPUT');
    assert.match(error.message, /Nothing was queued/); assert.doesNotMatch(error.message, /private question/);
    assert.equal(submissions, 0); assert.deepEqual(store.get('goal'), goal, 'malformed input consumes neither journal version nor result id');
  }
  for (const args of [[], 'invalid arguments', null, { id: 'same-result', output: { question: 'Question' }, ...binding }, { output: { question: 'Question' } }, { id: 'invalid id', output: { question: 'Question' } }]) {
    const response = await invoke(args); assert.equal(response.result.isError, true);
    assert.equal(JSON.parse(response.result.content[0].text).code, 'INVALID_PLANNER_OUTPUT');
    assert.equal(submissions, 0); assert.deepEqual(store.get('goal'), goal);
  }
  const listed = await agentMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { binding, bridge });
  const schema = listed.result.tools.find(tool => tool.name === 'submit_result').inputSchema.properties.output;
  assert.deepEqual(schema.oneOf.map(branch => branch.required), [['question'], ['contract']]);
  assert.ok(schema.oneOf.every(branch => branch.additionalProperties === false));
  assert.deepEqual(schema.oneOf[1].properties.contract.required, ['schemaVersion', 'outcome', 'scope', 'exclusions', 'criteria', 'verification', 'tasks']);
  const corrected = await call({ question: 'Which audience?' }); assert.equal(corrected.result.isError, undefined); assert.equal(submissions, 1);
  await results.drain();
  const settled = store.get('goal'); assert.equal(settled.results[0].id, 'same-result'); assert.equal(settled.results[0].status, 'accepted'); assert.equal(settled.clarification.question, 'Which audience?');
  assert.notEqual(settled.attempts[0].status, 'failed');
  const view = await app.inject({ url: '/api/orchestration/goals/goal', headers: HEADERS });
  assert.equal(view.statusCode, 200); assert.ok(view.json().actions.some(action => action.type === 'answer_clarification'));
});

test('MCP validates contract graph before submission and preserves server acceptance without granting approval', async t => {
  const { agentMcpRequest } = await import('../server/orchestration/agent-mcp.mjs');
  const { contract } = await import('./helpers/orchestration/domain-fixture.mjs');
  const { app, planner, store, results } = await apiFixture(t, { resultIntake: true });
  const credential = planner(), attempt = store.get('goal').attempts[0], plan = contract();
  const binding = { goalId: 'goal', attemptId: attempt.id, operationId: attempt.operationId, generation: attempt.generation, revision: attempt.revision, role: 'planner', target: attempt.target };
  let submissions = 0;
  const bridge = { submitResult: async payload => {
    submissions++;
    const response = await app.inject({ method: 'POST', url: '/api/orchestration/agent/results', headers: { authorization: `Bearer ${credential}` }, payload });
    assert.equal(response.statusCode, 202, response.body); return response.json();
  } };
  const call = value => agentMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'submit_result', arguments: { id: 'plan', output: { contract: value } } } }, { binding, bridge });
  const invalid = structuredClone(plan); invalid.criteria[0].verification = 'missing-check';
  const invalidResponse = await call(invalid); assert.equal(invalidResponse.result.isError, true);
  assert.match(JSON.parse(invalidResponse.result.content[0].text).reason, /unknown check/); assert.equal(submissions, 0); assert.equal(store.get('goal').results, undefined);
  assert.equal((await call(plan)).result.isError, undefined); assert.equal(submissions, 1);
  await results.drain();
  assert.equal(store.get('goal').results[0].status, 'accepted'); assert.equal(store.get('goal').revision, 1); assert.equal(store.get('goal').approvedRevision, null);
});
