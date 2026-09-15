import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireValue } from '../domain/contracts.mjs';

const worker = fileURLToPath(new URL('./native-worker.mjs', import.meta.url));
/** A visible terminal hosts the existing bounded supervisor. The supervisor
 * keeps its own process group, durable receipts and deadlines; closing this
 * terminal asks it to stop rather than orphaning hidden execution.
 * @param {string} configPath */
export async function runManagedTerminal(configPath) {
  requireValue(isAbsolute(configPath) && lstatSync(configPath).isFile() && !lstatSync(configPath).isSymbolicLink() && lstatSync(configPath).size <= 2 * 1024 * 1024, 'Invalid managed terminal configuration');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  requireValue(config.terminalOutput === true && typeof config.identity === 'string', 'Managed terminal identity is unavailable');
  writeFileSync(join(dirname(configPath), 'terminal-started.json'), JSON.stringify({ identity: config.identity }), { flag: 'wx', mode: 0o600 });
  const child = spawn(process.execPath, [worker, configPath], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: { PATH: process.env.PATH } });
  const stop = () => { if (child.pid) { try { process.kill(child.pid, 'SIGTERM'); } catch { /* The durable supervisor receipt establishes termination. */ } } };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop);
  try { const [code] = await once(child, 'exit'); return typeof code === 'number' ? code : 1; }
  finally { for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.off(signal, stop); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { process.exitCode = await runManagedTerminal(process.argv[2]); }
  catch { process.exitCode = 2; }
}
