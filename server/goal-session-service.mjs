import { randomUUID } from "node:crypto";
import { normalizePlannerEngine } from "./worktree-planner.mjs";
import { normalizeSpecOptions } from "./spec-options.mjs";
import { safeReviewOptions } from "./review-options.mjs";

// Owns only the visible, one-worktree session path. Legacy saved plans keep
// their existing planner/launch flow and never enter this service.
export class GoalSessionService {
  constructor({ store, worktrees, cmux, modelSettings, log = null } = {}) {
    if (!store || !worktrees || !cmux) throw new TypeError("Goal sessions need plan storage, worktrees and cmux");
    this.store = store; this.worktrees = worktrees; this.cmux = cmux; this.modelSettings = modelSettings; this.log = log;
  }

  async start({ repositoryId, goal, engine = {}, specOptions = {}, reviewOptions = {} } = {}) {
    const text = String(goal || "").trim();
    if (!text || text.length > 4_000) throw new TypeError("Describe the goal for this repository");
    const repository = await this.worktrees.resolveRepository(repositoryId);
    const planId = randomUUID();
    const selectedEngine = normalizePlannerEngine(engine, this.modelSettings?.roles);
    this.store.createPlan({ planId, repositoryId: repository.id, repositoryName: repository.name, cwd: repository.primaryPath, goal: text,
      engine: selectedEngine, specOptions: normalizeSpecOptions(specOptions), reviewOptions: safeReviewOptions(reviewOptions) });
    const branch = `goal-session/${planId.slice(0, 12)}`;
    this.store.reserveGoalSession(planId, { branch, generation: 1 });
    try {
      const created = await this.worktrees.create(repository.id, { branch, base: "HEAD", requireFreshAtBase: true, workspaces: [], workspacesAvailable: true });
      const workspace = await this.cmux.workspaceCreate({ cwd: created.worktree.path, title: `Goal · ${text.slice(0, 72)}`, agent: "shell" });
      const plan = this.store.recordGoalSessionStart(planId, { worktreePath: created.worktree.path, workspaceId: workspace.workspace_id, generation: 1 });
      // Binding is durable before the terminal process starts. A crashed runner
      // can therefore be resumed in this exact workspace without creating a
      // second writer for the worktree.
      await this.cmux.workspaceStartGoalSessionRunner(workspace.workspace_id, { planId, databasePath: this.store.path, generation: plan.goalSessionGeneration });
      return this.store.get(planId);
    } catch (cause) {
      this.store.recordGoalSessionStartFailure(planId, cause?.message || "Goal session could not start");
      throw cause;
    }
  }

  approve(planId, decision) { return this.store.approveProposal(planId, decision); }
  requestChanges(planId, decision) { return this.store.requestProposalChanges(planId, decision); }
}
