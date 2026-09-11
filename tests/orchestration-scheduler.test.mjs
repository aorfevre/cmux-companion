import assert from 'node:assert/strict';
import test from 'node:test';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { VerificationCoordinator } from '../server/orchestration/verification-coordinator.mjs';
import { FakeAgents, barrier } from './helpers/orchestration/fake-agents.mjs';
import { IntegrationRepairs } from '../server/orchestration/integration-repairs.mjs';
import { Scheduler } from '../server/orchestration/scheduler.mjs';
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
  if (duplicate) f.command('g', 'receive_role_result', { resultId: 'early_duplicate', attemptId, artifactId: 'c'.repeat(64) });
  f.command('g', 'prepare_repair_result', { resultId: 'repair_result', effectId: 'repair_effect', result, proofArtifactId: 'b'.repeat(64) });
  f.command('g', 'record_stopped', { attemptId });
  return attemptId;
}

for (const scenario of ['pending_abort', 'withdrawal', 'sent_abort', 'unknown', 'before_commit', 'after_commit']) test(`repair coordinator preserves ownership across ${scenario}`, async (t) => {
  const f = fixture(t), attemptId = preparedRepair(f); let applied = false, calls = 0, observations = 0;
  if (scenario === 'pending_abort') f.command('g', 'abort', {}, 'user');
  if (scenario === 'withdrawal') f.service.repositoryIds.delete('repo');
  if (scenario === 'sent_abort' || scenario === 'unknown') f.store.advanceOperation('repair_effect', 'pending', 'dispatching');
  if (scenario === 'sent_abort') { f.command('g', 'abort', {}, 'user'); applied = true; }
  const options = { service: f.service, ownership: { assertOwned() {} }, integrations: {
    observeRepair: async () => { observations++; return { status: applied ? 'integrated' : 'unknown', headSha: applied ? 'd'.repeat(40) : null }; },
    acceptRepair: async () => {
      calls++; applied = true;
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
    assert.equal(calls, scenario.endsWith('commit') ? 1 : 0);
    if (applied) { assert.equal(goal.integrationHead, 'd'.repeat(40)); assert.equal(goal.integrationResults.length, 1); }
    else assert.equal(goal.integrationHead, BASE);
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
