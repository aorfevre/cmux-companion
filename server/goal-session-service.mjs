import { createHash, randomUUID } from "node:crypto";
import { normalizeImages, normalizePlannerEngine, normalizeIssueNumbers, normalizeIssueUrls } from "./worktree-planner.mjs";
import { normalizeSpecOptions } from "./spec-options.mjs";
import { safeReviewOptions } from "./review-options.mjs";

// Owns only the visible, one-worktree session path. Legacy saved plans keep
// their existing planner/launch flow; an explicit restart creates a new goal.
export class GoalSessionService {
  constructor({ store, worktrees, cmux, modelSettings, log = null, processAlive = isProcessAlive } = {}) {
    if (!store || !worktrees || !cmux) throw new TypeError("Goal sessions need plan storage, worktrees and cmux");
    this.store = store; this.worktrees = worktrees; this.cmux = cmux; this.modelSettings = modelSettings; this.log = log;
    this.processAlive = processAlive;
  }

  async start({ repositoryId, goal, images, engine = {}, specOptions = {}, reviewOptions = {}, idempotencyKey = null, issueNumbers = [], issueUrls = [] } = {}) {
    const text = String(goal || "").trim();
    if (!text || text.length > 4_000) throw new TypeError("Describe the goal for this repository");
    const repository = await this.worktrees.resolveRepository(repositoryId);
    const planId = validIdempotencyKey(idempotencyKey) || randomUUID();
    const attachments = normalizeImages(images);
    const linkedIssues = normalizeIssueNumbers(issueNumbers);
    const linkedUrls = normalizeIssueUrls(issueUrls);
    const selectedEngine = normalizePlannerEngine(engine, this.modelSettings?.roles);
    const selectedReview = safeReviewOptions(reviewOptions);
    if (selectedReview.codeReview || selectedEngine.reviewer) throw new TypeError("Managed goal sessions do not support automated reviewers. Use Plan this goal for reviewed delivery");
    const selectedOptions = normalizeSpecOptions(specOptions);
    const existing = this.store.get(planId);
    if (existing) {
      if (existing.workflow !== "goal_session" || existing.repositoryId !== repository.id || existing.goal !== text || !same(existing.issueNumbers, linkedIssues) || !same(existing.issueUrls, linkedUrls) || !same(existing.images, attachments) || !same(existing.engine, selectedEngine) || !same(existing.specOptions, selectedOptions) || !same(existing.reviewOptions, selectedReview)) throw new TypeError("This goal-session request key belongs to a different goal");
      return existing;
    }
    this.store.createPlan({ planId, repositoryId: repository.id, repositoryName: repository.name, cwd: repository.primaryPath, goal: text, images: attachments,
      engine: selectedEngine, specOptions: selectedOptions, reviewOptions: selectedReview,
      sourceType: linkedIssues.length ? "github_issues" : null, issueNumbers: linkedIssues, issueUrls: linkedUrls });
    const branch = `goal-session/${planId.slice(0, 12)}`;
    this.store.reserveGoalSession(planId, { branch, generation: 1 });
    try {
      const inventory = await this.#inventory();
      // WorktreeDashboard resolves and fetches the actual default remote
      // branch. Never start this isolated checkout from stale local HEAD.
      const created = await this.worktrees.create(repository.id, {
        branch, useDefaultBase: true, requireFreshAtBase: true,
        workspaces: inventory.workspaces, workspacesAvailable: true,
      });
      // This is the first irreversible external boundary. Persist the path
      // before any subsequent Git read can fail or the process can restart.
      this.store.recordGoalSessionWorktree(planId, { worktreePath: created.worktree.path, generation: 1 });
      const baseSha = await this.worktrees.repoCatalog?.git?.(created.worktree.path, ["rev-parse", "HEAD"])
        .then((value) => String(value).trim(), () => "") || "";
      this.store.recordGoalSessionBase(planId, { baseRef: created.baseRef || null, baseSha });
      const workspace = await this.cmux.workspaceCreate({ cwd: created.worktree.path, title: `Goal · ${text.slice(0, 72)}`, agent: "shell" });
      const plan = this.store.recordGoalSessionStart(planId, { worktreePath: created.worktree.path, workspaceId: workspace.workspace_id, generation: 1 });
      await this.#startRunner(plan);
      return this.store.get(planId);
    } catch (cause) {
      this.store.recordGoalSessionStartFailure(planId, cause?.message || "Goal session could not start");
      throw withPlanId(cause, planId);
    }
  }

