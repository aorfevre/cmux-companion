import assert from 'node:assert/strict';
import test from 'node:test';
import { apiFixture, TOKEN, HEADERS, create } from './helpers/orchestration/api-fixture.mjs';
const url = '/api/orchestration/commands';

test('user mutations require pairing and same origin; agent/system authorities cannot be supplied in the body', async (t) => {
  const { app, store } = await apiFixture(t);
  assert.equal((await app.inject({ method: 'POST', url, payload: create })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url, headers: { ...HEADERS, origin: 'https://attacker.test' }, payload: create })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url, headers: HEADERS, payload: { ...create, authority: { kind: 'system' } } })).statusCode, 400);
  const created = await app.inject({ method: 'POST', url, headers: HEADERS, payload: create }); assert.equal(created.statusCode, 200);
  assert.equal(created.json().goal.status, 'discovering'); assert.ok(!created.body.includes('private-context'));
  assert.equal((await app.inject({ method: 'POST', url, headers: HEADERS, payload: { id: 'dispatch', goalId: 'goal', expectedVersion: 1, type: 'request_attempt', payload: {} } })).statusCode, 403);
  assert.equal(store.get('goal').version, 1);
});

test('pairing sets a private cookie and invalid pairing is rate limited', async (t) => {
  const { app } = await apiFixture(t);
  const pair = await app.inject({ method: 'POST', url: '/api/orchestration/pair', headers: { host: 'localhost', origin: 'http://localhost' }, payload: { token: TOKEN } });
  assert.equal(pair.statusCode, 200); assert.match(pair.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
  const cookie = pair.headers['set-cookie'].split(';')[0];
  assert.equal((await app.inject({ url: '/api/orchestration/snapshot', headers: { cookie } })).statusCode, 200);
  for (let i = 0; i < 10; i++) assert.equal((await app.inject({ method: 'POST', url: '/api/orchestration/pair', payload: { token: 'wrong' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/orchestration/pair', payload: { token: 'wrong' } })).statusCode, 429);
});

test('repository allow-list and expected versions are enforced at the service boundary', async (t) => {
  const { app, service } = await apiFixture(t);
  const disallowed = { ...create, payload: { ...create.payload, repositoryId: 'not_allowed' } };
  assert.throws(() => service.execute(disallowed, { kind: 'user' }), { code: 'FORBIDDEN' });
  await app.inject({ method: 'POST', url, headers: HEADERS, payload: create });
  const stale = await app.inject({ method: 'POST', url, headers: HEADERS, payload: { id: 'abort', goalId: 'goal', expectedVersion: 0, type: 'abort', payload: {} } });
  assert.equal(stale.statusCode, 409); assert.equal(stale.json().code, 'VERSION_CONFLICT');
});

test('snapshots and events require auth and omit provider identities; unknown goals are explicit', async (t) => {
  const { app, planner } = await apiFixture(t); planner();
  assert.equal((await app.inject({ url: '/api/orchestration/events' })).statusCode, 401);
  const snapshot = await app.inject({ url: '/api/orchestration/snapshot', headers: HEADERS });
  assert.equal(snapshot.json().cursor, 3); assert.ok(!snapshot.body.includes('private-context'));
  const events = await app.inject({ url: '/api/orchestration/events?since=1&limit=1', headers: HEADERS });
  assert.equal(events.json().events.length, 1);
  assert.equal((await app.inject({ url: '/api/orchestration/goals/missing', headers: HEADERS })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/orchestration/goals/goal', headers: HEADERS })).statusCode, 200);
});

test('agent credentials cannot approve, address another goal or call the user API', async (t) => {
  const { app, planner, store } = await apiFixture(t); const secret = planner();
  const headers = { authorization: `Bearer ${secret}` };
  const command = { id: 'approve', goalId: 'goal', expectedVersion: 3, type: 'approve', payload: { revision: 1 } };
  assert.equal((await app.inject({ method: 'POST', url: '/api/orchestration/agent/commands', headers, payload: command })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: command })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/orchestration/agent/commands', headers, payload: { ...command, goalId: 'other', type: 'publish_contract' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/orchestration/agent/status', headers })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/orchestration/agent/status', headers: HEADERS })).statusCode, 401);
  assert.equal(store.get('goal').version, 3);
});

test('credentials are hashed and explicit revocation or abort disables requests', async (t) => {
  const { app, planner, bridgeAuth, store, service } = await apiFixture(t); const secret = planner();
  const stored = store.db.prepare('SELECT * FROM agent_credentials').all(); assert.ok(!JSON.stringify(stored).includes(secret));
  bridgeAuth.revoke('goal', 'planner');
  assert.equal((await app.inject({ url: '/api/orchestration/agent/status', headers: { authorization: `Bearer ${secret}` } })).statusCode, 401);
  const next = bridgeAuth.issue('goal', 'planner'); service.execute({ id: 'abort', goalId: 'goal', expectedVersion: 3, type: 'abort', payload: {} }, { kind: 'user' });
  const rejected = await app.inject({ url: '/api/orchestration/agent/status', headers: { authorization: `Bearer ${next}` } });
  assert.equal(rejected.statusCode, 403); assert.ok(!rejected.body.includes(next));
});

test('encoded matched routes cannot bypass pairing or same-origin checks', async (t) => {
  const { app, store } = await apiFixture(t);
  for (const prefix of ['/api/%6frchestration', '/%61pi/orchestration', '/api/orchestrat%69on']) {
    assert.equal((await app.inject({ url: `${prefix}/snapshot` })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: `${prefix}/commands`, payload: create })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: `${prefix}/commands`, headers: { ...HEADERS, origin: 'https://attacker.test' }, payload: create })).statusCode, 403);
  }
  assert.equal(store.get('goal'), null);
});

test('cleanup preview is authenticated; cleanup execution preserves same-origin and readonly boundaries', async t => {
  let writes = 0;
  const cleanup = { preview: async goalId => ({ goalId, candidates: [] }), execute: async input => { writes++; return input; } };
  const { app } = await apiFixture(t, { cleanup });
  const path = '/api/orchestration/goals/goal/cleanup';
  assert.equal((await app.inject({ url: path })).statusCode, 401);
  assert.equal((await app.inject({ url: path, headers: HEADERS })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: path, headers: { ...HEADERS, origin: 'https://attacker.test' }, payload: {} })).statusCode, 403);
  assert.equal(writes, 0);
  const result = await app.inject({ method: 'POST', url: path, headers: HEADERS, payload: { expectedVersion: 2, attemptId: 'a' } });
  assert.deepEqual(result.json(), { goalId: 'goal', expectedVersion: 2, attemptId: 'a' }); assert.equal(writes, 1);
  const readonly = await apiFixture(t, { cleanup, readOnly: true });
  assert.equal((await readonly.app.inject({ url: path, headers: HEADERS })).statusCode, 200);
  assert.equal((await readonly.app.inject({ method: 'POST', url: path, headers: HEADERS, payload: { expectedVersion: 2, attemptId: 'a' } })).statusCode, 403);
  assert.equal(writes, 1);
});

