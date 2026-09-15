import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { LocalSettings, defaultSettings, inspectProject, providerCommand, resolveExecutable } from '../server/local-settings.mjs';

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'companion-settings-')));
  const path = join(directory, 'settings.sqlite');
  const store = new LocalSettings({ path });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const repo = join(directory, 'project'); mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  return { store, directory, path, project: { id: 'project', name: 'Project', path: repo, enabled: true, github: null, remote: null, checks: [] } };
}

test('fresh settings are generic, private and survive restart independently of the catalog cache', async t => {
  const { store, path, directory, project } = fixture(t);
  assert.deepEqual(store.read(), { revision: 0, settings: defaultSettings(), imported: false });
  const settings = store.read().settings;
  settings.projects.push(project); settings.providers.codex = { executable: 'codex', args: [], model: 'custom-model' };
  await store.update(0, settings);
  writeFileSync(join(directory, 'repo-identity.db'), 'disposable'); rmSync(join(directory, 'repo-identity.db'));
  const reopened = new LocalSettings({ path }); t.after(() => reopened.close());
  assert.deepEqual(reopened.read().settings, settings);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(reopened.read().revision, 1);
});

test('concurrent paired writers cannot overwrite changes after asynchronous project validation', async t => {
  const { store, project } = fixture(t);
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const delayed = store.update(0, { ...defaultSettings(), projects: [project] }, { inspect: async path => { await waiting; return { path }; } });
  await store.update(0, { ...defaultSettings(), provider: 'codex' }); release();
  await assert.rejects(delayed, error => error.statusCode === 409);
  assert.equal(store.read().settings.provider, 'codex');
  assert.deepEqual(store.read().settings.projects, []);
});

test('project roots are canonical, unique, immutable and disabled instead of deleted', async t => {
  const { store, directory, project } = fixture(t);
  const alias = join(directory, 'alias'); symlinkSync(project.path, alias);
  let settings = defaultSettings(); settings.projects.push({ ...project, path: alias });
  await store.update(0, settings);
  assert.equal(store.read().settings.projects[0].path, project.path);
  settings = store.read().settings; settings.projects.push({ ...project, id: 'duplicate', path: alias });
  await assert.rejects(store.update(1, settings), /unique absolute/);
  settings = store.read().settings; settings.projects[0].path = alias;
  await assert.rejects(store.update(1, settings), /cannot be changed/);
  await assert.rejects(store.update(1, defaultSettings()), /Disable projects/);
  settings = store.read().settings; settings.projects[0].enabled = false;
  // A missing disk must not prevent disabling its project or editing settings.
  rmSync(project.path, { recursive: true });
  await store.update(1, settings);
  settings.projects[0].enabled = true;
  await assert.rejects(store.update(2, settings), /accessible Git/);
});

test('provider commands reject shell evaluation and permission overrides', () => {
  for (const provider of ['claude', 'codex']) {
    for (const executable of [provider, `/opt/bin/${provider}`]) assert.equal(providerCommand({ executable, args: [], model: 'default' }, provider).executable, executable);
    assert.deepEqual(providerCommand({ executable: 'ccs', args: [provider], model: 'default' }, provider).args, [provider]);
    for (const value of [
      { executable: 'sh', args: ['-c', provider], model: 'default' },
      { executable: 'ccs', args: [provider, '--dangerously-skip-permissions'], model: 'default' },
      { executable: 'ccs', args: [provider], model: '$(secret)' },
      { executable: '/tmp/$(bad)/ccs', args: [provider], model: 'default' },
      { executable: `ccs ${provider}`, args: [], model: 'default' },
      { executable: 'ccs', args: [provider], model: 'default', env: { TOKEN: 'secret' } },
    ]) assert.throws(() => providerCommand(value, provider), TypeError);
  }
});

test('Git inspection only suggests credential-free remotes and refuses subdirectories', async t => {
  const { project } = fixture(t);
  execFileSync('git', ['-C', project.path, 'remote', 'add', 'origin', 'https://token@github.com/example/private.git']);
  assert.equal((await inspectProject(project.path)).remote, null);
  execFileSync('git', ['-C', project.path, 'remote', 'set-url', 'origin', 'git@github.com:example/project.git']);
  assert.equal((await inspectProject(project.path)).github, 'example/project');
  mkdirSync(join(project.path, 'sub'));
  await assert.rejects(inspectProject(join(project.path, 'sub')), /Git repository root/);
  await assert.rejects(inspectProject('relative'), /absolute/);
});

test('legacy import is explicit, atomic, once-only and never persists environment credentials', async t => {
  const { store, project } = fixture(t);
  const orchestration = { repositories: [{ ...project, github: 'example/project', remote: { url: 'git@github.com:example/project.git', env: { GH_TOKEN: 'private-token' } }, checks: [{ id: 'test', bin: '/opt/bin/node', argv: ['node', '--test'], env: { SECRET: 'private-token' } }] }], native: { ccsBin: '/opt/bin/ccs', engine: { provider: 'claude', model: 'default' }, cmux: { bin: '/opt/bin/cmux' }, env: { SECRET: 'private-token' } }, policy: {}, limits: { global: 6 } };
  const invalid = structuredClone(orchestration); invalid.repositories[0].remote.url = 'https://private-token@github.com/example/project';
  await assert.rejects(store.importLegacy(0, { orchestration: invalid }), /without embedded/);
  assert.equal(store.read().revision, 0);
  await store.importLegacy(0, { orchestration, models: { version: 1, roles: { coder: { models: { codex: 'custom' } } } } });
  assert.equal(store.read().imported, true);
  assert.equal(store.read().settings.execution.global, 6);
  assert.equal(store.read().settings.providers.codex.model, 'custom');
  assert.equal(JSON.stringify(store.read()).includes('private-token'), false);
  await assert.rejects(store.importLegacy(1, { orchestration }), /only available/);
});

