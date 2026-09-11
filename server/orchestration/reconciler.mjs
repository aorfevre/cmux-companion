import { randomUUID } from 'node:crypto';
import { ownsWorker } from './domain/transitions.mjs';
import { requireValue } from './domain/contracts.mjs';

export class Reconciler {
  /** @param {{service: import('./service.mjs').OrchestrationService; ownership: {assertOwned(): void}; id?: () => string}} options */
  constructor({ service, ownership, id = randomUUID }) { this.service = service; this.store = service.store; this.agents = service.agents; this.ownership = ownership; this.id = id; }
  /** @param {string} goalId @param {string} type @param {unknown} payload */
  record(goalId, type, payload) {
    this.ownership.assertOwned(); const goal = this.store.get(goalId); requireValue(goal, 'Goal disappeared');
    return this.service.execute({ id: this.id(), goalId, expectedVersion: goal.version, type, payload }, { kind: 'system' });
  }
  /** @param {string} goalId @param {string} attemptId */
  async observe(goalId, attemptId) {
    let goal = this.store.get(goalId), attempt = goal?.attempts.find((entry) => entry.id === attemptId);
    if (!goal || !attempt || !ownsWorker(attempt)) return;
    this.ownership.assertOwned();
    let observation;
    try { observation = await this.agents.observe(attempt.operationId); }
    catch { observation = { status: 'unknown', identity: null }; }
    this.ownership.assertOwned();
    goal = this.store.get(goalId); attempt = goal?.attempts.find((entry) => entry.id === attemptId);
    if (!goal || !attempt || !ownsWorker(attempt)) return;
    if (observation.status === 'stopped') {
      this.record(goalId, 'record_stopped', { attemptId }); this.store.advanceOperation(attempt.operationId, 'dispatching', 'completed'); return;
    }
    if (observation.status === 'running' && observation.identity && (!attempt.identity || attempt.identity === observation.identity)) {
      if (attempt.status === 'queued' || attempt.status === 'uncertain' || (attempt.status === 'succeeded' && attempt.workerState === 'unknown')) {
        requireValue(attempt.worktree && attempt.branch, 'Dispatched worker has no recorded checkout', 'OWNERSHIP_UNCERTAIN');
        this.record(goalId, 'record_dispatch', { attemptId, identity: observation.identity, worktree: attempt.worktree, branch: attempt.branch });
      }
      this.store.advanceOperation(attempt.operationId, 'dispatching', 'completed'); return;
    }
    if (attempt.workerState !== 'unknown' && attempt.generation === goal.generation && !['aborted', 'merged'].includes(goal.status)) {
      this.record(goalId, 'record_failure', { attemptId, uncertain: true, error: 'Worker identity is uncertain; reconcile before retrying' });
    }
  }
  async run() {
    this.ownership.assertOwned();
    const operations = this.store.operations();
    for (const goal of this.store.list()) for (const attempt of goal.attempts.filter(ownsWorker)) {
      const operation = operations.find((entry) => entry.id === attempt.operationId);
      if (operation?.status === 'pending') continue; // No launch was sent; dispatcher handles cancellation safely.
      await this.observe(goal.id, attempt.id);
    }
    for (const operation of this.store.operations().filter((entry) => entry.kind === 'terminate')) {
      this.ownership.assertOwned();
      const goal = this.store.get(operation.goalId), attempt = goal?.attempts.find((entry) => entry.id === operation.attemptId);
      if (!attempt || !ownsWorker(attempt)) { this.store.advanceOperation(operation.id, operation.status, 'completed'); continue; }
      if (!attempt.identity) continue;
      this.store.advanceOperation(operation.id, 'pending', 'dispatching');
      try { await this.agents.terminate(attempt.identity); } catch { /* termination response is not stopped proof */ }
      await this.observe(operation.goalId, attempt.id);
      if (this.store.get(operation.goalId)?.attempts.find((entry) => entry.id === attempt.id)?.workerState === 'stopped') this.store.advanceOperation(operation.id, 'dispatching', 'completed');
    }
  }
}
