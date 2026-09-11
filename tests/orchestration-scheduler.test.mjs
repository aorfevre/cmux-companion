import assert from 'node:assert/strict';
import test from 'node:test';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { OrchestrationService } from '../server/orchestration/service.mjs';
import { contract, BASE } from './helpers/orchestration/domain-fixture.mjs';
import { planTarget } from '../server/orchestration/domain/transitions.mjs';

function fixture(t, limits = {}) {
  const store = new OrchestrationStore({ path: ':memory:' }); t.after(() => store.close());
  const agents = { capabilities: [{ role: 'planner', mode: 'interactive' }, ...['implementer', 'reviewer', 'integrator'].map((role) => ({ role, mode: 'background' }))] };
  const service = new OrchestrationService({ store, agents, limits, repositoryIds: new Set(['repo']) });
  let sequence = 0;
  const command = (goalId, type, payload = {}, kind = 'system') => service.execute({ id: `c${++sequence}`, goalId, expectedVersion: store.get(goalId)?.version ?? 0, type, payload }, { kind });
  const create = (id) => command(id, 'create_goal', { repositoryId: 'repo', title: id, baseSha: BASE }, 'user');
  const request = (id, role, taskId = null) => {
    const attemptId = `attempt${++sequence}`;
    command(id, 'request_attempt', { attemptId, operationId: `op${sequence}`, role, taskId, conversationId: `conversation${sequence}` }); return attemptId;
  };
  const dispatch = (id, attemptId) => command(id, 'record_dispatch', { attemptId, identity: attemptId, worktree: `/tmp/${attemptId}`, branch: attemptId });
  const approve = (id) => {
    command(id, 'publish_contract', { contract: contract() }, 'user');
    const attemptId = request(id, 'reviewer'); dispatch(id, attemptId);
    command(id, 'record_review', { attemptId, reviewId: `review${sequence}`, review: { schemaVersion: 1, target: planTarget(store.get(id)), disposition: 'accept', findings: [] } });
    command(id, 'record_stopped', { attemptId }); command(id, 'approve', { revision: 1 }, 'user');
  };
  return { store, agents, service, command, create, request, dispatch, approve };
}

test('global background admission counts implementers and reviewers while planners have separate capacity', (t) => {
  const f = fixture(t, { global: 2, perGoal: 2, planners: 1 }); f.create('g'); f.approve('g');
  const a = f.request('g', 'implementer', 'A'); f.dispatch('g', a);
  f.request('g', 'implementer', 'B');
  f.command('g', 'confirm_candidate', { attemptId: a, headSha: 'b'.repeat(40) });
  assert.throws(() => f.request('g', 'reviewer', 'A'), { code: 'CAPACITY_FULL' });
  f.create('p'); f.request('p', 'planner'); f.create('q');
  assert.throws(() => f.request('q', 'planner'), { code: 'CAPACITY_FULL' });
  f.command('g', 'record_stopped', { attemptId: a }); f.request('g', 'reviewer', 'A');
  assert.equal(f.store.ownedCapacity('g', 'background').total, 2);
});

test('per-goal capacity leaves capacity for another goal and counts uncertain workers', (t) => {
  const f = fixture(t, { global: 3, perGoal: 1 }); f.create('g'); f.approve('g'); f.create('h'); f.approve('h');
  const a = f.request('g', 'implementer', 'A');
  f.command('g', 'record_failure', { attemptId: a, uncertain: true, error: 'lost launch response' });
  assert.throws(() => f.request('g', 'implementer', 'B'), { code: 'CAPACITY_FULL' });
  f.request('h', 'implementer', 'A'); assert.equal(f.store.ownedCapacity('g', 'background').total, 2);
});

test('a command replay reserves no second capacity slot', (t) => {
  const f = fixture(t, { planners: 1 }); f.create('g');
  const command = { id: 'exact', goalId: 'g', expectedVersion: 1, type: 'request_attempt', payload: { attemptId: 'a', operationId: 'op', role: 'planner', conversationId: 'conversation' } };
  const first = f.service.execute(command, { kind: 'system' });
  assert.deepEqual(f.service.execute(command, { kind: 'system' }), first);
  assert.equal(f.store.ownedCapacity('g', 'interactive').total, 1);
});

test('ready order is durable first-readiness order, not goal creation order', (t) => {
  const f = fixture(t); f.create('older'); f.create('newer');
  f.approve('newer'); f.approve('older');
  assert.deepEqual(f.store.ready().filter((work) => work.role === 'implementer').map((work) => `${work.goalId}/${work.taskId}`), ['newer/A', 'newer/B', 'older/A', 'older/B']);
  const before = f.store.ready().find((work) => work.goalId === 'older' && work.taskId === 'B').sequence;
  f.request('older', 'implementer', 'A');
  assert.equal(f.store.ready().find((work) => work.goalId === 'older' && work.taskId === 'B').sequence, before);
  assert.ok(!f.store.ready().some((work) => work.taskId === 'C'));
});

test('invalid capacity settings are rejected, never interpreted as unlimited', (t) => {
  const f = fixture(t);
  for (const limits of [{ global: 0 }, { perGoal: -1 }, { planners: 0.5 }]) assert.throws(() => new OrchestrationService({ store: f.store, agents: f.agents, limits }));
});

