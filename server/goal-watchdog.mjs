// The health sweep can tell that a task's agent died. Nothing called it.
//
// A supervision tool that only answers when asked is not supervision: the
// operator still has to remember to look, which is exactly the habit that let
// goals sit stranded for days. This runs the sweep on a timer and pushes one
// alert when a goal's health gets worse.
//
// It writes no plan state. Moving a goal on a timer would let a slow agent be
// declared dead and its worktree rebuilt under it, so the watchdog only ever
// reports. Every recovery stays an explicit decision.

const DEFAULT_INTERVAL_MS = 5 * 60 * 1_000;
// A goal that has just launched has no session yet on the first tick. Waiting
// one interval before the first sweep avoids an alert about work that is
// starting normally.
const DEFAULT_START_DELAY_MS = 60 * 1_000;

// Only these verdicts are worth waking someone for. `working`, `ready`,
// `integrated` and `queued` are the healthy path, and `unknown` means the check
// itself could not run, which is not the goal's fault.
const ALERTING = new Map([
  ["dead", { kind: "failure", label: "stopped" }],
  ["failed", { kind: "failure", label: "could not launch" }],
  ["idle", { kind: "attention", label: "went quiet" }],
  ["needs_you", { kind: "decision", label: "is waiting for you" }],
]);

export class GoalWatchdog {
  constructor({ health, pushService = null, log = null, intervalMs = DEFAULT_INTERVAL_MS, startDelayMs = DEFAULT_START_DELAY_MS } = {}) {
    if (!health) throw new TypeError("A goal health sweep is required");
    this.health = health;
    this.pushService = pushService;
    this.log = log;
    this.intervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;
    this.startDelayMs = Number.isFinite(startDelayMs) && startDelayMs >= 0 ? startDelayMs : DEFAULT_START_DELAY_MS;
    // The last verdict alerted per goal. A goal that is still dead on the next
    // tick is not news, so it is not sent again; a goal that recovers and dies
    // again is, because the entry is dropped the moment it reports healthy.
    this.alerted = new Map();
    this.timer = null;
  }

  start() {
    if (this.timer) return () => {};
    const tick = () => {
      this.timer = setTimeout(run, this.intervalMs);
      this.timer.unref?.();
    };
    const run = () => {
      this.check()
        .catch((cause) => this.log?.warn?.({ err: cause }, "goal watchdog sweep failed"))
        .finally(tick);
    };
    this.timer = setTimeout(run, this.startDelayMs);
    this.timer.unref?.();
    return () => this.stop();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  // One pass. Exported so a test drives it directly and the manual sweep route
  // can share the dedupe.
  async check() {
    const swept = await this.health.sweep();
    // An unreachable cmux reports every session as `unknown`. Alerting on that
    // would tell the user their agents died every time they closed cmux, so the
    // pass is skipped entirely and no memory is cleared: the goals are exactly
    // as they were before the check could not run.
    if (swept?.sessionsAvailable !== true) return { checked: false, alerts: [] };

    const alerts = [];
    const seen = new Set();
    for (const goal of swept.goals || []) {
      seen.add(goal.planId);
      const rule = ALERTING.get(goal.health);
      if (!rule) {
        // Recovered, or never sick. Forget it, so a later relapse alerts again.
        this.alerted.delete(goal.planId);
        continue;
      }
      if (this.alerted.get(goal.planId) === goal.health) continue;
      this.alerted.set(goal.planId, goal.health);
      const alert = { planId: goal.planId, health: goal.health, goal: goal.goal, stuckCount: goal.stuckCount };
      alerts.push(alert);
      await this.#push(goal, rule);
    }
    // A goal that left the sweep is terminal or deleted. Dropping it keeps the
    // map bounded by the number of live goals rather than by uptime.
    for (const planId of [...this.alerted.keys()]) if (!seen.has(planId)) this.alerted.delete(planId);
    return { checked: true, checkedAt: swept.checkedAt, alerts, summary: swept.summary };
  }

  async #push(goal, rule) {
    if (!this.pushService?.send) return;
    try {
      const reason = firstReason(goal);
      await this.pushService.send({
        title: `A goal ${rule.label}`,
        body: [oneLine(goal.goal, 120), reason ? oneLine(reason, 140) : ""].filter(Boolean).join(" — "),
        kind: rule.kind,
        planId: goal.planId,
        // One tag per goal, so a phone shows the current state of a goal rather
        // than a stack of its history.
        tag: `goal-health:${goal.planId}`,
      });
    } catch (cause) {
      this.log?.warn?.({ err: cause, planId: goal.planId }, "goal health alert failed");
    }
  }
}

function firstReason(goal) {
  const parts = [...(goal?.tasks || []), ...(goal?.merge ? [goal.merge] : [])];
  return parts.find((part) => part.health === goal?.health)?.reason || null;
}

function oneLine(value, limit) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
