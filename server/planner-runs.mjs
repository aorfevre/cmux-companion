// A background planner round outlives the request that started it, so nothing
// in the request cycle can say whether a plan is busy. This registry answers
// that one question, and it carries the last progress line for a card that was
// never open while the round ran.
//
// It is deliberately in memory. A companion restart kills the ccs child, so a
// persisted "running" flag would outlive the process it describes and lie.

const RUN_TTL_MS = 60_000;
const MAX_RUNS = 200;

// The specification phases a live round can be in. The board reads this value,
// never the display text in `step`, so a wording change cannot move a card.
export const RUN_STAGES = Object.freeze(["writing_spec", "review_spec"]);

export class PlannerRuns {
  constructor({ ttlMs = RUN_TTL_MS, now = Date.now } = {}) {
    this.runs = new Map();
    this.ttlMs = ttlMs;
    this.now = now;
  }

  // `kind` says which round this is, so a card can tell a first plan apart from
  // an answered round without reading the plan row.
  begin(planId, kind = "plan") {
    const id = String(planId || "");
    if (!id) return;
    this.#sweep();
    if (this.runs.size >= MAX_RUNS) {
      const oldest = [...this.runs.entries()].filter(([, run]) => run.finishedAt !== null).sort((left, right) => left[1].at - right[1].at)[0];
      if (oldest) this.runs.delete(oldest[0]);
    }
    this.runs.set(id, { planId: id, kind, phase: "running", stage: "writing_spec", step: "", error: "", startedAt: this.now(), finishedAt: null, at: this.now() });
  }

  // The one structured lifecycle move a live round makes. It is validated here
  // rather than at the call site, so no caller can invent a third phase.
  setStage(planId, stage) {
    if (!RUN_STAGES.includes(stage)) throw new TypeError(`Unknown planner run stage ${stage}`);
    const run = this.runs.get(String(planId || ""));
    if (!run || run.finishedAt !== null) return;
    run.stage = stage;
    run.at = this.now();
  }

  // The newest legible progress line, which is all a card has room for.
  step(planId, text) {
    const run = this.runs.get(String(planId || ""));
    if (!run || run.finishedAt !== null) return;
    run.step = String(text || "").slice(0, 120);
    run.at = this.now();
  }

  // A finished run stays visible for its TTL, so a card that renders just after
  // the round ends still shows the outcome instead of an empty gap.
  finish(planId, { phase = "done", error = "" } = {}) {
    const run = this.runs.get(String(planId || ""));
    if (!run) return;
    run.phase = phase;
    run.error = String(error || "").slice(0, 400);
    run.finishedAt = this.now();
    run.at = this.now();
  }

  isRunning(planId) {
    this.#sweep();
    const run = this.runs.get(String(planId || ""));
    return Boolean(run && run.finishedAt === null);
  }

  get(planId) {
    this.#sweep();
    return this.runs.get(String(planId || "")) || null;
  }

  list() {
    this.#sweep();
    return [...this.runs.values()].map((run) => ({ ...run }));
  }

  // Every round this process owns is gone after a restart. The caller clears
  // the registry so no card shows a run that no child process backs.
  clear() {
    this.runs.clear();
  }

  #sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, run] of this.runs) {
      if (run.finishedAt !== null && run.finishedAt < cutoff) this.runs.delete(id);
    }
  }
}
