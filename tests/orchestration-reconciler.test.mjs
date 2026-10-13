import assert from 'node:assert/strict';
import test from 'node:test';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { OrchestrationService } from '../server/orchestration/service.mjs';
import { Scheduler } from '../server/orchestration/scheduler.mjs';
import { SchedulerOwnership } from '../server/orchestration/storage/ownership.mjs';
import { FakeAgents, barrier } from './helpers/orchestration/fake-agents.mjs';
import { BASE } from './helpers/orchestration/domain-fixture.mjs';

function fixture(t) {
  const store = new OrchestrationStore({ path: ':memory:' }), agents = new FakeAgents();
  const service = new OrchestrationService({ store, agents, repositoryIds: new Set(['repo']), limits: { planners: 2 } });
  const repositories = { provision: async ({ operationId, branch, baseSha }) => ({ worktree: `/tmp/${operationId}`, branch, baseSha }) };
  const scheduler = new Scheduler({ service, repositories });
  t.after(async () => { await scheduler.stop(); store.close(); });
  const create = (goalId, experienceVersion) => service.execute({ id: `create_${goalId}`, goalId, expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: goalId, baseSha: BASE, ...(experienceVersion ? { experienceVersion } : {}) } }, { kind: 'user' });
  const abort = (goalId) => service.execute({ id: `abort_${goalId}`, goalId, expectedVersion: store.get(goalId).version, type: 'abort', payload: {} }, { kind: 'user' });
  return { store, service, agents, repositories, scheduler, create, abort };
}

test('pre-policy stopped failure evidence is classified only from the same recorded native identity', async t => {
  const f = fixture(t); f.store.now = () => new Date(0).toISOString(); f.create('g', 2);
  await f.scheduler.start();
  const attempt = f.store.get('g').attempts[0];
  let identity = 'different';
  f.agents.observe = async () => ({ status: 'stopped', identity, failureCode: 'SUPERVISOR_TURN_TIMEOUT' });
  f.service.execute({ id: 'old_failure', goalId: 'g', expectedVersion: f.store.get('g').version, type: 'record_failure', payload: { attemptId: attempt.id, confirmedStopped: true, error: 'Saved failure predates structured recovery evidence' } }, { kind: 'system' });
  await f.scheduler.tick();
  assert.equal(f.store.get('g').attempts[0].failureCode, undefined);
  assert.equal(f.store.get('g').recoveryPolicy.decisions.length, 0);
  identity = attempt.identity; await f.scheduler.tick();
  assert.equal(f.store.get('g').attempts[0].failureCode, 'SUPERVISOR_TURN_TIMEOUT');
  assert.equal(f.store.get('g').recoveryPolicy.decisions.length, 1);
  assert.equal(f.agents.launches.length, 1, 'classification does not launch a replacement before its due time');
});

test('startup discovers persisted ready work, records resources and dispatches once', async (t) => {
  const f = fixture(t); f.create('g'); await f.scheduler.start();
  assert.equal(f.agents.launches.length, 1);
  const attempt = f.store.get('g').attempts[0]; assert.equal(attempt.workerState, 'running'); assert.ok(attempt.worktree);
  assert.deepEqual(f.store.operations(), []);
  await f.scheduler.tick(); assert.equal(f.agents.launches.length, 1);
  await f.scheduler.stop(); await f.scheduler.start(); assert.equal(f.agents.launches.length, 1);
});

test('lost launch response is reconciled by operation identity without another launch', async (t) => {
  const f = fixture(t); f.agents.loseResponse = true; f.create('g'); await f.scheduler.start();
  assert.equal(f.agents.launches.length, 1); assert.equal(f.store.get('g').attempts[0].status, 'running');
  await f.scheduler.stop(); await f.scheduler.start(); assert.equal(f.agents.launches.length, 1);
});

test('unknown dispatch survives restart and cannot silently release capacity', async (t) => {
  const f = fixture(t); f.agents.loseResponse = true; f.agents.observationUnknown = true; f.create('g');
  await f.scheduler.start(); assert.equal(f.store.get('g').attempts[0].workerState, 'unknown');
  await f.scheduler.stop(); await f.scheduler.start(); assert.equal(f.agents.launches.length, 1);
  assert.equal(f.store.ownedCapacity('g', 'interactive').total, 1);
  f.agents.observationUnknown = false; await f.scheduler.tick();
  assert.equal(f.store.get('g').attempts[0].workerState, 'running'); assert.equal(f.agents.launches.length, 1);
});

test('abort during a sent launch adopts the late identity and confirms termination', async (t) => {
  const f = fixture(t); const entered = barrier(), release = barrier();
  f.agents.onLaunch = async () => { entered.release(); await release.promise; };
  f.create('g'); const started = f.scheduler.start(); await entered.promise;
  f.abort('g'); release.release(); await started;
  assert.equal(f.store.get('g').status, 'aborted'); assert.equal(f.store.get('g').attempts[0].workerState, 'stopped');
  assert.equal(f.agents.launches.length, 1); assert.equal(f.agents.terminations.length, 1);
});

