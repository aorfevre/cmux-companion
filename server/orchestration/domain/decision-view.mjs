import { isSupervisor } from './conversation.mjs';
import { recoveryStatus } from './agent-recovery.mjs';
import { actionView } from './action-view.mjs';

/** The browser shows one state, one plain reason, one primary action or one
 * next step, a rank for list order and a stage label. It derives nothing else;
 * the action projection stays the only authority over what is offered.
 * @typedef {{ type: string; label: string; payload: Record<string, unknown> }} ProjectedAction
 * @typedef {{ type: 'request_revision'; label: string; context: string } | { type: 'answer_clarification' | 'send_goal_message'; label: string }} NextStep
 * @typedef {{ id: string; argv: string[]; code: string; artifactId: string }} FailedCheck
 * @typedef {{ state: string; reason: string | null; detail: string | null; primary: ProjectedAction | null; next: NextStep | null; rank: 0 | 1 | 2 | 3 | 4; stage: string; outcome?: string; effect?: string; checks?: FailedCheck[] }} Decision */
const PRIMARY_ORDER = ['retry_startup', 'extend_recovery_budget', 'recover_goal', 'approve', 'accept_moved_target', 'approve_publication', 'request_review_fix', 'retry_task', 'retry_attempt', 'retry_integration', 'retry_verification', 'authorize_repair', 'resume_goal'];
/** @type {Record<string, string>} */
const ROLE_WORDS = { planner: 'planner', implementer: 'implementer', reviewer: 'reviewer', integrator: 'integrator', review_fixer: 'review fixer' };

/** Plain sentences for each hold kind. Exported so a test can prove every kind is covered.
 * @type {Record<string, (reason: { message: string; target: string }, goal: import('../types.d.ts').Goal) => string>} */
export const HOLD_TRANSLATIONS = {
  attempt: (reason, goal) => {
    const attempt = goal.attempts.find(entry => entry.id === reason.target);
    const role = !attempt ? 'agent' : isSupervisor(goal, attempt) ? 'supervisor' : attempt.role === 'reviewer' && attempt.target.startsWith('contract:') ? 'plan reviewer' : ROLE_WORDS[attempt.role] ?? attempt.role;
    return `The ${role} stopped before it finished. Recover to run it again.`;
  },
  review: (reason, goal) => goal.reviews.find(review => review.id === reason.target)?.kind === 'plan'
    ? 'The plan review asked for changes. Request a revision with your guidance.'
    : 'An independent review asked for changes. Recover to repair them.',
  integration: (_reason, goal) => goal.integration?.state === 'conflict' ? 'Combining the work hit a conflict. Recover to repair it.' : 'Combining the work failed. Recover to retry it.',
  verification: reason => reason.message.startsWith('Dependencies') ? 'Dependencies did not install on the integrated commit. Inspect the check output, then recover.' : 'Checks failed on the integrated commit. Recover to repair them.',
  publication: () => 'The pull request outcome is uncertain. Recover after you confirm it on GitHub.',
  review_fix: reason => reason.message.startsWith('The fix push outcome') ? 'The fix push outcome is uncertain. Companion is confirming the branch.' : 'Addressing review comments failed. Recover to try again.',
};
/** Plain sentences for each recovery refusal, keyed by the domain message. @type {Record<string, string>} */
export const REFUSAL_TRANSLATIONS = {
  'Let active workers finish and reconcile uncertain ownership before recovery': 'Workers are still running. Recovery opens when they stop.',
  'Request a plan revision to address the blocking review': 'A plan revision is required before recovery.',
  'Wait for submitted results to settle before recovery': "A worker's result is still being recorded. Recovery opens when it settles.",
  'Confirm the fix push outcome before recovery': 'Companion is confirming the fix push. Recovery opens when it is confirmed.',
  'The failure hold changed': 'The goal changed. Reload to see its current state.',
};

/** The list badge. Holds and pauses show where execution stopped. @param {import('../types.d.ts').Goal} goal */
function stageOf(goal) {
  if (goal.status === 'merged') return 'Complete';
  if (goal.status === 'aborted') return 'Aborted';
  if (goal.hold) return 'On hold';
  if (goal.conversation?.paused) return 'Paused';
  if (goal.status === 'addressing_review') return 'Addressing review';
  if (goal.status === 'delivered') return 'Waiting for merge';
  if (goal.status === 'ready_to_publish') return goal.publication?.approval ? 'PR delivery' : 'Ready to publish';
  if (goal.status === 'discovering') return 'Planning';
  if (goal.status === 'awaiting_approval') return 'Needs approval';
  if (goal.verificationRuns?.some(run => run.generation === goal.generation && run.revision === goal.revision && ['pending', 'uncertain'].includes(run.status))) return 'Verification';
  if (goal.tasks.length && goal.tasks.every(task => task.status === 'integrated')) return goal.reviews.some(review => review.kind === 'integration' && review.target === goal.integrationHead && review.disposition === 'accept') ? 'Verification' : 'Review';
  if (goal.tasks.some(task => task.status === 'in_review') && !goal.tasks.some(task => task.status === 'running')) return 'Review';
  return 'In progress';
}

