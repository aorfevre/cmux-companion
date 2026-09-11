import assert from 'node:assert/strict';
import test from 'node:test';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { OrchestrationService } from '../server/orchestration/service.mjs';
import { Scheduler } from '../server/orchestration/scheduler.mjs';
import { planTarget } from '../server/orchestration/domain/transitions.mjs';
import { createRepositoryFixture, fixtureGit } from './helpers/orchestration/fixture.mjs';
import { ScriptedAgents, barrier } from './helpers/orchestration/fake-agents.mjs';

test('real scheduler overlaps two committing implementers while C waits for integrated dependencies', async (t) => {
  const fixture = await createRepositoryFixture();
  const store = new OrchestrationStore({ path: `${fixture.directory}/workflow.sqlite` });
  const started = new Map([['A', barrier()], ['B', barrier()]]), release = barrier();
  const agents = new ScriptedAgents({ script: async (request) => {
    const task = request.attempt.taskId;
    assert.ok(started.has(task), 'C cannot start before integrated A and B');
    started.get(task).release(); await release.promise;
    const headSha = await fixture.implement(request.attempt.worktree, task);
    return { schemaVersion: 1, type: 'candidate', attemptId: request.attempt.id, headSha };
  } });
  const service = new OrchestrationService({ store, agents, repositoryIds: new Set(['repo']), limits: { global: 2, perGoal: 2 } });
  const scheduler = new Scheduler({ service, repositories: { provision: async (request) => {
    const result = await fixture.checkout(`op_${request.operationId}`, request.baseSha);
    // The fixture builder chooses an isolated branch; persist its actual identity.
    return result;
  } } });
  t.after(async () => { release.release(); await agents.drain(); await scheduler.stop(); store.close(); await fixture.close(); });
  let next = 0;
  const command = (type, payload, kind = 'system') => service.execute({ id: `command${++next}`, goalId: 'g', expectedVersion: store.get('g')?.version ?? 0, type, payload }, { kind });
  command('create_goal', { repositoryId: 'repo', title: 'Parallel fixture tasks', baseSha: fixture.baseSha }, 'user');
  command('publish_contract', { contract: fixture.contract }, 'user');
  // Seed the reviewed/approved contract through commands. This test's observable
  // target is implementer scheduling; scheduled plan review is exercised in T06.
  command('request_attempt', { attemptId: 'review', operationId: 'review_op', role: 'reviewer', conversationId: 'review_conversation' });
  command('record_dispatch', { attemptId: 'review', identity: 'review_worker', worktree: fixture.repository, branch: 'main' });
  command('record_review', { attemptId: 'review', reviewId: 'plan_review', review: { schemaVersion: 1, target: planTarget(store.get('g')), disposition: 'accept', findings: [] } });
  command('record_stopped', { attemptId: 'review' });
  store.advanceOperation('review_op', 'pending', 'completed');
  command('approve', { revision: 1 }, 'user');
  await scheduler.start(); assert.equal(agents.launches.length, 2);
  await Promise.all([...started.values()].map((entry) => entry.promise));
  const implementers = store.get('g').attempts.filter((attempt) => attempt.role === 'implementer');
  assert.equal(implementers.length, 2);
  assert.ok(implementers.every((attempt) => attempt.workerState === 'running' && attempt.baseSha === fixture.baseSha));
  assert.equal(new Set(implementers.map((attempt) => attempt.worktree)).size, 2);
  assert.equal(store.ownedCapacity('g', 'background').total, 2);
  assert.equal(store.get('g').tasks.find((task) => task.id === 'C').status, 'pending');
  release.release(); await agents.drain(); assert.deepEqual(agents.errors, []);
  assert.equal(agents.results.length, 2);
  for (const evidence of agents.results) {
    const attempt = implementers.find((entry) => entry.operationId === evidence.operationId);
    assert.equal(await fixtureGit(attempt.worktree, ['rev-parse', 'HEAD']), evidence.result.headSha);
    assert.equal(await fixtureGit(attempt.worktree, ['rev-parse', 'HEAD^']), fixture.baseSha);
  }
  await scheduler.tick();
  assert.equal(agents.launches.length, 2, 'commits alone cannot satisfy integrated dependencies');
  assert.equal(store.get('g').integrationHead, fixture.baseSha);
  assert.equal(store.get('g').tasks.find((task) => task.id === 'C').status, 'pending');
});

