import { integer, requireValue } from './domain/contracts.mjs';
import { eventView } from './domain/event-view.mjs';

/** At-least-once delivery with durable cursors. A sink must deduplicate the stable
 * idempotency key: a process can die after delivery and before cursor acknowledgement.
 * Notification delivery has no authority to schedule or replay workflow effects.
 */
export class JournalConsumer {
  /** @param {{ store: import('./storage/store.mjs').OrchestrationStore; id: string; from?: number; handle: (event: ReturnType<typeof eventView>, context: { idempotencyKey: string }) => void | Promise<void>; intervalMs?: number; batchSize?: number; onError?: (error: unknown) => void }} options */
  constructor({ store, id, from = 0, handle, intervalMs = 2500, batchSize = 100, onError = () => {} }) {
    this.store = store; this.id = id; this.handle = handle; this.intervalMs = integer(intervalMs, 1);
    this.batchSize = integer(batchSize, 1); requireValue(this.batchSize <= 500 && this.intervalMs <= 2147483647, 'Consumer limits exceed supported range'); this.onError = onError;
    this.cursor = store.registerConsumer(id, from); this.stopped = true; this.again = false;
    /** @type {Promise<void> | null} */ this.sweep = null;
    /** @type {ReturnType<typeof setInterval> | null} */ this.timer = null;
  }
  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => { this.wake(); }, this.intervalMs); this.timer.unref();
    await this.tick().catch((error) => this.report(error));
  }
  /** @param {unknown} error */
  report(error) { try { this.onError(error); } catch { /* telemetry never owns delivery */ } }
  wake() { void this.tick().catch((error) => this.report(error)); }
  tick() {
    if (this.stopped) return Promise.resolve();
    this.again = true;
    if (this.sweep) return this.sweep;
    this.sweep = Promise.resolve().then(async () => {
      // Bound a sweep even if a callback continuously causes new journal events.
      let remaining = 500;
      while (!this.stopped && this.again && remaining > 0) {
        this.again = false;
        const events = this.store.events({ since: this.cursor, limit: Math.min(this.batchSize, remaining) });
        for (const event of events) {
          if (this.stopped) break;
          await this.handle(eventView(event), { idempotencyKey: `${this.store.journalId}:${this.id}:${event.id}` });
          this.store.acknowledge(this.id, event.id); this.cursor = event.id; remaining--;
        }
        if (events.length === this.batchSize) this.again = true;
      }
    }).finally(() => { this.sweep = null; });
    return this.sweep;
  }
  async stop() {
    this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null;
    await this.sweep;
  }
}
