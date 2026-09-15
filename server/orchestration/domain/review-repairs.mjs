import { currentReviews } from './review.mjs';

export const PLAN_REVISION_LIMIT = 2;
/** Only a settled rejection of the current unapproved plan may trigger repair.
 * Unrelated failure holds and uncertain workers always require human recovery.
 * @param {import('../types.d.ts').Goal} goal */
export function revisablePlan(goal) {
  const count = goal.planRevisionCount ?? 0;
  if (!Number.isSafeInteger(count) || count < 0 || count >= PLAN_REVISION_LIMIT
    || goal.status !== 'awaiting_approval' || goal.approvedRevision !== null
    || goal.integration || goal.publication || !goal.hold
    || goal.clarification && goal.clarification.answer === undefined
    || goal.attempts.some(attempt => attempt.workerState !== 'stopped')
    || goal.results?.some(result => result.status === 'pending')
    || goal.verificationRuns?.some(run => run.workerState !== 'stopped')) return null;
  const review = currentReviews(goal).filter(entry => entry.kind === 'plan'
    && entry.target === `contract:${goal.generation}:${goal.revision}`).at(-1);
  if (!review || review.disposition !== 'request_changes' || !goal.hold.reasons.length
    || goal.hold.reasons.some(reason => reason.kind !== 'review' || reason.target !== review.id)) return null;
  return review;
}

/** Once a review has rejected a plan, repairs must be independently re-reviewed
 * even if initial plan review is now disabled. @param {import('../types.d.ts').Goal} goal */
export function requiresPlanReview(goal) {
  return goal.planReviewEnabled !== false || (goal.planRevisionCount ?? 0) > 0
    || goal.attempts.some(attempt => attempt.role === 'reviewer' && attempt.generation === goal.generation
      && attempt.revision === goal.revision && attempt.target === `contract:${goal.generation}:${goal.revision}`)
    || currentReviews(goal).some(review => review.kind === 'plan' && review.disposition === 'request_changes');
}
/** All held findings must belong to current review targets with remaining repair
 * budget. Mixed execution/check failures are never silently recovered.
 * @param {import('../types.d.ts').Goal} goal */
export function repairableReviews(goal) {
  if (goal.status !== 'building' || goal.approvedRevision !== goal.revision || !goal.hold?.reasons.length
    || goal.attempts.some(attempt => attempt.workerState !== 'stopped')
    || goal.results?.some(result => result.status === 'pending')
    || goal.verificationRuns?.some(run => run.workerState !== 'stopped')) return false;
  const reviews = currentReviews(goal);
  return goal.hold.reasons.every(reason => {
    if (reason.kind !== 'review') return false;
    const review = reviews.find(entry => entry.id === reason.target);
    if (!review || review.disposition !== 'request_changes') return false;
    if (review.kind === 'task') {
      const task = goal.tasks.find(entry => entry.id === review.taskId);
      return Boolean(task && task.candidateSha === review.target && task.status === 'repair_required'
        && task.repairCount < task.repairLimit && !goal.integration);
    }
    return review.kind === 'integration' && review.target === goal.integrationHead && !goal.integration
      && goal.finalRepairCount < goal.finalRepairLimit;
  });
}
