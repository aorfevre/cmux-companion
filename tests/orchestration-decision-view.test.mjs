import assert from 'node:assert/strict';
import test from 'node:test';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { decisionView, HOLD_TRANSLATIONS, REFUSAL_TRANSLATIONS } from '../server/orchestration/domain/decision-view.mjs';
import { goalView } from '../server/orchestration/domain/state-view.mjs';
import { transition, planTarget } from '../server/orchestration/domain/transitions.mjs';
import { fixture, contract, BASE, HEAD_A, HEAD_B } from './helpers/orchestration/domain-fixture.mjs';

const primary = goal => decisionView(goal).primary?.type ?? null;
/** Compare the three decision fields the bar renders; the list fields are asserted in their own tests. */
const core = ({ state, reason, primary }) => ({ state, reason, primary });

test('startup failure, approval, delivery and abort pick the first offered primary', () => {
  const created = transition(null, { id: 'create', goalId: 'goal', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'Fix', baseBranch: 'main' } }, { kind: 'user' }).goal;
  const failed = transition(created, { id: 'fail', goalId: 'goal', expectedVersion: created.version, type: 'fail_startup', payload: { error: 'Repository is owned by another service.' } }, { kind: 'system' }).goal;
  assert.deepEqual(core(decisionView(failed)), { state: 'Repository is owned by another service.', reason: null, primary: { type: 'retry_startup', label: 'Retry startup', payload: {} } });
  const ready = fixture();
  ready.command('publish_contract', { contract: contract() }, ready.user);
  assert.deepEqual(core(decisionView(ready.goal)), { state: 'Your plan waits on a blocker.', reason: 'Independent plan review must accept this revision', primary: null });
  ready.request('plan_review', 'reviewer'); ready.dispatch('plan_review'); ready.review('plan_review', planTarget(ready.goal));
  assert.equal(decisionView(ready.goal).state, 'Your plan is ready to approve.');
  assert.equal(decisionView(ready.goal).primary.label, 'Approve revision 1');
  const delivered = fixture(); delivered.deliver();
  assert.equal(decisionView(delivered.goal).state, 'Pull request published. Waiting for merge.');
  assert.equal(primary(delivered.goal), 'request_review_fix', 'addressing review comments stays one click away after delivery');
  delivered.goal.mergeSync = { checkedAt: 1, state: 'closed', error: null };
  assert.deepEqual(core(decisionView(delivered.goal)), { state: 'The pull request was closed without merging.', reason: 'Review it on GitHub.', primary: null }, 'a closed PR offers no review fix, so the bar explains instead of pretending');
  delivered.goal.mergeSync = null;
  delivered.command('request_review_fix', {}, delivered.user);
  delivered.goal.reviewRound.state = 'unknown';
  assert.deepEqual(core(decisionView(delivered.goal)), { state: 'The fix push outcome is uncertain.', reason: 'Companion is confirming the remote branch.', primary: null });
  delivered.goal.reviewRound.state = 'fixing';
  delivered.command('abort', {}, delivered.user);
  assert.deepEqual(core(decisionView(delivered.goal)), { state: 'Aborted. Evidence is retained.', reason: null, primary: null });
});

