import { firstReason as firstStuckReason } from "./goal-health-summary.mjs";
import { providerCapacity } from "./capacity-policy.mjs";
import { ModelSettings } from "./model-settings.mjs";
import { DEFAULT_MODEL_ROLES, currentModelId, normalizeModelId, roleEngine } from "./model-options.mjs";
export { parsePlannerReply, parseDiscussionReply } from "./planner-reply.mjs";
import { streamExecFile } from "./planner-process.mjs";
export { streamExecFile, finalEnvelope, progressEvent } from "./planner-process.mjs";
import { existsSync } from "node:fs";
import {
  completionReportInstruction,
  formatDesignArtifacts,
  formatOptionEvidence,
  normalizeContractTask,
  normalizeDeliveryContract,
  taskWave,
  validateDeliveryContract,
} from "./delivery-contract.mjs";
import { safeSpecOptions, specOptionsBriefLines } from "./spec-options.mjs";
import { safeReviewOptions } from "./review-options.mjs";
import { burstBriefLines } from "./burst-options.mjs";
import { AgentBriefs } from "./agent-brief.mjs";
import { resolveDefaultBaseRef } from "./default-base-ref.mjs";
import { PlannerRuns } from "./planner-runs.mjs";
import { LaunchRuns } from "./launch-runs.mjs";
import { goalBoardState } from "./goal-board.mjs";
import { sessionEnv, sessionTitle } from "./session-name.mjs";
import { acquireTaskWorktree, effectiveTaskBranch, launchReason } from "./task-branch.mjs";
import { PLANNER_ENGINES } from "./worktree-planner-options.mjs";

export { PLANNER_ENGINES, reviewerEngine } from "./worktree-planner-options.mjs";

const BUSY = "This goal is planning right now. Wait for the round to finish";
// A launch creates worktrees and cmux sessions. A second one would create them
// twice, so it is refused in the same voice as a second planner round.
const LAUNCHING = "This goal is launching right now. Wait for the launch to finish";
const ABORTED_ROUND = "This goal was aborted, so its planner round stopped";
// A terminal goal is finished. Every mutation says so in the sentence the sheet
// shows, rather than failing with a generic message the user cannot act on.
const ABORTED_PLAN = "This goal was aborted. Start a new goal";
const MERGED_PLAN = "This goal is already merged. Start a new goal";

const CLOSE_ENOUGH = 10;
const LABELS = { claude: "Claude", codex: "Codex" };

export function assignAgents(tasks, usage) {
  const states = { claude: providerCapacity(usage, "claude"), codex: providerCapacity(usage, "codex") };
  const claude = states.claude.headroom;
  const codex = states.codex.headroom;
  const list = Array.isArray(tasks) ? tasks : [];

  if (claude === null && codex === null) {
    const fallback = ["claude", "codex"].find((id) => states[id].state === "unknown");
    if (!fallback && list.length) throw new TypeError("No provider has usable quota. Check limits, paused accounts or reconnection before trying again");
    return list.map((task) => ({ ...task, agent: fallback, agentReason: "Account usage is unavailable · provider fallback; quota unverified" }));
  }
  if (claude === null) return list.map((task) => ({ ...task, ...describe("codex", codex) }));
  if (codex === null) return list.map((task) => ({ ...task, ...describe("claude", claude) }));

  const roomier = codex > claude ? "codex" : "claude";
  const other = roomier === "codex" ? "claude" : "codex";
  const headroom = { claude, codex };
  if (Math.abs(codex - claude) > CLOSE_ENOUGH) {
    return list.map((task) => ({ ...task, ...describe(roomier, headroom[roomier]) }));
  }
  return list.map((task, index) => {
    const agent = index % 2 === 0 ? roomier : other;
    return { ...task, ...describe(agent, headroom[agent]) };
  });
}

// The percentage is the provider's best usable account, not a promise about the
// account that runs the task: assignAgents chooses a provider, never an account.
function describe(agent, percent) {
  return { agent, agentReason: `${LABELS[agent]} · best account ${Math.round(percent)}% left` };
}

const DRAFT_TTL_MS = 30 * 60_000;
// A planner round is not slow because it is stuck. It reads the repository, and
// a long goal against a large repository legitimately takes many minutes, while
// printing a tool line every few seconds. Measured: three rounds on one goal all
// died at 361s under the old wall-clock limit and could never have finished.
// So silence is the failure signal, and the ceiling only bounds a true hang.
const ROUND_IDLE_TIMEOUT_MS = Number(process.env.CMUX_PLANNER_IDLE_TIMEOUT_MS) || 240_000;
const ROUND_CEILING_MS = Number(process.env.CMUX_PLANNER_CEILING_MS) || 1_800_000;
const MAX_TASKS = 8;
const MAX_IMAGES = 4;

export function normalizePlannerEngine(engine, roles = DEFAULT_MODEL_ROLES) {
  if (engine === undefined) engine = {};
  if (!engine || typeof engine !== "object" || Array.isArray(engine)) {
    throw new TypeError("Planner engine configuration must be an object");
  }
  const provider = engine.provider ?? roles.planner.provider;
  if (typeof provider !== "string" || !Object.hasOwn(PLANNER_ENGINES.providers, provider)) {
    throw new TypeError("Unknown planner provider. Choose Claude or Codex");
  }
  const model = normalizeModelId(currentModelId(engine.model ?? roleEngine(roles, "planner", provider).model));
  const effort = engine.effort ?? PLANNER_ENGINES.defaultEffort;
  if (!PLANNER_ENGINES.efforts.some((option) => option.id === effort)) {
    throw new TypeError("Unknown planner effort. Choose Default, Low, Medium, High, or Xhigh");
  }
  if (engine.reviewer !== undefined && typeof engine.reviewer !== "boolean") {
    throw new TypeError("The reviewer setting must be on or off");
  }
  return { provider, model, effort, reviewer: engine.reviewer === true };
}

