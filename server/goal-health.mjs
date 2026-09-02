// A launched goal has no liveness signal of its own. The integrator only ever
// hears `agent.hook.Stop`, and a crashed agent, a closed workspace, a hung
// session or a sleeping Mac emits nothing at all. So a task can sit at
// `pending` for ever while the board reports "Dev in progress".
//
// This module answers one question for every launched task: is its agent still
// there? It joins the persisted `workspace_id` to the live cmux workspace list
// and classifies what it finds. It writes nothing. The caller decides what to
// do with a verdict, so a sweep can never move a goal on its own.
//
// It is deliberately tolerant, like the merge watch beside it. An unreachable
// cmux, a plan the store cannot read, or a malformed workspace entry must
// produce a verdict of "unknown", never an exception. A supervision tool that
// crashes when the thing it supervises is down is worse than no tool.

// How long a launched task may show no session activity before the sweep calls
// it idle. An agent that reads a large repository is quiet for minutes, so this
// is deliberately longer than any single tool call.
export const DEFAULT_IDLE_MS = 20 * 60 * 1_000;

// Every verdict this module can return, worst first. The order is the ranking:
// a goal reports the worst verdict any of its tasks carries.
export const TASK_HEALTH = Object.freeze(["failed", "dead", "idle", "needs_you", "working", "ready", "integrated", "queued", "unknown"]);

const RANK = new Map(TASK_HEALTH.map((value, index) => [value, TASK_HEALTH.length - index]));

export class GoalHealthSweep {
  constructor({ store, cmux = null, log = null, idleMs = DEFAULT_IDLE_MS, now = () => Date.now() } = {}) {
    if (!store) throw new TypeError("A goal plan store is required");
    this.store = store;
    this.cmux = cmux;
    this.log = log;
    this.idleMs = Number.isFinite(idleMs) && idleMs > 0 ? idleMs : DEFAULT_IDLE_MS;
    this.now = now;
  }

  // Inspects every launched, non-terminal goal. Returns one report per goal,
  // newest plan first, plus the totals a KPI tile needs. Reads only.
  //
  // Unlike `activeCombinedPlans`, this does NOT filter on delivery mode. A
  // single-task goal is exactly the case that has no watcher today, so it is
  // the case that most needs the sweep.
  async sweep() {
    const goals = [];
    let summaries;
    try {
      summaries = this.store.list({ status: "launched", limit: 200 }) || [];
    } catch (cause) {
      this.log?.warn?.({ err: cause }, "goal health sweep could not read the plan list");
      return { checkedAt: new Date(this.now()).toISOString(), sessionsAvailable: false, goals, summary: emptySummary() };
    }

    const live = await this.#liveWorkspaces();
    for (const item of summaries) {
      const planId = text(item?.planId);
      if (!planId || item?.boardStatus) continue;
      let plan;
      try {
        plan = this.store.get(planId);
      } catch (cause) {
        this.log?.warn?.({ err: cause, planId }, "goal health sweep could not read a plan");
        continue;
      }
      if (!plan || plan.status !== "launched" || plan.boardStatus) continue;
      goals.push(this.#inspect(plan, live));
    }

    return {
      checkedAt: new Date(this.now()).toISOString(),
      sessionsAvailable: live.available,
      goals,
      summary: summarize(goals),
    };
  }

  // One goal, already read from the store. Exported through sweep() and used
  // directly by the per-goal route, so both paths share the one rule.
  async inspect(planId) {
    const plan = this.store.get(text(planId));
    if (!plan) throw new TypeError("Unknown plan. Start a new goal");
    return this.#inspect(plan, await this.#liveWorkspaces());
  }

  #inspect(plan, live) {
    const tasks = (Array.isArray(plan.tasks) ? plan.tasks : []).map((task) => this.#task(task, live));
    // The merge session is a task in every way that matters here: it can die
    // the same way, and a dead merge agent strands the goal just as hard.
    const merge = plan.mergeStatus === "running"
      ? this.#session(plan.mergeWorkspaceId, live, { label: "merge" })
      : null;
    const stuck = [...tasks.map((task) => task.health), merge?.health]
      .filter(Boolean)
      .filter((health) => health === "dead" || health === "idle" || health === "failed");
    return {
      planId: plan.planId,
      goal: plan.goal,
      repositoryId: plan.repositoryId,
      repositoryName: plan.repositoryName,
      deliveryMode: plan.deliveryMode,
      deliveryStatus: plan.deliveryStatus,
      deliveryError: plan.deliveryError || null,
      mergeStatus: plan.mergeStatus || null,
      merge,
      tasks,
      // The worst verdict any task carries. A goal is only as healthy as its
      // sickest task, because one stranded task blocks the whole assembly.
      health: worst(tasks.map((task) => task.health).concat(merge ? [merge.health] : [])),
      stuckCount: stuck.length,
      readyCount: tasks.filter((task) => task.deliveryStatus === "ready" || task.deliveryStatus === "integrated").length,
      launchedCount: tasks.filter((task) => task.launchStatus === "launched").length,
      taskCount: tasks.length,
    };
  }

  #task(task, live) {
    const launchStatus = text(task?.launchStatus);
    const deliveryStatus = text(task?.deliveryStatus) || "pending";
    const base = {
      id: task?.id,
      title: task?.title,
      branch: task?.branch,
      agent: task?.agent || null,
      wave: Number(task?.wave) || 0,
      launchStatus: launchStatus || null,
      launchError: task?.launchError || null,
      deliveryStatus,
      evidenceStatus: task?.evidenceStatus || null,
      evidenceError: task?.evidenceError || null,
      workspaceId: task?.workspaceId || null,
      worktreePath: task?.worktreePath || null,
      sessionClosedAt: task?.sessionClosedAt || null,
    };

    // A task the launch never started, and a task queued for a later wave, are
    // both correct states with no session to find. They are not stuck.
    if (launchStatus === "failed") return { ...base, health: "failed", reason: task?.launchError || "This task never launched", session: null };
    if (launchStatus !== "launched") return { ...base, health: "queued", reason: waveReason(base.wave), session: null };

    // Work that is done needs no live agent. Companion closes those sessions
    // itself, so a missing workspace here is expected, not a failure.
    if (deliveryStatus === "integrated") return { ...base, health: "integrated", reason: "This task is merged into the goal branch", session: null };
    if (deliveryStatus === "ready") return { ...base, health: "ready", reason: "This task pushed its evidence and waits for the merge", session: null };

    const session = this.#session(task?.workspaceId, live, { label: "task" });
    return { ...base, health: session.health, reason: session.reason, session: session.session };
  }

