import { isSupervisor, ownsExecution } from './conversation.mjs';
import { requireValue } from './contracts.mjs';

/** @typedef {import('../types.d.ts').Goal} Goal */
/** @typedef {import('../types.d.ts').RecoveryEvidence} Evidence */
/** @typedef {import('../types.d.ts').RecoveryDecision['strategy']} Strategy */

/** Codes originate in adapters/domain validation, never in provider prose. */
const SETUP = new Set(['CMUX_AUTH_REJECTED', 'CMUX_SOCKET_MISSING', 'PROVIDER_SPAWN_ENOENT',
  'PROVIDER_SPAWN_EACCES', 'PROVIDER_SPAWN_EPERM', 'PROVIDER_SPAWN_ENOEXEC', 'FORBIDDEN',
  'UNSUPPORTED_CAPABILITY', 'PREPARATION_FAILED', 'NATIVE_PREPARATION_FAILED']);
const RETRY = new Set(['PROVIDER_SPAWN_EAGAIN', 'PROVIDER_SPAWN_EMFILE', 'PROVIDER_SPAWN_ENFILE',
  'PROVIDER_SPAWN_ENOMEM', 'STOPPED_WITHOUT_RESULT', 'SUPERVISOR_TURN_TIMEOUT',
  'SUPERVISOR_PROTOCOL_FAILED', 'SUPERVISOR_TURN_UNSETTLED', 'INVALID_RESULT', 'EXIT_FAILED', 'CEILING_LIMIT', 'IDLE_LIMIT', 'SIGNALLED', 'RESULT_ACCEPTED']);

/** @returns {import('../types.d.ts').RecoveryPolicy} */
export const newRecoveryPolicy = () => ({ version: 1, limit: 12, episodeLimit: 3, priorSpent: 0, decisions: [] });

/** @param {import('../types.d.ts').RecoveryPolicy} policy @param {string} key */
export const episodeSpent = (policy, key) => policy.priorSpent + policy.decisions.filter(entry => (entry.chargeKeys ?? entry.evidence.map(item => item.key)).includes(key)).length;
/** @param {Goal} goal */
const supervisorKey = goal => `${goal.approvedRevision === null ? 'planning' : `revision:${goal.approvedRevision}`}:supervisor:`;

/** Conservative adoption accounting. Unclassified history is not a fresh budget.
 * @param {Goal} goal */
