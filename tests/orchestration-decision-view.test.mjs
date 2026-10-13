import assert from 'node:assert/strict';
import test from 'node:test';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { decisionView } from '../server/orchestration/domain/decision-view.mjs';
import { goalView } from '../server/orchestration/domain/state-view.mjs';
import { transition, planTarget } from '../server/orchestration/domain/transitions.mjs';
import { fixture, contract, BASE, HEAD_A, HEAD_B } from './helpers/orchestration/domain-fixture.mjs';

const primary = goal => decisionView(goal).primary?.type ?? null;

test('startup failure, approval, delivery and abort pick the first offered primary', () => {
  const created = transition(null, { id: 'create', goalId: 'goal', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'Fix', baseBranch: 'main' } }, { kind: 'user' }).goal;
  const failed = transition(created, { id: 'fail', goalId: 'goal', expectedVersion: created.version, type: 'fail_startup', payload: { error: 'Repository is owned by another service.' } }, { kind: 'system' }).goal;
  assert.deepEqual(decisionView(failed), { state: 'Repository is owned by another service.', reason: null, primary: { type: 'retry_startup', label: 'Retry startup', payload: {} } });
  const ready = fixture();
  ready.command('publish_contract', { contract: contract() }, ready.user);
  assert.deepEqual(decisionView(ready.goal), { state: 'Your plan waits on a blocker.', reason: 'Independent plan review must accept this revision', primary: null });
  ready.request('plan_review', 'reviewer'); ready.dispatch('plan_review'); ready.review('plan_review', planTarget(ready.goal));
  assert.equal(decisionView(ready.goal).state, 'Your plan is ready to approve.');
  assert.equal(decisionView(ready.goal).primary.label, 'Approve revision 1');
  const delivered = fixture(); delivered.deliver();
  assert.deepEqual(decisionView(delivered.goal), { state: 'Pull request published. Waiting for merge.', reason: null, primary: null });
  delivered.command('abort', {}, delivered.user);
  assert.deepEqual(decisionView(delivered.goal), { state: 'Aborted. Evidence is retained.', reason: null, primary: null });
});

test('the publication gate is a primary, and progress has none', () => {
  const f = fixture();
  const single = contract(); single.tasks = [single.tasks[0]]; f.approve(single);
  assert.deepEqual(decisionView(f.goal), { state: 'Work continues automatically. No action needed.', reason: null, primary: null });
  f.request('a', 'implementer', 'A'); f.dispatch('a');
  assert.equal(decisionView(f.goal).state, '1 agent working.');
  f.command('confirm_candidate', { attemptId: 'a', headSha: HEAD_A }); f.command('record_stopped', { attemptId: 'a' });
  f.request('ar', 'reviewer', 'A'); f.dispatch('ar'); f.review('ar', HEAD_A);
  f.command('request_integration', { taskId: 'A', operationId: 'integrate' });
  f.command('record_integration', { operationId: 'integrate', headSha: HEAD_B });
  f.request('final', 'reviewer'); f.dispatch('final'); f.review('final', HEAD_B);
  f.command('record_verification', { headSha: HEAD_B, checks: [{ id: 'unit', passed: true, artifactId: 'log' }] });
  f.command('request_publication', { operationId: 'publish' });
  assert.equal(decisionView(f.goal).state, 'The verified result waits for your publication approval.');
  assert.equal(primary(f.goal), 'approve_publication');
});

test('a held goal explains a refusal, recovers through the plain recovery action, then continues', () => {
  const f = fixture(); f.request('planner', 'planner'); f.dispatch('planner');
  f.command('record_failure', { attemptId: 'planner', uncertain: true, error: 'Lost connection' });
  assert.deepEqual(decisionView(f.goal), { state: 'The goal is on hold.', reason: 'Let active workers finish and reconcile uncertain ownership before recovery', primary: null });
  f.command('record_stopped', { attemptId: 'planner' });
  const stopped = decisionView(f.goal);
  assert.equal(stopped.reason, 'planner did not finish successfully.');
  assert.equal(stopped.primary.label, 'Recover goal');
  assert.equal(stopped.primary.payload.mode, undefined);
  f.recover();
  assert.deepEqual(decisionView(f.goal), { state: 'Work continues automatically. No action needed.', reason: null, primary: null });
});

