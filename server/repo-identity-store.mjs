import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_PATH = join(homedir(), ".config", "cmux-companion", "repo-identity.db");

// A repository scan spawns one git child per command per path. On a machine
// with fifty repositories that is over a thousand processes, and the cost is
// the spawn, not the git work. This store holds the answers that cannot change
// without something observable changing with them.
//
// It is never a source of truth. Every read can answer null, and every caller
// must run the live git command when it does. A missing row, a corrupt file,
// and a key that no longer matches are all the same path through the code.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS commit_times (
  sha         TEXT PRIMARY KEY,
  commit_time INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS commit_times_updated ON commit_times (updated_at);

CREATE TABLE IF NOT EXISTS worktree_status (
  path         TEXT PRIMARY KEY,
  output       TEXT NOT NULL,
  -- The activity time read in the same instant as the status above. Storing it
  -- here keeps a served row internally consistent: the card shows one moment,
  -- not a status from now beside a timestamp from a minute ago.
  last_activity INTEGER NOT NULL DEFAULT 0,
  read_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS worktree_status_read ON worktree_status (read_at);
`;

// A commit time is part of what its sha hashes, so a row here cannot become
// wrong. It can only become unused. This cap exists to bound the file, not to
// expire anything.
const MAX_COMMIT_TIMES = 5_000;
const SHA = /^[0-9a-f]{40}$/;

// Unlike a commit time, a working tree changes with no signal at all: an agent
// writes a file and nothing observable moves. So this half is a real cache with
// a real staleness window, and it serves the display path only. Every path that
// deletes anything reads git directly, with different arguments, through
// repoCatalog.git — see WorktreeDashboard.assertStillClean.
const DEFAULT_STATUS_TTL_MS = 30_000;

export class RepoIdentityStore {
  constructor({ path = process.env.CMUX_COMPANION_REPO_DB || DEFAULT_PATH, statusTtlMs = Number(process.env.CMUX_COMPANION_STATUS_TTL_MS) || DEFAULT_STATUS_TTL_MS, now = Date.now } = {}) {
    this.path = path;
    this.statusTtlMs = Math.max(0, Number(statusTtlMs) || 0);
    this.now = now;
    // One throw from sqlite disables the store for the life of the process. A
    // broken file must not cost a try/catch and a log line per row forever.
    this.disabled = false;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    // Losing a row to a power cut costs one re-run of one git command, so the
    // full fsync per transaction buys nothing here.
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(SCHEMA);
    if (path !== ":memory:") {
      // Repository paths describe private work, like every other companion file.
      try { chmodSync(path, 0o600); } catch { /* a filesystem without modes */ }
    }
  }

  commitTime(sha) {
    if (this.disabled || !SHA.test(String(sha || ""))) return null;
    return this.#read(() => {
      const row = this.db.prepare("SELECT commit_time FROM commit_times WHERE sha = ?").get(sha);
      return row ? Number(row.commit_time) || null : null;
    });
  }

  // Written in one transaction per scan rather than one per row: node:sqlite is
  // synchronous, so a write per row would block the event loop the whole scan.
  rememberCommitTimes(entries) {
    if (this.disabled) return;
    const rows = (entries || []).filter(({ sha, commitTime }) => SHA.test(String(sha || "")) && Number.isFinite(Number(commitTime)) && Number(commitTime) > 0);
    if (!rows.length) return;
    this.#write(() => {
      const at = new Date().toISOString();
      const insert = this.db.prepare("INSERT OR REPLACE INTO commit_times (sha, commit_time, updated_at) VALUES (?, ?, ?)");
      this.db.exec("BEGIN");
      try {
        for (const { sha, commitTime } of rows) insert.run(sha, Math.trunc(Number(commitTime)), at);
        this.db.exec("COMMIT");
      } catch (cause) {
        this.db.exec("ROLLBACK");
        throw cause;
      }
    });
  }

  // The display copy of one worktree's status. Never call this before deleting
  // anything: a value up to the TTL old would say a worktree is clean while an
  // agent writes to it.
  status(path) {
    if (this.disabled || !path || this.statusTtlMs === 0) return null;
    return this.#read(() => {
      const row = this.db.prepare("SELECT output, last_activity, read_at FROM worktree_status WHERE path = ?").get(String(path));
      if (!row) return null;
      if (this.now() - Number(row.read_at) >= this.statusTtlMs) return null;
      return { output: String(row.output), lastActivity: Number(row.last_activity) || 0 };
    });
  }

  rememberStatuses(entries) {
    if (this.disabled || this.statusTtlMs === 0) return;
    const rows = (entries || []).filter(({ path, output }) => path && typeof output === "string");
    if (!rows.length) return;
    this.#write(() => {
      const at = this.now();
      const insert = this.db.prepare("INSERT OR REPLACE INTO worktree_status (path, output, last_activity, read_at) VALUES (?, ?, ?, ?)");
      this.db.exec("BEGIN");
      try {
        for (const { path, output, lastActivity } of rows) insert.run(String(path), output, Math.trunc(Number(lastActivity)) || 0, at);
        this.db.exec("COMMIT");
      } catch (cause) {
        this.db.exec("ROLLBACK");
        throw cause;
      }
    });
  }

  // Every place that used to null the catalog's in-memory cache must reach this
  // too, or a stored status outlives the invalidation those callers exist to
  // perform — a removed worktree would keep reporting its old state.
  forgetStatuses() {
    if (this.disabled) return;
    this.#write(() => { this.db.prepare("DELETE FROM worktree_status").run(); });
  }

  // Bounded by row count rather than by age, because age says nothing about
  // whether a commit is still checked out somewhere.
  prune() {
    if (this.disabled) return;
    this.#write(() => {
      this.db.prepare(`
        DELETE FROM commit_times WHERE sha NOT IN (
          SELECT sha FROM commit_times ORDER BY updated_at DESC, sha DESC LIMIT ?
        )
      `).run(MAX_COMMIT_TIMES);
      // An expired status row is dead weight, not a fallback: the reader
      // already refuses it. Age is the right measure here, unlike above.
      this.db.prepare("DELETE FROM worktree_status WHERE read_at < ?").run(this.now() - this.statusTtlMs);
    });
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }

  #read(operation) {
    try { return operation(); }
    catch { this.disabled = true; return null; }
  }

  #write(operation) {
    try { operation(); }
    catch { this.disabled = true; }
  }
}

// The store is an optimisation. A database that cannot be opened at all must
// leave the companion running fully live, not stop it from starting.
export function openRepoIdentityStore(options = {}, log = null) {
  try { return new RepoIdentityStore(options); }
  catch (cause) {
    log?.warn?.({ err: cause }, "repository identity cache unavailable, reading git directly");
    return null;
  }
}
