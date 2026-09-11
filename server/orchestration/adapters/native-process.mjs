import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requireValue } from '../domain/contracts.mjs';

const execute = promisify(execFile);
/** PID alone never authorizes termination after restart. Pin the process birth
 * and full command line; any exec/title change becomes explicit uncertainty.
 * The command line stays private and is persisted only as a digest.
 * @param {number} pid @param {string} marker */
export async function nativeProcessStamp(pid, marker) {
  requireValue(Number.isSafeInteger(pid) && pid > 0, 'Invalid native PID');
  try {
    const { stdout } = await execute('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 5000, maxBuffer: 65536 });
    return stdout.trim() && stdout.includes(marker) ? createHash('sha256').update(stdout.trim()).digest('hex') : null;
  } catch { return null; }
}
/** @param {number} pid */
export function nativeGroupState(pid) {
  try { process.kill(-pid, 0); return 'alive'; }
  catch (error) { return /** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH' ? 'dead' : 'unknown'; }
}
