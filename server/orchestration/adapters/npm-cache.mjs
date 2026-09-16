import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { requireValue } from '../domain/contracts.mjs';

/** One private, content-addressed npm cache shared by every verification run.
 * npm verifies cache integrity itself, so a poisoned worktree cannot poison it.
 * Pruning removes the oldest content buckets until the cache is under the cap.
 */
export class NpmCache {
  /** @param {{ directory: string }} options */
  constructor({ directory }) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = realpathSync(directory);
    requireValue(!lstatSync(this.path).isSymbolicLink(), 'npm cache directory is a symlink', 'OWNERSHIP_UNCERTAIN');
  }
  environment() { return { npm_config_cache: this.path }; }
  /** @param {string} path */
  size(path) {
    let total = 0;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) continue;
      total += entry.isDirectory() ? this.size(child) : statSync(child).size;
    }
    return total;
  }
  /** Remove the oldest content buckets until the cache is under capBytes.
   * npm re-downloads any missing blob and verifies it, so partial removal is safe.
   * @param {number} capBytes @returns {string[]} removed bucket paths */
  prune(capBytes) {
    /** @type {string[]} */ const removed = [];
    const content = join(this.path, '_cacache', 'content-v2');
    let total = this.size(this.path);
    if (total <= capBytes || !existsSync(content)) return removed;
    /** @type {{ path: string; mtimeMs: number; size: number }[]} */ const buckets = [];
    for (const algorithm of readdirSync(content, { withFileTypes: true })) {
      if (!algorithm.isDirectory()) continue;
      for (const bucket of readdirSync(join(content, algorithm.name), { withFileTypes: true })) {
        if (!bucket.isDirectory()) continue;
        const path = join(content, algorithm.name, bucket.name);
        buckets.push({ path, mtimeMs: statSync(path).mtimeMs, size: this.size(path) });
      }
    }
    buckets.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const bucket of buckets) {
      if (total <= capBytes) break;
      rmSync(bucket.path, { recursive: true, force: true }); total -= bucket.size; removed.push(bucket.path);
    }
    return removed;
  }
}
