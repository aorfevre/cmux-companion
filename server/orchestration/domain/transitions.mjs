import { DomainError, identifier, integer, object, requireValue, sha, text, array } from './contracts.mjs';
import { parseContract, readyTasks } from './graph.mjs';
import { acceptedReview, currentReviews, parseReview } from './review.mjs';
import { parseRoleResult } from './role-result.mjs';

/** @typedef {import('../types.d.ts').Goal} Goal */
/** @typedef {import('../types.d.ts').Attempt} Attempt */
/** @typedef {import('../types.d.ts').Authority} Authority */
/** @typedef {import('../types.d.ts').Command} Command */
/** @typedef {import('../types.d.ts').Transition} Transition */
/** Worker ownership outlives result submission and unsuccessful termination. @param {Attempt} attempt */
export const ownsWorker = (attempt) => attempt.workerState !== 'stopped';
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
      repositoryId: identifier(input.repositoryId), title: text(input.title, 500),
      status: 'discovering', revision: 0, approvedRevision: null, contracts: [], tasks: [],
      attempts: [], reviews: [], integrationHead: sha(input.baseSha), verification: null,
      finalRepairCount: 0, finalRepairLimit: 2, pr: null, integration: null, publication: null,
    });
    return { goal, events: [{ kind: 'goal_created', payload: { repositoryId: goal.repositoryId } }], intents: [] };
  }
  requireValue(before && before.id === command.goalId, 'Goal not found', 'NOT_FOUND');
  validateAuthority(before, authority);
  requireValue(before.version === command.expectedVersion, 'Goal version changed', 'VERSION_CONFLICT');
  requireValue(!['aborted', 'merged'].includes(before.status) || ['record_stopped', 'record_dispatch', 'record_provision', 'record_pr', 'receive_role_result', 'reject_role_result'].includes(command.type), 'Goal is terminal', 'TERMINAL_GOAL');
  const goal = structuredClone(before);
  /** @type {Transition} */
  const result = { goal, events: [], intents: [] };
  /** @param {string} kind @param {import('../types.d.ts').Json} [payload] */
  const emit = (kind, payload = {}) => result.events.push({ kind, payload });
  /** @param {import('../types.d.ts').Intent['kind']} kind @param {string} id @param {string | null} attemptId @param {import('../types.d.ts').Json} payload */
  const intent = (kind, id, attemptId, payload) => result.intents.push({ id, kind, goalId: goal.id, generation: goal.generation, revision: goal.revision, attemptId, payload });
  switch (command.type) {
    case 'receive_role_result': {
      requireAuthority(authority, 'system');
      const attempt = goal.attempts.find((entry) => entry.id === input.attemptId);
      requireValue(attempt, 'Result attempt is unknown', 'NOT_FOUND');
      const id = identifier(input.resultId), artifactId = text(input.artifactId, 64);
      requireValue(/^[a-f0-9]{64}$/.test(artifactId), 'Invalid result artifact');
      goal.results ??= [];
      requireValue(!goal.results.some((entry) => entry.id === id), 'Result id already exists', 'IDEMPOTENCY_CONFLICT');
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
      if (parsed.role === 'planner') { type = 'publish_contract'; payload = parsed.output; }
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
    case 'reject_role_result': {
      requireAuthority(authority, 'system');
      const submission = goal.results?.find((entry) => entry.id === input.resultId);
      requireValue(submission?.status === 'pending', 'Result is not pending', 'STALE_ATTEMPT');
      submission.status = 'rejected'; submission.code = identifier(input.code);
      const attempt = goal.attempts.find((entry) => entry.id === submission.attemptId);
      if (attempt && attempt.generation === goal.generation && attempt.revision === goal.revision && ['queued', 'running', 'uncertain'].includes(attempt.status)) {
        attempt.status = 'failed'; attempt.error = 'Agent result was rejected; inspect the saved evidence';
        if (attempt.role === 'implementer' && attempt.taskId) {
          const task = taskById(goal, attempt.taskId); if (task.status === 'running') task.status = 'failed';
        }
      }
      emit('agent_result_rejected', { resultId: submission.id, attemptId: submission.attemptId, artifactId: submission.artifactId, code: submission.code }); break;
    }
    case 'request_revision': {
      requireAuthority(authority, 'user');
      requireValue(goal.status !== 'delivered', 'Delivered goals require a new goal', 'INVALID_STATE');
      requireValue(!goal.integration && !goal.publication, 'Reconcile the external operation before revising', 'OWNERSHIP_UNCERTAIN');
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
      requireValue(!goal.integration && !goal.publication, 'Reconcile the external operation before revising', 'OWNERSHIP_UNCERTAIN');
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
      requireAuthority(authority, 'system');
      const id = identifier(input.attemptId), operationId = identifier(input.operationId);
      requireValue(!goal.attempts.some((entry) => entry.id === id || entry.operationId === operationId), 'Duplicate attempt');
      requireValue(['planner', 'implementer', 'reviewer', 'integrator'].includes(String(input.role)), 'Unknown role');
      const role = /** @type {Attempt['role']} */ (input.role);
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
      requireValue(!goal.attempts.some((attempt) => ownsWorker(attempt) && attempt.role === role && (role === 'integrator' || (attempt.taskId === taskId && (role === 'implementer' || attempt.target === target)))), 'Attempt already active', 'ALREADY_RUNNING');
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
      const task = taskById(goal, operation.taskId);
      requireValue(task.status === 'accepted' && task.candidateSha === operation.candidateSha, 'Accepted candidate changed');
      goal.integrationHead = sha(input.headSha); goal.verification = null; goal.integration = null;
      task.status = 'integrated'; task.integratedSha = goal.integrationHead; emit('task_integrated', { taskId: task.id, headSha: goal.integrationHead }); break;
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
        const task = taskById(goal, attempt.taskId); task.status = 'integrated'; task.integratedSha = head; goal.integration = null;
      }
      goal.integrationHead = head; goal.verification = null; attempt.status = 'succeeded';
      emit('integration_repaired', { headSha: head, attemptId: attempt.id }); break;
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
      requireValue(goal.status === 'building' && goal.verification?.headSha === goal.integrationHead && goal.verification.checks.every((check) => check.passed) && acceptedReview(goal, goal.integrationHead, 'integration'), 'Final evidence is missing or stale', 'NOT_READY');
      requireValue(!goal.attempts.some(ownsWorker), 'Workers still active', 'NOT_READY');
      goal.publication = { operationId: identifier(input.operationId), headSha: goal.integrationHead, generation: goal.generation, revision: goal.revision };
      goal.status = 'ready_to_publish'; intent('publish', goal.publication.operationId, null, { headSha: goal.integrationHead }); emit('publication_requested', { headSha: goal.integrationHead }); break;
    }
    case 'record_pr': {
      requireAuthority(authority, 'system');
      requireValue(['ready_to_publish', 'aborted'].includes(goal.status) && goal.publication && input.operationId === goal.publication.operationId, 'Publication operation was not requested', 'STALE_OPERATION');
      requireValue(input.headSha === goal.integrationHead, 'PR head does not match verified head', 'STALE_TARGET');
      const url = text(input.url, 2000); requireValue(/^https:\/\/[^\s]+$/.test(url), 'Invalid PR URL');
      goal.pr = { number: integer(input.number, 1), url, headSha: goal.integrationHead };
      if (goal.status !== 'aborted') goal.status = 'delivered'; emit('pr_observed', { number: goal.pr.number, headSha: goal.integrationHead }); break;
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