test('paired users can open each current execution role without opening historical or unowned sessions', async t => {
  const { contract, BASE, HEAD_A } = await import('./helpers/orchestration/domain-fixture.mjs');
  const { planTarget } = await import('../server/orchestration/domain/transitions.mjs');
  const { app, service, store } = await apiFixture(t); let id = 0; const opened = [];
  service.agents.capabilities.push({ role: 'implementer', mode: 'background' }, { role: 'integrator', mode: 'background' });
  service.agents.open = async operationId => { opened.push(operationId); };
  service.ownership = { assertOwned() {} };
  const command = (type, payload, kind = 'system') => service.execute({ id: `terminal-${++id}`, goalId: 'goal', expectedVersion: store.get('goal')?.version ?? 0, type, payload }, { kind });
  const request = role => { command('request_attempt', { role, taskId: role === 'implementer' ? 'A' : null, attemptId: role, operationId: role, conversationId: role }); command('record_dispatch', { attemptId: role, identity: role, worktree: `/tmp/${role}`, branch: role }); };
  const endpoint = '/api/orchestration/goals/goal/terminal';
  const open = (attemptId, headers = HEADERS) => app.inject({ method: 'POST', url: endpoint, headers, payload: { expectedVersion: store.get('goal').version, attemptId } });
  command('create_goal', { repositoryId: 'repo', title: 'Visible roles', baseSha: BASE }, 'user');
  const plan = contract(); plan.tasks = [plan.tasks[0]]; command('publish_contract', { contract: plan }, 'user');
  request('reviewer');
  assert.equal((await open('reviewer', {})).statusCode, 401);
  assert.equal((await open('reviewer', { ...HEADERS, origin: 'https://invalid.example' })).statusCode, 403);
  assert.equal((await open('reviewer')).statusCode, 200);
  command('record_review', { attemptId: 'reviewer', reviewId: 'plan-review', review: { schemaVersion: 1, target: planTarget(store.get('goal')), disposition: 'accept', findings: [] } });
  assert.equal((await open('reviewer')).statusCode, 200, 'A submitted result does not hide a still-running terminal');
  command('record_stopped', { attemptId: 'reviewer' }); command('approve', { revision: 1 }, 'user');
  request('implementer'); assert.equal((await open('implementer')).statusCode, 200);
  assert.equal((await open('reviewer')).statusCode, 409);
  command('confirm_candidate', { attemptId: 'implementer', headSha: HEAD_A }); command('record_stopped', { attemptId: 'implementer' });
  command('request_attempt', { role: 'reviewer', taskId: 'A', attemptId: 'task-review', operationId: 'task-review', conversationId: 'task-review' });
  command('record_dispatch', { attemptId: 'task-review', identity: 'task-review', worktree: '/tmp/task-review', branch: 'task-review' });
  command('record_review', { attemptId: 'task-review', reviewId: 'task-review', review: { schemaVersion: 1, target: HEAD_A, disposition: 'accept', findings: [] } });
  command('record_stopped', { attemptId: 'task-review' }); command('request_integration', { taskId: 'A', operationId: 'integrate' });
  command('record_integration_conflict', { operationId: 'integrate' }); command('recover_goal', { holdId: store.get('goal').hold.id }, 'user');
  request('integrator'); assert.equal((await open('integrator')).statusCode, 200);
  service.repositoryIds.clear(); assert.equal((await open('integrator')).statusCode, 404);
  assert.deepEqual(opened, ['reviewer', 'reviewer', 'implementer', 'integrator']);
});


