import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BURST_ID, CANDIDATE_STATUSES, MAX_BURST_GOAL, REPOSITORY_ID, normalizeProposal } from "./burst-contract.mjs";

// One burst is one scan of the starred repositories. Its candidates live in
// their own file, separate from goal-plans.db: a burst is a proposal set, and
// a goal it approves is an ordinary plan row over there.
const DEFAULT_PATH = join(homedir(), ".config", "cmux-companion", "bursts.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS burst_plans (
  burst_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  capacity_snapshot TEXT
);
CREATE TABLE IF NOT EXISTS burst_candidates (
  burst_id TEXT NOT NULL REFERENCES burst_plans(burst_id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  goal TEXT,
  rationale TEXT,
  evidence TEXT NOT NULL DEFAULT '[]',
  size_estimate TEXT,
  status TEXT NOT NULL DEFAULT 'scanning',
  reason TEXT,
  plan_id TEXT,
  position INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (burst_id, repository_id)
);
`;

export class BurstStore {
  constructor({ path = process.env.CMUX_COMPANION_BURSTS_DB || DEFAULT_PATH, now = () => new Date() } = {}) {
    this.now = now;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    // WAL keeps a reader from blocking a scan that is writing. It is a no-op on
    // an in-memory database, which is what the tests use.
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    if (path !== ":memory:") {
      // Proposed goals describe private work, so the file stays owner-readable.
      try { chmodSync(path, 0o600); } catch { /* a database on a filesystem without modes */ }
    }
  }

  create({ burstId, capacitySnapshot = null, repositories = [] }) {
    const id = identifier(burstId);
    const list = repositories.map((repository) => {
      if (!REPOSITORY_ID.test(String(repository?.id || ""))) throw new TypeError("Invalid repository");
      return { id: repository.id, name: String(repository.name || repository.id).slice(0, 200) };
    });
    if (!list.length) throw new TypeError("A burst needs at least one starred repository");
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare("INSERT INTO burst_plans (burst_id, created_at, updated_at, capacity_snapshot) VALUES (?, ?, ?, ?)")
        .run(id, at, at, capacitySnapshot ? JSON.stringify(capacitySnapshot) : null);
      const insert = this.db.prepare("INSERT INTO burst_candidates (burst_id, repository_id, repository_name, position, updated_at) VALUES (?, ?, ?, ?, ?)");
      list.forEach((repository, index) => insert.run(id, repository.id, repository.name, index, at));
    });
    return this.get(id);
  }

  recordProposal(burstId, repositoryId, proposal) {
    const clean = normalizeProposal(proposal);
    return this.#updateCandidate(burstId, repositoryId, ["scanning"], "proposed", {
      goal: clean.goal, rationale: clean.rationale, evidence: JSON.stringify(clean.evidence), size_estimate: clean.sizeEstimate, reason: null,
    });
  }

  recordFailure(burstId, repositoryId, reason) {
    return this.#updateCandidate(burstId, repositoryId, ["scanning"], "failed", { reason: String(reason || "The scan failed").slice(0, 2_000) });
  }

  recordApproval(burstId, repositoryId, { planId, goal }) {
    const current = this.#candidate(burstId, repositoryId);
    if (!current) throw new TypeError("Unknown burst candidate");
    if (current.status === "approved") throw new TypeError("This candidate is already approved");
    if (current.status !== "proposed") throw new TypeError("Only a proposed candidate can be approved");
    const text = String(goal ?? current.goal ?? "").trim();
    if (!text) throw new TypeError("An approved candidate needs a goal");
    return this.#updateCandidate(burstId, repositoryId, ["proposed"], "approved", { plan_id: String(planId), goal: text.slice(0, MAX_BURST_GOAL) });
  }

  recordDecline(burstId, repositoryId) {
    return this.#updateCandidate(burstId, repositoryId, ["proposed", "failed"], "declined", {});
  }

  resetForScan(burstId, repositoryId) {
    return this.#updateCandidate(burstId, repositoryId, ["proposed", "failed", "declined"], "scanning", { reason: null, plan_id: null });
  }

  get(burstId) {
    const row = this.db.prepare("SELECT * FROM burst_plans WHERE burst_id = ?").get(String(burstId || ""));
    if (!row) return null;
    const candidates = this.db.prepare("SELECT * FROM burst_candidates WHERE burst_id = ? ORDER BY position").all(row.burst_id).map(readCandidate);
    return readBurst(row, candidates);
  }

  list({ limit = 20 } = {}) {
    const rows = this.db.prepare("SELECT burst_id FROM burst_plans ORDER BY created_at DESC, burst_id DESC LIMIT ?")
      .all(Math.max(1, Math.min(100, Number(limit) || 20)));
    return rows.map((row) => this.get(row.burst_id));
  }

  close() { this.db.close(); }

  #candidate(burstId, repositoryId) {
    const row = this.db.prepare("SELECT * FROM burst_candidates WHERE burst_id = ? AND repository_id = ?").get(String(burstId || ""), String(repositoryId || ""));
    return row ? readCandidate(row) : null;
  }

  // Every transition names the states it may leave, so a stale caller (a scan
  // that finishes after a rescan reset the row) fails instead of overwriting.
  #updateCandidate(burstId, repositoryId, fromStatuses, toStatus, fields) {
    if (!CANDIDATE_STATUSES.includes(toStatus)) throw new TypeError(`Unknown candidate status ${toStatus}`);
    const at = this.#stamp();
    const keys = Object.keys(fields);
    const assignments = ["status = ?", "updated_at = ?", ...keys.map((key) => `${key} = ?`)].join(", ");
    const placeholders = fromStatuses.map(() => "?").join(", ");
    let changed = 0;
    this.#transaction(() => {
      changed = this.db.prepare(`UPDATE burst_candidates SET ${assignments} WHERE burst_id = ? AND repository_id = ? AND status IN (${placeholders})`)
        .run(toStatus, at, ...keys.map((key) => fields[key]), String(burstId || ""), String(repositoryId || ""), ...fromStatuses).changes;
      if (changed) this.db.prepare("UPDATE burst_plans SET updated_at = ? WHERE burst_id = ?").run(at, String(burstId || ""));
    });
    if (changed !== 1) throw new TypeError(`This candidate cannot move to ${toStatus} from its current state`);
    return this.#candidate(burstId, repositoryId);
  }

  #transaction(run) {
    this.db.exec("BEGIN IMMEDIATE");
    try { run(); this.db.exec("COMMIT"); }
    catch (cause) { this.db.exec("ROLLBACK"); throw cause; }
  }

  #stamp() { return this.now().toISOString(); }
}

function identifier(value) {
  const id = String(value || "");
  if (!BURST_ID.test(id)) throw new TypeError("Invalid burst id");
  return id;
}

// Burst status is derived, never stored: the candidates are the truth.
function readBurst(row, candidates) {
  const status = candidates.some((c) => c.status === "scanning") ? "scanning"
    : candidates.every((c) => ["approved", "declined", "failed"].includes(c.status)) ? "closed" : "ready";
  let capacitySnapshot = null;
  try { capacitySnapshot = row.capacity_snapshot ? JSON.parse(row.capacity_snapshot) : null; } catch { capacitySnapshot = null; }
  return { burstId: row.burst_id, createdAt: row.created_at, updatedAt: row.updated_at, status, capacitySnapshot, candidates };
}

function readCandidate(row) {
  let evidence = [];
  try { evidence = JSON.parse(row.evidence || "[]"); } catch { evidence = []; }
  return {
    repositoryId: row.repository_id, repositoryName: row.repository_name, goal: row.goal ?? null, rationale: row.rationale ?? null,
    evidence: Array.isArray(evidence) ? evidence : [], sizeEstimate: row.size_estimate ?? null, status: row.status,
    reason: row.reason ?? null, planId: row.plan_id ?? null, updatedAt: row.updated_at,
  };
}
