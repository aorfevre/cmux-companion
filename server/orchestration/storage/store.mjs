import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, openSync, closeSync, constants, fstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { initializeSchema } from './schema.mjs';
import { canonicalJson, identifier, integer, requireValue } from '../domain/contracts.mjs';
import { readyWork } from '../domain/scheduling.mjs';
import { transition, validateAuthority } from '../domain/transitions.mjs';

/** @typedef {import('../types.d.ts').Goal} Goal */
/** @typedef {import('../types.d.ts').Command} Command */
/** @typedef {import('../types.d.ts').Authority} Authority */
/** @typedef {{ goal: Goal; cursor: number }} CommandResult */
/** @typedef {'before_write' | 'after_state' | 'after_events' | 'before_commit' | 'after_commit' | 'before_notify'} Failpoint */
/** @param {unknown} value */
const hash = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** One authoritative aggregate per goal; indexed attempts and immutable contracts are
 * transactionally maintained query tables, never independent lifecycle writers.
 * Paths are mandatory so fake/test compositions cannot open installed state by accident.
 */
export class OrchestrationStore {
  /** @param {{ path: string; now?: () => string; failpoint?: (point: Failpoint) => void; onCommit?: (cursor: number) => void; onNotificationError?: (error: unknown) => void }} options */
  constructor({ path, now = () => new Date().toISOString(), failpoint = () => {}, onCommit = () => {}, onNotificationError = () => {} }) {
    requireValue(typeof path === 'string' && path.length > 0, 'An explicit orchestration database path is required');
    this.path = path === ':memory:' ? path : resolve(path);
    if (path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (path !== ':memory:') {
      const descriptor = openSync(this.path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try { requireValue(fstatSync(descriptor).nlink === 1, 'Hard-linked database paths are not supported'); }
      finally { closeSync(descriptor); }
      this.path = realpathSync(this.path); chmodSync(this.path, 0o600);
      for (const suffix of ['-wal', '-shm']) {
        try { chmodSync(`${this.path}${suffix}`, 0o600); }
        catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; }
      }
    }
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    try { initializeSchema(this.db); }
    catch (error) { this.db.close(); throw error; }
    if (path !== ':memory:') chmodSync(this.path, 0o600);
    this.now = now; this.failpoint = failpoint; this.onCommit = onCommit; this.onNotificationError = onNotificationError;
    // An earlier foundation database has goals but no ready queue. Backfill its
    // current work atomically; reopening a current database preserves ordering.
    this.db.exec('BEGIN IMMEDIATE');
    try { for (const goal of this.list()) this.refreshReady(goal); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }

  }
  /** Rebuildable readiness index; existing sequence numbers survive refresh.
   * @param {Goal} goal
   */
  refreshReady(goal) {
    const ready = readyWork(goal);
    const existing = this.db.prepare('SELECT sequence,generation,revision,work_key FROM ready_work WHERE goal_id=?').all(goal.id);
    for (const row of existing) if (row.generation !== goal.generation || row.revision !== goal.revision || !ready.some((work) => work.key === row.work_key)) this.db.prepare('DELETE FROM ready_work WHERE sequence=?').run(row.sequence);
    for (const work of ready) this.db.prepare('INSERT INTO ready_work(goal_id,generation,revision,work_key,body) VALUES (?,?,?,?,?) ON CONFLICT(goal_id,generation,revision,work_key) DO UPDATE SET body=excluded.body').run(goal.id, goal.generation, goal.revision, work.key, JSON.stringify(work));
  }
  close() { this.db.close(); }
  /** @param {string} id @returns {Goal | null} */
  get(id) {
    const row = this.db.prepare('SELECT state FROM goals WHERE id = ?').get(id);
    return row ? JSON.parse(String(row.state)) : null;
  }
  /** @returns {Goal[]} */
  list() { return this.db.prepare('SELECT state FROM goals ORDER BY created_at, id').all().map((row) => JSON.parse(String(row.state))); }
  cursor() { return Number(this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get()?.seq ?? 0); }

  /** All authorization happens before receipt lookup, including replay after revocation.
   * @param {Command} command @param {Authority} authority
   * @param {(goal: Goal | null, command: Command, authority: Authority) => import('../types.d.ts').Transition} [decide]
   * @returns {CommandResult}
   */
  apply(command, authority, decide = transition) {
    identifier(command.id); identifier(command.goalId);
    requireValue(['user', 'system', 'agent'].includes(authority.kind), 'Unknown authority', 'FORBIDDEN');
    const inputHash = hash(command), authorityHash = hash(authority);
    requireValue(Buffer.byteLength(canonicalJson(command)) <= 2 * 1024 * 1024, 'Command exceeds storage limit');
    this.db.exec('BEGIN IMMEDIATE');
    /** @type {CommandResult} */
    let result;
    try {
      const before = this.get(command.goalId);
      if (before) validateAuthority(before, authority, true);
      else requireValue(authority.kind === 'user' && command.type === 'create_goal', 'No goal authority', 'FORBIDDEN');
      const receipt = this.db.prepare('SELECT * FROM command_receipts WHERE goal_id = ? AND id = ?').get(command.goalId, command.id);
      if (receipt) {
        requireValue(receipt.input_hash === inputHash && receipt.authority_hash === authorityHash, 'Operation id was reused with different input or authority', 'IDEMPOTENCY_CONFLICT');
        result = JSON.parse(String(receipt.result));
        this.db.exec('COMMIT'); return result;
      }
      const change = decide(before, command, authority), at = this.now();
      this.failpoint('before_write');
      const goal = change.goal;
      this.db.prepare(`INSERT INTO goals(id, version, generation, repository_id, status, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,
        generation=excluded.generation, status=excluded.status, state=excluded.state, updated_at=excluded.updated_at`)
        .run(goal.id, goal.version, goal.generation, goal.repositoryId, goal.status, JSON.stringify(goal), at, at);
      for (const contract of goal.contracts) {
        const body = canonicalJson(contract.contract);
        const old = this.db.prepare('SELECT body FROM contracts WHERE goal_id = ? AND revision = ?').get(goal.id, contract.revision);
        requireValue(!old || old.body === body, 'Immutable contract was rewritten');
        this.db.prepare('INSERT OR IGNORE INTO contracts(goal_id, revision, body) VALUES (?, ?, ?)').run(goal.id, contract.revision, body);
      }
      this.db.prepare('DELETE FROM attempts WHERE goal_id = ?').run(goal.id);
      const insertAttempt = this.db.prepare(`INSERT INTO attempts(goal_id,id,generation,revision,role,mode,task_id,target,status,worker_state,body) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const attempt of goal.attempts) insertAttempt.run(goal.id, attempt.id, attempt.generation, attempt.revision, attempt.role, attempt.mode, attempt.taskId, attempt.target, attempt.status, attempt.workerState, JSON.stringify(attempt));
      this.refreshReady(goal);
      this.failpoint('after_state');
      for (const intent of change.intents) this.db.prepare('INSERT INTO operations(id,goal_id,kind,generation,revision,attempt_id,body,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(intent.id, goal.id, intent.kind, intent.generation, intent.revision, intent.attemptId, JSON.stringify(intent), at);
      for (const event of change.events) {
        const payload = JSON.stringify(event.payload);
        requireValue(Buffer.byteLength(payload) <= 16 * 1024, 'Event needs an artifact reference');
        this.db.prepare('INSERT INTO events(goal_id,version,generation,revision,command_id,kind,payload,created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(goal.id, goal.version, goal.generation, goal.revision, command.id, event.kind, payload, at);
      }
      this.failpoint('after_events');
      result = { goal, cursor: this.cursor() };
      this.db.prepare('INSERT INTO command_receipts(goal_id,id,input_hash,authority_hash,result) VALUES (?,?,?,?,?)')
        .run(goal.id, command.id, inputHash, authorityHash, JSON.stringify(result));
      this.failpoint('before_commit'); this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK'); throw error;
    }
    // A crash here loses the response/wakeup, not the command. Receipt replay and
    // periodic journal consumers recover it without repeating external operations.
    this.failpoint('after_commit');
    try { this.failpoint('before_notify'); this.onCommit(result.cursor); }
    catch (error) { try { this.onNotificationError(error); } catch { /* telemetry cannot undo a commit */ } }
    return result;
  }

  /** @param {{ since?: number; limit?: number; goalId?: string }} [options] */
  events({ since = 0, limit = 100, goalId } = {}) {
    integer(since); integer(limit, 1); requireValue(limit <= 500, 'Event page is too large');
    const floor = Number(this.db.prepare('SELECT floor FROM journal_meta WHERE id=1').get()?.floor ?? 0);
    requireValue(since >= floor, 'Event history expired; fetch a snapshot', 'CURSOR_EXPIRED');
    const rows = goalId
      ? this.db.prepare('SELECT * FROM events WHERE id > ? AND goal_id = ? ORDER BY id LIMIT ?').all(since, goalId, limit)
      : this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?').all(since, limit);
    return rows.map((row) => ({ id: Number(row.id), goalId: String(row.goal_id), version: Number(row.version),
      generation: Number(row.generation), revision: Number(row.revision), commandId: String(row.command_id),
      schemaVersion: Number(row.schema_version), kind: String(row.kind), payload: JSON.parse(String(row.payload)), createdAt: String(row.created_at) }));
  }
  snapshot() {
    this.db.exec('BEGIN');
    try { const snapshot = { goals: this.list(), cursor: this.cursor() }; this.db.exec('COMMIT'); return snapshot; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** @returns {(import('../domain/scheduling.mjs').ReadyWork & { sequence: number; goalId: string; generation: number; revision: number })[]} */
  ready() {
    return this.db.prepare('SELECT * FROM ready_work ORDER BY sequence').all().map((row) => ({ ...JSON.parse(String(row.body)), sequence: Number(row.sequence), goalId: String(row.goal_id), generation: Number(row.generation), revision: Number(row.revision) }));
  }
  /** Called inside the command write transaction so reservation and capacity check
   * cannot race across service instances. @param {string} goalId @param {import('../types.d.ts').Mode} mode
   */
  ownedCapacity(goalId, mode) {
    const row = this.db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(goal_id = ?),0) AS goal
      FROM attempts WHERE worker_state != 'stopped' AND mode = ?`).get(goalId, mode);
    return { total: Number(row?.total ?? 0), goal: Number(row?.goal ?? 0) };
  }
  /** @returns {(import('../types.d.ts').Intent & { status: string })[]} */
  operations() { return this.db.prepare("SELECT body,status FROM operations WHERE status != 'completed' ORDER BY created_at,id").all().map((row) => ({ ...JSON.parse(String(row.body)), status: String(row.status) })); }
  /** Compare-and-set operation progress with its journal event. No external effect
   * occurs inside this transaction. @param {string} id @param {string} expected @param {string} next
   */
  advanceOperation(id, expected, next) {
    requireValue((expected === 'pending' && (next === 'dispatching' || next === 'completed')) || (expected === 'dispatching' && next === 'completed'), 'Invalid operation transition');
    this.db.exec('BEGIN IMMEDIATE');
    let cursor = 0;
    try {
      const row = this.db.prepare('SELECT * FROM operations WHERE id=? AND status=?').get(id, expected);
      if (!row) { this.db.exec('COMMIT'); return false; }
      const goal = this.get(String(row.goal_id)); requireValue(goal, 'Operation goal disappeared');
      this.db.prepare('UPDATE operations SET status=? WHERE id=? AND status=?').run(next, id, expected);
      this.db.prepare('INSERT INTO events(goal_id,version,generation,revision,command_id,kind,payload,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(goal.id, goal.version, Number(row.generation), Number(row.revision), `${id}_${next}`, 'operation_progress', JSON.stringify({ operationId: id, status: next }), this.now());
      this.failpoint('before_commit'); cursor = this.cursor(); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.failpoint('after_commit');
    try { this.onCommit(cursor); } catch (error) { try { this.onNotificationError(error); } catch { /* committed progress outlives telemetry */ } }
    return true;
  }
  /** @param {string} consumerId @param {number} [from] */
  registerConsumer(consumerId, from = 0) {
    identifier(consumerId); integer(from);
    const saved = this.db.prepare('SELECT cursor FROM consumers WHERE id = ?').get(consumerId);
    if (saved) return Number(saved.cursor);
    this.events({ since: from, limit: 1 });
    requireValue(from <= this.cursor(), 'Cannot start consumer in the future');
    this.db.prepare('INSERT OR IGNORE INTO consumers(id,cursor) VALUES (?,?)').run(consumerId, from);
    return Number(this.db.prepare('SELECT cursor FROM consumers WHERE id = ?').get(consumerId)?.cursor);
  }
  /** @param {string} consumerId @param {number} cursor */
  acknowledge(consumerId, cursor) {
    integer(cursor); requireValue(cursor <= this.cursor(), 'Cannot acknowledge future events');
    const result = this.db.prepare('UPDATE consumers SET cursor = ? WHERE id = ? AND cursor <= ?').run(cursor, consumerId, cursor);
    requireValue(result.changes === 1, 'Unknown consumer or decreasing cursor');
  }
  /** Conservative prefix retention: no active goal, owned worker, pending operation
   * or lagging registered consumer loses evidence. @param {number} through
   */
  pruneEvents(through) {
    integer(through);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const consumed = Number(this.db.prepare('SELECT MIN(cursor) AS cursor FROM consumers').get()?.cursor ?? 0);
      const protectedId = this.db.prepare(`SELECT MIN(e.id) AS id FROM events e JOIN goals g ON g.id=e.goal_id
        WHERE g.status NOT IN ('aborted','merged')
        OR EXISTS (SELECT 1 FROM attempts a WHERE a.goal_id=g.id AND a.worker_state != 'stopped')
        OR EXISTS (SELECT 1 FROM operations o WHERE o.goal_id=g.id AND o.status != 'completed')`).get()?.id;
      const cutoff = Math.min(through, consumed, protectedId === null || protectedId === undefined ? this.cursor() : Number(protectedId) - 1);
      const removed = this.db.prepare('DELETE FROM events WHERE id <= ?').run(cutoff).changes;
      this.db.prepare('UPDATE journal_meta SET floor = MAX(floor, ?) WHERE id=1').run(cutoff);
      this.db.exec('COMMIT'); return Number(removed);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
