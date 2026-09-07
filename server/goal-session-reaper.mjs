import { restoredGoalSessions, restoredSessionProtection } from "./restored-goal-sessions.mjs";
import { agentBusyState } from "./goal-health.mjs";

// Companion opens one cmux session per task and one per merge attempt, and
// almost nothing closed them again. A goal whose pull request merged weeks ago
// still filled the sidebar with `KRV · … · T2-api` and `… · MERGE`
// workspaces, and a person had to close every one of them by hand.
//
// This module holds the one rule that says which of a plan's recorded sessions
// are finished. `retirableSessions` is pure: it reads a plan row and a live
// workspace view and returns the two lists. `GoalSessionReaper` is the writer
// that acts on those lists. Splitting them keeps the rule testable without a
// cmux, and keeps the integrator and the supervision pass on one rule.
//
// The rule is deliberately conservative. Closing a session that is still
// working destroys unsaved work, and no tidy sidebar is worth that. Every
// refusal is reported with its reason, so a session that stays open can always
// be explained.

// The sessions one goal can own. `merge` is the session the plan currently
// points at; `superseded` is a merge session a newer merge agent replaced.
const MERGE_TITLE = "Goal merge";
const SUPERSEDED_TITLE = "Goal merge (replaced)";

// The one policy. It calls nothing, so a caller can ask what would happen
// without touching cmux or the store.
//
// `plan` is a WorktreePlanStore detail row. `live` is
// `{ available: boolean, byId: Map<workspaceId, workspace> }`, built from
// `cmux.workspaceListDetailed()`.
export function retirableSessions(plan, live = { available: false, byId: new Map() }) {
  const close = [];
  const keep = [];
  const available = live?.available === true;
  const byId = live?.byId instanceof Map ? live.byId : new Map();
  const candidates = ownedSessions(plan);

  // An unreachable cmux proves nothing about any agent. A blocked merge keeps
  // every session the user needs to read to unblock it. Both refuse the whole
  // plan rather than a single session, because neither says anything about one
  // workspace in particular.
  if (!available) {
    for (const entry of candidates) keep.push(kept(entry, "cmux could not be reached, so no session was closed"));
    return { close, keep };
  }
  if (plan?.mergeStatus === "blocked" && !hasOpenPullRequest(plan) && !isTerminal(plan)) {
    for (const entry of candidates) keep.push(kept(entry, "This goal's merge is blocked, so every session it owns stays open"));
    return { close, keep };
  }

  const terminal = isTerminal(plan);
  const prOpen = hasOpenPullRequest(plan);
  // Once the goal PR exists its original task and merge sessions are finished.
  // Follow-up sessions have separate identities and are not owned by this list.
  for (const entry of candidates) {
    if (plan?.workflow === "goal_session" && !terminal && entry.workspaceId === plan.goalSessionWorkspaceId) {
      keep.push(kept(entry, "The goal conversation stays open for review and corrections"));
      continue;
    }
    if (!terminal && !prOpen && !finishedWithoutPullRequest(entry)) {
      keep.push(kept(entry, entry.kind === "task" ? "This task is not integrated yet" : "This goal is still being assembled"));
      continue;
    }
    // The last check before a close: the live record. An agent that is running
    // or waiting for an answer is doing work no board state can see, and the
    // plan row is always older than the workspace.
    const busy = agentBusyState(byId.get(entry.workspaceId));
    if (busy === "needs_input") {
      keep.push(kept(entry, "This session's agent is waiting for an answer"));
      continue;
    }
    if (busy === "running") {
      keep.push(kept(entry, "This session's agent is running"));
      continue;
    }
    close.push({
      workspaceId: entry.workspaceId,
      taskId: entry.taskId,
      kind: entry.kind,
      title: entry.title,
      reason: closeReason(entry, { terminal, prOpen, plan }),
    });
  }
  return { close, keep };
}

