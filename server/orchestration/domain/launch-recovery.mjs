import { text, requireValue } from './contracts.mjs';
import { appendMessage } from './conversation.mjs';

const transient = new Set(['PROVIDER_SPAWN_EAGAIN', 'PROVIDER_SPAWN_EMFILE', 'PROVIDER_SPAWN_ENFILE', 'PROVIDER_SPAWN_ENOMEM']);
/** cmux refused the request before creating a workspace. Never retried
 * automatically: the same socket refuses again until its owner repairs it. */
export const CMUX_REFUSALS = new Set(['CMUX_AUTH_REJECTED', 'CMUX_SOCKET_MISSING']);
const providerSpawn = /^PROVIDER_SPAWN_(EAGAIN|EMFILE|ENFILE|ENOMEM|ENOENT|EACCES|EPERM|ENOEXEC|FAILED)$/;
/** Adapter-proven failure codes for a launch that started no process. @param {unknown} code */
export const isLaunchFailure = (code) => typeof code === 'string' && (providerSpawn.test(code) || CMUX_REFUSALS.has(code));
/** Fixed operator guidance; codes are Companion's own classification. @param {string} code */
export function launchFailureMessage(code) {
  if (code === 'CMUX_AUTH_REJECTED') return `cmux refused the launch (${code}). Set the socket password in cmux → Settings → Automation, then recover the goal.`;
  if (code === 'CMUX_SOCKET_MISSING') return `cmux was not reachable (${code}). Start cmux, then recover the goal.`;
  return `Provider could not start (${code}).`;
}
/** Preserve failed launch evidence and admit at most one automatic replacement
 * for a role/task/target. Only adapter-proven pre-process failures qualify.
 * @param {import('../types.d.ts').Goal} goal @param {import('../types.d.ts').Attempt} attempt
 * @param {unknown} value @param {string} commandId */
export function recordLaunchFailure(goal, attempt, value, commandId) {
  const code = text(value, 80);
  requireValue(isLaunchFailure(code)
    && attempt.workerState === 'stopped' && attempt.status === 'failed', 'Launch failure requires stopped pre-process evidence');
  const prior = goal.attempts.filter(entry => entry.id !== attempt.id && entry.generation === attempt.generation
    && entry.revision === attempt.revision && entry.role === attempt.role && entry.taskId === attempt.taskId
    && entry.target === attempt.target && entry.launchFailure).length;
  const scheduled = !goal.recoveryPolicy && goal.experienceVersion === 2 && transient.has(code) && prior < 1 && !goal.hold
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