// ccs draws its errors as a box: ANSI colour, border glyphs, a blank padded
// line between every sentence, and a bare docs URL last. Taking the last stderr
// line therefore reported only the URL. Strip the frame, then keep the words.
const BOX_GLYPHS = /[\u2500-\u257f]/gu;
// eslint-disable-next-line no-control-regex -- stripping ANSI needs the escape byte.
const ANSI = /\u001b\[[0-9;]*m/gu;

export function describeRunFailure(stderr) {
  const lines = String(stderr || "")
    .replace(ANSI, "")
    .replace(BOX_GLYPHS, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const text = lines.join(" ");
  // E301 is the one failure an operator can fix without reading the docs, and
  // the launchd PATH omits ~/.local/bin, where the installer puts claude.
  if (/E301|Claude CLI not found/i.test(text)) {
    return "The planner could not run: ccs cannot find the claude CLI on PATH. Add its directory to the companion PATH, or set CCS_CLAUDE_PATH to the binary";
  }
  const detail = lines.filter((line) => !/^https?:\/\//.test(line) && line !== "ERROR").at(-1);
  return detail ? `The planner could not run: ${detail.slice(0, 160)}` : "The planner could not run. Try again";
}

// A killed round has two very different causes, and the user acts on each one
// differently: silence means try again, while the ceiling means the goal is too
// large for one round. An unlabelled kill keeps the old wording, because a fake
// `execute` in a test rejects without a reason.
export function describeTimeout(reason, idleTimeoutMs, ceilingMs) {
  if (reason === "aborted") return ABORTED_ROUND;
  if (reason === "idle") return `The planner stopped answering: no output for ${minutes(idleTimeoutMs)}. Try again`;
  if (reason === "ceiling") return `The planner ran for ${minutes(ceilingMs)} without finishing. Start again with a narrower goal`;
  return "The planner did not answer in time. Try again";
}

function minutes(ms) {
  const value = Math.max(1, Math.round(Number(ms) / 60_000));
  return `${value} minute${value === 1 ? "" : "s"}`;
}

export class WorktreePlanner {
  constructor({ worktrees, cmux, accountUsage, modelSettings = new ModelSettings(), log = null, execute = streamExecFile, git = null, maxRounds = 6, idleTimeoutMs = ROUND_IDLE_TIMEOUT_MS, ceilingMs = ROUND_CEILING_MS, usageTimeoutMs = 10_000, ttlMs = DRAFT_TTL_MS, store = null, runs = null, launches = null, progress = null, pushService = null, briefs = new AgentBriefs(), onLaunchSettled = null } = {}) {
    if (!worktrees) throw new TypeError("A worktree dashboard is required");
    if (!cmux) throw new TypeError("A cmux client is required");
    this.worktrees = worktrees;
    // The dashboard owns the repo catalog, which owns the injected git runner.
    this.git = git || ((cwd, args, options) => worktrees.repoCatalog.git(cwd, args, options));
    this.cmux = cmux;
    this.modelSettings = modelSettings;
    this.accountUsage = accountUsage;
    // The full brief goes to a file. cmux caps a prompt at 8,000 characters, so
    // the session gets a short pointer to that file instead of the brief text.
    this.briefs = briefs;
    this.log = log;
    this.execute = execute;
    this.maxRounds = maxRounds;
    this.idleTimeoutMs = idleTimeoutMs;
    this.ceilingMs = ceilingMs;
    this.usageTimeoutMs = usageTimeoutMs;
    this.ttlMs = ttlMs;
    // The database owns every plan. The map is only a hot cache in front of it,
    // so a companion restart loses no goal, no session and no task list.
    this.store = store;
    // A background round outlives its request, so the registry, not the request
    // cycle, is what says whether a plan is busy.
    this.runs = runs || new PlannerRuns();
    // A launch is not a specification round, so it gets its own registry. One
    // shared map would put a launching goal in the "Writing Spec" column.
    this.launches = launches || new LaunchRuns();
    // The dashboard caches describe worktrees a background launch creates, so
    // they can only be invalidated once that launch has settled.
    this.onLaunchSettled = onLaunchSettled;
    // The same hub the synchronous rounds publish to. A background round keys
    // its stream on the plan id, which exists before the round starts.
    this.progress = progress;
    this.pushService = pushService;
    this.drafts = new Map();
    // One controller per active round, keyed by plan id. Abort reaches the ccs
    // child through it, and every exit path deletes its own entry, so a
    // finished round leaves nothing behind for a later abort to kill.
    this.controllers = new Map();
    this.taskOperations = new Set();
  }

  // One notification per background launch, and only one. It names the count,
  // because "the launch finished" does not say whether anything started.
  #notifyLaunch(draft, result) {
    const launched = Number(result?.launched) || 0;
    // A launch that started nothing is a failure the user has to act on, even
    // though no exception was thrown. It must not report as a success.
    if (launched === 0) {
      const reason = result?.results?.find((item) => item?.status === "failed")?.error || "No task could start";
      this.#notifyLaunchFailure(draft, reason);
      return;
    }
    void this.#push({
      title: "A goal is running",
      body: `${launched} session${launched === 1 ? "" : "s"} started for “${shortGoal(draft.goal)}”`,
      kind: "completion",
      planId: draft.planId,
    });
  }

  #notifyLaunchFailure(draft, message) {
    void this.#push({
      title: "A goal launch failed",
      body: `“${shortGoal(draft.goal)}”: ${message}`,
      kind: "failure",
      planId: draft.planId,
    });
  }

  // A launch that threw wrote nothing, so the plan would show a goal that is
  // still "ready to launch" and no reason why the launch never happened. The
  // per-task rows carry the failure and the plan row carries the sentence, so
  // a sheet reopened later can explain it.
  #recordLaunchFailure(draft, message) {
    const results = (draft.tasks || []).map((task) => ({
      id: task.id,
      title: task.title,
      branch: task.branch,
      agent: task.agent,
      status: "failed",
      error: message,
    }));
    this.#persist(() => this.store?.recordLaunch(draft.planId, { base: null, baseSha: null, results }), draft.planId, "launch-failed");
    draft.lastError = message;
    draft.lastErrorAt = new Date().toISOString();
    this.#persist(() => this.store?.recordRoundFailure(draft.planId, message), draft.planId, "launch-failed");
  }

  // The dashboard caches describe the worktrees this launch created, so they
  // are only stale once it has settled. A hook that throws must never turn a
  // finished launch into a failed one.
  #launchSettled(planId) {
    try {
      this.onLaunchSettled?.(planId);
    } catch (cause) {
      this.log?.warn?.({ err: cause, planId }, "launch settled hook failed");
    }
  }

  // A notification is the least important part of a round. It must never turn a
  // finished plan into a failed one.
  async #push(payload) {
    try {
      await this.pushService?.send({ ...payload, tag: `cmux-plan-${payload.planId}` });
    } catch (cause) {
      this.log?.warn?.({ err: cause, planId: payload.planId }, "planner notification failed");
    }
  }

  // One ccs session id belongs to one plan, so two rounds at once on the same
  // plan would corrupt it. Different plans are free to run together.
  #assertIdle(planId) {
    if (this.runs.isRunning(planId)) throw new TypeError(BUSY);
  }

  // A terminal goal takes no more work. It stays readable and deletable, so
  // only the mutating paths call this.
  #assertNotTerminal(planId) {
    const status = this.#read(() => this.store?.get(String(planId || ""))?.boardStatus) || null;
    if (status === "aborted") throw new TypeError(ABORTED_PLAN);
    if (status === "merged") throw new TypeError(MERGED_PLAN);
  }

  // Stop a goal for good. It closes every cmux session the goal is known to
  // own, and it deliberately leaves the worktrees, the branches and the plan
  // row alone: the work stays on disk for the user to read or reuse.
  //
  // The whole call is idempotent. A second abort records no second event and
  // retries only the closures that failed the first time.
  async abort(planId) {
    const id = String(planId || "");
    const plan = this.#read(() => this.store?.get(id));
    if (!plan) throw new TypeError("Unknown plan. Start a new goal");
    if (plan.boardStatus === "merged") throw new TypeError("This goal is already merged, so it cannot be aborted");
    const alreadyAborted = plan.boardStatus === "aborted";

    // Cancel the live specification round first. Its child dies, its run and
    // its progress stream finish as aborted, and no later round can start.
    const controller = this.controllers.get(id);
    if (controller) {
      controller.abort();
      this.controllers.delete(id);
    }
    if (this.runs.isRunning(id)) {
      this.progress?.publish(id, { k: "error", t: ABORTED_ROUND });
      this.runs.finish(id, { phase: "aborted", error: ABORTED_ROUND });
    }
    this.drafts.delete(id);
    if (!alreadyAborted) this.#persist(() => this.store?.recordGoalAborted(id), id, "abort");

    const closedSessionIds = [];
    const failedSessionIds = [];
    for (const workspaceId of goalWorkspaceIds(plan)) {
      try {
        await this.cmux?.workspaceClose?.(workspaceId);
        closedSessionIds.push(workspaceId);
      } catch (cause) {
        this.log?.warn?.({ err: cause, planId: id, workspaceId }, "closing an aborted goal session failed");
        failedSessionIds.push(workspaceId);
      }
    }
    return { planId: id, aborted: true, alreadyAborted, closedSessionIds, failedSessionIds };
  }

  // One task starts again on a plan that is already launched.
  //
  // `launch()` cannot do this. It goes through `#draft`, which refuses every
  // launched plan, so a task whose agent died had no route back and the goal
  // was locked for good. This reads the stored plan directly, exactly as the
  // integrator does for a wave, and touches one task only.
  //
  // Three modes, because a dead agent, a wrong turn and a branch ownership
  // collision need different things:
  //   - `continue` keeps the worktree and whatever the agent already wrote,
  //     and opens a fresh session on it. This is the common case.
  //   - `restart` throws the working tree away and rebuilds from the base.
  //   - `rebranch` preserves it and starts in a newly derived branch.
  async relaunchTask(planId, taskId, options = {}) {
    const key = `${planId}/${taskId}`;
    if (this.taskOperations.has(key)) throw new TypeError("This task already has a recovery operation in progress");
    this.taskOperations.add(key);
    try { return await this.#relaunchTask(planId, taskId, options); }
    finally { this.taskOperations.delete(key); }
  }

  async #relaunchTask(planId, taskId, { mode = "continue", closeLive = false } = {}) {
    if (!new Set(["continue", "restart", "rebranch"]).has(mode)) throw new TypeError("Relaunch mode must be continue, restart, or rebranch");
    const { plan, task } = this.#launchedTask(planId, taskId);
    if (task.deliveryStatus === "integrated") throw new TypeError("This task is already merged into the goal branch");
    if (!this.cmux) throw new TypeError("Relaunching a task needs a cmux connection");
    if (providerCapacity(await this.#usage(true), task.agent).state === "blocked") {
      throw new TypeError("This provider has no usable quota. Check limits, paused accounts or reconnection before retrying");
    }

    // Two agents in one worktree would fight over the same files, so a live
    // session must go before a new one starts.
    //
    // A crashed agent usually leaves its workspace open at a shell prompt, and
    // that is the commonest way a task dies. Refusing outright sent the user to
    // cmux to close it by hand and come back, which is the round trip this
    // whole path exists to remove. `closeLive` closes it here instead — but
    // only when asked, because a session that is genuinely working must never
    // be killed by a button labelled Continue.
    const inventory = await this.#workspaces();
    if (task.workspaceId && !inventory.available) {
      throw new TypeError("This task's cmux session could not be checked. Reconnect cmux before relaunching it");
    }
    const live = task.workspaceId
      ? inventory.workspaces.find((workspace) => workspace?.id === task.workspaceId) || null
      : null;
    if (live && !closeLive) throw new TypeError("This task's cmux session is still open. Close it first, or answer it, before relaunching");
    if (live) {
      let closeError;
      try { await this.cmux.workspaceClose(task.workspaceId); }
      catch (cause) { closeError = cause; }
      // Even an acknowledged close must become visible in a fresh inventory.
      // A transport failure is recoverable only when that inventory proves
      // the old workspace is gone; it is never permission for another writer.
      const fresh = await this.#workspaces();
      if (!fresh.available || fresh.workspaces.some((workspace) => workspace?.id === task.workspaceId)) {
        throw new TypeError(`The previous session could not be confirmed closed. Retry before relaunching${closeError?.message ? `: ${closeError.message}` : ""}`);
      }
    }

    const base = plan.deliveryMode === "combined" && plan.integrationBranch ? plan.integrationBranch : plan.baseRef || "origin/main";
    const result = mode === "restart"
      ? await this.#relaunchClean(plan, task, base, inventory)
      : mode === "rebranch"
        ? await this.#relaunchRebranch(plan, task, base, inventory)
        : await this.#relaunchContinue(plan, task);
    // The dead session is recorded as closed before the new id is written, or
    // the old workspace id would vanish with nothing saying it was retired.
    if (task.workspaceId) this.#persist(() => this.store?.recordSessionsRetired(plan.planId, [{ workspaceId: task.workspaceId, taskId: task.id }]), plan.planId, "relaunch-retire");
    this.#persist(() => this.store?.recordTaskRelaunch(plan.planId, task.id, result), plan.planId, "relaunch");
    if (result.status === "failed") throw new TypeError(result.error || "Could not relaunch this task");
    return { planId: plan.planId, taskId: task.id, mode, ...result };
  }

  // Drop a task the goal no longer needs, so one dead task stops blocking the
  // merge for every other task that finished.
  async skipTask(planId, taskId, { reason = null } = {}) {
    const { plan, task } = this.#launchedTask(planId, taskId);
    if (task.deliveryStatus === "integrated") throw new TypeError("This task is already merged, so it cannot be skipped");
    let closedSession = null;
    if (task.workspaceId && await this.#liveSession(task.workspaceId)) {
      closedSession = await this.cmux?.workspaceClose?.(task.workspaceId).then(() => task.workspaceId, (cause) => {
        this.log?.warn?.({ err: cause, planId: plan.planId, taskId: task.id }, "closing a skipped task session failed");
        return null;
      });
    }
    this.#persist(() => this.store?.recordTaskSkipped(plan.planId, task.id, reason), plan.planId, "skip");
    return { planId: plan.planId, taskId: task.id, skipped: true, closedSession };
  }

  // Reuse the existing worktree with its work in it. `worktrees.create` refuses
  // a dirty worktree by design, which is right for a launch and wrong here:
  // half-finished work is exactly what this mode continues. So the path is
  // checked directly and no worktree call is made.
  async #relaunchContinue(plan, task) {
    const summary = { id: task.id, title: task.title, branch: task.branch, agent: task.agent };
    const path = String(task.worktreePath || "");
    if (!path || !existsSync(path)) {
      throw new TypeError("This task has no worktree left to continue. Relaunch it with restart instead");
    }
    try {
      const head = String(await this.git(path, ["rev-parse", "HEAD"]).catch(() => "")).trim() || null;
      const brief = await this.briefs.write({
        planId: plan.planId,
        taskId: task.id,
        markdown: taskPrompt(task, plan.spec, plan.images, task.branch, plan.deliveryMode, `${plan.planId}/${task.id}`, plan.issueNumbers, plan.specOptions, plan.burst),
      });
      const workspace = await this.cmux.workspaceCreate({
        cwd: path,
        title: sessionTitle(plan, task),
        ...this.modelSettings.workspace("coder", task.agent),
        env: sessionEnv(plan, task),
        prompt: this.briefs.pointerPrompt({
          title: task.title,
          outcome: plan.spec?.outcome || plan.goal,
          path: brief.path,
          resume: "A previous agent worked in this worktree and stopped. Read the brief, then run `git status` and `git log` to see what is already done. Continue from there. Do not start again from nothing.",
        }),
      });
      return { ...summary, status: "launched", launchReason: null, path, workspace, startSha: task.startSha || head };
    } catch (cause) {
      this.log?.warn?.({ err: cause, planId: plan.planId, taskId: task.id }, "task relaunch failed");
      return { ...summary, status: "failed", launchReason: launchReason(cause), path, error: cause?.message || "Could not relaunch this task" };
    }
  }

  // Throw the working tree away and start the task again from its base. The
  // branch is deleted first, because `create` checks out an existing branch and
  // would put the agent back on the work this mode was asked to discard.
  async #relaunchClean(plan, task, base, inventory) {
    const summary = { id: task.id, title: task.title, branch: task.branch, agent: task.agent };
    let branch = task.branch;
    let path = null;
    try {
      await this.worktrees.removeBranchWorktree(plan.repositoryId, task.branch, {
        workspaces: inventory.workspaces,
        workspacesAvailable: inventory.available,
        allowedWorkspaceIds: task.workspaceId ? [task.workspaceId] : [],
      });
      const created = await acquireTaskWorktree({
        worktrees: this.worktrees,
        repositoryId: plan.repositoryId,
        repositoryPath: plan.cwd,
        branch: task.branch,
        base,
        inventory,
        git: this.git,
        planId: plan.planId,
        taskId: task.id,
        log: this.log,
      });
      branch = created.branch;
      const effectiveTask = { ...task, branch: created.branch };
      path = created.worktree.path;
      const startSha = String(await this.git(path, ["rev-parse", "HEAD"]).catch(() => "")).trim() || null;
      const brief = await this.briefs.write({
        planId: plan.planId,
        taskId: task.id,
        markdown: taskPrompt(effectiveTask, plan.spec, plan.images, base, plan.deliveryMode, `${plan.planId}/${task.id}`, plan.issueNumbers, plan.specOptions, plan.burst),
      });
      const workspace = await this.cmux.workspaceCreate({
        cwd: path,
        title: sessionTitle(plan, effectiveTask),
        ...this.modelSettings.workspace("coder", effectiveTask.agent),
        env: sessionEnv(plan, effectiveTask),
        prompt: this.briefs.pointerPrompt({ title: task.title, outcome: plan.spec?.outcome || plan.goal, path: brief.path }),
      });
      return { ...summary, branch: effectiveTask.branch, status: "launched", launchReason: null, path, workspace, startSha };
    } catch (cause) {
      branch = effectiveTaskBranch(cause, branch);
      this.log?.warn?.({ err: cause, branch, planId: plan.planId, taskId: task.id }, "task restart failed");
      return { ...summary, branch, status: "failed", launchReason: launchReason(cause), path, error: cause?.message || "Could not restart this task" };
    }
  }

  // A branch collision is not permission to delete the occupied branch. This
  // mode derives the next bounded candidate and creates exactly one new
  // worktree from the same base a clean restart would use.
  async #relaunchRebranch(plan, task, base, inventory) {
    const summary = { id: task.id, title: task.title, branch: task.branch, agent: task.agent };
    let branch = task.branch;
    let path = null;
    try {
      const created = await acquireTaskWorktree({
        worktrees: this.worktrees,
        repositoryId: plan.repositoryId,
        repositoryPath: plan.cwd,
        branch: task.branch,
        base,
        inventory,
        git: this.git,
        planId: plan.planId,
        taskId: task.id,
        log: this.log,
        forceFresh: true,
        fallbackReason: task.launchReason,
      });
      branch = created.branch;
      const effectiveTask = { ...task, branch: created.branch };
      path = created.worktree.path;
      const startSha = String(await this.git(path, ["rev-parse", "HEAD"]).catch(() => "")).trim() || null;
      const brief = await this.briefs.write({
        planId: plan.planId,
        taskId: task.id,
        markdown: taskPrompt(effectiveTask, plan.spec, plan.images, base, plan.deliveryMode, `${plan.planId}/${task.id}`, plan.issueNumbers, plan.specOptions, plan.burst),
      });
      const workspace = await this.cmux.workspaceCreate({
        cwd: path,
        title: sessionTitle(plan, effectiveTask),
        ...this.modelSettings.workspace("coder", effectiveTask.agent),
        env: sessionEnv(plan, effectiveTask),
        prompt: this.briefs.pointerPrompt({ title: effectiveTask.title, outcome: plan.spec?.outcome || plan.goal, path: brief.path }),
      });
      return { ...summary, branch: effectiveTask.branch, status: "launched", launchReason: null, path, workspace, startSha };
    } catch (cause) {
      branch = effectiveTaskBranch(cause, branch);
      this.log?.warn?.({ err: cause, branch, planId: plan.planId, taskId: task.id }, "task rebranch failed");
      return { ...summary, branch, status: "failed", launchReason: launchReason(cause), path, error: cause?.message || "Could not rebranch this task" };
    }
  }

  // Reads a task from the durable row, never the draft cache. Both recovery
  // actions are for launched plans, which the draft cache refuses by design.
  #launchedTask(planId, taskId) {
    const id = String(planId || "");
    this.#assertNotTerminal(id);
    const plan = this.#read(() => this.store?.get(id));
    if (!plan) throw new TypeError("Unknown plan. Start a new goal");
    if (plan.workflow === "goal_session") throw new TypeError("This managed goal owns its visible cmux conversation and cannot launch a legacy task recovery");
    if (plan.status !== "launched") throw new TypeError("This goal has not launched yet, so it has no task to recover");
    const task = (plan.tasks || []).find((item) => item.id === String(taskId || ""));
    if (!task) throw new TypeError("Unknown task in this goal");
    return { plan, task };
  }

  // Returns the live workspace when cmux still holds it. Callers that can
  // create a competing task session use #workspaces directly so unavailable
  // inventory remains distinct from a confirmed empty list.
  async #liveSession(workspaceIdValue) {
    const id = String(workspaceIdValue || "").trim();
    if (!id) return null;
    const inventory = await this.#workspaces();
    if (!inventory.available) return null;
    return inventory.workspaces.find((workspace) => workspace?.id === id) || null;
  }

  isRunning(planId) {
    return this.runs.isRunning(planId);
  }

  // A launch is not a planner round, so it answers a question of its own.
  isLaunching(planId) {
    return this.launches.isLaunching(planId);
  }

  activeRuns() {
    return { runs: this.runs.list() };
  }

  async update(planId, { tasks } = {}) {
    const draft = await this.#draft(planId);
    this.#assertIdle(draft.planId);
    if (!Array.isArray(tasks) || !tasks.length) throw new TypeError("Keep at least one task");
    if (tasks.length > MAX_TASKS) throw new TypeError(`A plan can hold at most ${MAX_TASKS} tasks`);
    const next = tasks.map((task, index) => {
      const previous = draft.tasks.find((item) => item.id === task?.id) || draft.tasks[index] || {};
      const branch = String(task?.branch || "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/.test(branch) || branch.includes("..")) {
        throw new TypeError(`Task ${index + 1} needs a valid Git branch name`);
      }
      const title = String(task?.title || "").trim();
      const prompt = String(task?.prompt || "").trim();
      if (!title || !prompt) throw new TypeError(`Task ${index + 1} needs a title and a prompt`);
      const agent = task?.agent === "codex" ? "codex" : "claude";
      const contract = normalizeContractTask({
        criterionIds: draft.spec?.acceptanceCriteria?.map((criterion) => criterion.id) || [],
        ownedAreas: ["**/*"],
        verification: ["Run the repository verification appropriate for this task"],
        ...previous,
        ...task,
        title, branch, prompt,
      }, index);
      return { ...contract, agent, agentReason: String(task?.agentReason || "") };
    });
    const branches = new Set(next.map((task) => task.branch));
    if (branches.size !== next.length) throw new TypeError("Two tasks share a branch name");
    const readiness = validateDeliveryContract(draft.spec, next, draft.specOptions);
    if (!readiness.ready) throw new TypeError(readiness.errors[0]);
    draft.tasks = next.map((task) => ({ ...task, wave: taskWave(task.id, readiness) }));
    draft.readiness = readiness;
    draft.at = Date.now();
    this.#persist(() => this.store?.recordEdit(draft.planId, draft.tasks, readiness), draft.planId, "edit");
    return publicDraft(draft);
  }

  async launch(planId) {
    const draft = await this.#launchable(planId);
    if (!this.launches.begin(draft.planId)) throw new TypeError(LAUNCHING);
    try { return await this.#launchWork(draft); }
    finally { this.launches.finish(draft.planId); this.#launchSettled(draft.planId); }
  }

  // The background entry point. It answers as soon as the launch is registered,
  // and the worktrees and the sessions are created after the request has ended.
  //
  // Every validation that can fail cheaply already ran in #launchable, so the
  // caller still learns about an unusable plan in its own hand. Nothing awaits
  // the work below, so both outcomes are handled here: an unhandled rejection
  // would take the whole companion down.
  async launchBackground(planId) {
    const draft = await this.#launchable(planId);
    // The registry, not the check above, is the real gate. Two requests can
    // both pass an async validation before either of them registers.
    if (!this.launches.begin(draft.planId)) throw new TypeError(LAUNCHING);
    Promise.resolve()
      .then(() => this.#launchWork(draft))
      .then((result) => {
        this.launches.finish(draft.planId);
        this.#notifyLaunch(draft, result);
        this.#launchSettled(draft.planId);
      })
      .catch((cause) => {
        this.launches.finish(draft.planId);
        const message = cause?.message || "The launch failed";
        this.log?.warn?.({ err: cause, planId: draft.planId }, "background launch failed");
        this.#recordLaunchFailure(draft, message);
        this.#notifyLaunchFailure(draft, message);
        this.#launchSettled(draft.planId);
      });
    return { planId: draft.planId, launching: true };
  }

  // The validation both launch paths share. It is cheap and it touches nothing
  // outside this process, so a background launch can run it before it answers.
  async #launchable(planId) {
    const draft = await this.#draft(planId);
    this.#assertIdle(draft.planId);
    if (this.launches.isLaunching(draft.planId)) throw new TypeError(LAUNCHING);
    if (draft.status !== "ready" || !draft.tasks.length) throw new TypeError("This plan is not ready to launch yet");
    const readiness = validateDeliveryContract(draft.spec, draft.tasks, draft.specOptions);
    if (!readiness.ready) throw new TypeError(`This delivery contract is not ready: ${readiness.errors[0]}`);
    draft.readiness = readiness;
    return draft;
  }

  // Everything a launch does after the plan is known to be launchable. The
  // synchronous path awaits it; the background path detaches it. Neither one
  // has its own copy, so the two can never drift apart.
  async #launchWork(draft) {
    const base = await this.#baseRef(draft);
    const repositoryPath = await this.#repositoryPath(draft);
    const baseSha = String(await this.git(repositoryPath, ["rev-parse", `${base}^{commit}`]).catch(() => "")).trim() || null;
    const deliveryMode = planDeliveryMode(draft);
    const firstWave = Math.min(...draft.tasks.map((task) => Number(task.wave) || 0));
    // A retry may find worktrees a failed launch left behind. Reuse needs the
    // live session list to tell a stranded worktree from one an agent owns.
    // An unreachable cmux only makes the check stricter, never looser.
    const inventory = await this.#workspaces();
    const results = [];
    for (const task of draft.tasks) {
      if ((Number(task.wave) || 0) !== firstWave) {
        results.push({ id: task.id, title: task.title, branch: task.branch, agent: task.agent, status: "queued", launchReason: null, wave: task.wave });
        continue;
      }
      results.push(await this.#launchTask(draft, task, base, deliveryMode, baseSha, inventory, repositoryPath));
    }
    const launched = results.filter((item) => item.status === "launched").length;
    const effectiveBranches = new Map(results.map((result) => [result.id, result.branch]));
    draft.tasks = draft.tasks.map((task) => ({ ...task, branch: effectiveBranches.get(task.id) || task.branch }));
    this.#persist(() => this.store?.recordLaunch(draft.planId, { base, baseSha, results }), draft.planId, "launch");
    // Deleting stops a plan running twice. That risk does not exist when nothing
    // was created, and keeping the draft saves the user a fresh planner round
    // after a transient failure such as cmux being down.
    if (launched > 0) this.drafts.delete(draft.planId);
    return { planId: draft.planId, base, baseSha, deliveryMode, launched, results };
  }

  // One task never rolls back another: a half-made plan the user can see and
  // finish by hand beats a silent undo of work that already started.
  async #launchTask(draft, task, base, deliveryMode, startSha = null, inventory = { available: false, workspaces: [] }, repositoryPath = draft.cwd) {
    const summary = { id: task.id, title: task.title, branch: task.branch, agent: task.agent };
    let branch = task.branch;
    let path = null;
    try {
      if (providerCapacity(await this.#usage(true), task.agent).state === "blocked") {
        throw new TypeError("This provider has no usable quota. Check limits, paused accounts or reconnection before retrying");
      }
      const created = await acquireTaskWorktree({
        worktrees: this.worktrees,
        repositoryId: draft.repositoryId,
        repositoryPath,
        branch: task.branch,
        base,
        inventory,
        git: this.git,
        planId: draft.planId,
        taskId: task.id,
        log: this.log,
      });
      branch = created.branch;
      const effectiveTask = { ...task, branch: created.branch };
      path = created.worktree.path;
      // create() checks out an existing branch and ignores `base`, so the task
      // would start on old work instead of the fetched commit. Refuse it: an
      // agent committing on top of someone's in-progress branch is worse than
      // a failed row the user can act on. A reused worktree is exempt: it
      // already proved its HEAD equals `base`.
      if (created.branchCreated === false && !created.reused) {
        throw new TypeError(`Branch ${effectiveTask.branch} already exists, so this task would not start from ${base}. Rename it in the plan, or delete the branch first`);
      }
      // Each worktree agent is isolated, so every task brief carries its images
      // and the delivery contract selected for the whole goal. The brief is
      // written to disk; the session receives only a pointer to it.
      const brief = await this.briefs.write({
        planId: draft.planId,
        taskId: task.id,
        markdown: taskPrompt(effectiveTask, draft.spec, draft.images, base, deliveryMode, `${draft.planId}/${task.id}`, draft.issueNumbers, draft.specOptions, draft.burst),
      });
      const workspace = await this.cmux.workspaceCreate({
        cwd: path,
        title: sessionTitle(draft, effectiveTask),
        ...this.modelSettings.workspace("coder", effectiveTask.agent),
        env: sessionEnv(draft, effectiveTask),
        prompt: this.briefs.pointerPrompt({ title: effectiveTask.title, outcome: draft.spec?.outcome || draft.goal, path: brief.path }),
      });
      return { ...summary, branch: effectiveTask.branch, status: "launched", launchReason: null, path, workspace, startSha };
    } catch (cause) {
      branch = effectiveTaskBranch(cause, branch);
      this.log?.warn?.({ err: cause, branch, planId: draft.planId, taskId: task.id }, "planner task launch failed");
      return { ...summary, branch, status: "failed", launchReason: launchReason(cause), path, error: cause?.message || "Could not launch this task" };
    }
  }

  // Branch every task from the up-to-date default remote branch, so no task
  // inherits another task's work or a stale local commit.
  async #baseRef(draft) {
    return resolveDefaultBaseRef(this.git, await this.#repositoryPath(draft));
  }

  async #repositoryPath(draft) {
    const dashboard = await this.worktrees.snapshot({ refresh: false });
    const repository = dashboard.repositories.find((item) => item.id === draft.repositoryId);
    if (!repository) throw new TypeError("Unknown repository");
    return repository.path;
  }

  // Inventory availability is part of the answer. A genuinely new branch may
  // launch while cmux is unreachable, but an existing worktree may not be
  // reused or removed on the fiction that an exception meant "no sessions".
  async #workspaces() {
    try {
      const payload = await (this.cmux.loadWorkspaceListDetailed ? this.cmux.loadWorkspaceListDetailed() : this.cmux.workspaceListDetailed());
      return { available: Array.isArray(payload?.workspaces), workspaces: Array.isArray(payload?.workspaces) ? payload.workspaces : [] };
    } catch (cause) {
      this.log?.warn?.({ err: cause }, "planner could not read the workspace list");
      return { available: false, workspaces: [] };
    }
  }

  async #usage(refresh = false) {
    const timedOut = Symbol("usage-timeout");
    let timer = null;
    try {
      const snapshot = Promise.resolve().then(() => this.accountUsage?.snapshot({ refresh })).catch((cause) => {
        this.log?.warn?.({ err: cause }, "planner usage snapshot failed");
        return null;
      });
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(timedOut), this.usageTimeoutMs);
      });
      const result = await Promise.race([snapshot, timeout]);
      if (result === timedOut) {
        this.log?.warn?.({ timeoutMs: this.usageTimeoutMs }, "planner usage snapshot timed out");
        return null;
      }
      return result;
    } catch (cause) {
      this.log?.warn?.({ err: cause }, "planner usage snapshot failed");
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // A plan the cache dropped — through the TTL sweep, the size cap, or a
  // companion restart — is rebuilt from the database instead of being refused.
  async #draft(planId) {
    this.#sweep();
    const id = String(planId || "");
    // The durable row is the authority on a terminal outcome, so the guard runs
    // before the cache: an aborted goal whose draft is still hot must refuse
    // exactly like one that was reloaded from the database.
    this.#assertNotTerminal(id);
    const stored = this.#read(() => this.store?.get(id));
    const cached = this.drafts.get(id);
    // A few supported adapters intentionally keep only an in-memory draft.
    // A persisted row, when present, still wins for the managed-session guard.
    if (!stored && cached) return cached;
    if (!stored) throw new TypeError("Unknown plan. Start a new goal");
    // A managed goal owns one visible conversation and revision-bound decision
    // records. Legacy planner mutations must not create a second provider turn
    // or turn terminal/inbox text into an implementation approval.
    if (stored.workflow === "goal_session") throw new TypeError("This goal is managed in its cmux session. Use its proposal controls there");
    if (cached) return cached;
    if (stored.status === "launched") throw new TypeError("This plan is already launched. Start a new goal");
    const draft = draftFromStore(stored);
    this.drafts.set(draft.planId, draft);
    return draft;
  }

  // Reload a plan into memory and return it, so a reopened sheet continues the
  // same ccs session rather than starting a new one.
  async resume(planId) {
    const draft = await this.#draft(planId);
    return { ...publicDraft(draft), running: this.runs.isRunning(draft.planId), launching: this.launches.isLaunching(draft.planId) };
  }

  // The stored view of a plan, including a launched one, with its event log.
  async detail(planId) {
    const stored = this.#read(() => this.store?.get(String(planId || "")));
    if (!stored) throw new TypeError("Unknown plan. Start a new goal");
    const run = this.runs.get(stored.planId);
    // The live run fields are attached first, and only then is the board state
    // derived. Computing it on the stored row alone would put a plan that is
    // planning right now into the wrong column.
    const detail = {
      ...stored,
      events: this.#read(() => this.store?.events(stored.planId)) || [],
      // Its own query, not a filter over `events`: that reader is capped, so a
      // busy plan would lose its older discussions from the sheet.
      discussion: this.#read(() => this.store?.discussions(stored.planId)) || [],
      running: this.runs.isRunning(stored.planId),
      // A launching goal is neither planning nor launched yet. The marker is
      // its own field, so the board reads it without mistaking it for a
      // specification round.
      launching: this.launches.isLaunching(stored.planId),
      runPhase: run?.phase || null,
      runStage: run?.stage || null,
      runStep: run?.step || "",
      runError: run?.error || "",
    };
    return { ...detail, boardState: goalBoardState(detail) };
  }

  // A card needs to know that a plan is planning right now, and the run state
  // lives only in this process, so the list carries it rather than the store.
  //
  // `health` is optional and read-only. With it, a goal whose agents all died
  // lands in Blocked instead of reporting "Dev in progress"; without it the
  // list behaves exactly as it always did, so a cmux that cannot answer never
  // costs the board its goals.
  async list(options = {}, { health = null } = {}) {
    const plans = this.#read(() => this.store?.list(options)) || [];
    const verdicts = await this.#healthVerdicts(health, plans);
    return {
      plans: plans.map((plan) => {
        const run = this.runs.get(plan.planId);
        const verdict = verdicts.get(plan.planId) || null;
        const summary = {
          ...plan,
          running: this.runs.isRunning(plan.planId),
          launching: this.launches.isLaunching(plan.planId),
          runPhase: run?.phase || null,
          runStage: run?.stage || null,
          runStep: run?.step || "",
          runError: run?.error || "",
          health: verdict?.health || null,
          healthReason: verdict?.reason || null,
          stuckCount: verdict?.stuckCount ?? null,
        };
        return { ...summary, boardState: goalBoardState(summary) };
      }),
    };
  }

  // The sweep is best-effort. A failure returns no verdicts, so every goal
  // keeps its derived column: a supervision tool that hides the work when it
  // cannot reach cmux is worse than one that says nothing.
  async #healthVerdicts(health, plans) {
    const verdicts = new Map();
    if (!health?.sweep || !plans.some((plan) => plan.status === "launched")) return verdicts;
    try {
      const swept = await health.sweep();
      for (const goal of swept?.goals || []) {
        verdicts.set(goal.planId, {
          health: goal.health,
          stuckCount: goal.stuckCount,
          reason: firstStuckReason(goal),
        });
      }
    } catch (cause) {
      this.log?.warn?.({ err: cause }, "goal list could not read agent health");
    }
    return verdicts;
  }

  async remove(planId) {
    const id = String(planId || "");
    const plan = this.#read(() => this.store?.get(id));
    if (plan?.workflow === "goal_session") throw new TypeError("Managed goal sessions are retained for their workspace and approval record. Abort it instead");
    this.#assertIdle(id);
    this.drafts.delete(id);
    const deleted = this.#read(() => this.store?.delete(id)) === true;
    if (!deleted) throw new TypeError("Unknown plan. Start a new goal");
    return { planId: id, deleted: true };
  }

  // A storage failure must never lose a round the planner already paid for, so
  // a write that throws is logged and the answer still reaches the user.
  #persist(write, planId, step) {
    try {
      write();
    } catch (cause) {
      this.log?.warn?.({ err: cause, planId, step }, "planner plan store write failed");
    }
  }

  #read(read) {
    try {
      return read();
    } catch (cause) {
      this.log?.warn?.({ err: cause }, "planner plan store read failed");
      return null;
    }
  }

  #sweep() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, draft] of this.drafts) if (draft.at < cutoff) this.drafts.delete(id);
  }
}

