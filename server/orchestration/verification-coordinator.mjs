import { integratedWaveReady, verificationWaveId } from './domain/waves.mjs';
import { randomUUID } from 'node:crypto';
import { DomainError, object, requireValue } from './domain/contracts.mjs';

/** Long-running checks never block ordinary scheduler admission. The scheduler
 * retains exclusive ownership until every locally launched verification joins.
 */
export class VerificationCoordinator {
  /** @param {{ service: import('./service.mjs').OrchestrationService; verifier: import('./types.d.ts').VerificationPort; ownership: { assertOwned(): void }; repositories?: Partial<Pick<import('./types.d.ts').RepositoryPort, 'removeVerificationWorktree'>> | null; id?: () => string; onError?: (error: unknown) => void }} options */
  constructor({ service, verifier, ownership, repositories = null, id = randomUUID, onError = () => {} }) {
    this.service = service; this.store = service.store; this.verifier = verifier; this.ownership = ownership; this.repositories = repositories; this.id = id; this.onError = onError;
    /** @type {Map<string, { goalId: string; generation: number; revision: number; headSha: string; controller: AbortController; job: Promise<void> }>} */ this.active = new Map();
    /** @type {Map<string, Promise<void>>} */ this.releasing = new Map();
    this.stopped = false;
  }
  /** @param {string} goalId @param {string} type @param {unknown} payload */
  record(goalId, type, payload) {
    this.ownership.assertOwned(); const goal = this.store.get(goalId); requireValue(goal, 'Verification goal disappeared');
    return this.service.execute({ id: this.id(), goalId, expectedVersion: goal.version, type, payload }, { kind: 'system' });
  }
  /** Verification evidence is durable once recorded; the checkout adds nothing.
   * A removal failure is reported and never changes a verification result.
   * @param {string} operationId */
  async release(operationId) {
    const port = this.repositories?.removeVerificationWorktree;
    if (!port) return;
    // The job completion and the next tick's sweep may both reach here; one
    // Git removal per operation at a time keeps the second from racing it.
    let pending = this.releasing.get(operationId);
    if (!pending) {
      pending = Promise.resolve().then(() => port.call(this.repositories, operationId)).then(() => undefined, (error) => { this.onError(error); })
        .finally(() => { if (this.releasing.get(operationId) === pending) this.releasing.delete(operationId); });
      this.releasing.set(operationId, pending);
    }
    await pending;
  }
  cancelRevoked() {
    for (const run of this.active.values()) {
      const goal = this.store.get(run.goalId);
      if (!goal || goal.status !== 'building' || goal.generation !== run.generation || goal.revision !== run.revision || goal.integrationHead !== run.headSha || !this.service.repositoryIds.has(goal.repositoryId)) run.controller.abort();
    }
  }
  async stop() {
    this.stopped = true;
    for (const run of this.active.values()) run.controller.abort();
    const settled = await Promise.allSettled([...this.active.values()].map((run) => run.job));
    const errors = settled.filter((entry) => entry.status === 'rejected');
    if (errors.length) throw new AggregateError(errors.map((entry) => entry.reason), 'Verification shutdown failed');
  }
  async run() {
    if (this.stopped) return;
    this.cancelRevoked(); this.ownership.assertOwned();
    // Sweep checkouts of runs whose stopped result is already recorded, so a
    // crash between the result and its removal cannot strand installed files.
    for (const snapshot of this.store.list()) for (const run of snapshot.verificationRuns ?? []) {
      if (run.workerState === 'stopped' && run.result) await this.release(run.operationId);
    }
    for (const snapshot of this.store.list()) {
      const goal = this.store.get(snapshot.id);
      if (!goal || goal.hold || goal.status !== 'building' || !this.service.repositoryIds.has(goal.repositoryId)) continue;
      const prior = goal.verificationRuns?.some((run) => run.generation === goal.generation && run.revision === goal.revision && run.headSha === goal.integrationHead && run.waveId === verificationWaveId(goal) && !run.retryRequested);
      if (prior || !integratedWaveReady(goal)) continue;
      try { this.record(goal.id, 'request_verification', { operationId: this.id() }); }
      catch (error) { if (!(error instanceof DomainError) || !['NOT_READY', 'RETRY_REQUIRED', 'FORBIDDEN'].includes(error.code)) throw error; }
    }
    for (const operation of this.store.operations().filter((entry) => entry.kind === 'verify')) {
      if (this.stopped) return;
      if (this.active.has(operation.id)) continue;
      const goal = this.store.get(operation.goalId), run = goal?.verificationRuns?.find((entry) => entry.operationId === operation.id);
      requireValue(goal && run, 'Verification operation has no owner');
      if (run.workerState === 'stopped') { this.store.advanceOperation(operation.id, operation.status, 'completed'); continue; }
      if (operation.status === 'dispatching') {
        let receipt = null;
        try { receipt = await this.verifier.observe(operation.id); } catch { /* no observable receipt is not stopped proof */ }
        this.ownership.assertOwned();
        if (receipt && (!run.result || receipt.workerState !== run.workerState)) this.record(goal.id, 'record_verification_result', { operationId: operation.id, result: receipt });
        else if (!receipt && run.status !== 'uncertain') this.record(goal.id, 'verification_uncertain', { operationId: operation.id });
        if (receipt?.workerState === 'stopped') { this.store.advanceOperation(operation.id, operation.status, 'completed'); await this.release(operation.id); }
        continue;
      }
      const permitted = goal.status === 'building' && goal.generation === operation.generation && goal.revision === operation.revision && goal.integrationHead === run.headSha && this.service.repositoryIds.has(goal.repositoryId);
      if (!permitted) {
        this.record(goal.id, 'cancel_verification', { operationId: operation.id }); this.store.advanceOperation(operation.id, 'pending', 'completed'); continue;
      }
      if (goal.hold) continue;
      // One verification process at a time; implementation/review admission keeps
      // running in the ordinary scheduler while this job awaits its child.
      if (this.active.size
        || this.store.operations().some((entry) => entry.kind === 'verify' && entry.id !== operation.id && entry.status === 'dispatching')
        || this.store.list().some((entry) => entry.verificationRuns?.some((owned) => owned.workerState === 'unknown'))) continue;
      if (!this.store.advanceOperation(operation.id, 'pending', 'dispatching')) continue;
      const controller = new AbortController(), payload = object(operation.payload);
      const job = Promise.resolve().then(async () => {
        let result;
        try {
          result = await this.verifier.run({ operationId: operation.id, goalId: goal.id, repositoryId: goal.repositoryId, headSha: run.headSha, checks: /** @type {import('./types.d.ts').Check[]} */ (payload.checks), signal: controller.signal });
        } catch {
          this.record(goal.id, 'verification_uncertain', { operationId: operation.id }); return;
        }
        this.record(goal.id, 'record_verification_result', { operationId: operation.id, result });
        if (result.workerState === 'stopped') { this.store.advanceOperation(operation.id, 'dispatching', 'completed'); await this.release(operation.id); }
      }).finally(() => { this.active.delete(operation.id); });
      this.active.set(operation.id, { goalId: goal.id, generation: goal.generation, revision: goal.revision, headSha: run.headSha, controller, job });
      void job.catch(this.onError);
    }
  }
}
