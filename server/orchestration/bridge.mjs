// Agent-side transport only. This executable has no workflow storage imports.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** @param {{ endpoint: string; credential: string; timeoutMs?: number }} options */
export function createBridge({ endpoint, credential, timeoutMs = 15000 }) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Bridge requires an authenticated loopback endpoint');
  /** @param {string} path @param {unknown} input */
  const send = async (path, input) => {
      const response = await fetch(new URL(path, url), { method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(timeoutMs) });
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error(body.error || 'Agent command rejected'), { code: body.code || 'REQUEST_FAILED' });
      return body;
  };
  return {
    async status() {
      const response = await fetch(new URL('/api/orchestration/agent/status', url), { redirect: 'error', headers: { authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(timeoutMs) });
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error('Agent status rejected'), { code: body.code || 'REQUEST_FAILED' });
      return body;
    },
    /** @param {string} id @param {number} [offset] */
    async reference(id, offset = 0) {
      if (!/^[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid reference request');
      const response = await fetch(new URL(`/api/orchestration/agent/references/${id}?offset=${offset}`, url), { redirect: 'error', headers: { authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(timeoutMs) });
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error('Agent reference rejected'), { code: body.code || 'REQUEST_FAILED' });
      return body;
    },
    /** @param {{id: string; expectedHead: string; message: string}} input */
    commit: (input) => send('/api/orchestration/agent/commit', input),
    /** @param {unknown} command */
    submit: (command) => send('/api/orchestration/agent/commands', command),
    /** @param {{ id: string; raw: string }} result */
    submitResult: (result) => send('/api/orchestration/agent/results', result),
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  // Configuration contains the scoped credential, supplied through a private file.
  // argv carries only its path; logs/errors never print the secret or command body.
  const configPath = process.env.CMUX_ORCHESTRATION_BRIDGE_CONFIG;
  if (!configPath) throw new Error('Missing private bridge configuration');
  const bridge = createBridge(JSON.parse(readFileSync(configPath, 'utf8')));
  /** @param {Buffer | null} line */
  const handle = async (line) => {
    try {
      if (line === null) throw new Error('Bridge command exceeds limit');
      const input = JSON.parse(line.toString('utf8'));
      const result = input.type === 'submit_result' ? await bridge.submitResult({ id: input.id, raw: input.raw }) : await bridge.submit(input);
      process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    } catch (cause) {
      const error = /** @type {{code?: string}} */ (cause);
      process.stdout.write(`${JSON.stringify({ ok: false, code: error.code || 'REQUEST_FAILED' })}\n`);
    }
  };
  // Bound buffering before newline arrival; readline otherwise accumulates an
  // arbitrarily long unterminated result before its length can be checked.
  /** @type {Buffer[]} */ let pending = [];
  let bytes = 0, discarded = false;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    for (let start = 0; start < buffer.length;) {
      const newline = buffer.indexOf(10, start), end = newline < 0 ? buffer.length : newline;
      const part = buffer.subarray(start, end);
      if (!discarded) {
        bytes += part.length;
        if (bytes > 2 * 1024 * 1024) { discarded = true; pending = []; }
        else pending.push(part);
      }
      if (newline >= 0) {
        await handle(discarded ? null : Buffer.concat(pending)); pending = []; bytes = 0; discarded = false;
      }
      start = end + 1;
    }
  }
  if (bytes || discarded) await handle(discarded ? null : Buffer.concat(pending));
}
