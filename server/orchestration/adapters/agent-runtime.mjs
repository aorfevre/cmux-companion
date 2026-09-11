import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { DomainError, integer, requireValue } from '../domain/contracts.mjs';
import { requireCapability } from '../ports.mjs';

/** @type {import('../types.d.ts').RuntimeClock} */
const clock = { schedule: (callback, delay) => setTimeout(callback, delay), cancel: (handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)) };

/** Background limits are mandatory and bounded by the native timer range.
 * Interactive drivers receive no background timers or redirected terminal I/O.
 * @param {import('../types.d.ts').BackgroundPolicy} input
 */
export function backgroundPolicy(input) {
  for (const value of [input.ceilingMs, input.idleMs, input.maxOutputBytes, input.killGraceMs]) {
    integer(value, 1); requireValue(value <= 2147483647, 'Execution limit exceeds supported range');
  }
  return Object.freeze({ ...input });
}

/** A bounded argv-only process primitive. Raw output is private evidence, not a
 * public error message. Process completion does not itself prove workflow success
 * or the termination of all provider-owned resources; adapters observe those.
 * @param {{ bin: string; argv: string[]; cwd: string; env: NodeJS.ProcessEnv }} command
 * @param {{ policy: import('../types.d.ts').BackgroundPolicy; signal?: AbortSignal; clock?: import('../types.d.ts').RuntimeClock; identity?: () => string; onIdentity: (identity: { identity: string; pid: number }) => void | Promise<void> }} options
 * @returns {Promise<import('../types.d.ts').BackgroundHandle>}
 */
