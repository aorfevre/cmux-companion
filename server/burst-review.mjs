import { open } from "node:fs/promises";
import { join } from "node:path";
import { identifier } from "./agent-brief.mjs";
import { sessionEnv } from "./session-name.mjs";

const SETTLED = new Set(["running", "pass", "blocked_twice"]);
// The task id a goal session's single review files under.
const GOAL_TASK = "goal";
// A verdict is a sentence or two per finding. Anything past this is not a
// verdict, whatever it is, and must not be parsed as one.
const MAX_VERDICT_BYTES = 64 * 1024;

// A reviewer must never open on a goal that ended. Automatic paths swallow
// this error by name; see the integrator's TerminalGoalError for the twin.
export class BurstReviewTerminalError extends TypeError {}

// The extra reviewer a burst goal buys. One session per finished task, on the
// task's own worktree, with the other provider. It writes a verdict file and
// stops; the Stop hook brings the verdict back here. Twice at most.
export class BurstReview {
  constructor({ store, cmux, briefs, modelSettings, log = null } = {}) {
    if (!store || !cmux || !briefs || !modelSettings) throw new TypeError("Burst review needs a store, cmux, briefs and model settings");
    this.store = store;
    this.cmux = cmux;
    this.briefs = briefs;
    this.modelSettings = modelSettings;
    this.log = log;
  }

  // The integrator asks this before it treats a ready task as ready.
  taskReady(plan, task) {
    if (task.deliveryStatus !== "ready") return false;
    if (plan?.burst !== true) return true;
    return task.burstReviewStatus === "pass";
  }

