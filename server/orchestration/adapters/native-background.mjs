import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdirSync, lstatSync, realpathSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DomainError, identifier, requireValue } from '../domain/contracts.mjs';
import { backgroundPolicy } from './agent-runtime.mjs';
import { nativeResult, requireNativeCapabilities } from './ccs.mjs';
import { pathExists } from './git.mjs';
import { nativeProcessStamp, nativeGroupState } from './native-process.mjs';
const WORKER = fileURLToPath(new URL('./native-worker.mjs', import.meta.url));

/** @param {import('../types.d.ts').LaunchRequest} request */
export function nativeBinding(request) {
  const { attempt, goalId, operationId } = request;
  return { goalId, operationId, attemptId: attempt.id, role: attempt.role, mode: attempt.mode, generation: attempt.generation, revision: attempt.revision,
    conversationId: attempt.conversationId, target: attempt.target, baseSha: attempt.baseSha, worktree: attempt.worktree, branch: attempt.branch };
}

/** Durable background launch receipts compose the existing bounded process
 * primitive with native input/output contracts. An uncertain sent launch never
 * starts another worker. No constructor starts a process or timer.
 */
export class NativeBackground {
  /** @param {{ directory: string; bin: string; inputs: import('./native-inputs.mjs').NativeInputs; policy: import('../types.d.ts').BackgroundPolicy; onResult: (request: import('../types.d.ts').LaunchRequest, raw: string) => void | Promise<void>; onError?: (code: string) => void; failpoint?: (point: string) => void }} options */
  constructor({ directory, bin, inputs, policy, onResult, onError = () => {}, failpoint = () => {} }) {
    requireValue(isAbsolute(bin) && !bin.includes('\0'), 'Native executable must be explicit and absolute');
    this.bin = bin; this.inputs = inputs; this.policy = backgroundPolicy(policy); requireValue(this.policy.maxOutputBytes <= 2 * 1024 * 1024, 'Native output budget exceeds transport limit'); this.onResult = onResult; this.onError = onError; this.failpoint = failpoint;
    for (const role of /** @type {const} */ (['implementer', 'reviewer', 'integrator'])) requireNativeCapabilities(inputs.capabilities, role, 'background');
    this.capabilities = /** @type {import('../types.d.ts').AgentPort['capabilities']} */ (['implementer', 'reviewer', 'integrator'].map((role) => ({ role, mode: 'background' })));
    mkdirSync(directory, { recursive: true, mode: 0o700 }); this.directory = realpathSync(directory);
    requireValue(!lstatSync(directory).isSymbolicLink(), 'Native state directory is a symlink', 'OWNERSHIP_UNCERTAIN');
    this.stopping = false;
    this.shutdownDeadline = Infinity;
    /** Only operations launched/reconciled by this instance are shutdown owners. */
    this.managed = new Set();
    /** @type {Map<string, { job: Promise<void> }>} */ this.active = new Map();
    /** @type {Map<string, {binding: string; promise: Promise<{identity: string}>}>} */ this.launching = new Map();
    /** @type {Map<string, Promise<void>>} */ this.delivering = new Map();
  }
  /** @param {string} operationId */
  path(operationId) {
    identifier(operationId); requireValue(realpathSync(this.directory) === this.directory, 'Native state directory changed', 'OWNERSHIP_UNCERTAIN');
    const directory = join(this.directory, operationId);
    if (pathExists(directory)) requireValue(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'Native operation directory changed', 'OWNERSHIP_UNCERTAIN');
    return directory;
  }
  /** @param {string} path @param {unknown} value */
  save(path, value) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path);
  }
  /** @param {string} path */
  read(path) {
    // Two MiB of output can expand sixfold through JSON control-byte escaping.
    // The worker enforces that raw budget; this includes bounded receipt metadata.
    requireValue(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() && lstatSync(path).size <= 16 * 1024 * 1024, 'Native receipt is invalid or oversized', 'OWNERSHIP_UNCERTAIN');
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  /** @param {import('../types.d.ts').LaunchRequest} request */
  launch(request) {
    request = structuredClone(request);
    requireValue(!this.stopping, 'Native runtime is stopping', 'NOT_READY');
    requireNativeCapabilities(this.inputs.capabilities, request.attempt.role, request.attempt.mode);
    requireValue(request.attempt.mode === 'background', 'Interactive planning needs its terminal adapter', 'UNSUPPORTED_CAPABILITY');
    requireValue(request.operationId === request.attempt.operationId, 'Native operation binding changed', 'IDEMPOTENCY_CONFLICT');
    const binding = JSON.stringify(nativeBinding(request));
    const existing = this.launching.get(request.operationId);
    if (existing) { requireValue(existing.binding === binding, 'Native launch identity was reused', 'IDEMPOTENCY_CONFLICT'); return existing.promise; }
    const launched = this.start(request).finally(() => this.launching.delete(request.operationId));
    this.launching.set(request.operationId, { binding, promise: launched }); return launched;
  }
  /** @param {import('../types.d.ts').LaunchRequest} request */
  async start(request) {
    const directory = this.path(request.operationId), requestPath = join(directory, 'request.json');
    const binding = nativeBinding(request);
    if (pathExists(requestPath)) {
      requireValue(JSON.stringify(this.read(requestPath).binding) === JSON.stringify(binding), 'Native launch identity was reused', 'IDEMPOTENCY_CONFLICT');
      const identityPath = join(directory, 'identity.json');
      requireValue(pathExists(identityPath), 'Native launch has no proven worker identity', 'OWNERSHIP_UNCERTAIN');
      this.managed.add(request.operationId); return { identity: String(this.read(identityPath).identity) };
    }
    requireValue(!pathExists(directory), 'Native directory has no launch owner', 'OWNERSHIP_UNCERTAIN');
    mkdirSync(directory, { mode: 0o700 });
    const identity = `native:${request.operationId}:${randomUUID()}`;
    writeFileSync(requestPath, JSON.stringify({ schemaVersion: 1, identity, binding, request }), { mode: 0o600, flag: 'wx' });
    this.managed.add(request.operationId);
    let sent = false;
    try {
      const command = await this.inputs.prepare(request, directory);
      requireValue(!this.stopping, 'Native runtime stopped before launch', 'NOT_READY');
      // Exclusive claim precedes the first process operation, including failures.
      writeFileSync(join(directory, 'sent.json'), JSON.stringify({ identity }), { mode: 0o600, flag: 'wx' }); sent = true;
      this.failpoint('sent');
      const workerPath = join(directory, 'worker.json');
      writeFileSync(workerPath, JSON.stringify({ identity, startedAt: Date.now(), command: { bin: this.bin, argv: command.argv, cwd: request.attempt.worktree, env: command.env }, policy: this.policy, activation: command.activation }), { mode: 0o600, flag: 'wx' });
      const child = spawn(process.execPath, [WORKER, workerPath], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH } });
      await once(child, 'spawn'); child.unref();
      const identityPath = join(directory, 'identity.json'), deadline = Date.now() + 10000;
      while (!pathExists(identityPath)) {
        requireValue(child.exitCode === null && child.signalCode === null && Date.now() < deadline, 'Native supervisor identity is unavailable', 'OWNERSHIP_UNCERTAIN');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      requireValue(this.read(identityPath).identity === identity, 'Native supervisor identity changed', 'OWNERSHIP_UNCERTAIN');
      this.failpoint('identity');
      const job = this.watch(request.operationId).catch((error) => { this.report(error instanceof DomainError ? error.code : 'NATIVE_RECEIPT_FAILED'); }).finally(() => {
        this.active.delete(request.operationId);
        const path = join(directory, 'outcome.json');
        try { if (pathExists(path) && this.read(path).outcome.workerState === 'stopped') this.managed.delete(request.operationId); }
        catch { this.report('OWNERSHIP_UNCERTAIN'); }
      });
      this.active.set(request.operationId, { job });
      if (this.stopping) await this.terminate(identity);
      return { identity };
    } catch (error) {
      if (!sent) this.save(join(directory, 'not-sent.json'), { identity, code: error instanceof DomainError ? error.code : 'NATIVE_PREPARATION_FAILED' });
      throw new DomainError(sent ? 'OWNERSHIP_UNCERTAIN' : 'NATIVE_PREPARATION_FAILED', sent ? 'Native launch needs identity reconciliation' : 'Native input preparation failed');
    }
  }
  /** Supervisor owns timing/output even if the service dies. This watcher only
   * moves its completed receipt into the service result inbox.
   * @param {string} operationId */
  async watch(operationId) {
    const directory = this.path(operationId), outcomePath = join(directory, 'outcome.json');
    const config = this.read(join(directory, 'worker.json'));
    const deadline = config.startedAt + config.policy.ceilingMs + config.policy.killGraceMs * 2 + 10000;
    while (!pathExists(outcomePath)) {
      const worker = this.read(join(directory, 'identity.json'));
      if (nativeGroupState(worker.pid) === 'dead') { if (pathExists(outcomePath)) await this.deliver(operationId); return; }
      const stamp = await nativeProcessStamp(worker.pid, directory);
      if (pathExists(outcomePath)) { await this.deliver(operationId); return; }
      requireValue(worker.stamp && stamp === worker.stamp, 'Native supervisor identity cannot be verified', 'OWNERSHIP_UNCERTAIN');
      requireValue(Date.now() < Math.min(deadline, this.shutdownDeadline), 'Native supervisor has not settled within its deadline', 'OWNERSHIP_UNCERTAIN');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    this.failpoint('outcome'); await this.deliver(operationId);
  }
  /** @param {string} code */
  report(code) { try { this.onError(code); } catch { /* diagnostic sinks do not own workers */ } }
  /** @param {string} operationId */
  deliver(operationId) {
    const existing = this.delivering.get(operationId); if (existing) return existing;
    const work = (async () => {
      const directory = this.path(operationId), outcomePath = join(directory, 'outcome.json');
      if (!pathExists(outcomePath) || pathExists(join(directory, 'delivery.json'))) return;
      const saved = this.read(join(directory, 'request.json')), completed = this.read(outcomePath);
      requireValue(completed.identity === saved.identity, 'Native result identity changed', 'OWNERSHIP_UNCERTAIN');
      if (completed.outcome.status !== 'succeeded') { this.save(join(directory, 'delivery.json'), { code: completed.outcome.cause?.code ?? 'NATIVE_FAILED' }); return; }
      let raw;
      try { raw = nativeResult(completed.outcome.stdout, saved.binding.conversationId); }
      catch { this.save(join(directory, 'delivery.json'), { code: 'INVALID_RESULT' }); return; }
      await this.onResult(saved.request, raw);
      this.save(join(directory, 'delivery.json'), { code: null });
    })().finally(() => this.delivering.delete(operationId));
    this.delivering.set(operationId, work); return work;
  }
  /** @param {string} operationId @returns {Promise<{status:'running'|'stopped'|'unknown';identity:string|null}>} */
  async observe(operationId) {
    const directory = this.path(operationId), requestPath = join(directory, 'request.json');
    if (!pathExists(requestPath)) return { status: 'unknown', identity: null };
    const request = this.read(requestPath);
    requireValue(request.binding?.operationId === operationId && JSON.stringify(nativeBinding(request.request)) === JSON.stringify(request.binding), 'Native request binding changed', 'OWNERSHIP_UNCERTAIN');
    this.managed.add(operationId);
    if (pathExists(join(directory, 'not-sent.json'))) return { status: 'stopped', identity: request.identity };
    const outcomePath = join(directory, 'outcome.json');
    if (pathExists(outcomePath)) {
      await this.deliver(operationId); const completed = this.read(outcomePath);
      requireValue(completed.identity === request.identity, 'Native outcome identity changed', 'OWNERSHIP_UNCERTAIN');
      if (completed.outcome.workerState === 'stopped') return { status: 'stopped', identity: request.identity };
      // Escaped descendants can outlive the original group. Its disappearance
      // cannot override the executor's durable unknown-termination evidence.
      return { status: 'unknown', identity: request.identity };
    }
    const identityPath = join(directory, 'identity.json');
    if (!pathExists(identityPath)) return { status: 'unknown', identity: null };
    const worker = this.read(identityPath); requireValue(worker.identity === request.identity && Number.isSafeInteger(worker.pid) && worker.pid > 0, 'Native worker identity changed', 'OWNERSHIP_UNCERTAIN');
    if (nativeGroupState(worker.pid) === 'dead') return { status: 'unknown', identity: request.identity };
    if (worker.stamp && await nativeProcessStamp(worker.pid, directory) === worker.stamp && !pathExists(outcomePath)) return { status: 'running', identity: request.identity };
    return { status: 'unknown', identity: request.identity };
  }
  /** @param {string} identity */
  async terminate(identity) {
    const parts = identity.split(':'); requireValue(parts.length === 3 && parts[0] === 'native', 'Invalid native worker identity', 'OWNERSHIP_UNCERTAIN');
    const operationId = identifier(parts[1]), directory = this.path(operationId), saved = this.read(join(directory, 'request.json'));
    requireValue(saved.identity === identity, 'Native worker identity changed', 'OWNERSHIP_UNCERTAIN');
    const worker = this.read(join(directory, 'identity.json'));
    requireValue(worker.identity === identity && Number.isSafeInteger(worker.pid) && worker.pid > 0, 'Native worker identity changed', 'OWNERSHIP_UNCERTAIN');
    if (nativeGroupState(worker.pid) === 'dead') return;
    requireValue(worker.stamp && await nativeProcessStamp(worker.pid, directory) === worker.stamp, 'Native process instance cannot be verified', 'OWNERSHIP_UNCERTAIN');
    // A later reconciliation observes termination; this signal is not stopped proof.
    try { process.kill(worker.pid, 'SIGTERM'); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') throw new DomainError('OWNERSHIP_UNCERTAIN', 'Native termination is uncertain'); }
  }
  async close() {
    this.stopping = true;
    this.shutdownDeadline = Date.now() + Math.min(30000, this.policy.killGraceMs * 2 + 1000);
    await Promise.allSettled([...this.launching.values()].map((entry) => entry.promise));
    const operations = [...this.managed];
    await Promise.all(operations.map(async (operationId) => {
      try {
        const directory = this.path(operationId);
        if (!pathExists(join(directory, 'outcome.json')) && pathExists(join(directory, 'identity.json'))) await this.terminate(String(this.read(join(directory, 'request.json')).identity));
      } catch { this.report('OWNERSHIP_UNCERTAIN'); }
    }));
    await Promise.all([...this.active.values()].map((active) => active.job));
    const observations = await Promise.allSettled(operations.map(async (operationId) => {
      // A supervisor can disappear between the signal and atomic outcome rename.
      // Wait for durable stopped proof even when the first observation is unknown.
      const deadline = Date.now() + this.policy.killGraceMs * 2 + 1000;
      let observation = await this.observe(operationId);
      while (observation.status !== 'stopped' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        observation = await this.observe(operationId);
      }
      requireValue(observation.status === 'stopped', 'Native worker termination is uncertain', 'OWNERSHIP_UNCERTAIN');
      this.managed.delete(operationId);
    }));
    requireValue(observations.every((result) => result.status === 'fulfilled'), 'One or more native worker terminations are uncertain', 'OWNERSHIP_UNCERTAIN');
    // Inputs/receipts remain private recovery evidence; T13 cleanup owns removal.
  }
}