// Every cmux session one goal is known to own: one per launched task, the live
// merge session, and every merge session a retry superseded. The ids are
// deduplicated, because a merge session that was later superseded appears in
// both lists and must not be closed twice.
function goalWorkspaceIds(plan) {
  const ids = (Array.isArray(plan?.tasks) ? plan.tasks : []).map((task) => task?.workspaceId);
  ids.push(plan?.mergeWorkspaceId, plan?.goalSessionWorkspaceId);
  for (const entry of Array.isArray(plan?.supersededMergeWorkspaces) ? plan.supersededMergeWorkspaces : []) {
    ids.push(typeof entry === "string" ? entry : entry?.workspaceId);
  }
  return [...new Set(ids.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean))];
}

// A notification body has room for a phrase, not a four-thousand-character goal.
function shortGoal(goal) {
  const text = String(goal || "").replace(/\s+/g, " ").trim();
  return text.length > 70 ? `${text.slice(0, 69)}…` : text;
}

function publicDraft(draft) {
  return {
    planId: draft.planId,
    repositoryId: draft.repositoryId,
    goal: draft.goal,
    images: draft.images || [],
    sourceType: draft.sourceType || null,
    issueNumbers: draft.issueNumbers || [],
    issueUrls: draft.issueUrls || [],
    deliveryPolicy: draft.deliveryPolicy || "auto",
    engine: draft.engine || normalizePlannerEngine(),
    specOptions: safeSpecOptions(draft.specOptions),
    reviewOptions: safeReviewOptions(draft.reviewOptions),
    round: draft.round,
    status: draft.status,
    questions: draft.questions,
    spec: draft.spec,
    readiness: draft.readiness,
    tasks: draft.tasks,
    lastError: draft.lastError || null,
    lastErrorAt: draft.lastErrorAt || null,
    deliveryMode: planDeliveryMode(draft),
  };
}