test('a termination request does not release an unresponsive worker slot', async (t) => {
  const f = fixture(t); f.agents.ignoreTermination = true; f.create('g'); await f.scheduler.start();
  f.abort('g'); await f.scheduler.tick();
  assert.equal(f.store.get('g').attempts[0].workerState, 'running');
  assert.equal(f.store.ownedCapacity('g', 'interactive').total, 1);
  f.agents.ignoreTermination = false; await f.scheduler.tick();
  assert.equal(f.store.get('g').attempts[0].workerState, 'stopped');
});

test('abort during provisioning preserves resource identity and never launches an agent', async (t) => {
  const f = fixture(t); const entered = barrier(), release = barrier();
  f.repositories.provision = async ({ branch, baseSha }) => { entered.release(); await release.promise; return { branch, baseSha, worktree: '/tmp/created-before-abort' }; };
  f.create('g'); const started = f.scheduler.start(); await entered.promise;
  f.abort('g'); release.release(); await started;
  assert.equal(f.agents.launches.length, 0); assert.equal(f.store.get('g').attempts[0].worktree, '/tmp/created-before-abort');
  assert.equal(f.store.get('g').attempts[0].workerState, 'stopped');
});

test('an event arriving during an active sweep triggers a subsequent pass', async (t) => {
  const f = fixture(t); const entered = barrier(), release = barrier();
  f.agents.onLaunch = async (request) => { if (request.goalId === 'first') { entered.release(); await release.promise; } };
  f.create('first'); const started = f.scheduler.start(); await entered.promise;
  f.create('second'); release.release(); await started;
  assert.equal(f.agents.launches.length, 2); assert.equal(f.store.get('second').attempts[0].status, 'running');
});

test('repository withdrawal during provisioning fences dispatch and leaves stopped evidence', async (t) => {
  const f = fixture(t); const entered = barrier(), release = barrier();
  f.repositories.provision = async ({ branch, baseSha }) => { entered.release(); await release.promise; return { branch, baseSha, worktree: '/tmp/withdrawn' }; };
  f.create('g'); const started = f.scheduler.start(); await entered.promise;
  f.service.repositoryIds = new Set(); release.release(); await started;
  assert.equal(f.agents.launches.length, 0); assert.equal(f.store.get('g').attempts[0].workerState, 'stopped');
});

test('a provision failure after abort releases the worker slot without needing an agent observation', async (t) => {
  const f = fixture(t); const entered = barrier(), release = barrier(); f.agents.observationUnknown = true;
  f.repositories.provision = async () => { entered.release(); await release.promise; throw new Error('provision failed'); };
  f.create('g'); const started = f.scheduler.start(); await entered.promise;
  f.abort('g'); release.release(); await started;
  assert.equal(f.agents.launches.length, 0); assert.equal(f.store.get('g').attempts[0].workerState, 'stopped');
  assert.equal(f.store.ownedCapacity('g', 'interactive').total, 0);
});

test('shutdown retains ownership until every sibling launch settles after a dispatch failure', async (t) => {
  const f = fixture(t), entered = barrier(), release = barrier(), failed = barrier();
  const record = f.scheduler.reconciler.record.bind(f.scheduler.reconciler);
  f.scheduler.reconciler.record = (goalId, type, payload) => {
    if (goalId === 'broken' && type === 'record_failure') { failed.release(); throw new Error('storage unavailable'); }
    return record(goalId, type, payload);
  };
  const provision = f.repositories.provision;
  f.repositories.provision = async (request) => {
    if (request.branch.includes('/broken/')) { await entered.promise; throw new Error('provision failed'); }
    return provision(request);
  };
  f.agents.onLaunch = async () => { entered.release(); await release.promise; };
  f.create('broken'); f.create('sibling');
  let settled = false;
  const started = f.scheduler.start();
  const rejected = assert.rejects(started, /Agent dispatch failed/).finally(() => { settled = true; });
  await failed.promise;
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(settled, false);
    assert.throws(() => new SchedulerOwnership({ store: f.store }).acquire(), { code: 'OWNERSHIP_UNCERTAIN' });
  } finally { release.release(); await rejected; }
  assert.equal(f.agents.launches.length, 1);
  assert.equal(f.store.get('sibling').attempts[0].workerState, 'running');
  const replacement = new SchedulerOwnership({ store: f.store }); replacement.acquire(); replacement.release();
});

test('failure after launch completion commit cannot mark a live worker stopped', async (t) => {
  const f = fixture(t); f.create('g'); let injected = false;
  f.store.failpoint = (point) => {
    if (point === 'after_commit' && !injected && f.store.db.prepare("SELECT id FROM operations WHERE kind='launch' AND status='completed'").get()) {
      injected = true; throw new Error('lost completion acknowledgement');
    }
  };
  await f.scheduler.start();
  assert.equal(injected, true); assert.equal(f.agents.launches.length, 1);
  assert.equal(f.store.get('g').attempts[0].workerState, 'running');
  assert.equal(f.store.ownedCapacity('g', 'interactive').total, 1);
  assert.deepEqual(f.store.operations(), []);
  await f.scheduler.stop(); await f.scheduler.start();
  assert.equal(f.agents.launches.length, 1);
});