test('team configuration cannot be forged and only paired writable users can override assignments', async t => {
  const { app, store, planner } = await apiFixture(t);
  const forged = { ...create, payload: { ...create.payload, teamConfiguration: { profiles: [] } } };
  assert.equal((await app.inject({ method: 'POST', url, headers: HEADERS, payload: forged })).statusCode, 403);
  assert.equal(store.get('goal'), null);
  const secret = planner();
  const override = { id: 'override', goalId: 'goal', expectedVersion: 3, type: 'override_assignment', payload: { key: 'planner:*', profileId: 'codex' } };
  assert.equal((await app.inject({ method: 'POST', url: '/api/orchestration/agent/commands', headers: { authorization: `Bearer ${secret}` }, payload: override })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url, payload: override })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url, headers: { ...HEADERS, origin: 'https://attacker.test' }, payload: override })).statusCode, 403);
  assert.equal(store.get('goal').version, 3);
  const readonly = await apiFixture(t, { readOnly: true }); readonly.planner();
  assert.equal((await readonly.app.inject({ method: 'POST', url, headers: HEADERS, payload: override })).statusCode, 403);
  assert.equal(readonly.store.get('goal').version, 3);
});

test('activity is paired, goal-scoped, paginated metadata and passive merge polling does not replace meaningful activity', async t => {
  const { app, service, store } = await apiFixture(t);
  service.execute(create, { kind: 'user' });
  service.execute({ ...create, id: 'other', goalId: 'other' }, { kind: 'user' });
  for (let index = 0; index < 55; index++) service.execute({ id: `rename_${index}`, goalId: 'goal', expectedVersion: store.get('goal').version, type: 'rename_goal', payload: { title: `Title ${index}` } }, { kind: 'user' });
  store.db.prepare('INSERT INTO events(goal_id,version,generation,revision,command_id,kind,payload,created_at) VALUES (?,?,?,?,?,?,?,?)').run('goal', 56, 1, 0, 'sync', 'merge_sync_observed', '{"private":"hidden"}', '2099-01-01T00:00:00Z');
  const path = '/api/orchestration/goals/goal/activity';
  assert.equal((await app.inject({ url: path })).statusCode, 401);
  const first = (await app.inject({ url: path, headers: HEADERS })).json();
  assert.equal(first.events.length, 50); assert.equal(first.events[0].kind, 'merge_sync_observed');
  assert.ok(first.events.every(event => event.goalId === 'goal' && !('payload' in event) && !('commandId' in event)));
  const second = (await app.inject({ url: `${path}?before=${first.nextBefore}`, headers: HEADERS })).json();
  assert.equal(second.events.length, 7); assert.equal(second.events.at(-1).kind, 'goal_created'); assert.equal(second.nextBefore, null);
  assert.ok(second.events.every(event => event.id < first.nextBefore));
  for (const before of ['0', '-1', 'NaN', '1.5']) assert.equal((await app.inject({ url: `${path}?before=${before}`, headers: HEADERS })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/orchestration/goals/missing/activity', headers: HEADERS })).statusCode, 404);
  const snapshot = (await app.inject({ url: '/api/orchestration/snapshot', headers: HEADERS })).json();
  assert.equal(snapshot.goals.find(goal => goal.id === 'goal').lastActivity.kind, 'goal_renamed');
  assert.equal(snapshot.goals.find(goal => goal.id === 'other').lastActivity.kind, 'goal_created');
});

test('check output is bound to the selected goal and exact head, bounded and excludes environment and agent envelopes', async t => {
  const { app, service, store, artifacts } = await apiFixture(t, { resultIntake: true });
  service.execute(create, { kind: 'user' });
  service.execute({ ...create, id: 'other', goalId: 'other' }, { kind: 'user' });
  const headSha = 'a'.repeat(40);
  const evidence = { checkId: 'unit', headSha, environment: { secret: 'private-environment' }, activation: 'private-bridge', code: '', outcome: { stdout: '<script>unsafe()</script>', stderr: 'x'.repeat(262145) } };
  const artifact = artifacts.put(JSON.stringify(evidence));
  const goal = store.get('goal'); goal.verification = { headSha, checks: [{ id: 'unit', passed: true, artifactId: artifact.id }] };
  store.db.prepare('UPDATE goals SET state=? WHERE id=?').run(JSON.stringify(goal), goal.id);
  const path = `/api/orchestration/goals/goal/checks/${artifact.id}`;
  assert.equal((await app.inject({ url: path })).statusCode, 401);
  assert.equal((await app.inject({ url: path.replace('/goal/', '/other/'), headers: HEADERS })).statusCode, 404);
  const response = await app.inject({ url: path, headers: HEADERS }); assert.equal(response.statusCode, 200);
  const body = response.json(); assert.equal(body.stdout, evidence.outcome.stdout); assert.equal(body.stderr.length, 262144); assert.equal(body.truncated, true);
  assert.ok(!response.body.includes('private-environment')); assert.ok(!response.body.includes('private-bridge'));
  goal.verification = null; goal.verificationRuns = [{ operationId: 'historical', result: { verification: { headSha, checks: [{ id: 'unit', passed: true, artifactId: artifact.id }] } } }];
  store.db.prepare('UPDATE goals SET state=? WHERE id=?').run(JSON.stringify(goal), goal.id);
  assert.equal((await app.inject({ url: path, headers: HEADERS })).statusCode, 200);
  goal.verificationRuns[0].result.verification.headSha = 'b'.repeat(40);
  store.db.prepare('UPDATE goals SET state=? WHERE id=?').run(JSON.stringify(goal), goal.id);
  assert.equal((await app.inject({ url: path, headers: HEADERS })).statusCode, 409);
  assert.equal((await app.inject({ url: `/api/orchestration/goals/goal/checks/${'f'.repeat(64)}`, headers: HEADERS })).statusCode, 404);
});
