import { randomUUID } from 'node:crypto';
import { bootIdentity, processBirth } from '../adapters/process-evidence.mjs';
import { requireValue } from '../domain/contracts.mjs';

/** Kernel liveness is conservative: a reused PID blocks takeover rather than
 * authorizing it. Only ESRCH proves the previous process no longer exists.
 * @param {number} pid
 */
export function processLiveness(pid) {
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return /** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH' ? 'dead' : 'unknown'; }
}

/** @param {Record<string,unknown>} owner
 * @param {{ liveness?: (pid:number)=>string; boot?: ()=>string|null; birth?: (pid:number)=>string|null }} [options] */
export function ownerLiveness(owner, { liveness = processLiveness, boot = bootIdentity, birth = processBirth } = {}) {
  const currentBoot = boot();
  if (typeof owner.boot_id === 'string' && currentBoot && owner.boot_id !== currentBoot) return 'dead';
  const state = liveness(Number(owner.pid));
  if (state === 'dead') return state;
  const currentBirth = birth(Number(owner.pid));
  if (typeof owner.birth_id === 'string' && currentBirth && owner.birth_id !== currentBirth) return 'dead';
  return state;
}

/** Non-expiring, nonce-fenced scheduler ownership. SQLite serializes acquisition
 * across connections; no lease timeout or slow heartbeat can steal a live owner.
 * PID evidence is used only to refuse/reclaim ownership, never to kill a worker.
 */
export class SchedulerOwnership {
  /** @param {{ store: import('./store.mjs').OrchestrationStore; pid?: number; token?: string; liveness?: (pid: number) => string; boot?: ()=>string|null; birth?: (pid:number)=>string|null }} options */
  constructor({ store, pid = process.pid, token = randomUUID(), liveness = processLiveness, boot = bootIdentity, birth = processBirth }) {
    requireValue(Number.isSafeInteger(pid) && pid > 0 && token.length >= 16, 'Invalid scheduler identity');
    this.store = store; this.pid = pid; this.token = token; this.liveness = liveness; this.boot = boot; this.birth = birth; this.acquired = false;
    store.db.exec(`CREATE TABLE IF NOT EXISTS scheduler_owner (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, token TEXT NOT NULL, boot_id TEXT, birth_id TEXT
    )`);
    store.db.exec('BEGIN IMMEDIATE');
    try {
      const columns = store.db.prepare('PRAGMA table_info(scheduler_owner)').all().map((row) => row.name);
      for (const column of ['boot_id', 'birth_id']) if (!columns.includes(column)) store.db.exec(`ALTER TABLE scheduler_owner ADD COLUMN ${column} TEXT`);
      store.db.exec('COMMIT');
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  }
  acquire() {
    requireValue(!this.acquired, 'This scheduler already owns the database', 'ALREADY_RUNNING');
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT pid,token,boot_id,birth_id FROM scheduler_owner WHERE singleton=1').get();
      if (existing) requireValue(ownerLiveness(existing, { liveness: this.liveness, boot: this.boot, birth: this.birth }) === 'dead', 'Another scheduler owns this database; reconcile ambiguous ownership', 'OWNERSHIP_UNCERTAIN');
      db.prepare('INSERT INTO scheduler_owner(singleton,pid,token,boot_id,birth_id) VALUES (1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET pid=excluded.pid, token=excluded.token, boot_id=excluded.boot_id, birth_id=excluded.birth_id').run(this.pid, this.token, this.boot(), this.birth(this.pid));
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
