import { DomainError, identifier, integer, object, requireValue, sha, text, array, branchName } from './contracts.mjs';
import { projectCode, shortGoalTitle, planningName } from './goal-presentation.mjs';
import { parseContract, readyTasks } from './graph.mjs';
import { acceptedReview, currentReviews, parseReview } from './review.mjs';
import { parseRoleResult, requireResultCapacity } from './role-result.mjs';

/** @typedef {import('../types.d.ts').Goal} Goal */
/** @typedef {import('../types.d.ts').Attempt} Attempt */
/** @typedef {import('../types.d.ts').Authority} Authority */
/** @typedef {import('../types.d.ts').Command} Command */
/** @typedef {import('../types.d.ts').Transition} Transition */
/** Worker ownership outlives result submission and unsuccessful termination. @param {Attempt} attempt */
export const ownsWorker = (attempt) => attempt.workerState !== 'stopped';
/** A stopped repair worker can still own unsettled result evidence. @param {Goal} goal */
export const hasPendingRepairResult = (goal) => Boolean(goal.results?.some((result) => result.status === 'pending'
  && goal.attempts.some((attempt) => attempt.id === result.attemptId && attempt.role === 'integrator'
    && attempt.generation === goal.generation && attempt.revision === goal.revision)));
/** @param {Goal} goal */
export const planTarget = (goal) => `contract:${goal.generation}:${goal.revision}`;
/** @param {Goal} goal */
export function currentContract(goal) {
  const found = goal.contracts.find((entry) => entry.revision === goal.revision);
  requireValue(found, 'No current contract', 'INVALID_STATE');
  return found.contract;
}
/** @param {Goal} goal @param {unknown} id */
function taskById(goal, id) {
  const task = goal.tasks.find((entry) => entry.id === id);
  requireValue(task, 'Unknown task'); return task;
}
/** @param {Goal} goal @param {unknown} id */
function attemptById(goal, id) {
  const attempt = goal.attempts.find((entry) => entry.id === id);
  requireValue(attempt && attempt.generation === goal.generation && attempt.revision === goal.revision, 'Attempt was replaced', 'STALE_ATTEMPT');
  return attempt;
}
/** @param {Authority} authority @param {'user' | 'system'} kind */
function requireAuthority(authority, kind) { requireValue(authority.kind === kind, `${kind} authority required`, 'FORBIDDEN'); }
/** @param {Goal} goal @param {Authority} authority @param {boolean} [allowReceipt] */
export function validateAuthority(goal, authority, allowReceipt = false) {
  if (authority.kind !== 'agent') return;
  requireValue(authority.goalId === goal.id && authority.generation === goal.generation && authority.revision === goal.revision && !['aborted', 'merged'].includes(goal.status), 'Agent authority was revoked', 'FORBIDDEN');
  const attempt = attemptById(goal, authority.attemptId);
  requireValue(attempt.role === authority.role && (attempt.status === 'running' || (allowReceipt && attempt.status === 'succeeded')), 'Agent attempt is not active', 'FORBIDDEN');
}
/** @param {Authority} authority @param {Attempt} attempt */
function ownsResult(authority, attempt) {
  requireValue(authority.kind === 'system' || (authority.kind === 'agent' && authority.attemptId === attempt.id && authority.role === attempt.role), 'Another attempt owns this result', 'FORBIDDEN');
  requireValue(attempt.status === 'running', 'Attempt is not running', 'STALE_ATTEMPT');
}

/** Pure aggregate decision. Persistence adds timestamps and atomic receipts.
 * @param {Goal | null} before @param {Command} command @param {Authority} authority @returns {Transition}
 */
