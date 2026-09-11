import assert from 'node:assert/strict';
import test from 'node:test';
import { apiFixture, HEADERS } from './helpers/orchestration/api-fixture.mjs';
import { Reconciler } from '../server/orchestration/reconciler.mjs';

test('planner resume persists intent, replays response loss and settles one receipt without another conversation', async (t) => {
  const { service, store, planner } = await apiFixture(t); planner();
  const attempts = [], seen = new Set(); let loseResponse = true;
  service.agents.observe = async () => ({ status: 'running', identity: 'planner_process' });
  service.agents.resume = async (request) => {
    attempts.push(request); seen.add(request.resumeId);
    if (loseResponse) { loseResponse = false; throw new Error('response lost'); }
    return { identity: request.attempt.identity };
  };
  const command = { id: 'r'.repeat(128), goalId: 'goal', expectedVersion: store.get('goal').version, type: 'resume_planner', payload: { attemptId: 'planner' } };
  service.execute(command, { kind: 'user' }); service.execute(command, { kind: 'user' });
  const reconciler = new Reconciler({ service, ownership: { assertOwned() {} } });
  await reconciler.run(); assert.equal(store.operations().filter(entry => entry.kind === 'resume')[0].status, 'dispatching');
  await reconciler.run(); assert.equal(seen.size, 1); assert.equal(attempts.length, 2);
  assert.equal(attempts[0].attempt.conversationId, 'conversation');
  assert.ok(attempts[0].resumeId.startsWith('resume_') && attempts[0].resumeId.length <= 128);
  assert.deepEqual(store.get('goal').attempts[0].lastResume, { id: 'r'.repeat(128), code: null });
  assert.equal(store.operations().filter(entry => entry.kind === 'resume').length, 0);
  assert.equal(store.events({ limit: 100 }).filter(event => event.kind === 'planner_resumed').length, 1);
});

test('resume result commit before intent settlement is recovered without replaying its adapter effect', async (t) => {
  const { service, store, planner } = await apiFixture(t); planner(); let calls = 0;
  service.agents.observe = async () => ({ status: 'running', identity: 'planner_process' });
  service.agents.resume = async () => { calls++; return { identity: 'planner_process' }; };
  service.execute({ id: 'resume', goalId: 'goal', expectedVersion: store.get('goal').version, type: 'resume_planner', payload: { attemptId: 'planner' } }, { kind: 'user' });
  const advance = store.advanceOperation.bind(store); let fail = true;
  store.advanceOperation = (id, before, after) => { if (id === 'resume' && after === 'completed' && fail) { fail = false; throw new Error('after result commit'); } return advance(id, before, after); };
  const reconciler = new Reconciler({ service, ownership: { assertOwned() {} } });
  await assert.rejects(reconciler.run(), /after result commit/); await reconciler.run();
  assert.equal(calls, 1); assert.equal(store.events({ limit: 100 }).filter(event => event.kind === 'planner_resumed').length, 1);
});

test('abort fences queued resume and agent authority cannot request it', async (t) => {
  const { service, store, planner, bridgeAuth } = await apiFixture(t); const credential = planner(); let calls = 0;
  service.agents.observe = async () => ({ status: 'running', identity: 'planner_process' });
  service.agents.terminate = async () => {};
  service.agents.resume = async () => { calls++; return { identity: 'planner_process' }; };
  const command = { id: 'resume', goalId: 'goal', expectedVersion: store.get('goal').version, type: 'resume_planner', payload: { attemptId: 'planner' } };
  assert.throws(() => service.execute(command, bridgeAuth.authenticate(credential)), { code: 'FORBIDDEN' });
  service.execute(command, { kind: 'user' });
  service.execute({ id: 'abort', goalId: 'goal', expectedVersion: store.get('goal').version, type: 'abort', payload: {} }, { kind: 'user' });
  await new Reconciler({ service, ownership: { assertOwned() {} } }).run();
  assert.equal(calls, 0); assert.equal(store.operations().filter(entry => entry.kind === 'resume').length, 0);
});


test('terminal opening requires pairing, current target/version, ownership and a writable interface', async (t) => {
  const f = await apiFixture(t); f.planner(); let opened = 0;
  f.service.ownership = { assertOwned() {} };
  f.service.agents.open = async operationId => { assert.equal(operationId, 'planner_operation'); opened++; };
  const request = { method: 'POST', url: '/api/orchestration/goals/goal/terminal', headers: HEADERS, payload: { expectedVersion: 3, attemptId: 'planner' } };
  assert.equal((await f.app.inject({ ...request, headers: { host: 'localhost', origin: 'http://localhost' } })).statusCode, 401);
  assert.equal((await f.app.inject({ ...request, payload: { ...request.payload, attemptId: 'another' } })).statusCode, 409);
  assert.equal((await f.app.inject({ ...request, payload: { ...request.payload, expectedVersion: 2 } })).statusCode, 409);
  f.service.ownership = undefined;
  assert.equal((await f.app.inject(request)).statusCode, 400);
  assert.equal(opened, 0); f.service.ownership = { assertOwned() {} };
  assert.deepEqual((await f.app.inject(request)).json(), { opened: true }); assert.equal(opened, 1);
  f.service.execute({ id: 'abort', goalId: 'goal', expectedVersion: 3, type: 'abort', payload: {} }, { kind: 'user' });
  assert.equal((await f.app.inject({ ...request, payload: { ...request.payload, expectedVersion: 4 } })).statusCode, 409);
  assert.equal(opened, 1);
  const readonly = await apiFixture(t, { readOnly: true }); readonly.planner();
  readonly.service.agents.open = async () => { throw new Error('Read-only must not reach adapter'); };
  assert.equal((await readonly.app.inject(request)).statusCode, 403);
});
