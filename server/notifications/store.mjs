import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { generateIdentity, invalid, subscription } from './transport.mjs';

export const defaults = { attention: true, complete: true, updates: true, discreet: true };
export const digest = value => createHash('sha256').update(value).digest('hex');
export function preferences(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 4 || Object.keys(defaults).some(key => typeof value[key] !== 'boolean')) throw invalid('Invalid notification preferences');
  return Object.fromEntries(Object.keys(defaults).map(key => [key, value[key]]));
}
export function deviceId(proof) {
  if (typeof proof !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(proof)) throw invalid('Device management key required', 403);
  return digest(proof);
}
export class NotificationStore {
  constructor({ directory, token, now = Date.now, identity = generateIdentity }) {
    this.now = now;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw invalid('Private notification directory required');
    chmodSync(directory, 0o700);
    const path = join(directory, 'notifications.sqlite');
    if (!existsSync(path)) closeSync(openSync(path, 'wx', 0o600));
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw invalid('Private notification file required');
    chmodSync(path, 0o600); this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 0 && version !== 1) throw invalid('Notification storage requires a newer Companion');
      this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, endpoint TEXT UNIQUE NOT NULL, subscription TEXT NOT NULL, preferences TEXT NOT NULL, enrolled INTEGER NOT NULL, baseline INTEGER NOT NULL, journal TEXT NOT NULL, last_test INTEGER NOT NULL DEFAULT 0, last_attempt INTEGER, result TEXT);
        CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, device TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, event_key TEXT NOT NULL, kind TEXT NOT NULL, reference TEXT NOT NULL, milestone TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, next_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'queued', lease TEXT, lease_until INTEGER, UNIQUE(device,event_key));
        CREATE INDEX IF NOT EXISTS outbox_ready ON outbox(status,next_at); PRAGMA user_version=1;`);
      this.transaction(() => {
        if (!this.meta('identity')) this.setMeta('identity', identity());
        if (this.meta('pairing') !== digest(token)) { this.db.exec('DELETE FROM devices'); this.setMeta('pairing', digest(token)); }
      });
    } catch (error) { this.db.close(); throw error; }
  }
  meta(key) { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
  setMeta(key, value) { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  get(id) { const row = this.db.prepare('SELECT * FROM devices WHERE id=?').get(id); return row ? { ...row, subscription: JSON.parse(row.subscription), preferences: JSON.parse(row.preferences) } : null; }
  all() { return this.db.prepare('SELECT id FROM devices').all().map(row => this.get(row.id)); }
  status(id) { const row = id ? this.get(id) : null; return { available: true, publicKey: this.meta('identity').publicKey, subscribed: Boolean(row), preferences: row?.preferences ?? defaults, lastAttempt: row?.last_attempt ?? null, result: row?.result ?? null }; }
  enroll(proof, target, prefs, { cursor, journal }) {
    const id = deviceId(proof), saved = subscription(target), policy = preferences(prefs);
    this.transaction(() => {
      const old = this.get(id);
      if (!old && this.db.prepare('SELECT count(*) AS n FROM devices').get().n >= 32) throw invalid('Push subscription limit reached', 429);
      const owner = this.db.prepare('SELECT id FROM devices WHERE endpoint=?').get(saved.endpoint);
      if (owner && owner.id !== id) throw invalid('This subscription has another management key; revoke it before enrolling again', 409);
      if (old) {
        this.db.prepare('UPDATE devices SET endpoint=?,subscription=?,preferences=? WHERE id=?').run(saved.endpoint, JSON.stringify(saved), JSON.stringify(policy), id);
      } else this.db.prepare('INSERT INTO devices(id,endpoint,subscription,preferences,enrolled,baseline,journal) VALUES (?,?,?,?,?,?,?)').run(id, saved.endpoint, JSON.stringify(saved), JSON.stringify(policy), this.now(), cursor, journal);
    });
    return this.status(id);
  }
  configure(id, prefs) {
    if (!this.get(id)) throw invalid('Push subscription not found', 404);
    const policy = preferences(prefs);
    this.transaction(() => {
      this.db.prepare('UPDATE devices SET preferences=? WHERE id=?').run(JSON.stringify(policy), id);
      for (const kind of ['attention','complete','updates']) if (!policy[kind]) this.db.prepare("UPDATE outbox SET status='cancelled',lease=NULL WHERE device=? AND kind=? AND status IN ('queued','sending')").run(id, kind);
    });
    return this.status(id);
  }
  revoke(id) { this.db.prepare('DELETE FROM devices WHERE id=?').run(id); }
  revokeAll() { this.db.exec('DELETE FROM devices'); }
  enqueue({ key, kind, reference = '', milestone = '', event = null, lifetime = 3600000, device = null }) {
    const now = this.now();
    this.transaction(() => {
      this.prune();
      for (const row of device ? [this.get(device)].filter(Boolean) : this.all()) {
        if (kind !== 'test' && (!row.preferences[kind] || event && (row.journal !== event.journal || event.id <= row.baseline))) continue;
        if (this.db.prepare('SELECT id FROM outbox WHERE device=? AND event_key=?').get(row.id, key)) continue;
        if (kind === 'attention') this.db.prepare("UPDATE outbox SET status='cancelled',lease=NULL WHERE device=? AND reference=? AND kind='attention' AND status='queued'").run(row.id, reference);
        if (this.db.prepare("SELECT count(*) AS n FROM outbox WHERE device=? AND status IN ('queued','sending')").get(row.id).n >= 100) {
          this.db.prepare('UPDATE devices SET result=? WHERE id=?').run('Delivery queue full; older notices may be missed', row.id); continue;
        }
        this.db.prepare('INSERT OR IGNORE INTO outbox(id,device,event_key,kind,reference,milestone,created,expires,next_at) VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(), row.id, key, kind, reference, milestone, now, now + lifetime, now);
      }
    });
  }
  test(id) {
    const row = this.get(id); if (!row) throw invalid('Push subscription not found', 404);
    if (row.last_test && this.now() - row.last_test < 60000) throw invalid('Wait one minute before another test', 429);
    this.db.prepare('UPDATE devices SET last_test=? WHERE id=?').run(this.now(), id);
    this.enqueue({ key: `test:${randomUUID()}`, kind: 'test', device: id, lifetime: 3600000 });
  }
  prune() {
    const now = this.now();
    this.db.prepare("UPDATE outbox SET status='expired',lease=NULL WHERE expires<=? AND status IN ('queued','sending')").run(now);
    this.db.prepare('DELETE FROM outbox WHERE created<?').run(now - 7 * 86400000);
    this.db.prepare('UPDATE devices SET last_attempt=NULL,result=NULL WHERE last_attempt<?').run(now - 7 * 86400000);
    // Bound retained deduplication metadata as well as pending delivery rows.
    this.db.prepare("DELETE FROM outbox WHERE status NOT IN ('queued','sending') AND id NOT IN (SELECT id FROM outbox ORDER BY created DESC LIMIT 10000)").run();
  }
  claim() {
    return this.transaction(() => {
      this.prune(); const now = this.now();
      this.db.prepare("UPDATE outbox SET status='failed',lease=NULL WHERE attempts>=5 AND (status='queued' OR (status='sending' AND lease_until<?))").run(now);
      const row = this.db.prepare("SELECT * FROM outbox WHERE expires>? AND next_at<=? AND (status='queued' OR (status='sending' AND lease_until<?)) ORDER BY created LIMIT 1").get(now, now, now);
      if (!row) return null;
      const lease = randomUUID(); this.db.prepare("UPDATE outbox SET status='sending',lease=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(lease, now + 30000, row.id);
      return { ...row, lease, attempts: row.attempts + 1 };
    });
  }
  active(row) { return Boolean(this.db.prepare("SELECT id FROM outbox WHERE id=? AND lease=? AND status='sending'").get(row.id, row.lease)); }
  finish(row, result) {
    if (!this.active(row)) return;
    const status = result.status;
    if (status === 404 || status === 410) { this.revoke(row.device); return; }
    const accepted = status >= 200 && status < 300;
    const retry = !accepted && (status === 429 || status >= 500 || !status) && row.attempts < 5;
    const next = this.now() + Math.max(Math.min(3600000, (result.retryAfter || 0) * 1000), Math.min(3600000, 30000 * 2 ** (row.attempts - 1)));
    this.db.prepare('UPDATE outbox SET status=?,next_at=?,lease=NULL WHERE id=? AND lease=?').run(accepted ? 'accepted' : retry ? 'queued' : 'failed', next, row.id, row.lease);
    this.db.prepare('UPDATE devices SET last_attempt=?,result=? WHERE id=?').run(this.now(), accepted ? 'Accepted by push service' : retry ? 'Push service unavailable; retry scheduled' : 'Push was not accepted; check notification setup', row.device);
  }
  discard(row) { this.db.prepare("UPDATE outbox SET status='cancelled',lease=NULL WHERE id=? AND lease=?").run(row.id, row.lease); }
  close() { this.db.close(); }
}
