import { createHash, randomUUID } from 'node:crypto';
import { DomainError, identifier, requireValue } from './domain/contracts.mjs';
import { parseRoleResult, requireResultCapacity } from './domain/role-result.mjs';
import { currentContract } from './domain/transitions.mjs';

/** Durable result inbox in the authoritative aggregate. Raw output is written to
 * private artifacts first; accepted/rejected disposition commits with lifecycle
 * changes, so response loss cannot replay an accepted mutation after restart.
 */
export class AgentResults {
  /** @param {{ service: import('./service.mjs').OrchestrationService; artifacts: import('./storage/artifacts.mjs').ArtifactStore; id?: () => string; repositories?: Pick<import('./types.d.ts').RepositoryPort, 'candidate'> }} options */
  constructor({ service, artifacts, repositories, reviewMerges, id = randomUUID }) { this.service = service; this.store = service.store; this.artifacts = artifacts; this.id = id; this.repositories = repositories; this.reviewMerges = reviewMerges; }
  /** Receipt reconciliation is read-only and cannot revive authority. The sole
   * generation exception is a planner's own accepted publication, which advances
   * generation/revision in the same transaction as accepting that exact result.
   * Any further user revision/abort remains fenced.
   * @param {Extract<import('./types.d.ts').Authority, {kind: 'agent'}>} authority
   * @param {string} resultId @param {string} raw
   */
  receipt(authority, resultId, raw) {
    const goal = this.store.get(authority.goalId);
    const attempt = goal?.attempts.find((entry) => entry.id === authority.attemptId);
    const result = goal?.results?.find((entry) => entry.id === resultId && entry.attemptId === authority.attemptId);
    if (!goal || !attempt || !result || result.status === 'pending' || ['aborted', 'merged'].includes(goal.status)) return null;
    if (attempt.role !== authority.role || attempt.generation !== authority.generation || attempt.revision !== authority.revision) return null;
    const current = goal.generation === attempt.generation && goal.revision === attempt.revision;
    const ownPublication = attempt.role === 'planner' && result.status === 'accepted' && goal.generation === attempt.generation + 1 && goal.revision === attempt.revision + 1;
    if (createHash('sha256').update(raw).digest('hex') !== result.artifactId) return null;
    // A question revokes its planner without publishing a new revision. Only
    // that exact accepted result may be acknowledged while its question waits.
    const ownQuestion = attempt.role === 'planner' && result.status === 'accepted'
      && goal.status === 'discovering' && goal.generation === attempt.generation + 1
      && goal.revision === attempt.revision && goal.clarification?.answer === undefined
      && goal.clarification && JSON.parse(raw).output?.question === goal.clarification.question;
    return current || ownPublication || ownQuestion ? result : null;
  }
  /** Caller supplies authority authenticated by transport or bound by the trusted
   * adapter to its recorded attempt, never identity parsed from raw agent output.
   * Historical adapter observations may be archived but cannot advance state.
   * @param {Extract<import('./types.d.ts').Authority, {kind: 'agent'}>} authority
   * @param {string} resultId @param {string} raw
   */
  receive(authority, resultId, raw) {
    identifier(resultId);
    const goal = this.store.get(authority.goalId), attempt = goal?.attempts.find((entry) => entry.id === authority.attemptId);
    requireValue(authority.kind === 'agent' && goal && attempt && attempt.role === authority.role && attempt.generation === authority.generation && attempt.revision === authority.revision, 'Result authority does not match its recorded attempt', 'FORBIDDEN');
    requireValue(typeof raw === 'string', 'Result must be raw structured output');
    requireValue(Buffer.byteLength(raw) <= this.artifacts.maxBytes, 'Artifact too large');
    const digest = createHash('sha256').update(raw).digest('hex');
    const existing = goal.results?.find((entry) => entry.id === resultId);
    if (existing) {
      requireValue(existing.attemptId === attempt.id && existing.artifactId === digest, 'Result id was reused with different evidence', 'IDEMPOTENCY_CONFLICT');
      return existing;
    }
    requireResultCapacity(goal.results, attempt.id);
    const artifact = this.artifacts.put(raw);
    this.service.execute({ id: this.id(), goalId: goal.id, expectedVersion: goal.version, type: 'receive_role_result', payload: { resultId, attemptId: attempt.id, artifactId: artifact.id } }, { kind: 'system' });
    return this.store.get(goal.id)?.results?.find((entry) => entry.id === resultId);
  }
  async drain() {
    for (const snapshot of this.store.list()) for (const pending of snapshot.results?.filter((entry) => entry.status === 'pending') ?? []) {
      if (pending.repair) continue;
      const goal = this.store.get(snapshot.id); requireValue(goal, 'Result goal disappeared');
      const attempt = goal.attempts.find((entry) => entry.id === pending.attemptId); requireValue(attempt, 'Result attempt disappeared');
      const current = goal.generation === attempt.generation && goal.revision === attempt.revision && !['aborted', 'merged'].includes(goal.status);
      if (current && (attempt.status === 'queued' || attempt.status === 'uncertain')) continue;
      try {
        requireValue(current && attempt.status === 'running', 'Result attempt is no longer active', 'STALE_ATTEMPT');
        const bytes = this.artifacts.get(pending.artifactId);
        let result;
        try { result = JSON.parse(bytes.toString('utf8')); }
        catch { throw new DomainError('MALFORMED_RESULT', 'Agent result was not a JSON object'); }
        const parsed = parseRoleResult(result, { goalId: goal.id, attempt });
        if (parsed.role === 'review_fixer') {
          requireValue(this.repositories, 'Repository evidence verification is unavailable', 'UNSUPPORTED_CAPABILITY');
          requireValue(this.service.repositoryIds.has(goal.repositoryId), 'Repository is no longer allowed', 'FORBIDDEN');
          const round = goal.reviewRound;
          requireValue(round && round.attemptId === attempt.id, 'Review round changed', 'STALE_TARGET');
          // A conflicted path is Companion's own merge output, so resolving it is
          // in scope even when the contract does not own that file.
          const ownedAreas = [...new Set([...currentContract(goal).tasks.flatMap((entry) => entry.ownedAreas), ...round.conflictPaths ?? []])];
          if (parsed.output.headSha !== (round.mergeCommitSha ?? round.prHeadSha)) {
            const proof = await this.repositories.candidate({ repositoryId: goal.repositoryId, attempt, headSha: parsed.output.headSha, ownedAreas });
            requireValue(proof.headSha === parsed.output.headSha, 'Git proof targets a different fix', 'STALE_TARGET');
            this.artifacts.get(proof.artifactId);
            requireValue(this.service.repositoryIds.has(goal.repositoryId), 'Repository is no longer allowed', 'FORBIDDEN');
            // Ancestry and scope do not prove a resolution. A fixer can touch a
            // conflicted file and leave its markers, and that commit would reach
            // the pull request. Prove every recorded conflicted path is clean.
            if (round.conflictPaths?.length) {
              requireValue(this.reviewMerges?.unresolvedPaths, 'Conflict resolution evidence is unavailable', 'UNSUPPORTED_CAPABILITY');
              const unresolved = await this.reviewMerges.unresolvedPaths({ repositoryId: goal.repositoryId, headSha: parsed.output.headSha, conflictPaths: round.conflictPaths });
              requireValue(!unresolved.length, `Conflict markers remain in ${unresolved.join(', ')}`, 'UNRESOLVED_CONFLICT');
            }
          }
          this.service.execute({ id: this.id(), goalId: goal.id, expectedVersion: goal.version, type: 'accept_review_fix_result', payload: { attemptId: attempt.id, headSha: parsed.output.headSha, summary: parsed.output.summary, replies: parsed.output.replies } }, { kind: 'system' });
          const settled = this.store.get(goal.id);
          if (settled?.results?.find((entry) => entry.id === pending.id)?.status === 'pending') {
            this.service.execute({ id: this.id(), goalId: goal.id, expectedVersion: settled.version, type: 'mark_result_accepted', payload: { resultId: pending.id } }, { kind: 'system' });
          }
          continue;
        }
        if (parsed.role === 'implementer' || parsed.role === 'integrator') {
          requireValue(this.repositories, 'Repository evidence verification is unavailable', 'UNSUPPORTED_CAPABILITY');
          requireValue(this.service.repositoryIds.has(goal.repositoryId), 'Repository is no longer allowed', 'FORBIDDEN');
          const task = goal.tasks.find((entry) => entry.id === attempt.taskId);
          requireValue(task || (parsed.role === 'integrator' && attempt.taskId === null), 'Candidate task disappeared');
          const proof = await this.repositories.candidate({ repositoryId: goal.repositoryId, attempt, headSha: parsed.output.headSha, ownedAreas: task ? task.ownedAreas : [...new Set(goal.tasks.flatMap((entry) => entry.ownedAreas))] });
          requireValue(proof.headSha === parsed.output.headSha, 'Git proof targets a different candidate', 'STALE_TARGET');
          this.artifacts.get(proof.artifactId);
          requireValue(this.service.repositoryIds.has(goal.repositoryId), 'Repository is no longer allowed', 'FORBIDDEN');
          this.service.execute({ id: this.id(), goalId: goal.id, expectedVersion: goal.version, type: parsed.role === 'implementer' ? 'accept_candidate_result' : 'prepare_repair_result', payload: { resultId: pending.id, result, proofArtifactId: proof.artifactId, ...(parsed.role === 'integrator' ? { effectId: this.id() } : {}) } }, { kind: 'system' });
          continue;
        }
        this.service.execute({ id: this.id(), goalId: goal.id, expectedVersion: goal.version, type: 'accept_role_result', payload: { resultId: pending.id, result } }, { kind: 'agent', goalId: goal.id, attemptId: attempt.id, role: attempt.role, generation: attempt.generation, revision: attempt.revision });
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        // An awaited Git read can overlap another result or user command. Retry
        // from fresh state; a concurrent mutation is not an implementer failure.
        if (error.code === 'VERSION_CONFLICT') continue;
        const latest = this.store.get(goal.id); requireValue(latest, 'Result goal disappeared');
        if (latest.results?.find((entry) => entry.id === pending.id)?.status !== 'pending') continue;
        this.service.execute({ id: this.id(), goalId: latest.id, expectedVersion: latest.version, type: 'reject_role_result', payload: { resultId: pending.id, code: error.code } }, { kind: 'system' });
      }
    }
  }
}