test('script cancellation retains running ownership until the script and result delivery join', async () => {
  const entered = barrier(), release = barrier();
  let signal;
  const agents = new ScriptedAgents({ script: async (_request, context) => {
    signal = context.signal; entered.release(); await release.promise;
    return { candidate: 'late' };
  } });
  const { identity } = await agents.launch({ operationId: 'cancelled' });
  await entered.promise;
  await agents.terminate(identity);
  assert.equal(signal.aborted, true);
  assert.equal((await agents.observe('cancelled')).status, 'running');
  release.release(); await agents.drain();
  assert.equal((await agents.observe('cancelled')).status, 'stopped');
  assert.deepEqual(agents.results, []);
  assert.deepEqual(agents.errors, []);

  const delivering = barrier(), delivered = barrier();
  const output = new ScriptedAgents({ script: async () => ({ candidate: 'done' }),
    onResult: async () => { delivering.release(); await delivered.promise; } });
  const launched = await output.launch({ operationId: 'delivering' });
  await delivering.promise; await output.terminate(launched.identity);
  assert.equal((await output.observe('delivering')).status, 'running');
  delivered.release(); await output.drain();
  assert.equal((await output.observe('delivering')).status, 'stopped');
});

test('cancellation before script start prevents edits and lost acknowledgements still launch one script', async () => {
  const entering = barrier(), proceed = barrier();
  let calls = 0;
  const agents = new ScriptedAgents({ script: async () => { calls++; return {}; } });
  agents.onLaunch = async () => { entering.release(); await proceed.promise; };
  const launch = agents.launch({ operationId: 'early' });
  await entering.promise;
  await agents.terminate((await agents.observe('early')).identity);
  assert.equal((await agents.observe('early')).status, 'running');
  proceed.release(); await launch; await agents.drain();
  assert.equal(calls, 0); assert.equal((await agents.observe('early')).status, 'stopped');

  const entered = barrier(), finish = barrier();
  const lost = new ScriptedAgents({ script: async () => { calls++; entered.release(); await finish.promise; return {}; } });
  lost.loseResponse = true;
  await assert.rejects(lost.launch({ operationId: 'lost' }), /lost launch response/);
  await entered.promise;
  assert.equal((await lost.observe('lost')).status, 'running');
  lost.ignoreTermination = true;
  await lost.terminate((await lost.observe('lost')).identity);
  assert.equal((await lost.observe('lost')).status, 'running');
  finish.release(); await lost.drain();
  assert.equal(calls, 1); assert.equal(lost.launches.length, 1);
  assert.equal(lost.results.length, 1);
  assert.equal((await lost.observe('lost')).status, 'stopped');
});

test('scheduler abort fences scripted work while its capacity remains owned until exit', async (t) => {
  const store = new OrchestrationStore({ path: ':memory:' });
  const entered = barrier(), release = barrier();
  const agents = new ScriptedAgents({ script: async () => { entered.release(); await release.promise; return { late: true }; } });
  const service = new OrchestrationService({ store, agents, repositoryIds: new Set(['repo']) });
  const scheduler = new Scheduler({ service, repositories: { provision: async ({ branch, baseSha }) => ({ worktree: '/tmp/unused-scripted-planner', branch, baseSha }) } });
  t.after(async () => { release.release(); await agents.drain(); await scheduler.stop(); store.close(); });
  service.execute({ id: 'create', goalId: 'abort', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'Abort', baseSha: 'a'.repeat(40) } }, { kind: 'user' });
  await scheduler.start(); assert.equal(agents.launches.length, 1); await entered.promise;
  const attempt = store.get('abort').attempts[0];
  service.execute({ id: 'abort', goalId: 'abort', expectedVersion: store.get('abort').version, type: 'abort', payload: {} }, { kind: 'user' });
  await scheduler.tick();
  assert.equal(store.get('abort').status, 'aborted');
  assert.equal((await agents.observe(attempt.operationId)).status, 'running');
  assert.equal(store.ownedCapacity('abort', 'interactive').total, 1);
  release.release(); await agents.drain(); await scheduler.tick();
  assert.equal(store.ownedCapacity('abort', 'interactive').total, 0);
  assert.equal(store.get('abort').status, 'aborted');
  assert.deepEqual(agents.results, []);
  assert.equal(agents.launches.length, 1);
});