test('competing service processes atomically reserve the final planner slot', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os'); const { spawn } = await import('node:child_process');
  const directory = mkdtempSync(join(tmpdir(), 'orchestration-capacity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite'), store = new OrchestrationStore({ path }); t.after(() => store.close());
  for (const goalId of ['a', 'b']) store.apply({ id: 'create', goalId, type: 'create_goal', expectedVersion: 0, payload: { repositoryId: 'repo', title: goalId, baseSha: BASE } }, { kind: 'user' });
  const children = ['a', 'b'].map((goalId) => {
    const child = spawn(process.execPath, ['tests/helpers/orchestration/admission-child.mjs', path], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let output = '', errors = '';
    child.stderr.on('data', (chunk) => errors += chunk);
    const ready = new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code) => { if (code) reject(new Error(errors)); });
      child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('READY\n')) resolve(); });
    });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => code ? reject(new Error(errors)) : resolve(output)); });
    return { child, ready, done, command: { id: 'launch', goalId, expectedVersion: 1, type: 'request_attempt', payload: { role: 'planner', attemptId: goalId, operationId: `op_${goalId}`, conversationId: goalId } } };
  });
  await Promise.all(children.map((child) => child.ready));
  for (const entry of children) entry.child.stdin.end(JSON.stringify(entry.command));
  const results = await Promise.all(children.map((child) => child.done));
  assert.equal(results.filter((output) => output.includes('ACCEPTED')).length, 1);
  assert.equal(results.filter((output) => output.includes('CAPACITY_FULL')).length, 1);
  assert.equal(store.ownedCapacity('a', 'interactive').total, 1); assert.equal(store.operations().length, 1);
});

test('failed planner and reviewer work requires explicit user retry after proven termination', (t) => {
  const f = fixture(t); f.create('g'); const planner = f.request('g', 'planner');
  f.command('g', 'record_failure', { attemptId: planner, error: 'launch outcome unknown', uncertain: true });
  assert.throws(() => f.command('g', 'retry_attempt', { attemptId: planner }, 'user'), { code: 'NOT_READY' });
  f.command('g', 'record_stopped', { attemptId: planner }); assert.deepEqual(f.store.ready(), []);
  assert.throws(() => f.request('g', 'planner'), { code: 'RETRY_REQUIRED' });
  assert.throws(() => f.command('g', 'retry_attempt', { attemptId: planner }), { code: 'FORBIDDEN' });
  f.command('g', 'retry_attempt', { attemptId: planner }, 'user'); assert.equal(f.store.ready()[0].role, 'planner');
  const replacement = f.request('g', 'planner'); f.command('g', 'record_stopped', { attemptId: replacement });
  f.command('g', 'publish_contract', { contract: contract() }, 'user');
  const reviewer = f.request('g', 'reviewer'); f.dispatch('g', reviewer);
  f.command('g', 'record_failure', { attemptId: reviewer, error: 'review failed', confirmedStopped: true });
  assert.deepEqual(f.store.ready(), []);
  f.command('g', 'retry_attempt', { attemptId: reviewer }, 'user');
  assert.equal(f.store.ready()[0].role, 'reviewer'); f.request('g', 'reviewer');
});

test('opening a pre-queue database backfills readiness without changing goal version', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const directory = mkdtempSync(join(tmpdir(), 'orchestration-ready-upgrade-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite'); let store = new OrchestrationStore({ path });
  store.apply({ id: 'create', goalId: 'g', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'goal', baseSha: BASE } }, { kind: 'user' });
  store.db.exec('DROP TABLE ready_work'); store.close();
  store = new OrchestrationStore({ path }); t.after(() => store.close());
  assert.equal(store.ready()[0].role, 'planner'); assert.equal(store.get('g').version, 1);
});

test('continuous implementer readiness keeps its FIFO position when integration head advances', (t) => {
  const f = fixture(t); f.create('older'); f.approve('older');
  const firstSequence = f.store.ready().find((work) => work.goalId === 'older' && work.taskId === 'B').sequence;
  f.create('newer'); f.approve('newer');
  const a = f.request('older', 'implementer', 'A'); f.dispatch('older', a);
  const head = 'b'.repeat(40); f.command('older', 'confirm_candidate', { attemptId: a, headSha: head }); f.command('older', 'record_stopped', { attemptId: a });
  const review = f.request('older', 'reviewer', 'A'); f.dispatch('older', review);
  f.command('older', 'record_review', { attemptId: review, reviewId: 'review_A', review: { schemaVersion: 1, target: head, disposition: 'accept', findings: [] } });
  f.command('older', 'record_stopped', { attemptId: review });
  f.command('older', 'request_integration', { operationId: 'integrate_A', taskId: 'A' });
  f.command('older', 'record_integration', { operationId: 'integrate_A', headSha: head });
  const work = f.store.ready().find((work) => work.goalId === 'older' && work.taskId === 'B');
  assert.equal(work.sequence, firstSequence); assert.equal(work.target, head);
  assert.equal(f.store.ready()[0].goalId, 'older');
});