/** A refused action is never the end: the composer step the person can still take.
 * @param {import('../types.d.ts').Goal} goal @param {ProjectedAction[]} actions @param {ProjectedAction | null} primary @returns {NextStep | null} */
function nextStep(goal, actions, primary) {
  if (primary) return null;
  /** @param {string} type */ const offered = type => actions.some(action => action.type === type);
  const blockingPlan = goal.hold?.reasons.some(reason => reason.kind === 'review' && goal.reviews.some(review => review.id === reason.target && review.kind === 'plan'));
  if (blockingPlan && offered('request_revision')) {
    const review = goal.reviews.filter(entry => entry.kind === 'plan' && entry.disposition === 'request_changes').at(-1);
    const context = (review?.findings ?? []).map(finding => `${finding.severity}: ${finding.title}. ${finding.suggestion}`).join('\n');
    return { type: 'request_revision', label: 'Request revision', context };
  }
  if (goal.clarification && goal.clarification.answer === undefined && offered('answer_clarification')) return { type: 'answer_clarification', label: 'Answer question' };
  if (goal.experienceVersion === 2 && goal.hold && offered('send_goal_message')) return { type: 'send_goal_message', label: 'Message supervisor' };
  return null;
}

/** Only evidence attached to the current hold can explain the current blocker.
 * @param {import('../types.d.ts').Goal} goal @returns {FailedCheck[]} */
function failedChecks(goal) {
  const contract = goal.contracts.find(entry => entry.revision === goal.revision)?.contract;
  const checks = new Map();
  for (const reason of goal.hold?.reasons ?? []) {
    if (reason.kind !== 'verification') continue;
    const run = goal.verificationRuns?.filter(entry => (entry.operationId === reason.target || (!entry.attemptId && entry.headSha === reason.target))
      && entry.generation === goal.generation && entry.revision === goal.revision && entry.status === 'complete' && entry.workerState === 'stopped').at(-1);
    const verification = run?.result?.verification ?? (goal.verification?.headSha === reason.target ? goal.verification : null);
    for (const check of verification?.checks ?? []) if (!check.passed) checks.set(check.artifactId, {
      id: check.id, argv: contract?.verification.find(entry => entry.id === check.id)?.argv ?? [], code: check.code ?? 'CHECK_FAILED', artifactId: check.artifactId,
    });
  }
  return [...checks.values()];
}

/** @param {import('../types.d.ts').Goal} goal @param {ProjectedAction | null} primary */
function actionEffect(goal, primary) {
  if (primary?.type === 'approve') return `Starts implementation of plan ${goal.revision}, including its scope, checks and proposed team. Creating a pull request requires a separate approval.`;
  if (primary?.type === 'approve_publication') return `Creates a pull request to ${goal.baseBranch} with the reviewed and tested code. This does not merge or deploy it.`;
  if (primary?.type === 'accept_moved_target') return `Creates a pull request to ${goal.baseBranch} using the same reviewed and tested commit, without incorporating the newer changes on ${goal.baseBranch}. This does not merge or deploy it.`;
  return undefined;
}

