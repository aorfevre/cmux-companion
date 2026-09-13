import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupData, restoreData, assertDataCompatibility } from '../updater/src/data-recovery.mjs';
import { defaultPaths } from '../updater/src/constants.mjs';
import { assertMigrationReady, installationConfig, installBundled } from '../updater/src/install.mjs';
import { writeJson, readJson } from '../updater/src/fs-safe.mjs';
import { run } from '../updater/src/process.mjs';
import { loadConfig } from '../updater/src/config.mjs';
const sha = 'a'.repeat(40);
async function directory(t) { const root = await mkdtemp(join(tmpdir(), 'bundled-recovery-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
test('consistent SQLite backup restores only approved data, checks digests and refuses symlinks', async t => {
  const root = await directory(t), file = join(root, 'settings.sqlite'), missing = join(root, 'core.sqlite');
  let db = new DatabaseSync(file); db.exec("CREATE TABLE value (text); INSERT INTO value VALUES ('before')"); db.close();
  const options = { root: join(root, 'backups'), id: 'transaction1', files: [file, missing], previousSha: sha };
  const snapshot = await backupData(options); assert.deepEqual(await backupData(options), snapshot);
  db = new DatabaseSync(file); db.exec("UPDATE value SET text='after'"); db.close();
  await writeFile(missing, 'candidate data');
  await restoreData(snapshot, options.files);
  db = new DatabaseSync(file); assert.equal(db.prepare('SELECT text FROM value').get().text, 'before'); db.close();
  await assert.rejects(readFile(missing), { code: 'ENOENT' });
  await assert.rejects(restoreData(snapshot, [missing, file]), /destinations/);
  await assert.rejects(backupData({ ...options, previousSha: 'b'.repeat(40) }), /identity/);
  await symlink(file, missing); await assert.rejects(restoreData(snapshot, options.files), /Unsafe/);
  await assert.rejects(backupData({ ...options, id: 'transaction2', files: [missing] }), /Unsafe/);
  await writeFile(snapshot.files[0].backup, 'corruption'); await assert.rejects(restoreData(snapshot, options.files), /digest/);
});
test('unchanged schema code is required before activation', async t => {
  const root = await directory(t), old = join(root, 'old'), candidate = join(root, 'candidate');
  for (const base of [old, candidate]) { await mkdir(join(base, 'server/orchestration/storage'), { recursive: true }); await writeFile(join(base, 'server/local-settings.mjs'), 'same'); await writeFile(join(base, 'server/orchestration/storage/schema.mjs'), 'same'); }
  await assertDataCompatibility(old, candidate); await writeFile(join(candidate, 'server/local-settings.mjs'), 'migration');
  await assert.rejects(assertDataCompatibility(old, candidate), /explicit migration/);
});
test('legacy migration refuses transactions and live owners and never imports old enabled authorization', async t => {
  const root = await directory(t), paths = defaultPaths(root), stopped = async () => ({ code: 1 });
  await assert.rejects(assertMigrationReady({ paths, existing: { schemaVersion: 1, enabled: true }, execute: stopped }), /--migrate/);
  await assertMigrationReady({ paths, existing: { schemaVersion: 1 }, migrate: true, execute: stopped });
  await assert.rejects(assertMigrationReady({ paths, existing: { schemaVersion: 1 }, migrate: true, execute: async () => ({ code: 0 }) }), /Stop/);
  await writeJson(paths.transaction, { id: 'old-transaction' });
  await assert.rejects(assertMigrationReady({ paths, existing: null, execute: stopped }), /transaction/);
});
test('one-checkout installation packages the updater, persists explicit paths and supports local rollback evidence', async t => {
  const root = await directory(t), repo = join(root, 'source'), paths = defaultPaths(join(root, 'home'));
  const git = args => run('git', args, { env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  await git(['init', '--initial-branch=main', repo]); await git(['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/companion.git']);
  for (const folder of ['server', 'dist/server', 'updater/scripts', 'server/orchestration/storage']) await mkdir(join(repo, folder), { recursive: true });
  const files = ['server/local-settings.mjs', 'server/orchestration/storage/schema.mjs', 'server/supervisor.mjs', 'dist/server/index.js', 'updater/scripts/local-updater.mjs', 'updater/scripts/bootstrap.mjs', 'updater/scripts/launch-companion.mjs'];
  for (const file of files) await writeFile(join(repo, file), '// disposable fixture\n');
  await writeJson(join(repo, 'package.json'), { name: 'disposable-updater-install', version: '1.0.0', private: true, scripts: { build: 'node -e "process.exit(0)"', verify: 'node -e "process.exit(0)"' } });
  await writeJson(join(repo, 'package-lock.json'), { name: 'disposable-updater-install', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'disposable-updater-install', version: '1.0.0' } } });
  await git(['-C', repo, 'add', '.']); await git(['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'fixture']);
  const calls = [], execute = async (bin, args, options) => { if (bin === '/usr/bin/plutil') return { code: 0, stdout: JSON.stringify({ EnvironmentVariables: { CMUX_COMPANION_VAPID_SUBJECT: 'https://fixture.example.invalid' } }) }; if (bin === '/bin/launchctl') { calls.push(args); return { code: args[0] === 'print' ? 1 : 0, stdout: '' }; } return run(bin, args, options); };
  const result = await installBundled({ sourceRoot: repo, repository: 'example/companion', paths, execute, checkHealth: async () => ({ ok: true }), port: 3240, frontendPort: 3241 });
  assert.match(result.sha, /^[a-f0-9]{40}$/); assert.equal(result.automatic, false);
  const config = await loadConfig(paths.config); assert.equal(config.targets.length, 1); assert.equal(config.repository, 'example/companion'); assert.equal(config.healthUrl, 'http://127.0.0.1:3240/api/health');
  assert.match(await readFile(join(paths.launchAgents, 'org.cmux-companion.service.plist'), 'utf8'), /CMUX_COMPANION_UPDATER_CONTROL/);
  assert.equal((await readJson(join(result.backupRoot, 'migration.json'))).installedSha, result.sha);
  assert.equal(calls.filter(args => args[0] === 'bootstrap').length, 2);
  const reinstall = await installBundled({ sourceRoot: repo, repository: 'example/companion', paths, execute, checkHealth: async () => ({ ok: true }) }); assert.equal(reinstall.sha, result.sha);
  assert.match(await readFile(join(paths.launchAgents, 'org.cmux-companion.service.plist'), 'utf8'), /https:\/\/fixture.example.invalid/);
  const beforeFailure = await readFile(paths.config, 'utf8');
  await assert.rejects(installBundled({ sourceRoot: repo, repository: 'example/companion', paths,
    execute: async (bin, args, options) => { if (bin === '/bin/launchctl' && args[0] === 'bootstrap' && args[2].endsWith('org.cmux-companion.updater.plist')) throw new Error('fixture bootstrap failure'); return execute(bin, args, options); },
    checkHealth: async () => ({ ok: true }), listenerStopped: async () => true }), /fixture bootstrap failure/);
  assert.equal(await readFile(paths.config, 'utf8'), beforeFailure);
  const { UpdateControl } = await import('../updater/src/control.mjs');
  const oldControl = new UpdateControl(paths.control); oldControl.policy(oldControl.status().revision, true); oldControl.close();
  await writeJson(paths.config, { ...config, schemaVersion: 1, enabled: true });
  await writeFile(join(paths.launchAgents, 'com.aorfevre.cmux-companion.plist'), '<plist/>');
  await writeFile(join(paths.launchAgents, 'com.aorfevre.cmux-companion-updater.plist'), '<plist/>');
  await mkdir(paths.updaterStore, { recursive: true }); await writeFile(join(paths.updaterStore, 'preserved'), 'old release evidence');
  await writeFile(config.tokenFile, 'unchanged private fixture token');
  const migrated = await installBundled({ sourceRoot: repo, repository: 'example/companion', paths, execute, checkHealth: async () => ({ ok: true }), migrate: true, dataDirectory: paths.configRoot, tokenFile: config.tokenFile });
  assert.equal(migrated.automatic, false);
  assert.equal(await readFile(config.tokenFile, 'utf8'), 'unchanged private fixture token');
  assert.equal(await readFile(join(paths.updaterStore, 'preserved'), 'utf8'), 'old release evidence');
  await assert.rejects(readFile(join(paths.launchAgents, 'com.aorfevre.cmux-companion-updater.plist')), { code: 'ENOENT' });
  assert.equal((await readJson(join(migrated.backupRoot, 'migration.json'))).legacy, true);
  await assert.rejects(installBundled({ sourceRoot: repo, repository: 'example/companion', paths, execute, build: async () => {}, checkHealth: async () => ({ ok: true }), port: 3211, frontendPort: 3211 }), /distinct/);
});
test('configuration rejects unsafe paths, hosts, repositories and legacy automatic engine state', async t => {
  const root = await directory(t), paths = defaultPaths(root), sourceRoot = join(root, 'source'); await mkdir(sourceRoot);
  assert.throws(() => installationConfig({ sourceRoot, repository: 'https://bad', paths }), /repository/);
  assert.throws(() => installationConfig({ sourceRoot: '.', repository: 'example/repo', paths }), /absolute/);
  const valid = installationConfig({ sourceRoot, repository: 'example/repo', paths });
  for (const bad of [{ schemaVersion: 1 }, { ...valid, healthUrl: 'http://0.0.0.0:3210/api/health' }, { ...valid, pollSeconds: 0 }, { ...valid, dataFiles: [] }, { ...valid, targets: [] }, { ...valid, repository: '../bad' }, { ...valid, healthTimeoutSeconds: -1 }]) { await writeJson(paths.config, bad); await assert.rejects(loadConfig(paths.config)); }
  await writeJson(paths.config, valid); assert.equal((await loadConfig(paths.config)).schemaVersion, 2);
});

test('build watchdog reuses durable success rather than launching a duplicate process', async t => {
  const root = await directory(t);
  const { supervisedBuildRunner } = await import('../updater/src/build-process.mjs');
  const execute = supervisedBuildRunner(join(root, 'build'));
  const marker = join(root, 'executions');
  const argv = ['-e', 'require("node:fs").appendFileSync(process.argv[1], "x"); process.stdout.write("verified")', marker];
  assert.equal((await execute(process.execPath, argv, { cwd: root, timeoutMs: 5000 })).stdout, 'verified');
  assert.equal((await execute(process.execPath, argv, { cwd: root, timeoutMs: 5000 })).stdout, 'verified');
  assert.equal(await readFile(marker, 'utf8'), 'x');
  await assert.rejects(execute('missing-updater-build-binary', []), /unavailable/);
  await assert.rejects(execute(process.execPath, ['-e', 'process.exit(1)'], { cwd: root, timeoutMs: 5000 }), /verification failed/);
});

test('preparation recovery requires every watchdog to prove stopped before releasing maintenance', async t => {
  const root = await realpath(await directory(t)), paths = defaultPaths(root);
  const { UpdateControl } = await import('../updater/src/control.mjs');
  const { reconcilePreparation } = await import('../updater/src/preparation-recovery.mjs');
  const control = new UpdateControl(paths.control); t.after(() => control.close());
  control.checked({ candidate: { sha } }); control.request({ id: 'build-recovery1', sha }); control.fence('build-recovery1', 'service'); control.start('build-recovery1', 'service');
  control.finish('build-recovery1', { success: false, recoveryRequired: true });
  const evidenceDirectory = join(paths.stateRoot, 'builds', 'build-recovery1'); await mkdir(evidenceDirectory, { recursive: true });
  const options = { paths, control, id: 'build-recovery1', observe: async () => ({ workerState: 'stopped' }) };
  await assert.rejects(reconcilePreparation(options), /incomplete/);
  await mkdir(join(evidenceDirectory, 'f'.repeat(64)));
  await assert.rejects(reconcilePreparation({ ...options, observe: async () => null }), /running or uncertain/);
  assert.equal(control.status().maintenance, true);
  await reconcilePreparation(options); assert.equal(control.status().maintenance, false);
  await assert.rejects(reconcilePreparation(options), /No matching/);
});
