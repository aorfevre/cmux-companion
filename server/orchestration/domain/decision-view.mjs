import { isSupervisor } from './conversation.mjs';
import { actionView } from './action-view.mjs';

/** The browser shows one state, one reason and one primary action. It derives
 * nothing else; the action projection stays the only authority over what is
 * offered, and this view only chooses which offered action leads.
 * @typedef {{ type: string; label: string; payload: Record<string, unknown> }} ProjectedAction
 * @typedef {{ state: string; reason: string | null; primary: ProjectedAction | null }} Decision */
const PRIMARY_ORDER = ['retry_startup', 'recover_goal', 'approve', 'approve_publication', 'accept_moved_target', 'request_review_fix', 'retry_task', 'retry_attempt', 'retry_integration', 'retry_verification', 'authorize_repair', 'resume_goal'];

/** @param {import('../types.d.ts').Goal} goal @param {ReturnType<typeof actionView>} [projected] @returns {Decision} */
export function decisionView(goal, projected = actionView(goal)) {
  const { actions, approvalBlocked, recoveryBlocked } = projected;
  // The plain "Recover goal" action carries only a holdId; the verification retry variant adds a mode.
  const offered = actions.filter(action => action.type !== 'recover_goal' || action.payload.mode === undefined);
  const primary = PRIMARY_ORDER.map(type => offered.find(action => action.type === type)).find(Boolean) ?? null;
  /** @param {string} state @param {string | null} [reason] @param {boolean} [keep] */
  const decision = (state, reason = null, keep = true) => ({ state, reason, primary: keep ? primary : null });
  if (goal.startup?.status === 'failed') return decision(goal.startup.error || 'Could not prepare the base branch.');
  if (goal.hold) return decision('The goal is on hold.', recoveryBlocked ?? goal.hold.reasons.map(reason => reason.message).join(' '));
  if (goal.clarification && goal.clarification.answer === undefined) return decision(goal.clarification.question, null, false);
  if (goal.status === 'awaiting_approval') return approvalBlocked ? decision('Your plan waits on a blocker.', approvalBlocked, false) : decision('Your plan is ready to approve.');
  if (goal.status === 'ready_to_publish' && !goal.publication?.approval) return decision('The verified result waits for your publication approval.');
  const current = goal.attempts.filter(attempt => isSupervisor(goal, attempt) || (attempt.generation === goal.generation && attempt.revision === goal.revision));
  const latest = new Map(current.map(attempt => [JSON.stringify([attempt.role, attempt.taskId, attempt.target]), attempt]));
  const failed = [...latest.values()].find(attempt => attempt.workerState === 'unknown' || (attempt.status === 'failed' && !attempt.launchFailure?.scheduled));
  if (failed) return decision(failed.error || (failed.workerState === 'unknown' ? 'Agent ownership needs reconciliation.' : 'An agent needs a retry.'));
  if (goal.tasks.some(task => task.status === 'failed')) return decision('A task needs a retry.');
  if (goal.conversation?.paused) return decision('Paused.', 'Your messages stay queued.');
  if (goal.status === 'merged') return decision('Merged on GitHub.', null, false);
  if (goal.status === 'aborted') return decision('Aborted. Evidence is retained.', null, false);
  if (goal.status === 'delivered') return decision('Pull request published. Waiting for merge.', goal.mergeSync?.error ?? null);
  const working = current.filter(attempt => attempt.workerState === 'running' && !isSupervisor(goal, attempt)).length;
  return decision(working ? `${working} agent${working === 1 ? '' : 's'} working.` : 'Work continues automatically. No action needed.', null, false);
}
