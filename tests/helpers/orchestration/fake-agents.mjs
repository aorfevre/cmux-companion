/** Deterministic external process model. Launch counts are separate from intent
 * records so tests cannot hide duplicate dispatch behind the same operation id.
 */
export class FakeAgents {
  constructor() {
    this.capabilities = [{ role: 'planner', mode: 'interactive' }, ...['implementer', 'reviewer', 'integrator', 'review_fixer'].map((role) => ({ role, mode: 'background' }))];
    this.workers = new Map(); this.launches = []; this.terminations = [];
    this.loseResponse = false; this.observationUnknown = false; this.ignoreTermination = false;
    this.onLaunch = async () => {};
  }
  beginLaunch(request) {
    this.launches.push(structuredClone(request));
    const identity = `worker_${request.operationId}`;
    this.workers.set(request.operationId, { identity, status: 'running' });
    return { identity };
  }
  async afterLaunch() {}
  async launch(request) {
    const launched = this.beginLaunch(request);
    await this.onLaunch(request);
    await this.afterLaunch(request);
    if (this.loseResponse) throw new Error('lost launch response');
    return launched;
  }
  async observe(operationId) {
    if (this.observationUnknown) return { status: 'unknown', identity: null };
    // This fake owns its entire process inventory, so absence is confirmed.
    return this.workers.get(operationId) ?? { status: 'stopped', identity: null };
  }
  async terminate(identity) {
    this.terminations.push(identity);
    if (!this.ignoreTermination) for (const worker of this.workers.values()) if (worker.identity === identity) worker.status = 'stopped';
  }
  stop(operationId) { const worker = this.workers.get(operationId); if (worker) worker.status = 'stopped'; }
}
export function barrier() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

/** Scripted processes use the adapter result boundary. They never accept tasks,
 * integrate branches, or write workflow state themselves. Script barriers model
 * work in flight separately from a lost launch acknowledgement.
 */
export class ScriptedAgents extends FakeAgents {
  constructor({ script, onResult = async () => {} }) {
    super(); this.script = script; this.onResult = onResult;
    this.jobs = new Map(); this.controllers = new Map(); this.results = []; this.errors = [];
  }
  beginLaunch(request) {
    this.controllers.set(request.operationId, new AbortController());
    return super.beginLaunch(request);
  }
  async terminate(identity) {
    this.terminations.push(identity);
    if (this.ignoreTermination) return;
    for (const [operationId, worker] of this.workers) {
      if (worker.identity === identity) this.controllers.get(operationId)?.abort();
    }
    // Cancellation requests do not prove termination. Only the job's finally
    // block marks it stopped, including scripts that ignore their signal.
  }
  async afterLaunch(request) {
    const signal = this.controllers.get(request.operationId).signal;
    const job = Promise.resolve().then(async () => {
      try {
        signal.throwIfAborted();
        const result = await this.script(structuredClone(request), { signal });
        signal.throwIfAborted();
        this.results.push({ operationId: request.operationId, result: structuredClone(result) });
        await this.onResult(request, result);
      } catch (error) { if (!signal.aborted || error !== signal.reason) this.errors.push({ operationId: request.operationId, error }); }
      finally { this.stop(request.operationId); }
    });
    this.jobs.set(request.operationId, job);
  }
  async drain() { await Promise.all([...this.jobs.values()]); }
}