export function adoptionSpending(goal) {
  const recoveries = goal.recoveries?.length ?? 0;
  const launchRetries = goal.attempts.filter(attempt => attempt.launchFailure?.scheduled).length;
  const repairs = goal.tasks.reduce((sum, task) => sum + task.repairCount, goal.finalRepairCount);
  const planRepairs = goal.planRevisionCount ?? 0;
  const workerRepairs = (goal.verificationRuns ?? []).filter(run => run.attemptId && run.result?.verification.checks.some(check => !check.passed)).length;
  const attempts = new Map();
  for (const attempt of goal.attempts) {
    const key = JSON.stringify([attempt.role, attempt.taskId, attempt.role === 'planner' && goal.experienceVersion === 2 ? 'supervisor' : [attempt.generation, attempt.revision], attempt.role === 'reviewer' ? attempt.target : null]);
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
  }
  const replacements = [...attempts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  return Math.max(recoveries, repairs + planRepairs, replacements) + launchRetries + workerRepairs;
}

/** @param {Goal} goal */
export function recoveryEvidence(goal) {
  /** @type {Evidence[]} */ const evidence = [];
  let blocker = null;
  const lineage = goal.approvedRevision === null ? 'planning' : `revision:${goal.approvedRevision}`;
  for (const reason of goal.hold?.reasons ?? []) {
    let key = '', cause = '', input = '';
    if (reason.kind === 'attempt') {
      const attempt = goal.attempts.find(entry => entry.id === reason.target);
      if (!attempt || (!(goal.experienceVersion === 2 && attempt.role === 'planner') && (attempt.generation !== goal.generation || attempt.revision !== goal.revision))) {
        blocker = 'The failed worker does not belong to the current work. Review its saved evidence.'; break;
      }
      if (attempt.workerState !== 'stopped') { blocker = 'Companion is reconciling the existing worker before recovery.'; break; }
      cause = attempt.status === 'succeeded' ? 'RESULT_ACCEPTED' : attempt.failureCode ?? attempt.launchFailure?.code
        ?? (attempt.status === 'cancelled' && !attempt.error ? 'STOPPED_WITHOUT_RESULT' : '');
      if (SETUP.has(cause)) { blocker = `Setup needs attention (${cause}). ${attempt.error ?? 'Check the configured launcher.'}`; break; }
      if (!RETRY.has(cause)) { blocker = 'The worker failure has no recognized recovery classification. Inspect its saved evidence.'; break; }
      key = `${lineage}:${goal.experienceVersion === 2 && attempt.role === 'planner' ? 'supervisor' : attempt.role}:${attempt.taskId ?? ''}`;
      input = attempt.target.startsWith('contract:') ? JSON.stringify(goal.contracts.at(-1)?.contract ?? null) : attempt.target;
    } else if (reason.kind === 'review') {
      const review = goal.reviews.find(entry => entry.id === reason.target);
      if (!review || review.disposition !== 'request_changes') { blocker = 'The held review is no longer a repairable rejection.'; break; }
      const target = review.kind === 'plan' ? `contract:${goal.generation}:${goal.revision}` : review.taskId ? goal.tasks.find(task => task.id === review.taskId)?.candidateSha : goal.integrationHead;
      if (review.target !== target) { blocker = 'The held review refers to an older target. Inspect its saved evidence.'; break; }
      key = `${lineage}:review:${review.kind}:${review.taskId ?? ''}`; cause = 'REVIEW_CHANGES';
      input = JSON.stringify([review.kind === 'plan' ? goal.contracts.at(-1)?.contract : review.target,
        review.findings.map(({ severity, title, evidence, suggestion }) => ({ severity, title, evidence, suggestion }))]);
    } else if (reason.kind === 'verification') {
      const run = goal.verificationRuns?.find(entry => entry.operationId === reason.target)
        ?? goal.verificationRuns?.filter(entry => entry.headSha === reason.target && !entry.attemptId).at(-1);
      if (!run || run.status !== 'complete' || run.workerState !== 'stopped' || run.generation !== goal.generation || run.revision !== goal.revision) {
        blocker = 'Companion needs settled check evidence before recovery.'; break;
      }
      const failed = run.result?.verification.checks.filter(check => !check.passed) ?? [];
      if (!failed.length || failed.some(check => check.id === 'prepare' || check.code !== 'EXIT_FAILED')) {
        blocker = 'Check setup or execution needs attention. Inspect the saved check output.'; break;
      }
      const attempt = goal.attempts.find(entry => entry.id === run.attemptId);
      key = `${lineage}:checks:${attempt?.taskId ?? 'integration'}`; cause = 'CHECK_FAILED';
      input = JSON.stringify([run.headSha, failed.map(check => [check.id, check.code])]);
    } else if (reason.kind === 'integration') {
      if (goal.integration?.state !== 'conflict') { blocker = 'Reconcile the failed integration before retrying it.'; break; }
      key = `${lineage}:integration:${goal.integration.taskId ?? ''}`; cause = 'INTEGRATION_CONFLICT';
      input = JSON.stringify([goal.integration.expectedHead, goal.integration.candidateSha]);
    } else { blocker = 'Confirm the external operation outcome before recovery.'; break; }
    evidence.push({ key, fingerprint: JSON.stringify([key, cause, input]), cause, target: reason.target, kind: reason.kind });
  }
  return { evidence, blocker };
}

/** Pure projection: no clock reads, model calls or side effects.
 * @param {Goal} goal */
export function recoveryStatus(goal) {
  const policy = goal.recoveryPolicy;
  if (!policy || !goal.hold || ['aborted', 'merged', 'delivered', 'addressing_review'].includes(goal.status)) return null;
  const remaining = Math.max(0, policy.limit - policy.priorSpent - policy.decisions.length);
  const pending = policy.decisions.find(entry => entry.state === 'scheduled' && entry.holdId === goal.hold?.id);
  const { evidence, blocker } = recoveryEvidence(goal);
  /** @param {'waiting' | 'blocked' | 'strategy' | 'ready' | 'scheduled'} state @param {string} reason */
  const view = (state, reason) => ({ state, reason, remaining, evidence, pending: pending ?? null });
  if (goal.conversation?.paused) return view('waiting', 'Recovery is paused.');
  if (goal.results?.some(result => result.status === 'pending') || goal.verificationRuns?.some(run => run.workerState !== 'stopped')
    || goal.attempts.some(attempt => ownsExecution(goal, attempt) && !(attempt.status === 'queued' && attempt.workerState === 'pending' && !attempt.identity)))
    return view('waiting', 'Companion is settling worker ownership and results before recovery.');
  if (goal.clarification && goal.clarification.answer === undefined) return view('blocked', goal.clarification.question);
  if (blocker) return view('blocked', blocker);
  if (!evidence.length) return view('blocked', 'No classified failure evidence is available.');
  if (pending && JSON.stringify(pending.evidence) === JSON.stringify(evidence)) return view('scheduled', 'Recovery is scheduled with the saved failure evidence.');
  if (pending) return view('ready', 'The failure evidence changed; Companion will reassess recovery.');
  if (!remaining || evidence.some(item => episodeSpent(policy, item.key) >= policy.episodeLimit))
    return view('blocked', 'The recovery budget is exhausted. Review what agents tried before authorizing more work.');
  const proposal = policy.strategy?.holdId === goal.hold.id ? policy.strategy : null;
  const supervisor = goal.attempts.find(attempt => isSupervisor(goal, attempt));
  if (episodeSpent(policy, supervisorKey(goal)) >= policy.episodeLimit
    && supervisor && supervisor.id === policy.diagnosisAttemptId && supervisor.workerState === 'stopped')
    return view('blocked', 'The recovery budget is exhausted. Supervisor diagnosis could not complete; inspect its saved failure before authorizing more work.');
  const repeated = evidence.some(item => {
    const prior = policy.decisions.filter(entry => !entry.purpose && entry.evidence.some(entry => entry.fingerprint === item.fingerprint)).slice(-2);
    const last = prior.at(-1);
    const previousStrategy = prior.length === 2 ? prior[0].strategy : item.kind === 'attempt' ? 'retry' : 'repair';
    return Boolean(last && last.strategy === previousStrategy && (!proposal || proposal.strategy === last.strategy));
  });
  if (repeated) return view('strategy', 'Repeated unchanged failure. The supervisor must select a different recovery strategy.');
  return view('ready', 'Agents can recover this failure within the approved scope.');
}

/** @param {Goal} goal @param {string} commandId @param {number} now */
export function scheduleRecovery(goal, commandId, now) {
  const status = recoveryStatus(goal), policy = goal.recoveryPolicy;
  requireValue(policy && goal.hold && status?.state === 'ready', 'Recovery is not eligible', 'NOT_READY');
  if (status.pending) { status.pending.state = 'superseded'; return; }
  const proposal = policy.strategy?.holdId === goal.hold.id ? policy.strategy : null;
  const repairs = status.evidence.some(item => item.kind !== 'attempt');
  const spent = Math.max(...status.evidence.map(item => policy.decisions.filter(entry => entry.evidence.some(prior => prior.key === item.key)).length));
  const previous = policy.decisions.filter(entry => !entry.purpose && JSON.stringify(entry.evidence.map(item => item.fingerprint)) === JSON.stringify(status.evidence.map(item => item.fingerprint))).at(-1);
  const strategy = proposal?.strategy ?? previous?.strategy ?? (repairs ? 'repair' : 'retry');
  policy.decisions.push({ id: commandId, holdId: goal.hold.id, evidence: status.evidence, strategy,
    rationale: proposal?.rationale ?? (repairs ? 'Repair the saved findings within approved scope.' : 'Retry the confirmed stopped worker using retained evidence.'),
    dueAt: now + (repairs ? 0 : [5000, 15000, 45000][Math.min(spent, 2)]), state: 'scheduled' });
  delete policy.strategy;
}

/** @param {Goal} goal @param {unknown} decisionId @param {number} now */
export function dueRecovery(goal, decisionId, now) {
  const status = recoveryStatus(goal);
  const pending = status?.pending;
  requireValue(status?.state === 'scheduled' && pending && pending.id === decisionId && pending.dueAt <= now,
    'Recovery is not due or its evidence changed', 'NOT_READY');
  return pending;
}

/** A diagnosis-only supervisor admission cannot release the failure hold or
 * start workers. It uses the same total budget and preserves normal capacity.
 * @param {Goal} goal */
export function diagnosisAdmission(goal) {
  return Boolean(goal.hold && goal.recoveryPolicy?.diagnosisHoldId === goal.hold.id && !goal.conversation?.paused
    && !goal.attempts.some(attempt => attempt.workerState === 'unknown')
    && !goal.results?.some(result => result.status === 'pending')
    && !goal.verificationRuns?.some(run => run.workerState !== 'stopped'));
}

/** @param {Goal} goal @param {string} id @param {number} now */
export function scheduleDiagnosis(goal, id, now) {
  const status = recoveryStatus(goal), policy = goal.recoveryPolicy;
  requireValue(policy && goal.hold && status && canScheduleDiagnosis(goal), 'Supervisor diagnosis cannot start', 'NOT_READY');
  const spent = episodeSpent(policy, supervisorKey(goal));
  requireValue(spent < policy.episodeLimit, 'Supervisor recovery budget exhausted', 'NOT_READY');
  policy.decisions.push({ id, holdId: goal.hold.id, evidence: status.evidence, chargeKeys: [supervisorKey(goal)], purpose: 'diagnosis', strategy: 'reconstruct',
    rationale: 'Reconstruct supervision from durable evidence to select a changed recovery strategy.', dueAt: now + [5000, 15000, 45000][Math.min(spent, 2)], state: 'scheduled' });
}

/** @param {Goal} goal */
export function canScheduleDiagnosis(goal) {
  const status = recoveryStatus(goal), policy = goal.recoveryPolicy;
  const supervisor = goal.attempts.find(attempt => isSupervisor(goal, attempt));
  const prior = policy?.decisions.some(entry => entry.purpose === 'diagnosis' && entry.holdId === goal.hold?.id);
  return Boolean(policy && status?.state === 'strategy' && (!supervisor || supervisor.workerState === 'stopped')
    && (!prior || policy.diagnosisAttemptId === supervisor?.id));
}

/** Worker-local repairs also spend the goal budget; a new worker cannot reset
 * it. The first check is verification, each rerun after a failure is repair.
 * @param {Goal} goal @param {string} id @param {import('../types.d.ts').Attempt} attempt
 * @param {NonNullable<Goal['verificationRuns']>[number] | undefined} prior */
export function reserveWorkerRepair(goal, id, attempt, prior) {
  const policy = goal.recoveryPolicy;
  const failed = prior?.result?.verification.checks.filter(check => !check.passed) ?? [];
  if (!policy || !prior || !failed.length) return;
  requireValue(failed.every(check => check.id !== 'prepare' && check.code === 'EXIT_FAILED'), 'Check setup requires attention before retrying', 'NOT_READY');
  const key = `revision:${goal.approvedRevision}:checks:${attempt.taskId ?? 'integration'}`;
  requireValue(policy.priorSpent + policy.decisions.length < policy.limit
    && episodeSpent(policy, key) < policy.episodeLimit,
  'The persisted recovery budget is exhausted', 'REPAIR_BUDGET_EXHAUSTED');
  const cause = 'CHECK_FAILED';
  const fingerprint = JSON.stringify([key, cause, JSON.stringify([prior?.headSha, failed.map(check => [check.id, check.code])])]);
  policy.decisions.push({ id, holdId: `worker:${attempt.id}`, evidence: [{ key, fingerprint, cause, target: prior.operationId, kind: 'verification' }],
    strategy: 'repair', rationale: 'Worker repaired code after an approved check failure and requested verification.', dueAt: 0, state: 'applied' });
}