  // One durable successor per stopped discovery, including after a lost HTTP
  // response or a browser reload. Restarting its successor is a separate action.
  async restart(planId) {
    const source = this.store.get(planId);
    if (!source || source.boardStatus !== "aborted") throw new TypeError("Abort the old goal before restarting discovery");
    if (source.tasks?.length || source.status === "launched") throw new TypeError("Restart discovery is only available before development tasks exist");
    const hash = createHash("sha256").update(`goal-discovery-restart:${source.planId}`).digest("hex");
    const idempotencyKey = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    const existing = this.store.get(idempotencyKey);
    if (existing) {
      if (existing.workflow !== "goal_session" || existing.repositoryId !== source.repositoryId || existing.goal !== source.goal) throw new TypeError("The discovery restart identity belongs to a different goal");
      return existing;
    }
    if (source.goalSessionRunnerPid && this.processAlive(source.goalSessionRunnerPid)) throw new TypeError("The old discovery runner is still active. Wait for it to stop");
    if (source.goalSessionWorkspaceId) {
      const inventory = await this.#inventory();
      if (inventory.workspaces.some((workspace) => (workspace.id || workspace.workspace_id) === source.goalSessionWorkspaceId)) throw new TypeError("Close the old discovery workspace before restarting");
    }
    // Resolve authorization before releasing issue ownership. A failed start
    // leaves the original readable and issues available for an explicit retry.
    await this.worktrees.resolveRepository(source.repositoryId);
    if (source.issueNumbers?.length) this.store.returnIssuesToBacklog(source.planId);
    return this.start({ repositoryId: source.repositoryId, goal: source.goal, images: source.images,
      engine: { ...source.engine, reviewer: false }, specOptions: source.specOptions,
      reviewOptions: { ...source.reviewOptions, codeReview: false },
      issueNumbers: source.issueNumbers, issueUrls: source.issueUrls, idempotencyKey });
  }

  // Recovery is explicit and reuses only durable ids. It never looks at a
  // title or transcript and refuses a second runner while its recorded local
  // process is live.
  async recover(planId) {
    let plan = this.store.get(planId);
    if (!plan || plan.workflow !== "goal_session" || plan.boardStatus) throw new TypeError("This managed goal session is unavailable");
    if (!plan.goalSessionWorktreePath) throw new TypeError("This goal stopped before its worktree was recorded. Start a new goal rather than risking a second checkout");
    if (!plan.goalSessionWorkspaceId) throw new TypeError("This goal stopped before its workspace identity was recorded. Recovery will not create a second conversation");
    const activePid = plan.goalSessionRunnerPid;
    if (activePid && this.processAlive(activePid)) {
      // A provider failure leaves the runner alive and holding this workspace.
      // It can consume a durable retry queue; starting another process here
      // would create a second writer in the same terminal.
      if (plan.goalSessionError && plan.goalSessionState === "planning") return this.store.retryGoalSessionTurn(plan.planId, { generation: plan.goalSessionGeneration });
      throw new TypeError("This goal session runner is still active in its workspace");
    }
    if (activePid) this.store.clearDeadGoalSessionRunner(plan.planId, { generation: plan.goalSessionGeneration, pid: activePid });
    plan = this.store.get(plan.planId);
    if (plan.goalSessionRunnerDispatchId) throw new TypeError("Starting this goal session runner is still uncertain. Reopen its recorded conversation before retrying");
    if (plan.goalSessionError && plan.goalSessionState === "planning") plan = this.store.retryGoalSessionTurn(plan.planId, { generation: plan.goalSessionGeneration });
    await this.#startRunner(plan);
    return this.store.get(plan.planId);
  }

  async #inventory() {
    const inventory = await (this.cmux.loadWorkspaceListDetailed ? this.cmux.loadWorkspaceListDetailed() : this.cmux.workspaceListDetailed());
    if (!Array.isArray(inventory?.workspaces)) throw new TypeError("cmux sessions could not be checked before starting this goal");
    return inventory;
  }

  async #startRunner(plan) {
    if (!plan?.goalSessionWorkspaceId || !plan?.goalSessionGeneration) throw new TypeError("This goal session has no durable workspace");
    const dispatchId = randomUUID();
    this.store.claimGoalSessionRunnerDispatch(plan.planId, { generation: plan.goalSessionGeneration, dispatchId });
    // A transport error can arrive after cmux accepted surface.send_text. The
    // durable dispatch remains uncertain instead of permitting a retry to
    // inject a second runner into the visible workspace.
    await this.cmux.workspaceStartGoalSessionRunner(plan.goalSessionWorkspaceId, {
      planId: plan.planId, databasePath: this.store.path, generation: plan.goalSessionGeneration, dispatchId,
    });
  }

  findByWorkspace(workspaceId) { return this.store.findGoalSessionByWorkspace(workspaceId); }
  approve(planId, decision) { return this.store.approveProposal(planId, decision); }
  requestChanges(planId, decision) { return this.store.requestProposalChanges(planId, decision); }
  answer(planId, answer) { return this.store.submitGoalSessionAnswer(planId, answer); }
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (cause) { return cause?.code === "EPERM"; }
}

function withPlanId(cause, planId) {
  const error = new TypeError(cause?.message || String(cause || "Goal session could not start"));
  error.planId = planId;
  return error;
}

function validIdempotencyKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key) return null;
  if (!/^[0-9a-f-]{36}$/i.test(key)) throw new TypeError("Invalid goal-session request key");
  return key;
}

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
