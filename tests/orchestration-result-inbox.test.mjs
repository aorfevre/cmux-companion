import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { ArtifactStore } from '../server/orchestration/storage/artifacts.mjs';
import { OrchestrationService } from '../server/orchestration/service.mjs';
import { AgentResults } from '../server/orchestration/agent-results.mjs';
import { Scheduler } from '../server/orchestration/scheduler.mjs';
import { Reconciler } from '../server/orchestration/reconciler.mjs';
import { FakeAgents, ScriptedAgents } from './helpers/orchestration/fake-agents.mjs';
import { contract, BASE } from './helpers/orchestration/domain-fixture.mjs';

const authority = (attempt) => ({ kind: 'agent', goalId: 'g', attemptId: attempt.id, role: attempt.role, generation: attempt.generation, revision: attempt.revision });
const envelope = (attempt, output) => JSON.stringify({ schemaVersion: 1, goalId: 'g', attemptId: attempt.id, operationId: attempt.operationId, role: attempt.role, generation: attempt.generation, revision: attempt.revision, target: attempt.target, output });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'orchestration-results-'));
  const artifacts = new ArtifactStore({ directory: join(directory, 'artifacts') });
  let store, service, results, next = 0;
  const reopen = () => {
    store?.close(); store = new OrchestrationStore({ path: join(directory, 'state.sqlite') });
    service = new OrchestrationService({ store, agents: new FakeAgents(), repositoryIds: new Set(['repo']) });
    results = new AgentResults({ service, artifacts });
  };
  reopen(); t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const command = (type, payload = {}, kind = 'system') => service.execute({ id: `cmd${++next}`, goalId: 'g', expectedVersion: store.get('g')?.version ?? 0, type, payload }, { kind });
  command('create_goal', { repositoryId: 'repo', title: 'Review contract', baseSha: BASE }, 'user');
  command('publish_contract', { contract: contract() }, 'user');
  command('request_attempt', { role: 'reviewer', attemptId: 'r', operationId: 'op', conversationId: 'review' });
  const dispatch = () => command('record_dispatch', { attemptId: 'r', identity: 'worker', worktree: '/tmp/review', branch: 'review' });
  const raw = () => envelope(store.get('g').attempts[0], { schemaVersion: 1, target: store.get('g').attempts[0].target, disposition: 'accept', findings: [] });
  return { get store() { return store; }, get service() { return service; }, get results() { return results; }, artifacts, reopen, command, dispatch, raw, get authority() { return authority(store.get('g').attempts[0]); } };
}

