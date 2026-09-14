import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pin the original executable tree before sending a terminal runner. Development
 * checkouts have no managed release retention and require no release pin.
 * @param {{directory:string;identity:string;operationId:string}} input
 * @param {string} [release] */
export function pinNativeRelease(input, release = fileURLToPath(new URL('../../../', import.meta.url))) {
  release = realpathSync(release);
  if (!/^[a-f0-9]{40}$/.test(basename(release)) || basename(dirname(release)) !== 'releases') return null;
  const directory = join(dirname(dirname(release)), 'planner-pins');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, `${input.operationId}.json`), JSON.stringify({ version: 1, ...input, release }), { mode: 0o600, flag: 'wx', flush: true });
  return release;
}
