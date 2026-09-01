import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_PATH = join(homedir(), ".config", "cmux-companion", "goal-plans.db");

// A plan row is small, but its event log grows one row per round. Cap what a
// single repository can accumulate so an abandoned plan never becomes a leak.
const MAX_PLANS = 200;
const MAX_EVENT_BYTES = 64 * 1024;

export const PLAN_EVENT_KINDS = new Set([
  "goal", "questions", "answers", "tasks", "edit", "launch",
  "task_ready", "task_pending", "integration_started", "task_integrated", "delivery_failed", "final_pr",
  "merge_launched", "merge_blocked",
]);
// A round either asked questions or returned the split. Any other stage is a
// caller mistake, and storing it would make a reloaded plan unreadable.
const PLAN_STAGES = new Set(["questions", "ready"]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  plan_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  repository_name TEXT,
  cwd TEXT,
  goal TEXT NOT NULL,
  images TEXT NOT NULL DEFAULT '[]',
  source_type TEXT,
  issue_numbers TEXT NOT NULL DEFAULT '[]',
  issue_urls TEXT NOT NULL DEFAULT '[]',
  delivery_policy TEXT NOT NULL DEFAULT 'auto',
  session_id TEXT,
  round INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  stage TEXT NOT NULL DEFAULT 'questions',
  questions TEXT NOT NULL DEFAULT '[]',
  base_ref TEXT,
  base_sha TEXT,
  delivery_mode TEXT NOT NULL DEFAULT 'single',
  delivery_status TEXT NOT NULL DEFAULT 'planning',
  integration_branch TEXT,
  integration_worktree_path TEXT,
  final_pr_number INTEGER,
  final_pr_url TEXT,
  delivery_error TEXT,
  verified_at TEXT,
  cmux_group_id TEXT,
  merge_workspace_id TEXT,
  merge_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  launched_at TEXT
);
CREATE TABLE IF NOT EXISTS plan_tasks (
  plan_id TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  branch TEXT NOT NULL,
  prompt TEXT NOT NULL,
  agent TEXT,
  agent_reason TEXT,
  launch_status TEXT,
  launch_error TEXT,
  worktree_path TEXT,
  workspace_id TEXT,
  head_sha TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  integrated_commit_sha TEXT,
  PRIMARY KEY (plan_id, task_id)
);
CREATE TABLE IF NOT EXISTS plan_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
  round INTEGER,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plans_repository_updated ON plans (repository_id, updated_at);
