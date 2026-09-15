import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, contract, BASE, HEAD_A } from './helpers/orchestration/domain-fixture.mjs';
import { revisablePlan, repairableReviews } from '../server/orchestration/domain/review-repairs.mjs';
import { planTarget, transition } from '../server/orchestration/domain/transitions.mjs';
import { readyWork } from '../server/orchestration/domain/scheduling.mjs';

function rejected(kind) {
  const f = fixture();
  if (kind === 'plan') {
    f.command('publish_contract', { contract: contract() }, f.user);
    f.request('rejected', 'reviewer'); f.dispatch('rejected'); f.review('rejected', planTarget(f.goal), true);
  } else {
    f.approve();
    if (kind === 'task') {
      f.request('impl', 'implementer', 'A'); f.dispatch('impl');
      f.command('confirm_candidate', { attemptId: 'impl', headSha: HEAD_A });
      f.command('record_stopped', { attemptId: 'impl' });
      f.request('rejected', 'reviewer', 'A');
    } else {
      f.goal.tasks.forEach(task => { task.status = 'integrated'; task.integratedSha = BASE; });
      f.request('rejected', 'reviewer');
    }
    f.dispatch('rejected'); f.review('rejected', kind === 'task' ? HEAD_A : BASE, true);
  }
  return f;
}
for (const kind of ['task', 'integration']) test(`${kind} rejection authorizes bounded repair without increasing its budget`, () => {
  const f = rejected(kind), before = structuredClone(f.goal);
  assert.equal(repairableReviews(f.goal), true);
  assert.throws(() => f.command('repair_review_findings', { holdId: f.goal.hold.id }, f.user), { code: 'FORBIDDEN' });
  f.command('repair_review_findings', { holdId: f.goal.hold.id });
  assert.equal(f.goal.hold, null);
  assert.equal(f.goal.finalRepairLimit, before.finalRepairLimit);
  assert.deepEqual(f.goal.tasks.map(task => task.repairLimit), before.tasks.map(task => task.repairLimit));
  assert.ok(readyWork(f.goal).some(work => work.role === (kind === 'task' ? 'implementer' : 'integrator')));
  f.request('repair', kind === 'task' ? 'implementer' : 'integrator', kind === 'task' ? 'A' : null);
  assert.equal(kind === 'task' ? f.goal.tasks[0].repairCount : f.goal.finalRepairCount, 1);
});
const changes = {
  terminal: goal => { goal.status = 'aborted'; },
  unrelatedHold: goal => { goal.hold.reasons.push({ kind: 'attempt', target: 'other', message: 'Execution failed' }); },
  liveWorker: goal => { goal.attempts[0].workerState = 'running'; },
  unknownWorker: goal => { goal.attempts[0].workerState = 'unknown'; },
  pendingResult: goal => { goal.results = [{ status: 'pending' }]; },
  verificationOwner: goal => { goal.verificationRuns = [{ workerState: 'unknown' }]; },
  staleReview: goal => { goal.reviews.at(-1).target = 'stale'; },
  emptyHold: goal => { goal.hold.reasons = []; },
};
for (const kind of ['plan', 'task', 'integration']) for (const [name, change] of Object.entries(changes)) test(`${kind} repair refuses ${name}`, () => {
  const f = rejected(kind); change(f.goal);
  assert.equal(kind === 'plan' ? Boolean(revisablePlan(f.goal)) : repairableReviews(f.goal), false);
});
for (const kind of ['plan', 'task', 'integration']) test(`${kind} repair refuses exhausted budget`, () => {
  const f = rejected(kind);
  f.goal.planRevisionCount = 2; f.goal.finalRepairCount = 2; f.goal.tasks.forEach(task => { task.repairCount = task.repairLimit; });
  assert.equal(kind === 'plan' ? Boolean(revisablePlan(f.goal)) : repairableReviews(f.goal), false);
});
test('plan revision rejects replaced review ids and leaves the held journal unchanged', () => {
  const f = rejected('plan'), before = structuredClone(f.goal);
  assert.throws(() => transition(f.goal, { id: 'auto', goalId: f.goal.id, expectedVersion: f.goal.version,
    type: 'revise_rejected_plan', payload: { reviewId: 'stale' } }, f.system), { code: 'NOT_READY' });
  assert.deepEqual(f.goal, before);
});
