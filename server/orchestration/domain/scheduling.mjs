import { integratedWaveReady } from './waves.mjs';
import { diagnosisAdmission } from './agent-recovery.mjs';
import { readyTasks } from './graph.mjs';
import { ownsWorker, planTarget, hasPendingRepairResult } from './transitions.mjs';
import { requiresPlanReview } from './review-repairs.mjs';
import { currentReviews } from './review.mjs';
/** @typedef {{ key: string; role: import('../types.d.ts').Role; taskId: string | null; target: string }} ReadyWork */
/** Readiness is derived from accepted evidence; durable ordering is assigned by
 * the state transaction when a candidate first becomes ready.
 * @param {import('../types.d.ts').Goal} goal @returns {ReadyWork[]}
 */
export function readyWork(goal) {
  if (goal.conversation?.paused) return [];
  if (goal.hold) {
    if (!diagnosisAdmission(goal)) return [];
    const supervisor = goal.attempts.find(attempt => attempt.id === goal.conversation?.supervisorAttemptId);
    return !supervisor || (supervisor.workerState === 'stopped' && supervisor.retryRequested)
      ? [{ key: 'planner::' + planTarget(goal), role: 'planner', taskId: null, target: planTarget(goal) }] : [];
  }
  if (goal.startup && goal.startup.status !== 'ready') return [];
  if (['aborted', 'merged'].includes(goal.status)) return [];
  /** @type {ReadyWork[]} */
  const result = [];
  /** @param {ReadyWork['role']} role @param {string | null} taskId @param {string} target */
  const add = (role, taskId, target) => {
    if (role === 'integrator' && hasPendingRepairResult(goal)) return;
    const history = goal.attempts.filter((attempt) => attempt.generation === goal.generation && attempt.revision === goal.revision && attempt.role === role && attempt.taskId === taskId && attempt.target === target);
    if ((role === 'planner' || role === 'reviewer') && history.length && !history.at(-1)?.retryRequested) return;
    if (goal.attempts.some((attempt) => ownsWorker(attempt) && attempt.role === role && (role === 'integrator' || (attempt.taskId === taskId && (role === 'implementer' || role === 'planner' || attempt.target === target))))) return;
    result.push({ key: role === 'implementer' ? `${role}:${taskId}` : `${role}:${taskId ?? ''}:${target}`, role, taskId, target });
  };
  if (goal.experienceVersion === 2) {
    const supervisor = goal.attempts.find(attempt => attempt.id === goal.conversation?.supervisorAttemptId);
    if (!supervisor || (supervisor.workerState === 'stopped' && supervisor.retryRequested)) add('planner', null, planTarget(goal));
  } else if (goal.status === 'discovering' && (!goal.clarification || goal.clarification.answer !== undefined)) add('planner', null, planTarget(goal));
  if (['delivered', 'ready_to_publish'].includes(goal.status)) return result;
  if (goal.status === 'addressing_review') {
    const round = goal.reviewRound;
    if (round?.state === 'fixing' && (round.threads.length || round.conflictPaths?.length)
      && !goal.attempts.some((attempt) => attempt.role === 'review_fixer' && attempt.generation === goal.generation && attempt.revision === goal.revision && !attempt.launchFailure?.scheduled)) {
      add('review_fixer', null, round.mergeCommitSha ?? round.prHeadSha);
    }
    return result;
  }
  if (goal.status === 'awaiting_approval' && requiresPlanReview(goal)) add('reviewer', null, planTarget(goal));
  if (goal.status !== 'building' || goal.approvedRevision !== goal.revision) return result;
  if (goal.conversation && !goal.conversation.dispatchApproved) return result;
  for (const task of goal.tasks) if (task.status === 'in_review' && task.candidateSha) add('reviewer', task.id, task.candidateSha);
  for (const task of readyTasks(goal)) add('implementer', task.id, goal.integrationHead);
  if (goal.integration?.state === 'conflict') {
    const task = goal.tasks.find((task) => task.id === goal.integration?.taskId);
    if (task && task.repairCount < task.repairLimit) add('integrator', task.id, goal.integrationHead);
  } else if (integratedWaveReady(goal)) {
    const review = currentReviews(goal).filter((review) => review.kind === 'integration' && review.target === goal.integrationHead).at(-1);
    const failedCheck = goal.verification?.headSha === goal.integrationHead && goal.verification.checks.some((check) => !check.passed);
    if (review?.disposition === 'request_changes' || failedCheck) {
      if (!goal.verificationRuns?.some((run) => run.workerState !== 'stopped') && goal.finalRepairCount < goal.finalRepairLimit) add('integrator', null, goal.integrationHead);
    } else if (goal.tasks.every(task => task.status === 'integrated')) add('reviewer', null, goal.integrationHead);
  }
  return result;
}
