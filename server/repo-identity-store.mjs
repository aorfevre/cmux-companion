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
`;

// A commit time is part of what its sha hashes, so a row here cannot become
// wrong. It can only become unused. This cap exists to bound the file, not to
// expire anything.
const MAX_COMMIT_TIMES = 5_000;
const SHA = /^[0-9a-f]{40}$/;

export class RepoIdentityStore {
  constructor({ path = process.env.CMUX_COMPANION_REPO_DB || DEFAULT_PATH } = {}) {
    this.path = path;
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