  // Returns true when a reviewer session was opened, false when nothing was
  // needed. It never throws for a task that is simply not reviewable yet.
  async reviewTask(planId, taskId) {
    const plan = this.store.get(planId);
    const task = plan?.tasks?.find((item) => item.id === taskId);
    if (!plan || !task || plan.burst !== true) return false;
    if (task.deliveryStatus !== "ready" || !task.worktreePath) return false;
    if (SETTLED.has(task.burstReviewStatus)) return false;
    const round = (Number(task.burstReviewRound) || 0) + 1;
    const verdictPath = this.verdictPath(plan.planId, task.id, round);
    const brief = await this.briefs.write({ planId: plan.planId, taskId: `${task.id}-burst-review-${round}`, markdown: burstReviewPrompt(plan, task, verdictPath) });
    const workspaceId = await this.#createGuarded(plan.planId, {
      cwd: task.worktreePath,
      title: `Burst review ${round}: ${String(task.title || task.id).slice(0, 60)}`,
      ...this.modelSettings.workspace("codeReviewer", reviewerProvider(task.agent)),
      env: sessionEnv(plan, task),
      prompt: this.briefs.pointerPrompt({ title: `Burst review: ${task.title || task.id}`, outcome: plan.spec?.outcome || plan.goal, path: brief.path }),
    });
    this.store.recordBurstReviewLaunched(plan.planId, task.id, { workspaceId, headSha: task.headSha || null });
    return true;
  }

  // The abort race, handled the way the merge session handles it: read the
  // lifecycle right before cmux is asked, and again right after it answers. A
  // session created in that gap is closed here, and its id is recorded first
  // so a failed close is still the reaper's to finish after a restart.
  async #createGuarded(planId, options) {
    this.#assertNotTerminal(this.store.get(planId));
    const created = await this.cmux.workspaceCreate(options);
    const workspaceId = created?.workspace_id || created?.workspaceId || created?.id || null;
    if (!workspaceId) throw new TypeError("cmux created the review session but did not return its id");
    try { this.#assertNotTerminal(this.store.get(planId)); }
    catch (cause) {
      try { this.store.recordMergeCleanupRequired(planId, workspaceId); }
      catch (recordError) { cause.message += `; cleanup identity could not be saved: ${recordError.message}`; }
      try { await this.cmux.workspaceClose?.(workspaceId); }
      catch (closeError) {
        this.log?.warn?.({ err: closeError, planId, workspaceId }, "cancelled burst review session needs cleanup");
        cause.message += `; session ${workspaceId} still needs cleanup: ${closeError.message}`;
      }
      throw cause;
    }
    return workspaceId;
  }

  #assertNotTerminal(plan) {
    if (!plan) throw new BurstReviewTerminalError("The goal could not be read. Retry before creating a review session");
    if (plan.boardStatus === "aborted") throw new BurstReviewTerminalError("This goal was aborted, so no burst review will be opened for it");
    if (plan.boardStatus === "merged") throw new BurstReviewTerminalError("This goal is already merged, so no burst review will be opened for it");
  }

  // The goal-session counterpart of reviewTask: one reviewer on the goal's own
  // worktree once its pull request is open. The plan-level review columns
  // hold the claim, so two watch passes cannot open two reviewers.
  async reviewGoal(planId) {
    const plan = this.store.get(planId);
    if (!plan || plan.burst !== true || plan.workflow !== "goal_session") return false;
    if (!plan.goalSessionWorktreePath || !(plan.boardPrUrl || plan.finalPrUrl)) return false;
    if (plan.reviewStatus) return false;
    const provider = reviewerProvider(plan.engine?.provider);
    const claimed = this.store.claimGoalReview(plan.planId, { agent: provider });
    if (!claimed) return false;
    try {
      const verdictPath = this.verdictPath(plan.planId, GOAL_TASK, 1);
      const task = { id: GOAL_TASK, title: plan.goal, branch: plan.goalSessionBranch, criterionIds: (plan.spec?.acceptanceCriteria || []).map((criterion) => criterion.id), ownedAreas: [] };
      const brief = await this.briefs.write({ planId: plan.planId, taskId: `${GOAL_TASK}-burst-review-1`, markdown: burstReviewPrompt(plan, task, verdictPath) });
      const workspaceId = await this.#createGuarded(plan.planId, {
        cwd: plan.goalSessionWorktreePath,
        title: `Burst review: ${String(plan.goal).slice(0, 60)}`,
        ...this.modelSettings.workspace("codeReviewer", provider),
        env: sessionEnv(plan, null),
        prompt: this.briefs.pointerPrompt({ title: `Burst review: ${plan.goal}`, outcome: plan.spec?.outcome || plan.goal, path: brief.path }),
      });
      this.store.recordReviewLaunched(plan.planId, { workspaceId, agent: provider, briefPath: brief.path });
      return true;
    } catch (cause) {
      this.store.releaseGoalReview(plan.planId);
      throw cause;
    }
  }

  // Called for every agent Stop. Returns false when the workspace is not one
  // of ours, so the caller can hand it to the integrator's own path.
  async onWorkspaceStopped(workspaceId) {
    const found = this.store.findTaskByBurstReviewWorkspace?.(workspaceId);
    if (!found) return this.#onGoalReviewStopped(workspaceId);
    const plan = this.store.get(found.planId);
    const task = plan?.tasks?.find((item) => item.id === found.taskId);
    if (!plan || !task || task.burstReviewStatus !== "running") return false;
    const verdict = await this.#readVerdict(this.verdictPath(plan.planId, task.id, task.burstReviewRound));
    const updated = this.store.recordBurstReviewVerdict(plan.planId, task.id, verdict);
    const after = updated.tasks.find((item) => item.id === task.id);
    if (verdict.verdict === "pass") return true;
    const summary = verdict.findings.map((item) => `- ${item}`).join("\n");
    if (after.burstReviewStatus === "blocked_twice") {
      this.store.recordTaskPending(plan.planId, task.id, { error: `Burst review blocked twice; a person decides next. Findings:\n${summary}` });
      return true;
    }
    this.store.recordTaskPending(plan.planId, task.id, { error: `Burst review found blocking issues (round ${task.burstReviewRound})` });
    if (task.workspaceId && this.cmux.sendWorkspacePrompt) {
      await this.cmux.sendWorkspacePrompt(task.workspaceId, [
        "An independent burst review of your branch found blocking issues:",
        summary,
        "Address each finding, amend the final commit so it keeps the Cmux-Goal-Ready and Cmux-Goal-Report trailers, force-push with lease, then stop again. A second review follows.",
      ].join("\n")).catch((cause) => this.log?.warn?.({ err: cause, taskId: task.id }, "burst review findings could not reach the owner"));
    }
    return true;
  }

  async #onGoalReviewStopped(workspaceId) {
    const plan = this.store.findPlanByReviewWorkspace?.(workspaceId);
    if (!plan || plan.burst !== true || plan.reviewStatus !== "running" || plan.reviewSessionClosedAt) return false;
    const verdict = await this.#readVerdict(this.verdictPath(plan.planId, GOAL_TASK, 1));
    this.store.recordReviewSessionClosed(plan.planId);
    if (verdict.verdict === "pass" || !plan.goalSessionWorkspaceId || !this.cmux.sendWorkspacePrompt) return true;
    await this.cmux.sendWorkspacePrompt(plan.goalSessionWorkspaceId, [
      "An independent burst review of your pull request found blocking issues:",
      verdict.findings.map((item) => `- ${item}`).join("\n"),
      "Address each finding on the same branch and push. Companion observes the pull request; do not merge.",
    ].join("\n")).catch((cause) => this.log?.warn?.({ err: cause, planId: plan.planId }, "burst goal review findings could not reach the owner"));
    return true;
  }

  // The same sanitiser the brief file goes through, so the verdict always
  // sits beside its brief and never outside the briefs directory.
  verdictPath(planId, taskId, round) {
    return join(this.briefs.directory, `${identifier(planId, "planId")}-${identifier(taskId, "taskId")}-burst-review-${Math.max(1, Number(round) || 1)}.json`);
  }

  async #readVerdict(path) {
    let raw;
    try { raw = await readCapped(path, MAX_VERDICT_BYTES); }
    catch { return { verdict: "block", findings: ["The reviewer stopped without writing a verdict file; no verdict file was found"] }; }
    try {
      if (raw === null) throw new Error(`the file is larger than ${MAX_VERDICT_BYTES} bytes`);
      const value = JSON.parse(raw);
      if (value?.verdict !== "pass" && value?.verdict !== "block") throw new Error("verdict must be pass or block");
      const findings = Array.isArray(value.findings) ? value.findings.map((item) => String(item || "").trim()).filter(Boolean) : [];
      return { verdict: value.verdict, findings };
    } catch (cause) {
      return { verdict: "block", findings: [`The verdict file is malformed: ${String(cause?.message || cause).slice(0, 200)}`] };
    }
  }
}

