// A planner round takes minutes and says nothing while it runs. This registry
// carries its live steps from the round to whichever browser is watching.
//
// The key is a trace id the client makes before it posts the goal, because the
// slow round is round one and no plan id exists until that round finishes.

export const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_TRACES = 20;
const MAX_EVENTS = 40;
const TRACE_TTL_MS = 5 * 60_000;
// A finished round keeps its buffer only long enough for a reconnect that lands
// just after the last event to still read the "done".
const FINISHED_GRACE_MS = 10_000;

export class PlannerProgress {
  constructor({ ttlMs = TRACE_TTL_MS, now = Date.now } = {}) {
    this.traces = new Map();
    this.ttlMs = ttlMs;
    this.now = now;
  }

  publish(traceId, event) {
    // An unbounded key space is the whole risk here, so a key that is not a
    // uuid never allocates anything.
    if (!TRACE_ID.test(String(traceId || ""))) return;
    const trace = this.#trace(traceId);
    trace.at = this.now();
    // The buffer is a replay window for a reconnect, not a transcript. Its head
    // is what a late subscriber already missed and can no longer act on.
    trace.events.push(event);
    if (trace.events.length > MAX_EVENTS) trace.events.shift();
    for (const listener of trace.listeners) {
      try { listener(event); } catch { /* one broken stream never stops another */ }
    }
    if (event?.k === "done" || event?.k === "error") this.finish(traceId);
  }

  subscribe(traceId, listener) {
    if (!TRACE_ID.test(String(traceId || ""))) return () => {};
    const trace = this.#trace(traceId);
    for (const event of trace.events) {
      try { listener(event); } catch { /* a dead stream needs no replay */ }
    }
    trace.listeners.add(listener);
    return () => { trace.listeners.delete(listener); };
  }

  // Nothing more can arrive for this trace, so age it towards the sweep.
  finish(traceId) {
    const trace = this.traces.get(traceId);
    if (trace) trace.at = this.now() - this.ttlMs + FINISHED_GRACE_MS;
  }

  #trace(traceId) {
    this.#sweep();
    let trace = this.traces.get(traceId);
    if (!trace) {
      if (this.traces.size >= MAX_TRACES) {
        const oldest = [...this.traces.entries()].sort((left, right) => left[1].at - right[1].at)[0];
        if (oldest) this.traces.delete(oldest[0]);
      }
      trace = { events: [], listeners: new Set(), at: this.now() };
      this.traces.set(traceId, trace);
    }
    return trace;
  }

  #sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, trace] of this.traces) {
      if (trace.at < cutoff && trace.listeners.size === 0) this.traces.delete(id);
    }
  }
}