CREATE INDEX IF NOT EXISTS plan_events_plan_id ON plan_events (plan_id, id);
`;

// Every write goes through this class, so the planner never holds SQL and the
// tests can point the whole flow at a temporary file.
export class WorktreePlanStore {
  constructor({ path = process.env.CMUX_COMPANION_PLANS_DB || DEFAULT_PATH, now = () => new Date() } = {}) {
    this.path = path;
    this.now = now;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    // WAL keeps a reader from blocking the round that is writing. It is a no-op
    // on an in-memory database, which is what the fast tests use.
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.#migrate();
    if (path !== ":memory:") {
      // The goal text and the task prompts describe private work, so the file
      // stays readable by its owner only, like every other companion file.
      try { chmodSync(path, 0o600); } catch { /* a database on a filesystem without modes */ }
    }
  }

  // The opening goal. It is the only row that creates a plan.
  createPlan({ planId, repositoryId, repositoryName = null, cwd = null, goal, images = [], sourceType = null, issueNumbers = [], issueUrls = [], deliveryPolicy = "auto" }) {
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO plans (plan_id, repository_id, repository_name, cwd, goal, images, source_type, issue_numbers, issue_urls, delivery_policy, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(planId, repositoryId, repositoryName, cwd, goal, json(images), text(sourceType), json(issueNumbers), json(issueUrls), policy(deliveryPolicy), at, at);
      this.#insertEvent(planId, 0, "goal", { goal, images, sourceType, issueNumbers, issueUrls, deliveryPolicy: policy(deliveryPolicy) }, at);
    });
    this.#prune();
    return this.get(planId);
  }

  // One round of the conversation: the plan row, its task rows and the event
  // that explains them all land together, or none of them land.
  recordRound(planId, { round, stage, sessionId = null, questions = [], tasks = [], answers = null, skipped = false }) {
    if (!PLAN_STAGES.has(stage)) throw new TypeError(`Unknown plan stage ${stage}`);
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plans SET round = ?, stage = ?, session_id = ?, questions = ?,
          delivery_mode = CASE WHEN delivery_policy = 'combined' THEN 'combined' ELSE ? END,
          updated_at = ? WHERE plan_id = ?
      `).run(round, stage, sessionId, json(questions), deliveryMode(tasks), at, planId);
      // An answered round replaces the previous task list wholesale, because the
      // planner returns a fresh split rather than a patch.
      this.#replaceTasks(planId, tasks);
      if (answers !== null || skipped) this.#insertEvent(planId, round, "answers", { answers: answers || [], skipped }, at);
      if (stage === "questions") this.#insertEvent(planId, round, "questions", { questions }, at);
      else this.#insertEvent(planId, round, "tasks", { tasks }, at);
    });
    return this.get(planId);
  }

  // A user edit through PATCH. It never changes the round or the stage.
  recordEdit(planId, tasks) {
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plans SET delivery_mode = CASE WHEN delivery_policy = 'combined' THEN 'combined' ELSE ? END,
          updated_at = ? WHERE plan_id = ?
      `).run(deliveryMode(tasks), at, planId);
      this.#replaceTasks(planId, tasks);
      this.#insertEvent(planId, null, "edit", { tasks }, at);
    });
    return this.get(planId);
  }

  // The launch outcome, one row per task plus one event for the whole run.
  recordLaunch(planId, { base = null, baseSha = null, results = [] } = {}) {
    const at = this.#stamp();
    const launched = results.filter((item) => item?.status === "launched").length;
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plans SET status = ?, base_ref = ?, base_sha = ?, delivery_status = ?, launched_at = ?, updated_at = ? WHERE plan_id = ?
      `).run(
        launched > 0 ? "launched" : "draft",
        base,
        text(baseSha),
        launched > 0 ? "implementing" : "planning",
        launched > 0 ? at : null,
        at,
        planId,
      );
      const update = this.db.prepare(`
        UPDATE plan_tasks SET launch_status = ?, launch_error = ?, worktree_path = ?, workspace_id = ?
        WHERE plan_id = ? AND task_id = ?
      `);
      for (const result of results) {
        update.run(
          text(result?.status),
          text(result?.error),
          text(result?.path),
          workspaceId(result?.workspace),
          planId,
          String(result?.id || ""),
        );
      }
      this.#insertEvent(planId, null, "launch", { base, baseSha, launched, results }, at);
    });
    return this.get(planId);
  }

  findTaskByWorkspace(workspaceIdValue) {
    const id = text(workspaceIdValue);
    if (!id) return null;
    const row = this.db.prepare(`
      SELECT t.plan_id, t.task_id FROM plan_tasks t
      JOIN plans p ON p.plan_id = t.plan_id
      WHERE t.workspace_id = ? AND p.status = 'launched' AND p.delivery_mode = 'combined'
      LIMIT 1
    `).get(id);
    if (!row) return null;
    const plan = this.get(row.plan_id);
    return plan ? { plan, task: plan.tasks.find((task) => task.id === row.task_id) || null } : null;
  }

  findPlanByMergeWorkspace(workspaceIdValue) {
    const id = text(workspaceIdValue);
    if (!id) return null;
    const row = this.db.prepare(
      "SELECT plan_id FROM plans WHERE merge_workspace_id = ? AND merge_status = 'running' LIMIT 1",
    ).get(id);
    return row ? this.get(row.plan_id) : null;
  }

  activeCombinedPlans() {
    return this.db.prepare(`
      SELECT plan_id FROM plans
      WHERE status = 'launched' AND delivery_mode = 'combined' AND final_pr_url IS NULL
      ORDER BY updated_at
    `).all().map((row) => this.get(row.plan_id)).filter(Boolean);
  }

  recordTaskReady(planId, taskId, headSha) {
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plan_tasks SET head_sha = ?, delivery_status = 'ready'
        WHERE plan_id = ? AND task_id = ?
      `).run(String(headSha), String(planId), String(taskId));
      this.db.prepare("UPDATE plans SET updated_at = ? WHERE plan_id = ?").run(at, String(planId));
      this.#insertEvent(String(planId), null, "task_ready", { taskId, headSha }, at);
    });
    return this.get(planId);
  }

  recordTaskPending(planId, taskId) {
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plan_tasks SET head_sha = NULL, delivery_status = 'pending'
        WHERE plan_id = ? AND task_id = ?
      `).run(String(planId), String(taskId));
      this.db.prepare("UPDATE plans SET updated_at = ? WHERE plan_id = ?").run(at, String(planId));
      this.#insertEvent(String(planId), null, "task_pending", { taskId }, at);
    });
    return this.get(planId);
  }

  recordIntegrationStarted(planId, { branch, path }) {
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plans SET delivery_status = 'assembling', integration_branch = ?,
          integration_worktree_path = ?, delivery_error = NULL, updated_at = ? WHERE plan_id = ?
      `).run(String(branch), String(path), at, String(planId));
      this.#insertEvent(String(planId), null, "integration_started", { branch, path }, at);
    });
    return this.get(planId);
  }

  // The cmux group is presentation, so it is stored on its own and never joins
  // a delivery transition. A lost group id only costs a fresh lookup by name.
  recordGroup(planId, groupId) {
    const at = this.#stamp();
    this.db.prepare("UPDATE plans SET cmux_group_id = ?, updated_at = ? WHERE plan_id = ?")
      .run(text(groupId), at, String(planId));
    return this.get(planId);
  }

  recordMergeLaunched(planId, workspaceId) {
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plans SET merge_workspace_id = ?, merge_status = 'running',
          delivery_status = 'assembling', delivery_error = NULL, updated_at = ? WHERE plan_id = ?
      `).run(text(workspaceId), at, String(planId));
      this.#insertEvent(String(planId), null, "merge_launched", { workspaceId }, at);
    });
    return this.get(planId);
  }

  // The merge agent stopped without a pull request. The worktree and the live
  // session are both kept, because a retry continues them rather than restarting.
  recordMergeBlocked(planId, reason) {
    const at = this.#stamp();
    const message = String(reason || "The merge agent stopped without opening a pull request").slice(0, 2_000);
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plans SET merge_status = 'blocked', delivery_status = 'blocked',
          delivery_error = ?, updated_at = ? WHERE plan_id = ?
      `).run(message, at, String(planId));
      this.#insertEvent(String(planId), null, "merge_blocked", { error: message }, at);
    });
    return this.get(planId);
  }

  recordTaskIntegrated(planId, taskId, commitSha) {
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plan_tasks SET integrated_commit_sha = ?, delivery_status = 'integrated'
        WHERE plan_id = ? AND task_id = ?
      `).run(String(commitSha), String(planId), String(taskId));
      this.db.prepare("UPDATE plans SET updated_at = ? WHERE plan_id = ?").run(at, String(planId));
      this.#insertEvent(String(planId), null, "task_integrated", { taskId, commitSha }, at);
    });
    return this.get(planId);
  }

  recordDeliveryFailure(planId, error) {
    const at = this.#stamp();
    const message = String(error || "Combined delivery failed").slice(0, 2_000);
    this.#transaction(() => {
      // A running merge is demoted with the plan: leaving it running would
      // route the merge agent's Stop to a settle that refuses it, while the
      // user reads the plan as blocked.
      this.db.prepare(`
        UPDATE plans SET delivery_status = 'blocked', delivery_error = ?,
          merge_status = CASE merge_status WHEN 'running' THEN 'blocked' ELSE merge_status END,
          updated_at = ? WHERE plan_id = ?
      `).run(message, at, String(planId));
      this.#insertEvent(String(planId), null, "delivery_failed", { error: message }, at);
    });
    return this.get(planId);
  }

  recordFinalPr(planId, { number = null, url, verifiedAt = null }) {
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plans SET delivery_status = 'pr_open', merge_status = 'done', final_pr_number = ?,
          final_pr_url = ?, delivery_error = NULL, verified_at = ?, updated_at = ? WHERE plan_id = ?
      `).run(Number.isInteger(number) ? number : null, String(url), verifiedAt || at, at, String(planId));
      this.#insertEvent(String(planId), null, "final_pr", { number, url, verifiedAt: verifiedAt || at }, at);
    });
    return this.get(planId);
  }

  get(planId) {
    const row = this.db.prepare("SELECT * FROM plans WHERE plan_id = ?").get(String(planId || ""));
    if (!row) return null;
    const tasks = this.db
      .prepare("SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY position")
      .all(row.plan_id)
      .map(readTask);
    return { ...readPlan(row), tasks };
  }

  events(planId, { limit = 200 } = {}) {
    return this.db
      .prepare("SELECT round, kind, payload, created_at FROM plan_events WHERE plan_id = ? ORDER BY id LIMIT ?")
      .all(String(planId || ""), clampLimit(limit, 500))
      .map((row) => ({
        round: row.round,
        kind: row.kind,
        payload: parse(row.payload, {}),
        createdAt: row.created_at,
      }));
  }

  // The list view never needs the prompts, so it reads a summary row and one
  // counted join instead of every task body.
  list({ repositoryId = null, status = null, limit = 50 } = {}) {
    const clauses = [];
    const values = [];
    if (repositoryId) { clauses.push("p.repository_id = ?"); values.push(String(repositoryId)); }
    if (status && status !== "all") { clauses.push("p.status = ?"); values.push(String(status)); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(clampLimit(limit, 200));
    return this.db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM plan_tasks t WHERE t.plan_id = p.plan_id) AS task_count
      FROM plans p ${where} ORDER BY p.updated_at DESC, p.plan_id DESC LIMIT ?
    `).all(...values).map((row) => ({
      planId: row.plan_id,
      repositoryId: row.repository_id,
      repositoryName: row.repository_name,
      goal: row.goal,
      round: row.round,
      status: row.status,
      stage: row.stage,
      deliveryMode: row.delivery_mode,
      deliveryStatus: row.delivery_status,
      finalPrNumber: row.final_pr_number,
      finalPrUrl: row.final_pr_url,
      issueNumbers: parse(row.issue_numbers, []),
      deliveryPolicy: row.delivery_policy || "auto",
      taskCount: row.task_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      launchedAt: row.launched_at,
    }));
  }

  delete(planId) {
    // The two child tables cascade, so one statement removes the whole plan.
    const result = this.db.prepare("DELETE FROM plans WHERE plan_id = ?").run(String(planId || ""));
    return Number(result.changes) > 0;
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }

  #replaceTasks(planId, tasks) {
    this.db.prepare("DELETE FROM plan_tasks WHERE plan_id = ?").run(planId);
    const insert = this.db.prepare(`
      INSERT INTO plan_tasks (plan_id, task_id, position, title, branch, prompt, agent, agent_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    (Array.isArray(tasks) ? tasks : []).forEach((task, index) => {
      insert.run(
        planId,
        String(task?.id || `t${index + 1}`),
        index,
        String(task?.title || ""),
        String(task?.branch || ""),
        String(task?.prompt || ""),
        text(task?.agent),
        text(task?.agentReason),
      );
    });
  }

  #insertEvent(planId, round, kind, payload, at) {
    if (!PLAN_EVENT_KINDS.has(kind)) throw new TypeError(`Unknown plan event ${kind}`);
    const body = json(payload);
    this.db.prepare(`
      INSERT INTO plan_events (plan_id, round, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)
    `).run(planId, round === null || round === undefined ? null : Number(round), kind, body.slice(0, MAX_EVENT_BYTES), at);
  }

  #migrate() {
    const ensure = (table, column, declaration) => {
      const columns = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
      if (!columns.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    };
    ensure("plans", "base_sha", "TEXT");
    ensure("plans", "source_type", "TEXT");
    ensure("plans", "issue_numbers", "TEXT NOT NULL DEFAULT '[]'");
    ensure("plans", "issue_urls", "TEXT NOT NULL DEFAULT '[]'");
    ensure("plans", "delivery_policy", "TEXT NOT NULL DEFAULT 'auto'");
    ensure("plans", "delivery_mode", "TEXT NOT NULL DEFAULT 'single'");
    ensure("plans", "delivery_status", "TEXT NOT NULL DEFAULT 'planning'");
    ensure("plans", "integration_branch", "TEXT");
    ensure("plans", "integration_worktree_path", "TEXT");
    ensure("plans", "final_pr_number", "INTEGER");
    ensure("plans", "final_pr_url", "TEXT");
    ensure("plans", "delivery_error", "TEXT");
    ensure("plans", "verified_at", "TEXT");
    ensure("plans", "cmux_group_id", "TEXT");
    ensure("plans", "merge_workspace_id", "TEXT");
    ensure("plans", "merge_status", "TEXT");
    ensure("plan_tasks", "head_sha", "TEXT");
    ensure("plan_tasks", "delivery_status", "TEXT NOT NULL DEFAULT 'pending'");
    ensure("plan_tasks", "integrated_commit_sha", "TEXT");
  }

  // node:sqlite has no transaction helper, so BEGIN/COMMIT is written out. A
  // throw inside the body rolls the whole round back.
  #transaction(run) {
    this.db.exec("BEGIN");
    try {
      run();
      this.db.exec("COMMIT");
    } catch (cause) {
      try { this.db.exec("ROLLBACK"); } catch { /* the transaction already ended */ }
      throw cause;
    }
  }

  #prune() {
    const total = this.db.prepare("SELECT COUNT(*) AS total FROM plans").get()?.total ?? 0;
    if (Number(total) <= MAX_PLANS) return;
    this.db.prepare(`
      DELETE FROM plans WHERE plan_id IN (
        SELECT plan_id FROM plans ORDER BY updated_at DESC, plan_id DESC LIMIT -1 OFFSET ?
      )
    `).run(MAX_PLANS);
  }

  #stamp() {
    return this.now().toISOString();
  }
}

function readPlan(row) {
  return {
    planId: row.plan_id,
    repositoryId: row.repository_id,
    repositoryName: row.repository_name,
    cwd: row.cwd,
    goal: row.goal,
    images: parse(row.images, []),
    sourceType: row.source_type,
    issueNumbers: parse(row.issue_numbers, []),
    issueUrls: parse(row.issue_urls, []),
    deliveryPolicy: row.delivery_policy || "auto",
    sessionId: row.session_id,
    round: row.round,
    status: row.status,
    stage: row.stage,
    questions: parse(row.questions, []),
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    deliveryMode: row.delivery_mode || "single",
    deliveryStatus: row.delivery_status || "planning",
    integrationBranch: row.integration_branch,
    integrationWorktreePath: row.integration_worktree_path,
    finalPrNumber: row.final_pr_number,
    finalPrUrl: row.final_pr_url,
    deliveryError: row.delivery_error,
    verifiedAt: row.verified_at,
    cmuxGroupId: row.cmux_group_id,
    mergeWorkspaceId: row.merge_workspace_id,
    mergeStatus: row.merge_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    launchedAt: row.launched_at,
  };
}

function readTask(row) {
  return {
    id: row.task_id,
    title: row.title,
    branch: row.branch,
    prompt: row.prompt,
    agent: row.agent,
    agentReason: row.agent_reason,
    launchStatus: row.launch_status,
    launchError: row.launch_error,
    worktreePath: row.worktree_path,
    workspaceId: row.workspace_id,
    headSha: row.head_sha,
    deliveryStatus: row.delivery_status || "pending",
    integratedCommitSha: row.integrated_commit_sha,
  };
}

function deliveryMode(tasks) {
  return Array.isArray(tasks) && tasks.length > 1 ? "combined" : "single";
}

function policy(value) {
  return value === "combined" ? "combined" : "auto";
}

// cmux answers with one of several id fields depending on its version, so read
// each of them rather than losing the link to the workspace that was created.
function workspaceId(workspace) {
  if (!workspace || typeof workspace !== "object") return null;
  return text(workspace.workspace_id ?? workspace.workspaceId ?? workspace.id);
}

function text(value) {
  return typeof value === "string" && value ? value : null;
}

function json(value) {
  try { return JSON.stringify(value ?? null); } catch { return "null"; }
}

function parse(value, fallback) {
  try {
    const parsed = JSON.parse(String(value ?? ""));
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function clampLimit(value, max) {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return max;
  return Math.min(Math.floor(limit), max);
}
