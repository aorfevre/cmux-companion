import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, realpathSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootIdentity, processBirth } from './process-evidence.mjs';
import { requireValue } from '../domain/contracts.mjs';

/** @type {AsyncLocalStorage<{directory:string;run:string}>} */
const scope = new AsyncLocalStorage();
const write = (/** @type {string} */ path, /** @type {unknown} */ value) => writeFileSync(path, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
function read(/** @type {string} */ path) {
  requireValue(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Git process evidence changed', 'OWNERSHIP_UNCERTAIN');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function exists(/** @type {string} */ path) {
  try { lstatSync(path); return true; } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return false; throw error; }
}
function directory(/** @type {string} */ path) {
  requireValue(realpathSync(path) === path && lstatSync(path).isDirectory(), 'Git process directory changed', 'OWNERSHIP_UNCERTAIN');
}
function gone(/** @type {number} */ pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return /** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH'; }
}
function rebooted(/** @type {unknown} */ boot, /** @type {string|null} */ current) { return typeof boot === 'string' && /^[a-f0-9]{64}$/.test(boot) && current !== null && boot !== current; }

/** No timer or absent applied ref is stopped proof. A live scope may launch its
 * next command, and a dead service may leave a detached Git transaction behind.
 * @param {string} path */
export function gitScopeStopped(path) {
  try {
    if (!exists(path)) return true;
    directory(path); const boot = bootIdentity();
    for (const name of readdirSync(path)) {
      requireValue(/^run-[a-f0-9-]{36}$/.test(name), 'Unrecognized Git process evidence');
      const run = join(path, name); directory(run); const owner = read(join(run, 'run.json'));
      requireValue(owner.schemaVersion === 1 && Number.isSafeInteger(owner.pid) && owner.pid > 0, 'Invalid Git owner evidence');
      if (rebooted(owner.boot, boot)) continue;
      if (!exists(join(run, 'finished.json')) && scope.getStore()?.run !== run) {
        const birth = processBirth(owner.pid);
        if (!gone(owner.pid) && !(typeof owner.birth === 'string' && birth !== null && owner.birth !== birth)) return false;
      } else if (exists(join(run, 'finished.json'))) requireValue(read(join(run, 'finished.json')).finished === true, 'Invalid Git scope completion');
      for (const command of readdirSync(run)) {
        if (['run.json', 'finished.json'].includes(command)) continue;
        requireValue(/^command-[a-f0-9-]{36}$/.test(command), 'Unrecognized Git command evidence');
        const path = join(run, command); directory(path); const started = read(join(path, 'started.json'));
        requireValue(started.schemaVersion === 1, 'Invalid Git command evidence');
        if (rebooted(started.boot, boot)) continue;
        if (exists(join(path, 'stopped.json'))) { requireValue(read(join(path, 'stopped.json')).stopped === true, 'Invalid Git stopped evidence'); continue; }
        if (!exists(join(path, 'identity.json'))) return false;
        const identity = read(join(path, 'identity.json'));
        requireValue(Number.isSafeInteger(identity.pid) && identity.pid > 0, 'Invalid Git process identity');
        if (!gone(-identity.pid)) return false;
      }
    }
    return true;
  } catch { return false; }
}

/** @template T @param {string} path @param {() => Promise<T>} operation */
export async function withGitProcessScope(path, operation) {
  requireValue(gitScopeStopped(path), 'Previous Git command may still be running', 'OWNERSHIP_UNCERTAIN');
  mkdirSync(path, { recursive: true, mode: 0o700 }); directory(path);
  const run = join(path, `run-${randomUUID()}`); mkdirSync(run, { mode: 0o700 });
  write(join(run, 'run.json'), { schemaVersion: 1, pid: process.pid, birth: processBirth(process.pid), boot: bootIdentity() });
  return scope.run({ directory: path, run }, async () => {
    try { return await operation(); } finally { write(join(run, 'finished.json'), { finished: true }); }
  });
}

/** Called before exec; a crash before PID persistence remains uncertain.
 * @returns {{identity(pid:number):void; complete(pid:number|undefined,neverSpawned:boolean):boolean}|null} */
export function trackGitCommand() {
  const context = scope.getStore(); if (!context) return null;
  requireValue(gitScopeStopped(context.directory), 'Previous Git command is not stopped', 'OWNERSHIP_UNCERTAIN');
  directory(context.directory); directory(context.run);
  const path = join(context.run, `command-${randomUUID()}`); mkdirSync(path, { mode: 0o700 });
  write(join(path, 'started.json'), { schemaVersion: 1, boot: bootIdentity() });
  return {
    identity(pid) { write(join(path, 'identity.json'), { pid, birth: processBirth(pid) }); },
    complete(pid, neverSpawned) {
      const stopped = neverSpawned || (pid !== undefined && gone(-pid));
      if (stopped) write(join(path, 'stopped.json'), { stopped: true });
      return stopped;
    },
  };
}
