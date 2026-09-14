import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateControl } from '../updater/src/control.mjs';
import { registerUpdateRoutes } from '../server/update-routes.mjs';
import { installUpdateMaintenance, managedWorkBusy } from '../server/update-maintenance.mjs';
import { sessionValue } from '../server/security.mjs';
const sha = 'a'.repeat(40), token = 't'.repeat(32);
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'update-routes-')), control = new UpdateControl(join(root, 'control.sqlite'));
  const app = Fastify({ ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  const runtime = { app, scheduler: { sweep: null, verifications: { active: new Map() }, publications: { active: new Map() } }, store: { operations: () => [], list: () => [] } };
  const cmux = { workspaceList: async () => ({ workspaces: [] }), workspaceStatus: async () => ({ signals: { any_agent_running: false, any_agent_needs_input: false } }) };
  const promptQueue = { inFlight: new Set() };
  const maintenance = installUpdateMaintenance({ runtime, control, cmux, promptQueue, serviceId: 'service' });
  app.post('/api/launch', async () => ({ launched: true }));
  await app.register(async scope => registerUpdateRoutes(scope, { control, token, maintenance }));
  const headers = { host: 'localhost', authorization: `Bearer ${token}`, origin: 'http://localhost' };
  const send = (url, payload, method = 'POST', supplied = headers) => app.inject({ method, url, payload, headers: supplied });
  t.after(async () => { await app.close(); control.close(); rmSync(root, { recursive: true, force: true }); });
  control.checked({ candidate: { sha }, observedSha: sha, deployedSha: 'b'.repeat(40) });
  return { control, app, runtime, cmux, promptQueue, maintenance, send };
}
test('update routes require pairing, origin and strict payloads; private transaction evidence is not returned', async t => {
  const f = await fixture(t);
  assert.equal((await f.send('/api/updater/preferences', { revision: 0, automatic: true }, 'PATCH', {})).statusCode, 401);
  assert.equal((await f.send('/api/updater/preferences', { revision: 0, automatic: true }, 'PATCH', { authorization: `Bearer ${token}`, origin: 'https://evil.test' })).statusCode, 403);
  for (const body of [{ revision: 0, automatic: true, command: 'shell' }, { revision: 0, automatic: 'true' }]) assert.equal((await f.send('/api/updater/preferences', body, 'PATCH')).statusCode, 400);
  assert.equal((await f.send('/api/updater/preferences', { revision: 0, automatic: true }, 'PATCH')).statusCode, 200);
  assert.equal((await f.send('/api/updater/preferences', { revision: 0, automatic: false }, 'PATCH')).statusCode, 409);
  assert.equal((await f.send('/api/updater/check', {})).json().checking, true);
  assert.equal((await f.send('/api/updater/requests', { id: 'manual-001', sha, whenIdle: true })).statusCode, 200);
  f.control.change(state => { state.requests['manual-001'].backup = { path: '/private/data' }; });
  const status = await f.send('/api/updater/updates', undefined, 'GET'); assert.doesNotMatch(status.body, /private|backup|serviceId/);
  const cookie = { host: 'localhost', cookie: `cmux_session=${sessionValue(token)}`, origin: 'http://localhost' };
  assert.equal((await f.send('/api/updater/maintenance', { id: 'manual-001', action: 'acquire' }, 'POST', cookie)).statusCode, 403);
  assert.equal((await f.send('/api/updater/cancel', { id: 'manual-001' })).json().request.status, 'cancelled');
});
test('durable maintenance fences HTTP launches and prompt draining, requires same service and fails closed on uncertain work', async t => {
  const f = await fixture(t); f.control.request({ id: 'manual-002', sha, whenIdle: true });
  const acquire = await f.send('/api/updater/maintenance', { id: 'manual-002', action: 'acquire' });
  assert.equal(acquire.json().ready, true); assert.equal(f.runtime.scheduler.paused(), true); assert.equal(f.promptQueue.paused(), true);
  assert.equal((await f.send('/api/launch', {})).statusCode, 503);
  assert.equal((await f.send('/api/updater/maintenance', { id: 'manual-002', action: 'verify', serviceId: 'old-service' })).statusCode, 409);
  assert.equal((await f.send('/api/updater/maintenance', { id: 'manual-002', action: 'verify', serviceId: 'service' })).json().ready, true);
  f.control.unfence('manual-002'); assert.equal((await f.send('/api/launch', {})).statusCode, 200);
  f.runtime.store.list = () => [{ attempts: [{ workerState: 'unknown' }], status: 'aborted' }];
  assert.equal((await f.maintenance.acquire('manual-002')).ready, false); assert.equal(f.control.status().maintenance, false);
  f.runtime.store.list = () => []; f.cmux.workspaceList = async () => ({ workspaces: [{ id: 'workspace' }] });
  f.cmux.workspaceStatus = async () => ({}); assert.equal((await f.maintenance.acquire('manual-002')).ready, true);
  f.cmux.workspaceList = async () => { throw new Error('cmux must not be queried during updates'); };
  assert.equal((await f.maintenance.acquire('manual-002')).ready, true);
  assert.equal((await f.maintenance.verify('manual-002', 'service')).ready, true);
});
test('in-flight launches and coordinator effects cannot race the idle fence', async t => {
  const f = await fixture(t); let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  f.app.post('/api/slow-launch', async () => { entered(); await waiting; return {}; });
  const launch = f.send('/api/slow-launch', {}); await started;
  f.control.request({ id: 'manual-003', sha });
  assert.equal((await f.maintenance.acquire('manual-003')).ready, false); release(); await launch;
  f.runtime.scheduler.verifications.active.set('check', {}); assert.equal(managedWorkBusy(f.runtime), true); f.runtime.scheduler.verifications.active.clear();
  f.runtime.store.operations = () => [{ status: 'dispatching' }]; assert.equal(managedWorkBusy(f.runtime), true);
  f.runtime.store.operations = () => []; f.promptQueue.inFlight.add('prompt'); assert.equal((await f.maintenance.acquire('manual-003')).ready, false);
  assert.equal(managedWorkBusy(null), true);
});

test('aborted goal with an owned base fetch still blocks update activation until the job settles', async t => {
  const f = await fixture(t);
  f.control.request({ id: 'manual-004', sha, whenIdle: true });
  f.runtime.store.list = () => [{ status: 'aborted', attempts: [] }];
  f.runtime.scheduler.startupJobs = new Map([['aborted-goal', Promise.resolve()]]);
  assert.equal(managedWorkBusy(f.runtime), true);
  assert.equal((await f.maintenance.acquire('manual-004')).ready, false);
  assert.equal(f.control.status().maintenance, false);
  f.runtime.scheduler.startupJobs.clear();
  assert.equal(managedWorkBusy(f.runtime), false);
  assert.equal((await f.maintenance.acquire('manual-004')).ready, true);
});

test('stopped planning and building goals permit updates while queued work stays behind the scheduler fence', async t => {
  const { transition, planTarget } = await import('../server/orchestration/domain/transitions.mjs');
  const make = () => transition(null, { id: 'create-idle', goalId: 'idle', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'Saved work', baseSha: sha } }, { kind: 'user' }).goal;
  const f = await fixture(t); f.control.request({ id: 'manual-005', sha, whenIdle: true });
  const planning = make();
  planning.attempts.push({ id: 'planner', role: 'planner', taskId: null, target: planTarget(planning), generation: planning.generation, revision: planning.revision, status: 'failed', workerState: 'stopped' });
  f.runtime.store.list = () => [planning];
  assert.equal(managedWorkBusy(f.runtime), false);
  assert.equal((await f.maintenance.acquire('manual-005')).ready, true);
  f.control.unfence('manual-005');
  planning.attempts[0].retryRequested = true;
  assert.equal((await f.maintenance.acquire('manual-005')).ready, true);
  assert.equal(f.runtime.scheduler.paused(), true);
  planning.attempts[0].retryRequested = false;
  planning.attempts[0].workerState = 'unknown'; assert.equal(managedWorkBusy(f.runtime), true);
  planning.attempts[0].workerState = 'stopped';
  const building = make(); building.status = 'building'; building.approvedRevision = building.revision;
  building.tasks = [{ id: 'task', status: 'failed', dependsOn: [], repairCount: 0, repairLimit: 2 }];
  f.runtime.store.list = () => [building];
  assert.equal(managedWorkBusy(f.runtime), false);
  building.tasks[0].status = 'pending'; assert.equal(managedWorkBusy(f.runtime), false);
  building.tasks[0].status = 'accepted'; assert.equal(managedWorkBusy(f.runtime), false);
  building.tasks[0].status = 'failed';
  f.runtime.store.operations = () => [{ status: 'pending' }]; assert.equal(managedWorkBusy(f.runtime), true);
  f.runtime.store.operations = () => [];
  planning.attempts = []; planning.startup = { status: 'failed', error: 'GitHub unavailable' };
  f.runtime.store.list = () => [planning]; assert.equal(managedWorkBusy(f.runtime), false);
  planning.startup.status = 'pending'; assert.equal(managedWorkBusy(f.runtime), false);
});

