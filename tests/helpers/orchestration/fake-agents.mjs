/** Deterministic external process model. Launch counts are separate from intent
 * records so tests cannot hide duplicate dispatch behind the same operation id.
 */
export class FakeAgents {
  constructor() {
    this.capabilities = [{ role: 'planner', mode: 'interactive' }, ...['implementer', 'reviewer', 'integrator'].map((role) => ({ role, mode: 'background' }))];
    this.workers = new Map(); this.launches = []; this.terminations = [];
    this.loseResponse = false; this.observationUnknown = false; this.ignoreTermination = false;
    this.onLaunch = async () => {};
  }
  async launch(request) {
    this.launches.push(structuredClone(request));
    const identity = `worker_${request.operationId}`;
    this.workers.set(request.operationId, { identity, status: 'running' });
    await this.onLaunch(request);
    if (this.loseResponse) throw new Error('lost launch response');
    return { identity };
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
