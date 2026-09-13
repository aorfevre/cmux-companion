import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';

const shaPattern = /^[a-f0-9]{40}$/;
const idPattern = /^[a-zA-Z0-9_-]{8,100}$/;
const initial = () => ({ revision: 0, automatic: false, candidate: null, observedSha: null, deployedSha: null, lastCheckAt: null, checkError: null, checkRequested: false, requests: {}, activeId: null, suppressed: [], quarantined: [], fence: null });
export function updateError(message, statusCode = 409) { return Object.assign(new Error(message), { statusCode }); }
export function exactSha(value) { if (!shaPattern.test(value || '')) throw updateError('An exact update commit is required', 400); return value; }
export function requestId(value) { if (!idPattern.test(value || '')) throw updateError('Invalid update request ID', 400); return value; }

// One shared SQLite transaction serializes policy changes, cancellation and start.
// No process lock can strand a preference write when the updater is building.
export class UpdateControl {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid update control file'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS update_control (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
    this.db.prepare('INSERT OR IGNORE INTO update_control VALUES(1,?)').run(JSON.stringify(initial()));
  }
  read() {
    const state = JSON.parse(this.db.prepare('SELECT value FROM update_control WHERE id=1').get().value);
    if (typeof state.automatic !== 'boolean' || !Number.isSafeInteger(state.revision) || !state.requests || !Array.isArray(state.quarantined)) throw updateError('Update settings need recovery', 503);
    return state;
  }
  change(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.read(), result = fn(state);
      this.db.prepare('UPDATE update_control SET value=? WHERE id=1').run(JSON.stringify(state));
      this.db.exec('COMMIT'); return result ?? state;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  policy(revision, automatic) {
    if (typeof automatic !== 'boolean' || !Number.isSafeInteger(revision)) throw updateError('Invalid update preference', 400);
    return this.change(state => {
      if (state.revision !== revision) throw updateError('Update settings changed; refresh before saving');
      const enabling = automatic && !state.automatic;
      state.automatic = automatic; state.revision++;
      if (enabling) state.suppressed = [];
      if (!automatic) for (const item of Object.values(state.requests)) if (item.source === 'automatic' && item.status === 'queued') { item.status = 'cancelled'; if (state.fence?.id === item.id) state.fence = null; }
    });
  }
  checked({ candidate = null, observedSha, deployedSha, error = null }, now = new Date().toISOString()) {
    return this.change(state => {
      state.lastCheckAt = now; state.checkRequested = false; state.checkError = error;
      if (!error) { state.candidate = candidate; state.observedSha = observedSha; state.deployedSha = deployedSha; }
    });
  }
  check() { return this.change(state => { state.checkRequested = true; }); }
  request({ id, sha, source = 'manual', whenIdle = false }) {
    requestId(id); exactSha(sha);
    if (!['manual', 'automatic'].includes(source) || typeof whenIdle !== 'boolean') throw updateError('Invalid update request', 400);
    return this.change(state => {
      const previous = state.requests[id];
      if (previous) {
        if (previous.sha !== sha || previous.source !== source || previous.whenIdle !== whenIdle) throw updateError('Update request ID was already used');
        return previous;
      }
      if (state.candidate?.sha !== sha || state.checkError || state.quarantined.includes(sha)) throw updateError('Update is no longer eligible; check again');
      if (source === 'automatic' && (!state.automatic || state.suppressed.includes(sha))) throw updateError('Automatic installation is not authorized');
      const active = Object.values(state.requests).find(item => ['queued', 'running', 'recovery_required'].includes(item.status));
      if (active) {
        if (active.sha === sha && active.source === source && active.whenIdle === whenIdle) return active;
        throw updateError('An update is already queued or running');
      }
      const item = { id, sha, source, policyRevision: state.revision, whenIdle, status: 'queued', phase: 'waiting', createdAt: new Date().toISOString(), error: null };
      state.requests[id] = item;
      return item;
    });
  }
  retry({ id, sha, whenIdle = false }) {
    requestId(id); exactSha(sha);
    if (typeof whenIdle !== 'boolean') throw updateError('Invalid update request', 400);
    return this.change(state => {
      const prior = state.requests[id];
      if (prior) {
        if (prior.sha !== sha || prior.source !== 'manual' || prior.whenIdle !== whenIdle) throw updateError('Update request ID was already used');
        return prior;
      }
      if (state.activeId || Object.values(state.requests).some(item => item.status === 'queued') || !state.quarantined.includes(sha) || state.candidate?.sha !== sha || state.checkError) throw updateError('Failed update is not eligible for retry');
      state.quarantined = state.quarantined.filter(value => value !== sha);
      const item = { id, sha, source: 'manual', policyRevision: state.revision, whenIdle, status: 'queued', phase: 'waiting', createdAt: new Date().toISOString(), error: null };
      state.requests[id] = item; return item;
    });
  }
  recover(id) {
    requestId(id);
    return this.change(state => {
      const item = state.requests[id];
      if (state.activeId !== id || item?.status !== 'recovery_required' || !item.backup || !item.previousSha || state.fence?.id !== id) throw updateError('No matching recovery transaction');
      item.status = 'running'; item.phase = 'rolling-back';
    });
  }
  cancel(id) {
    requestId(id);
    return this.change(state => {
      const item = state.requests[id];
      if (!item) throw updateError('Update request not found', 404);
      if (item.status === 'cancelled') return item;
      if (item.status !== 'queued') throw updateError('This transaction has started; it must finish or recover safely');
      item.status = 'cancelled';
      if (state.fence?.id === item.id) state.fence = null;
      if (item.source === 'automatic' && !state.suppressed.includes(item.sha)) state.suppressed.push(item.sha);
      return item;
    });
  }
  fence(id, serviceId) {
    return this.change(state => {
      const item = state.requests[id];
      if (!item || !['queued', 'running', 'recovery_required'].includes(item.status)) throw updateError('Update request is not active');
      if (state.fence && state.fence.id !== id) throw updateError('Another update owns maintenance');
      state.fence = { id, serviceId };
    });
  }
  unfence(id) { return this.change(state => { if (state.fence?.id === id && state.requests[id]?.status !== 'running' && state.requests[id]?.status !== 'recovery_required') state.fence = null; }); }
  start(id, serviceId) {
    return this.change(state => {
      const item = state.requests[id];
      if (!item || item.status !== 'queued' || state.activeId || state.fence?.id !== id || state.fence.serviceId !== serviceId) throw updateError('Update admission changed');
      if (item.source === 'automatic' && !state.automatic) throw updateError('Automatic installation was disabled');
      if (state.quarantined.includes(item.sha)) throw updateError('Failed update requires explicit retry');
      item.status = 'running'; item.phase = 'preparing'; item.serviceId = serviceId; state.activeId = id;
      return item;
    });
  }
  phase(id, phase) { return this.change(state => { if (state.activeId !== id) throw updateError('Update does not own the transaction'); state.requests[id].phase = phase; }); }
  finish(id, { success, recoveryRequired = false, error = null }) {
    return this.change(state => {
      const item = state.requests[id];
      if (!item || state.activeId !== id) throw updateError('Update does not own the transaction');
      item.status = success ? 'succeeded' : recoveryRequired ? 'recovery_required' : 'failed'; item.phase = item.status; item.error = error;
      if (!success && !state.quarantined.includes(item.sha)) state.quarantined.push(item.sha);
      if (success) { state.deployedSha = item.sha; if (state.candidate?.sha === item.sha) state.candidate = null; }
      if (!recoveryRequired) { state.activeId = null; state.fence = null; }
      return item;
    });
  }
  status() {
    const state = this.read();
    const latest = Object.values(state.requests).at(-1);
    const request = latest ? Object.fromEntries(['id', 'sha', 'source', 'whenIdle', 'status', 'phase', 'createdAt', 'error'].map(key => [key, latest[key]])) : null;
    return { available: true, revision: state.revision, automatic: state.automatic, candidate: state.checkError ? null : state.candidate, observedSha: state.observedSha, deployedSha: state.deployedSha, lastCheckAt: state.lastCheckAt, checkError: state.checkError, checking: state.checkRequested, maintenance: Boolean(state.fence), request };
  }
  close() { this.db.close(); }
}