// The writer. It reads the plans, applies the policy once per plan against one
// live workspace read, closes what the policy names, and records every closure
// durably so the next pass never repeats it.
//
// It swallows every failure it can. A supervision pass that throws when the
// thing it supervises is down is worse than no pass at all.
export class GoalSessionReaper {
  constructor({ store, cmux = null, log = null, enabled = true } = {}) {
    if (!store) throw new TypeError("A goal plan store is required");
    this.store = store;
    this.cmux = cmux;
    this.log = log;
    this.enabled = enabled !== false;
  }

  reap(options = {}) {
    const run = (this.chain || Promise.resolve()).then(() => this.reapSequential(options));
    this.chain = run.catch(() => {});
    return run;
  }

  async reapSequential({ planId = null } = {}) {
    const checkedAt = new Date().toISOString();
    // The kill switch. It answers with the same shape as a pass that found
    // nothing, so a caller never has to special-case it.
    if (!this.enabled) return { checkedAt, sessionsAvailable: false, closed: [], kept: [], failed: [] };

    const plans = this.#plans(planId);
    if (!plans.length) return { checkedAt, sessionsAvailable: false, closed: [], kept: [], failed: [] };

    const live = await this.#liveWorkspaces();
    const closed = [];
    const kept = [];
    const failed = [];
    for (const plan of plans) {
      const { close, keep } = retirableSessions(plan, live);
      for (const entry of keep) kept.push({ planId: plan.planId, ...entry });
      const retired = [];
      for (const entry of close) {
        const outcome = await this.#close(plan, entry);
        if (outcome.retired) {
          retired.push({ workspaceId: entry.workspaceId, taskId: entry.taskId, kind: entry.kind });
          closed.push({ planId: plan.planId, ...entry, closedInCmux: outcome.closedInCmux });
        } else if (outcome.kept) {
          kept.push({ planId: plan.planId, ...entry, reason: outcome.error });
        } else {
          failed.push({ planId: plan.planId, ...entry, error: outcome.error });
        }
      }
      // One write per plan. A partial pass still records what it achieved, so
      // a cmux that dies halfway costs a retry of the rest and nothing else.
      if (retired.length) {
        try {
          this.store.recordSessionsRetired(plan.planId, retired);
        } catch (cause) {
          this.log?.warn?.({ err: cause, planId: plan.planId }, "goal session reaper could not record retired sessions");
        }
      }
    }
    // New UUIDs after a cmux restore are absent from the durable session list.
    // Reconcile conservatively, and never stamp another task's stored UUID.
    if (live.available) for (const entry of restoredGoalSessions(this.#plans(null), [...live.byId.values()])) {
      if (planId && entry.planId !== planId) continue;
      if (!entry.eligible) { kept.push(entry); continue; }
      try {
        const fresh = await this.#liveWorkspaces();
        const currentPlans = this.#plans(null);
        const candidate = restoredGoalSessions(currentPlans, [...fresh.byId.values()])
          .find((item) => item.workspaceId === entry.workspaceId);
        const workspace = { ...fresh.byId.get(entry.workspaceId) };
        if (!fresh.available || !candidate?.eligible || candidate.path !== entry.path || candidate.title !== entry.title || candidate.planId !== entry.planId) {
          kept.push({ ...entry, reason: "Workspace identity or delivery evidence changed during cleanup" }); continue;
        }
        if (this.cmux.workspaceStatus) workspace.status = await this.cmux.workspaceStatus(entry.workspaceId);
        const protection = restoredSessionProtection(workspace);
        if (protection) { kept.push({ ...entry, reason: protection }); continue; }
        await this.cmux.workspaceClose(entry.workspaceId);
        closed.push({ ...entry, closedInCmux: true });
      } catch (cause) {
        failed.push({ ...entry, error: String(cause?.message || cause) });
      }
    }
    return { checkedAt, sessionsAvailable: live.available, closed, kept, failed };
  }

  // A workspace the live list does not hold is already finished from cmux's
  // point of view. Asking cmux to close it would log a failure for a session
  // that is gone, and the id would come back on every pass for ever.
  async #close(plan, entry) {
    const live = await this.#liveWorkspaces();
    const currentPlan = this.#plan(plan.planId);
    if (!live.available || !currentPlan) return { kept: true, error: "Fresh session or goal evidence is unavailable" };
    const current = retirableSessions(currentPlan, live);
    if (!current.close.some((candidate) => candidate.workspaceId === entry.workspaceId && candidate.taskId === entry.taskId && candidate.kind === entry.kind)) {
      return { kept: true, error: current.keep.find((candidate) => candidate.workspaceId === entry.workspaceId)?.reason || "Session ownership or delivery evidence changed during cleanup" };
    }
    if (!live.byId.has(entry.workspaceId)) return { retired: true, closedInCmux: false, error: null };
    if (!this.cmux?.workspaceClose) return { retired: false, closedInCmux: false, error: "This cmux client cannot close a workspace" };
    let closing = false;
    try {
      const workspace = { ...live.byId.get(entry.workspaceId) };
      if (this.cmux.workspaceStatus) workspace.status = await this.cmux.workspaceStatus(entry.workspaceId);
      const protection = restoredSessionProtection(workspace);
      if (protection) return { kept: true, error: protection };
      // Status itself awaited; recheck the durable identity before closing.
      const latest = this.#plan(plan.planId);
      if (!latest || !retirableSessions(latest, live).close.some((candidate) => candidate.workspaceId === entry.workspaceId && candidate.taskId === entry.taskId && candidate.kind === entry.kind)) {
        return { kept: true, error: "Session ownership or delivery evidence changed during cleanup" };
      }
      closing = true;
      await this.cmux.workspaceClose(entry.workspaceId);
      return { retired: true, closedInCmux: true, error: null };
    } catch (cause) {
      const message = String(cause?.message || "Closing this session failed");
      this.log?.warn?.({ err: cause, planId: plan.planId, workspaceId: entry.workspaceId }, "closing a finished goal session failed");
      // A session the user already closed rejects exactly like one that was
      // never opened. Both are retired, or the same dead id is retried on every
      // pass for the life of the plan. Anything else may be a passing fault and
      // stays pending, so the next pass tries again.
      if (closing && missingWorkspace(cause)) return { retired: true, closedInCmux: false, error: null };
      return { retired: false, closedInCmux: false, error: message };
    }
  }

