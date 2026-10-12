import { text, requireValue } from './contracts.mjs';
import { appendMessage } from './conversation.mjs';

const transient = new Set(['PROVIDER_SPAWN_EAGAIN', 'PROVIDER_SPAWN_EMFILE', 'PROVIDER_SPAWN_ENFILE', 'PROVIDER_SPAWN_ENOMEM']);
/** Preserve failed launch evidence and admit at most one automatic replacement
 * for a role/task/target. Only adapter-proven pre-process failures qualify.
 * @param {import('../types.d.ts').Goal} goal @param {import('../types.d.ts').Attempt} attempt
 * @param {unknown} value @param {string} commandId */
export function recordLaunchFailure(goal, attempt, value, commandId) {
  const code = text(value, 80);
  requireValue(/^PROVIDER_SPAWN_(EAGAIN|EMFILE|ENFILE|ENOMEM|ENOENT|EACCES|EPERM|ENOEXEC|FAILED)$/.test(code)
    && attempt.workerState === 'stopped' && attempt.status === 'failed', 'Launch failure requires stopped pre-process evidence');
  const prior = goal.attempts.filter(entry => entry.id !== attempt.id && entry.generation === attempt.generation
    && entry.revision === attempt.revision && entry.role === attempt.role && entry.taskId === attempt.taskId
    && entry.target === attempt.target && entry.launchFailure).length;
  const scheduled = goal.experienceVersion === 2 && transient.has(code) && prior < 1 && !goal.hold
    && attempt.generation === goal.generation && attempt.revision === goal.revision
    && !['aborted', 'merged', 'delivered'].includes(goal.status)
    && !goal.attempts.some(entry => entry.workerState === 'unknown')
    && !goal.results?.some(result => result.attemptId === attempt.id && result.status === 'pending');
  attempt.launchFailure = { code, retry: Math.min(prior + (scheduled ? 1 : 0), 1), limit: 1, scheduled };
  if (!scheduled) {
    if (goal.experienceVersion === 2 && transient.has(code) && prior >= 1) {
      attempt.error = `${attempt.error} Automatic launch retry budget exhausted (1 of 1).`;
      appendMessage(goal, commandId, 'service', 'decision', `${attempt.role} could not start again. Automatic launch retry budget exhausted (1 of 1); review the saved failure before retrying.`);
    }
    return;
  }
  attempt.retryRequested = true;
  const task = goal.tasks.find(task => task.id === attempt.taskId);
  if (attempt.role === 'implementer' && task) {
    task.status = task.candidateSha ? 'repair_required' : 'pending';
    if (task.candidateSha) task.repairCount = Math.max(0, task.repairCount - 1);
  }
  if (attempt.role === 'integrator') {
    if (task) task.repairCount = Math.max(0, task.repairCount - 1);
    else goal.finalRepairCount = Math.max(0, goal.finalRepairCount - 1);
  }
  appendMessage(goal, commandId, 'service', 'progress', `${attempt.role} could not start (${code.replace('PROVIDER_SPAWN_', '')}). Automatic launch retry 1 of 1 is queued; no provider process started.`);
}
