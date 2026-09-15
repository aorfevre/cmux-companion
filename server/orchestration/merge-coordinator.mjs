import { randomUUID } from 'node:crypto';
import { requireValue } from './domain/contracts.mjs';

export const MERGE_POLL_MS = 15 * 60 * 1000;
/** Service-owned polling, independent of browser refresh and agent admission. */
export class MergeCoordinator {
  /** @param {{ service:import('./service.mjs').OrchestrationService; publisher:import('./types.d.ts').PublicationPort; ownership:{assertOwned():void}; now?:()=>number; id?:()=>string; onError?:(error:unknown)=>void }} options */
  constructor({ service, publisher, ownership, now = Date.now, id = randomUUID, onError = () => {} }) {
    this.service = service; this.publisher = publisher; this.ownership = ownership; this.now = now; this.id = id; this.onError = onError; this.stopped = false;
    /** @type {Map<string,Promise<void>>} */ this.active = new Map();
  }
  run() {
    if (this.stopped || !this.publisher.observeMerge) return;
    this.ownership.assertOwned();
    for (const goal of this.service.store.list()) {
      if (goal.status !== 'delivered' || !goal.pr || !goal.publication || this.active.has(goal.id)
        || !this.service.repositoryIds.has(goal.repositoryId)
        || (goal.mergeSync && this.now() - goal.mergeSync.checkedAt < MERGE_POLL_MS)) continue;
      const pr = goal.pr, plan = goal.publication.plan;
      const job = Promise.resolve().then(async () => {
        if (this.stopped) return;
        /** @type {'open'|'closed'|'merged'|'unknown'} */ let state = 'unknown';
        try {
          const observation = await this.publisher.observeMerge?.(plan, pr);
          requireValue(observation?.number === pr.number && observation.url === pr.url, 'PR identity changed');
          state = observation.state;
        } catch { /* Persist a sanitized error; never expose CLI output or credentials. */ }
        if (this.stopped) return;
        this.ownership.assertOwned();
        const latest = this.service.store.get(goal.id);
        if (!latest || latest.status !== 'delivered' || latest.generation !== goal.generation || latest.pr?.number !== pr.number || latest.pr.url !== pr.url) return;
        this.service.execute({ id: this.id(), goalId: goal.id, expectedVersion: latest.version, type: 'record_merge_sync', payload: { number: pr.number, url: pr.url, state, checkedAt: this.now() } }, { kind: 'system' });
      }).finally(() => this.active.delete(goal.id));
      this.active.set(goal.id, job); void job.catch(this.onError);
    }
  }
  async stop() { this.stopped = true; await Promise.allSettled(this.active.values()); }
}
