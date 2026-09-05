import { GoalSessionReaper } from "./goal-session-reaper.mjs";

// Event-driven delivery and the periodic sweep share the established session
// policy, including its live-agent checks and durable retirement stamps.
export class GoalSessionCollector {
  constructor({ store, cmux, log = null, reaper = null, enabled = true }) {
    this.reaper = reaper || new GoalSessionReaper({ store, cmux, log });
    this.pending = new Map();
    this.enabled = enabled;
  }
  collect(planId) {
    if (!this.enabled) return Promise.resolve();
    if (this.pending.has(planId)) return this.pending.get(planId);
    const run = this.reaper.reap({ planId }).finally(() => this.pending.delete(planId));
    this.pending.set(planId, run);
    return run;
  }
  sweep() { return this.enabled ? this.reaper.reap() : Promise.resolve(); }
}
