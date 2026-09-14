import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, lstatSync, realpathSync, readdirSync, readFileSync, writeFileSync, renameSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { identifier, requireValue } from './domain/contracts.mjs';

/** Private, bounded result spool owned by the terminal supervisor. Only enqueue
 * runs in the MCP process; one supervisor drains it. SQLite rollback never touches
 * these files. A local queued receipt is explicitly not server acceptance. */
export class ResultOutbox {
  /** @param {{directory:string; binding:Record<string,unknown>}} options */
  constructor({ directory, binding }) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    requireValue(!lstatSync(directory).isSymbolicLink(), 'Outbox identity changed');
    this.directory = realpathSync(directory); this.binding = binding;
  }
  /** @param {string} path */
  read(path) {
    const info = lstatSync(path);
    requireValue(info.isFile() && !info.isSymbolicLink() && info.size <= 6 * 1024 * 1024, 'Invalid outbox record');
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  entries() {
    requireValue(realpathSync(this.directory) === this.directory, 'Outbox identity changed');
    const names = readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    requireValue(names.length <= 8, 'Outbox capacity exceeded');
    return names.map(name => ({ path: join(this.directory, name), value: this.read(join(this.directory, name)) }));
  }
  /** @param {{id:string;raw:string}} input */
  enqueue({ id, raw }) {
    identifier(id); requireValue(typeof raw === 'string' && Buffer.byteLength(raw) <= 2 * 1024 * 1024, 'Result exceeds outbox limit');
    const parsed = JSON.parse(raw);
    requireValue(Object.entries(this.binding).every(([key, value]) => parsed[key] === value), 'Outbox result binding changed', 'FORBIDDEN');
    const path = join(this.directory, `${createHash('sha256').update(id).digest('hex')}.json`);
    if (existsSync(path)) {
      const saved = this.read(path); requireValue(saved.id === id && saved.raw === raw, 'Outbox result id was reused', 'IDEMPOTENCY_CONFLICT');
      return { id, status: saved.status, code: saved.code ?? null };
    }
    requireValue(this.entries().length < 8, 'Outbox capacity exceeded');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ id, raw, status: 'queued' }), { mode: 0o600, flag: 'wx', flush: true });
      // Atomic no-replace publication: a partial write is never a final record.
      try { linkSync(temporary, path); }
      catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
        const saved = this.read(path); requireValue(saved.id === id && saved.raw === raw, 'Outbox result id was reused', 'IDEMPOTENCY_CONFLICT');
      }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return { id, status: 'queued', code: null };
  }
  /** @param {{submitResult(input:{id:string;raw:string}):Promise<unknown>}} bridge */
  async drain(bridge) {
    for (const { path, value } of this.entries()) {
      if (value.status !== 'queued') continue;
      let receipt;
      try {
        receipt = /** @type {{id?:string;status?:string;code?:string|null}} */ (await bridge.submitResult({ id: value.id, raw: value.raw }));
        if (receipt.id !== value.id || !['accepted', 'rejected'].includes(receipt.status ?? '')) continue;
      } catch (error) {
        const code = /** @type {{code?:string}} */ (error).code;
        if (!['FORBIDDEN', 'UNAUTHORIZED', 'IDEMPOTENCY_CONFLICT', 'MALFORMED_RESULT'].includes(code ?? '')) continue;
        receipt = { id: value.id, status: 'rejected', code };
      }
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ ...value, status: receipt.status, code: receipt.code ?? null }), { mode: 0o600, flag: 'wx', flush: true });
      renameSync(temporary, path);
    }
  }
}
