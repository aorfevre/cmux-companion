import { lstat, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { homedir, hostname } from 'node:os';
import { contains } from './dev-repositories.mjs';

const excluded = name => name.startsWith('.') || ['Library', 'node_modules', 'dist', 'build', 'coverage', 'worktrees'].includes(name);
const controls = value => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const invalid = message => { throw new TypeError(message); };

// Directory metadata only. Browsing never adds a repository to an allow-list.
export async function browseFolders(input = {}, { home = homedir(), roots = [], name = hostname(), entryLimit = 1000, deadlineMs = 5000, now = Date.now } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['path', 'filter'].includes(key))) invalid('Choose a folder in the explorer');
  const filter = input.filter ?? '';
  if (typeof filter !== 'string' || filter.length > 160 || controls(filter)) invalid('Use a short folder name to filter');
  const homeRoot = await realpath(home);
  const allowed = [{ name: 'Home', path: homeRoot }, ...roots.map(root => ({ name: root.name, path: root.path }))];
  const path = input.path ?? homeRoot;
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || controls(path) || path.split(sep).includes('..')) invalid('Choose a folder inside Home or a saved Dev repo');
  const root = allowed.filter(root => contains(root.path, path)).sort((a, b) => a.path.length - b.path.length)[0];
  if (!root) invalid('Choose a folder inside Home or a saved Dev repo');
  const parts = relative(root.path, path).split(sep).filter(Boolean);
  if (parts.some(excluded)) invalid('This folder is not available in the explorer');
  try {
    // Check every component, including the configured boundary, on every request.
    let current = root.path;
    for (const part of ['', ...parts]) {
      if (part) current = join(current, part);
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) invalid('Folder moved or is a symbolic link. Choose it again.');
    }
    const started = now(), folders = []; let examined = 0, partial = false, expired = false, timer;
    const enumerate = async () => {
      const directory = await opendir(path);
      for await (const entry of directory) {
        if (expired || examined >= entryLimit || now() - started >= deadlineMs) { partial = true; break; }
        examined++;
        if (!entry.isDirectory() || entry.isSymbolicLink() || excluded(entry.name) || controls(entry.name) || !entry.name.toLowerCase().includes(filter.toLowerCase())) continue;
        folders.push({ name: entry.name, path: join(path, entry.name) });
      }
    };
    try {
      await Promise.race([enumerate(), new Promise(resolve => { timer = setTimeout(() => { expired = true; partial = true; resolve(); }, deadlineMs); })]);
    } finally { clearTimeout(timer); }
    const breadcrumbs = [{ name: root.name, path: root.path }];
    for (const part of parts) breadcrumbs.push({ name: part, path: join(breadcrumbs.at(-1).path, part) });
    return { macName: name, path, name: basename(path), parent: path === root.path ? null : dirname(path), roots: allowed, breadcrumbs, folders: folders.sort((a, b) => a.name.localeCompare(b.name)), partial, examined };
  } catch (error) {
    if (['EACCES', 'EPERM'].includes(error.code)) invalid('Companion cannot open this folder. Choose another folder or allow access on the Mac, then retry.');
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) invalid('This folder is unavailable. Go back and choose another folder.');
    throw error;
  }
}