  // The one join: a persisted workspace id against the live cmux list.
  #session(workspaceIdValue, live, { label }) {
    const id = text(workspaceIdValue);
    if (!id) return { health: "unknown", reason: `Companion recorded no cmux session for this ${label}`, session: null };
    // An unreachable cmux proves nothing. Reporting "dead" here would tell the
    // user to relaunch live agents, which is the one mistake that loses work.
    if (!live.available) return { health: "unknown", reason: "cmux could not be reached, so this session was not checked", session: null };

    const workspace = live.byId.get(id);
    if (!workspace) return { health: "dead", reason: `This ${label} session is no longer open in cmux`, session: null };

    const session = {
      id,
      title: workspace.title || null,
      lastActivityAt: activityMs(workspace),
      effective: workspace.status?.effective || null,
    };
    const signals = workspace.status?.signals || {};
    if (workspace.has_unread === true || signals.any_agent_needs_input === true) {
      return { health: "needs_you", reason: `This ${label} agent is waiting for an answer`, session };
    }
    if (signals.any_agent_running === true || workspace.status?.effective === "working") {
      return { health: "working", reason: `This ${label} agent is running`, session };
    }
    const quietFor = session.lastActivityAt ? this.now() - session.lastActivityAt : 0;
    if (quietFor > this.idleMs) {
      return { health: "idle", reason: `This ${label} session has been quiet for ${minutes(quietFor)} with no result`, session };
    }
    // Open, not running, not waiting, recently active. The agent most likely
    // finished its turn and the evidence check has not caught up yet.
    return { health: "working", reason: `This ${label} session is open and was active ${minutes(quietFor)} ago`, session };
  }

  async #liveWorkspaces() {
    if (!this.cmux?.workspaceListDetailed) return { available: false, byId: new Map() };
    try {
      const payload = await this.cmux.workspaceListDetailed();
      const list = Array.isArray(payload?.workspaces) ? payload.workspaces : [];
      const byId = new Map();
      for (const workspace of list) {
        const id = text(workspace?.id);
        if (id) byId.set(id, workspace);
      }
      return { available: true, byId };
    } catch (cause) {
      this.log?.warn?.({ err: cause }, "goal health sweep could not read the workspace list");
      return { available: false, byId: new Map() };
    }
  }
}

// Exported so the board and the tests read the same ranking.
export function worst(values) {
  let winner = "unknown";
  for (const value of Array.isArray(values) ? values : []) {
    if ((RANK.get(value) || 0) > (RANK.get(winner) || 0)) winner = value;
  }
  return winner;
}

// True when a goal needs a person. The board badge and the KPI tile both read
// this, so "stuck" means one thing everywhere.
export function isStuck(health) {
  return health === "dead" || health === "idle" || health === "failed";
}

function summarize(goals) {
  const summary = emptySummary();
  for (const goal of goals) {
    summary.goals += 1;
    if (isStuck(goal.health)) summary.stuck += 1;
    if (goal.health === "needs_you") summary.needsYou += 1;
    if (goal.health === "working") summary.working += 1;
    for (const task of goal.tasks) {
      summary.tasks += 1;
      if (task.health === "dead") summary.deadTasks += 1;
      if (task.health === "idle") summary.idleTasks += 1;
      if (task.health === "failed") summary.failedTasks += 1;
    }
  }
  return summary;
}

function emptySummary() {
  return { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0, deadTasks: 0, idleTasks: 0, failedTasks: 0 };
}

function waveReason(wave) {
  return wave > 0 ? `This task waits for wave ${wave} to integrate` : "This task has not launched yet";
}

function activityMs(workspace) {
  const raw = workspace?.last_activity_at;
  if (Number.isFinite(raw) && raw > 0) return raw > 1e12 ? raw : raw * 1_000;
  const parsed = Date.parse(String(raw || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function minutes(ms) {
  const value = Math.max(0, Math.round(ms / 60_000));
  if (value < 1) return "less than a minute";
  if (value === 1) return "1 minute";
  if (value < 90) return `${value} minutes`;
  return `${Math.round(value / 60)} hours`;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