test('the publication gate is a primary, and progress has none', () => {
  const f = fixture();
  const single = contract(); single.tasks = [single.tasks[0]]; f.approve(single);
  assert.deepEqual(core(decisionView(f.goal)), { state: 'Work continues automatically. No action needed.', reason: null, primary: null });
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
  assert.deepEqual(core(decisionView(f.goal)), { state: 'The goal is on hold.', reason: 'Workers are still running. Recovery opens when they stop.', primary: null });
  assert.equal(decisionView(f.goal).detail, 'Let active workers finish and reconcile uncertain ownership before recovery');
  f.command('record_stopped', { attemptId: 'planner' });
  const stopped = decisionView(f.goal);
  assert.equal(stopped.reason, 'The planner stopped before it finished. Recover to run it again.');
  assert.equal(stopped.detail, 'planner did not finish successfully.');
  assert.equal(stopped.primary.label, 'Recover goal');
  assert.equal(stopped.primary.payload.mode, undefined);
  f.recover();
  assert.deepEqual(core(decisionView(f.goal)), { state: 'Work continues automatically. No action needed.', reason: null, primary: null });
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
  assert.equal(goalView(store.get('g')).decision.reason, 'Workers are still running. Recovery opens when they stop.', 'the reviewer still owns a worker');
  command('record_stopped', { attemptId: 'review' }, system);
  const held = goalView(store.get('g')).decision;
  assert.equal(held.state, 'The goal is on hold.');
  assert.equal(held.reason, 'The supervisor stopped before it finished. Recover to run it again.');
  assert.equal(held.detail, 'planner did not finish successfully.');
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
  assert.deepEqual(core(goalView(store.get('g')).decision), { state: 'Paused.', reason: 'Your messages stay queued.', primary: { type: 'resume_goal', label: 'Resume goal', payload: {} } });
});

test('clarification questions, failed tasks and uncertain attempts become the state', () => {
  const f = fixture();
  f.goal.clarification = { question: 'Which module first?' };
  assert.deepEqual(core(decisionView(f.goal)), { state: 'Which module first?', reason: null, primary: null });
  const failed = fixture(); failed.approve();
  failed.goal.tasks[0].status = 'failed';
  assert.equal(decisionView(failed.goal).state, 'A task needs a retry.');
  assert.equal(primary(failed.goal), 'retry_task');
  const unknown = fixture(); unknown.approve(); unknown.request('a', 'implementer', 'A'); unknown.dispatch('a');
  unknown.goal.attempts.at(-1).workerState = 'unknown';
  assert.deepEqual(core(decisionView(unknown.goal)), { state: 'Agent ownership needs reconciliation.', reason: null, primary: null });
});

test('hold reasons are translated with a hint and keep the raw detail', () => {
  const f = fixture(); f.request('planner', 'planner'); f.dispatch('planner');
  f.command('record_failure', { attemptId: 'planner', uncertain: true, error: 'Lost connection' });
  assert.equal(decisionView(f.goal).reason, 'Workers are still running. Recovery opens when they stop.');
  f.command('record_stopped', { attemptId: 'planner' });
  const d = decisionView(f.goal);
  assert.equal(d.reason, 'The planner stopped before it finished. Recover to run it again.');
  assert.equal(d.detail, 'planner did not finish successfully.');
  assert.equal(d.stage, 'On hold');
  assert.equal(d.rank, 0);
  assert.equal(d.next, null);
});

test('a blocking plan review refuses recovery and offers a revision with the findings as context', () => {
  const f = fixture(); f.command('publish_contract', { contract: contract() }, f.user);
  f.request('plan_review', 'reviewer'); f.dispatch('plan_review'); f.review('plan_review', planTarget(f.goal), true);
  const d = decisionView(f.goal);
  assert.equal(d.primary, null);
  assert.equal(d.reason, 'A plan revision is required before recovery.');
  assert.equal(d.detail, 'Request a plan revision to address the blocking review');
  assert.deepEqual(d.next, { type: 'request_revision', label: 'Request revision', context: 'high: Incorrect value. Return the required value' });
  assert.equal(d.rank, 0);
});

test('a clarification offers the answer form as the next step', () => {
  const asked = fixture(); asked.goal.clarification = { question: 'Which module first?' };
  const d = decisionView(asked.goal);
  assert.deepEqual(d.next, { type: 'answer_clarification', label: 'Answer question' });
  assert.equal(d.rank, 0);
  asked.goal.clarification.answer = 'A';
  assert.equal(decisionView(asked.goal).next, null);
  const stopped = fixture(); stopped.goal.clarification = { question: 'Historical question' }; stopped.goal.status = 'aborted';
  assert.equal(decisionView(stopped.goal).state, 'Aborted. Evidence is retained.', 'a stopped goal never shows a stale question');
});

