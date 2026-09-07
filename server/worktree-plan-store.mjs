import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { classifyLegacyWorktreeError } from "./worktree-errors.mjs";
import { normalizeSpecOptions } from "./spec-options.mjs";
import { safeReviewOptions } from "./review-options.mjs";

const DEFAULT_PATH = join(homedir(), ".config", "cmux-companion", "goal-plans.db");

// A plan row is small, but its event log grows one row per round. Cap what a
// store can accumulate. Records owning unretired sessions remain until cleanup
// succeeds, even when that temporarily exceeds this retention target.
const MAX_PLANS = 200;
// A full eight-task Delivery Contract can exceed 64 KiB once the spec and
// self-contained prompts share one historical event. Keep enough room for the
// validated maximum instead of truncating JSON into an unreadable event.
const MAX_EVENT_BYTES = 128 * 1024;

export const PLAN_EVENT_KINDS = new Set([
  "goal", "questions", "answers", "tasks", "feedback", "edit", "launch",
  "task_ready", "task_pending", "integration_started", "task_integrated", "delivery_failed", "final_pr",
  "merge_launched", "merge_blocked", "task_evidence", "wave_launched", "wave_integrated",
  "session_retired", "board_merged", "board_aborted", "board_pull_request",
  "task_relaunched", "task_skipped", "followup_launched", "task_associated",
  "review_claimed", "review_launched", "discussion", "merge_cleanup_required",
  "goal_session_started", "proposal_published", "proposal_changes_requested", "proposal_approved", "goal_session_transition",
]);
// The only two lifecycle states that are stored. Every other column of the
// board is derived, so a stored value that is neither of these is a bug.
const BOARD_STATUSES = new Set(["merged", "aborted"]);
// The pull-request states GitHub reports. A different word is a caller mistake.
const BOARD_PR_STATES = new Set(["OPEN", "CLOSED", "MERGED"]);
// The two verdicts a discussion can reach. `revision_suggested` carries the
// text the user can hand to the rejection flow; `none` carries nothing.
const DISCUSSION_IMPACTS = new Set(["none", "revision_suggested"]);
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
  engine_provider TEXT NOT NULL DEFAULT 'claude',
  engine_model TEXT NOT NULL DEFAULT 'default',
  engine_effort TEXT NOT NULL DEFAULT 'default',
  engine_reviewer INTEGER NOT NULL DEFAULT 0,
  spec_options TEXT NOT NULL DEFAULT '{}',
  review_options TEXT NOT NULL DEFAULT '{}',
  review_workspace_id TEXT,
  review_status TEXT,
  review_brief_path TEXT,
  review_launched_at TEXT,
  review_session_closed_at TEXT,
  session_id TEXT,
  round INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  stage TEXT NOT NULL DEFAULT 'questions',
  questions TEXT NOT NULL DEFAULT '[]',
  contract_version INTEGER NOT NULL DEFAULT 1,
  spec TEXT,
  readiness TEXT,
  last_error TEXT,
  last_error_at TEXT,
  base_ref TEXT,
  base_sha TEXT,
  delivery_mode TEXT NOT NULL DEFAULT 'single',
  delivery_status TEXT NOT NULL DEFAULT 'planning',
  integration_branch TEXT,
  integration_worktree_path TEXT,
  integration_worktree_removed_at TEXT,
  final_pr_number INTEGER,
  final_pr_url TEXT,
  delivery_error TEXT,
  verified_at TEXT,
  cmux_group_id TEXT,
  cmux_notice_key TEXT,
  merge_workspace_id TEXT,
  merge_status TEXT,
  merge_session_closed_at TEXT,
  superseded_merge_workspaces TEXT NOT NULL DEFAULT '[]',
  followups TEXT NOT NULL DEFAULT '[]',
  board_status TEXT,
  board_changed_at TEXT,
  board_pr_number INTEGER,
  board_pr_url TEXT,
  board_pr_state TEXT,
  board_pr_observed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  launched_at TEXT
  ,workflow TEXT NOT NULL DEFAULT 'planned'
  ,goal_session_state TEXT
  ,goal_session_workspace_id TEXT
  ,goal_session_worktree_path TEXT
  ,goal_session_branch TEXT
  ,goal_session_generation INTEGER NOT NULL DEFAULT 0
  ,goal_session_provider_session_id TEXT
  ,proposal_revision INTEGER NOT NULL DEFAULT 0
  ,proposal TEXT
  ,approval_revision INTEGER
  ,approval_at TEXT
  ,transition_status TEXT
  ,goal_session_error TEXT
  ,goal_session_pending_input TEXT
  ,goal_session_active_input TEXT
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
  task_type TEXT NOT NULL DEFAULT 'feature',
  criterion_ids TEXT NOT NULL DEFAULT '[]',
  depends_on TEXT NOT NULL DEFAULT '[]',
  owned_areas TEXT NOT NULL DEFAULT '[]',
  verification TEXT NOT NULL DEFAULT '[]',
  wave INTEGER NOT NULL DEFAULT 0,
  launch_status TEXT,
  launch_error TEXT,
  launch_reason TEXT,
  worktree_path TEXT,
  workspace_id TEXT,
  start_sha TEXT,
  head_sha TEXT,
  completion_report TEXT,
  evidence_status TEXT,
  evidence_error TEXT,
  changed_files TEXT NOT NULL DEFAULT '[]',
  scope_warnings TEXT NOT NULL DEFAULT '[]',
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  integrated_commit_sha TEXT,
  session_closed_at TEXT,
  worktree_removed_at TEXT,
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
  createPlan({ planId, repositoryId, repositoryName = null, cwd = null, goal, images = [], sourceType = null, issueNumbers = [], issueUrls = [], deliveryPolicy = "auto", engine = {}, specOptions = {}, reviewOptions = {} }) {
    const at = this.#stamp();
    const options = safeSpecOptions(specOptions);
    const review = safeReviewOptions(reviewOptions);
    this.#transaction(() => {
      // Reservation and plan creation are one transaction, before any planner
      // process starts. Both single-issue and topic planning use this boundary.
      if (issueNumbers.length) {
        const wanted = new Set(issueNumbers.map(Number));
        const existing = this.db.prepare("SELECT plan_id, issue_numbers FROM plans WHERE repository_id = ?").all(repositoryId)
          .find((row) => parse(row.issue_numbers, []).some((number) => wanted.has(Number(number))));
        if (existing) throw Object.assign(new TypeError("An issue already belongs to a saved goal. Open or delete that goal before planning again"), { code: "ISSUE_ALREADY_PLANNED", planId: existing.plan_id });
      }

      this.db.prepare(`
        INSERT INTO plans (plan_id, repository_id, repository_name, cwd, goal, images, source_type, issue_numbers, issue_urls, delivery_policy, engine_provider, engine_model, engine_effort, engine_reviewer, spec_options, review_options, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(planId, repositoryId, repositoryName, cwd, goal, json(images), text(sourceType), json(issueNumbers), json(issueUrls), policy(deliveryPolicy), engine.provider || "claude", engine.model || "default", engine.effort || "default", engine.reviewer === true ? 1 : 0, json(options), json(review), at, at);
      this.#insertEvent(planId, 0, "goal", { goal, images, sourceType, issueNumbers, issueUrls, deliveryPolicy: policy(deliveryPolicy), engine: { provider: engine.provider || "claude", model: engine.model || "default", effort: engine.effort || "default", reviewer: engine.reviewer === true }, specOptions: options, reviewOptions: review }, at);
    });
    this.#prune();
    return this.get(planId);
  }

  // Goal sessions are additive to the historic plan workflow. The stored
  // generation is part of every mutable decision, so a recovered or replaced
  // session can never consume an approval intended for its predecessor.
  recordGoalSessionStart(planId, { worktreePath, workspaceId: workspaceIdValue, providerSessionId = null, generation = 1 } = {}) {
    const path = text(worktreePath);
    const workspace = text(workspaceIdValue);
    if (!path || !workspace || !Number.isInteger(generation) || generation < 1) throw new TypeError("Invalid goal session identity");
    const at = this.#stamp();
    this.#transaction(() => {
      const changed = this.db.prepare(`
        UPDATE plans SET workflow = 'goal_session', cwd = ?, goal_session_state = 'planning',
          goal_session_worktree_path = ?, goal_session_workspace_id = ?, goal_session_generation = ?,
          goal_session_provider_session_id = ?, proposal_revision = 0, proposal = NULL,
          approval_revision = NULL, approval_at = NULL, transition_status = NULL, goal_session_error = NULL,
          updated_at = ? WHERE plan_id = ? AND workflow = 'goal_session' AND goal_session_state = 'starting' AND board_status IS NULL
      `).run(path, path, workspace, generation, text(providerSessionId) || null, at, String(planId)).changes;
      if (changed !== 1) throw new TypeError("This goal session has already started or is unavailable");
      this.#insertEvent(String(planId), null, "goal_session_started", { worktreePath: path, workspaceId: workspace, generation, providerSessionId: text(providerSessionId) || null }, at);
    });
    return this.get(planId);
  }

  reserveGoalSession(planId, { branch, generation = 1 } = {}) {
    const at = this.#stamp();
    const safeBranch = text(branch);
    if (!safeBranch || !Number.isInteger(generation) || generation < 1) throw new TypeError("Invalid goal session reservation");
    const changed = this.db.prepare(`UPDATE plans SET workflow = 'goal_session', goal_session_state = 'starting',
      goal_session_branch = ?, goal_session_generation = ?, goal_session_error = NULL, updated_at = ?
      WHERE plan_id = ? AND workflow = 'planned' AND board_status IS NULL`).run(safeBranch, generation, at, String(planId)).changes;
    if (changed !== 1) throw new TypeError("This goal session has already started or is unavailable");
    return this.get(planId);
  }

  recordGoalSessionStartFailure(planId, error) {
    const at = this.#stamp();
    this.db.prepare(`UPDATE plans SET goal_session_state = 'unavailable', goal_session_error = ?, updated_at = ?
      WHERE plan_id = ? AND workflow = 'goal_session' AND goal_session_state = 'starting'`).run(text(error).slice(0, 2_000) || "Goal session could not start", at, String(planId));
    return this.get(planId);
  }

  publishProposal(planId, { generation, proposal, providerSessionId = null } = {}) {
    if (!Number.isInteger(generation) || generation < 1 || !proposal || typeof proposal !== "object" || Array.isArray(proposal)) throw new TypeError("Invalid goal-session proposal");
    const at = this.#stamp();
    this.#transaction(() => {
      const row = this.db.prepare("SELECT proposal_revision FROM plans WHERE plan_id = ? AND workflow = 'goal_session' AND board_status IS NULL AND goal_session_generation = ? AND goal_session_state IN ('planning', 'awaiting_approval')").get(String(planId), generation);
      if (!row) throw new TypeError("This proposal belongs to an unavailable goal session");
      const revision = Number(row.proposal_revision || 0) + 1;
      this.db.prepare(`UPDATE plans SET goal_session_state = 'awaiting_approval', proposal_revision = ?, proposal = ?,
        goal_session_provider_session_id = COALESCE(?, goal_session_provider_session_id), approval_revision = NULL,
        approval_at = NULL, transition_status = NULL, goal_session_error = NULL, updated_at = ? WHERE plan_id = ?`).run(revision, json(proposal), text(providerSessionId) || null, at, String(planId));
      this.#insertEvent(String(planId), null, "proposal_published", { generation, revision, proposal }, at);
    });
    return this.get(planId);
  }

  requestProposalChanges(planId, { generation, revision, feedback } = {}) {
    const note = text(feedback);
    if (!Number.isInteger(generation) || !Number.isInteger(revision) || revision < 1 || !note || note.length > 4_000) throw new TypeError("Invalid proposal change request");
    const at = this.#stamp();
    this.#transaction(() => {
      const changed = this.db.prepare(`UPDATE plans SET goal_session_state = 'planning', approval_revision = NULL, approval_at = NULL,
        goal_session_pending_input = ?,
        transition_status = NULL, goal_session_error = NULL, updated_at = ? WHERE plan_id = ? AND workflow = 'goal_session'
        AND board_status IS NULL AND goal_session_generation = ? AND proposal_revision = ? AND goal_session_state = 'awaiting_approval'`).run(note, at, String(planId), generation, revision).changes;
      if (changed !== 1) throw new TypeError("This proposal is no longer current");
      this.#insertEvent(String(planId), null, "proposal_changes_requested", { generation, revision, feedback: note }, at);
    });
    return this.get(planId);
  }

  consumeGoalSessionInput(planId, { generation } = {}) {
    const id = String(planId);
    const row = this.db.prepare(`SELECT goal_session_pending_input FROM plans WHERE plan_id = ? AND workflow = 'goal_session'
      AND board_status IS NULL AND goal_session_generation = ? AND goal_session_state = 'planning'
      AND goal_session_pending_input IS NOT NULL AND goal_session_active_input IS NULL`).get(id, generation);
    const feedback = text(row?.goal_session_pending_input);
    if (!feedback) return null;
    // Claim the correction before the provider turn begins. A rejected turn
    // remains active and visible for an explicit recovery action; it is never
    // silently replayed on the next polling interval or runner restart.
    const changed = this.db.prepare(`UPDATE plans SET goal_session_pending_input = NULL, goal_session_active_input = ?, updated_at = ?
      WHERE plan_id = ? AND workflow = 'goal_session' AND board_status IS NULL AND goal_session_generation = ?
      AND goal_session_state = 'planning' AND goal_session_pending_input = ? AND goal_session_active_input IS NULL`)
      .run(feedback, this.#stamp(), id, generation, feedback).changes;
    return changed === 1 ? feedback : null;
  }

  acknowledgeGoalSessionInput(planId, { generation, feedback } = {}) {
    const changed = this.db.prepare(`UPDATE plans SET goal_session_active_input = NULL,
      goal_session_pending_input = CASE WHEN goal_session_pending_input = ? THEN NULL ELSE goal_session_pending_input END,
      updated_at = ? WHERE plan_id = ? AND workflow = 'goal_session' AND goal_session_generation = ?
      AND (goal_session_pending_input = ? OR goal_session_active_input = ?)`)
      .run(text(feedback), this.#stamp(), String(planId), generation, text(feedback), text(feedback)).changes;
    return changed === 1;
  }

  recordGoalSessionInputFailure(planId, { generation, error } = {}) {
    const message = text(error)?.slice(0, 2_000) || "The requested proposal revision failed";
    this.db.prepare(`UPDATE plans SET goal_session_error = ?, updated_at = ? WHERE plan_id = ? AND workflow = 'goal_session'
      AND goal_session_generation = ? AND goal_session_active_input IS NOT NULL`).run(message, this.#stamp(), String(planId), generation);
    return this.get(planId);
  }

  findGoalSessionByWorkspace(workspaceId) {
    const id = text(workspaceId);
    if (!id || id.length > 200) return null;
    const row = this.db.prepare("SELECT * FROM plans WHERE workflow = 'goal_session' AND goal_session_workspace_id = ? LIMIT 1").get(id);
    return row ? readPlan(row) : null;
  }

  recordGoalSessionProviderSession(planId, { generation, providerSessionId } = {}) {
    const session = text(providerSessionId);
    if (!Number.isInteger(generation) || generation < 1 || !session) throw new TypeError("Invalid provider conversation identity");
    const at = this.#stamp();
    const changed = this.db.prepare(`UPDATE plans SET goal_session_provider_session_id = ?, updated_at = ? WHERE plan_id = ?
      AND workflow = 'goal_session' AND board_status IS NULL AND goal_session_generation = ? AND goal_session_state IN ('planning', 'awaiting_approval')`).run(session, at, String(planId), generation).changes;
    if (changed !== 1) throw new TypeError("This provider conversation belongs to an unavailable goal session");
    return this.get(planId);
  }

  approveProposal(planId, { generation, revision } = {}) {
    if (!Number.isInteger(generation) || !Number.isInteger(revision) || revision < 1) throw new TypeError("Invalid proposal approval");
    const at = this.#stamp();
    this.#transaction(() => {
      const changed = this.db.prepare(`UPDATE plans SET goal_session_state = 'implementing', approval_revision = ?, approval_at = ?,
        transition_status = 'pending', goal_session_error = NULL, updated_at = ? WHERE plan_id = ? AND workflow = 'goal_session'
        AND board_status IS NULL AND goal_session_generation = ? AND proposal_revision = ? AND goal_session_state = 'awaiting_approval'`).run(revision, at, at, String(planId), generation, revision).changes;
      if (changed !== 1) throw new TypeError("This proposal is no longer current or was already approved");
      this.#insertEvent(String(planId), null, "proposal_approved", { generation, revision }, at);
    });
    return this.get(planId);
  }

  claimGoalSessionTransition(planId, { generation, revision } = {}) {
    const at = this.#stamp();
    const changed = this.db.prepare(`UPDATE plans SET transition_status = 'dispatching', updated_at = ? WHERE plan_id = ?
      AND workflow = 'goal_session' AND board_status IS NULL AND goal_session_generation = ? AND approval_revision = ? AND transition_status = 'pending'`).run(at, String(planId), generation, revision).changes;
    return changed === 1 ? this.get(planId) : null;
  }

  recordGoalSessionTransition(planId, { generation, revision, error = null } = {}) {
    const at = this.#stamp();
    const failed = text(error);
    const changed = this.db.prepare(`UPDATE plans SET transition_status = ?, goal_session_state = ?, goal_session_error = ?, updated_at = ? WHERE plan_id = ?
      AND workflow = 'goal_session' AND board_status IS NULL AND goal_session_generation = ? AND approval_revision = ? AND transition_status = 'dispatching'`).run(failed ? "uncertain" : "delivered", "implementing", failed || null, at, String(planId), generation, revision).changes;
    // A transport failure after the child was started is not permission to
    // send a second writable command. Leave it uncertain until the coordinator
    // reconciles the provider/session state.
    if (changed) this.#insertEvent(String(planId), null, "goal_session_transition", { generation, revision, status: failed ? "uncertain" : "delivered", error: failed || null }, at);
    return this.get(planId);
  }

  // One round of the conversation: the plan row, its task rows and the event
  // that explains them all land together, or none of them land.
  recordRound(planId, { round, stage, sessionId = null, questions = [], spec = null, readiness = null, tasks = [], answers = null, skipped = false, feedback = null }) {
    if (!PLAN_STAGES.has(stage)) throw new TypeError(`Unknown plan stage ${stage}`);
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plans SET round = ?, stage = ?, session_id = ?, questions = ?, contract_version = ?, spec = ?, readiness = ?,
          delivery_mode = CASE WHEN delivery_policy = 'combined' THEN 'combined' ELSE ? END,
          last_error = NULL, last_error_at = NULL,
          updated_at = ? WHERE plan_id = ?
      `).run(round, stage, sessionId, json(questions), spec ? 2 : 1, spec ? json(spec) : null, readiness ? json(readiness) : null, deliveryMode(tasks), at, planId);
      // An answered round replaces the previous task list wholesale, because the
      // planner returns a fresh split rather than a patch.
      this.#replaceTasks(planId, tasks);
      if (answers !== null || skipped) this.#insertEvent(planId, round, "answers", { answers: answers || [], skipped }, at);
      // The rejection that caused this round. It is stored beside the split it
      // replaced, so the log reads as a reason followed by its consequence.
      if (feedback) this.#insertEvent(planId, round, "feedback", { feedback }, at);
      if (stage === "questions") this.#insertEvent(planId, round, "questions", { questions }, at);
      else this.#insertEvent(planId, round, "tasks", { spec, readiness, tasks }, at);
    });
    return this.get(planId);
  }

  // A round that died. The message lives only in memory otherwise — the run
  // registry expires after a minute and the progress stream is closed — so a
  // reopened sheet had to guess the cause and blamed a companion restart.
  // No event row: PLAN_EVENT_KINDS is a closed set, and a failure is plan state
  // rather than a turn of the conversation.
  recordRoundFailure(planId, error) {
    const at = this.#stamp();
    const message = String(error || "The planner round failed").slice(0, 2_000);
    this.db.prepare("UPDATE plans SET last_error = ?, last_error_at = ?, updated_at = ? WHERE plan_id = ?")
      .run(message, at, at, String(planId));
    return this.get(planId);
  }

  // One question about a Delivery Contract and the planner's answer to it. It is
  // deliberately the narrowest write in this store: one event at the round it
  // examined, and the modification stamp. The contract it questions must read
  // back exactly as it did before, so no other plan column and no task row is
  // touched here.
  recordDiscussion(planId, { question, answer, contractImpact, suggestion = "", round = null }) {
    if (!DISCUSSION_IMPACTS.has(contractImpact)) throw new TypeError(`Unknown discussion impact ${contractImpact}`);
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare("UPDATE plans SET updated_at = ? WHERE plan_id = ?").run(at, String(planId));
      this.#insertEvent(planId, round, "discussion", { question, answer, contractImpact, suggestion }, at);
    });
    return this.get(planId);
  }

  // A user edit through PATCH. It never changes the round or the stage.
  recordEdit(planId, tasks, readiness = null) {
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plans SET delivery_mode = CASE WHEN delivery_policy = 'combined' THEN 'combined' ELSE ? END,
          readiness = COALESCE(?, readiness), updated_at = ? WHERE plan_id = ?
      `).run(deliveryMode(tasks), readiness ? json(readiness) : null, at, planId);
      this.#replaceTasks(planId, tasks);
      this.#insertEvent(planId, null, "edit", { tasks, readiness }, at);
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
        UPDATE plan_tasks SET branch = COALESCE(?, branch), launch_status = ?, launch_error = ?, launch_reason = ?,
          worktree_path = ?, worktree_removed_at = NULL, workspace_id = ?, start_sha = ?
        WHERE plan_id = ? AND task_id = ?
      `);
      for (const result of results) {
        update.run(
          text(result?.branch),
          text(result?.status),
          text(result?.error),
          result?.status === "launched" ? null : text(result?.launchReason),
          text(result?.path),
          workspaceId(result?.workspace),
          result?.status === "queued" ? null : text(result?.startSha) || text(baseSha),
          planId,
          String(result?.id || ""),
        );
      }
      this.#insertEvent(planId, null, "launch", { base, baseSha, launched, results }, at);
    });
    return this.get(planId);
  }

  recordWaveLaunch(planId, { wave, startSha, results = [] } = {}) {
    const at = this.#stamp();
    this.#transaction(() => {
      const update = this.db.prepare(`
        UPDATE plan_tasks SET branch = COALESCE(?, branch), launch_status = ?, launch_error = ?, launch_reason = ?,
          worktree_path = ?, worktree_removed_at = NULL, workspace_id = ?, start_sha = ?, delivery_status = 'pending'
        WHERE plan_id = ? AND task_id = ? AND launch_status IN ('queued', 'failed')
      `);
      let changed = 0;
      for (const result of results) {
        changed += Number(update.run(
          text(result?.branch), text(result?.status), text(result?.error),
          result?.status === "launched" ? null : text(result?.launchReason), text(result?.path), workspaceId(result?.workspace),
          text(result?.startSha) || text(startSha), String(planId), String(result?.id || ""),
        ).changes);
      }
      if (changed) this.db.prepare(`
        UPDATE plans SET delivery_status = 'implementing', merge_status = NULL, merge_workspace_id = NULL,
          delivery_error = NULL, updated_at = ? WHERE plan_id = ?
      `).run(at, String(planId));
      this.#insertEvent(String(planId), null, "wave_launched", { wave, startSha, results }, at);
    });
    return this.get(planId);
  }

  recordWaveIntegrated(planId, wave) {
    const at = this.#stamp();
    this.#transaction(() => {
      // The statement below is about to clear merge_workspace_id, and that
      // column is the only record of the wave merge session there is. Capture
      // it first, or the session stays open with nothing left to point at it.
      this.#supersedeMerge(String(planId));
      this.db.prepare(`
        UPDATE plans SET delivery_status = 'implementing', merge_status = NULL, merge_workspace_id = NULL,
          delivery_error = NULL, updated_at = ? WHERE plan_id = ?
      `).run(at, String(planId));
      this.#insertEvent(String(planId), null, "wave_integrated", { wave }, at);
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
        AND p.board_status IS NULL
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
      "SELECT plan_id FROM plans WHERE merge_workspace_id = ? AND merge_status = 'running' AND board_status IS NULL LIMIT 1",
    ).get(id);
    return row ? this.get(row.plan_id) : null;
  }

  activeCombinedPlans() {
    return this.db.prepare(`
      SELECT plan_id FROM plans
      WHERE status = 'launched' AND delivery_mode = 'combined' AND final_pr_url IS NULL
        AND board_status IS NULL
      ORDER BY updated_at
    `).all().map((row) => this.get(row.plan_id)).filter(Boolean);
  }

  recordTaskReady(planId, taskId, headSha, { report = null, changedFiles = [], scopeWarnings = [] } = {}) {
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plan_tasks SET head_sha = ?, delivery_status = 'ready', completion_report = ?,
          evidence_status = 'ready', evidence_error = NULL, changed_files = ?, scope_warnings = ?
        WHERE plan_id = ? AND task_id = ?
      `).run(String(headSha), report ? json(report) : null, json(changedFiles), json(scopeWarnings), String(planId), String(taskId));
      this.db.prepare("UPDATE plans SET updated_at = ? WHERE plan_id = ?").run(at, String(planId));
      if (report || changedFiles.length || scopeWarnings.length) this.#insertEvent(String(planId), null, "task_evidence", { taskId, headSha, report, changedFiles, scopeWarnings }, at);
      this.#insertEvent(String(planId), null, "task_ready", { taskId, headSha }, at);
    });
    return this.get(planId);
  }

  recordTaskPending(planId, taskId, { error = null, report = null, changedFiles = [], scopeWarnings = [] } = {}) {
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plan_tasks SET head_sha = NULL, delivery_status = 'pending', completion_report = ?,
          evidence_status = ?, evidence_error = ?, changed_files = ?, scope_warnings = ?
        WHERE plan_id = ? AND task_id = ?
      `).run(report ? json(report) : null, error ? "blocked" : null, text(error), json(changedFiles), json(scopeWarnings), String(planId), String(taskId));
      this.db.prepare("UPDATE plans SET updated_at = ? WHERE plan_id = ?").run(at, String(planId));
      if (error || report) this.#insertEvent(String(planId), null, "task_evidence", { taskId, error, report, changedFiles, scopeWarnings }, at);
      this.#insertEvent(String(planId), null, "task_pending", { taskId, error }, at);
    });
    return this.get(planId);
  }

  recordIntegrationStarted(planId, { branch, path }) {
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plans SET delivery_status = 'assembling', integration_branch = ?,
          integration_worktree_path = ?, integration_worktree_removed_at = NULL, delivery_error = NULL, updated_at = ? WHERE plan_id = ?
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

  // The last notification actually delivered. Like the group id this is
  // presentation only, so it never joins a delivery transition: losing it costs
  // one repeated notice, never a lost merge.
  recordNoticeKey(planId, noticeKey) {
    const at = this.#stamp();
    this.db.prepare("UPDATE plans SET cmux_notice_key = ?, updated_at = ? WHERE plan_id = ?")
      .run(text(noticeKey), at, String(planId));
    return this.get(planId);
  }

  // A cancelled create may still return a workspace. Retain its identity for
  // cleanup without reopening the goal or overwriting the current merge.
  recordMergeCleanupRequired(planId, workspaceId) {
    const id = String(planId);
    const at = this.#stamp();
    this.#transaction(() => {
      const sessions = this.#superseded(id);
      if (!sessions.some((entry) => entry.workspaceId === workspaceId)) sessions.push({ workspaceId, retiredAt: null });
      this.db.prepare("UPDATE plans SET superseded_merge_workspaces = ?, updated_at = ? WHERE plan_id = ?").run(json(sessions), at, id);
      this.#insertEvent(id, null, "merge_cleanup_required", { workspaceId }, at);
    });
    return this.get(id);
  }

  recordMergeLaunched(planId, workspaceId) {
    const at = this.#stamp();
    this.#transaction(() => {
      // A resumed merge is recorded under its own id, so only a different id
      // means the previous session was replaced rather than continued.
      this.#supersedeMerge(String(planId), { except: text(workspaceId) });
      this.db.prepare(`
        UPDATE plans SET merge_workspace_id = ?, merge_status = 'running',
          delivery_status = 'assembling', delivery_error = NULL, updated_at = ? WHERE plan_id = ?
      `).run(text(workspaceId), at, String(planId));
      this.#insertEvent(String(planId), null, "merge_launched", { workspaceId }, at);
    });
    return this.get(planId);
  }

  recordFollowupLaunched(planId, { followupId, workspaceId, actions, agent, branch, worktreePath, briefPath }) {
    const at = this.#stamp();
    const id = String(planId);
    this.#transaction(() => {
      const row = this.db.prepare("SELECT followups FROM plans WHERE plan_id = ?").get(id);
      const followups = parse(row?.followups, []);
      const entry = {
        followupId: text(followupId),
        workspaceId: text(workspaceId),
        actions: Array.isArray(actions) ? actions.map(String) : [],
        agent: text(agent),
        branch: text(branch),
        worktreePath: text(worktreePath),
        briefPath: text(briefPath),
        launchedAt: at,
      };
      followups.push(entry);
      this.db.prepare("UPDATE plans SET followups = ?, updated_at = ? WHERE plan_id = ?")
        .run(json(followups), at, id);
      this.#insertEvent(id, null, "followup_launched", entry, at);
    });
    return this.get(planId);
  }

  // The single-launch lock for a goal code review. Two callers race for it: the
  // integrator settling a combined goal, and the merge watcher observing a
  // single-task goal's pull request. The WHERE clause is the lock, so the
  // loser gets null and launches nothing.
  //
  // The claim is written before cmux is called, because a workspace id only
  // exists afterwards. A crash in between leaves 'claiming', which still
  // blocks a second launch and is visible to a person reading the row.
  claimGoalReview(planId, { agent } = {}) {
    const at = this.#stamp();
    const id = String(planId);
    let claimed = false;
    this.#transaction(() => {
      const result = this.db.prepare(`
        UPDATE plans SET review_status = 'claiming', review_launched_at = ?, updated_at = ?
        WHERE plan_id = ? AND review_status IS NULL AND review_workspace_id IS NULL
      `).run(at, at, id);
      claimed = result.changes === 1;
      if (claimed) this.#insertEvent(id, null, "review_claimed", { agent: text(agent) }, at);
    });
    return claimed ? this.get(id) : null;
  }

  recordReviewLaunched(planId, { workspaceId, agent, briefPath }) {
    const at = this.#stamp();
    const id = String(planId);
    const entry = {
      workspaceId: text(workspaceId),
      agent: text(agent),
      briefPath: text(briefPath),
      launchedAt: at,
    };
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plans SET review_workspace_id = ?, review_status = 'running',
          review_brief_path = ?, review_launched_at = ?, updated_at = ? WHERE plan_id = ?
      `).run(entry.workspaceId, entry.briefPath, at, at, id);
      this.#insertEvent(id, null, "review_launched", entry, at);
    });
    return this.get(id);
  }

  // A claim that never became a session must not strand the goal. Releasing it
  // returns the row to its unclaimed state so a later pass can try again.
  releaseGoalReview(planId) {
    const at = this.#stamp();
    const id = String(planId);
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plans SET review_status = NULL, review_launched_at = NULL, updated_at = ?
        WHERE plan_id = ? AND review_workspace_id IS NULL
      `).run(at, id);
    });
    return this.get(id);
  }

  recordReviewSessionClosed(planId) {
    const at = this.#stamp();
    const id = String(planId);
    this.#transaction(() => {
      this.db.prepare("UPDATE plans SET review_session_closed_at = ?, updated_at = ? WHERE plan_id = ?")
        .run(at, at, id);
    });
    return this.get(id);
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

  recordWorktreeRemoved(path) {
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare("UPDATE plan_tasks SET worktree_removed_at = ? WHERE worktree_path = ?").run(at, path);
      this.db.prepare("UPDATE plans SET integration_worktree_removed_at = ? WHERE integration_worktree_path = ?").run(at, path);
      this.db.prepare("UPDATE plans SET goal_session_error = 'The goal session worktree was removed', updated_at = ? WHERE goal_session_worktree_path = ?").run(at, path);
    });
  }

  // Sweep every launched plan, including old merged goals outside the board's
  // 200-row window. Only durable workspace identities are eligible for cleanup.
  sessionCleanupPlanIds() {
    return this.db.prepare("SELECT plan_id FROM plans WHERE status = 'launched' OR (workflow = 'goal_session' AND goal_session_state NOT IN ('aborted', 'merged'))").all().map((row) => row.plan_id);
  }

  pendingSessionClosures(planId) {
    const id = String(planId || "");
    const plan = this.get(id);
    if (!plan) return [];
    const delivered = Boolean(plan.finalPrNumber || plan.finalPrUrl || plan.boardPrNumber || plan.boardPrUrl);
    if (!delivered && (plan.deliveryMode !== "combined" || plan.mergeStatus === "blocked" || plan.boardStatus)) return [];
    const tasks = this.db.prepare(`
      SELECT task_id, workspace_id FROM plan_tasks
      WHERE plan_id = ? AND (? OR delivery_status = 'integrated') AND workspace_id IS NOT NULL AND session_closed_at IS NULL
      ORDER BY position
    `).all(id, Number(delivered)).map((row) => ({ workspaceId: row.workspace_id, taskId: row.task_id }));
    const merges = this.#superseded(id)
      .filter((entry) => !entry.retiredAt)
      .map((entry) => ({ workspaceId: entry.workspaceId, taskId: null }));
    if (delivered && plan.mergeWorkspaceId && !plan.mergeSessionClosedAt && !merges.some((entry) => entry.workspaceId === plan.mergeWorkspaceId)) {
      merges.push({ workspaceId: plan.mergeWorkspaceId, taskId: null });
    }
    return [...tasks, ...merges];
  }

  // Retirement is durable so a restart never closes the same session twice and
  // never keeps asking cmux about a session that is already gone.
  //
  // Three kinds of session reach this method: a task session, the live merge
  // session, and a merge session a newer merge agent replaced. Each lives in a
  // different column, so the kind decides where the stamp is written. A caller
  // that names no kind is read the way the only caller used to be read: a
  // taskId means a task, and everything else means a superseded merge.
  recordSessionsRetired(planId, entries = []) {
    const id = String(planId || "");
    const liveMerge = text(this.db.prepare("SELECT merge_workspace_id FROM plans WHERE plan_id = ?").get(id)?.merge_workspace_id);
    const wanted = (Array.isArray(entries) ? entries : [])
      .map((entry) => {
        const workspaceIdValue = text(entry?.workspaceId);
        const taskId = text(entry?.taskId);
        return { workspaceId: workspaceIdValue, taskId, kind: sessionKind(entry?.kind, taskId, workspaceIdValue, liveMerge) };
      })
      .filter((entry) => entry.workspaceId);
    if (!wanted.length) return this.get(id);
    const at = this.#stamp();
    this.#transaction(() => {
      const close = this.db.prepare(
        "UPDATE plan_tasks SET session_closed_at = ? WHERE plan_id = ? AND task_id = ? AND workspace_id = ? AND session_closed_at IS NULL",
      );
      for (const entry of wanted) if (entry.kind === "task" && entry.taskId) close.run(at, id, entry.taskId, entry.workspaceId);
      // The live merge session has no row of its own, so the plan carries its
      // stamp. Only the id the plan currently points at may claim that column.
      if (wanted.some((entry) => entry.kind === "merge" && entry.workspaceId === liveMerge)) {
        this.db.prepare("UPDATE plans SET merge_session_closed_at = COALESCE(merge_session_closed_at, ?) WHERE plan_id = ?").run(at, id);
      }
      const retired = new Set(wanted.filter((entry) => entry.kind === "superseded").map((entry) => entry.workspaceId));
      if (retired.size) {
        const current = this.db.prepare("SELECT merge_workspace_id FROM plans WHERE plan_id = ?").get(id)?.merge_workspace_id;
        if (current && retired.has(current)) {
          this.#supersedeMerge(id);
          this.db.prepare("UPDATE plans SET merge_workspace_id = NULL WHERE plan_id = ?").run(id);
        }
        const merges = this.#superseded(id)
          .map((entry) => (retired.has(entry.workspaceId) && !entry.retiredAt ? { ...entry, retiredAt: at } : entry));
        this.db.prepare("UPDATE plans SET superseded_merge_workspaces = ? WHERE plan_id = ?").run(json(merges), id);
      }
      this.db.prepare("UPDATE plans SET updated_at = ? WHERE plan_id = ?").run(at, id);
      // The event keeps the shape it has always had. The kind decides which
      // column moves, and every column it can move is already readable on the
      // plan row, so repeating it here would only break older readers.
      this.#insertEvent(id, null, "session_retired", { sessions: wanted.map(({ workspaceId: id_, taskId }) => ({ workspaceId: id_, taskId })) }, at);
    });
    return this.get(id);
  }

  #superseded(planId) {
    const row = this.db.prepare("SELECT superseded_merge_workspaces FROM plans WHERE plan_id = ?").get(String(planId));
    const list = parse(row?.superseded_merge_workspaces, []);
    return Array.isArray(list) ? list.filter((entry) => entry && typeof entry.workspaceId === "string") : [];
  }

  // Called from inside the transaction that is about to drop the current merge
  // workspace id. Nothing else records that a session was left behind.
  #supersedeMerge(planId, { except = null } = {}) {
    const row = this.db.prepare("SELECT merge_workspace_id FROM plans WHERE plan_id = ?").get(String(planId));
    const current = text(row?.merge_workspace_id);
    if (!current || current === except) return;
    const merges = this.#superseded(planId);
    if (merges.some((entry) => entry.workspaceId === current)) return;
    merges.push({ workspaceId: current, retiredAt: null });
    this.db.prepare("UPDATE plans SET superseded_merge_workspaces = ? WHERE plan_id = ?").run(json(merges), String(planId));
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

  // One task starts again. `recordWaveLaunch` writes a subset of tasks the
  // same way, but it also resets the whole plan's delivery state because a
  // wave is a plan-wide transition. A relaunch is not: the other tasks keep
  // their evidence, so only this row and the plan's blocked flag move.
  //
  // The blocked flag is cleared because the two reasons a launched plan blocks
  // are "a task never launched" and "a task is not ready", and a relaunch is
  // the answer to both. Leaving it set would keep the goal in the merge column
  // while its agent works.
  recordTaskRelaunch(planId, taskId, result = {}) {
    const id = String(planId || "");
    const task = String(taskId || "");
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plan_tasks SET branch = COALESCE(?, branch), launch_status = ?, launch_error = ?, launch_reason = ?,
          worktree_path = ?, worktree_removed_at = NULL, workspace_id = ?, start_sha = ?, head_sha = NULL, delivery_status = 'pending', evidence_status = NULL,
          evidence_error = NULL, completion_report = NULL, changed_files = '[]', scope_warnings = '[]',
          integrated_commit_sha = NULL, session_closed_at = NULL
        WHERE plan_id = ? AND task_id = ?
      `).run(
        text(result?.branch), text(result?.status) || "launched", text(result?.error),
        result?.status === "failed" ? text(result?.launchReason) : null, text(result?.path),
        workspaceId(result?.workspace), text(result?.startSha), id, task,
      );
      this.db.prepare(`
        UPDATE plans SET delivery_status = CASE delivery_status WHEN 'blocked' THEN 'implementing' ELSE delivery_status END,
          delivery_error = NULL, updated_at = ? WHERE plan_id = ?
      `).run(at, id);
      this.#insertEvent(id, null, "task_relaunched", { taskId: task, result }, at);
    });
    return this.get(id);
  }

  // Called only after external Git and live-session evidence has been verified.
  // Compare-and-set prevents an audit from replacing a concurrently relaunched task.
  recordTaskAssociation(planId, taskId, { branch, path, workspaceId: sessionId, headSha }) {
    this.#transaction(() => {
      const plan = this.get(planId);
      const task = plan?.tasks.find((item) => item.id === taskId);
      if (!plan || plan.status !== "launched" || plan.boardStatus || plan.finalPrUrl ||
          !task || task.launchStatus !== "failed" || task.workspaceId || task.worktreePath ||
          task.branch !== branch || !path || !sessionId || !/^[a-f0-9]{40}$/.test(headSha || "")) {
        throw new Error("Task changed or is not an unassociated failed task");
      }
      if (this.db.prepare("SELECT 1 FROM plan_tasks WHERE workspace_id = ? OR worktree_path = ? LIMIT 1").get(sessionId, path)) {
        throw new Error("Workspace or checkout is already associated with a task");
      }
      const at = this.#stamp();
      this.db.prepare("UPDATE plan_tasks SET launch_status = 'launched', launch_error = NULL, workspace_id = ?, worktree_path = ?, session_closed_at = NULL, worktree_removed_at = NULL WHERE plan_id = ? AND task_id = ?")
        .run(sessionId, path, planId, taskId);
      this.db.prepare("UPDATE plans SET updated_at = ? WHERE plan_id = ?").run(at, planId);
      this.#insertEvent(planId, null, "task_associated", { taskId, branch, path, workspaceId: sessionId, headSha, reason: "Verified pushed goal-ready commit and live checkout" }, at);
    });
    return this.get(planId);
  }

  // A task the goal no longer needs. `skipped` is deliberately not `failed`:
  // every reader that counts launched work already ignores an unlaunched
  // status, so a skipped task drops out of readiness without pretending it
  // succeeded. The row stays, with its reason, because a silent disappearance
  // is what made the old failures impossible to diagnose.
  recordTaskSkipped(planId, taskId, reason = null) {
    const id = String(planId || "");
    const task = String(taskId || "");
    const at = this.#stamp();
    const note = reason ? String(reason).slice(0, 2_000) : null;
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plan_tasks SET launch_status = 'skipped', launch_error = ?, delivery_status = 'pending',
          evidence_status = NULL, evidence_error = NULL
        WHERE plan_id = ? AND task_id = ?
      `).run(note, id, task);
      this.db.prepare(`
        UPDATE plans SET delivery_status = CASE delivery_status WHEN 'blocked' THEN 'implementing' ELSE delivery_status END,
          delivery_error = NULL, updated_at = ? WHERE plan_id = ?
      `).run(at, id);
      this.#insertEvent(id, null, "task_skipped", { taskId: task, reason: note }, at);
    });
    return this.get(id);
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

  // The two terminal lifecycle states and the pull-request observation that
  // reaches one of them. Every other board column is derived at read time, so
  // these three methods are the only writers of board state.

  // The user stopped the goal. An already aborted plan is returned untouched,
  // and a merged plan is never demoted: the two terminal states are exclusive.
  recordGoalAborted(planId, { reason = null } = {}) {
    const id = String(planId || "");
    const row = this.#boardRow(id);
    if (!row) return null;
    if (boardStatus(row.board_status)) return this.get(id);
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plans SET board_status = 'aborted', board_changed_at = ?, updated_at = ? WHERE plan_id = ?
      `).run(at, at, id);
      this.#insertEvent(id, null, "board_aborted", { reason: text(reason), at }, at);
    });
    return this.get(id);
  }

  // The goal landed. The merge is stored with the pull request that carried it,
  // so the board can name the pull request without another GitHub call.
  recordGoalMerged(planId, { number = null, url = null, observedAt = null } = {}) {
    return this.#recordBoardMerged(String(planId || ""), { number, url, observedAt });
  }

  // One GitHub observation. It moves the board only when the stored
  // number/url/state triple actually changes, so a refresh that reports the
  // same pull request neither grows the event log nor reorders the goal.
  recordGoalPullRequest(planId, { number = null, url = null, state, observedAt = null } = {}) {
    if (!BOARD_PR_STATES.has(state)) throw new TypeError(`Unknown pull request state ${state}`);
    const id = String(planId || "");
    if (state === "MERGED") return this.#recordBoardMerged(id, { number, url, observedAt });
    const row = this.#boardRow(id);
    if (!row) return null;
    // A terminal goal is finished. GitHub reports a merged pull request as
    // MERGED forever, so an OPEN or CLOSED observation on a terminal plan is a
    // stale read. It must not move the board backwards.
    if (boardStatus(row.board_status)) return this.get(id);
    const next = { number: prNumber(number), url: text(url), state };
    const staleDelivery = state === "OPEN" && (row.merge_status !== "done" || row.delivery_status !== "pr_open" || row.delivery_error);
    if (this.#samePullRequest(row, next) && !staleDelivery) return this.get(id);
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plans SET board_pr_number = ?, board_pr_url = ?, board_pr_state = ?,
          board_pr_observed_at = ?, updated_at = ?,
          merge_status = CASE WHEN ? = 'OPEN' THEN 'done' ELSE merge_status END,
          delivery_status = CASE WHEN ? = 'OPEN' THEN 'pr_open' ELSE delivery_status END,
          delivery_error = CASE WHEN ? = 'OPEN' THEN NULL ELSE delivery_error END
          WHERE plan_id = ?
      `).run(next.number, next.url, next.state, text(observedAt) || at, at, state, state, state, id);
      this.#insertEvent(id, null, "board_pull_request", { ...next, observedAt: text(observedAt) || at }, at);
    });
    return this.get(id);
  }

  #recordBoardMerged(planId, { number, url, observedAt }) {
    const row = this.#boardRow(planId);
    if (!row) return null;
    const current = boardStatus(row.board_status);
    // An aborted goal stays aborted, and a repeated merge of the same pull
    // request is a no-op rather than a second event.
    if (current === "aborted") return this.get(planId);
    const next = { number: prNumber(number), url: text(url), state: "MERGED" };
    if (current === "merged" && this.#samePullRequest(row, next) && row.merge_status === "done" && row.delivery_status === "pr_open" && !row.delivery_error) return this.get(planId);
    const at = this.#stamp();
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE plans SET board_status = 'merged', board_changed_at = ?, board_pr_number = ?,
          board_pr_url = ?, board_pr_state = 'MERGED', board_pr_observed_at = ?, updated_at = ?,
          merge_status = 'done', delivery_status = 'pr_open', delivery_error = NULL
        WHERE plan_id = ?
      `).run(current === "merged" ? row.board_changed_at : at, next.number, next.url, text(observedAt) || at, at, planId);
      this.#insertEvent(planId, null, "board_merged", { ...next, observedAt: text(observedAt) || at }, at);
    });
    return this.get(planId);
  }

  #samePullRequest(row, next) {
    return prNumber(row.board_pr_number) === next.number
      && (row.board_pr_url ?? null) === next.url
      && boardPrState(row.board_pr_state) === next.state;
  }

  #boardRow(planId) {
    return this.db.prepare(
      "SELECT board_status, board_changed_at, board_pr_number, board_pr_url, board_pr_state, merge_status, delivery_status, delivery_error FROM plans WHERE plan_id = ?",
    ).get(String(planId || "")) || null;
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

  // Every discussion on a plan, oldest first. It is a query of its own rather
  // than a filter over events(): that reader is capped at 200 rows, so a busy
  // plan would silently drop the older half of its discussion history.
  discussions(planId) {
    return this.db
      .prepare("SELECT round, payload, created_at FROM plan_events WHERE plan_id = ? AND kind = 'discussion' ORDER BY id")
      .all(String(planId || ""))
      .map((row) => {
        const payload = parse(row.payload, {});
        return {
          question: typeof payload.question === "string" ? payload.question : "",
          answer: typeof payload.answer === "string" ? payload.answer : "",
          contractImpact: payload.contractImpact === "revision_suggested" ? "revision_suggested" : "none",
          suggestion: typeof payload.suggestion === "string" ? payload.suggestion : "",
          round: row.round,
          createdAt: row.created_at,
        };
      });
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
    // The board card needs "3 of 5 ready", the Claude/Codex split, and the
    // session ids behind an Open-in-cmux button. Each was a per-plan detail
    // fetch before, which the board cannot afford once it shows every goal at
    // once, so the rollup is computed in the one list query.
    return this.db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM plan_tasks t WHERE t.plan_id = p.plan_id) AS task_count,
        (SELECT COUNT(*) FROM plan_tasks t WHERE t.plan_id = p.plan_id AND t.launch_status = 'launched') AS launched_count,
        (SELECT COUNT(*) FROM plan_tasks t WHERE t.plan_id = p.plan_id AND t.launch_status = 'launched'
           AND t.delivery_status IN ('ready','integrated')) AS ready_count,
        (SELECT COUNT(*) FROM plan_tasks t WHERE t.plan_id = p.plan_id AND t.launch_status = 'failed') AS failed_count,
        (SELECT COUNT(*) FROM plan_tasks t WHERE t.plan_id = p.plan_id AND t.launch_status = 'skipped') AS skipped_count,
        (SELECT COUNT(*) FROM plan_tasks t WHERE t.plan_id = p.plan_id AND t.launch_status = 'queued') AS queued_count,
        (SELECT COUNT(*) FROM plan_tasks t WHERE t.plan_id = p.plan_id AND t.agent = 'claude') AS claude_count,
        (SELECT COUNT(*) FROM plan_tasks t WHERE t.plan_id = p.plan_id AND t.agent = 'codex') AS codex_count,
        (SELECT group_concat(t.workspace_id) FROM plan_tasks t WHERE t.plan_id = p.plan_id
           AND t.workspace_id IS NOT NULL AND t.session_closed_at IS NULL) AS open_workspace_ids
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
      deliveryError: row.delivery_error,
      mergeStatus: row.merge_status,
      mergeWorkspaceId: row.merge_workspace_id,
      finalPrNumber: row.final_pr_number,
      finalPrUrl: row.final_pr_url,
      issueNumbers: parse(row.issue_numbers, []),
      deliveryPolicy: row.delivery_policy || "auto",
      engine: { provider: row.engine_provider || "claude", model: row.engine_model || "default", effort: row.engine_effort || "default", reviewer: row.engine_reviewer === 1 },
      specOptions: safeSpecOptions(parse(row.spec_options, null)),
      reviewOptions: safeReviewOptions(parse(row.review_options, null)),
      reviewStatus: row.review_status ?? null,
      lastError: row.last_error ?? null,
      lastErrorAt: row.last_error_at ?? null,
      boardStatus: boardStatus(row.board_status),
      boardChangedAt: row.board_changed_at ?? null,
      boardPrNumber: Number.isInteger(row.board_pr_number) ? row.board_pr_number : null,
      boardPrUrl: row.board_pr_url ?? null,
      boardPrState: boardPrState(row.board_pr_state),
      boardPrObservedAt: row.board_pr_observed_at ?? null,
      followupCount: parse(row.followups, []).length,
      taskCount: row.task_count,
      launchedCount: row.launched_count,
      readyCount: row.ready_count,
      failedCount: row.failed_count,
      skippedCount: row.skipped_count,
      queuedCount: row.queued_count,
      agentSplit: { claude: row.claude_count, codex: row.codex_count },
      // Every session this goal still owns, so one card can offer Open in cmux
      // without a second request. The merge session is included because it is
      // the one the user opens when a merge is blocked.
      workspaceIds: splitIds([row.open_workspace_ids, row.merge_workspace_id, row.goal_session_workspace_id].filter(Boolean).join(","), null),
      workflow: row.workflow || "planned",
      goalSessionState: row.goal_session_state ?? null,
      goalSessionWorkspaceId: row.goal_session_workspace_id ?? null,
      proposalRevision: Number(row.proposal_revision) || 0,
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
      INSERT INTO plan_tasks (plan_id, task_id, position, title, branch, prompt, agent, agent_reason,
        task_type, criterion_ids, depends_on, owned_areas, verification, wave)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        text(task?.type) || "feature",
        json(task?.criterionIds || []),
        json(task?.dependsOn || []),
        json(task?.ownedAreas || []),
        json(task?.verification || []),
        Number.isInteger(task?.wave) && task.wave >= 0 ? task.wave : 0,
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
    ensure("plans", "engine_provider", "TEXT NOT NULL DEFAULT 'claude'");
    ensure("plans", "engine_model", "TEXT NOT NULL DEFAULT 'default'");
    ensure("plans", "engine_effort", "TEXT NOT NULL DEFAULT 'default'");
    ensure("plans", "engine_reviewer", "INTEGER NOT NULL DEFAULT 0");
    ensure("plans", "spec_options", "TEXT NOT NULL DEFAULT '{}'");
    ensure("plans", "review_options", "TEXT NOT NULL DEFAULT '{}'");
    ensure("plans", "review_workspace_id", "TEXT");
    ensure("plans", "review_status", "TEXT");
    ensure("plans", "review_brief_path", "TEXT");
    ensure("plans", "review_launched_at", "TEXT");
    ensure("plans", "review_session_closed_at", "TEXT");
    ensure("plans", "workflow", "TEXT NOT NULL DEFAULT 'planned'");
    ensure("plans", "goal_session_state", "TEXT");
    ensure("plans", "goal_session_workspace_id", "TEXT");
    ensure("plans", "goal_session_worktree_path", "TEXT");
    ensure("plans", "goal_session_branch", "TEXT");
    ensure("plans", "goal_session_generation", "INTEGER NOT NULL DEFAULT 0");
    ensure("plans", "goal_session_provider_session_id", "TEXT");
    ensure("plans", "proposal_revision", "INTEGER NOT NULL DEFAULT 0");
    ensure("plans", "proposal", "TEXT");
    ensure("plans", "approval_revision", "INTEGER");
    ensure("plans", "approval_at", "TEXT");
    ensure("plans", "transition_status", "TEXT");
    ensure("plans", "goal_session_error", "TEXT");
    ensure("plans", "goal_session_pending_input", "TEXT");
    ensure("plans", "goal_session_active_input", "TEXT");
    ensure("plans", "delivery_mode", "TEXT NOT NULL DEFAULT 'single'");
    ensure("plans", "delivery_status", "TEXT NOT NULL DEFAULT 'planning'");
    ensure("plans", "integration_branch", "TEXT");
    ensure("plans", "integration_worktree_path", "TEXT");
    ensure("plans", "final_pr_number", "INTEGER");
    ensure("plans", "final_pr_url", "TEXT");
    ensure("plans", "delivery_error", "TEXT");
    ensure("plans", "verified_at", "TEXT");
    ensure("plans", "cmux_group_id", "TEXT");
    ensure("plans", "cmux_notice_key", "TEXT");
    ensure("plans", "merge_workspace_id", "TEXT");
    ensure("plans", "merge_status", "TEXT");
    ensure("plans", "integration_worktree_removed_at", "TEXT");
    ensure("plan_tasks", "worktree_removed_at", "TEXT");
    ensure("plans", "merge_session_closed_at", "TEXT");
    ensure("plans", "superseded_merge_workspaces", "TEXT NOT NULL DEFAULT '[]'");
    ensure("plans", "followups", "TEXT NOT NULL DEFAULT '[]'");
    ensure("plans", "board_status", "TEXT");
    ensure("plans", "board_changed_at", "TEXT");
    ensure("plans", "board_pr_number", "INTEGER");
    ensure("plans", "board_pr_url", "TEXT");
    ensure("plans", "board_pr_state", "TEXT");
    ensure("plans", "board_pr_observed_at", "TEXT");
    ensure("plans", "contract_version", "INTEGER NOT NULL DEFAULT 1");
    ensure("plans", "spec", "TEXT");
    ensure("plans", "readiness", "TEXT");
    ensure("plans", "last_error", "TEXT");
    ensure("plans", "last_error_at", "TEXT");
    ensure("plan_tasks", "task_type", "TEXT NOT NULL DEFAULT 'feature'");
    ensure("plan_tasks", "criterion_ids", "TEXT NOT NULL DEFAULT '[]'");
    ensure("plan_tasks", "depends_on", "TEXT NOT NULL DEFAULT '[]'");
    ensure("plan_tasks", "owned_areas", "TEXT NOT NULL DEFAULT '[]'");
    ensure("plan_tasks", "verification", "TEXT NOT NULL DEFAULT '[]'");
    ensure("plan_tasks", "wave", "INTEGER NOT NULL DEFAULT 0");
    ensure("plan_tasks", "launch_reason", "TEXT");
    ensure("plan_tasks", "start_sha", "TEXT");
    ensure("plan_tasks", "head_sha", "TEXT");
    ensure("plan_tasks", "completion_report", "TEXT");
    ensure("plan_tasks", "evidence_status", "TEXT");
    ensure("plan_tasks", "evidence_error", "TEXT");
    ensure("plan_tasks", "changed_files", "TEXT NOT NULL DEFAULT '[]'");
    ensure("plan_tasks", "scope_warnings", "TEXT NOT NULL DEFAULT '[]'");
    ensure("plan_tasks", "delivery_status", "TEXT NOT NULL DEFAULT 'pending'");
    ensure("plan_tasks", "integrated_commit_sha", "TEXT");
    ensure("plan_tasks", "session_closed_at", "TEXT");
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
      AND (merge_workspace_id IS NULL OR merge_session_closed_at IS NOT NULL)
      AND (integration_worktree_path IS NULL OR integration_worktree_removed_at IS NOT NULL)
      AND (workflow != 'goal_session' OR (goal_session_workspace_id IS NULL AND goal_session_worktree_path IS NULL))
      AND NOT EXISTS (
        SELECT 1 FROM plan_tasks t WHERE t.plan_id = plans.plan_id
          AND ((t.workspace_id IS NOT NULL AND t.session_closed_at IS NULL)
            OR (t.worktree_path IS NOT NULL AND t.worktree_removed_at IS NULL))
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(plans.superseded_merge_workspaces)
        WHERE json_extract(value, '$.retiredAt') IS NULL
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
    engine: { provider: row.engine_provider || "claude", model: row.engine_model || "default", effort: row.engine_effort || "default", reviewer: row.engine_reviewer === 1 },
    specOptions: safeSpecOptions(parse(row.spec_options, null)),
    reviewOptions: safeReviewOptions(parse(row.review_options, null)),
    reviewWorkspaceId: row.review_workspace_id ?? null,
    reviewStatus: row.review_status ?? null,
    reviewBriefPath: row.review_brief_path ?? null,
    reviewLaunchedAt: row.review_launched_at ?? null,
    reviewSessionClosedAt: row.review_session_closed_at ?? null,
    workflow: row.workflow || "planned",
    goalSessionState: row.goal_session_state ?? null,
    goalSessionWorkspaceId: row.goal_session_workspace_id ?? null,
    goalSessionWorktreePath: row.goal_session_worktree_path ?? null,
    goalSessionBranch: row.goal_session_branch ?? null,
    goalSessionGeneration: Number(row.goal_session_generation) || 0,
    goalSessionProviderSessionId: row.goal_session_provider_session_id ?? null,
    proposalRevision: Number(row.proposal_revision) || 0,
    proposal: parse(row.proposal, null),
    approvalRevision: Number.isInteger(row.approval_revision) ? row.approval_revision : null,
    approvalAt: row.approval_at ?? null,
    transitionStatus: row.transition_status ?? null,
    goalSessionError: row.goal_session_error ?? null,
    goalSessionPendingInput: row.goal_session_pending_input ?? null,
    goalSessionActiveInput: row.goal_session_active_input ?? null,
    sessionId: row.session_id,
    round: row.round,
    status: row.status,
    stage: row.stage,
    questions: parse(row.questions, []),
    contractVersion: Number(row.contract_version) || 1,
    spec: parse(row.spec, null),
    readiness: parse(row.readiness, null),
    lastError: row.last_error ?? null,
    lastErrorAt: row.last_error_at ?? null,
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
    cmuxNoticeKey: row.cmux_notice_key ?? null,
    mergeWorkspaceId: row.merge_workspace_id,
    mergeStatus: row.merge_status,
    mergeSessionClosedAt: row.merge_session_closed_at ?? null,
    supersededMergeWorkspaces: parse(row.superseded_merge_workspaces, []),
    followups: parse(row.followups, []),
    boardStatus: boardStatus(row.board_status),
    boardChangedAt: row.board_changed_at ?? null,
    boardPrNumber: Number.isInteger(row.board_pr_number) ? row.board_pr_number : null,
    boardPrUrl: row.board_pr_url ?? null,
    boardPrState: boardPrState(row.board_pr_state),
    boardPrObservedAt: row.board_pr_observed_at ?? null,
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
    type: row.task_type || "feature",
    criterionIds: parse(row.criterion_ids, []),
    dependsOn: parse(row.depends_on, []),
    ownedAreas: parse(row.owned_areas, []),
    verification: parse(row.verification, []),
    wave: Number(row.wave) || 0,
    launchStatus: row.launch_status,
    launchError: row.launch_error,
    launchReason: row.launch_reason || classifyLegacyWorktreeError(row.launch_error),
    worktreePath: row.worktree_path,
    workspaceId: row.workspace_id,
    startSha: row.start_sha,
    headSha: row.head_sha,
    completionReport: parse(row.completion_report, null),
    evidenceStatus: row.evidence_status,
    evidenceError: row.evidence_error,
    changedFiles: parse(row.changed_files, []),
    scopeWarnings: parse(row.scope_warnings, []),
    deliveryStatus: row.delivery_status || "pending",
    integratedCommitSha: row.integrated_commit_sha,
    sessionClosedAt: row.session_closed_at ?? null,
  };
}

function deliveryMode(tasks) {
  return Array.isArray(tasks) && tasks.length > 1 ? "combined" : "single";
}

function policy(value) {
  return value === "combined" ? "combined" : "auto";
}

// A plan row must stay readable. A blank column, a legacy row, hand-edited
// JSON or an unknown key therefore reads as all options off instead of
// throwing and hiding the whole plan.
function safeSpecOptions(value) {
  try {
    return normalizeSpecOptions(value ?? undefined);
  } catch {
    return normalizeSpecOptions();
  }
}

// A stored lifecycle value that is neither terminal state reads as unset. A
// database edited by hand must not put an unknown word on the board.
// `group_concat` returns one comma-joined string, or null when a plan has no
// open session. The merge session lives on the plan row, not in plan_tasks, so
// it is appended here rather than in the query.
function splitIds(joined, mergeWorkspaceId) {
  const ids = String(joined || "").split(",").map((value) => value.trim()).filter(Boolean);
  const merge = text(mergeWorkspaceId);
  if (merge && !ids.includes(merge)) ids.push(merge);
  return ids;
}

// A retirement entry names its own kind, because a workspace id alone cannot
// say which column holds its stamp. An entry with no kind is read the old way,
// so the relaunch caller keeps working unchanged.
function sessionKind(value, taskId, workspaceIdValue, liveMergeWorkspaceId) {
  if (value === "task" || value === "merge" || value === "superseded") return value;
  if (taskId) return "task";
  return workspaceIdValue && workspaceIdValue === liveMergeWorkspaceId ? "merge" : "superseded";
}

function boardStatus(value) {
  return BOARD_STATUSES.has(value) ? value : null;
}

function boardPrState(value) {
  return BOARD_PR_STATES.has(value) ? value : null;
}

function prNumber(value) {
  return Number.isInteger(value) ? value : null;
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
