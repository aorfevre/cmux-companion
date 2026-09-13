import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { LocalSettings, defaultSettings, inspectProject } from '../server/local-settings.mjs';
import { assertDevChild, contains, inspectDevRepo, macPath, scanDevRepo, suggestedChecks } from '../server/dev-repositories.mjs';
import { RepoCatalog } from '../server/repo-catalog.mjs';
import { buildApp } from '../server/app.mjs';
import { backupData, restoreData } from '../updater/src/data-recovery.mjs';
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dev-repos-test-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const roots = ['karven', 'rekord'].map(name => { const path = join(directory, name); mkdirSync(path); return { id: name, name, path }; });
  const repo = (root, name) => { const path = join(root.path, name); mkdirSync(path); execFileSync('git', ['init', '-q', path]); return path; };
  const path = repo(roots[0], 'example');
  const project = { id: 'existing', name: 'Existing', path, enabled: false, github: 'example/repo', remote: 'git@github.com:example/repo.git', checks: [{ id: 'check', executable: 'npm', args: ['test'] }] };
  return { directory, roots, repo, project };
}
test('named directory migration, discovery, association, renaming and removal preserve durable identities and admitted snapshots', async t => {
  const { directory, roots, project } = fixture(t), path = join(directory, 'settings.sqlite');
  const old = defaultSettings(); delete old.devRepos; old.projects = [project];
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE local_settings(id INTEGER PRIMARY KEY, revision INTEGER, value TEXT, imported INTEGER); CREATE TABLE goal_configuration(goal_id TEXT PRIMARY KEY, revision INTEGER, value TEXT); PRAGMA user_version=1;');
  db.prepare('INSERT INTO local_settings VALUES(1,7,?,1)').run(JSON.stringify(old));
  const goal = { project, provider: 'claude' };
  db.prepare('INSERT INTO goal_configuration VALUES(?,?,?)').run('old-goal', 6, JSON.stringify(goal)); db.close();
  const backup = await backupData({ root: join(directory, 'backups'), id: 'schema-v1', files: [path], previousSha: 'a'.repeat(40) });
  let store = new LocalSettings({ path });
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.deepEqual(store.read().settings.projects, old.projects); assert.equal(store.read().revision, 7); assert.equal(store.read().imported, true);
  await store.update(7, { ...store.read().settings, devRepos: roots });
  assert.equal(store.read().settings.projects[0].devRepoId, 'karven'); assert.equal(store.read().settings.projects[0].enabled, false);
  await store.update(8, { ...store.read().settings, devRepos: roots.map(root => ({ ...root, name: root.name.toUpperCase() })) });
  await store.update(9, { ...store.read().settings, devRepos: [] });
  assert.equal(store.read().settings.projects[0].devRepoId, undefined);
  assert.deepEqual(store.goalConfiguration('old-goal'), { revision: 6, ...goal });
  store.close(); store = new LocalSettings({ path }); assert.equal(store.read().revision, 10); store.close();
  await restoreData(backup, [path]);
  const restored = new DatabaseSync(path); assert.equal(restored.prepare('PRAGMA user_version').get().user_version, 1); assert.deepEqual(JSON.parse(restored.prepare('SELECT value FROM local_settings').get().value), old); restored.close();
});
test('directory inputs, names, membership and overlap are validated without admitting discovered repositories', async t => {
  const { directory, roots, project } = fixture(t); const store = new LocalSettings(); t.after(() => store.close());
  assert.equal(macPath('~/Developers'), join(homedir(), 'Developers'));
  for (const value of ['', null, 'relative', '/tmp/\n']) assert.throws(() => macPath(value));
  assert.equal(contains('/one', '/one-two'), false); assert.equal(contains('/one', '/one/child'), true);
  await assert.rejects(inspectDevRepo(project.path), /folder containing/);
  await assert.rejects(inspectDevRepo(join(directory, 'missing')), /unavailable/);
  const file = join(directory, 'file'); writeFileSync(file, 'text'); await assert.rejects(inspectDevRepo(file), /directory/);
  await store.update(0, { ...defaultSettings(), devRepos: roots });
  assert.deepEqual(store.read().settings.projects, []);
  for (const devRepos of [[...roots, { ...roots[0], id: 'dup' }], roots.map(root => ({ ...root, name: 'Same' })), [{ ...roots[0], name: ' spaced ' }], [{ ...roots[0], id: 'bad id' }], [...roots, { id: 'sub', name: 'Sub', path: project.path }]]) await assert.rejects(store.update(1, { ...store.read().settings, devRepos }));
  await assert.rejects(store.update(1, { ...store.read().settings, devRepos: [{ ...roots[0], path: roots[1].path }] }), /cannot be changed/);
  await assert.rejects(store.update(1, { ...store.read().settings, projects: [{ ...project, devRepoId: 'missing' }] }), /Unknown/);
  await assert.rejects(store.update(1, { ...store.read().settings, projects: [{ ...project, path: roots[1].path, devRepoId: roots[0].id }] }));
});
test('discovery excludes symlinks, hidden folders, generated folders, nested Git roots and linked worktrees, and only suggests safe data', async t => {
  const { directory, roots, repo, project } = fixture(t);
  for (const name of ['.hidden', 'node_modules', 'worktrees']) repo(roots[0], name);
  const parent = join(roots[0].path, 'nested'); mkdirSync(parent); repo({ path: parent }, 'deep');
  symlinkSync(project.path, join(roots[0].path, 'alias'));
  const linked = join(roots[0].path, 'linked'); mkdirSync(linked); writeFileSync(join(linked, '.git'), 'gitdir: elsewhere');
  const scripts = { test: 'touch should-never-run', build: 'echo build', '--unsafe': 'echo no', weird: 1, newline: 'a\nb' };
  writeFileSync(join(project.path, 'package.json'), JSON.stringify({ scripts }));
  execFileSync('git', ['-C', project.path, 'remote', 'add', 'origin', 'https://secret@github.com/example/private.git']);
  const scan = await scanDevRepo(roots[0], inspectProject);
  assert.equal(scan.partial, false); assert.deepEqual(scan.repositories.filter(entry => !entry.error).map(entry => entry.name), ['example']);
  const found = scan.repositories.find(entry => entry.name === 'example'); assert.equal(found.remote, null); assert.equal(JSON.stringify(scan).includes('secret'), false);
  assert.deepEqual(found.suggestedChecks.map(check => check.args), [['run', 'test'], ['run', 'build']]);
  const { existsSync } = await import('node:fs'); assert.equal(existsSync(join(project.path, 'should-never-run')), false);
  await assert.rejects(assertDevChild(roots[0].path, linked));
  await assert.rejects(assertDevChild(roots[0].path, join(roots[0].path, 'alias')));
  const aliasRoot = join(directory, 'root-alias'); symlinkSync(roots[0].path, aliasRoot); await assert.rejects(assertDevChild(aliasRoot, project.path));
  rmSync(join(project.path, 'package.json')); symlinkSync(join(directory, 'outside'), join(project.path, 'package.json')); assert.deepEqual(await suggestedChecks(project.path), []);
});
test('scans report limits, timeouts and unreadable repositories; script inspection is bounded', async t => {
  const { roots, project } = fixture(t);
  assert.equal((await scanDevRepo(roots[0], inspectProject, { entryLimit: 0 })).partial, true);
  let tick = 0; assert.equal((await scanDevRepo(roots[0], inspectProject, { now: () => tick++ * 10000, deadlineMs: 1 })).partial, true);
  const failed = await scanDevRepo(roots[0], async () => { throw new Error('secret diagnostic'); }); assert.match(failed.repositories[0].error, /could not be inspected/); assert.equal(JSON.stringify(failed).includes('secret'), false);
  for (const content of ['{bad', JSON.stringify({ scripts: [] }), '{}', 'x'.repeat(262145)]) { writeFileSync(join(project.path, 'package.json'), content); assert.deepEqual(await suggestedChecks(project.path), []); }
});
test('paired scoped writes preserve unrelated preferences and reject stale writes and cross-origin discovery', async t => {
  const { roots, project } = fixture(t), store = new LocalSettings(), token = 'd'.repeat(48);
  const app = await buildApp({ token, localSettings: store, repoCatalog: { list: async () => [] } }); t.after(async () => { await app.close(); store.close(); });
  const headers = { host: 'localhost', authorization: `Bearer ${token}`, origin: 'http://localhost' };
  const post = (url, payload, custom = headers) => app.inject({ method: 'POST', url, headers: custom, payload });
  assert.equal((await post('/api/settings/dev-repos/inspect', { path: roots[0].path }, {})).statusCode, 401);
  assert.equal((await post('/api/settings/dev-repos/inspect', { path: roots[0].path }, { ...headers, origin: 'https://evil.test' })).statusCode, 403);
  assert.equal((await post('/api/settings/dev-repos/inspect', { path: roots[0].path, secret: 'no' })).statusCode, 400);
  assert.equal((await post('/api/settings/dev-repos/inspect', { path: roots[0].path })).json().path, roots[0].path);
  assert.equal((await post('/api/settings/dev-repos/unknown/scan', {})).statusCode, 400);
  const patch = payload => app.inject({ method: 'PATCH', url: '/api/settings/local', headers, payload });
  assert.equal((await patch({ expectedRevision: 0, changes: { devRepos: roots } })).statusCode, 200);
  assert.equal((await post(`/api/settings/dev-repos/${roots[0].id}/scan`, {})).json().repositories[0].path, project.path);
  assert.deepEqual(store.read().settings.projects, []);
  assert.equal((await patch({ expectedRevision: 1, changes: { provider: 'codex' } })).statusCode, 200);
  assert.deepEqual(store.read().settings.devRepos, roots);
  assert.equal((await patch({ expectedRevision: 1, changes: { provider: 'claude' } })).statusCode, 409);
  for (const payload of [{ expectedRevision: 2, changes: [] }, { expectedRevision: 2, changes: { onboarding: { completed: true } } }, { expectedRevision: 2, changes: {}, extra: 1 }]) assert.equal((await patch(payload)).statusCode, 400);
});


test('cached manual repository lookup rechecks enablement and collection containment', async t => {
  const { roots, project, repo } = fixture(t);
  const outside = repo(roots[1], 'outside');
  let enabled = true;
  const catalog = new RepoCatalog({ roots: [], projects: () => [{ ...project, enabled, devRepoName: 'karven', devRepoPath: roots[0].path }] });
  const [entry] = await catalog.list(); assert.equal(entry.root, 'karven');
  assert.equal((await catalog.get(entry.id)).path, project.path);
  enabled = false; await assert.rejects(catalog.get(entry.id), /no longer enabled/); enabled = true;
  rmSync(project.path, { recursive: true }); symlinkSync(outside, project.path);
  await assert.rejects(catalog.get(entry.id), /direct Git directory/);
});
