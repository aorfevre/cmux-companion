import { randomUUID } from 'node:crypto';
/** @param {import('node:sqlite').DatabaseSync} db */
export function initializeSchema(db) {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (version !== 0 && version !== 1) throw new Error(`Unsupported orchestration database version ${version}`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY, version INTEGER NOT NULL, generation INTEGER NOT NULL,
      repository_id TEXT NOT NULL, status TEXT NOT NULL, state TEXT NOT NULL CHECK(json_valid(state)),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contracts (
      goal_id TEXT NOT NULL REFERENCES goals(id), revision INTEGER NOT NULL,
      body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(goal_id, revision)
    );
    CREATE TABLE IF NOT EXISTS attempts (
      goal_id TEXT NOT NULL REFERENCES goals(id), id TEXT NOT NULL, generation INTEGER NOT NULL,
      revision INTEGER NOT NULL, role TEXT NOT NULL, mode TEXT NOT NULL, task_id TEXT,
      target TEXT NOT NULL, status TEXT NOT NULL, worker_state TEXT NOT NULL,
      body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(goal_id, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_owned_attempt ON attempts
      (goal_id, generation, revision, role, COALESCE(task_id, ''), target) WHERE worker_state != 'stopped';
    CREATE UNIQUE INDEX IF NOT EXISTS one_task_worker ON attempts(goal_id, task_id) WHERE worker_state != 'stopped' AND role = 'implementer';
    CREATE UNIQUE INDEX IF NOT EXISTS one_integration_worker ON attempts(goal_id) WHERE worker_state != 'stopped' AND role = 'integrator';
    CREATE TABLE IF NOT EXISTS ready_work (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL REFERENCES goals(id),
      generation INTEGER NOT NULL, revision INTEGER NOT NULL, work_key TEXT NOT NULL,
      body TEXT NOT NULL CHECK(json_valid(body)), UNIQUE(goal_id, generation, revision, work_key)
    );
    CREATE TABLE IF NOT EXISTS command_receipts (
      goal_id TEXT NOT NULL REFERENCES goals(id), id TEXT NOT NULL,
      input_hash TEXT NOT NULL, authority_hash TEXT NOT NULL,
      result TEXT NOT NULL CHECK(json_valid(result)), PRIMARY KEY(goal_id, id)
    );
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), kind TEXT NOT NULL,
      generation INTEGER NOT NULL, revision INTEGER NOT NULL, attempt_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending', body TEXT NOT NULL CHECK(json_valid(body)),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL REFERENCES goals(id),
      version INTEGER NOT NULL, generation INTEGER NOT NULL, revision INTEGER NOT NULL,
      command_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1,
      kind TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS goal_events ON events(goal_id, id);
    CREATE TABLE IF NOT EXISTS consumers (id TEXT PRIMARY KEY, cursor INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS journal_identity (id INTEGER PRIMARY KEY CHECK(id = 1), identity TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS journal_meta (id INTEGER PRIMARY KEY CHECK(id = 1), floor INTEGER NOT NULL);
    INSERT OR IGNORE INTO journal_meta(id, floor) VALUES (1, 0);
    PRAGMA user_version = 1;
  `);
  db.prepare('INSERT OR IGNORE INTO journal_identity(id,identity) VALUES (1,?)').run(randomUUID());
}
