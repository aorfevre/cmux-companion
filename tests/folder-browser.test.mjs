import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browseFolders } from '../server/folder-browser.mjs';
import { buildApp } from '../server/app.mjs';
import { LocalSettings } from '../server/local-settings.mjs';
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'folder-browser-'))); t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home'); await mkdir(home);
  for (const name of ['Developers', 'Library', '.ssh', 'node_modules', 'dist', 'build', 'coverage', 'worktrees']) await mkdir(join(home, name));
  await mkdir(join(home, 'Developers/karven'), { recursive: true }); await mkdir(join(home, 'Developers/rekord'));
  await writeFile(join(home, 'credentials.txt'), 'never return file data'); await symlink(base, join(home, 'escape'));
  return { base, home, options: { home, name: 'Fixture Mac' } };
}
test('folder explorer returns directory-only bounded metadata, breadcrumbs, saved roots and filters', async t => {
  const { base, home, options } = await fixture(t);
  const root = await browseFolders({}, options); assert.equal(root.macName, 'Fixture Mac'); assert.equal(root.parent, null); assert.deepEqual(root.folders.map(f => f.name), ['Developers']); assert.equal(root.partial, false);
  const path = join(home, 'Developers'); const result = await browseFolders({ path, filter: 'KAR' }, options);
  assert.deepEqual(result.folders, [{ name: 'karven', path: join(path, 'karven') }]); assert.equal(result.parent, home); assert.equal(result.breadcrumbs.length, 2);
  const external = join(base, 'external'); await mkdir(external); const saved = await browseFolders({ path: external }, { ...options, roots: [{ name: 'External', path: external }] }); assert.equal(saved.parent, null); assert.deepEqual(saved.folders, []);
  assert.equal((await browseFolders({}, { ...options, entryLimit: 1 })).partial, true);
  let time = 0; assert.equal((await browseFolders({}, { ...options, now: () => time += 10, deadlineMs: 1 })).partial, true);
});
test('folder explorer rejects traversal, symlinks, exclusions, missing folders and malformed requests', async t => {
  const { base, home, options } = await fixture(t);
  for (const path of [base, join(home, 'Library'), join(home, '.ssh'), join(home, 'escape'), join(home, 'escape/home'), home + '/../home', 'relative', home + '\x00']) await assert.rejects(browseFolders({ path }, options), TypeError);
  for (const input of [[], null, { command: 'ls' }, { filter: 1 }, { filter: '\n' }, { filter: 'a'.repeat(161) }, { path: 42 }]) await assert.rejects(browseFolders(input, options), TypeError);
  await assert.rejects(browseFolders({ path: join(home, 'gone') }, options), /unavailable/);
  await assert.rejects(browseFolders({ path: join(home, 'credentials.txt') }, options), /moved|symbolic/);
  const alias = join(base, 'alias'); await symlink(home, alias); await assert.rejects(browseFolders({ path: alias }, { ...options, roots: [{ name: 'alias', path: alias }] }), /symbolic/);
});
test('folder endpoint requires pairing and same origin without changing settings', async t => {
  const settings = new LocalSettings(), token = 'f'.repeat(48);
  const app = await buildApp({ token, localSettings: settings, repoCatalog: { list: async () => [] } });
  t.after(async () => { await app.close(); settings.close(); });
  const url = '/api/settings/folders', headers = { host: 'localhost', origin: 'http://localhost', authorization: `Bearer ${token}` };
  assert.equal((await app.inject({ method: 'POST', url, payload: {} })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://elsewhere.example' }, payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { path: '/etc' } })).statusCode, 400);
  assert.equal(settings.read().revision, 0);
});

test('permission-denied directories explain how to recover', { skip: process.getuid?.() === 0 }, async t => {
  const { home, options } = await fixture(t); const path = join(home, 'locked'); await mkdir(path); await chmod(path, 0);
  try { await assert.rejects(browseFolders({ path }, options), /cannot open.*retry/); } finally { await chmod(path, 0o700); }
});