/** @param {import('../types.d.ts').Goal} goal @param {ReturnType<typeof actionView>} [projected] @returns {Decision} */
export function decisionView(goal, projected = actionView(goal)) {
  const { actions, approvalBlocked, recoveryBlocked } = projected;
  // The plain "Recover goal" action carries only a holdId; the verification retry variant adds a mode.
  const offered = actions.filter(action => action.type !== 'recover_goal' || action.payload.mode === undefined);
  const primary = PRIMARY_ORDER.map(type => offered.find(action => action.type === type)).find(Boolean) ?? null;
  const next = nextStep(goal, actions, primary);
  const stage = stageOf(goal);
  const outcome = goal.contracts.find(entry => entry.revision === goal.revision)?.contract.outcome;
  const checks = failedChecks(goal);
  // A delivered PR waits on GitHub, not on the person, unless it was closed or conflicts; its review fix stays offered but does not rank as a decision.
  const deliveredQuiet = goal.status === 'delivered' && goal.mergeSync?.state !== 'closed' && goal.mergeSync?.mergeable !== 'conflicting';
  const rank = /** @type {Decision['rank']} */ ((primary || next) && !deliveredQuiet ? 0 : goal.status === 'delivered' ? 2 : goal.status === 'merged' ? 3 : goal.status === 'aborted' ? 4 : 1);
  /** @param {string} state @param {string | null} [reason] @param {boolean} [keep] @param {string | null} [detail] @returns {Decision} */
  const decision = (state, reason = null, keep = true, detail = null) => ({ state, reason, detail, primary: keep ? primary : null, next: keep ? next : null, rank, stage,
    ...(outcome ? { outcome } : {}), ...(checks.length ? { checks } : {}), ...(keep && actionEffect(goal, primary) ? { effect: actionEffect(goal, primary) } : {}) });
  const unsupported = checks.filter(check => check.code === 'UNSUPPORTED_CAPABILITY' && check.argv.length);
  const fixChecks = () => unsupported.length && !(goal.clarification && goal.clarification.answer === undefined) && actions.some(action => action.type === 'request_revision') ? {
    ...decision('The verification plan needs a correction.', `Check ${unsupported.map(check => `“${check.id}”`).join(', ')} could not run. Retrying the unchanged plan will not fix its setup.`, false),
    primary: null, next: { type: /** @type {const} */ ('request_revision'), label: 'Fix verification plan',
      context: `Correct the unavailable or unsupported verification command(s), preserving the approved outcome and acceptance criteria:\n${unsupported.map(check => `${check.id}: ${JSON.stringify(check.argv)} (${check.code})`).join('\n')}\nPropose the corrected plan for review before restarting work.` },
    effect: 'Opens a revision draft with the failed command. Sending it requests a corrected plan; implementation waits for your approval.', rank: /** @type {const} */ (0),
  } : null;
  if (goal.startup?.status === 'failed') return decision(goal.startup.error || 'Could not prepare the base branch.');
  const recovery = recoveryStatus(goal);
  if (recovery) {
    const detail = `${recovery.evidence.map(entry => `${entry.cause}: ${entry.target}`).join('; ')} ${recovery.remaining} recovery actions remaining.`;
    if (recovery.state !== 'blocked') return {
      state: recovery.state === 'scheduled' ? 'Agents are recovering the goal.' : recovery.state === 'waiting' ? (goal.conversation?.paused ? 'Paused.' : 'Companion is reconciling workers.') : 'Agents are diagnosing the failure.',
      reason: recovery.reason, detail, primary: goal.conversation?.paused ? primary : null,
      next: null, rank: goal.conversation?.paused ? 0 : 1, stage: goal.conversation?.paused ? 'Paused' : 'Recovering',
    };
    return fixChecks() ?? { ...decision('The goal needs your attention.', recovery.reason, true, detail), rank: 0 };
  }
  if (goal.hold) {
    if (!recoveryBlocked && !goal.conversation?.paused) { const correction = fixChecks(); if (correction) return correction; }
    const detail = recoveryBlocked ?? goal.hold.reasons.map(reason => reason.message).join(' ');
    const reason = recoveryBlocked ? (REFUSAL_TRANSLATIONS[recoveryBlocked] ?? recoveryBlocked) : goal.hold.reasons.map(entry => HOLD_TRANSLATIONS[entry.kind]?.(entry, goal) ?? entry.message).join(' ');
    return decision('The goal is on hold.', reason, true, detail);
  }
  if (goal.clarification && goal.clarification.answer === undefined && !['merged', 'aborted'].includes(goal.status)) return decision(goal.clarification.question);
  if (goal.status === 'awaiting_approval') return approvalBlocked ? decision('Your plan waits on a blocker.', approvalBlocked, false) : decision('Your plan is ready to approve.');
  if (goal.status === 'ready_to_publish' && goal.publication?.observation?.status === 'target_moved') return decision(`${goal.baseBranch} changed after review.`, 'Publication was approved, then stopped because the target branch changed. Review the result before continuing.');
  if (goal.status === 'ready_to_publish' && !goal.publication?.approval) return decision('The verified result waits for your publication approval.');
  const current = goal.attempts.filter(attempt => isSupervisor(goal, attempt) || (attempt.generation === goal.generation && attempt.revision === goal.revision));
  const latest = new Map(current.map(attempt => [JSON.stringify([attempt.role, attempt.taskId, attempt.target]), attempt]));
  const failed = [...latest.values()].find(attempt => attempt.workerState === 'unknown' || (attempt.status === 'failed' && !attempt.launchFailure?.scheduled));
  if (failed) return decision(failed.error || (failed.workerState === 'unknown' ? 'Agent ownership needs reconciliation.' : 'An agent needs a retry.'));
  if (goal.tasks.some(task => task.status === 'failed')) return decision('A task needs a retry.');
  if (goal.conversation?.paused) return decision('Paused.', 'Your messages stay queued.');
  if (goal.status === 'merged') return decision('Merged on GitHub.', null, false);
  if (goal.status === 'aborted') return decision('Aborted. Evidence is retained.', null, false);
  if (goal.status === 'delivered' && goal.mergeSync?.state === 'closed') return decision('The pull request was closed without merging.', 'Review it on GitHub.');
  if (goal.status === 'delivered' && goal.mergeSync?.mergeable === 'conflicting') return decision('The pull request conflicts with its target branch.', 'A fix round starts automatically at the next merge check.');
  if (goal.status === 'addressing_review' && goal.reviewRound?.state === 'unknown') return decision('The fix push outcome is uncertain.', 'Companion is confirming the remote branch.', false);
  if (goal.status === 'delivered') return decision('Pull request published. Waiting for merge.', goal.mergeSync?.error ?? null);
  const working = current.filter(attempt => attempt.workerState === 'running' && !isSupervisor(goal, attempt)).length;
  return decision(working ? `${working} agent${working === 1 ? '' : 's'} working.` : 'Work continues automatically. No action needed.', null, false);
}
