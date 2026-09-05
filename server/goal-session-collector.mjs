// Close only sessions whose durable goal record proves they are disposable.
// Failed closes remain pending, so supervision can retry after a restart or a
// cmux outage without requiring another agent Stop event.
export class GoalSessionCollector {
  constructor({ store, cmux, log = null }) {
    this.store = store;
    this.cmux = cmux;
    this.log = log;
    this.pending = new Map();
  }

  collect(planId) {
    if (this.pending.has(planId)) return this.pending.get(planId);
    const run = this.#collect(planId).finally(() => this.pending.delete(planId));
    this.pending.set(planId, run);
    return run;
  }

  async sweep() {
    try {
      for (const id of this.store.sessionCleanupPlanIds()) await this.collect(id);
    } catch (err) {
      this.log?.warn?.({ err }, "goal session sweep failed");
    }
  }

  async #collect(planId) {
    if (!this.cmux?.workspaceClose || !this.store.pendingSessionClosures) return;
    try {
      const entries = this.store.pendingSessionClosures(planId);
      for (const workspaceId of new Set(entries.map((entry) => entry.workspaceId).filter(Boolean))) {
        try {
          await this.cmux.workspaceClose(workspaceId);
        } catch (err) {
          if (!/workspace[^\n]*(?:not found|does not exist|already closed)|no such workspace|unknown workspace/i.test(String(err?.message || ""))) {
            this.log?.warn?.({ err, planId, workspaceId }, "closing a finished goal session failed");
            continue;
          }
        }
        this.store.recordSessionsRetired(planId, entries.filter((entry) => entry.workspaceId === workspaceId));
      }
    } catch (err) {
      this.log?.warn?.({ err, planId }, "goal session cleanup failed");
    }
  }
}