test('ranks and stages order decisions, active work, delivered, merged and aborted', () => {
  const approved = fixture(); approved.approve();
  assert.equal(decisionView(approved.goal).rank, 1);
  assert.equal(decisionView(approved.goal).stage, 'In progress');
  const delivered = fixture(); delivered.deliver();
  assert.equal(decisionView(delivered.goal).rank, 2, 'a PR waiting on GitHub is not a decision even though a review fix stays offered');
  assert.equal(decisionView(delivered.goal).primary?.type, 'request_review_fix');
  assert.equal(decisionView(delivered.goal).stage, 'Waiting for merge');
  delivered.goal.mergeSync = { checkedAt: 1, state: 'open', error: null, mergeable: 'conflicting' };
  assert.equal(decisionView(delivered.goal).rank, 0, 'a conflicting PR is a decision');
  assert.equal(decisionView(delivered.goal).state, 'The pull request conflicts with its target branch.');
  assert.equal(decisionView(delivered.goal).reason, 'A fix round starts automatically at the next merge check.');
  delivered.goal.mergeSync = { checkedAt: 1, state: 'closed', error: null };
  assert.equal(decisionView(delivered.goal).rank, 2, 'a closed PR offers nothing to decide');
  delivered.goal.mergeSync = { checkedAt: 1, state: 'merged', error: null };
  const merged = { ...delivered.goal, status: 'merged' };
  assert.equal(decisionView(merged).rank, 3); assert.equal(decisionView(merged).stage, 'Complete');
  const aborted = { ...delivered.goal, status: 'aborted' };
  assert.equal(decisionView(aborted).rank, 4); assert.equal(decisionView(aborted).stage, 'Aborted');
});

test('every hold kind and recovery refusal has a translation', () => {
  for (const kind of ['attempt', 'review', 'integration', 'verification', 'publication', 'review_fix']) assert.equal(typeof HOLD_TRANSLATIONS[kind], 'function', kind);
  for (const message of ['Let active workers finish and reconcile uncertain ownership before recovery', 'Request a plan revision to address the blocking review', 'Wait for submitted results to settle before recovery', 'Confirm the fix push outcome before recovery', 'The failure hold changed']) assert.equal(typeof REFUSAL_TRANSLATIONS[message], 'string', message);
});

test('a held conversational goal whose recovery is refused offers the supervisor composer as the next step', t => {
  const store = new OrchestrationStore({ path: ':memory:' }); t.after(() => store.close());
  let next = 0; const user = { kind: 'user' }, system = { kind: 'system' };
  const command = (type, payload = {}, authority = user) => store.apply({ id: `n${++next}`, goalId: 'g', expectedVersion: store.get('g')?.version ?? 0, type, payload }, authority);
  command('create_goal', { repositoryId: 'repo', title: 'Held', baseSha: BASE, experienceVersion: 2 });
  command('request_attempt', { attemptId: 'supervisor', operationId: 'launch', role: 'planner', conversationId: 'native' }, system);
  command('record_dispatch', { attemptId: 'supervisor', identity: 'owned', worktree: '/tmp/s', branch: 'goal/s' }, system);
  command('supervisor_propose', { contract: contract() }, { kind: 'agent', goalId: 'g', attemptId: 'supervisor', role: 'planner', generation: 1, revision: 0 });
  command('request_attempt', { attemptId: 'review', operationId: 'review_launch', role: 'reviewer', conversationId: 'review_native' }, system);
  command('record_dispatch', { attemptId: 'review', identity: 'review_owned', worktree: '/tmp/r', branch: 'goal/r' }, system);
  command('record_stopped', { attemptId: 'supervisor' }, system);
  const d = goalView(store.get('g')).decision;
  assert.equal(d.primary, null);
  assert.deepEqual(d.next, { type: 'send_goal_message', label: 'Message supervisor' });
  assert.equal(d.rank, 0);
});
