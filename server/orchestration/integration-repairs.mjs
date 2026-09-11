import { randomUUID } from 'node:crypto';
import { DomainError, requireValue } from './domain/contracts.mjs';

/** Result intake records intent; only the exclusively owned scheduler performs
 * the Git effect. Physical worker exit and result/effect settlement are separate.
 */
export class IntegrationRepairs {
  /** @param {{ service: import('./service.mjs').OrchestrationService; integrations: Pick<import('./types.d.ts').RepositoryPort, 'acceptRepair' | 'observeRepair'>; ownership: { assertOwned(): void }; id?: () => string }} options */
  constructor({ service, integrations, ownership, id = randomUUID }) { this.service = service; this.store = service.store; this.integrations = integrations; this.ownership = ownership; this.id = id; }
  /** @param {string} goalId @param {string} type @param {unknown} payload */
  record(goalId, type, payload) {
    this.ownership.assertOwned(); const goal = this.store.get(goalId); requireValue(goal, 'Repair goal disappeared');
    return this.service.execute({ id: this.id(), goalId, expectedVersion: goal.version, type, payload }, { kind: 'system' });
  }
  async run() {
    for (const effect of this.store.operations().filter((entry) => entry.kind === 'integrate_repair')) {
      this.ownership.assertOwned();
      let goal = this.store.get(effect.goalId);
      const result = goal?.results?.find((entry) => entry.repair?.effectId === effect.id);
      const attempt = goal?.attempts.find((entry) => entry.id === effect.attemptId);
      requireValue(goal && result?.repair && result.proofArtifactId && attempt, 'Repair effect has no recorded result');
      if (result.status !== 'pending') { this.store.advanceOperation(effect.id, effect.status, 'completed'); continue; }
      const input = { goalId: goal.id, repositoryId: goal.repositoryId, integrationOperationId: result.repair.integrationOperationId, effectId: effect.id, attempt, headSha: result.repair.headSha, proofArtifactId: result.proofArtifactId };
      if (effect.status === 'dispatching') {
        const observed = await this.integrations.observeRepair(input); this.ownership.assertOwned();
        if (observed.status === 'integrated' && observed.headSha) {
          this.record(goal.id, 'settle_repair_result', { resultId: result.id, effectId: effect.id, headSha: observed.headSha });
          this.store.advanceOperation(effect.id, effect.status, 'completed'); continue;
        }
        if (observed.status === 'unknown') continue;
      }
      goal = this.store.get(goal.id); requireValue(goal, 'Repair goal disappeared');
      const authorized = goal.status === 'building' && goal.generation === effect.generation && goal.revision === effect.revision && this.service.repositoryIds.has(goal.repositoryId);
      if (!authorized) {
        // Pending means no effect has ever been sent. Dispatching remains owned
        // until read-only observation establishes its outcome, even after abort.
        if (effect.status === 'pending') {
          this.record(goal.id, 'cancel_repair_result', { resultId: result.id, effectId: effect.id, code: 'STALE_ATTEMPT' });
          this.store.advanceOperation(effect.id, 'pending', 'completed');
        }
        continue;
      }
      if (goal.integration?.state !== 'repairing') continue;
      if (effect.status === 'pending') this.store.advanceOperation(effect.id, 'pending', 'dispatching');
      try {
        const applied = await this.integrations.acceptRepair(input); this.ownership.assertOwned();
        this.record(goal.id, 'settle_repair_result', { resultId: result.id, effectId: effect.id, headSha: applied.headSha });
        this.store.advanceOperation(effect.id, 'dispatching', 'completed');
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        this.record(goal.id, 'record_integration_failure', { operationId: input.integrationOperationId, code: error.code });
      }
    }
  }
}
