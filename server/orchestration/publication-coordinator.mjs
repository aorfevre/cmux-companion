import { randomUUID } from 'node:crypto';
import { DomainError, requireValue } from './domain/contracts.mjs';

/** The scheduler owns publication lifecycle; the adapter owns remote receipts.
 * Long-running requests do not block ordinary agent admission.
 */
export class PublicationCoordinator {
  /** @param {{ service: import('./service.mjs').OrchestrationService; publisher: import('./types.d.ts').PublicationPort; ownership: { assertOwned(): void }; id?: () => string; onError?: (error: unknown) => void }} options */
  constructor({ service, publisher, ownership, id = randomUUID, onError = () => {} }) {
    this.service = service; this.store = service.store; this.publisher = publisher; this.ownership = ownership; this.id = id; this.onError = onError; this.stopped = false;
    /** @type {Map<string, { controller: AbortController; goalId: string; generation: number; revision: number; job: Promise<void> }>} */ this.active = new Map();
  }
  /** @param {string} goalId @param {string} type @param {unknown} payload */
  record(goalId, type, payload) {
    this.ownership.assertOwned(); const goal = this.store.get(goalId); requireValue(goal, 'Publication goal disappeared');
    return this.service.execute({ id: this.id(), goalId, expectedVersion: goal.version, type, payload }, { kind: 'system' });
  }
  cancelRevoked() {
    for (const run of this.active.values()) {
      const goal = this.store.get(run.goalId);
      if (!goal || goal.status !== 'ready_to_publish' || goal.generation !== run.generation || goal.revision !== run.revision || !this.service.repositoryIds.has(goal.repositoryId)) run.controller.abort();
    }
  }
  async stop() {
    this.stopped = true; for (const run of this.active.values()) run.controller.abort();
    const results = await Promise.allSettled([...this.active.values()].map((run) => run.job));
    const failed = results.filter((entry) => entry.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map((entry) => entry.reason), 'Publication shutdown failed');
  }
  /** @param {string} goalId @param {string} operationId @param {import('./types.d.ts').PublicationResult} observation */
  settle(goalId, operationId, observation) {
    const goal = this.store.get(goalId); requireValue(goal?.publication, 'Publication owner disappeared');
    if (observation.status === 'cancelled' && goal.status === 'ready_to_publish') observation = { ...observation, status: 'pending' };
    if (JSON.stringify(goal.publication.observation) !== JSON.stringify(observation)) this.record(goalId, 'record_publication_observation', { operationId, observation });
    if (['published', 'cancelled'].includes(observation.status)) {
      const operation = this.store.operations().find((entry) => entry.id === operationId);
      if (operation) this.store.advanceOperation(operationId, operation.status, 'completed');
    }
  }
  async run() {
    if (this.stopped) return;
    this.cancelRevoked(); this.ownership.assertOwned();
    for (const goal of this.store.list()) {
      if (goal.status !== 'building') continue;
      try { this.record(goal.id, 'request_publication', { operationId: this.id() }); }
      catch (error) { if (!(error instanceof DomainError) || !['NOT_READY', 'FORBIDDEN'].includes(error.code)) throw error; }
    }
    for (const operation of this.store.operations().filter((entry) => entry.kind === 'publish')) {
      if (this.stopped) return;
      if (this.active.has(operation.id)) continue;
      const goal = this.store.get(operation.goalId), publication = goal?.publication;
      requireValue(goal && publication?.operationId === operation.id, 'Publication operation has no owner');
      if (goal.pr) { this.store.advanceOperation(operation.id, operation.status, 'completed'); continue; }
      const permitted = goal.status === 'ready_to_publish' && goal.generation === operation.generation && goal.revision === operation.revision && this.service.repositoryIds.has(goal.repositoryId);
      // A moved target needs an explicit user decision, not another remote read
      // every scheduler tick. Revoked goals must still settle their effects.
      if (permitted && publication.observation?.status === 'target_moved' && publication.observation.baseHeadSha !== null) continue;
      if (operation.status === 'pending' && !permitted) {
        this.settle(goal.id, operation.id, { status: 'cancelled', baseHeadSha: null, pr: null }); continue;
      }
      if (operation.status === 'pending') this.store.advanceOperation(operation.id, 'pending', 'dispatching');
      const controller = new AbortController(); if (!permitted) controller.abort();
      const job = Promise.resolve().then(async () => {
        let observation;
        try {
          observation = controller.signal.aborted ? await this.publisher.observe(publication.plan) : await this.publisher.publish(publication.plan, { signal: controller.signal });
          if (controller.signal.aborted && ['pending', 'target_moved'].includes(observation.status)) observation = { ...observation, status: /** @type {const} */ ('cancelled') };
        } catch { observation = { status: /** @type {const} */ ('unknown'), baseHeadSha: null, pr: null }; }
        this.settle(goal.id, operation.id, observation);
      }).finally(() => { this.active.delete(operation.id); });
      this.active.set(operation.id, { controller, goalId: goal.id, generation: operation.generation, revision: operation.revision, job });
      void job.catch(this.onError);
    }
  }
}