test('an effect admitted by an in-flight sweep is observed before update activation', async t => {
  const f = await fixture(t); f.control.request({ id: 'manual-006', sha, whenIdle: true });
  let release;
  f.runtime.scheduler.sweep = new Promise(resolve => { release = resolve; });
  const admission = f.maintenance.acquire('manual-006');
  assert.equal(f.runtime.scheduler.paused(), true);
  f.runtime.store.operations = () => [{ status: 'pending' }];
  release();
  assert.equal((await admission).ready, false);
  f.runtime.store.operations = () => [];
  f.runtime.store.list = () => [{ attempts: [], results: [{ status: 'pending' }] }];
  assert.equal(managedWorkBusy(f.runtime), true);
  f.runtime.store.list = () => [{ attempts: [], verificationRuns: [{ workerState: 'unknown' }] }];
  assert.equal(managedWorkBusy(f.runtime), true);
});

test('a real scheduler preserves a queued planner across the update fence and launches once after release', async t => {
  const { OrchestrationStore } = await import('../server/orchestration/storage/store.mjs');
  const { OrchestrationService } = await import('../server/orchestration/service.mjs');
  const { Scheduler } = await import('../server/orchestration/scheduler.mjs');
  const { FakeAgents } = await import('./helpers/orchestration/fake-agents.mjs');
  const f = await fixture(t), store = new OrchestrationStore({ path: ':memory:' }), agents = new FakeAgents();
  const service = new OrchestrationService({ store, agents, repositoryIds: new Set(['repo']) });
  service.execute({ id: 'queued-create', goalId: 'queued', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'Saved goal', baseSha: sha } }, { kind: 'user' });
  const scheduler = new Scheduler({ service, repositories: { provision: async request => ({ worktree: '/tmp/owned-queued', branch: request.branch, baseSha: request.baseSha }) } });
  f.runtime.store = store; f.runtime.scheduler = scheduler;
  scheduler.paused = () => Boolean(f.control.read().fence);
  try {
    f.control.request({ id: 'manual-007', sha, whenIdle: true });
    assert.equal((await f.maintenance.acquire('manual-007')).ready, true);
    await scheduler.start(); await scheduler.tick();
    assert.equal(agents.launches.length, 0); assert.equal(store.get('queued').attempts.length, 0);
    assert.equal((await f.maintenance.verify('manual-007', 'service')).ready, true);
    f.control.unfence('manual-007');
    await scheduler.tick(); await scheduler.tick();
    assert.equal(agents.launches.length, 1); assert.equal(store.get('queued').attempts.length, 1);
    assert.equal(managedWorkBusy(f.runtime), true);
  } finally { await scheduler.stop(); store.close(); }
});

