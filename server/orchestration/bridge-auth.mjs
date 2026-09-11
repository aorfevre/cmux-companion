import { createHash, randomBytes } from 'node:crypto';
import { requireValue } from './domain/contracts.mjs';
import { validateAuthority } from './domain/transitions.mjs';

/** Credentials live only in server storage; bridge clients get one scoped secret.
 * Database access here is internal credential management, never agent-side access.
 */
export class BridgeAuthority {
  /** @param {import('./storage/store.mjs').OrchestrationStore} store */
  constructor(store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS agent_credentials (
      digest TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
      attempt_id TEXT NOT NULL, authority TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
    )`);
  }
  /** @param {string} goalId @param {string} attemptId */
  issue(goalId, attemptId) {
    const goal = this.store.get(goalId);
    const attempt = goal?.attempts.find((entry) => entry.id === attemptId);
    requireValue(goal && attempt && attempt.status === 'running', 'No active attempt for credential');
    /** @type {import('./types.d.ts').Authority} */
    const authority = { kind: 'agent', goalId, generation: goal.generation, revision: goal.revision, attemptId, role: attempt.role };
    validateAuthority(goal, authority);
    return this.save(authority);
  }
  /** Mint an inert credential only after the launch intent enters dispatching.
   * Authentication still requires record_dispatch; this is not early authority.
   * @param {string} goalId @param {string} attemptId @param {string} operationId */
  issueForDispatch(goalId, attemptId, operationId) {
    const goal = this.store.get(goalId), attempt = goal?.attempts.find((entry) => entry.id === attemptId);
    const intent = this.store.operations().find((entry) => entry.id === operationId);
    requireValue(goal && attempt && attempt.status === 'queued' && attempt.workerState === 'pending' && attempt.worktree && attempt.branch
      && attempt.operationId === operationId && attempt.generation === goal.generation && attempt.revision === goal.revision
      && !['aborted', 'merged'].includes(goal.status) && intent?.kind === 'launch' && intent.status === 'dispatching'
      && intent.goalId === goalId && intent.attemptId === attemptId && intent.generation === goal.generation && intent.revision === goal.revision,
    'No current dispatch for credential', 'FORBIDDEN');
    return this.save({ kind: 'agent', goalId, generation: attempt.generation, revision: attempt.revision, attemptId, role: attempt.role });
  }
  /** The readiness endpoint gives no workflow data or early mutation access.
   * @param {string} secret */
  ready(secret) {
    const authority = this.receiptAuthority(secret), goal = this.store.get(authority.goalId);
    requireValue(goal && goal.generation === authority.generation && goal.revision === authority.revision, 'Dispatch authority was revoked', 'FORBIDDEN');
    const attempt = goal.attempts.find((entry) => entry.id === authority.attemptId);
    requireValue(attempt?.status !== 'queued', 'Dispatch identity has not committed', 'NOT_READY');
    validateAuthority(goal, authority);
    requireValue(attempt?.workerState === 'running' && attempt.identity, 'Worker identity is not active', 'NOT_READY');
    return authority;
  }
  /** @param {Extract<import('./types.d.ts').Authority, {kind:'agent'}>} authority */
  save(authority) {
    const { goalId, attemptId } = authority;
    const secret = randomBytes(32).toString('base64url');
    this.store.db.prepare('INSERT INTO agent_credentials(digest,goal_id,attempt_id,authority) VALUES (?,?,?,?)')
      .run(this.digest(secret), goalId, attemptId, JSON.stringify(authority));
    return secret;
  }
  /** @param {string} secret */
  digest(secret) { return createHash('sha256').update(secret).digest('hex'); }
  /** @param {string} secret @returns {Extract<import('./types.d.ts').Authority, {kind: 'agent'}>} */
  authenticate(secret) {
    const authority = this.receiptAuthority(secret);
    const goal = this.store.get(authority.goalId);
    requireValue(goal, 'Agent goal is unavailable', 'UNAUTHORIZED');
    validateAuthority(goal, authority, true); return authority;
  }
  /** This historical binding permits only exact receipt lookup; callers must
   * authenticate() separately before any new mutation. Explicit credential
   * revocation and terminal goals deny even receipt reconciliation.
   * @param {string} secret @returns {Extract<import('./types.d.ts').Authority, {kind: 'agent'}>}
   */
  receiptAuthority(secret) {
    requireValue(typeof secret === 'string' && secret.length >= 32 && secret.length <= 128, 'Invalid agent credential', 'UNAUTHORIZED');
    const row = this.store.db.prepare('SELECT authority FROM agent_credentials WHERE digest = ? AND revoked = 0').get(this.digest(secret));
    requireValue(row, 'Invalid agent credential', 'UNAUTHORIZED');
    const authority = /** @type {Extract<import('./types.d.ts').Authority, {kind: 'agent'}>} */ (JSON.parse(String(row.authority)));
    const goal = this.store.get(authority.goalId);
    requireValue(goal, 'Agent goal is unavailable', 'UNAUTHORIZED');
    requireValue(!['aborted', 'merged'].includes(goal.status), 'Agent authority was revoked', 'FORBIDDEN');
    return authority;
  }
  /** @param {string} goalId @param {string} attemptId */
  revoke(goalId, attemptId) { this.store.db.prepare('UPDATE agent_credentials SET revoked = 1 WHERE goal_id = ? AND attempt_id = ?').run(goalId, attemptId); }
}
