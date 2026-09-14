import { prepareCcsLaunch } from './ccs-managed-launcher.mjs';
import { ResultOutbox } from '../result-outbox.mjs';
import { createBridge } from '../bridge.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstatSync, readFileSync, writeFileSync, renameSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError, requireValue } from '../domain/contracts.mjs';
import { awaitNativeActivation } from './native-activation.mjs';
import { assertNativeInstallation } from './native-capabilities.mjs';
import { nativeProcessStamp, nativeGroupState } from './native-process.mjs';

/** A terminal-owned supervisor. Native I/O is inherited and user/permission waits
 * have no ceiling or idle timer. Only explicit termination has a cleanup deadline.
 * A paused conversation retains its original operation and native conversation.
 * @param {string} configPath */
export async function runNativeTerminal(configPath) {
  const directory = dirname(configPath);
  requireValue(realpathSync(directory) === directory && lstatSync(configPath).isFile() && !lstatSync(configPath).isSymbolicLink() && lstatSync(configPath).size <= 2 * 1024 * 1024, 'Invalid terminal configuration');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'));
  requireValue(config.identity === request.identity && request.binding.operationId === directory.split('/').at(-1)
    && request.binding.role === 'planner' && request.binding.mode === 'interactive' && config.command.cwd === request.binding.worktree
    && Number.isSafeInteger(config.killGraceMs) && config.killGraceMs > 0 && config.killGraceMs <= 30000, 'Terminal binding changed');
  writeFileSync(join(directory, 'runner-started.json'), JSON.stringify({ identity: config.identity }), { flag: 'wx', mode: 0o600 });
  const save = (/** @type {string} */ name, /** @type {unknown} */ value) => {
    const target = join(directory, name), temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temporary, target);
  };
  const controller = new AbortController();
  /** @type {number | null} */ let providerPid = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */ let force;
  let providerSent = false, providerStopped = true;
  const signalProvider = (/** @type {NodeJS.Signals} */ signal) => { if (providerPid) { try { process.kill(-providerPid, signal); } catch { /* observation, never signal success, establishes stopped proof */ } } };
  const stop = () => {
    if (controller.signal.aborted) return;
    controller.abort(); signalProvider('SIGTERM');
    force = setTimeout(() => signalProvider('SIGKILL'), config.killGraceMs);
  };
  // The provider has a separate owned process group but inherits this terminal.
  // Forward terminal interruption without treating the native permission UI as dead.
  const interrupt = () => signalProvider('SIGINT');
  process.on('SIGTERM', stop); process.on('SIGHUP', stop); process.on('SIGINT', interrupt);
  let code = 'ABORTED';
  /** @type {ReturnType<typeof setInterval> | undefined} */ let outboxTimer;
  /** @type {Promise<void> | null} */ let draining = null;
  try {
    save('identity.json', { identity: config.identity, pid: process.pid, stamp: await nativeProcessStamp(process.pid, directory), workspaceId: config.workspaceId });
    const bridgeConfig = JSON.parse(readFileSync(join(directory, 'bridge.json'), 'utf8'));
    requireValue(config.handoffProtocol === 1 && bridgeConfig.handoffProtocol === 1, 'Terminal handoff protocol is unavailable');
    const outbox = new ResultOutbox({ directory: join(directory, 'outbox'), binding: bridgeConfig.binding });
    const bridge = createBridge({ ...bridgeConfig, timeoutMs: 1000 });
    save('handoff.json', { version: 1, identity: config.identity });
    const drain = () => { if (!draining) draining = outbox.drain(bridge).catch(() => {}).finally(() => { draining = null; }); };
    outboxTimer = setInterval(drain, 500); drain();
    await awaitNativeActivation(config.activation, controller.signal);
    let runId = 'initial';
    while (!controller.signal.aborted) {
      if (config.installation) {
        assertNativeInstallation(config.installation);
        requireValue(config.command.bin === config.installation.bin && config.command.env[config.installation.provider === 'codex' ? 'CCS_CODEX_PATH' : 'CCS_CLAUDE_PATH'] === config.installation.nativeBin, 'Terminal executable binding changed', 'UNSUPPORTED_CAPABILITY');
      }
      const argv = [...config.command.argv];
      if (runId !== 'initial') {
        if (config.installation?.provider === 'codex') {
          const session = JSON.parse(readFileSync(join(directory, 'codex-session.json'), 'utf8'));
          requireValue(session.conversationId === request.binding.conversationId && /^[A-Za-z0-9_-]{1,160}$/.test(session.sessionId), 'Codex session identity changed');
          const prompt = argv.pop();
          requireValue(typeof prompt === 'string', 'Codex resume context is missing');
          argv.push('resume', session.sessionId, prompt);
        } else {
        const index = argv.indexOf('--session-id');
        requireValue(index >= 0 && argv[index + 1] === request.binding.conversationId && !argv.includes('--print'), 'Invalid native resume contract');
        argv[index] = '--resume';
        }
      }
      // Resume is a durable idempotent command, not a new attempt or conversation.
      writeFileSync(join(directory, `run-${runId}.json`), JSON.stringify({ identity: config.identity }), { flag: 'wx', mode: 0o600 });
      if (controller.signal.aborted) break;
      const command = prepareCcsLaunch({ ...config.command, argv }, config.installation, directory, runId);
      providerSent = true; providerStopped = false;
      save('session.json', { phase: 'starting', runId });
      const child = spawn(command.bin, command.argv, { cwd: command.cwd, env: command.env, stdio: 'inherit', detached: true });
      const exited = once(child, 'exit'); void exited.catch(() => {});
      try { await once(child, 'spawn'); } catch (error) { providerStopped = !child.pid; throw error; }
      providerPid = child.pid ?? null;
      save('provider.json', { identity: config.identity, runId, pid: providerPid });
      save('session.json', { phase: 'running', runId });
      if (controller.signal.aborted) signalProvider('SIGTERM');
      const [exitCode, exitSignal] = await exited;
      const deadline = Date.now() + config.killGraceMs * 2;
      while (providerPid && nativeGroupState(providerPid) !== 'dead' && Date.now() < deadline) await delay(20);
      providerStopped = providerPid !== null && nativeGroupState(providerPid) === 'dead';
      requireValue(providerStopped, 'Terminal provider descendants remain uncertain', 'OWNERSHIP_UNCERTAIN');
      providerPid = null;
      if (controller.signal.aborted) break;
      save('session.json', { phase: 'paused', runId, exitCode, signal: exitSignal });
      process.stdout.write('\nConversation paused. Resume it from Companion to continue.\n');
      while (!controller.signal.aborted) {
        const path = join(directory, 'resume.json');
        if (existsSync(path)) {
          requireValue(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() && lstatSync(path).size <= 2048, 'Invalid resume receipt');
          const resumed = JSON.parse(readFileSync(path, 'utf8'));
          requireValue(resumed.identity === config.identity && /^[a-zA-Z0-9_-]{1,128}$/.test(resumed.id), 'Resume binding changed');
          if (!existsSync(join(directory, `run-${resumed.id}.json`))) { runId = resumed.id; await awaitNativeActivation(config.activation, controller.signal); break; }
        }
        await delay(50, undefined, { signal: controller.signal }).catch(() => {});
      }
    }
  } catch (error) { code = error instanceof DomainError ? error.code : 'NATIVE_TERMINAL_FAILED'; }
  finally {
    if (outboxTimer) clearInterval(outboxTimer);
    await draining;
    if (force) clearTimeout(force);
    if (!providerStopped && providerPid) {
      signalProvider('SIGTERM'); await delay(config.killGraceMs); signalProvider('SIGKILL'); await delay(config.killGraceMs);
      providerStopped = nativeGroupState(providerPid) === 'dead';
    }
    save('outcome.json', { identity: config.identity, workerState: !providerSent || providerStopped ? 'stopped' : 'unknown', code });
    process.off('SIGTERM', stop); process.off('SIGHUP', stop); process.off('SIGINT', interrupt);
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await runNativeTerminal(process.argv[2]); } catch { process.exitCode = 2; }
}
