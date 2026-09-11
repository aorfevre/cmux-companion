// Agent-side transport only. This executable has no workflow storage imports.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

/** @param {{ endpoint: string; credential: string }} options */
export function createBridge({ endpoint, credential }) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Bridge requires an authenticated loopback endpoint');
  return {
    /** @param {unknown} command */
    async submit(command) {
      const response = await fetch(new URL('/api/orchestration/agent/commands', url), { method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(15000) });
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error(body.error || 'Agent command rejected'), { code: body.code || 'REQUEST_FAILED' });
      return body;
    },
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  // Configuration contains the scoped credential, supplied through a private file.
  // argv carries only its path; logs/errors never print the secret or command body.
  const configPath = process.env.CMUX_ORCHESTRATION_BRIDGE_CONFIG;
  if (!configPath) throw new Error('Missing private bridge configuration');
  const bridge = createBridge(JSON.parse(readFileSync(configPath, 'utf8')));
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    try {
      if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error('Bridge command exceeds limit');
      const result = await bridge.submit(JSON.parse(line));
      process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    } catch (cause) {
      const error = /** @type {{code?: string}} */ (cause);
      process.stdout.write(`${JSON.stringify({ ok: false, code: error.code || 'REQUEST_FAILED' })}\n`);
    }
  }
}
