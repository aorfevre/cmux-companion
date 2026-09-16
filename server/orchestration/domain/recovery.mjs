import { PLAN_REVISION_LIMIT } from './review-repairs.mjs';
import { requireValue } from './contracts.mjs';

/** @typedef {import('../types.d.ts').Goal} Goal */
/** Capture failures without letting successful siblings or reconciliation clear them.
 * @param {Goal} before @param {import('../types.d.ts').Transition} change @param {string} commandId
 */
export function captureFailureHold(before, change, commandId) {
  const goal = change.goal;
  if (['aborted', 'merged', 'delivered'].includes(goal.status) || goal.generation !== before.generation || goal.revision !== before.revision) return;
  /** @type {NonNullable<Goal['hold']>['reasons']} */ const reasons = [];
  for (const attempt of goal.attempts) {
    if (attempt.generation !== goal.generation || attempt.revision !== goal.revision) continue;
    const prior = before.attempts.find(entry => entry.id === attempt.id);
    if ((['failed', 'uncertain', 'cancelled'].includes(attempt.status) && prior?.status !== attempt.status) || (attempt.workerState === 'unknown' && prior?.workerState !== 'unknown')) {
      reasons.push({ kind: 'attempt', target: attempt.id, message: `${attempt.role}${attempt.taskId ? ` for ${attempt.taskId}` : ''} did not finish successfully.` });
    }
  }
  for (const review of goal.reviews) if (review.disposition === 'request_changes' && !before.reviews.some(entry => entry.id === review.id)) {
    reasons.push({ kind: 'review', target: review.id, message: review.kind === 'plan' && (goal.planRevisionCount ?? 0) >= PLAN_REVISION_LIMIT ? 'Automatic plan revision limit reached. Review the findings and request a revision with guidance.' : `${review.kind === 'plan' ? 'Plan' : review.taskId ? `Task ${review.taskId}` : 'Integrated outcome'} review requires changes.` });
  }
  if (goal.integration && ['conflict', 'failed'].includes(goal.integration.state) && (goal.integration.state !== before.integration?.state || goal.integration.code !== before.integration.code || (before.integration.retryRequested && !goal.integration.retryRequested))) {
    reasons.push({ kind: 'integration', target: goal.integration.operationId, message: goal.integration.state === 'conflict' ? 'Integration has a conflict.' : 'Integration failed or its outcome is uncertain.' });
  }
  if (goal.verification?.checks.some(check => !check.passed) && JSON.stringify(goal.verification) !== JSON.stringify(before.verification)) {
    const prepareFailed = goal.verification.checks.some(check => check.id === 'prepare' && !check.passed);
    reasons.push({ kind: 'verification', target: goal.verification.headSha, message: prepareFailed ? 'Dependencies did not install on the integrated head.' : 'Required verification failed on the integrated head.' });
  }
  for (const run of goal.verificationRuns ?? []) if (run.status === 'uncertain' && run.generation === goal.generation && run.revision === goal.revision && before.verificationRuns?.find(entry => entry.operationId === run.operationId)?.status !== 'uncertain') {
    reasons.push({ kind: 'verification', target: run.operationId, message: 'Verification ownership needs reconciliation.' });
  }
  if (goal.publication?.observation?.status === 'unknown' && before.publication?.observation?.status !== 'unknown') reasons.push({ kind: 'publication', target: goal.publication.operationId, message: 'Publication outcome is uncertain; reconcile before retrying.' });
  if (!reasons.length) return;
  goal.hold ??= { id: commandId, reasons: [] };
  for (const reason of reasons) if (!goal.hold.reasons.some(entry => entry.kind === reason.kind && entry.target === reason.target)) goal.hold.reasons.push(reason);
  change.events.push({ kind: 'goal_dispatch_held', payload: { holdId: goal.hold.id, reasons } });
}

/** Authorize one recovery pass over the saved failed targets. It does not erase
 * failed evidence or approve a changed plan. Queued, never-launched attempts keep
 * their identities and resume after recovery; they are never replaced.
 * @param {Goal} goal @param {unknown} holdId @param {string} commandId @param {unknown} [mode]
 */
export function recoverGoal(goal, holdId, commandId, mode = 'repair') {
  requireValue(['repair', 'retry_verification'].includes(String(mode)), 'Unknown recovery mode');
  requireValue(goal.hold && goal.hold.id === holdId, 'The failure hold changed', 'STALE_TARGET');
  requireValue(!goal.attempts.some(attempt => attempt.workerState !== 'stopped' && !(attempt.workerState === 'pending' && attempt.status === 'queued' && !attempt.identity))
    && !goal.verificationRuns?.some(run => run.workerState !== 'stopped'), 'Let active workers finish and reconcile uncertain ownership before recovery', 'OWNERSHIP_UNCERTAIN');
  requireValue(!goal.results?.some(result => result.status === 'pending' && !result.repair), 'Wait for submitted results to settle before recovery', 'NOT_READY');
  requireValue(!goal.hold.reasons.some(reason => reason.kind === 'review' && goal.reviews.some(review => review.id === reason.target && review.kind === 'plan')), 'Request a plan revision to address the blocking review', 'NOT_READY');
  if (mode === 'retry_verification') {
    const run = goal.verificationRuns?.filter(entry => entry.generation === goal.generation && entry.revision === goal.revision && entry.headSha === goal.integrationHead).at(-1);
    requireValue(run?.status === 'complete' && run.result?.verification.checks.some(check => !check.passed), 'No stopped failed verification to retry', 'NOT_READY');
    requireValue(!goal.reviews.some(review => review.kind === 'integration' && review.target === goal.integrationHead && review.disposition === 'request_changes'), 'Repair blocking review findings before retrying verification', 'NOT_READY');
    run.retryRequested = true; goal.verification = null;
  }
  const latest = new Map(goal.attempts.filter(attempt => attempt.generation === goal.generation && attempt.revision === goal.revision)
    .map(attempt => [JSON.stringify([attempt.role, attempt.taskId, attempt.target]), attempt]));
  for (const attempt of latest.values()) if (['planner', 'reviewer'].includes(attempt.role) && ['failed', 'cancelled'].includes(attempt.status)) attempt.retryRequested = true;
  for (const task of goal.tasks) {
    if (task.status === 'failed') task.status = task.candidateSha ? 'repair_required' : 'pending';
    if ((task.status === 'repair_required' || goal.integration?.taskId === task.id) && task.repairCount >= task.repairLimit) task.repairLimit++;
  }
  if (goal.integration?.state === 'failed') goal.integration.retryRequested = true;
  const finalNeedsRepair = goal.verification?.checks.some(check => !check.passed) || goal.reviews.some(review => review.kind === 'integration' && review.target === goal.integrationHead && review.disposition === 'request_changes');
  if (finalNeedsRepair && goal.finalRepairCount >= goal.finalRepairLimit) goal.finalRepairLimit++;
  if (goal.publication?.observation?.status === 'unknown') delete goal.publication.observation;
  (goal.recoveries ??= []).push({ commandId, hold: goal.hold });
  goal.hold = null;
}
