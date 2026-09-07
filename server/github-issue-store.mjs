import { readPrivateJson } from "./private-json-state.mjs";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_PATH = join(homedir(), ".config", "cmux-companion", "github-issues.json");
const REPOSITORY_ID = /^[A-Za-z0-9_-]{18}$/;

// The durable half of GitHub Sync. A synced issue must survive a page reload
// and a companion restart, so the column is rebuilt from this file and never
// from memory. The write is atomic (temp file plus rename) with the same
// permissions as server/repository-favorites.mjs: a 0o700 directory and a
// 0o600 file, because issue titles are private repository data.
export class GitHubIssueStore {
  constructor({ path = DEFAULT_PATH } = {}) {
    this.path = path;
    this.issues = new Map();
    this.syncedAt = null;
    this.load();
  }

  load() {
    const value = readPrivateJson(this.path, { issues: [], syncedAt: null }, value => value !== null && typeof value === "object" && Array.isArray(value.issues));
    const rows = Array.isArray(value?.issues) ? value.issues : [];
    this.issues = new Map();
    // A malformed row is dropped, never thrown. A corrupted file must degrade
    // to an empty column that the next sync refills, not to a companion that
    // refuses to start.
    for (const row of rows) {
      const issue = normalize(row);
      if (issue) this.issues.set(key(issue.repositoryId, issue.number), issue);
    }
    this.syncedAt = text(value?.syncedAt, 100) || null;
  }

  // Every stored issue as a board card, ordered by repository then issue
  // number, so the board renders the same card order on every read. The issue
  // body is deliberately left out: it is untrusted repository prose that only
  // the goal prompt needs.
  list() {
    return [...this.issues.values()].map((issue) => card(issue)).sort((left, right) => (
      left.repositoryName.localeCompare(right.repositoryName)
      || left.repositoryId.localeCompare(right.repositoryId)
      || left.number - right.number
    ));
  }

  get(repositoryId, number) {
    const issue = this.#find(repositoryId, number);
    return issue ? { ...issue, labels: [...issue.labels] } : null;
  }

  // Replaces the issues of the given repositories only. A repository that this
  // sync did not reach keeps its stored issues, so one `gh` failure never
  // empties a healthy repository's cards.
  replace(repositoryIds, issues, { syncedAt = new Date().toISOString() } = {}) {
    const scope = new Set((Array.isArray(repositoryIds) ? repositoryIds : []).filter((id) => typeof id === "string"));
    const kept = new Map();
    for (const [id, issue] of this.issues) if (!scope.has(issue.repositoryId)) kept.set(id, issue);
    for (const raw of Array.isArray(issues) ? issues : []) {
      const issue = normalize({ ...raw, syncedAt: text(raw?.syncedAt, 100) || syncedAt });
      if (!issue || !scope.has(issue.repositoryId)) continue;
      // A goal that already started stays started. The reconcile updates the
      // issue fields around that plan id; it never drops it.
      const previous = this.issues.get(key(issue.repositoryId, issue.number));
      if (previous?.planId && !issue.planId) issue.planId = previous.planId;
      kept.set(key(issue.repositoryId, issue.number), issue);
    }
    this.issues = kept;
    this.syncedAt = text(syncedAt, 100) || null;
    this.save();
    return this.list();
  }

  // Removes every issue of repositories that are no longer starred.
  retainRepositories(repositoryIds) {
    const keep = new Set((Array.isArray(repositoryIds) ? repositoryIds : []).filter((id) => typeof id === "string"));
    let changed = false;
    for (const [id, issue] of this.issues) {
      if (keep.has(issue.repositoryId)) continue;
      this.issues.delete(id);
      changed = true;
    }
    if (changed) this.save();
    return changed;
  }

  // Records the plan that one issue started. This is the field that makes the
  // card show its started state after a restart.
  setPlanId(repositoryId, number, planId) {
    const issue = this.#find(repositoryId, number);
    if (!issue) throw new TypeError("Unknown GitHub issue");
    issue.planId = text(planId, 200) || null;
    this.save();
    return card(issue);
  }

  #rows() {
    return [...this.issues.values()]
      .map((issue) => ({ ...issue, labels: [...issue.labels] }))
      .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId) || left.number - right.number);
  }

  #find(repositoryId, number) {
    return this.issues.get(key(String(repositoryId || ""), Number(number))) || null;
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // The file keeps the full row, body included; only the board projection
    // drops it.
    const payload = { syncedAt: this.syncedAt, issues: this.#rows() };
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }
}

function normalize(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const repositoryId = text(row.repositoryId, 100);
  const number = Number(row.number);
  const title = text(row.title, 500);
  if (!REPOSITORY_ID.test(repositoryId)) return null;
  if (!Number.isInteger(number) || number <= 0) return null;
  if (!title) return null;
  return {
    repositoryId,
    repositoryName: text(row.repositoryName, 200) || repositoryId,
    number,
    title,
    // The body is kept so a goal started after a restart carries the same
    // issue text that the sync read from GitHub.
    body: text(row.body, 4_000),
    labels: (Array.isArray(row.labels) ? row.labels : []).map((label) => text(label?.name || label, 100)).filter(Boolean).slice(0, 20),
    url: text(row.url, 1_000),
    updatedAt: text(row.updatedAt, 100),
    syncedAt: text(row.syncedAt, 100),
    planId: text(row.planId, 200) || null,
  };
}

// The API shape of one stored issue.
function card(issue) {
  const { body, ...rest } = issue;
  void body;
  return { ...rest, labels: [...issue.labels] };
}

function key(repositoryId, number) {
  return `${repositoryId}#${number}`;
}

function text(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
