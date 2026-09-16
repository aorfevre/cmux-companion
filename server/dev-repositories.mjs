import { lstat, opendir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

export function macPath(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new TypeError('Enter a directory on this Mac');
  const path = value.trim().startsWith('~/') ? join(homedir(), value.trim().slice(2)) : value.trim();
  if (!isAbsolute(path)) throw new TypeError('Enter an absolute directory or ~/ on this Mac');
  return path;
}
export function contains(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
export async function inspectDevRepo(value, run = execute) {
  const path = await realpath(macPath(value)).catch(() => { throw new TypeError('Dev repo directory is unavailable on this Mac'); });
  if (!(await lstat(path)).isDirectory()) throw new TypeError('Dev repo must be a directory');
  let inside = false;
  try { inside = (await run('git', ['-C', path, 'rev-parse', '--is-inside-work-tree'], { timeout: 5000, maxBuffer: 32768 })).stdout.trim() === 'true'; } catch { /* A collection is not a Git checkout. */ }
  if (inside) throw new TypeError('Choose a folder containing repositories, or use Add individual repository for a Git root');
  return { path };
}
export async function assertDevChild(root, path) {
  const [canonicalRoot, canonical, info, git] = await Promise.all([realpath(root), realpath(path), lstat(path), lstat(join(path, '.git'))]);
  if (canonicalRoot !== root || canonical !== path || info.isSymbolicLink() || dirname(canonical) !== root || !git.isDirectory() || git.isSymbolicLink()) throw new TypeError('Repository must be a direct Git directory inside its Dev repo; linked worktrees and symlinks are excluded');
}
export async function suggestedChecks(path) {
  try {
    const file = join(path, 'package.json'), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 262144) return [];
    const scripts = JSON.parse(await readFile(file, 'utf8')).scripts;
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return [];
    return Object.entries(scripts).filter(([name, script]) => /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,63}$/.test(name) && typeof script === 'string' && script.length <= 4096 && ![...script].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)).slice(0, 50)
      .map(([name, script], index) => ({ id: `script-${index + 1}`, executable: 'npm', args: ['run', name], script }));
  } catch { return []; }
}
/** Prepare detection reads lockfile names only. The command table is owned by
 * Companion; repository content never selects an executable or argument. */
const PREPARE_TABLE = [
  ['package-lock.json', { executable: 'npm', args: ['ci'] }],
  ['pnpm-lock.yaml', { executable: 'pnpm', args: ['install', '--frozen-lockfile'] }],
  ['yarn.lock', { executable: 'yarn', args: ['install', '--immutable'] }],
  ['bun.lockb', { executable: 'bun', args: ['install', '--frozen-lockfile'] }],
  ['bun.lock', { executable: 'bun', args: ['install', '--frozen-lockfile'] }],
];
export async function detectPrepare(path) {
  for (const [name, command] of PREPARE_TABLE) {
    try {
      const info = await lstat(join(path, name));
      if (info.isFile() && !info.isSymbolicLink()) return { source: 'detected', executable: command.executable, args: [...command.args] };
    } catch { /* Try the next lockfile. */ }
  }
  return { source: 'none' };
}
export async function scanDevRepo(root, inspect, { entryLimit = 1000, deadlineMs = 30000, now = Date.now } = {}) {
  const started = now(), results = [], children = []; let partial = false, reason = null;
  if ((await inspectDevRepo(root.path)).path !== root.path) throw new TypeError('Dev repo directory moved. Restore its original location.');
  // opendir bounds enumeration memory even for unexpectedly large directories.
  for await (const entry of await opendir(root.path)) {
    if (children.length >= entryLimit || now() - started >= deadlineMs) { partial = true; reason = 'Scan limit reached. Results are partial.'; break; }
    children.push(entry);
  }
  let next = 0;
  async function worker() {
    while (next < children.length) {
      if (now() - started >= deadlineMs) { partial = true; reason = 'Scan timed out. Results are partial.'; return; }
      const entry = children[next++];
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') || ['node_modules', 'worktrees'].includes(entry.name)) continue;
      const path = join(root.path, entry.name);
      try {
        // A .git file denotes a linked checkout, not a primary repository.
        if (!(await lstat(join(path, '.git'))).isDirectory()) continue;
        await assertDevChild(root.path, path);
        const project = await inspect(path, undefined, { timeout: Math.max(1, Math.min(5000, deadlineMs - (now() - started))) });
        results.push(project);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        results.push({ path, name: entry.name, error: 'Repository could not be inspected. Check its location and access.' });
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  return { repositories: results.sort((a, b) => a.name.localeCompare(b.name)), partial, reason };
}