// The stored row holds every field a round needs, so a rebuilt draft resumes
// the same ccs session with the same goal, questions and tasks.
function draftFromStore(stored) {
  const contract = storedContract(stored);
  return {
    planId: stored.planId,
    repositoryId: stored.repositoryId,
    repositoryName: stored.repositoryName || "",
    cwd: stored.cwd || "",
    goal: stored.goal,
    images: Array.isArray(stored.images) ? stored.images : [],
    sourceType: stored.sourceType || null,
    issueNumbers: Array.isArray(stored.issueNumbers) ? stored.issueNumbers : [],
    issueUrls: Array.isArray(stored.issueUrls) ? stored.issueUrls : [],
    deliveryPolicy: stored.deliveryPolicy === "combined" ? "combined" : "auto",
    engine: normalizePlannerEngine(stored.engine),
    specOptions: safeSpecOptions(stored.specOptions),
    reviewOptions: safeReviewOptions(stored.reviewOptions),
    sessionId: stored.sessionId || null,
    round: Number(stored.round) || 0,
    at: Date.now(),
    status: stored.stage === "ready" ? "ready" : "questions",
    questions: Array.isArray(stored.questions) ? stored.questions : [],
    lastError: stored.lastError || null,
    lastErrorAt: stored.lastErrorAt || null,
    spec: contract.spec,
    readiness: contract.readiness,
    tasks: contract.tasks.map((task) => ({
      ...task,
      agent: task.agent || "claude",
      agentReason: task.agentReason || "",
    })),
  };
}

