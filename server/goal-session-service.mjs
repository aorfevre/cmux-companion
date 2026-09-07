import { randomUUID } from "node:crypto";
import { normalizeImages, normalizePlannerEngine } from "./worktree-planner.mjs";
import { normalizeSpecOptions } from "./spec-options.mjs";
import { safeReviewOptions } from "./review-options.mjs";

// Owns only the visible, one-worktree session path. Legacy saved plans keep
// their existing planner/launch flow and never enter this service.
export class GoalSessionService {
  constructor({ store, worktrees, cmux, modelSettings, log = null, processAlive = isProcessAlive } = {}) {
    if (!store || !worktrees || !cmux) throw new TypeError("Goal sessions need plan storage, worktrees and cmux");
    this.store = store; this.worktrees = worktrees; this.cmux = cmux; this.modelSettings = modelSettings; this.log = log;
    this.processAlive = processAlive;
  }

  async start({ repositoryId, goal, images, engine = {}, specOptions = {}, reviewOptions = {} } = {}) {
    const text = String(goal || "").trim();
    if (!text || text.length > 4_000) throw new TypeError("Describe the goal for this repository");
    const repository = await this.worktrees.resolveRepository(repositoryId);
    const planId = randomUUID();
    const attachments = normalizeImages(images);
    const selectedEngine = normalizePlannerEngine(engine, this.modelSettings?.roles);
    this.store.createPlan({ planId, repositoryId: repository.id, repositoryName: repository.name, cwd: repository.primaryPath, goal: text, images: attachments,
      engine: selectedEngine, specOptions: normalizeSpecOptions(specOptions), reviewOptions: safeReviewOptions(reviewOptions) });
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
      const baseSha = await this.worktrees.repoCatalog?.git?.(created.worktree.path, ["rev-parse", "HEAD"])
        .then((value) => String(value).trim(), () => "") || "";
      this.store.recordGoalSessionBase(planId, { baseRef: created.baseRef || null, baseSha });
      // Durably own the checkout before the cmux side effect. A crash at the
      // next boundary can recover only this path, never create a second writer.
      this.store.recordGoalSessionWorktree(planId, { worktreePath: created.worktree.path, generation: 1 });
      const workspace = await this.cmux.workspaceCreate({ cwd: created.worktree.path, title: `Goal · ${text.slice(0, 72)}`, agent: "shell" });
      const plan = this.store.recordGoalSessionStart(planId, { worktreePath: created.worktree.path, workspaceId: workspace.workspace_id, generation: 1 });
      await this.#startRunner(plan);
      return this.store.get(planId);
    } catch (cause) {
      this.store.recordGoalSessionStartFailure(planId, cause?.message || "Goal session could not start");
      throw withPlanId(cause, planId);
    }
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
    try {
      await this.cmux.workspaceStartGoalSessionRunner(plan.goalSessionWorkspaceId, {
        planId: plan.planId, databasePath: this.store.path, generation: plan.goalSessionGeneration, dispatchId,
      });
    } catch (cause) {
      this.store.releaseGoalSessionRunnerDispatch(plan.planId, { generation: plan.goalSessionGeneration, dispatchId });
      throw cause;
    }
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
  const error = cause instanceof Error ? cause : new Error(String(cause || "Goal session could not start"));
  error.planId = planId;
  return error;
}
