// GitHub Sync only ever ran when someone pressed the button. A column that is
// refreshed by hand is stale by definition: the board showed whatever the last
// operator happened to ask for, which could be days old.
//
// This runs the same pass on a timer, so the issue column stays passively
// current. It reads nothing and writes nothing of its own. It owns one thing
// only: when GitHubIssueSync.sync() runs, and that no two passes overlap.
//
// The in-flight guard matters more than the timer. A scheduled pass and the
// manual button both fan `gh` out over every starred repository. Two of those
// at once would double the process count and race on the same store, so the
// second caller joins the first pass instead of starting another one.

const DEFAULT_INTERVAL_MS = 60 * 60 * 1_000;
// The first minute after boot is the busiest: bootstrap spawns cmux children
// and the dashboard scan spawns one git child per repository. A `gh` fan-out on
// top of that competes with the first page load, so the first pass waits.
const DEFAULT_START_DELAY_MS = 60 * 1_000;

export class GitHubIssueSyncScheduler {
  constructor({ sync, log = null, intervalMs = DEFAULT_INTERVAL_MS, startDelayMs = DEFAULT_START_DELAY_MS } = {}) {
    if (!sync?.sync) throw new TypeError("A GitHub issue sync is required");
    this.sync = sync;
    this.log = log;
    this.intervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;
    this.startDelayMs = Number.isFinite(startDelayMs) && startDelayMs >= 0 ? startDelayMs : DEFAULT_START_DELAY_MS;
    this.timer = null;
    // The one pass that is running now, or null. Every caller of syncNow()
    // shares it, so `gh` never runs twice over the same repositories.
    this.inFlight = null;
  }

  start() {
    if (this.timer) return () => {};
    // Rescheduled only after the pass settles, never on a fixed period. A slow
    // `gh` fan-out that outlasts the interval would otherwise stack passes,
    // and each stacked pass would find the guard held and do nothing useful.
    const tick = () => {
      this.timer = setTimeout(run, this.intervalMs);
      this.timer.unref?.();
    };
    const run = () => {
      this.syncNow()
        .catch((cause) => this.log?.warn?.({ err: cause }, "github issue sync pass failed"))
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

  // One pass, shared. The timer and the manual route both come through here,
  // which is what makes the guard cover both.
  async syncNow() {
    if (this.inFlight) return this.inFlight;
    const pass = (async () => this.sync.sync())();
    this.inFlight = pass;
    // Cleared on failure as well as success. A rejected pass that kept the slot
    // would hand the same error to every later caller for the life of the
    // process.
    const release = () => { if (this.inFlight === pass) this.inFlight = null; };
    pass.then(release, release);
    return pass;
  }
}

export { DEFAULT_INTERVAL_MS, DEFAULT_START_DELAY_MS };