// Plans created before Delivery Contract v2 remain launchable. Their fallback
// is deliberately explicit and visible in the passport; new model replies must
// provide the full structured contract and never pass through this path.
function storedContract(stored) {
  const rawTasks = Array.isArray(stored.tasks) ? stored.tasks : [];
  const specOptions = safeSpecOptions(stored.specOptions);
  if (stored.spec?.acceptanceCriteria?.length) {
    const spec = normalizeDeliveryContract(stored.spec, stored.goal);
    const tasks = rawTasks.map((task, index) => ({ ...normalizeContractTask(task, index), ...task }));
    return { spec, tasks, readiness: stored.readiness || validateDeliveryContract(spec, tasks, specOptions) };
  }
  const spec = normalizeDeliveryContract({
    outcome: stored.goal,
    assumptions: ["Imported from a plan created before Delivery Contract v2"],
    acceptanceCriteria: rawTasks.map((task, index) => ({
      id: `AC-${index + 1}`,
      text: `Complete ${task.title || `task ${index + 1}`} as described in its saved prompt`,
      verification: "Run the repository verification appropriate for the task",
    })),
  }, stored.goal);
  const tasks = rawTasks.map((task, index) => ({
    ...normalizeContractTask({
      ...task,
      id: task.id || `T${index + 1}`,
      criterionIds: [`AC-${index + 1}`],
      ownedAreas: ["**/*"],
      verification: ["Run the repository verification appropriate for the task"],
    }, index),
    agent: task.agent,
    agentReason: task.agentReason,
  }));
  return { spec, tasks, readiness: validateDeliveryContract(spec, tasks, specOptions) };
}

