import { randomUUID } from 'node:crypto';
import { requireValue } from '../domain/contracts.mjs';

/** Kernel liveness is conservative: a reused PID blocks takeover rather than
 * authorizing it. Only ESRCH proves the previous process no longer exists.
 * @param {number} pid
 */
export function processLiveness(pid) {
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return /** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH' ? 'dead' : 'unknown'; }
}

/** Non-expiring, nonce-fenced scheduler ownership. SQLite serializes acquisition
 * across connections; no lease timeout or slow heartbeat can steal a live owner.
 * PID evidence is used only to refuse/reclaim ownership, never to kill a worker.
 */
export class SchedulerOwnership {
  /** @param {{ store: import('./store.mjs').OrchestrationStore; pid?: number; token?: string; liveness?: (pid: number) => string }} options */
  constructor({ store, pid = process.pid, token = randomUUID(), liveness = processLiveness }) {
    requireValue(Number.isSafeInteger(pid) && pid > 0 && token.length >= 16, 'Invalid scheduler identity');
    this.store = store; this.pid = pid; this.token = token; this.liveness = liveness; this.acquired = false;
    store.db.exec(`CREATE TABLE IF NOT EXISTS scheduler_owner (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, token TEXT NOT NULL
    )`);
  }
  acquire() {
    requireValue(!this.acquired, 'This scheduler already owns the database', 'ALREADY_RUNNING');
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT pid,token FROM scheduler_owner WHERE singleton=1').get();
      if (existing) requireValue(this.liveness(Number(existing.pid)) === 'dead', 'Another scheduler owns this database; reconcile ambiguous ownership', 'OWNERSHIP_UNCERTAIN');
      db.prepare('INSERT INTO scheduler_owner(singleton,pid,token) VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET pid=excluded.pid, token=excluded.token').run(this.pid, this.token);
      db.exec('COMMIT'); this.acquired = true;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return this;
  }
  assertOwned() {
    const row = this.store.db.prepare('SELECT pid,token FROM scheduler_owner WHERE singleton=1').get();
    requireValue(this.acquired && row?.token === this.token && Number(row?.pid) === this.pid, 'Scheduler ownership changed', 'OWNERSHIP_UNCERTAIN');
  }
  release() {
    if (!this.acquired) return;
    const result = this.store.db.prepare('DELETE FROM scheduler_owner WHERE singleton=1 AND token=? AND pid=?').run(this.token, this.pid);
    this.acquired = false;
    requireValue(result.changes === 1, 'Scheduler ownership changed before release', 'OWNERSHIP_UNCERTAIN');
  }
}