test('verified supported planners hand off across maintenance while old clients and background effects remain blocked', async t => {
  const f = await fixture(t); f.control.request({ id: 'handoff-001', sha, whenIdle: true });
  const attempt = { id: 'planner', operationId: 'operation', identity: 'terminal:operation:owner', role: 'planner', mode: 'interactive', status: 'running', workerState: 'running', generation: 1, revision: 0 };
  f.runtime.store.list = () => [{ id: 'goal', generation: 1, revision: 0, attempts: [attempt] }];
  f.runtime.prepareHandoff = async () => { throw Object.assign(new Error('legacy'), { code: 'HANDOFF_UNSUPPORTED' }); };
  const blocked = await f.maintenance.acquire('handoff-001');
  assert.equal(blocked.ready, false); assert.match(blocked.reason, /update-compatible recovery/);
  const evidence = [{ goalId: 'goal', operationId: attempt.operationId, identity: attempt.identity, endpoint: 'http://127.0.0.1:3210', credentialDigest: 'a'.repeat(64) }];
  f.runtime.prepareHandoff = async () => evidence;
  assert.equal((await f.maintenance.acquire('handoff-001')).ready, true);
  assert.deepEqual(f.control.read().fence.handoff, evidence);
  await f.maintenance.adopt();
  assert.equal((await f.maintenance.verify('handoff-001', 'service')).ready, true);
  assert.equal((await f.send('/api/launch', {})).statusCode, 503);
  f.runtime.scheduler.verifications.active.set('verification', {});
  await assert.rejects(f.maintenance.verify('handoff-001', 'service'));
  f.runtime.scheduler.verifications.active.clear();
  f.control.unfence('handoff-001');
  attempt.workerState = 'unknown'; assert.equal((await f.maintenance.acquire('handoff-001')).ready, false);
  attempt.workerState = 'running'; attempt.mode = 'background'; assert.equal((await f.maintenance.acquire('handoff-001')).ready, false);
});
