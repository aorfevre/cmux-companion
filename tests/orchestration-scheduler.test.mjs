import assert from 'node:assert/strict';
import test from 'node:test';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { PublicationCoordinator } from '../server/orchestration/publication-coordinator.mjs';
import { VerificationCoordinator } from '../server/orchestration/verification-coordinator.mjs';
import { FakeAgents, barrier } from './helpers/orchestration/fake-agents.mjs';
import { IntegrationRepairs } from '../server/orchestration/integration-repairs.mjs';
import { Scheduler } from '../server/orchestration/scheduler.mjs';
import { SchedulerOwnership } from '../server/orchestration/storage/ownership.mjs';
import { DomainError } from '../server/orchestration/domain/contracts.mjs';
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

test('pre-queue readiness backfill requires ownership and preserves goal version', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const directory = mkdtempSync(join(tmpdir(), 'orchestration-ready-upgrade-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite'); let store = new OrchestrationStore({ path });
  store.apply({ id: 'create', goalId: 'g', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'goal', baseSha: BASE } }, { kind: 'user' });
  store.db.exec('DROP TABLE ready_work'); store.close();
  store = new OrchestrationStore({ path }); t.after(() => store.close());
  assert.deepEqual(store.ready(), []);
  const owner = new SchedulerOwnership({ store });
  assert.throws(() => store.rebuildReady(() => owner.assertOwned()), { code: 'OWNERSHIP_UNCERTAIN' });
  assert.deepEqual(store.ready(), []);
  owner.acquire();
  try { store.rebuildReady(() => owner.assertOwned()); } finally { owner.release(); }
  assert.equal(store.ready()[0].role, 'planner'); assert.equal(store.get('g').version, 1);
});

test('a competing scheduler cannot refresh the active owners readiness index', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const directory = mkdtempSync(join(tmpdir(), 'orchestration-ready-owner-'));
  const path = join(directory, 'state.sqlite'), first = new OrchestrationStore({ path });
  let owner, second;
  t.after(() => { owner?.release(); second?.close(); first.close(); rmSync(directory, { recursive: true, force: true }); });
  first.apply({ id: 'create', goalId: 'g', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'goal', baseSha: BASE } }, { kind: 'user' });
  first.db.exec('CREATE TABLE ready_audit(action TEXT); CREATE TRIGGER audit_ready BEFORE INSERT ON ready_work BEGIN INSERT INTO ready_audit VALUES (\'insert\'); END;');
  owner = new SchedulerOwnership({ store: first }); owner.acquire();
  const before = first.ready(); second = new OrchestrationStore({ path });
  const service = new OrchestrationService({ store: second, agents: new FakeAgents(), repositoryIds: new Set(['other']) });
  const scheduler = new Scheduler({ service, repositories: { provision: async () => { throw new Error('Must not provision'); } } });
  await assert.rejects(scheduler.start(), { code: 'OWNERSHIP_UNCERTAIN' });
  owner.assertOwned();
  assert.deepEqual(first.ready(), before);
  assert.equal(first.db.prepare('SELECT COUNT(*) AS n FROM ready_audit').get().n, 0);
  assert.equal(first.get('g').version, 1);
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

function acceptedTask(f, goalId = 'g') {
  f.create(goalId); f.approve(goalId);
  const attemptId = f.request(goalId, 'implementer', 'A'); f.dispatch(goalId, attemptId);
  f.command(goalId, 'confirm_candidate', { attemptId, headSha: 'b'.repeat(40) });
  f.command(goalId, 'record_stopped', { attemptId });
  const reviewId = f.request(goalId, 'reviewer', 'A'); f.dispatch(goalId, reviewId);
  f.command(goalId, 'record_review', { attemptId: reviewId, reviewId: 'accepted_a', review: { schemaVersion: 1, target: 'b'.repeat(40), disposition: 'accept', findings: [] } });
  f.command(goalId, 'record_stopped', { attemptId: reviewId });
}

for (const scenario of ['abort', 'receipt_loss', 'failure']) test(`integration coordinator preserves evidence across ${scenario}`, async (t) => {
  const f = fixture(t); acceptedTask(f); let calls = 0;
  const integrations = { integrate: async () => {
    calls++;
    if (scenario === 'abort') f.command('g', 'abort', {}, 'user');
    if (scenario === 'failure') throw new DomainError('OWNERSHIP_UNCERTAIN', 'Moved ref');
    if (scenario === 'receipt_loss') f.store.failpoint = (point) => {
      if (point === 'after_commit' && f.store.get('g').integrationResults?.length) throw new Error('lost database response');
    };
    return { status: 'integrated', headSha: 'c'.repeat(40) };
  } };
  const scheduler = new Scheduler({ service: f.service, repositories: {}, integrations, ownership: { assertOwned() {} } });
  scheduler.stopped = false;
  if (scenario === 'receipt_loss') await assert.rejects(scheduler.integrate(), /lost database response/);
  else await scheduler.integrate();
  f.store.failpoint = () => {};
  await scheduler.integrate();
  assert.equal(calls, 1);
  const goal = f.store.get('g');
  if (scenario === 'failure') {
    assert.equal(goal.integration.state, 'failed'); assert.equal(goal.tasks[0].status, 'accepted');
    assert.equal(goal.integrationHead, BASE);
  } else {
    assert.equal(goal.tasks[0].status, 'integrated'); assert.equal(goal.integrationResults.length, 1);
    assert.ok(!f.store.operations().some((entry) => entry.kind === 'integrate'));
    if (scenario === 'abort') assert.equal(goal.status, 'aborted');
  }
});