test('early role results remain durable and pending until dispatch identity is recorded', async (t) => {
  const f = fixture(t), raw = f.raw();
  const received = f.results.receive(f.authority, 'result', raw);
  assert.equal(f.artifacts.get(received.artifactId).toString(), raw);
  await f.results.drain(); assert.equal(f.store.get('g').reviews.length, 0);
  f.reopen(); await f.results.drain(); assert.equal(f.store.get('g').results[0].status, 'pending');
  f.dispatch(); await f.results.drain();
  assert.equal(f.store.get('g').results[0].status, 'accepted');
  assert.equal(f.store.get('g').reviews.length, 1); assert.equal(f.store.get('g').attempts[0].workerState, 'running');
  const version = f.store.get('g').version;
  f.results.receive(f.authority, 'result', raw); await f.results.drain(); assert.equal(f.store.get('g').version, version);
  assert.throws(() => f.results.receive(f.authority, 'result', '{}'), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('result retries cannot flood artifacts or bypass the one-pending-result bound', t => {
  const f = fixture(t), raw = f.raw();
  const first = f.results.receive(f.authority, 'first', raw);
  const files = readdirSync(f.artifacts.directory).sort();
  assert.deepEqual(f.results.receive(f.authority, 'first', raw), first);
  for (let n = 0; n < 20; n++) {
    assert.throws(() => f.results.receive(f.authority, 'first', `changed-${n}`), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.throws(() => f.results.receive(f.authority, `extra-${n}`, `extra-${n}`), { code: 'IDEMPOTENCY_CONFLICT' });
  }
  assert.throws(() => f.command('receive_role_result', { resultId: 'bypass', attemptId: f.authority.attemptId, artifactId: first.artifactId }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(readdirSync(f.artifacts.directory).sort(), files);
  assert.equal(f.store.get('g').results.length, 1);
});

test('retained rejected results have a per-attempt bound even after draining', async t => {
  const f = fixture(t); f.dispatch();
  for (let n = 0; n < 8; n++) {
    f.results.receive(f.authority, `rejected-${n}`, `malformed-${n}`);
    await f.results.drain();
  }
  const files = readdirSync(f.artifacts.directory).sort();
  assert.equal(f.store.get('g').results.length, 8);
  assert.throws(() => f.results.receive(f.authority, 'overflow', 'more evidence'), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(readdirSync(f.artifacts.directory).sort(), files);
});

test('malformed and stale reviews preserve private evidence without approval or slot release', async (t) => {
  const f = fixture(t); f.dispatch();
  f.results.receive(f.authority, 'malformed', 'PASS private provider details'); await f.results.drain();
  const goal = f.store.get('g');
  assert.equal(goal.results[0].code, 'MALFORMED_RESULT'); assert.equal(goal.attempts[0].status, 'failed');
  assert.equal(goal.attempts[0].workerState, 'running'); assert.equal(goal.reviews.length, 0);
  assert.ok(!JSON.stringify(f.store.events()).includes('private provider details'));
  assert.throws(() => f.command('approve', { revision: 1 }, 'user'), { code: 'NOT_READY' });
  const old = f.authority, raw = f.raw(); f.command('abort', {}, 'user');
  f.results.receive(old, 'late', raw); await f.results.drain();
  assert.equal(f.store.get('g').results[1].code, 'STALE_ATTEMPT'); assert.equal(f.store.get('g').status, 'aborted');
  assert.equal(f.store.get('g').reviews.length, 0);
});

test('post-commit response loss cannot duplicate accepted review after reopening storage', async (t) => {
  const f = fixture(t); f.dispatch(); f.results.receive(f.authority, 'result', f.raw());
  f.store.failpoint = (point) => { if (point === 'after_commit') throw new Error('crash after acceptance'); };
  await assert.rejects(f.results.drain(), /crash after acceptance/); f.reopen(); await f.results.drain();
  assert.equal(f.store.get('g').reviews.length, 1);
  assert.equal(f.store.events().filter((event) => event.kind === 'agent_result_accepted').length, 1);
});

test('a result received during stopped observation is accepted before the attempt is settled', async (t) => {
  const f = fixture(t); f.dispatch();
  f.service.agents.observe = async () => {
    f.results.receive(f.authority, 'during_observe', f.raw()); return { status: 'stopped', identity: 'worker' };
  };
  const reconciler = new Reconciler({ service: f.service, results: f.results, ownership: { assertOwned() {} } });
  await reconciler.observe('g', 'r');
  assert.equal(f.store.get('g').results[0].status, 'accepted'); assert.equal(f.store.get('g').reviews.length, 1);
  assert.equal(f.store.get('g').attempts[0].workerState, 'stopped'); assert.equal(f.store.get('g').attempts[0].status, 'succeeded');
});

test('uncertain result waits for correlated stopped identity instead of being cancelled', async (t) => {
  const f = fixture(t); f.dispatch(); f.command('record_failure', { attemptId: 'r', uncertain: true, error: 'Lost provider identity' });
  f.results.receive(f.authority, 'uncertain', f.raw());
  const reconciler = new Reconciler({ service: f.service, results: f.results, ownership: { assertOwned() {} } });
  f.service.agents.observe = async () => ({ status: 'stopped', identity: null });
  await reconciler.observe('g', 'r');
  assert.equal(f.store.get('g').results[0].status, 'pending'); assert.equal(f.store.get('g').attempts[0].workerState, 'unknown');
  f.service.agents.observe = async () => ({ status: 'stopped', identity: 'worker' });
  await reconciler.observe('g', 'r');
  assert.equal(f.store.get('g').results[0].status, 'accepted'); assert.equal(f.store.get('g').attempts[0].workerState, 'stopped');
});

test('rejection of a historical implementer result cannot fail its running replacement', async (t) => {
  const f = fixture(t); f.dispatch(); f.results.receive(f.authority, 'review', f.raw()); await f.results.drain();
  f.command('record_stopped', { attemptId: 'r' }); f.command('approve', { revision: 1 }, 'user');
  const launch = (attemptId) => {
    f.command('request_attempt', { role: 'implementer', attemptId, operationId: `op_${attemptId}`, conversationId: attemptId, taskId: 'A' });
    f.command('record_dispatch', { attemptId, identity: attemptId, worktree: `/tmp/${attemptId}`, branch: attemptId });
  };
  launch('old'); const old = f.store.get('g').attempts.at(-1);
  f.command('record_failure', { attemptId: 'old', confirmedStopped: true, error: 'Failed task' });
  f.command('recover_goal', { holdId: f.store.get('g').hold.id }, 'user'); launch('new');
  f.results.receive(authority(old), 'late_candidate', envelope(old, { headSha: 'b'.repeat(40), summary: 'Late output', evidence: [] }));
  await f.results.drain();
  assert.equal(f.store.get('g').results.at(-1).code, 'STALE_ATTEMPT');
  assert.equal(f.store.get('g').tasks[0].status, 'running'); assert.equal(f.store.get('g').attempts.at(-1).status, 'running');
});

test('scheduler consumes scripted planner/reviewer results before observing exited workers', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'orchestration-scripted-results-'));
  const artifacts = new ArtifactStore({ directory: join(directory, 'artifacts') });
  const store = new OrchestrationStore({ path: ':memory:' });
  let results;
  const agents = new ScriptedAgents({ script: async (request) => request.attempt.role === 'planner' ? { contract: contract() } : { schemaVersion: 1, target: request.attempt.target, disposition: 'accept', findings: [] },
    onResult: async (request, output) => results.receive(authority(request.attempt), request.operationId, envelope(request.attempt, output)) });
  const service = new OrchestrationService({ store, agents, repositoryIds: new Set(['repo']) });
  results = new AgentResults({ service, artifacts });
  const scheduler = new Scheduler({ service, results, repositories: { provision: async ({ operationId, branch, baseSha }) => ({ worktree: `/tmp/${operationId}`, branch, baseSha }) } });
  t.after(async () => { await scheduler.stop(); await agents.drain(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  service.execute({ id: 'create', goalId: 'g', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'Scheduled results', baseSha: BASE } }, { kind: 'user' });
  await scheduler.start(); await agents.drain(); await scheduler.tick(); await agents.drain(); await scheduler.tick();
  assert.deepEqual(agents.errors, []);
  assert.equal(store.get('g').status, 'awaiting_approval'); assert.equal(store.get('g').reviews.length, 1);
  assert.equal(store.get('g').results.filter((entry) => entry.status === 'accepted').length, 2);
  assert.equal(agents.launches.length, 2); assert.equal(store.get('g').approvedRevision, null);
});

for (const role of ['planner', 'reviewer', 'implementer', 'integrator']) for (const boundary of ['received', 'before_accept_commit', 'accepted']) {
  test(`${role} result survives process death at ${boundary} without duplicate acceptance`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestration-result-crash-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const run = (point) => spawnSync(process.execPath, ['tests/helpers/orchestration/result-recovery-child.mjs', directory, role, point], { encoding: 'utf8', timeout: 10000 });
    const crashed = run(boundary);
    assert.equal(crashed.error, undefined); assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
    assert.equal(readFileSync(join(directory, 'checkpoint'), 'utf8'), boundary);
    for (let restart = 0; restart < 2; restart++) {
      const recovered = run('none');
      assert.equal(recovered.error, undefined); assert.equal(recovered.status, 0, recovered.stderr);
      t.diagnostic(JSON.stringify({ caseId: t.name, failpoint: boundary, seed: 0, observed: JSON.parse(recovered.stdout), expected: role === 'integrator' ? 'One durable receipt and one prepared repair; acceptance awaits Git integration' : 'One durable receipt and one acceptance at the exact role target' }));
      assert.deepEqual(JSON.parse(recovered.stdout), { disposition: role === 'integrator' ? 'pending' : 'accepted', reviews: role === 'integrator' ? 2 : role === 'planner' ? 0 : 1, contracts: 1, repairPrepared: role === 'integrator', received: 1, accepted: role === 'integrator' ? 0 : 1 });
    }
  });
}
