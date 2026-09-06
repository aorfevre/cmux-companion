// A background launch outlives the request that started it. Nothing in the
// request cycle can say whether a plan is already creating its worktrees, so
// this registry answers that one question.
//
// It is deliberately separate from PlannerRuns. That registry holds one entry
// per plan id and carries a specification stage, so a launch entry stored there
// would replace the round entry and drop the goal card into "Writing Spec". A
// launch is not a specification round, and it must not read as one.
//
// It is deliberately in memory. A companion restart kills the launch, so a
// persisted "launching" flag would outlive the work it describes and lie.

const MAX_LAUNCHES = 200;

export class LaunchRuns {
  constructor({ now = Date.now } = {}) {
    this.launches = new Map();
    this.now = now;
  }

  // Registers the launch and reports whether the caller won the slot. A false
  // answer means another launch is already in flight for this plan.
  begin(planId) {
    const id = String(planId || "");
    if (!id) return false;
    if (this.launches.has(id)) return false;
    // A live claim cannot be evicted: doing so permits a second writer.
    if (this.launches.size >= MAX_LAUNCHES) return false;
    this.launches.set(id, { planId: id, startedAt: this.now() });
    return true;
  }

  // Every exit path calls this, so a settled launch leaves nothing behind.
  finish(planId) {
    this.launches.delete(String(planId || ""));
  }

  isLaunching(planId) {
    return this.launches.has(String(planId || ""));
  }

  list() {
    return [...this.launches.values()].map((launch) => ({ ...launch }));
  }

  // Every launch this process owns is gone after a restart. The caller clears
  // the registry so no card shows a launch that no work backs.
  clear() {
    this.launches.clear();
  }
}