  // Every plan that can still own a session. A terminal goal keeps its
  // `launched` status, so the launched list holds the merged and aborted goals
  // too; the second read only catches a goal whose status moved on while its
  // sessions did not.
  #plans(planId) {
    if (planId) {
      const plan = this.#plan(String(planId));
      return plan ? [plan] : [];
    }
    if (this.store.sessionCleanupPlanIds) return this.store.sessionCleanupPlanIds().map((id) => this.#plan(id)).filter(Boolean);
    const ids = [];
    for (const summary of this.#list({ status: "launched" })) {
      const id = text(summary?.planId);
      if (id) ids.push(id);
    }
    for (const summary of this.#list({})) {
      const id = text(summary?.planId);
      if (!id || ids.includes(id)) continue;
      if (summary?.boardStatus && (summary.workspaceIds || []).length) ids.push(id);
    }
    return ids.map((id) => this.#plan(id)).filter(Boolean);
  }

  #list(options) {
    try {
      return this.store.list({ ...options, limit: 200 }) || [];
    } catch (cause) {
      this.log?.warn?.({ err: cause }, "goal session reaper could not read the plan list");
      return [];
    }
  }

  #plan(planId) {
    try {
      return this.store.get(planId) || null;
    } catch (cause) {
      this.log?.warn?.({ err: cause, planId }, "goal session reaper could not read a plan");
      return null;
    }
  }

  async #liveWorkspaces() {
    if (!this.cmux?.workspaceListDetailed) return { available: false, byId: new Map() };
    try {
      const payload = await (this.cmux.loadWorkspaceListDetailed ? this.cmux.loadWorkspaceListDetailed() : this.cmux.workspaceListDetailed());
      if (!Array.isArray(payload?.workspaces)) throw new Error("Invalid cmux workspace inventory");
      const list = Array.isArray(payload?.workspaces) ? payload.workspaces : [];
      const byId = new Map();
      for (const workspace of list) {
        const id = text(workspace?.id);
        if (id) byId.set(id, workspace);
      }
      return { available: true, byId };
    } catch (cause) {
      this.log?.warn?.({ err: cause }, "goal session reaper could not read the workspace list");
      return { available: false, byId: new Map() };
    }
  }
}