for (const exhausted of [false, true]) test(`proven transient provider spawn retries after its persisted delay; repeated=${exhausted}`, async t => {
  const f = fixture(t); f.create('g', 2);
  let now = 0; f.store.now = () => new Date(now).toISOString();
  const observe = f.agents.observe.bind(f.agents);
  f.agents.observe = async operationId => {
    const worker = await observe(operationId);
    return exhausted || operationId === f.agents.launches[0]?.operationId
      ? { ...worker, status: 'stopped', launchFailure: 'PROVIDER_SPAWN_EAGAIN' } : worker;
  };
  await f.scheduler.start(); await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(f.agents.launches.length, 1, 'no retry before the due time');
  now = 5000; await f.scheduler.tick();
  const goal = f.store.get('g');
  assert.equal(f.agents.launches.length, 2);
  assert.equal(goal.attempts[0].workerState, 'stopped');
  assert.equal(goal.attempts[0].launchFailure.scheduled, false, 'the shared policy owns retries');
  assert.equal(goal.recoveryPolicy.decisions[0].state, 'applied');
  assert.equal(goal.recoveryPolicy.decisions[0].dueAt, 5000);
  assert.notEqual(goal.attempts[0].operationId, goal.attempts[1].operationId);
  assert.equal(Boolean(goal.hold), exhausted);
  assert.equal(goal.attempts[1].status, exhausted ? 'failed' : 'running');
  if (exhausted) assert.equal(goal.attempts[1].launchFailure.scheduled, false);
  await f.scheduler.stop(); await f.scheduler.start(); await f.scheduler.tick();
  assert.equal(f.agents.launches.length, 2, 'restart cannot reset the saved retry budget');
});

for (const [status, code, version] of [['stopped', 'PROVIDER_SPAWN_EACCES', 2], ['stopped', 'PROVIDER_SPAWN_ENOENT', 2], ['unknown', 'PROVIDER_SPAWN_EAGAIN', 2], ['stopped', 'PROVIDER_SPAWN_EAGAIN', undefined]]) {
  test(`launch recovery retains decision for ${status}/${code}/experience=${version ?? 1}`, async t => {
    const f = fixture(t); f.create('g', version);
    const observe = f.agents.observe.bind(f.agents);
    f.agents.observe = async operationId => ({ ...await observe(operationId), status, launchFailure: code });
    await f.scheduler.start(); await f.scheduler.tick();
    assert.equal(f.agents.launches.length, 1); assert.ok(f.store.get('g').hold);
    assert.equal(f.store.get('g').attempts[0].workerState, status === 'unknown' ? 'unknown' : 'stopped');
  });
}

for (const version of [2, undefined]) test(`a cmux refusal releases planner capacity and names the cmux setting; experience=${version ?? 1}`, async t => {
  const f = fixture(t); f.create('g', version);
  f.agents.launch = async request => {
    f.agents.launches.push(structuredClone(request));
    f.agents.workers.set(request.operationId, { identity: `worker_${request.operationId}`, status: 'stopped', launchFailure: 'CMUX_AUTH_REJECTED' });
    throw new Error('cmux refused the request');
  };
  await f.scheduler.start(); await f.scheduler.tick();
  const goal = f.store.get('g'), [attempt] = goal.attempts;
  assert.equal(f.agents.launches.length, 1, 'a refused socket is not retried automatically');
  assert.equal(attempt.status, 'failed'); assert.equal(attempt.workerState, 'stopped');
  assert.deepEqual(attempt.launchFailure, { code: 'CMUX_AUTH_REJECTED', retry: 0, limit: 1, scheduled: false });
  assert.match(attempt.error, /cmux refused the launch \(CMUX_AUTH_REJECTED\)/);
  assert.match(attempt.error, /cmux → Settings → Automation/);
  assert.doesNotMatch(attempt.error, /Provider could not start/);
  assert.equal(f.store.ownedCapacity('g', 'interactive').total, 0);
  assert.ok(goal.hold);
  // After the owner repairs cmux, one Recover goal starts a fresh planner.
  delete f.agents.launch;
  f.service.execute({ id: 'recover_g', goalId: 'g', expectedVersion: goal.version, type: 'recover_goal', payload: { holdId: goal.hold.id } }, { kind: 'user' });
  await f.scheduler.tick();
  const recovered = f.store.get('g');
  assert.equal(f.agents.launches.length, 2); assert.equal(recovered.hold, null);
  assert.equal(recovered.attempts.at(-1).role, 'planner'); assert.equal(recovered.attempts.at(-1).workerState, 'running');
});
