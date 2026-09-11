import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const digest = (/** @type {string} */ value) => createHash('sha256').update(value).digest('hex');
/** Kernel boot identity is stopped proof for all processes from an earlier boot,
 * including descendants that escaped their original process group. Missing or
 * unreadable evidence never authorizes recovery. */
export function bootIdentity() {
  try {
    if (process.platform === 'linux') {
      const value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return /^[a-f0-9-]{36}$/.test(value) ? digest(value) : null;
    }
    if (process.platform === 'darwin') {
      const value = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      const match = value.match(/sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/);
      return match ? digest(`${match[1]}:${match[2]}`) : null;
    }
  } catch { /* Uncertain kernel evidence is not a takeover permission. */ }
  return null;
}
/** Birth identity excludes command/title, which a live owner may change.
 * @param {number} pid */
export function processBirth(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const value = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const start = value.slice(value.lastIndexOf(')') + 2).split(' ')[19];
      return /^\d+$/.test(start) ? digest(start) : null;
    }
    if (process.platform === 'darwin') {
      const value = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 2000, maxBuffer: 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return value ? digest(value) : null;
    }
  } catch { /* Absence must be established separately by kernel liveness. */ }
  return null;
}