// Reads at most `limit` bytes; null when the file holds more than that.
async function readCapped(path, limit) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, limit + 1, 0);
    return bytesRead > limit ? null : buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

// The reviewer is always the other provider, so a claude task gets a codex
// reader and a codex task gets a claude reader.
export function reviewerProvider(agent) {
  return agent === "codex" ? "claude" : "codex";
}

export function burstReviewPrompt(plan, task, verdictPath) {
  const owned = new Set(task.criterionIds || []);
  const criteria = (plan.spec?.acceptanceCriteria || []).filter((criterion) => owned.has(criterion.id));
  return [
    `# Burst review: ${task.title || task.id}`,
    `Goal: ${plan.goal}`,
    `Outcome: ${plan.spec?.outcome || plan.goal}`,
    `Branch: ${task.branch} against ${plan.baseRef || "origin/main"}`,
    `Owned areas: ${(task.ownedAreas || []).join(", ") || "(unspecified)"}`,
    "",
    "## Acceptance criteria this task owns",
    ...(criteria.length ? criteria.map((criterion) => `- ${criterion.id}: ${criterion.text}\n  Verify: ${criterion.verification}`) : ["- (none recorded; judge against the goal and outcome)"]),
    "",
    "## Your job",
    "1. Read the diff of this branch against its base.",
    "2. Run the repository's own verification if it is documented (README or AGENTS.md).",
    "3. Judge correctness, regressions, missing tests, security and scope drift outside the owned areas.",
    "Do not edit files. Do not commit. Do not push. You review only.",
    "",
    "## Verdict",
    `Write exactly one JSON file at ${verdictPath} with this shape and then stop:`,
    '{"verdict":"pass","findings":[]} or {"verdict":"block","findings":["one concrete, actionable finding", "..."]}',
    "Use block only for a finding that must change before merge. Put advisory notes in findings with a pass verdict.",
  ].join("\n");
}