export function startBackgroundProcess(command, { policy: input, signal, clock: timers = clock, identity = randomUUID, onIdentity }) {
  const policy = backgroundPolicy(input);
  requireValue(process.platform !== 'win32', 'Background execution requires process-group support', 'UNSUPPORTED_CAPABILITY');
  requireValue(command.bin.length > 0 && !command.bin.includes('\0') && command.argv.every((arg) => typeof arg === 'string' && !arg.includes('\0')), 'Invalid process argv');
  if (signal?.aborted) return Promise.reject(new DomainError('ABORTED', 'Execution was aborted before spawn'));
  const workerIdentity = identity(); requireValue(workerIdentity.length >= 16, 'Invalid runtime identity');
  return new Promise((resolve, reject) => {
    const child = spawn(command.bin, command.argv, { cwd: command.cwd, env: command.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    /** @type {Buffer[]} */ const stdout = [];
    /** @type {Buffer[]} */ const stderr = [];
    let bytes = 0, ended = false, reason = '', spawned = false, closed = false;
    /** @type {number | null} */ let exitCode = null;
    /** @type {NodeJS.Signals | null} */ let closeSignal = null;
    /** @type {unknown} */ let ceiling = null;
    /** @type {unknown} */ let idle = null;
    /** @type {unknown} */ let force = null;
    /** @type {(outcome: import('../types.d.ts').ProcessOutcome) => void} */ let finish = () => {};
    /** @type {Promise<import('../types.d.ts').ProcessOutcome>} */ const result = new Promise((done) => { finish = done; });
    const groupStopped = () => {
      if (!child.pid) return true;
      try { process.kill(-child.pid, 0); return false; }
      catch (error) { return /** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH'; }
    };
    const complete = (deadline = false) => {
      if ((!closed && !deadline) || ended) return;
      const stopped = closed && groupStopped();
      ended = true; timers.cancel(ceiling); timers.cancel(idle); timers.cancel(force);
      signal?.removeEventListener('abort', abort);
      if (!closed) {
        // A descendant outside the owned group may retain these pipes. Drain
        // only until the cleanup deadline, then retain uncertain ownership.
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
      }
      if (!spawned) reject(new DomainError('SPAWN_FAILED', 'Background process could not start'));
      const code = reason || (!stopped ? 'TERMINATION_UNCERTAIN' : closeSignal ? 'SIGNALLED' : exitCode === 0 ? '' : 'EXIT_FAILED');
      // Truncated/invalid UTF-8 must not expand the returned byte budget through
      // replacement characters. StringDecoder.write omits an incomplete suffix.
      const out = new StringDecoder('utf8').write(Buffer.from(Buffer.concat(stdout).toString('utf8')).subarray(0, policy.maxOutputBytes));
      const err = new StringDecoder('utf8').write(Buffer.from(Buffer.concat(stderr).toString('utf8')).subarray(0, policy.maxOutputBytes - Buffer.byteLength(out)));
      finish({ status: code ? 'failed' : 'succeeded', workerState: stopped ? 'stopped' : 'unknown', cause: code ? { code, exitCode, signal: closeSignal } : null, stdout: out, stderr: err });
    };
    /** @param {NodeJS.Signals} value */
    const kill = (value) => {
      if (!child.pid || ended) return;
      try { process.kill(-child.pid, value); }
      catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') reason = 'TERMINATION_UNCERTAIN'; }
    };
    /** @param {string} code */
    const stop = (code) => {
      if (ended || reason) return;
      reason = code; timers.cancel(ceiling); timers.cancel(idle);
      kill('SIGTERM');
      force = timers.schedule(() => {
        kill('SIGKILL');
        // The leader may already have closed its pipes while descendants still
        // own the group. Give the kernel a bounded reap window, then retain
        // uncertainty if group disappearance cannot be established.
        force = timers.schedule(() => complete(true), policy.killGraceMs);
      }, policy.killGraceMs);
    };
    const abort = () => stop('ABORTED');
    const activity = () => {
      if (ended || reason) return;
      timers.cancel(idle); idle = timers.schedule(() => stop('IDLE_LIMIT'), policy.idleMs);
    };
    /** @param {Buffer[]} output @param {Buffer} chunk */
    const receive = (output, chunk) => {
      activity();
      const remaining = Math.max(0, policy.maxOutputBytes - bytes);
      if (remaining) output.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > policy.maxOutputBytes) stop('OUTPUT_LIMIT');
    };
    child.stdout.on('data', (chunk) => receive(stdout, chunk));
    child.stderr.on('data', (chunk) => receive(stderr, chunk));
    child.once('error', () => { reason ||= 'SPAWN_FAILED'; });
    child.once('close', (code, signal) => {
      closed = true; exitCode = code; closeSignal = signal;
      if (groupStopped()) complete();
      else if (!reason) stop('DESCENDANTS_RUNNING');
    });
    child.once('spawn', async () => {
      spawned = true;
      try {
        requireValue(child.pid, 'Spawned process has no identity');
        const pid = child.pid;
        const persisted = await Promise.race([
          Promise.resolve().then(() => onIdentity({ identity: workerIdentity, pid })).then(() => true),
          result.then(() => false),
        ]);
        requireValue(persisted, 'Process ended before identity persistence completed');
        resolve({ identity: workerIdentity, pid: child.pid, result, terminate: () => stop('ABORTED') });
      } catch {
        stop('IDENTITY_FAILED'); await result;
        reject(new DomainError('IDENTITY_FAILED', 'Background process identity could not be recorded'));
      }
    });
    ceiling = timers.schedule(() => stop('CEILING_LIMIT'), policy.ceilingMs); activity();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Stateless mode routing uses durable attempt lookup, never in-memory absence
 * as proof of a stopped worker. Provider identity and result protocols belong to
 * the injected drivers; interactive resume preserves the recorded conversation.
 */
export class AgentRuntime {
  /** @param {{ interactive: import('../types.d.ts').InteractiveAgentPort; background: import('../types.d.ts').AgentPort; locate: (key: { operationId?: string; identity?: string }) => import('../types.d.ts').Mode | null }} options */
  constructor({ interactive, background, locate }) {
    this.interactive = interactive; this.background = background; this.locate = locate;
    this.capabilities = [...interactive.capabilities.filter((entry) => entry.mode === 'interactive' && entry.role === 'planner'), ...background.capabilities.filter((entry) => entry.mode === 'background' && entry.role !== 'planner')];
  }
  /** @param {import('../types.d.ts').LaunchRequest} request */
  async launch(request) {
    requireCapability(this, request.attempt.role, request.attempt.mode);
    return this[request.attempt.mode].launch(request);
  }
  /** @param {import('../types.d.ts').LaunchRequest} request */
  async resume(request) {
    requireValue(request.attempt.role === 'planner' && request.attempt.mode === 'interactive' && request.attempt.identity, 'Only an owned interactive planner can resume', 'NOT_READY');
    requireCapability(this, 'planner', 'interactive');
    return this.interactive.resume(request);
  }
  /** @param {string} operationId */
  async observe(operationId) {
    const mode = this.locate({ operationId });
    if (!mode) return { status: /** @type {const} */ ('unknown'), identity: null };
    return this[mode].observe(operationId);
  }
  /** @param {string} operationId */
  async open(operationId) {
    requireValue(this.locate({ operationId }) === 'interactive' && this.interactive.open, 'Owned native terminal is unavailable', 'UNSUPPORTED_CAPABILITY');
    await this.interactive.open(operationId);
  }
  /** @param {string} identity */
  async terminate(identity) {
    const mode = this.locate({ identity });
    requireValue(mode, 'Worker identity is not recorded', 'OWNERSHIP_UNCERTAIN');
    return this[mode].terminate(identity);
  }
}