test('an aborted dispatching integration is reconciled read-only after restart', async (t) => {
  const f = fixture(t); acceptedTask(f);
  f.command('g', 'request_integration', { taskId: 'A', operationId: 'integration_before_abort' });
  f.store.advanceOperation('integration_before_abort', 'pending', 'dispatching');
  f.command('g', 'abort', {}, 'user');
  let observations = 0, mutations = 0;
  const scheduler = new Scheduler({ service: f.service, repositories: {}, ownership: { assertOwned() {} }, integrations: {
    observeIntegration: async () => { observations++; return { status: 'integrated', headSha: 'c'.repeat(40) }; },
    integrate: async () => { mutations++; throw new Error('Must not resume mutation after abort'); },
  } });
  scheduler.stopped = false; await scheduler.integrate(); await scheduler.integrate();
  assert.equal(observations, 1); assert.equal(mutations, 0);
  assert.equal(f.store.get('g').status, 'aborted'); assert.equal(f.store.get('g').integrationHead, 'c'.repeat(40));
  assert.equal(f.store.get('g').integrationResults.length, 1);
  assert.ok(!f.store.operations().some((operation) => operation.kind === 'integrate'));
});

test('withdrawn repositories do not interrupt unrelated allowed integration work', async (t) => {
  const f = fixture(t); acceptedTask(f);
  f.service.repositoryIds.add('other');
  f.command('h', 'create_goal', { repositoryId: 'other', title: 'Allowed goal', baseSha: BASE }, 'user');
  f.approve('h');
  const implementer = f.request('h', 'implementer', 'A'); f.dispatch('h', implementer);
  f.command('h', 'confirm_candidate', { attemptId: implementer, headSha: 'b'.repeat(40) });
  f.command('h', 'record_stopped', { attemptId: implementer });
  const reviewer = f.request('h', 'reviewer', 'A'); f.dispatch('h', reviewer);
  f.command('h', 'record_review', { attemptId: reviewer, reviewId: 'h_review', review: { schemaVersion: 1, target: 'b'.repeat(40), disposition: 'accept', findings: [] } });
  f.command('h', 'record_stopped', { attemptId: reviewer });
  f.service.repositoryIds.delete('repo');
  const calls = [];
  const scheduler = new Scheduler({ service: f.service, repositories: {}, ownership: { assertOwned() {} }, integrations: {
    integrate: async (input) => { calls.push(input.goalId); return { status: 'integrated', headSha: 'c'.repeat(40) }; },
  } });
  scheduler.stopped = false; await scheduler.integrate();
  assert.deepEqual(calls, ['h']); assert.equal(f.store.get('g').integration, null);
  assert.equal(f.store.get('h').tasks[0].status, 'integrated');
});

function preparedRepair(f, duplicate = false) {
  acceptedTask(f);
  f.command('g', 'request_integration', { taskId: 'A', operationId: 'conflict_a' });
  f.command('g', 'record_integration_conflict', { operationId: 'conflict_a' });
  const attemptId = f.request('g', 'integrator', 'A'); f.dispatch('g', attemptId);
  const attempt = f.store.get('g').attempts.find((entry) => entry.id === attemptId);
  const result = { schemaVersion: 1, goalId: 'g', attemptId, operationId: attempt.operationId, generation: attempt.generation, revision: attempt.revision, role: 'integrator', target: attempt.target,
    output: { headSha: 'c'.repeat(40), operationId: 'conflict_a', summary: 'Resolve conflict', evidence: [] } };
  f.command('g', 'receive_role_result', { resultId: 'repair_result', attemptId, artifactId: 'a'.repeat(64) });
  if (duplicate) {
    // Reopen-era state written before the one-pending-result intake limit.
    const legacy = f.store.get('g');
    legacy.results.push({ ...legacy.results[0], id: 'early_duplicate', artifactId: 'c'.repeat(64) });
    f.store.db.prepare('UPDATE goals SET state=? WHERE id=?').run(JSON.stringify(legacy), 'g');
  }
  f.command('g', 'prepare_repair_result', { resultId: 'repair_result', effectId: 'repair_effect', result, proofArtifactId: 'b'.repeat(64) });
  f.command('g', 'record_stopped', { attemptId });
  return attemptId;
}

for (const final of [false, true]) for (const scenario of ['pending_abort', 'withdrawal', 'sent_abort', 'unknown', 'effect_error', 'before_commit', 'after_commit']) test(`repair coordinator preserves ownership across ${scenario}, final=${final}`, async (t) => {
  const f = fixture(t), attemptId = final ? preparedFinalRepair(f) : preparedRepair(f); let applied = false, calls = 0, observations = 0;
  const before = f.store.get('g');
  if (scenario === 'pending_abort') f.command('g', 'abort', {}, 'user');
  if (scenario === 'withdrawal') f.service.repositoryIds.delete('repo');
  if (scenario === 'sent_abort' || scenario === 'unknown') f.store.advanceOperation('repair_effect', 'pending', 'dispatching');
  if (scenario === 'sent_abort') { f.command('g', 'abort', {}, 'user'); applied = true; }
  const options = { service: f.service, ownership: { assertOwned() {} }, integrations: {
    observeRepair: async () => { observations++; return { status: applied ? 'integrated' : 'unknown', headSha: applied ? 'd'.repeat(40) : null }; },
    acceptRepair: async () => {
      calls++; applied = true;
      if (scenario === 'effect_error') throw new DomainError('OWNERSHIP_UNCERTAIN', 'Effect completed before response was lost');
      if (scenario.endsWith('commit')) f.store.failpoint = (point) => { if (point === scenario) throw new Error('settlement interrupted'); };
      return { status: 'integrated', headSha: 'd'.repeat(40) };
    },
  } };
  if (scenario.endsWith('commit')) await assert.rejects(new IntegrationRepairs(options).run(), /settlement interrupted/);
  else await new IntegrationRepairs(options).run();
  f.store.failpoint = () => {};
  await new IntegrationRepairs(options).run();
  const goal = f.store.get('g'), result = goal.results[0], attempt = goal.attempts.find((entry) => entry.id === attemptId);
  if (scenario === 'unknown') {
    assert.equal(result.status, 'pending'); assert.equal(attempt.status, 'running');
    assert.equal(attempt.workerState, 'stopped'); assert.equal(calls, 0); assert.equal(observations, 2);
    assert.ok(f.store.operations().some((entry) => entry.id === 'repair_effect' && entry.status === 'dispatching'));
  } else {
    assert.ok(!f.store.operations().some((entry) => entry.id === 'repair_effect'));
    const stale = ['pending_abort', 'withdrawal', 'sent_abort'].includes(scenario);
    assert.equal(result.status, stale ? 'rejected' : 'accepted');
    assert.equal(attempt.status, scenario === 'withdrawal' ? 'failed' : stale ? 'cancelled' : 'succeeded');
    assert.equal(attempt.workerState, 'stopped');
    assert.equal(calls, scenario.endsWith('commit') || scenario === 'effect_error' ? 1 : 0);
    if (applied) { assert.equal(goal.integrationHead, 'd'.repeat(40)); assert.equal(goal.integrationResults.length, (before.integrationResults?.length ?? 0) + 1); }
    else assert.equal(goal.integrationHead, before.integrationHead);
  }
});

