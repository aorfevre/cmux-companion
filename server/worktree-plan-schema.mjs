const PLAN_SCHEMA = `
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
  ,goal_session_question_revision INTEGER NOT NULL DEFAULT 0
  ,goal_session_runner_pid INTEGER
  ,goal_session_runner_started_at TEXT
  ,goal_session_runner_dispatch_id TEXT
  ,goal_session_runner_dispatched_at TEXT
  ,goal_session_correction_input TEXT
  ,goal_session_correction_status TEXT
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
CREATE TABLE IF NOT EXISTS goal_reports (
  plan_id TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  approval_revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  base_sha TEXT,
  created_at TEXT NOT NULL,
  coding_goal_id TEXT,
  PRIMARY KEY (plan_id, version)
);
CREATE TABLE IF NOT EXISTS goal_reviews (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  generation INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 0,
  pid INTEGER,
  result TEXT,
  error TEXT,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (plan_id, kind, target)
);
CREATE INDEX IF NOT EXISTS plans_repository_updated ON plans (repository_id, updated_at);
CREATE INDEX IF NOT EXISTS plan_events_plan_id ON plan_events (plan_id, id);
`;

export function initializePlanSchema(db) {
  db.exec(PLAN_SCHEMA);
  migratePlanSchema(db);
}

function migratePlanSchema(db) {
    const ensure = (table, column, declaration) => {
      const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
      if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    };
    ensure("goal_reviews", "post_owner", "INTEGER");
    ensure("goal_reviews", "post_pid", "INTEGER");
    ensure("goal_reviews", "runner_owner", "INTEGER");
    ensure("plans", "goal_type", "TEXT NOT NULL DEFAULT 'coding'");
    ensure("plans", "source_analysis", "TEXT");
    ensure("plans", "base_sha", "TEXT");
    ensure("plans", "source_type", "TEXT");
    ensure("plans", "issues_returned_at", "TEXT");
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
    ensure("plans", "discovery_context", "TEXT");
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
    ensure("plans", "goal_session_question_revision", "INTEGER NOT NULL DEFAULT 0");
    ensure("plans", "goal_session_runner_pid", "INTEGER");
    ensure("plans", "goal_session_runner_started_at", "TEXT");
    ensure("plans", "goal_session_runner_dispatch_id", "TEXT");
    ensure("plans", "goal_session_runner_dispatched_at", "TEXT");
    ensure("plans", "goal_session_correction_input", "TEXT");
    ensure("plans", "goal_session_correction_status", "TEXT");
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
    ensure("plans", "burst", "INTEGER NOT NULL DEFAULT 0");
    ensure("plan_tasks", "burst_review_status", "TEXT");
    ensure("plan_tasks", "burst_review_round", "INTEGER NOT NULL DEFAULT 0");
    ensure("plan_tasks", "burst_review_workspace_id", "TEXT");
    ensure("plan_tasks", "burst_review_findings", "TEXT NOT NULL DEFAULT '[]'");
}
