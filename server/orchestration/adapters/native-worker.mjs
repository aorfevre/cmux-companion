import { prepareCcsLaunch } from './ccs-managed-launcher.mjs';
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DomainError, requireValue } from '../domain/contracts.mjs';
import { startBackgroundProcess, backgroundPolicy } from './agent-runtime.mjs';
import { assertNativeInstallation } from './native-capabilities.mjs';
import { awaitNativeActivation } from './native-activation.mjs';
import { nativeProcessStamp } from './native-process.mjs';

/** Independent watchdog process. It owns the provider's process group, buffers
 * and execution deadlines even when the HTTP/scheduler service is SIGKILLed.
 * It writes private adapter receipts only, never orchestration database state.
 * @param {string} configPath */
export async function runNativeWorker(configPath) {
  const directory = dirname(configPath);
  requireValue(realpathSync(directory) === directory && !lstatSync(configPath).isSymbolicLink() && lstatSync(configPath).size <= 2 * 1024 * 1024, 'Invalid native worker configuration');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'));
  requireValue(config.identity === request.identity && request.binding.operationId === directory.split('/').at(-1) && config.command.cwd === request.binding.worktree, 'Native worker binding changed');
  backgroundPolicy(config.policy);
  requireValue(config.policy.maxOutputBytes <= 2 * 1024 * 1024, 'Native output budget exceeds transport limit');
  // A duplicated supervisor cannot spawn a second provider for this operation.
  writeFileSync(join(directory, 'supervisor-started.json'), JSON.stringify({ identity: config.identity }), { mode: 0o600, flag: 'wx' });
  const save = (/** @type {string} */ name, /** @type {unknown} */ value) => {
    const path = join(directory, name), temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path);
  };
  // A closed terminal display must not crash the independent watchdog.
  if (config.terminalOutput) { process.stdout.on('error', () => {}); process.stderr.on('error', () => {}); }
  const controller = new AbortController(), stop = () => controller.abort();
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  let sent = false;
  try {
    save('identity.json', { identity: config.identity, pid: process.pid, stamp: await nativeProcessStamp(process.pid, directory) });
    if (config.activation) await awaitNativeActivation(config.activation, controller.signal);
    if (config.installation) {
      assertNativeInstallation(config.installation);
      requireValue(config.command.bin === config.installation.bin && config.command.env[config.installation.provider === 'codex' ? 'CCS_CODEX_PATH' : 'CCS_CLAUDE_PATH'] === config.installation.nativeBin, 'Native executable binding changed', 'UNSUPPORTED_CAPABILITY');
    }
    if (controller.signal.aborted) {
      save('outcome.json', { identity: config.identity, outcome: { status: 'failed', workerState: 'stopped', cause: { code: 'ABORTED', exitCode: null, signal: null }, stdout: '', stderr: '' } }); return;
    }
    const command = prepareCcsLaunch(config.command, config.installation, directory, 'initial');
    writeFileSync(join(directory, 'provider-sent.json'), JSON.stringify({ identity: config.identity }), { mode: 0o600, flag: 'wx' }); sent = true;
    const handle = await startBackgroundProcess(command, {
      policy: config.policy, signal: controller.signal, identity: () => config.identity,
      ...(config.terminalOutput ? { onOutput: (stream, chunk) => { process[stream].write(chunk); } } : {}),
      onIdentity: async ({ pid }) => { save('provider.json', { identity: config.identity, pid, stamp: await nativeProcessStamp(pid, directory) }); },
    });
    save('outcome.json', { identity: config.identity, outcome: await handle.result });
  } catch (error) {
    save('outcome.json', { identity: config.identity, outcome: { status: 'failed', workerState: sent ? 'unknown' : 'stopped', cause: { code: error instanceof DomainError ? error.code : 'NATIVE_WORKER_FAILED', exitCode: null, signal: null }, stdout: '', stderr: '' } });
  } finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await runNativeWorker(process.argv[2]); }
  catch { process.exitCode = 2; }
}