// cmux has no typed error for a workspace that is gone, so its message is all
// there is to read. Anything else may be a passing fault, and stays retryable.
function missingWorkspace(cause) {
  return /workspace[^\n]*(?:not found|does not exist|already closed)|no such workspace|unknown workspace/i.test(String(cause?.message || ""));
}

// Every session the plan actually records and has not retired yet. Nothing else
// may ever reach a close: an id that is not on the plan row belongs to work
// this goal does not own.
function ownedSessions(plan) {
  const sessions = [];
  for (const task of Array.isArray(plan?.tasks) ? plan.tasks : []) {
    const workspaceId = text(task?.workspaceId);
    if (!workspaceId || task?.sessionClosedAt) continue;
    sessions.push({
      workspaceId,
      taskId: text(task?.id) || null,
      kind: "task",
      title: text(task?.title) || workspaceId,
      deliveryStatus: text(task?.deliveryStatus) || "pending",
    });
  }
  if (plan?.workflow === "goal_session" && !isTerminal(plan) && plan.goalSessionWorkspaceId && !sessions.some((entry) => entry.workspaceId === plan.goalSessionWorkspaceId)) {
    sessions.push({ workspaceId: plan.goalSessionWorkspaceId, taskId: null, kind: "goal", title: plan.goal || "Goal", deliveryStatus: "pending" });
  }
  const mergeId = text(plan?.mergeWorkspaceId);
  if (mergeId && !plan?.mergeSessionClosedAt) {
    sessions.push({ workspaceId: mergeId, taskId: null, kind: "merge", title: MERGE_TITLE, deliveryStatus: null });
  }
  for (const entry of Array.isArray(plan?.supersededMergeWorkspaces) ? plan.supersededMergeWorkspaces : []) {
    const workspaceId = text(entry?.workspaceId);
    // A superseded id can equal the live merge id only through a hand-edited
    // row, and closing the live session twice would report a failure for a
    // session that is fine.
    if (!workspaceId || entry?.retiredAt || workspaceId === mergeId) continue;
    sessions.push({ workspaceId, taskId: null, kind: "superseded", title: SUPERSEDED_TITLE, deliveryStatus: null });
  }
  return sessions;
}

// Merged or aborted: the goal is over, so no session it owns has work left.
function isTerminal(plan) {
  return plan?.boardStatus === "merged" || plan?.boardStatus === "aborted" || text(plan?.boardPrState).toUpperCase() === "MERGED";
}

// The delivery pull request is open, so every task's work is in it. A closed
// pull request still records delivery of those original sessions; follow-up
// work is launched in separate sessions.
function hasOpenPullRequest(plan) {
  const state = text(plan?.boardPrState).toUpperCase();
  if (state === "OPEN") return true;
  if (state === "CLOSED") return true;
  return plan?.deliveryStatus === "pr_open" || text(plan?.finalPrUrl) !== "";
}

// What a session may be retired for while the goal is still being assembled.
// Both are proven finished by their own state, whatever the pull request says.
function finishedWithoutPullRequest(entry) {
  return entry.kind === "superseded" || (entry.kind === "task" && entry.deliveryStatus === "integrated");
}

function closeReason(entry, { terminal, prOpen, plan }) {
  if (entry.kind === "superseded") return "A newer merge agent replaced this session";
  if (terminal) return plan?.boardStatus === "aborted" ? "This goal was aborted" : "This goal is merged";
  if (entry.kind === "task" && entry.deliveryStatus === "integrated") return "This task is merged into the goal branch";
  return prOpen ? "This goal's pull request is open, so this task's work is delivered" : "This session has no work left";
}

function kept(entry, reason) {
  return { workspaceId: entry.workspaceId, kind: entry.kind, reason };
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
