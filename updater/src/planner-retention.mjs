import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

async function record(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 6 * 1024 * 1024) throw new Error('Unverifiable planner receipt');
  return JSON.parse(await readFile(path, 'utf8'));
}
/** Durable dependency pins cover JS/hooks/resume files that lsof cwd/txt misses.
 * Unknown evidence conservatively prevents cleanup. Never signal or modify a
 * planner, and never remove an outbox to make a release eligible. */
export async function plannerReleasePinned(releaseRoot, release) {
  const directory = join(releaseRoot, 'planner-pins');
  let info;
  try { info = await lstat(directory); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) return true;
  try {
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json')) return true;
      const pin = await record(join(directory, name));
      if (pin.version !== 1 || typeof pin.release !== 'string' || typeof pin.directory !== 'string' || !isAbsolute(pin.directory)) return true;
      if (pin.release !== release) continue;
      const owner = await lstat(pin.directory);
      if (!owner.isDirectory() || owner.isSymbolicLink() || await realpath(pin.directory) !== pin.directory) return true;
      const outcome = await record(join(pin.directory, 'outcome.json'));
      if (outcome.identity !== pin.identity || outcome.workerState !== 'stopped') return true;
      const outbox = join(pin.directory, 'outbox'), outboxInfo = await lstat(outbox);
      if (!outboxInfo.isDirectory() || outboxInfo.isSymbolicLink()) return true;
      for (const entry of await readdir(outbox)) {
        if (/^[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/.test(entry)) continue;
        if (!/^[a-f0-9]{64}\.json$/.test(entry)) return true;
        if (!['accepted', 'rejected'].includes((await record(join(outbox, entry))).status)) return true;
      }
    }
    return false;
  } catch { return true; }
}
