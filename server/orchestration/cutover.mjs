import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { realpathSync, mkdirSync, existsSync } from 'node:fs';
import { isAbsolute, join, dirname, basename } from 'node:path';
import { canonicalJson, requireValue } from './domain/contracts.mjs';
import { processLiveness, SchedulerOwnership } from './storage/ownership.mjs';
import { OrchestrationStore } from './storage/store.mjs';
import { git } from './adapters/git.mjs';

/** @typedef {{legacyDatabases:string[]; legacyOwnerPids:number[]; legacySessionIds:string[]; inventoryDigest:string}} Cutover */
/** Read only: do not import the retired schema constructor or migrate its data.
 * Output intentionally excludes goal prompts, credentials and provider contexts.
 * @param {string[]} paths */
export function legacyInventory(paths) {
  const databases = paths.map(path => {
    requireValue(isAbsolute(path), 'Legacy database paths must be explicit and absolute');
    const canonical = realpathSync(path), db = new DatabaseSync(canonical, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name));
      requireValue(tables.includes('plans'), 'Unrecognized legacy database; inspect it before cutover', 'CUTOVER_REQUIRED');
      const columns = new Set(db.prepare('PRAGMA table_info(plans)').all().map(row => String(row.name)));
      requireValue(columns.has('plan_id') && columns.has('status'), 'Unrecognized legacy plan schema', 'CUTOVER_REQUIRED');
      const fields = ['plan_id', 'status', 'board_status', 'goal_session_state', 'goal_session_workspace_id', 'review_workspace_id', 'session_id'].filter(name => columns.has(name));
      const rows = db.prepare(`SELECT ${fields.join(',')} FROM plans ORDER BY plan_id`).all();
      const inactive = new Set(['aborted', 'cancelled', 'completed', 'delivered', 'merged', 'archived', 'closed']);
      const plans = rows.map(row => ({ id: String(row.plan_id), status: String(row.status), active: !inactive.has(String(row.board_status || row.status)), sessions: [...new Set([row.goal_session_workspace_id, row.review_workspace_id, row.session_id].filter(value => typeof value === 'string' && value.length > 0))] }));
      const resources = [];
      for (const table of tables.filter(name => !name.startsWith('sqlite_'))) {
        requireValue(/^[A-Za-z0-9_]+$/.test(table), 'Unsupported legacy table identity');
        const fields = db.prepare(`PRAGMA table_info("${table}")`).all().map(row => String(row.name)).filter(name => /^[A-Za-z0-9_]+$/.test(name) && /(^|_)(workspace_id|session_id|pid)$/.test(name));
        if (fields.length) for (const row of db.prepare(`SELECT ${fields.map(name => `"${name}"`).join(',')} FROM "${table}"`).all()) {
          for (const field of fields) if (row[field] !== null) resources.push({ table, field, value: row[field] });
        }
      }
      resources.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
      return { path: canonical, plans, resources };
    } finally { db.close(); }
  });
  return { databases, digest: createHash('sha256').update(canonicalJson(databases)).digest('hex') };
}
/** @param {Cutover} cutover @param {{liveness?:(pid:number)=>string; sessions?:()=>Promise<string[]>}} [observers] */
export async function assertCutover(cutover, { liveness = processLiveness, sessions } = {}) {
  requireValue(cutover && Array.isArray(cutover.legacyDatabases) && Array.isArray(cutover.legacyOwnerPids) && Array.isArray(cutover.legacySessionIds), 'Explicit cutover inventory is required', 'CUTOVER_REQUIRED');
  const inventory = legacyInventory(cutover.legacyDatabases);
  requireValue(inventory.digest === cutover.inventoryDigest, 'Legacy inventory changed; rehearse cutover again', 'CUTOVER_REQUIRED');
  requireValue(!inventory.databases.some(database => database.plans.some(plan => plan.active)), 'Legacy goals must be drained or explicitly retired before startup', 'CUTOVER_REQUIRED');
  const recordedPids = inventory.databases.flatMap(database => database.resources.filter(resource => /(^|_)pid$/.test(resource.field)).map(resource => Number(resource.value)));
  for (const pid of [...new Set([...cutover.legacyOwnerPids, ...recordedPids])]) requireValue(Number.isSafeInteger(pid) && pid > 0 && liveness(pid) === 'dead', 'A legacy owner is alive or uncertain', 'OWNERSHIP_UNCERTAIN');
  const recorded = new Set([...cutover.legacySessionIds, ...inventory.databases.flatMap(database => database.plans.flatMap(plan => plan.sessions)), ...inventory.databases.flatMap(database => database.resources.filter(resource => /(^|_)workspace_id$/.test(resource.field)).map(resource => String(resource.value)))]);
  requireValue([...recorded].every(id => typeof id === 'string' && id.length > 0), 'Invalid recorded legacy session identity');
  if (recorded.size) {
    requireValue(sessions, 'Legacy session inventory requires a live read-only observer', 'CUTOVER_REQUIRED');
    requireValue(!(await sessions()).some(id => recorded.has(id)), 'Recorded legacy sessions are still present', 'OWNERSHIP_UNCERTAIN');
  }
  return inventory;
}
/** One kernel-checked owner per Git common directory prevents two new databases
 * from independently controlling the same repository. Constructors launch nothing.
 * @param {ReadonlyMap<string,string>} repositories @param {string} database */
