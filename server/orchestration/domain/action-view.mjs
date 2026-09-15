import { validateAssignmentOverride } from './teams.mjs';
import { transition, planTarget } from './transitions.mjs';

/** The browser renders decisions from the same pure command authority. It does
 * not maintain another approval/repair/readiness state machine.
 * @param {import('../types.d.ts').Goal} goal */
export function actionView(goal) {
  /** @type {{type:string;label:string;payload:Record<string,unknown>}[]} */ const actions = [];
  /** @param {string} type @param {string} label @param {Record<string,unknown>} payload */
  const offer = (type, label, payload) => {
    try { transition(goal, { id: 'projection', goalId: goal.id, expectedVersion: goal.version, type, payload }, { kind: 'user' }); actions.push({ type, label, payload }); return null; }
    catch (error) { return error instanceof Error ? error.message : 'Action unavailable'; }
  };
  offer('rename_goal', 'Edit title', { title: goal.title.slice(0, 120) });
  offer('answer_clarification', 'Send answer', { answer: 'Your answer' });
  const approvalBlocked = offer('approve', `Approve revision ${goal.revision}`, { revision: goal.revision });
  offer('request_revision', 'Request revision', { message: 'Revision feedback' });
  offer('abort', 'Abort goal', {});
  const recoveryBlocked = goal.hold ? offer('recover_goal', 'Recover goal', { holdId: goal.hold.id }) : null;
  if (goal.hold) offer('recover_goal', 'Retry verification & resume', { holdId: goal.hold.id, mode: 'retry_verification' });
  offer('retry_startup', 'Retry startup', {});
  if (goal.publication) offer('approve_publication', 'Approve & publish PR', { operationId: goal.publication.operationId, headSha: goal.publication.headSha });
  if (goal.integration) offer('retry_integration', 'Retry integration', { operationId: goal.integration.operationId });
  offer('retry_verification', 'Retry verification', {});
  if (goal.publication?.observation?.baseHeadSha) offer('accept_moved_target', 'Publish reviewed head against moved target', { operationId: goal.publication.operationId, baseHeadSha: goal.publication.observation.baseHeadSha });
  offer('authorize_repair', 'Authorize one final repair', {});
  for (const task of goal.tasks) {
    if (task.status === 'failed') offer('retry_task', `Retry ${task.id}`, { taskId: task.id });
    if (task.repairCount >= task.repairLimit) offer('authorize_repair', `Authorize one repair for ${task.id}`, { taskId: task.id });
  }
  const current = goal.attempts.filter((entry) => entry.generation === goal.generation && entry.revision === goal.revision);
  const latest = new Map(current.map(attempt => [JSON.stringify([attempt.role, attempt.taskId, attempt.target]), attempt]));
  const taskTargets = new Map(goal.tasks.map(task => [task.id, task.candidateSha]));
  const contractTarget = planTarget(goal);
  for (const attempt of latest.values()) {
    const target = attempt.role === 'planner' || goal.status === 'awaiting_approval' ? contractTarget : attempt.taskId ? taskTargets.get(attempt.taskId) : goal.integrationHead;
    if (attempt.target !== target) continue;
    if (['planner', 'reviewer'].includes(attempt.role) && !attempt.retryRequested && ['failed', 'cancelled'].includes(attempt.status)) offer('retry_attempt', `Retry ${attempt.role}${attempt.taskId ? ` for ${attempt.taskId}` : ''}`, { attemptId: attempt.id });
    if (attempt.role === 'planner' && attempt.status === 'running') offer('resume_planner', 'Resume planning', { attemptId: attempt.id });
  }
  const teamOptions = (goal.team?.assignments ?? []).map(assignment => ({ key: assignment.key, choices: (goal.teamConfiguration?.profiles ?? []).filter(profile => profile.roles.includes(assignment.role)).map(profile => {
    let blocked = null;
    try { validateAssignmentOverride(goal, assignment.key, profile.id); }
    catch (error) { blocked = error instanceof Error ? error.message : 'Assignment unavailable'; }
    return { profileId: profile.id, blocked };
  }) }));
  return { actions, approvalBlocked, recoveryBlocked, teamOptions };
}
