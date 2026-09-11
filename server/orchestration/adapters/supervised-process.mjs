import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireValue } from '../domain/contracts.mjs';
import { pathExists } from './git.mjs';
import { bootIdentity } from './process-evidence.mjs';
import { nativeGroupState, nativeProcessStamp } from './native-process.mjs';
const WORKER = fileURLToPath(new URL('./native-worker.mjs', import.meta.url));
const pause = () => new Promise((resolve) => setTimeout(resolve, 1000));
/** @param {'stopped'|'unknown'} workerState @param {string} [code] @returns {import('../types.d.ts').ProcessOutcome} */
const unavailable = (workerState, code = 'OWNERSHIP_UNCERTAIN') => ({ status: 'failed', workerState, cause: { code, exitCode: null, signal: null }, stdout: '', stderr: '' });
/** @param {string} path */
function read(path) {
  const stat = lstatSync(path);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024 * 1024, 'Supervisor evidence changed', 'OWNERSHIP_UNCERTAIN');
  return JSON.parse(readFileSync(path, 'utf8'));
}
/** Read-only durable outcome. Null means the independent watchdog still owns the
 * check. Dead groups alone do not prove escaped descendants have terminated.
 * @param {string} directory @param {()=>string|null} [boot]
 * @returns {Promise<import('../types.d.ts').ProcessOutcome|null>} */
export async function observeSupervisedProcess(directory, boot = bootIdentity) {
  if (!pathExists(directory)) return unavailable('unknown');
  requireValue(realpathSync(directory) === directory && !lstatSync(directory).isSymbolicLink(), 'Supervisor directory changed', 'OWNERSHIP_UNCERTAIN');
  const requestPath = join(directory, 'request.json');
  if (!pathExists(requestPath)) return unavailable('unknown');
  const request = read(requestPath), currentBoot = boot();
  const priorBoot = request.bootId && currentBoot && request.bootId !== currentBoot;
  const outcomePath = join(directory, 'outcome.json');
  if (pathExists(outcomePath)) {
    const result = read(outcomePath);
    requireValue(result.identity === request.identity && ['stopped', 'unknown'].includes(result.outcome?.workerState), 'Supervisor outcome changed', 'OWNERSHIP_UNCERTAIN');
    return priorBoot ? { ...result.outcome, workerState: 'stopped' } : result.outcome;
  }
  if (priorBoot) return unavailable('stopped');
  if (request.spawnClaim === true && !pathExists(join(directory, 'sent.json'))) return unavailable('stopped', 'NOT_STARTED');
  const identityPath = join(directory, 'identity.json');
  if (!pathExists(identityPath)) return Date.now() - request.startedAt < 10000 ? null : unavailable('unknown');
  const worker = read(identityPath);
  requireValue(worker.identity === request.identity && Number.isSafeInteger(worker.pid) && worker.pid > 0, 'Supervisor identity changed', 'OWNERSHIP_UNCERTAIN');
  if (nativeGroupState(worker.pid) === 'dead') return unavailable('unknown');
  return worker.stamp && await nativeProcessStamp(worker.pid, directory) === worker.stamp ? null : unavailable('unknown');
}
/** The independent native watchdog also supervises approved verification argv;
 * no provider installation or bridge credentials are needed for repository checks.
 * @param {{bin:string;argv:string[];cwd:string;env:NodeJS.ProcessEnv}} command
 * @param {{directory:string;policy:import('../types.d.ts').BackgroundPolicy;signal?:AbortSignal;onIdentity:()=>void;boot?:()=>string|null;failpoint?:(point:string)=>void}} options */
export async function runSupervisedProcess(command, { directory, policy, signal, onIdentity, boot = bootIdentity, failpoint = () => {} }) {
  if (signal?.aborted) return unavailable('stopped', 'ABORTED');
  mkdirSync(directory, { mode: 0o700 });
  const identity = `verification:${randomUUID()}`, startedAt = Date.now();
  const save = (/** @type {string} */ name, /** @type {unknown} */ value) => writeFileSync(join(directory, name), JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  save('request.json', { identity, startedAt, bootId: boot(), spawnClaim: true, binding: { operationId: directory.split('/').at(-1), worktree: command.cwd } });
  save('worker.json', { identity, startedAt, command, policy });
  failpoint('prepared');
  save('sent.json', { identity }); failpoint('sent');
  const child = spawn(process.execPath, [WORKER, join(directory, 'worker.json')], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH } });
  try { await once(child, 'spawn'); }
  catch { const outcome = unavailable('stopped', 'SPAWN_FAILED'); save('outcome.json', { identity, outcome }); return outcome; }
  child.unref();
  let notified = false, signalled = false;
  const deadline = startedAt + policy.ceilingMs + policy.killGraceMs * 2 + 10000;
  while (Date.now() <= deadline) {
    const identityPath = join(directory, 'identity.json');
    if (pathExists(identityPath)) {
      if (!notified) { notified = true; onIdentity(); }
      if (signal?.aborted && !signalled) {
        const worker = read(identityPath);
        if (worker.identity === identity && worker.stamp && await nativeProcessStamp(worker.pid, directory) === worker.stamp) {
          try { process.kill(worker.pid, 'SIGTERM'); signalled = true; }
          catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') throw error; }
        }
      }
    }
    const outcome = await observeSupervisedProcess(directory, boot);
    if (outcome) return outcome;
    await pause();
  }
  return unavailable('unknown');
}