export async function acquireRepositoryOwnership(repositories, database) {
  /** @type {{store:OrchestrationStore;owner:SchedulerOwnership}[]} */ const held = [];
  requireValue(isAbsolute(database), 'Explicit replacement database required');
  mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  const databaseIdentity = join(realpathSync(dirname(database)), basename(database));
  let workflowIdentity;
  if (existsSync(databaseIdentity)) {
    const existing = new DatabaseSync(databaseIdentity, { readOnly: true });
    try {
      const tables = new Set(existing.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
      requireValue(tables.has('journal_identity') && tables.has('goals'), 'Replacement database has an unrecognized identity', 'CUTOVER_REQUIRED');
      workflowIdentity = String(existing.prepare('SELECT identity FROM journal_identity WHERE id=1').get()?.identity);
    } finally { existing.close(); }
  } else {
    const initial = new OrchestrationStore({ path: databaseIdentity });
    workflowIdentity = initial.journalId; initial.close();
  }
  try {
    const commonPaths = new Set();
    for (const path of repositories.values()) {
      const root = realpathSync(path);
      requireValue((await git(root, ['rev-parse', '--show-toplevel'])).trim() === root, 'Repository allow-list root changed', 'OWNERSHIP_UNCERTAIN');
      commonPaths.add(realpathSync((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()));
    }
    for (const common of [...commonPaths].sort()) {
      const store = new OrchestrationStore({ path: join(common, 'companion-orchestration-owner.sqlite') });
      const owner = new SchedulerOwnership({ store });
      try {
        owner.acquire();
        store.db.exec('CREATE TABLE IF NOT EXISTS repository_binding(singleton INTEGER PRIMARY KEY CHECK(singleton=1), workflow_database TEXT NOT NULL, workflow_identity TEXT NOT NULL)');
        const previous = store.db.prepare('SELECT workflow_database,workflow_identity FROM repository_binding WHERE singleton=1').get();
        if (previous && previous.workflow_database === databaseIdentity) requireValue(previous.workflow_identity === workflowIdentity, 'Workflow database identity changed; reconcile the original state', 'OWNERSHIP_UNCERTAIN');
        if (previous && previous.workflow_database !== databaseIdentity) assertRollback(String(previous.workflow_database), String(previous.workflow_identity));
        held.push({ store, owner });
      } catch (error) { if (owner.acquired) owner.release(); store.close(); throw error; }
    }
    // Validate the complete repository set before changing any existing binding.
    // A refusal on a later repository must preserve earlier ownership history.
    for (const { store, owner } of held) {
      owner.assertOwned();
      store.db.prepare('INSERT INTO repository_binding VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET workflow_database=excluded.workflow_database,workflow_identity=excluded.workflow_identity').run(databaseIdentity, workflowIdentity);
    }
    return { assertOwned() { for (const entry of held) entry.owner.assertOwned(); }, close() { for (const entry of held.splice(0).reverse()) { try { entry.owner.release(); } finally { entry.store.close(); } } } };
  } catch (error) { for (const entry of held.reverse()) { try { entry.owner.release(); } finally { entry.store.close(); } } throw error; }
}
/** Rollback is a read-only decision. It never kills a worker or edits either DB.
 * @param {string} path @param {string} [expectedIdentity] */
export function assertRollback(path, expectedIdentity) {
  let canonical;
  try { canonical = realpathSync(path); }
  catch (error) {
    requireValue(/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT', 'Previously bound workflow database is missing; restore its recorded path before changing ownership', 'OWNERSHIP_UNCERTAIN');
    throw error;
  }
  const db = new DatabaseSync(canonical, { readOnly: true });
  try {
    const identity = db.prepare('SELECT identity FROM journal_identity WHERE id=1').get();
    requireValue(identity && (!expectedIdentity || identity.identity === expectedIdentity), 'Replacement journal identity changed', 'OWNERSHIP_UNCERTAIN');
    const ownerTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_owner'").get();
    const owner = ownerTable ? db.prepare('SELECT pid FROM scheduler_owner WHERE singleton=1').get() : null;
    requireValue(!owner || processLiveness(Number(owner.pid)) === 'dead', 'Replacement owner is still alive or uncertain', 'OWNERSHIP_UNCERTAIN');
    const goals = db.prepare('SELECT state FROM goals').all().map(row => JSON.parse(String(row.state)));
    requireValue(!goals.some(goal => goal.attempts.some(/** @param {{workerState:string}} a */ a => a.workerState !== 'stopped') || goal.verificationRuns?.some(/** @param {{workerState:string}} run */ run => run.workerState !== 'stopped')), 'Replacement workers remain active or uncertain', 'OWNERSHIP_UNCERTAIN');
    requireValue(!db.prepare("SELECT id FROM operations WHERE status!='completed' LIMIT 1").get(), 'Replacement effects remain unsettled', 'NOT_READY');
    return { safe: true, goals: goals.length };
  } finally { db.close(); }
}
