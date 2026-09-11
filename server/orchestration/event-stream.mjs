import { integer, requireValue } from './domain/contracts.mjs';
import { goalView } from './domain/state-view.mjs';
import { eventView } from './domain/event-view.mjs';

/** @typedef {{ response: import('node:http').ServerResponse; cursor: number; blocked: boolean; timeout: ReturnType<typeof setTimeout> | null; onDrain: () => void }} StreamClient */

/** SSE is a bounded public invalidation channel, not another lifecycle authority.
 * Ephemeral browser connections do not pin journal retention; expired cursors resync.
 */
export class EventStream {
  /** @param {{ store: import('./storage/store.mjs').OrchestrationStore; intervalMs?: number; heartbeatMs?: number; drainMs?: number; maxClients?: number; maxFrameBytes?: number; onError?: (error: unknown) => void }} options */
  constructor({ store, intervalMs = 1000, heartbeatMs = 15000, drainMs = 15000, maxClients = 64, maxFrameBytes = 1024 * 1024, onError = () => {} }) {
    this.store = store; this.intervalMs = integer(intervalMs, 1); this.heartbeatMs = integer(heartbeatMs, 1);
    this.drainMs = integer(drainMs, 1);
    requireValue(this.intervalMs <= 2147483647 && this.heartbeatMs <= 2147483647 && this.drainMs <= 2147483647, 'Stream timer exceeds supported range');
    this.maxClients = integer(maxClients, 1); this.maxFrameBytes = integer(maxFrameBytes, 1); this.onError = onError; this.stopped = true; this.queued = false;
    /** @type {Set<StreamClient>} */ this.clients = new Set();
    /** @type {ReturnType<typeof setInterval> | null} */ this.timer = null;
    /** @type {ReturnType<typeof setInterval> | null} */ this.heartbeat = null;
    /** @type {ReturnType<typeof setImmediate> | null} */ this.more = null;
  }
  snapshot() {
    const snapshot = this.store.snapshot();
    return { journalId: this.store.journalId, cursor: snapshot.cursor, goals: snapshot.goals.map(goalView) };
  }
  /** Validate before HTTP headers are sent. @param {string | undefined} token */
  prepare(token) {
    requireValue(!this.stopped, 'Event stream is not ready', 'NOT_READY');
    requireValue(this.clients.size < this.maxClients, 'Too many event connections', 'CAPACITY_FULL');
    if (!token) return { kind: 'snapshot', snapshot: this.snapshot(), cursor: 0 };
    const [journalId, raw, extra] = token.split(':'); const cursor = Number(raw);
    requireValue(extra === undefined && raw !== undefined && /^[0-9]+$/.test(raw), 'Invalid event cursor'); integer(cursor);
    if (journalId !== this.store.journalId) return { kind: 'resync', snapshot: this.snapshot(), cursor: 0 };
    requireValue(cursor <= this.store.cursor(), 'Event cursor is in the future');
    try { this.store.events({ since: cursor, limit: 1 }); }
    catch (error) { if (/** @type {{code?: string}} */ (error).code !== 'CURSOR_EXPIRED') throw error; return { kind: 'resync', snapshot: this.snapshot(), cursor: 0 }; }
    return { kind: 'events', snapshot: null, cursor };
  }
  /** @param {import('node:http').ServerResponse} response @param {ReturnType<EventStream['prepare']>} initial */
  attach(response, initial) {
    /** @type {StreamClient} */ const client = { response, cursor: initial.snapshot?.cursor ?? initial.cursor, blocked: false, timeout: null, onDrain: () => {
      if (client.timeout) clearTimeout(client.timeout); client.timeout = null; client.blocked = false; this.wake();
    } };
    this.clients.add(client); response.once('close', () => this.remove(client));
    response.once('error', () => { this.remove(client); response.destroy(); });
    if (initial.snapshot) this.send(client, initial.kind, initial.snapshot, client.cursor);
    else this.write(client, ': connected\n\n');
    this.wake();
  }
  /** @param {StreamClient} client */
  remove(client) {
    this.clients.delete(client); if (client.timeout) clearTimeout(client.timeout); client.timeout = null;
    client.response.removeListener('drain', client.onDrain);
  }
  /** Buffer at most one bounded frame per client; write(false) accepted that
   * frame, so wait for drain before producing more. @param {StreamClient} client @param {string} frame */
  write(client, frame) {
    if (client.blocked) return false;
    try {
      if (Buffer.byteLength(frame) <= this.maxFrameBytes) {
        if (!client.response.write(frame)) {
          client.blocked = true; client.response.once('drain', client.onDrain);
          client.timeout = setTimeout(() => { this.remove(client); client.response.destroy(); }, this.drainMs); client.timeout.unref();
        }
        return true;
      }
    } catch (error) { try { this.onError(error); } catch { /* telemetry cannot own delivery */ } }
    this.remove(client); client.response.destroy(); return false;
  }
  /** @param {StreamClient} client @param {string} kind @param {unknown} data @param {number} cursor */
  send(client, kind, data, cursor) {
    const frame = `id: ${this.store.journalId}:${cursor}\nevent: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
    if (this.write(client, frame)) client.cursor = cursor;
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), this.intervalMs); this.timer.unref();
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) this.write(client, ': heartbeat\n\n');
    }, this.heartbeatMs); this.heartbeat.unref();
  }
  wake() {
    if (this.stopped || this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false; if (this.stopped) return;
      let more = false;
      for (const client of this.clients) {
        if (client.blocked) continue;
        try {
          const events = this.store.events({ since: client.cursor, limit: 100 });
          if (events.length) this.send(client, 'events', { journalId: this.store.journalId, events: events.map(eventView) }, events[events.length - 1].id);
          if (events.length === 100 && this.clients.has(client) && !client.blocked) more = true;
        } catch (error) {
          if (/** @type {{code?: string}} */ (error).code === 'CURSOR_EXPIRED') {
            const snapshot = this.snapshot(); this.send(client, 'resync', snapshot, snapshot.cursor);
          } else { this.remove(client); client.response.destroy(); try { this.onError(error); } catch { /* telemetry cannot own delivery */ } }
        }
      }
      if (more && !this.more) { this.more = setImmediate(() => { this.more = null; this.wake(); }); this.more.unref(); }
    });
  }
  close() {
    this.stopped = true; if (this.timer) clearInterval(this.timer); if (this.heartbeat) clearInterval(this.heartbeat); if (this.more) clearImmediate(this.more);
    this.timer = null; this.heartbeat = null; this.more = null;
    for (const client of this.clients) { this.remove(client); client.response.destroy(); }
    this.clients.clear();
  }
}