test('the observed supervisor scenario recovers, then approves the reviewed revision, and pause offers resume', t => {
  const store = new OrchestrationStore({ path: ':memory:' }); t.after(() => store.close());
  let next = 0; const user = { kind: 'user' }, system = { kind: 'system' };
  const command = (type, payload = {}, authority = user) => store.apply({ id: `c${++next}`, goalId: 'g', expectedVersion: store.get('g')?.version ?? 0, type, payload }, authority);
  command('create_goal', { repositoryId: 'repo', title: 'Session in mobile', baseSha: BASE, experienceVersion: 2 });
  command('request_attempt', { attemptId: 'supervisor', operationId: 'launch', role: 'planner', conversationId: 'native' }, system);
  command('record_dispatch', { attemptId: 'supervisor', identity: 'owned', worktree: '/tmp/s', branch: 'goal/s' }, system);
  command('supervisor_propose', { contract: contract() }, { kind: 'agent', goalId: 'g', attemptId: 'supervisor', role: 'planner', generation: 1, revision: 0 });
  command('request_attempt', { attemptId: 'review', operationId: 'review_launch', role: 'reviewer', conversationId: 'review_native' }, system);
  command('record_dispatch', { attemptId: 'review', identity: 'review_owned', worktree: '/tmp/r', branch: 'goal/r' }, system);
  command('record_review', { attemptId: 'review', reviewId: 'r1', review: { schemaVersion: 1, target: planTarget(store.get('g')), disposition: 'accept', findings: [] } }, system);
  command('record_stopped', { attemptId: 'supervisor' }, system);
  assert.equal(goalView(store.get('g')).decision.reason, 'Let active workers finish and reconcile uncertain ownership before recovery', 'the reviewer still owns a worker');
  command('record_stopped', { attemptId: 'review' }, system);
  const held = goalView(store.get('g')).decision;
  assert.equal(held.state, 'The goal is on hold.');
  assert.equal(held.reason, 'planner did not finish successfully.');
  assert.equal(held.primary.label, 'Recover goal');
  command('recover_goal', held.primary.payload);
  const recovered = goalView(store.get('g'));
  assert.equal(recovered.decision.state, 'Your plan is ready to approve.');
  assert.equal(recovered.decision.primary.label, `Approve revision ${recovered.revision}`);
  command('pause_goal', {});
  const paused = goalView(store.get('g')).decision;
  assert.equal(paused.state, 'Your plan is ready to approve.', 'approval outranks the paused state');
  command('approve', recovered.decision.primary.payload);
  command('resume_goal', {}); command('pause_goal', {});
  assert.deepEqual(goalView(store.get('g')).decision, { state: 'Paused.', reason: 'Your messages stay queued.', primary: { type: 'resume_goal', label: 'Resume goal', payload: {} } });
});

test('clarification questions, failed tasks and uncertain attempts become the state', () => {
  const f = fixture();
  f.goal.clarification = { question: 'Which module first?' };
  assert.deepEqual(decisionView(f.goal), { state: 'Which module first?', reason: null, primary: null });
  const failed = fixture(); failed.approve();
  failed.goal.tasks[0].status = 'failed';
  assert.equal(decisionView(failed.goal).state, 'A task needs a retry.');
  assert.equal(primary(failed.goal), 'retry_task');
  const unknown = fixture(); unknown.approve(); unknown.request('a', 'implementer', 'A'); unknown.dispatch('a');
  unknown.goal.attempts.at(-1).workerState = 'unknown';
  assert.deepEqual(decisionView(unknown.goal), { state: 'Agent ownership needs reconciliation.', reason: null, primary: null });
});
