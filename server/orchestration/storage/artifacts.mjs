import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, readFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { requireValue } from '../domain/contracts.mjs';

export class ArtifactStore {
  /** @param {{ directory: string; maxBytes?: number }} options */
  constructor({ directory, maxBytes = 2 * 1024 * 1024 }) {
    requireValue(typeof directory === 'string' && directory.length > 0, 'Explicit artifact directory required');
    this.directory = resolve(directory); this.maxBytes = maxBytes;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  /** Persist bytes first; only then may the caller commit an artifact reference.
   * @param {string | Buffer} value
   */
  put(value) {
    const bytes = Buffer.from(value);
    requireValue(bytes.byteLength <= this.maxBytes, 'Artifact too large');
    const id = createHash('sha256').update(bytes).digest('hex');
    const temp = join(this.directory, `.pending-${randomUUID()}`);
    try { writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' }); renameSync(temp, this.path(id)); }
    catch (error) {
      try { unlinkSync(temp); } catch { /* preserve the write error; an orphan is not a referenced artifact */ }
      throw error;
    }
    return { id, bytes: bytes.byteLength };
  }
  /** @param {string} id */
  path(id) { requireValue(/^[a-f0-9]{64}$/.test(id), 'Invalid artifact identity'); return join(this.directory, id); }
  /** @param {string} id */
  get(id) {
    const bytes = readFileSync(this.path(id));
    requireValue(bytes.byteLength <= this.maxBytes && createHash('sha256').update(bytes).digest('hex') === id, 'Artifact integrity check failed');
    return bytes;
  }
  /** Run under exclusive service ownership; retain every active/historical reference.
   * @param {Set<string>} references @param {number} olderThanMs
   */
  pruneUnreferenced(references, olderThanMs) {
    const removed = [];
    for (const name of readdirSync(this.directory)) {
      if (!/^[a-f0-9]{64}$/.test(name) || references.has(name)) continue;
      const path = this.path(name);
      if (statSync(path).mtimeMs >= olderThanMs) continue;
      unlinkSync(path); removed.push(name);
    }
    return removed;
  }
}