test('existing goal configuration survives disabling and edits; new goals use the latest revision', async t => {
  const { store, project } = fixture(t);
  const settings = defaultSettings(); settings.projects.push(project);
  await store.update(0, settings);
  const original = store.snapshotGoal('first', project.id);
  settings.provider = 'codex'; settings.execution.global = 7;
  await store.update(1, settings);
  assert.equal(store.snapshotGoal('second', project.id).provider, 'codex');
  assert.deepEqual(store.snapshotGoal('first', project.id), original);
  settings.projects[0].enabled = false; await store.update(2, settings);
  assert.throws(() => store.snapshotGoal('third', project.id), /enabled/);
  assert.deepEqual(store.goalConfiguration('first'), original);
  assert.equal(store.goalConfiguration('missing'), null);
});

test('invalid settings writes preserve the previous database value', async t => {
  const { store, project } = fixture(t);
  const mutations = [
    s => { s.secret = 'no'; }, s => { s.provider = 'other'; }, s => { s.tools.cmux = ''; },
    s => { s.execution.global = 0; }, s => { s.execution.maxOutputBytes = 3000000; },
    s => { s.previews = { portStart: 8500, portEnd: 8599 }; }, s => { s.tools.chrome = 'chrome'; },
    s => { s.onboarding.completed = 'yes'; }, s => { s.projects = {}; },
    s => { s.projects.push({ ...project, id: undefined }); },
    s => { s.projects.push({ ...project, checks: [{ executable: 'npm', args: ['test'] }] }); },
    s => { s.projects.push({ ...project, github: 'bad' }); },
    s => { s.projects.push({ ...project, checks: [{ id: 'test', executable: 'sh', args: ['test'] }] }); },
  ];
  for (const mutate of mutations) {
    const settings = defaultSettings(); mutate(settings);
    await assert.rejects(store.update(0, settings), TypeError);
    assert.equal(store.read().revision, 0);
  }
  await assert.rejects(store.update(undefined, defaultSettings()), /revision/);
});

test('executable lookup ignores relative PATH entries and settings refuse symlink storage', t => {
  const { directory, path } = fixture(t);
  assert.equal(resolveExecutable(process.execPath), process.execPath);
  assert.equal(resolveExecutable('missing-command', '.:relative'), null);
  assert.equal(resolveExecutable(directory), null);
  const link = join(directory, 'settings-link'); symlinkSync(path, link);
  assert.throws(() => new LocalSettings({ path: link }), /regular file/);
});

 test('the registry refuses another application database without changing its schema', async t => {
  const { directory } = fixture(t);
  const { DatabaseSync } = await import('node:sqlite');
  const path = join(directory, 'workflow.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE goals(id TEXT PRIMARY KEY)');
  assert.throws(() => new LocalSettings({ path }), /separate settings database/);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name), ['goals']);
  db.close();
});

test('favorites survive restart and preserve settings and admitted goal snapshots', async t => {
  const { store, path, project } = fixture(t);
  await store.update(0, { ...defaultSettings(), projects: [project] });
  assert.deepEqual(store.favorites(), { revision: 1, ids: [] });
  const snapshot = store.snapshotGoal('goal', project.id);
  const before = store.read().settings;
  assert.deepEqual(store.setFavorite(1, project.id, true), { revision: 2, ids: [project.id] });
  assert.deepEqual(store.read().settings, before);
  assert.deepEqual(store.goalConfiguration('goal'), snapshot);
  const reopened = new LocalSettings({ path }); t.after(() => reopened.close());
  assert.deepEqual(reopened.favorites(), store.favorites());
  assert.throws(() => store.setFavorite(1, project.id, false), error => error.statusCode === 409);
  assert.throws(() => store.setFavorite(2, 'unknown', true), /saved project/);
  assert.throws(() => store.setFavorite(2, project.id, 'true'), /boolean/);
  assert.deepEqual(store.setFavorite(2, project.id, false), { revision: 3, ids: [] });
});


test('retirement hides inert schema-2 fields and preserves rollback data, favorites and attempt configuration across restart', async t => {
  const { store, path, project } = fixture(t);
  await store.update(0, { ...defaultSettings(), projects: [project], provider: 'codex' });
  const old = store.read();
  old.settings.previews = { portStart: 8700, portEnd: 8799 };
  old.settings.tools.chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const historical = { project, tools: old.settings.tools, provider: 'claude' };
  const db = new DatabaseSync(path);
  db.prepare('UPDATE local_settings SET value=?, imported=1 WHERE id=1').run(JSON.stringify(old.settings));
  db.prepare('INSERT INTO project_favorites VALUES(?,1)').run(project.id);
  db.prepare('INSERT INTO goal_configuration VALUES(?,?,?)').run('historical', 1, JSON.stringify(historical));
  db.exec('PRAGMA user_version=2'); db.close();
  for (let restart = 0; restart < 2; restart++) {
    const migrated = new LocalSettings({ path });
    try {
      const expected = structuredClone(old.settings); delete expected.previews; delete expected.tools.chrome;
      assert.deepEqual(migrated.read(), { revision: 1, settings: expected, imported: true });
      assert.deepEqual(migrated.goalConfiguration('historical'), { revision: 1, ...historical });
      const raw = { ...old.settings }; delete raw.launchProfiles; delete raw.teamDefaults;
      assert.deepEqual(JSON.parse(migrated.db.prepare('SELECT value FROM local_settings').get().value), raw);
      assert.equal(migrated.db.prepare('SELECT favorite FROM project_favorites WHERE project_id=?').get(project.id).favorite, 1);
      assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 2);
    } finally { migrated.close(); }
  }
});
