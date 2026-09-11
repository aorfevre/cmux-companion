import { randomUUID } from 'node:crypto';
import { DomainError, identifier, requireValue } from './domain/contracts.mjs';

/** Durable result inbox in the authoritative aggregate. Raw output is written to
 * private artifacts first; accepted/rejected disposition commits with lifecycle
 * changes, so response loss cannot replay an accepted mutation after restart.
 */
export class AgentResults {
  /** @param {{ service: import('./service.mjs').OrchestrationService; artifacts: import('./storage/artifacts.mjs').ArtifactStore; id?: () => string }} options */
  constructor({ service, artifacts, id = randomUUID }) { this.service = service; this.store = service.store; this.artifacts = artifacts; this.id = id; }
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
    const artifact = this.artifacts.put(raw);
    const existing = goal.results?.find((entry) => entry.id === resultId);
    if (existing) {
      requireValue(existing.attemptId === attempt.id && existing.artifactId === artifact.id, 'Result id was reused with different evidence', 'IDEMPOTENCY_CONFLICT');
      return existing;
    }
    this.service.execute({ id: this.id(), goalId: goal.id, expectedVersion: goal.version, type: 'receive_role_result', payload: { resultId, attemptId: attempt.id, artifactId: artifact.id } }, { kind: 'system' });
    return this.store.get(goal.id)?.results?.find((entry) => entry.id === resultId);
  }
  drain() {
    for (const snapshot of this.store.list()) for (const pending of snapshot.results?.filter((entry) => entry.status === 'pending') ?? []) {
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
        this.service.execute({ id: this.id(), goalId: goal.id, expectedVersion: goal.version, type: 'accept_role_result', payload: { resultId: pending.id, result } }, { kind: 'agent', goalId: goal.id, attemptId: attempt.id, role: attempt.role, generation: attempt.generation, revision: attempt.revision });
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        const latest = this.store.get(goal.id); requireValue(latest, 'Result goal disappeared');
        if (latest.results?.find((entry) => entry.id === pending.id)?.status !== 'pending') continue;
        this.service.execute({ id: this.id(), goalId: latest.id, expectedVersion: latest.version, type: 'reject_role_result', payload: { resultId: pending.id, code: error.code } }, { kind: 'system' });
      }
    }
  }
}