function planDeliveryMode(draft) {
  return draft.deliveryPolicy === "combined" || draft.tasks.length > 1 ? "combined" : "single";
}

// A prompt builder must never throw: the option value on a rebuilt draft comes
// from storage, and a corrupted row must still plan.


// The planner runs with Read allowed, so it can open each file itself.
function imageBlock(images) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return "";
  return [`Attached image${list.length > 1 ? "s" : ""}:`, ...list.map((image) => `- ${image.path}`)].join("\n");
}

function withImages(prompt, images) {
  const block = imageBlock(images);
  return block ? `${prompt}\n\n${block}` : prompt;
}

// The plan ends at a pull request, not at a finished worktree. The agent opens
// it, because the branch has no commit at launch time and gh would refuse an
// empty one. Each agent is isolated, so every task prompt carries this itself.
function pullRequestStep(base, issueNumbers = []) {
  const branch = String(base || "").replace(/^origin\//, "") || "main";
  return [
    "Finish with a pull request:",
    "1. Commit your work.",
    "2. Push the branch to origin.",
    `3. Open a pull request against ${branch} with \`gh pr create\`. Do not mark it a draft.`,
    ...(issueNumbers.length ? [`4. Put these closing references in the pull request body, one per line: ${issueNumbers.map((number) => `Closes #${number}`).join("; ")}. These exact keywords ensure GitHub closes the linked issues only when this final PR merges.`] : []),
    "Open the pull request even when your own checks fail. State what failed at the top of its body, so the work stays visible instead of stopping on this machine.",
  ].join("\n");
}

function combinedBranchStep(readyToken) {
  return [
    "Finish your task branch for combined delivery:",
    "1. Run the verification appropriate for this task.",
    `2. Commit all of your work. The final commit message must end with the trailer \`Cmux-Goal-Ready: ${readyToken}\`.`,
    "3. Push this task branch to origin.",
    "4. Do not open a pull request. Companion will pin this commit and assemble every task into one goal pull request.",
  ].join("\n");
}

// The card shows one line, so it shows the reason for the worst task rather
// than every reason. A healthy goal has nothing to say.


export function taskPrompt(task, spec, images, base, deliveryMode = "single", readyToken = "", issueNumbers = [], specOptions = undefined, burst = false) {
  const criteria = (spec?.acceptanceCriteria || []).filter((criterion) => task.criterionIds?.includes(criterion.id));
  const contract = [
    "Delivery contract for this task:",
    `Outcome: ${spec?.outcome || "Complete the requested goal"}`,
    `Task: ${task.id} · ${task.title} · type ${task.type}`,
    `Owned areas: ${(task.ownedAreas || []).join(", ")}`,
    ...(task.dependsOn?.length ? [`Workflow dependencies: ${task.dependsOn.join(", ")}. Do not duplicate their owned work.`] : []),
    "Acceptance criteria:",
    ...criteria.map((criterion) => `- ${criterion.id}: ${criterion.text}\n  Verify: ${criterion.verification}`),
    "Expected task verification:",
    ...(task.verification || []).map((check) => `- ${check}`),
    "Keep changes inside the owned areas unless a necessary adjacent change is required. Report every such exception in the completion limitations.",
  ].join("\n");
  const finish = deliveryMode === "combined" ? combinedBranchStep(readyToken) : pullRequestStep(base, issueNumbers);
  // The requested rigor, the evidence that answers it and the artifacts the
  // planner drew sit between the contract and the finish steps, so an agent
  // reads what was asked for before it reads how to close the branch.
  const rigor = [
    specOptionsBriefLines(safeSpecOptions(specOptions)).join("\n"),
    burstBriefLines(burst === true).join("\n"),
    formatOptionEvidence(spec?.optionEvidence),
    formatDesignArtifacts(spec?.designArtifacts),
  ].filter(Boolean);
  return [withImages(task.prompt, images), contract, ...rigor, completionReportInstruction(task), finish].join("\n\n");
}

export function normalizeImages(images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw new TypeError("Attached images must be a list");
  if (images.length > MAX_IMAGES) throw new TypeError(`Attach at most ${MAX_IMAGES} images`);
  return images.map((image) => {
    const path = image?.path;
    if (typeof path !== "string" || !path.trim()) throw new TypeError("Each attached image needs a file path");
    const name = typeof image?.name === "string" && image.name.trim() ? image.name.trim().slice(0, 200) : "attached image";
    return { path: path.trim().slice(0, 1_000), name };
  });
}

export function normalizeIssueNumbers(values) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new TypeError("GitHub issue numbers must be a list");
  const numbers = [...new Set(values.map(Number))];
  if (numbers.length > 100 || numbers.some((number) => !Number.isInteger(number) || number < 1)) throw new TypeError("GitHub issue numbers are invalid");
  return numbers;
}

export function normalizeIssueUrls(values) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new TypeError("GitHub issue links must be a list");
  return values.map((value) => String(value || "").trim()).filter((value) => /^https:\/\/github\.com\//.test(value)).slice(0, 100);
}