test('prepared repair owns its result and cannot be replaced by another submission', (t) => {
  const f = fixture(t), attemptId = preparedRepair(f);
  assert.throws(() => f.command('g', 'receive_role_result', { resultId: 'replacement', attemptId, artifactId: 'c'.repeat(64) }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => f.command('g', 'reject_role_result', { resultId: 'repair_result', code: 'STALE_ATTEMPT' }), { code: 'STALE_ATTEMPT' });
  assert.equal(f.store.get('g').results[0].status, 'pending');
});

test('rejecting an earlier duplicate cannot fail the repair effect owner', (t) => {
  const f = fixture(t), attemptId = preparedRepair(f, true);
  f.command('g', 'reject_role_result', { resultId: 'early_duplicate', code: 'STALE_TARGET' });
  const goal = f.store.get('g');
  assert.equal(goal.results[0].status, 'pending'); assert.ok(goal.results[0].repair);
  assert.equal(goal.results[1].status, 'rejected');
  assert.equal(goal.attempts.find((attempt) => attempt.id === attemptId).status, 'running');
});

function integratedGoal(f, goalId = 'g') {
  acceptedTask(f, goalId);
  for (const [index, taskId] of ['A', 'B', 'C'].entries()) {
    if (taskId !== 'A') {
      const attemptId = f.request(goalId, 'implementer', taskId); f.dispatch(goalId, attemptId);
      f.command(goalId, 'confirm_candidate', { attemptId, headSha: 'b'.repeat(40) }); f.command(goalId, 'record_stopped', { attemptId });
      const reviewer = f.request(goalId, 'reviewer', taskId); f.dispatch(goalId, reviewer);
      f.command(goalId, 'record_review', { attemptId: reviewer, reviewId: `accepted_${taskId}`, review: { schemaVersion: 1, target: 'b'.repeat(40), disposition: 'accept', findings: [] } });
      f.command(goalId, 'record_stopped', { attemptId: reviewer });
    }
    f.command(goalId, 'request_integration', { taskId, operationId: `integrate_${goalId}_${taskId}` });
    f.command(goalId, 'record_integration', { operationId: `integrate_${goalId}_${taskId}`, headSha: String(index + 1).repeat(40) });
  }
  for (const operation of f.store.operations()) f.store.advanceOperation(operation.id, operation.status, 'completed');
}
const verificationResult = (headSha, passed = true, workerState = 'stopped') => ({ verification: { headSha, checks: [{ id: 'unit', passed, artifactId: 'a'.repeat(64) }] }, workerState, artifactId: 'b'.repeat(64) });

for (const interrupted of [false, true]) test(`verification receipt settles once after coordinator interruption=${interrupted}`, async (t) => {
  const f = fixture(t); integratedGoal(f); let launches = 0, receipt;
  const errors = [], options = { service: f.service, ownership: { assertOwned() {} }, onError: (error) => errors.push(error), verifier: {
    run: async (input) => { launches++; receipt = verificationResult(input.headSha); if (interrupted) f.store.failpoint = (point) => { if (point === 'after_commit' && f.store.get('g').verification) throw new Error('lost receipt acknowledgement'); }; return receipt; },
    observe: async () => receipt,
  } };
  const coordinator = new VerificationCoordinator(options); await coordinator.run();
  const job = [...coordinator.active.values()][0].job;
  if (interrupted) await assert.rejects(job, /lost receipt acknowledgement/); else await job;
  f.store.failpoint = () => {};
  await new VerificationCoordinator(options).run();
  assert.equal(launches, 1); assert.equal(f.store.get('g').verification.checks[0].passed, true);
  assert.ok(!f.store.operations().some((operation) => operation.kind === 'verify'));
  assert.equal(errors.length, interrupted ? 1 : 0);
});

test('unknown verification remains owned and cannot authorize retry, final repair or publication', async (t) => {
  const f = fixture(t); integratedGoal(f);
  const coordinator = new VerificationCoordinator({ service: f.service, ownership: { assertOwned() {} }, verifier: {
    run: async (input) => verificationResult(input.headSha, false, 'unknown'), observe: async () => null,
  } });
  await coordinator.run(); await [...coordinator.active.values()][0].job;
  const run = f.store.get('g').verificationRuns[0];
  assert.equal(run.status, 'uncertain'); assert.equal(run.workerState, 'unknown');
  assert.throws(() => f.command('g', 'retry_verification', {}, 'user'), { code: 'NOT_READY' });
  assert.throws(() => f.request('g', 'integrator'), { code: 'NOT_READY' });
  assert.throws(() => f.command('g', 'request_publication', { operationId: 'publish' }), { code: 'NOT_READY' });
});

test('failed stopped verification can be explicitly retried without reusing its receipt', async (t) => {
  const f = fixture(t); integratedGoal(f); let launches = 0;
  const coordinator = new VerificationCoordinator({ service: f.service, ownership: { assertOwned() {} }, verifier: {
    run: async (input) => verificationResult(input.headSha, ++launches > 1), observe: async () => null,
  } });
  await coordinator.run(); await [...coordinator.active.values()][0].job;
  await coordinator.run(); assert.equal(launches, 1);
  f.command('g', 'retry_verification', {}, 'user');
  await coordinator.run(); await [...coordinator.active.values()][0].job;
  assert.equal(launches, 2); assert.equal(f.store.get('g').verificationRuns.length, 2);
  assert.equal(f.store.get('g').verification.checks[0].passed, true);
});

test('scheduler admits other goals during checks and joins cancelled verification before releasing ownership', async (t) => {
  const f = fixture(t); integratedGoal(f); f.service.agents = new FakeAgents();
  const started = barrier(), cancelled = barrier(), release = barrier(); let released = false;
  const ownership = { acquire() {}, assertOwned() { assert.equal(released, false); }, release() { released = true; } };
  const scheduler = new Scheduler({ service: f.service, ownership, repositories: { provision: async (input) => ({ worktree: `/tmp/${input.operationId}`, branch: input.branch, baseSha: input.baseSha }) }, verifier: {
    run: async (input) => { started.release(); input.signal.addEventListener('abort', () => cancelled.release(), { once: true }); await release.promise; return verificationResult(input.headSha, false); },
    observe: async () => null,
  } });
  t.after(async () => { release.release(); if (!released) await scheduler.stop(); });
  await scheduler.start(); await started.promise;
  f.create('h'); await scheduler.tick();
  assert.ok(f.service.agents.launches.some((launch) => launch.goalId === 'h' && launch.attempt.role === 'planner'));
  const stopped = scheduler.stop(); await cancelled.promise; assert.equal(released, false);
  release.release(); await stopped; assert.equal(released, true);
});

test('abort during checks archives their result without reviving final evidence', async (t) => {
  const f = fixture(t); integratedGoal(f); const release = barrier();
  const coordinator = new VerificationCoordinator({ service: f.service, ownership: { assertOwned() {} }, verifier: {
    run: async (input) => { await release.promise; assert.equal(input.signal.aborted, true); return verificationResult(input.headSha, false); }, observe: async () => null,
  } });
  await coordinator.run(); const job = [...coordinator.active.values()][0].job;
  f.command('g', 'abort', {}, 'user'); coordinator.cancelRevoked(); release.release(); await job;
  assert.equal(f.store.get('g').status, 'aborted'); assert.equal(f.store.get('g').verification, null);
  assert.equal(f.store.get('g').verificationRuns[0].status, 'complete');
});

for (const restart of [false, true]) test(`unknown verification globally retains capacity across restart=${restart}`, async (t) => {
  const f = fixture(t); integratedGoal(f); integratedGoal(f, 'h');
  let launches = 0;
  const options = { service: f.service, ownership: { assertOwned() {} }, verifier: {
    run: async (input) => { launches++; return verificationResult(input.headSha, false, 'unknown'); }, observe: async () => null,
  } };
  const first = new VerificationCoordinator(options);
  await first.run(); await Promise.all([...first.active.values()].map((run) => run.job));
  const coordinator = restart ? new VerificationCoordinator(options) : first;
  await coordinator.run(); await Promise.all([...coordinator.active.values()].map((run) => run.job));
  assert.equal(launches, 1);
  assert.deepEqual(['g', 'h'].map((goalId) => f.store.get(goalId).verificationRuns[0].workerState).sort(), ['pending', 'unknown']);
  f.create('ordinary'); f.approve('ordinary');
  assert.ok(f.request('ordinary', 'implementer', 'A'));
});

function preparedFinalRepair(f) {
  integratedGoal(f);
  f.command('g', 'record_verification', { headSha: f.store.get('g').integrationHead, checks: [{ id: 'unit', passed: false, artifactId: 'failed_check' }] });
  const attemptId = f.request('g', 'integrator'); f.dispatch('g', attemptId);
  const attempt = f.store.get('g').attempts.find((entry) => entry.id === attemptId);
  const result = { schemaVersion: 1, goalId: 'g', attemptId, operationId: attempt.operationId, generation: attempt.generation, revision: attempt.revision, role: 'integrator', target: attempt.target,
    output: { headSha: 'c'.repeat(40), operationId: null, summary: 'Repair combined behavior', evidence: [] } };
  f.command('g', 'receive_role_result', { resultId: 'repair_result', attemptId, artifactId: 'a'.repeat(64) });
  f.command('g', 'prepare_repair_result', { resultId: 'repair_result', effectId: 'repair_effect', result, proofArtifactId: 'b'.repeat(64) });
  f.command('g', 'record_stopped', { attemptId });
  assert.throws(() => f.command('g', 'request_revision', { message: 'Change scope' }, 'user'), { code: 'OWNERSHIP_UNCERTAIN' });
  assert.throws(() => f.command('g', 'request_verification', { operationId: 'premature' }), { code: 'NOT_READY' });
  assert.throws(() => f.request('g', 'integrator'), { code: 'NOT_READY' });
  return attemptId;
}

function approvedPublicationGoal(f, approve = true) {
  integratedGoal(f);
  f.command('g', 'record_verification', { headSha: f.store.get('g').integrationHead, checks: [{ id: 'unit', passed: true, artifactId: 'verified' }] });
  const reviewer = f.request('g', 'reviewer'); f.dispatch('g', reviewer);
  f.command('g', 'record_review', { attemptId: reviewer, reviewId: 'final_review', review: { schemaVersion: 1, target: f.store.get('g').integrationHead, disposition: 'accept', findings: [] } });
  f.command('g', 'record_stopped', { attemptId: reviewer });
  f.command('g', 'request_publication', { operationId: 'publish' });
  if (approve) f.command('g', 'approve_publication', { operationId: 'publish', headSha: f.store.get('g').integrationHead }, 'user');
}
const publishedResult = (input) => ({ status: 'published', baseHeadSha: input.baseSha, pr: { number: 1, url: 'https://github.invalid/pull/1', headSha: input.headSha } });

test('publication stays idle across coordinator restarts until exact-head user approval', async t => {
  const f = fixture(t); approvedPublicationGoal(f, false); let calls = 0;
  const options = { service: f.service, ownership: { assertOwned() {} }, publisher: { publish: async input => { calls++; return publishedResult(input); }, observe: async () => { throw new Error('No external effect before approval'); } } };
  for (let i = 0; i < 3; i++) { const coordinator = new PublicationCoordinator(options); await coordinator.run(); assert.equal(coordinator.active.size, 0); }
  assert.equal(calls, 0); assert.equal(f.store.operations().filter(operation => operation.kind === 'publish').length, 0);
  const before = f.store.get('g');
  const command = { id: 'approve_publish', goalId: 'g', expectedVersion: before.version, type: 'approve_publication', payload: { operationId: 'publish', headSha: before.integrationHead } };
  f.service.execute(command, { kind: 'user' }); f.service.execute(command, { kind: 'user' });
  assert.equal(f.store.operations().filter(operation => operation.kind === 'publish').length, 1);
  const coordinator = new PublicationCoordinator(options); await coordinator.run(); await Promise.all([...coordinator.active.values()].map(run => run.job));
  assert.equal(calls, 1); assert.equal(f.store.get('g').status, 'delivered');
});

test('an unpublished proposal can be revised and an old publication approval cannot follow it', t => {
  const f = fixture(t); approvedPublicationGoal(f, false); const before = f.store.get('g');
  f.command('g', 'request_revision', { message: 'Change acceptance criteria' }, 'user');
  assert.equal(f.store.get('g').publication, null);
  assert.throws(() => f.command('g', 'approve_publication', { operationId: 'publish', headSha: before.integrationHead }, 'user'), { code: 'STALE_OPERATION' });
  assert.equal(f.store.operations().filter(operation => operation.kind === 'publish').length, 0);
});

test('moved target pauses remote polling until exact user acceptance and retains final evidence', async t => {
  const f = fixture(t); approvedPublicationGoal(f); let calls = 0;
  const moved = 'e'.repeat(40);
  const publisher = { publish: async input => {
    calls++;
    return input.acceptedTargets?.at(-1)?.baseHeadSha === moved ? { ...publishedResult(input), baseHeadSha: moved } : { status: 'target_moved', baseHeadSha: moved, pr: null };
  }, observe: async () => ({ status: 'target_moved', baseHeadSha: moved, pr: null }) };
  const options = { service: f.service, publisher, ownership: { assertOwned() {} } };
  const run = async coordinator => { await coordinator.run(); await Promise.all([...coordinator.active.values()].map(entry => entry.job)); };
  await run(new PublicationCoordinator(options));
  const before = f.store.get('g'), operationId = before.publication.operationId;
  for (let i = 0; i < 3; i++) await run(new PublicationCoordinator(options));
  assert.equal(calls, 1);
  assert.throws(() => f.command('g', 'accept_moved_target', { operationId, baseHeadSha: moved }), { code: 'FORBIDDEN' });
  assert.throws(() => f.command('g', 'accept_moved_target', { operationId, baseHeadSha: BASE }, 'user'), { code: 'STALE_TARGET' });
  assert.throws(() => f.command('g', 'accept_moved_target', { operationId: 'stale', baseHeadSha: moved }, 'user'), { code: 'STALE_OPERATION' });
  assert.ok((await import('../server/orchestration/domain/action-view.mjs')).actionView(before).actions.some(action => action.type === 'accept_moved_target'));
  f.command('g', 'accept_moved_target', { operationId, baseHeadSha: moved }, 'user');
  assert.throws(() => f.command('g', 'accept_moved_target', { operationId, baseHeadSha: moved }, 'user'), { code: 'STALE_TARGET' });
  assert.deepEqual(f.store.get('g').reviews, before.reviews); assert.deepEqual(f.store.get('g').verification, before.verification);
  assert.equal(f.store.get('g').integrationHead, before.integrationHead); assert.equal(f.store.get('g').publication.plan.baseSha, BASE);
  await run(new PublicationCoordinator(options));
  assert.equal(calls, 2); assert.equal(f.store.get('g').status, 'delivered');
  assert.equal(f.store.get('g').publication.operationId, operationId);
});

test('abort revokes moved-target acceptance and settles the paused publication without sending', async t => {
  const f = fixture(t); approvedPublicationGoal(f);
  f.store.advanceOperation('publish', 'pending', 'dispatching');
  const observation = { status: 'target_moved', baseHeadSha: 'e'.repeat(40), pr: null };
  f.command('g', 'record_publication_observation', { operationId: 'publish', observation });
  f.command('g', 'abort', {}, 'user');
  assert.throws(() => f.command('g', 'accept_moved_target', { operationId: 'publish', baseHeadSha: observation.baseHeadSha }, 'user'), { code: 'TERMINAL_GOAL' });
  const coordinator = new PublicationCoordinator({ service: f.service, ownership: { assertOwned() {} }, publisher: { publish: async () => { throw new Error('Must not publish'); }, observe: async () => observation } });
  await coordinator.run(); await Promise.all([...coordinator.active.values()].map(entry => entry.job));
  assert.equal(f.store.get('g').publication.observation.status, 'cancelled');
  assert.ok(!f.store.operations().some(operation => operation.kind === 'publish'));
});

test('a missing target branch remains observable so restoring it can recover publication', async t => {
  const f = fixture(t); approvedPublicationGoal(f); let calls = 0;
  const coordinator = new PublicationCoordinator({ service: f.service, ownership: { assertOwned() {} }, publisher: {
    publish: async input => ++calls === 1 ? { status: 'target_moved', baseHeadSha: null, pr: null } : publishedResult(input),
    observe: async () => { throw new Error('Active publication uses publish'); },
  } });
  await coordinator.run(); await Promise.all([...coordinator.active.values()].map(entry => entry.job));
  assert.equal(f.store.get('g').publication.observation.baseHeadSha, null);
  await coordinator.run(); await Promise.all([...coordinator.active.values()].map(entry => entry.job));
  assert.equal(calls, 2); assert.equal(f.store.get('g').status, 'delivered');
});

for (const scenario of ['normal', 'receipt_loss', 'pending_abort', 'sent_abort', 'unknown']) test(`publication coordinator retains exact operation ownership across ${scenario}`, async (t) => {
  const f = fixture(t); approvedPublicationGoal(f); let calls = 0, receipt = null;
  const publisher = {
    publish: async (input) => {
      calls++;
      receipt = publishedResult(input);
      if (scenario === 'sent_abort') { f.command('g', 'abort', {}, 'user'); throw new Error('PR succeeded after abort'); }
      if (scenario === 'unknown') return { status: 'unknown', baseHeadSha: input.baseSha, pr: null };
      if (scenario === 'receipt_loss') f.store.failpoint = (point) => { if (point === 'after_commit' && f.store.get('g').pr) throw new Error('Lost database acknowledgement'); };
      return receipt;
    },
    observe: async () => receipt,
  };
  const options = { service: f.service, publisher, ownership: { assertOwned() {} } };
  if (scenario === 'pending_abort') f.command('g', 'abort', {}, 'user');
  const coordinator = new PublicationCoordinator(options); await coordinator.run();
  const jobs = [...coordinator.active.values()].map((run) => run.job);
  if (scenario === 'receipt_loss') await assert.rejects(Promise.all(jobs), /Lost database acknowledgement/); else await Promise.all(jobs);
  f.store.failpoint = () => {};
  if (scenario !== 'unknown') {
    const restarted = new PublicationCoordinator(options); await restarted.run(); await Promise.all([...restarted.active.values()].map((run) => run.job));
  }
  const goal = f.store.get('g');
  assert.equal(calls, scenario === 'pending_abort' ? 0 : 1);
  if (scenario === 'unknown') {
    assert.equal(goal.status, 'ready_to_publish'); assert.equal(goal.pr, null);
    assert.equal(goal.publication.observation.status, 'unknown');
    assert.ok(f.store.operations().some((operation) => operation.kind === 'publish' && operation.status === 'dispatching'));
  } else {
    assert.equal(goal.status, scenario.endsWith('abort') ? 'aborted' : 'delivered');
    assert.equal(goal.pr?.headSha ?? null, scenario === 'pending_abort' ? null : goal.integrationHead);
    assert.ok(!f.store.operations().some((operation) => operation.kind === 'publish'));
  }
});

test('scheduler continues agent admission and joins publication before releasing ownership', async (t) => {
  const f = fixture({ after() {} }); approvedPublicationGoal(f); f.service.agents = new FakeAgents();
  const started = barrier(), cancelled = barrier(), release = barrier();
  const scheduler = new Scheduler({ service: f.service, repositories: { provision: async ({ operationId, branch, baseSha }) => ({ worktree: `/tmp/${operationId}`, branch, baseSha }) }, publisher: {
    publish: async (input, { signal }) => { started.release(); signal.addEventListener('abort', () => cancelled.release(), { once: true }); await release.promise; return { status: 'cancelled', baseHeadSha: input.baseSha, pr: null }; },
    observe: async () => ({ status: 'unknown', baseHeadSha: null, pr: null }),
  } });
  t.after(async () => { release.release(); await scheduler.stop(); f.store.close(); });
  await scheduler.start(); await started.promise;
  f.create('other'); await scheduler.tick();
  assert.ok(f.service.agents.launches.some((entry) => entry.goalId === 'other'));
  const stopped = scheduler.stop(); await cancelled.promise;
  assert.equal(scheduler.ownership.acquired, true);
  release.release(); await stopped;
  assert.equal(scheduler.ownership.acquired, false);
  assert.ok(f.store.operations().some((operation) => operation.kind === 'publish'), 'Shutdown keeps a resumable publication');
  const restarted = new PublicationCoordinator({ service: f.service, ownership: { assertOwned() {} }, publisher: { publish: async (input) => publishedResult(input), observe: async () => ({ status: 'unknown', baseHeadSha: null, pr: null }) } });
  await restarted.run(); await Promise.all([...restarted.active.values()].map((run) => run.job));
  assert.equal(f.store.get('g').status, 'delivered');
});

test('an unreadable integration receipt preserves its intent and does not starve other goals', async (t) => {
  const f = fixture(t); acceptedTask(f);
  f.command('g', 'request_integration', { taskId: 'A', operationId: 'damaged_integration' });
  f.store.advanceOperation('damaged_integration', 'pending', 'dispatching');
  f.command('g', 'record_integration_failure', { operationId: 'damaged_integration', code: 'OWNERSHIP_UNCERTAIN' });
  f.create('h');
  const agents = new FakeAgents(), errors = [];
  f.service.agents = agents;
  const scheduler = new Scheduler({ service: f.service, repositories: {
    provision: async ({ branch, baseSha }) => ({ worktree: '/tmp/isolated-receipt-test', branch, baseSha }),
  }, ownership: { assertOwned() {} }, onError: (error) => errors.push(error), integrations: {
    observeIntegration: async () => { throw new DomainError('OWNERSHIP_UNCERTAIN', 'Receipt changed'); },
    integrate: async () => { throw new Error('Uncertain integration must not be replayed'); },
  } });
  scheduler.stopped = false;
  await scheduler.pass();
  assert.equal(errors.length, 1); assert.equal(errors[0].code, 'OWNERSHIP_UNCERTAIN');
  assert.ok(agents.launches.some((entry) => entry.goalId === 'h' && entry.attempt.role === 'planner'));
  assert.equal(f.store.operations().find((entry) => entry.id === 'damaged_integration').status, 'dispatching');
  assert.equal(f.store.get('g').integration.state, 'failed');
});

for (const observation of ['pending', 'integrated', 'unknown']) test(`explicit integration retry observes ${observation} before any replay`, async (t) => {
  const f = fixture(t); acceptedTask(f); let calls = 0, observed = false;
  const scheduler = new Scheduler({ service: f.service, repositories: {}, ownership: { assertOwned() {} }, integrations: {
    integrate: async () => { calls++; if (calls === 1) throw new DomainError('GIT_OPERATION_FAILED', 'Timed out'); assert.ok(observed); return { status: 'integrated', headSha: 'c'.repeat(40) }; },
    observeIntegration: async () => { observed = true; return { status: observation, headSha: observation === 'integrated' ? 'c'.repeat(40) : null }; },
  } });
  scheduler.stopped = false; await scheduler.integrate();
  const operationId = f.store.get('g').integration.operationId;
  if (observation !== 'integrated') { await scheduler.integrate(); assert.equal(calls, 1); }
  f.command('g', 'retry_integration', { operationId }, 'user');
  assert.throws(() => f.command('g', 'retry_integration', { operationId }, 'user'), { code: 'NOT_READY' });
  await scheduler.integrate();
  assert.equal(calls, observation === 'pending' ? 2 : 1);
  const goal = f.store.get('g');
  if (observation === 'unknown') {
    assert.equal(goal.integration.state, 'failed'); assert.equal(goal.integration.retryRequested, false);
    assert.equal(goal.integration.code, 'OWNERSHIP_UNCERTAIN'); assert.ok(f.store.operations().some((op) => op.id === operationId));
  } else { assert.equal(goal.integration, null); assert.equal(goal.integrationResults.length, 1); }
});

for (const state of ['pending', 'failed', 'conflict']) test(`abort settles proven non-applied ${state} integration intent`, async (t) => {
  const f = fixture(t); acceptedTask(f);
  f.command('g', 'request_integration', { taskId: 'A', operationId: 'abandoned' });
  if (state !== 'pending') f.store.advanceOperation('abandoned', 'pending', 'dispatching');
  if (state === 'failed') f.command('g', 'record_integration_failure', { operationId: 'abandoned', code: 'GIT_OPERATION_FAILED' });
  if (state === 'conflict') f.command('g', 'record_integration_conflict', { operationId: 'abandoned' });
  f.command('g', 'abort', {}, 'user');
  const scheduler = new Scheduler({ service: f.service, repositories: {}, ownership: { assertOwned() {} }, integrations: {
    observeIntegration: async () => ({ status: 'pending', headSha: null }),
    integrate: async () => { throw new Error('Terminal integration must never mutate Git'); },
  } });
  scheduler.stopped = false; await scheduler.integrate();
  assert.ok(!f.store.operations().some((op) => op.id === 'abandoned'));
  assert.equal(f.store.get('g').integrationHead, BASE);
});

for (const final of [false, true]) for (const observation of ['pending', 'integrated', 'unknown']) test(`explicit repair retry observes ${observation}, final=${final}`, async (t) => {
  const f = fixture(t); if (final) preparedFinalRepair(f); else preparedRepair(f); let calls = 0;
  const coordinator = new IntegrationRepairs({ service: f.service, ownership: { assertOwned() {} }, integrations: {
    acceptRepair: async () => { calls++; if (calls === 1) throw new DomainError('GIT_OPERATION_FAILED', 'Timed out'); return { status: 'integrated', headSha: 'd'.repeat(40) }; },
    observeRepair: async () => ({ status: observation, headSha: observation === 'integrated' ? 'd'.repeat(40) : null }),
  } });
  await coordinator.run(); const operationId = f.store.get('g').integration.operationId;
  f.command('g', 'retry_integration', { operationId }, 'user'); await coordinator.run();
  assert.equal(calls, observation === 'pending' ? 2 : 1);
  if (observation === 'unknown') { assert.equal(f.store.get('g').integration.state, 'failed'); assert.equal(f.store.get('g').integration.retryRequested, false); }
  else { assert.equal(f.store.get('g').integration, null); assert.equal(f.store.get('g').results[0].status, 'accepted'); }
});

for (const observation of ['pending', 'unknown']) test(`aborted dispatching repair ${observation} evidence controls settlement`, async (t) => {
  const f = fixture(t); preparedRepair(f);
  f.store.advanceOperation('repair_effect', 'pending', 'dispatching'); f.command('g', 'abort', {}, 'user');
  const coordinator = new IntegrationRepairs({ service: f.service, ownership: { assertOwned() {} }, integrations: {
    observeRepair: async () => ({ status: observation, headSha: null }),
    acceptRepair: async () => { throw new Error('Aborted repair must never mutate Git'); },
  } });
  await coordinator.run();
  assert.equal(f.store.operations().some((op) => op.id === 'repair_effect'), observation === 'unknown');
  assert.equal(f.store.get('g').results[0].status, observation === 'unknown' ? 'pending' : 'rejected');
});

for (const repair of [false, true]) test(`abort recovery releases cleanup and rollback gates, repair=${repair}`, async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { assertRollback } = await import('../server/orchestration/cutover.mjs');
  const { ResourceCleanup } = await import('../server/orchestration/cleanup.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'integration-recovery-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(t);
  if (repair) { preparedRepair(f); f.store.advanceOperation('repair_effect', 'pending', 'dispatching'); }
  else { acceptedTask(f); f.command('g', 'request_integration', { taskId: 'A', operationId: 'failed' }); f.store.advanceOperation('failed', 'pending', 'dispatching'); }
  f.command('g', 'record_integration_failure', { operationId: f.store.get('g').integration.operationId, code: 'GIT_OPERATION_FAILED' });
  for (const op of f.store.operations().filter((entry) => ['launch', 'terminate'].includes(entry.kind))) f.store.advanceOperation(op.id, op.status, 'completed');
  f.command('g', 'abort', {}, 'user');
  const cleanup = new ResourceCleanup({ service: f.service, repositories: {}, assertOwned() {} });
  assert.throws(() => cleanup.eligible('g', f.store.get('g').version), { code: 'NOT_READY' });
  const scheduler = new Scheduler({ service: f.service, repositories: {}, ownership: { assertOwned() {} }, integrations: {
    observeIntegration: async () => ({ status: 'pending', headSha: null }), observeRepair: async () => ({ status: 'pending', headSha: null }),
    integrate: async () => { throw new Error('No aborted mutations'); }, acceptRepair: async () => { throw new Error('No aborted mutations'); },
  } });
  scheduler.stopped = false; await scheduler.integrate();
  assert.equal(cleanup.eligible('g', f.store.get('g').version).status, 'aborted');
  const database = join(directory, 'snapshot.sqlite'); f.store.db.prepare('VACUUM INTO ?').run(database);
  assert.deepEqual(assertRollback(database), { safe: true, goals: 1 });
});

test('new goals persist before fetch, recover retryably and pin their base once before launch', async t => {
  const f = fixture(t);
  f.command('fresh', 'create_goal', { repositoryId: 'repo', title: 'fresh', baseBranch: 'main' }, 'user');
  assert.equal(f.store.get('fresh').startup.status, 'pending');
  assert.equal(f.store.ready().length, 0);
  assert.throws(() => f.request('fresh', 'planner'), { code: 'NOT_READY' });
  let fetches = 0, launches = 0;
  f.agents.launch = async () => { launches++; return { identity: 'planner' }; };
  f.agents.observe = async () => ({ status: 'running', identity: 'planner' });
  const scheduler = new Scheduler({ service: f.service,
    prepareGoal: async () => { if (++fetches === 1) throw new DomainError('BASE_FETCH_FAILED', 'Check GitHub access and retry'); return BASE; },
    repositories: { provision: async request => ({ worktree: '/tmp/owned-planner', branch: request.branch, baseSha: request.baseSha }) },
  });
  await scheduler.start();
  assert.equal(f.store.get('fresh').startup.status, 'failed');
  assert.match(f.store.get('fresh').startup.error, /GitHub/);
  await scheduler.tick(); assert.equal(fetches, 1); assert.equal(launches, 0);
  f.command('fresh', 'retry_startup', {}, 'user');
  await scheduler.tick();
  assert.equal(f.store.get('fresh').baseSha, BASE);
  assert.equal(f.store.get('fresh').startup.status, 'ready');
  assert.equal(launches, 1);
  await scheduler.stop(); await scheduler.start(); await scheduler.tick();
  assert.equal(fetches, 2); assert.equal(launches, 1);
  f.create('historical'); await scheduler.tick();
  assert.equal(f.store.get('historical').baseSha, BASE);
  assert.equal(fetches, 2);
  await scheduler.stop();
});

test('abort during base fetch preserves the terminal goal and never provisions a planner', async t => {
  const f = fixture(t);
  f.command('aborted-fetch', 'create_goal', { repositoryId: 'repo', title: 'Stop this' }, 'user');
  const scheduler = new Scheduler({ service: f.service,
    prepareGoal: async () => { f.command('aborted-fetch', 'abort', {}, 'user'); return BASE; },
    repositories: { provision: async () => { assert.fail('aborted goal must never provision'); } },
  });
  try {
    await scheduler.start();
    assert.equal(f.store.get('aborted-fetch').status, 'aborted');
    assert.equal(f.store.get('aborted-fetch').baseSha, '');
    assert.equal(f.store.get('aborted-fetch').attempts.length, 0);
    await scheduler.tick();
  } finally { await scheduler.stop(); }
});

test('stalled base fetch is bounded and does not block other goals or reconciliation; stop awaits ownership', async t => {
  const f = fixture(t), fetching = barrier();
  for (const id of ['fetch-one', 'fetch-two']) f.command(id, 'create_goal', { repositoryId: 'repo', title: id }, 'user');
  f.create('runnable');
  let fetches = 0, observed = 0;
  f.agents.launch = async () => ({ identity: 'live-worker' });
  f.agents.observe = async () => { observed++; return { status: 'running', identity: 'live-worker' }; };
  const scheduler = new Scheduler({ service: f.service, prepareGoal: async () => { fetches++; await fetching.promise; return BASE; },
    repositories: { provision: async request => ({ worktree: '/tmp/owned-other', branch: request.branch, baseSha: request.baseSha }) },
  });
  try {
    await scheduler.start();
    assert.equal(f.store.get('runnable').attempts[0].status, 'running');
    assert.equal(fetches, 1); assert.equal(scheduler.startupJobs.size, 1);
    await scheduler.tick(); assert.ok(observed > 0); assert.equal(fetches, 1);
    f.command('fetch-one', 'abort', {}, 'user');
    let stopped = false;
    const shutdown = scheduler.stop().then(() => { stopped = true; });
    await Promise.resolve(); assert.equal(stopped, false);
    fetching.release(); await shutdown;
    assert.equal(scheduler.startupJobs.size, 0);
    assert.equal(fetches, 1); assert.equal(f.store.get('fetch-one').baseSha, '');
  } finally { fetching.release(); await scheduler.stop(); }
});