export function transition(before, command, authority) {
  identifier(command.id); identifier(command.goalId); integer(command.expectedVersion);
  const input = object(command.payload);
  if (command.type === 'create_goal') {
    requireAuthority(authority, 'user');
    requireValue(!before && command.expectedVersion === 0, 'Goal already exists', 'VERSION_CONFLICT');
    const goal = /** @type {Goal} */ ({ id: command.goalId, version: 1, generation: 1,
      repositoryId: identifier(input.repositoryId), title: input.description === undefined ? text(input.title, 500) : shortGoalTitle(text(input.description, 12000)),
      ...(input.description === undefined ? {} : { description: text(input.description, 12000), projectCode: projectCode(input.projectCode ?? input.repositoryId),
        plannerName: planningName(projectCode(input.projectCode ?? input.repositoryId), shortGoalTitle(text(input.description, 12000))) }), baseSha: input.baseSha === undefined ? '' : sha(input.baseSha), ...(input.baseSha === undefined ? { startup: { status: 'pending', error: null } } : {}), baseBranch: branchName(input.baseBranch ?? 'main'),
      status: 'discovering', revision: 0, approvedRevision: null, contracts: [], tasks: [],
      attempts: [], reviews: [], integrationHead: input.baseSha === undefined ? '' : sha(input.baseSha), verification: null,
      finalRepairCount: 0, finalRepairLimit: 2, pr: null, integration: null, publication: null,
    });
    return { goal, events: [{ kind: 'goal_created', payload: { repositoryId: goal.repositoryId } }], intents: [] };
  }
  requireValue(before && before.id === command.goalId, 'Goal not found', 'NOT_FOUND');
  validateAuthority(before, authority);
  requireValue(before.version === command.expectedVersion, 'Goal version changed', 'VERSION_CONFLICT');
  requireValue(!['aborted', 'merged'].includes(before.status) || ['record_stopped', 'record_dispatch', 'record_provision', 'record_pr', 'record_publication_observation', 'record_integration', 'record_integration_conflict', 'record_integration_failure', 'cancel_integration', 'settle_repair_result', 'cancel_repair_result', 'record_verification_result', 'cancel_verification', 'verification_uncertain', 'receive_role_result', 'reject_role_result'].includes(command.type), 'Goal is terminal', 'TERMINAL_GOAL');
  requireValue(!before.startup || before.startup.status === 'ready' || ['record_startup', 'fail_startup', 'retry_startup', 'rename_goal', 'abort'].includes(command.type), 'Fetch the goal base before planning', 'NOT_READY');
  const goal = structuredClone(before);
  /** @type {Transition} */
  const result = { goal, events: [], intents: [] };
  /** @param {string} kind @param {import('../types.d.ts').Json} [payload] */
  const emit = (kind, payload = {}) => result.events.push({ kind, payload });
  /** @param {import('../types.d.ts').Intent['kind']} kind @param {string} id @param {string | null} attemptId @param {import('../types.d.ts').Json} payload */
  const intent = (kind, id, attemptId, payload) => result.intents.push({ id, kind, goalId: goal.id, generation: goal.generation, revision: goal.revision, attemptId, payload });
  switch (command.type) {
    case 'rename_goal': {
      requireAuthority(authority, 'user');
      goal.description ??= goal.title;
      goal.title = text(input.title, 120); emit('goal_renamed'); break;
    }
    case 'request_clarification': {
      requireValue(authority.kind === 'agent' && authority.role === 'planner' && goal.status === 'discovering', 'Only the active planner can ask a question', 'FORBIDDEN');
      requireValue(!goal.clarification || goal.clarification.answer !== undefined, 'A question is already waiting for an answer', 'NOT_READY');
      goal.clarification = { question: text(input.question, 4000) };
      for (const attempt of goal.attempts.filter(ownsWorker)) {
        if (attempt.identity) intent('terminate', `${command.id}_${attempt.id}`, attempt.id, { identity: attempt.identity });
        if (attempt.workerState === 'pending') attempt.workerState = 'unknown';
      }
      goal.generation++; emit('clarification_requested'); break;
    }
    case 'answer_clarification': {
      requireAuthority(authority, 'user');
      requireValue(goal.status === 'discovering' && goal.clarification && goal.clarification.answer === undefined, 'No question is waiting for an answer', 'NOT_READY');
      goal.clarification.answer = text(input.answer, 8000);
      const previous = goal.planningRequest?.message;
      goal.planningRequest = { message: [previous, `Question: ${goal.clarification.question}\nAnswer: ${goal.clarification.answer}`].filter(Boolean).join('\n\n').slice(-24000), basedOnRevision: goal.revision };
      emit('clarification_answered'); break;
    }
    case 'record_startup': {
      requireAuthority(authority, 'system');
      requireValue(goal.startup?.status === 'pending' && goal.attempts.length === 0, 'Goal base is already pinned', 'NOT_READY');
      goal.baseSha = sha(input.baseSha); goal.integrationHead = goal.baseSha;
      goal.startup = { status: 'ready', error: null };
      emit('goal_base_pinned', { baseSha: goal.baseSha, baseBranch: goal.baseBranch }); break;
    }
    case 'fail_startup': {
      requireAuthority(authority, 'system');
      requireValue(goal.startup?.status === 'pending', 'Goal startup is not pending', 'NOT_READY');
      goal.startup = { status: 'failed', error: text(input.error, 500) };
      emit('goal_startup_failed', { error: goal.startup.error }); break;
    }
    case 'retry_startup': {
      requireAuthority(authority, 'user');
      requireValue(goal.startup?.status === 'failed' && goal.attempts.length === 0, 'Goal startup is not awaiting retry', 'NOT_READY');
      goal.startup = { status: 'pending', error: null }; emit('goal_startup_retried'); break;
    }
    case 'receive_role_result': {
      requireAuthority(authority, 'system');
      const attempt = goal.attempts.find((entry) => entry.id === input.attemptId);
      requireValue(attempt, 'Result attempt is unknown', 'NOT_FOUND');
      const id = identifier(input.resultId), artifactId = text(input.artifactId, 64);
      requireValue(/^[a-f0-9]{64}$/.test(artifactId), 'Invalid result artifact');
      goal.results ??= [];
      requireValue(!goal.results.some((entry) => entry.id === id), 'Result id already exists', 'IDEMPOTENCY_CONFLICT');
      requireResultCapacity(goal.results, attempt.id);
      requireValue(!goal.results.some((entry) => entry.attemptId === attempt.id && entry.repair), 'Repair result already owns this attempt', 'IDEMPOTENCY_CONFLICT');
      goal.results.push({ id, attemptId: attempt.id, artifactId, status: 'pending', code: null });
      emit('agent_result_received', { resultId: id, attemptId: attempt.id, artifactId }); break;
    }
    case 'accept_role_result': {
      requireValue(authority.kind === 'agent', 'Scoped result authority required', 'FORBIDDEN');
      const submission = goal.results?.find((entry) => entry.id === input.resultId);
      requireValue(submission?.status === 'pending' && submission.attemptId === authority.attemptId, 'Result is not pending for this attempt', 'STALE_ATTEMPT');
      const attempt = attemptById(goal, submission.attemptId);
      const parsed = parseRoleResult(input.result, { goalId: goal.id, attempt });
      let type, payload;
      if (parsed.role === 'planner') { type = 'question' in parsed.output ? 'request_clarification' : 'publish_contract'; payload = parsed.output; }
      else if (parsed.role === 'reviewer') { type = 'record_review'; payload = { attemptId: attempt.id, reviewId: command.id, review: parsed.output }; }
      else throw new DomainError('UNSUPPORTED_CAPABILITY', 'Repository evidence verification is unavailable');
      const accepted = transition(before, { ...command, type, payload }, authority);
      const saved = accepted.goal.results?.find((entry) => entry.id === submission.id);
      requireValue(saved, 'Result reference disappeared'); saved.status = 'accepted';
      accepted.events.push({ kind: 'agent_result_accepted', payload: { resultId: saved.id, attemptId: saved.attemptId, artifactId: saved.artifactId } });
      return accepted;
    }
    case 'accept_candidate_result': {
      requireAuthority(authority, 'system');
      const submission = goal.results?.find((entry) => entry.id === input.resultId);
      requireValue(submission?.status === 'pending', 'Candidate result is not pending', 'STALE_ATTEMPT');
      const attempt = attemptById(goal, submission.attemptId);
      const parsed = parseRoleResult(input.result, { goalId: goal.id, attempt });
      requireValue(parsed.role === 'implementer', 'Candidate result must belong to an implementer', 'FORBIDDEN');
      const proofArtifactId = text(input.proofArtifactId, 64);
      requireValue(/^[a-f0-9]{64}$/.test(proofArtifactId), 'Invalid candidate proof artifact');
      const accepted = transition(before, { ...command, type: 'confirm_candidate', payload: { attemptId: attempt.id, headSha: parsed.output.headSha } }, authority);
      const saved = accepted.goal.results?.find((entry) => entry.id === submission.id);
      requireValue(saved, 'Result reference disappeared'); saved.status = 'accepted'; saved.proofArtifactId = proofArtifactId;
      accepted.events.push({ kind: 'agent_result_accepted', payload: { resultId: saved.id, attemptId: saved.attemptId, artifactId: saved.artifactId, proofArtifactId } });
      return accepted;
    }
    case 'prepare_repair_result': {
      requireAuthority(authority, 'system');
      const submission = goal.results?.find((entry) => entry.id === input.resultId);
      requireValue(submission?.status === 'pending' && !submission.repair, 'Repair result is not pending', 'STALE_ATTEMPT');
      const attempt = attemptById(goal, submission.attemptId); ownsResult(authority, attempt);
      const parsed = parseRoleResult(input.result, { goalId: goal.id, attempt });
      requireValue(parsed.role === 'integrator' && goal.status === 'building' && goal.approvedRevision === goal.revision, 'Integration repair is not approved', 'FORBIDDEN');
      requireValue(goal.integrationHead === attempt.target && parsed.output.headSha !== attempt.target, 'Repair target changed', 'STALE_TARGET');
      if (attempt.taskId) {
        requireValue(goal.integration?.state === 'conflict' && goal.integration.taskId === attempt.taskId && goal.integration.operationId === parsed.output.operationId, 'Conflict target changed', 'STALE_TARGET');
      } else {
        requireValue(parsed.output.operationId === null && !goal.integration && goal.tasks.every((task) => task.status === 'integrated') && !goal.verificationRuns?.some((run) => run.workerState !== 'stopped'), 'Final repair target is not available', 'STALE_TARGET');
        goal.integration = { operationId: identifier(input.effectId), taskId: null, expectedHead: goal.integrationHead, candidateSha: parsed.output.headSha, baseSha: attempt.baseSha, state: 'repairing' };
      }
      const proofArtifactId = text(input.proofArtifactId, 64);
      requireValue(/^[a-f0-9]{64}$/.test(proofArtifactId), 'Invalid repair proof artifact');
      submission.proofArtifactId = proofArtifactId;
      submission.repair = { effectId: identifier(input.effectId), integrationOperationId: goal.integration.operationId, headSha: parsed.output.headSha };
      goal.integration.state = 'repairing';
      intent('integrate_repair', submission.repair.effectId, attempt.id, { resultId: submission.id });
      emit('repair_result_prepared', { resultId: submission.id, effectId: submission.repair.effectId, proofArtifactId }); break;
    }
    case 'settle_repair_result': {
      requireAuthority(authority, 'system');
      const submission = goal.results?.find((entry) => entry.id === input.resultId);
      requireValue(submission?.status === 'pending' && submission.repair && submission.repair.effectId === input.effectId, 'Repair effect changed', 'STALE_OPERATION');
      const attempt = goal.attempts.find((entry) => entry.id === submission.attemptId);
      requireValue(attempt, 'Repair attempt disappeared');
      const change = transition(before, { ...command, type: 'record_integration', payload: { operationId: submission.repair.integrationOperationId, headSha: sha(input.headSha) } }, authority);
      const saved = change.goal.results?.find((entry) => entry.id === submission.id);
      const worker = change.goal.attempts.find((entry) => entry.id === attempt.id);
      requireValue(saved && worker, 'Repair receipt disappeared');
      const current = attempt.generation === goal.generation && attempt.revision === goal.revision && goal.status === 'building';
      saved.status = current ? 'accepted' : 'rejected'; saved.code = current ? null : 'STALE_ATTEMPT';
      if (current) worker.status = 'succeeded';
      else if (worker.workerState === 'stopped' && ['running', 'uncertain'].includes(worker.status)) worker.status = 'cancelled';
      change.events.push({ kind: current ? 'agent_result_accepted' : 'agent_result_rejected', payload: { resultId: saved.id, attemptId: worker.id, artifactId: saved.artifactId, effectId: submission.repair.effectId, headSha: change.goal.integrationHead } });
      return change;
    }
    case 'cancel_repair_result': {
      requireAuthority(authority, 'system');
      const submission = goal.results?.find((entry) => entry.id === input.resultId);
      requireValue(submission?.status === 'pending' && submission.repair && submission.repair.effectId === input.effectId, 'Repair effect changed', 'STALE_OPERATION');
      submission.status = 'rejected'; submission.code = identifier(input.code);
      const attempt = goal.attempts.find((entry) => entry.id === submission.attemptId);
      if (attempt && ['running', 'uncertain'].includes(attempt.status)) attempt.status = goal.status === 'aborted' ? 'cancelled' : 'failed';
      if (goal.integration?.operationId === submission.repair.integrationOperationId) goal.integration.state = 'failed';
      emit('agent_result_rejected', { resultId: submission.id, attemptId: submission.attemptId, artifactId: submission.artifactId, code: submission.code }); break;
    }
    case 'reject_role_result': {
      requireAuthority(authority, 'system');
      const submission = goal.results?.find((entry) => entry.id === input.resultId);
      requireValue(submission?.status === 'pending' && !submission.repair, 'Result is not pending or owns an external effect', 'STALE_ATTEMPT');
      submission.status = 'rejected'; submission.code = identifier(input.code);
      const attempt = goal.attempts.find((entry) => entry.id === submission.attemptId);
      if (attempt && !goal.results?.some((entry) => entry.id !== submission.id && entry.attemptId === attempt.id && entry.repair) && attempt.generation === goal.generation && attempt.revision === goal.revision && ['queued', 'running', 'uncertain'].includes(attempt.status)) {
        attempt.status = 'failed'; attempt.error = 'Agent result was rejected; inspect the saved evidence';
        if (attempt.role === 'implementer' && attempt.taskId) {
          const task = taskById(goal, attempt.taskId); if (task.status === 'running') task.status = 'failed';
        }
      }
      emit('agent_result_rejected', { resultId: submission.id, attemptId: submission.attemptId, artifactId: submission.artifactId, code: submission.code }); break;
    }
    case 'request_revision': {
      requireAuthority(authority, 'user');
      requireValue(!goal.clarification || goal.clarification.answer !== undefined, 'Answer the pending planner question first', 'NOT_READY');
      requireValue(goal.status !== 'delivered', 'Delivered goals require a new goal', 'INVALID_STATE');
      requireValue(!goal.integration && (!goal.publication || !goal.publication.approval), 'Reconcile the external operation before revising', 'OWNERSHIP_UNCERTAIN');
      const message = text(input.message, 8000);
      for (const attempt of goal.attempts.filter(ownsWorker)) {
        if (attempt.identity) intent('terminate', `${command.id}_${attempt.id}`, attempt.id, { identity: attempt.identity });
        if (attempt.workerState === 'pending') attempt.workerState = 'unknown';
      }
      goal.generation++; goal.approvedRevision = null; goal.status = 'discovering';
      goal.planningRequest = { message, basedOnRevision: goal.revision };
      goal.verification = null; goal.integration = null; goal.publication = null;
      emit('revision_requested', { basedOnRevision: goal.revision }); break;
    }
    case 'publish_contract': {
      requireValue(authority.kind === 'user' || (authority.kind === 'agent' && authority.role === 'planner'), 'Planner or user authority required', 'FORBIDDEN');
      requireValue(goal.status !== 'delivered', 'Delivered goals require a new goal', 'INVALID_STATE');
      requireValue(!goal.integration && (!goal.publication || !goal.publication.approval), 'Reconcile the external operation before revising', 'OWNERSHIP_UNCERTAIN');
      requireValue(!goal.clarification || goal.clarification.answer !== undefined, 'Answer the pending planner question first', 'NOT_READY');
      const contract = parseContract(input.contract);
      for (const attempt of goal.attempts.filter(ownsWorker)) {
        if (attempt.identity) intent('terminate', `${command.id}_${attempt.id}`, attempt.id, { identity: attempt.identity });
        // Revocation is immediate; uncertain physical termination still consumes capacity.
        if (attempt.workerState === 'pending') attempt.workerState = 'unknown';
      }
      goal.generation++; goal.revision++; goal.approvedRevision = null;
      goal.contracts.push({ revision: goal.revision, contract });
      goal.tasks = contract.tasks.map((task) => ({ ...task, status: 'pending', candidateSha: null, candidateBase: null, integratedSha: null, repairCount: 0, repairLimit: 2 }));
      goal.status = 'awaiting_approval'; goal.verification = null; goal.integration = null; goal.publication = null;
      goal.finalRepairCount = 0; goal.finalRepairLimit = 2;
      emit('contract_published', { revision: goal.revision }); break;
    }
    case 'approve': {
      requireAuthority(authority, 'user');
      requireValue(goal.status === 'awaiting_approval' && integer(input.revision, 1) === goal.revision, 'Approval target changed', 'STALE_TARGET');
      requireValue(acceptedReview(goal, planTarget(goal), 'plan'), 'Independent plan review must accept this revision', 'REVIEW_REQUIRED');
      requireValue(!goal.attempts.some((attempt) => attempt.generation !== goal.generation && ownsWorker(attempt)), 'Replaced workers need reconciliation', 'OWNERSHIP_UNCERTAIN');
      goal.approvedRevision = goal.revision; goal.status = 'building'; emit('goal_approved', { revision: goal.revision }); break;
    }
    case 'request_attempt': {
      requireValue(!goal.startup || goal.startup.status === 'ready', 'Fetch the goal base before planning', 'NOT_READY');
      requireAuthority(authority, 'system');
      const id = identifier(input.attemptId), operationId = identifier(input.operationId);
      requireValue(!goal.attempts.some((entry) => entry.id === id || entry.operationId === operationId), 'Duplicate attempt');
      requireValue(['planner', 'implementer', 'reviewer', 'integrator'].includes(String(input.role)), 'Unknown role');
      const role = /** @type {Attempt['role']} */ (input.role);
      requireValue(role !== 'planner' || !goal.clarification || goal.clarification.answer !== undefined, 'Answer the pending planner question first', 'NOT_READY');
      const mode = role === 'planner' ? 'interactive' : 'background';
      let target = planTarget(goal), taskId = null;
      if (role === 'planner') requireValue(goal.status === 'discovering' || goal.status === 'awaiting_approval', 'Planning is not available');
      if (role === 'implementer') {
        const task = taskById(goal, input.taskId);
        requireValue(readyTasks(goal).some((entry) => entry.id === task.id), 'Task dependencies or repair budget block dispatch', 'NOT_READY');
        if (task.status === 'repair_required') task.repairCount++;
        task.status = 'running'; taskId = task.id; target = goal.integrationHead;
      }
      if (role === 'integrator') {
        requireValue(!hasPendingRepairResult(goal), 'Previous repair result is not settled', 'NOT_READY');
        requireValue(!goal.verificationRuns?.some((run) => run.workerState !== 'stopped'), 'Verification worker is not settled', 'NOT_READY');
        requireValue(goal.status === 'building' && goal.approvedRevision === goal.revision, 'Integration is not approved', 'NOT_READY');
        if (goal.integration?.state === 'conflict') {
          taskId = goal.integration.taskId;
          const task = taskById(goal, taskId);
          requireValue(task.repairCount < task.repairLimit, 'Conflict repair budget exhausted', 'NOT_READY');
          task.repairCount++;
        } else {
          requireValue(!goal.integration && goal.tasks.every((task) => task.status === 'integrated'), 'Final repair is not ready', 'NOT_READY');
          const rejected = currentReviews(goal).filter((review) => review.kind === 'integration' && review.target === goal.integrationHead).at(-1);
          const failedChecks = goal.verification?.headSha === goal.integrationHead && goal.verification.checks.some((check) => !check.passed);
          requireValue((rejected?.disposition === 'request_changes' || failedChecks) && goal.finalRepairCount < goal.finalRepairLimit, 'Final repair requires findings or failed checks and budget', 'NOT_READY');
          goal.finalRepairCount++;
        }
        target = goal.integrationHead;
      }
      if (role === 'reviewer') {
        if (input.taskId) {
          const task = taskById(goal, input.taskId);
          requireValue(goal.status === 'building' && task.status === 'in_review' && task.candidateSha, 'No reviewable candidate', 'NOT_READY');
          taskId = task.id; target = task.candidateSha;
        } else if (goal.status === 'building') {
          requireValue(goal.tasks.every((task) => task.status === 'integrated'), 'Integration is incomplete', 'NOT_READY');
          target = goal.integrationHead;
        } else requireValue(goal.status === 'awaiting_approval', 'No reviewable contract', 'NOT_READY');
      }
      requireValue(!goal.attempts.some((attempt) => ownsWorker(attempt) && attempt.role === role && (role === 'integrator' || (attempt.taskId === taskId && (role === 'implementer' || role === 'planner' || attempt.target === target)))), 'Attempt already active', 'ALREADY_RUNNING');
      if (role === 'planner' || role === 'reviewer') {
        const previous = goal.attempts.filter((attempt) => attempt.generation === goal.generation && attempt.revision === goal.revision && attempt.role === role && attempt.taskId === taskId && attempt.target === target).at(-1);
        requireValue(!previous || previous.retryRequested, 'Explicit retry is required for this attempt', 'RETRY_REQUIRED');
      }
      const conversationId = identifier(input.conversationId);
      requireValue(!goal.attempts.some((attempt) => attempt.conversationId === conversationId), 'Independent attempts require fresh conversation identities');
      /** @type {Attempt} */
      const attempt = { id, operationId, role, mode, taskId, target, generation: goal.generation, revision: goal.revision, status: 'queued', workerState: 'pending', identity: null, baseSha: role === 'reviewer' && !target.startsWith('contract:') ? target : goal.integrationHead, worktree: null, branch: null, conversationId, error: null };
      goal.attempts.push(attempt); intent('launch', operationId, id, { role, mode, target, taskId }); emit('attempt_queued', { attemptId: id, role }); break;
    }
    case 'resume_planner': {
      requireAuthority(authority, 'user');
      const attempt = attemptById(goal, input.attemptId);
      requireValue(attempt.role === 'planner' && attempt.mode === 'interactive' && attempt.status === 'running' && attempt.workerState === 'running' && attempt.identity
        && ['discovering', 'awaiting_approval'].includes(goal.status), 'No current owned planner conversation', 'NOT_READY');
      intent('resume', command.id, attempt.id, { identity: attempt.identity });
      emit('planner_resume_requested', { attemptId: attempt.id }); break;
    }
    case 'record_resume': {
      requireAuthority(authority, 'system');
      const attempt = attemptById(goal, input.attemptId);
      requireValue(attempt.role === 'planner' && attempt.status === 'running', 'Planner resume target changed', 'STALE_ATTEMPT');
      attempt.error = input.code === null ? null : text(input.code, 100);
      attempt.lastResume = { id: identifier(input.resumeId), code: attempt.error };
      emit(input.code === null ? 'planner_resumed' : 'planner_resume_failed', { attemptId: attempt.id, code: attempt.error }); break;
    }
    case 'record_provision': {
      requireAuthority(authority, 'system'); const attempt = goal.attempts.find((entry) => entry.id === input.attemptId);
      requireValue(attempt && attempt.status === 'queued' && ['pending', 'unknown'].includes(attempt.workerState) && input.baseSha === attempt.baseSha, 'Provisioning target changed', 'STALE_ATTEMPT');
      const worktree = text(input.worktree, 2000), branch = text(input.branch, 500);
      requireValue(!attempt.worktree || (attempt.worktree === worktree && attempt.branch === branch), 'Attempt checkout changed', 'STALE_TARGET');
      attempt.worktree = worktree; attempt.branch = branch; emit('attempt_provisioned', { attemptId: attempt.id }); break;
    }
    case 'record_dispatch': {
      requireAuthority(authority, 'system');
      const attempt = goal.attempts.find((entry) => entry.id === input.attemptId);
      requireValue(attempt && (attempt.status === 'queued' || attempt.status === 'uncertain' || (attempt.status === 'succeeded' && attempt.workerState === 'unknown')) && attempt.workerState !== 'stopped', 'Dispatch was already recorded', 'STALE_ATTEMPT');
      requireValue(!attempt.worktree || (attempt.worktree === input.worktree && attempt.branch === input.branch), 'Dispatch checkout changed', 'STALE_TARGET');
      requireValue(!attempt.identity || attempt.identity === input.identity, 'Worker identity changed', 'OWNERSHIP_UNCERTAIN');
      attempt.identity = text(input.identity, 1000); attempt.worktree = text(input.worktree, 2000); attempt.branch = text(input.branch, 500);
      if (attempt.status !== 'succeeded') attempt.status = 'running';
      attempt.workerState = 'running';
      if (attempt.generation !== goal.generation || ['aborted', 'merged'].includes(goal.status)) intent('terminate', `${command.id}_${attempt.id}`, attempt.id, { identity: attempt.identity });
      emit('attempt_running', { attemptId: attempt.id }); break;
    }
    case 'record_failure': {
      requireAuthority(authority, 'system'); const attempt = attemptById(goal, input.attemptId);
      requireValue(ownsWorker(attempt), 'Attempt already settled', 'STALE_ATTEMPT');
      requireValue(input.uncertain === true || input.confirmedStopped === true, 'Failure needs stopped-process evidence or uncertainty');
      attempt.workerState = input.uncertain === true ? 'unknown' : 'stopped';
      if (attempt.status !== 'succeeded') attempt.status = input.uncertain === true ? 'uncertain' : 'failed';
      attempt.error = text(input.error, 2000);
      if (attempt.role === 'implementer' && attempt.taskId && attempt.status === 'failed') {
        const task = taskById(goal, attempt.taskId);
        if (task.status === 'running') task.status = 'failed';
      }
      emit('attempt_failed', { attemptId: attempt.id, uncertain: attempt.status === 'uncertain' }); break;
    }
    case 'record_stopped': {
      requireAuthority(authority, 'system');
      const attempt = goal.attempts.find((entry) => entry.id === input.attemptId);
      requireValue(attempt && ownsWorker(attempt), 'No owned live attempt');
      attempt.workerState = 'stopped';
      // A verified process exit releases capacity, but pending asynchronous
      // result verification retains lifecycle eligibility until disposition.
      const pendingResult = attempt.status === 'running' && attempt.generation === goal.generation && attempt.revision === goal.revision
        && !['aborted', 'merged'].includes(goal.status) && goal.results?.some((entry) => entry.attemptId === attempt.id && entry.status === 'pending');
      if (attempt.status !== 'succeeded' && !pendingResult) attempt.status = 'cancelled';
      if (!pendingResult && attempt.generation === goal.generation && attempt.taskId && attempt.role === 'implementer') {
        const task = taskById(goal, attempt.taskId);
        if (task.status === 'running') task.status = 'failed';
      } emit('attempt_stopped', { attemptId: attempt.id }); break;
    }
    case 'confirm_candidate': {
      // This command is internal: the service verifies Git evidence before issuing it.
      requireAuthority(authority, 'system'); const attempt = attemptById(goal, input.attemptId);
      ownsResult(authority, attempt); requireValue(attempt.role === 'implementer' && attempt.taskId, 'Not an implementer');
      const task = taskById(goal, attempt.taskId); requireValue(task.status === 'running', 'Task is not running');
      task.candidateSha = sha(input.headSha); task.candidateBase = attempt.baseSha; task.status = 'in_review';
      attempt.status = 'succeeded'; emit('candidate_verified', { taskId: task.id, headSha: task.candidateSha }); break;
    }
    case 'record_review': {
      const attempt = attemptById(goal, input.attemptId); ownsResult(authority, attempt);
      requireValue(attempt.role === 'reviewer', 'Not a reviewer', 'FORBIDDEN');
      const review = parseReview(input.review, attempt.target);
      const kind = attempt.taskId ? 'task' : attempt.target.startsWith('contract:') ? 'plan' : 'integration';
      if (kind === 'task') {
        const task = taskById(goal, attempt.taskId);
        requireValue(task.status === 'in_review' && task.candidateSha === attempt.target, 'Candidate changed', 'STALE_TARGET');
        task.status = review.disposition === 'accept' ? 'accepted' : 'repair_required';
      } else requireValue(attempt.target === (kind === 'plan' ? planTarget(goal) : goal.integrationHead), 'Review target changed', 'STALE_TARGET');
      const id = identifier(input.reviewId);
      requireValue(!goal.reviews.some((entry) => entry.id === id), 'Duplicate review');
      goal.reviews.push({ ...review, id, attemptId: attempt.id, taskId: attempt.taskId, kind }); attempt.status = 'succeeded';
      emit('review_completed', { reviewId: id, kind, disposition: review.disposition }); break;
    }
    case 'authorize_repair': {
      requireAuthority(authority, 'user'); requireValue(goal.status === 'building', 'Goal is not building');
      if (input.taskId) {
        const task = taskById(goal, input.taskId);
        requireValue((task.status === 'repair_required' || goal.integration?.taskId === task.id) && task.repairCount >= task.repairLimit, 'Repair budget is not exhausted');
        task.repairLimit++;
      } else { requireValue(goal.finalRepairCount >= goal.finalRepairLimit, 'Final repair budget is not exhausted'); goal.finalRepairLimit++; }
      emit('repair_authorized', { taskId: input.taskId ? identifier(input.taskId) : null }); break;
    }
    case 'retry_attempt': {
      requireAuthority(authority, 'user'); const attempt = attemptById(goal, input.attemptId);
      requireValue(['planner', 'reviewer'].includes(attempt.role) && ['failed', 'cancelled'].includes(attempt.status) && !ownsWorker(attempt), 'Confirm worker termination before retrying', 'NOT_READY');
      const latest = goal.attempts.filter((entry) => entry.generation === goal.generation && entry.revision === goal.revision && entry.role === attempt.role && entry.taskId === attempt.taskId && entry.target === attempt.target).at(-1);
      const target = attempt.role === 'planner' || goal.status === 'awaiting_approval' ? planTarget(goal) : attempt.taskId ? taskById(goal, attempt.taskId).candidateSha : goal.integrationHead;
      requireValue(latest?.id === attempt.id && target === attempt.target && !attempt.retryRequested, 'Retry target changed or retry is already requested', 'STALE_TARGET');
      attempt.retryRequested = true; emit('attempt_retry_authorized', { attemptId: attempt.id }); break;
    }
    case 'retry_task': {
      requireAuthority(authority, 'user'); const task = taskById(goal, input.taskId);
      requireValue(goal.status === 'building' && task.status === 'failed', 'Task cannot be retried');
      requireValue(!goal.attempts.some((attempt) => attempt.taskId === task.id && ownsWorker(attempt)), 'Previous worker is not stopped');
      task.status = task.candidateSha ? 'repair_required' : 'pending'; emit('task_retry_requested', { taskId: task.id }); break;
    }
    case 'request_integration': {
      requireAuthority(authority, 'system');
      requireValue(goal.status === 'building' && !goal.integration && !goal.attempts.some((attempt) => attempt.role === 'integrator' && ownsWorker(attempt)), 'Integration unavailable', 'NOT_READY');
      const task = taskById(goal, input.taskId); requireValue(task.status === 'accepted' && task.candidateSha && task.candidateBase, 'Task has no accepted candidate');
      const operationId = identifier(input.operationId);
      goal.integration = { operationId, taskId: task.id, expectedHead: goal.integrationHead, candidateSha: task.candidateSha, baseSha: task.candidateBase, state: 'applying' };
      intent('integrate', operationId, null, { ...goal.integration }); emit('integration_requested', { taskId: task.id, operationId }); break;
    }
    case 'record_integration': {
      requireAuthority(authority, 'system');
      const operation = goal.integration;
      requireValue(operation && operation.operationId === input.operationId && operation.expectedHead === goal.integrationHead, 'Integration ownership changed', 'STALE_TARGET');
      const task = operation.taskId === null ? null : taskById(goal, operation.taskId);
      requireValue(task ? task.status === 'accepted' && task.candidateSha === operation.candidateSha : ['repairing', 'failed'].includes(operation.state), 'Accepted integration candidate changed');
      goal.integrationHead = sha(input.headSha); goal.verification = null; goal.integration = null;
      if (task) { task.status = 'integrated'; task.integratedSha = goal.integrationHead; }
      (goal.integrationResults ??= []).push({ operationId: operation.operationId, taskId: operation.taskId, headSha: goal.integrationHead });
      emit(task ? 'task_integrated' : 'integration_repaired', { operationId: operation.operationId, taskId: operation.taskId, headSha: goal.integrationHead }); break;
    }
    case 'record_integration_failure': {
      requireAuthority(authority, 'system');
      requireValue(goal.integration && goal.integration.operationId === input.operationId, 'Integration operation changed', 'STALE_OPERATION');
      if (goal.integration.state !== 'failed') goal.integration.failedFrom = goal.integration.state === 'repairing' ? 'repairing' : 'applying';
      goal.integration.state = 'failed'; goal.integration.code = identifier(input.code); goal.integration.retryRequested = false;
      emit('integration_failed', { operationId: goal.integration.operationId, code: identifier(input.code) }); break;
    }
    case 'retry_integration': {
      requireAuthority(authority, 'user');
      const operation = goal.integration;
      requireValue(goal.status === 'building' && operation?.state === 'failed' && operation.operationId === input.operationId && !operation.retryRequested, 'Integration retry is unavailable', 'NOT_READY');
      requireValue(!goal.attempts.some((attempt) => attempt.role === 'integrator' && ownsWorker(attempt)), 'Repair worker is not stopped', 'OWNERSHIP_UNCERTAIN');
      operation.retryRequested = true; emit('integration_retry_requested', { operationId: operation.operationId }); break;
    }
    case 'resume_integration': {
      requireAuthority(authority, 'system');
      const operation = goal.integration;
      requireValue(goal.status === 'building' && operation?.state === 'failed' && operation.operationId === input.operationId && operation.retryRequested, 'Integration retry changed', 'STALE_OPERATION');
      operation.state = operation.failedFrom ?? (goal.results?.some((result) => result.status === 'pending' && result.repair?.integrationOperationId === operation.operationId) ? 'repairing' : 'applying');
      operation.retryRequested = false; emit('integration_resumed', { operationId: operation.operationId }); break;
    }
    case 'cancel_integration': {
      requireAuthority(authority, 'system');
      requireValue(goal.integration && ['aborted', 'merged'].includes(goal.status) && goal.integration.operationId === input.operationId, 'Integration cancellation is unavailable', 'STALE_OPERATION');
      goal.integration.state = 'cancelled'; goal.integration.retryRequested = false;
      emit('integration_cancelled', { operationId: goal.integration.operationId }); break;
    }
    case 'record_integration_conflict': {
      requireAuthority(authority, 'system');
      requireValue(goal.integration && goal.integration.operationId === input.operationId && goal.integration.state === 'applying', 'Integration operation changed', 'STALE_OPERATION');
      goal.integration.state = 'conflict'; emit('integration_conflict', { operationId: goal.integration.operationId }); break;
    }
    case 'confirm_integration_repair': {
      requireAuthority(authority, 'system'); const attempt = attemptById(goal, input.attemptId);
      ownsResult(authority, attempt);
      requireValue(attempt.role === 'integrator' && attempt.target === goal.integrationHead, 'Integration repair target changed', 'STALE_TARGET');
      const head = sha(input.headSha);
      requireValue(head !== goal.integrationHead, 'Repair must produce a new commit');
      if (attempt.taskId) {
        requireValue(goal.integration?.state === 'conflict' && goal.integration.taskId === attempt.taskId && input.operationId === goal.integration.operationId, 'Conflict operation changed', 'STALE_OPERATION');
        const task = taskById(goal, attempt.taskId); task.status = 'integrated'; task.integratedSha = head;
        (goal.integrationResults ??= []).push({ operationId: goal.integration.operationId, taskId: task.id, headSha: head });
        goal.integration = null;
      }
      goal.integrationHead = head; goal.verification = null; attempt.status = 'succeeded';
      emit('integration_repaired', { headSha: head, attemptId: attempt.id }); break;
    }
    case 'request_verification': {
      requireAuthority(authority, 'system');
      requireValue(goal.status === 'building' && goal.approvedRevision === goal.revision && !goal.integration && goal.tasks.every((task) => task.status === 'integrated'), 'Verification is not ready', 'NOT_READY');
      requireValue(!goal.attempts.some((attempt) => attempt.role === 'integrator' && ownsWorker(attempt)) && !goal.verificationRuns?.some((run) => run.workerState !== 'stopped'), 'Verification ownership is occupied', 'NOT_READY');
      const previous = goal.verificationRuns?.filter((run) => run.generation === goal.generation && run.revision === goal.revision && run.headSha === goal.integrationHead).at(-1);
      requireValue(!previous || previous.retryRequested, 'Explicit verification retry required', 'RETRY_REQUIRED');
      const operationId = identifier(input.operationId);
      (goal.verificationRuns ??= []).push({ operationId, generation: goal.generation, revision: goal.revision, headSha: goal.integrationHead, status: 'pending', workerState: 'pending' });
      intent('verify', operationId, null, { headSha: goal.integrationHead, checks: currentContract(goal).verification.map((check) => ({ id: check.id, argv: check.argv })) });
      emit('verification_requested', { operationId, headSha: goal.integrationHead }); break;
    }
    case 'retry_verification': {
      requireAuthority(authority, 'user');
      const run = goal.verificationRuns?.filter((entry) => entry.generation === goal.generation && entry.revision === goal.revision && entry.headSha === goal.integrationHead).at(-1);
      requireValue(goal.status === 'building' && run?.status === 'complete' && run.result?.verification.checks.some((check) => !check.passed) && !goal.verificationRuns?.some((entry) => entry.workerState !== 'stopped'), 'Verification cannot be retried while ownership is unresolved', 'NOT_READY');
      run.retryRequested = true; goal.verification = null; emit('verification_retry_requested', { operationId: run.operationId }); break;
    }
    case 'verification_uncertain': {
      requireAuthority(authority, 'system');
      const run = goal.verificationRuns?.find((entry) => entry.operationId === input.operationId);
      requireValue(run && run.status !== 'complete' && run.status !== 'cancelled', 'Verification is already settled', 'STALE_OPERATION');
      run.status = 'uncertain'; run.workerState = 'unknown'; emit('verification_uncertain', { operationId: run.operationId }); break;
    }
    case 'cancel_verification': {
      requireAuthority(authority, 'system');
      const run = goal.verificationRuns?.find((entry) => entry.operationId === input.operationId);
      requireValue(run?.status === 'pending', 'Verification is not pending', 'STALE_OPERATION');
      run.status = 'cancelled'; run.workerState = 'stopped'; emit('verification_cancelled', { operationId: run.operationId }); break;
    }
    case 'record_verification_result': {
      requireAuthority(authority, 'system');
      const run = goal.verificationRuns?.find((entry) => entry.operationId === input.operationId);
      requireValue(run && !['complete', 'cancelled'].includes(run.status), 'Verification is already settled', 'STALE_OPERATION');
      const received = object(input.result), verification = object(received.verification);
      requireValue(verification.headSha === run.headSha && ['stopped', 'unknown'].includes(String(received.workerState)), 'Verification receipt target changed', 'STALE_TARGET');
      const artifactId = text(received.artifactId, 64); requireValue(/^[a-f0-9]{64}$/.test(artifactId), 'Invalid verification evidence');
      const checks = array(verification.checks, 30).map((entry) => { const check = object(entry); requireValue(typeof check.passed === 'boolean', 'Missing check outcome'); return { id: identifier(check.id), passed: check.passed, artifactId: identifier(check.artifactId) }; });
      const contract = goal.contracts.find((entry) => entry.revision === run.revision)?.contract;
      requireValue(contract && checks.length === contract.verification.length && new Set(checks.map((check) => check.id)).size === checks.length && contract.verification.every((check) => checks.some((entry) => entry.id === check.id)), 'Verification must report every required check');
      requireValue(received.workerState === 'stopped' || checks.some((check) => !check.passed), 'Unknown workers cannot pass verification');
      requireValue(!run.result || JSON.stringify(run.result.verification) === JSON.stringify({ headSha: run.headSha, checks }), 'Completed check evidence cannot change during observation', 'STALE_TARGET');
      run.workerState = received.workerState === 'stopped' ? 'stopped' : 'unknown'; run.status = run.workerState === 'stopped' ? 'complete' : 'uncertain';
      run.result = { verification: { headSha: run.headSha, checks }, workerState: run.workerState, artifactId };
      if (goal.status === 'building' && run.generation === goal.generation && run.revision === goal.revision && run.headSha === goal.integrationHead) goal.verification = run.result.verification;
      emit('verification_result_recorded', { operationId: run.operationId, headSha: run.headSha, artifactId, workerState: run.workerState }); break;
    }
    case 'record_verification': {
      requireAuthority(authority, 'system');
      requireValue(goal.status === 'building' && input.headSha === goal.integrationHead && goal.tasks.every((task) => task.status === 'integrated'), 'Verification target is not ready', 'STALE_TARGET');
      const checks = array(input.checks, 30).map((entry) => {
        const check = object(entry); requireValue(typeof check.passed === 'boolean', 'Missing check outcome');
        return { id: identifier(check.id), passed: check.passed, artifactId: identifier(check.artifactId) };
      });
      requireValue(new Set(checks.map((check) => check.id)).size === checks.length, 'Duplicate checks');
      const required = currentContract(goal).verification;
      requireValue(checks.length === required.length && required.every((check) => checks.some((result) => result.id === check.id)), 'Verification must report every required check');
      goal.verification = { headSha: goal.integrationHead, checks }; emit('verification_recorded', { headSha: goal.integrationHead }); break;
    }
    case 'request_publication': {
      requireAuthority(authority, 'system');
      requireValue(goal.status === 'building' && !goal.integration && goal.verification?.headSha === goal.integrationHead && goal.verification.checks.every((check) => check.passed) && acceptedReview(goal, goal.integrationHead, 'integration'), 'Final evidence is missing or stale', 'NOT_READY');
      requireValue(!goal.verificationRuns?.some((run) => run.workerState !== 'stopped') && !goal.attempts.some(ownsWorker), 'Workers still active', 'NOT_READY');
      const plan = { operationId: identifier(input.operationId), goalId: goal.id, repositoryId: goal.repositoryId, headSha: goal.integrationHead, branch: `companion-goals/${goal.id}`, baseBranch: goal.baseBranch, baseSha: goal.baseSha, marker: `<!-- companion-goal:${goal.id} -->` };
      goal.publication = { operationId: plan.operationId, headSha: goal.integrationHead, generation: goal.generation, revision: goal.revision, plan };
      goal.status = 'ready_to_publish'; emit('publication_approval_requested', { headSha: goal.integrationHead }); break;
    }
    case 'approve_publication': {
      requireAuthority(authority, 'user');
      const publication = goal.publication;
      requireValue(goal.status === 'ready_to_publish' && publication && !publication.approval
        && publication.operationId === input.operationId && publication.generation === goal.generation && publication.revision === goal.revision,
      'Publication is not awaiting this approval', 'STALE_OPERATION');
      requireValue(input.headSha === goal.integrationHead && publication.headSha === goal.integrationHead && goal.approvedRevision === goal.revision
        && !goal.integration && goal.tasks.every(task => task.status === 'integrated')
        && goal.verification?.headSha === goal.integrationHead && goal.verification.checks.every(check => check.passed)
        && acceptedReview(goal, goal.integrationHead, 'integration'), 'Publication evidence changed', 'STALE_TARGET');
      requireValue(!goal.verificationRuns?.some(run => run.workerState !== 'stopped') && !goal.attempts.some(ownsWorker), 'Workers still active', 'NOT_READY');
      publication.approval = { commandId: command.id, headSha: goal.integrationHead };
      intent('publish', publication.operationId, null, { ...publication.plan });
      emit('publication_approved', { headSha: goal.integrationHead }); break;
    }
    case 'accept_moved_target': {
      requireAuthority(authority, 'user');
      const publication = goal.publication, baseHeadSha = sha(input.baseHeadSha);
      requireValue(goal.status === 'ready_to_publish' && publication && publication.operationId === input.operationId && publication.generation === goal.generation && publication.revision === goal.revision, 'Publication is not awaiting target acceptance', 'STALE_OPERATION');
      requireValue(publication.observation?.status === 'target_moved' && publication.observation.baseHeadSha === baseHeadSha, 'The observed target changed; accept its current commit', 'STALE_TARGET');
      const previousBaseSha = publication.plan.acceptedTargets?.at(-1)?.baseHeadSha ?? publication.plan.baseSha;
      requireValue(baseHeadSha !== previousBaseSha, 'The target is already accepted', 'STALE_TARGET');
      publication.plan.acceptedTargets = [...publication.plan.acceptedTargets ?? [], { id: command.id, previousBaseSha, baseHeadSha }];
      delete publication.observation;
      emit('moved_target_accepted', { operationId: publication.operationId, previousBaseSha, baseHeadSha }); break;
    }
    case 'record_publication_observation': {
      requireAuthority(authority, 'system');
      requireValue(goal.publication && goal.publication.operationId === input.operationId, 'Publication operation changed', 'STALE_OPERATION');
      const observed = object(input.observation);
      requireValue(['pending', 'published', 'unknown', 'cancelled', 'target_moved'].includes(String(observed.status)), 'Invalid publication observation');
      const baseHeadSha = observed.baseHeadSha === null ? null : sha(observed.baseHeadSha);
      let pr = null;
      if (observed.status === 'published') {
        const received = object(observed.pr);
        requireValue(received.state === undefined || ['open', 'closed', 'merged'].includes(String(received.state)), 'Invalid observed PR state');
        pr = { number: integer(received.number, 1), url: text(received.url, 2000), headSha: sha(received.headSha), ...(received.state === undefined ? {} : { state: /** @type {'open' | 'closed' | 'merged'} */ (received.state) }) };
        requireValue(pr.headSha === goal.publication.headSha && /^https:\/\/[^\s]+$/.test(pr.url), 'Published PR identity changed', 'STALE_TARGET');
      } else requireValue(observed.pr === null, 'Unconfirmed observation cannot claim a PR');
      goal.publication.observation = { status: /** @type {import('../types.d.ts').PublicationResult['status']} */ (observed.status), baseHeadSha, pr };
      if (pr) return transition(goal, { ...command, type: 'record_pr', payload: { operationId: goal.publication.operationId, ...pr } }, authority);
      emit('publication_observed', { operationId: goal.publication.operationId, status: String(observed.status), baseHeadSha }); break;
    }
    case 'record_pr': {
      requireAuthority(authority, 'system');
      requireValue(['ready_to_publish', 'aborted'].includes(goal.status) && goal.publication?.approval && input.operationId === goal.publication.operationId, 'Publication operation was not approved', 'STALE_OPERATION');
      requireValue(input.headSha === goal.integrationHead, 'PR head does not match verified head', 'STALE_TARGET');
      const url = text(input.url, 2000); requireValue(/^https:\/\/[^\s]+$/.test(url), 'Invalid PR URL');
      goal.pr = { number: integer(input.number, 1), url, headSha: goal.integrationHead };
      if (goal.status !== 'aborted') goal.status = 'delivered'; emit('pr_observed', { number: goal.pr.number, headSha: goal.integrationHead }); break;
    }
    case 'record_merge_sync': {
      requireAuthority(authority, 'system');
      requireValue(goal.status === 'delivered' && goal.pr && input.number === goal.pr.number && input.url === goal.pr.url, 'Waiting PR identity changed', 'STALE_TARGET');
      const checkedAt = integer(input.checkedAt);
      requireValue(!goal.mergeSync || checkedAt >= goal.mergeSync.checkedAt, 'Stale merge observation', 'STALE_TARGET');
      requireValue(['open', 'closed', 'merged', 'unknown'].includes(String(input.state)), 'Invalid merge observation');
      const state = /** @type {NonNullable<import('../types.d.ts').Goal['mergeSync']>['state']} */ (input.state);
      goal.mergeSync = { checkedAt, state, error: state === 'unknown' ? 'GitHub sync unavailable. Will retry on the next scheduled check.' : null };
      if (state === 'merged') { goal.status = 'merged'; emit('pr_merged', { number: goal.pr.number }); }
      emit('merge_sync_observed', { number: goal.pr.number, checkedAt, state }); break;
    }
    case 'record_merged': {
      requireAuthority(authority, 'system'); requireValue(goal.status === 'delivered' && goal.pr, 'No delivered PR');
      goal.status = 'merged'; emit('pr_merged', { number: goal.pr.number }); break;
    }
    case 'abort': {
      requireAuthority(authority, 'user'); goal.status = 'aborted'; goal.approvedRevision = null; goal.generation++;
      for (const attempt of goal.attempts.filter(ownsWorker)) {
        if (attempt.identity) intent('terminate', `${command.id}_${attempt.id}`, attempt.id, { identity: attempt.identity });
        if (attempt.workerState === 'pending') attempt.workerState = 'unknown';
      }
      emit('goal_aborted'); break;
    }
    default: throw new DomainError('UNKNOWN_COMMAND', 'Unknown orchestration command');
  }
  goal.version++;
  return result;
}
