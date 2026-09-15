import { ResultOutbox } from '../result-outbox.mjs';
import { createBridge } from '../bridge.mjs';
import { pinNativeRelease } from './native-handoff.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, realpathSync, lstatSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { identifier, requireValue } from '../domain/contracts.mjs';
import { nativeBinding } from './native-background.mjs';
import { requireNativeCapabilities } from './ccs.mjs';
import { nativeProcessStamp } from './native-process.mjs';

/** Cmux owns terminal I/O; private receipts own operation/conversation identity.
 * Lost creation/send responses stay uncertain and never select a workspace by
 * title. Only a verified runner receives termination; workspace cleanup is T13.
 */
export class NativeTerminal {
  /** @param {{directory:string; bin:string; inputs:import('./native-inputs.mjs').NativeInputs; terminal:Pick<import('./cmux.mjs').CmuxTerminal,'create'|'start'|'open'>; killGraceMs:number; releaseDirectory?:string}} options */
  constructor({ directory, bin, inputs, terminal, killGraceMs, releaseDirectory }) {
    requireValue(isAbsolute(bin) && !bin.includes('\0'), 'Explicit native executable required');
    requireNativeCapabilities(inputs.capabilities, 'planner', 'interactive');
    requireValue(!inputs.installation || inputs.installation.bin === bin, 'Terminal wrapper differs from the probed installation', 'UNSUPPORTED_CAPABILITY');
    requireValue(Number.isSafeInteger(killGraceMs) && killGraceMs > 0 && killGraceMs <= 30000, 'Invalid terminal cleanup limit');
    mkdirSync(directory, { recursive: true, mode: 0o700 }); this.directory = realpathSync(directory);
    requireValue(!lstatSync(directory).isSymbolicLink(), 'Terminal directory identity changed', 'OWNERSHIP_UNCERTAIN');
    this.bin = bin; this.inputs = inputs; this.terminal = terminal; this.killGraceMs = killGraceMs; this.stopping = false;
    // Fixture compositions supply their own managed tree, even when verification
    // itself runs inside an installed release. Production uses the module tree.
    this.releaseDirectory = releaseDirectory;
    this.capabilities = [{ role: /** @type {const} */ ('planner'), mode: /** @type {const} */ ('interactive') }];
    this.managed = new Set();
    /** @type {Map<string, {timer: ReturnType<typeof setInterval> | null; pending: Promise<void> | null; drain: () => Promise<void>}>} */ this.outboxRecovery = new Map();
    /** @type {Map<string,{binding:string;promise:Promise<{identity:string}>}>} */ this.launching = new Map();
  }
  /** @param {string} operationId */
  path(operationId) {
    identifier(operationId); requireValue(realpathSync(this.directory) === this.directory, 'Terminal state identity changed', 'OWNERSHIP_UNCERTAIN');
    const path = join(this.directory, operationId);
    if (existsSync(path)) requireValue(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), 'Terminal operation identity changed', 'OWNERSHIP_UNCERTAIN');
    return path;
  }
  /** @param {string} path */
  read(path) {
    requireValue(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() && lstatSync(path).size <= 2 * 1024 * 1024, 'Invalid terminal receipt', 'OWNERSHIP_UNCERTAIN');
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  /** @param {string} path @param {unknown} value */
  save(path, value) { const temporary = `${path}.${randomUUID()}.tmp`; writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
  /** @param {import('../types.d.ts').LaunchRequest} input */
  launch(input) {
    const request = structuredClone(input), binding = JSON.stringify(nativeBinding(request));
    requireValue(!this.stopping, 'Terminal runtime is stopping', 'NOT_READY');
    requireValue(request.attempt.role === 'planner' && request.attempt.mode === 'interactive' && request.attempt.operationId === request.operationId, 'Invalid terminal launch');
    const existing = this.launching.get(request.operationId);
    if (existing) { requireValue(existing.binding === binding, 'Terminal launch identity reused', 'IDEMPOTENCY_CONFLICT'); return existing.promise; }
    const promise = this.start(request).finally(() => this.launching.delete(request.operationId));
    this.launching.set(request.operationId, { binding, promise }); return promise;
  }
  /** @param {import('../types.d.ts').LaunchRequest} request */
  async start(request) {
    const directory = this.path(request.operationId), path = join(directory, 'request.json');
    if (existsSync(path)) {
      const saved = this.read(path); requireValue(JSON.stringify(saved.binding) === JSON.stringify(nativeBinding(request)), 'Terminal launch identity reused', 'IDEMPOTENCY_CONFLICT');
      const observed = await this.observe(request.operationId); requireValue(observed.identity, 'Terminal launch requires reconciliation', 'OWNERSHIP_UNCERTAIN');
      return { identity: observed.identity };
    }
    requireValue(!existsSync(directory), 'Terminal directory has no launch owner', 'OWNERSHIP_UNCERTAIN');
    mkdirSync(directory, { mode: 0o700 });
    const identity = `terminal:${request.operationId}:${randomUUID()}`;
    writeFileSync(path, JSON.stringify({ identity, binding: nativeBinding(request), request }), { mode: 0o600, flag: 'wx' });
    this.managed.add(request.operationId);
    let sent = false;
    try {
      const command = await this.inputs.prepare(request, directory);
      requireValue(command.activation && !this.stopping, 'Terminal activation is unavailable', 'NOT_READY');
      writeFileSync(join(directory, 'create-sent.json'), JSON.stringify({ identity }), { flag: 'wx', mode: 0o600 }); sent = true;
      const created = await this.terminal.create(request.attempt.worktree ?? '', command.plannerName);
      this.save(join(directory, 'workspace.json'), { identity, workspaceId: created.workspaceId });
      const configPath = join(directory, 'worker.json');
      const release = pinNativeRelease({ directory, identity, operationId: request.operationId }, this.releaseDirectory);
      this.save(configPath, { handoffProtocol: 1, release, identity, workspaceId: created.workspaceId, activation: command.activation, installation: this.inputs.installation?.identity,
        command: { bin: this.bin, argv: command.argv, env: command.env, cwd: request.attempt.worktree }, killGraceMs: this.killGraceMs });
      requireValue(!this.stopping, 'Terminal runtime stopped before runner send', 'NOT_READY');
      writeFileSync(join(directory, 'runner-sent.json'), JSON.stringify({ identity }), { flag: 'wx', mode: 0o600 });
      await this.terminal.start(created.workspaceId, configPath);
      const deadline = Date.now() + 10000;
      while (!existsSync(join(directory, 'identity.json'))) { requireValue(Date.now() < deadline, 'Terminal runner identity is unavailable', 'OWNERSHIP_UNCERTAIN'); await delay(20); }
      const runner = this.read(join(directory, 'identity.json'));
      requireValue(runner.identity === identity && runner.workspaceId === created.workspaceId && runner.stamp && await nativeProcessStamp(runner.pid, directory) === runner.stamp, 'Terminal runner identity changed', 'OWNERSHIP_UNCERTAIN');
      if (this.stopping) await this.terminate(identity);
      return { identity };
    } catch (error) {
      if (!sent) this.save(join(directory, 'outcome.json'), { identity, workerState: 'stopped', code: 'PREPARATION_FAILED' });
      throw error;
    }
  }
  /** @param {string} operationId @returns {Promise<{status:'running'|'stopped'|'unknown';identity:string|null;pendingOutbox?:boolean}>} */
  async observe(operationId) {
    const directory = this.path(operationId), path = join(directory, 'request.json');
    if (!existsSync(path)) return { status: 'unknown', identity: null };
    const saved = this.read(path); this.managed.add(operationId);
    requireValue(saved.binding.operationId === operationId && JSON.stringify(saved.binding) === JSON.stringify(nativeBinding(saved.request)), 'Terminal request changed', 'OWNERSHIP_UNCERTAIN');
    if (existsSync(join(directory, 'outcome.json'))) {
      const result = this.read(join(directory, 'outcome.json')); requireValue(result.identity === saved.identity, 'Terminal result identity changed', 'OWNERSHIP_UNCERTAIN');
      const pendingOutbox = result.workerState === 'stopped' && await this.recoverOutbox(directory);
      return { status: result.workerState === 'stopped' ? 'stopped' : 'unknown', identity: saved.identity, ...(pendingOutbox ? { pendingOutbox: true } : {}) };
    }
    if (!existsSync(join(directory, 'identity.json'))) return { status: 'unknown', identity: null };
    const runner = this.read(join(directory, 'identity.json')), workspace = this.read(join(directory, 'workspace.json'));
    requireValue(runner.identity === saved.identity && workspace.identity === saved.identity && runner.workspaceId === workspace.workspaceId, 'Terminal workspace binding changed', 'OWNERSHIP_UNCERTAIN');
    return { status: runner.stamp && await nativeProcessStamp(runner.pid, directory) === runner.stamp ? 'running' : 'unknown', identity: saved.identity };
  }
  /** A stopped runner cannot drain its own spool. Recover with its original
   * credential only; maintenance rejects writes until acceptance/rollback finishes.
   * @param {string} directory */
  async recoverOutbox(directory) {
    const path = join(directory, 'bridge.json');
    if (!existsSync(path)) return;
    const config = this.read(path);
    if (config.handoffProtocol !== 1) return;
    const outbox = new ResultOutbox({ directory: join(directory, 'outbox'), binding: config.binding });
    if (!outbox.entries().some(entry => entry.value.status === 'queued')) return;
    let recovery = this.outboxRecovery.get(directory);
    if (!recovery) {
      const bridge = createBridge({ ...config, timeoutMs: 1000 });
      const entry = { timer: /** @type {ReturnType<typeof setInterval> | null} */ (null), pending: /** @type {Promise<void> | null} */ (null), drain: /** @type {() => Promise<void>} */ (async () => {}) };
      const drain = () => {
        if (!entry.pending) entry.pending = outbox.drain(bridge).finally(() => {
          entry.pending = null;
          if (!outbox.entries().some(item => item.value.status === 'queued')) { if (entry.timer) clearInterval(entry.timer); this.outboxRecovery.delete(directory); }
        });
        return entry.pending;
      };
      entry.drain = drain;
      entry.timer = setInterval(() => { void drain().catch(() => {}); }, 500); entry.timer.unref();
      this.outboxRecovery.set(directory, entry); recovery = entry;
      await drain();
    } else await recovery.drain();
    return outbox.entries().some(entry => entry.value.status === 'queued');
  }
  /** @param {import('../types.d.ts').LaunchRequest} request */
  async resume(request) {
    requireValue(!this.stopping, 'Terminal runtime is stopping', 'NOT_READY');
    const id = identifier(request.resumeId); requireValue(id !== 'initial', 'Reserved native resume identity');
    const directory = this.path(request.operationId), saved = this.read(join(directory, 'request.json'));
    requireValue(saved.identity === request.attempt.identity && JSON.stringify(saved.binding) === JSON.stringify(nativeBinding(request)), 'Resume identity changed', 'STALE_ATTEMPT');
    const receipt = join(directory, `resume-${id}.json`);
    if (existsSync(receipt)) requireValue(this.read(receipt).identity === saved.identity, 'Resume receipt changed', 'IDEMPOTENCY_CONFLICT');
    if (existsSync(join(directory, `run-${id}.json`))) return { identity: saved.identity };
    requireValue((await this.observe(request.operationId)).status === 'running', 'Terminal runner is not available', 'OWNERSHIP_UNCERTAIN');
    requireValue(!this.stopping, 'Terminal runtime is stopping', 'NOT_READY');
    // The supervisor can consume this resume while process observation awaits.
    // Recheck its receipt before rejecting the now-running conversation.
    if (existsSync(join(directory, `run-${id}.json`))) return { identity: saved.identity };
    requireValue(this.read(join(directory, 'session.json')).phase === 'paused', 'Native conversation is already running', 'ALREADY_RUNNING');
    const pointer = join(directory, 'resume.json');
    if (existsSync(pointer)) {
      const pending = this.read(pointer);
      requireValue(pending.id === id || existsSync(join(directory, `run-${pending.id}.json`)), 'Another resume is pending', 'ALREADY_RUNNING');
    }
    const value = { identity: saved.identity, id };
    if (!existsSync(receipt)) writeFileSync(receipt, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    this.save(join(directory, 'resume.json'), value);
    return { identity: saved.identity };
  }
  /** @param {string} identity */
  async terminate(identity) {
    const parts = identity.split(':'); requireValue(parts.length === 3 && parts[0] === 'terminal', 'Invalid terminal identity', 'OWNERSHIP_UNCERTAIN');
    const operationId = identifier(parts[1]), directory = this.path(operationId);
    const observed = await this.observe(operationId); requireValue(observed.identity === identity, 'Terminal identity changed', 'OWNERSHIP_UNCERTAIN');
    if (observed.status === 'stopped') return;
    requireValue(observed.status === 'running', 'Terminal process instance is unknown', 'OWNERSHIP_UNCERTAIN');
    const runner = this.read(join(directory, 'identity.json'));
    requireValue(runner.stamp && await nativeProcessStamp(runner.pid, directory) === runner.stamp, 'Terminal process instance changed', 'OWNERSHIP_UNCERTAIN');
    try { process.kill(runner.pid, 'SIGTERM'); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') throw error; }
  }
  /** @param {string} operationId */
  async open(operationId) {
    const observed = await this.observe(operationId); requireValue(observed.status === 'running', 'Owned terminal is unavailable', 'OWNERSHIP_UNCERTAIN');
    await this.terminal.open(this.read(join(this.path(operationId), 'workspace.json')).workspaceId);
  }
  /** Validate the complete binding without launching, resuming or minting credentials.
   * @param {import('../types.d.ts').LaunchRequest} request */
  async prepareHandoff(request) {
    requireValue(!this.launching.size && request.attempt.role === 'planner' && request.attempt.mode === 'interactive', 'Terminal effect is still in flight', 'NOT_READY');
    const directory = this.path(request.operationId), saved = this.read(join(directory, 'request.json'));
    requireValue(saved.identity === request.attempt.identity && JSON.stringify(saved.binding) === JSON.stringify(nativeBinding(request)), 'Handoff attempt identity changed', 'OWNERSHIP_UNCERTAIN');
    const config = this.read(join(directory, 'worker.json'));
    requireValue(config.handoffProtocol === 1 && existsSync(join(directory, 'handoff.json')), 'Existing planning agent needs update-compatible recovery', 'HANDOFF_UNSUPPORTED');
    const protocol = this.read(join(directory, 'handoff.json'));
    requireValue(protocol.version === 1 && protocol.identity === saved.identity, 'Handoff protocol identity changed', 'OWNERSHIP_UNCERTAIN');
    const observed = await this.observe(request.operationId);
    requireValue(observed.identity === saved.identity && observed.status !== 'unknown', 'Handoff worker identity is uncertain', 'OWNERSHIP_UNCERTAIN');
    if (observed.status === 'running') requireValue(['running', 'paused'].includes(this.read(join(directory, 'session.json')).phase), 'Native activation is still in flight', 'NOT_READY');
    requireValue(typeof config.activation?.credential === 'string' && typeof config.activation.endpoint === 'string', 'Handoff credential unavailable', 'OWNERSHIP_UNCERTAIN');
    return { goalId: request.goalId, operationId: request.operationId, identity: saved.identity, endpoint: config.activation.endpoint, credentialDigest: createHash('sha256').update(config.activation.credential).digest('hex') };
  }
  /** @param {{preserve?: import('../types.d.ts').LaunchRequest[]}} [options] */
  async close({ preserve = [] } = {}) {
    this.stopping = true; await Promise.allSettled([...this.launching.values()].map((entry) => entry.promise));
    try {
    const retained = new Set(preserve.map(request => request.operationId));
    for (const request of preserve) await this.prepareHandoff(request);
    const settled = await Promise.allSettled([...this.managed].map(async (operationId) => {
      if (retained.has(operationId)) { this.managed.delete(operationId); return; }
      const observed = await this.observe(operationId);
      if (observed.status !== 'stopped' && observed.identity) await this.terminate(observed.identity);
      const deadline = Date.now() + this.killGraceMs * 2 + 1000;
      while ((await this.observe(operationId)).status !== 'stopped') { requireValue(Date.now() < deadline, 'Terminal termination remains uncertain', 'OWNERSHIP_UNCERTAIN'); await delay(20); }
      this.managed.delete(operationId);
    }));
    requireValue(settled.every((entry) => entry.status === 'fulfilled'), 'Owned terminals need reconciliation', 'OWNERSHIP_UNCERTAIN');
    } finally {
    for (const recovery of this.outboxRecovery.values()) if (recovery.timer) clearInterval(recovery.timer);
    await Promise.allSettled([...this.outboxRecovery.values()].map(entry => entry.pending));
    this.outboxRecovery.clear();
    }
  }
}
