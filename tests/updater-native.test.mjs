import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, utimes } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UpdateControl } from '../updater/src/control.mjs';
import { defaultPaths } from '../updater/src/constants.mjs';
import { nativeUpdateAdapter, linkedSha, runEngine } from '../updater/src/engine.mjs';
import { run } from '../updater/src/process.mjs';
import { writeJson, readJson } from '../updater/src/fs-safe.mjs';
import { buildCandidate } from '../updater/src/manifest.mjs';
import { installationConfig } from '../updater/src/install.mjs';
import { acquireLock } from '../updater/src/lock.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'updater-native-')), repo = join(root, 'repo'), remote = join(root, 'remote.git'), paths = defaultPaths(join(root, 'home'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = args => run('git', args, { env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  await git(['init', '--initial-branch=main', repo]); await git(['init', '--bare', '--initial-branch=main', remote]); await git(['-C', repo, 'remote', 'add', 'origin', remote]);
  for (const folder of ['server/orchestration/storage', 'updater/scripts', 'dist/server']) await mkdir(join(repo, folder), { recursive: true });
  const entries = ['server/local-settings.mjs', 'server/orchestration/storage/schema.mjs', 'server/supervisor.mjs', 'dist/server/index.js', 'updater/scripts/local-updater.mjs', 'updater/scripts/bootstrap.mjs', 'updater/scripts/launch-companion.mjs'];
  for (const entry of entries) await writeFile(join(repo, entry), '// fixture\n');
  const pkg = { name: 'native-update-fixture', version: '1.0.0', scripts: { build: 'node -e "console.log(123)"' } };
  await writeJson(join(repo, 'package.json'), pkg); await writeJson(join(repo, 'package-lock.json'), { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': { name: pkg.name, version: pkg.version } } });
  const commit = async message => { await git(['-C', repo, 'add', '.']); await git(['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', message]); return (await git(['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim(); };
  const base = await commit('base');
  const config = installationConfig({ sourceRoot: repo, repository: 'example/repo', paths });
  const target = { ...config.targets[0], expectedRemote: remote, verificationCommands: [] }; config.targets = [target];
  await mkdir(join(paths.companionStore, 'releases'), { recursive: true }); await mkdir(paths.libexec, { recursive: true });
  const oldRelease = join(paths.companionStore, 'releases', base);
  await git(['-C', repo, 'worktree', 'add', '--detach', oldRelease, base]); await buildCandidate(target, oldRelease, base);
  await symlink(`releases/${base}`, join(paths.companionStore, 'current'));
  await writeFile(join(repo, 'new.txt'), 'candidate'); const sha = await commit('candidate'); await git(['-C', repo, 'push', 'origin', 'main']);
  await writeFile(join(repo, 'new.txt'), 'private dirty source');
  await mkdir(paths.configRoot, { recursive: true }); await writeFile(config.tokenFile, 'private-test-token');
  for (const file of config.dataFiles) { const db = new DatabaseSync(file); db.exec('CREATE TABLE test (value)'); db.close(); }
  const control = new UpdateControl(paths.control); t.after(() => control.close());
  control.checked({ candidate: { sha }, observedSha: sha, deployedSha: base }); control.request({ id: 'native-001', sha }); control.fence('native-001', 'service'); control.start('native-001', 'service');
  const calls = []; let serviceRunning = true, installedSha = sha;
  const execute = async (bin, args, options) => {
    if (bin !== '/bin/launchctl') return run(bin, args, options);
    calls.push(args);
    if (args[0] === 'bootout') serviceRunning = false;
    if (['bootstrap', 'kickstart'].includes(args[0])) serviceRunning = true;
    return { code: args[0] === 'print' && !serviceRunning ? 1 : 0, stdout: '' };
  };
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.pathname.includes('/maintenance')) { assert.equal(init.headers.Authorization, 'Bearer private-test-token'); return Response.json({ ready: true, serviceId: 'service' }); }
    if (!serviceRunning) throw new Error('listener stopped');
    if (url.pathname === '/api/health') return Response.json({ ok: true, version: { gitSha: installedSha } });
    if (url.pathname === '/') return new Response('<script src="/app.js"></script>');
    return new Response('code', { headers: { 'content-type': 'application/javascript' } });
  };
  const adapter = nativeUpdateAdapter({ paths, config, control, github: { revalidate: async () => {} }, fetchImpl, execute });
  return { root, repo, paths, config, target, base, sha, control, adapter, calls, setInstalledSha: value => { installedSha = value; } };
}
test('native adapter stages exact approved SHA, uses isolated supervised build, backs up data and verifies recovery', async t => {
  const f = await fixture(t);
  assert.equal((await f.adapter.maintenance('native-001')).ready, true);
  const release = await f.adapter.prepare(f.sha); await f.adapter.prepare(f.sha);
  assert.equal(await readFile(join(f.repo, 'new.txt'), 'utf8'), 'private dirty source');
  assert.equal(await readFile(join(release, 'new.txt'), 'utf8'), 'candidate');
  await f.adapter.verifyFence('native-001', 'service');
  const backup = await f.adapter.backup('native-001'); assert.equal(backup.previousSha, f.base);
  await f.adapter.activate(f.sha); assert.equal(await linkedSha(f.target), f.sha);
  await f.adapter.restart(); await f.adapter.health(f.sha); await f.adapter.accept(f.sha);
  assert.equal(await readFile(f.paths.bootstrap, 'utf8'), '// fixture\n');
  await f.adapter.stop(); await f.adapter.restore(backup); await f.adapter.activate(f.base); f.setInstalledSha(f.base); await f.adapter.restart(); await f.adapter.health(f.base);
  assert.ok(f.calls.some(args => args[0] === 'bootstrap'));
  f.control.finish('native-001', { success: false }); await f.adapter.recoveryRecord(); assert.equal(await readJson(f.paths.transaction), null);
});
test('engine cycle writes one-repository status without installation when automatic mode is off', async t => {
  const root = await mkdtemp(join(tmpdir(), 'updater-cycle-')); t.after(() => rm(root, { recursive: true, force: true }));
  const paths = defaultPaths(root), repo = join(root, 'repo'); await mkdir(repo);
  const base = 'b'.repeat(40), sha = 'a'.repeat(40), config = installationConfig({ sourceRoot: repo, repository: 'example/repo', paths });
  await mkdir(join(paths.companionStore, 'releases', base), { recursive: true }); await symlink(`releases/${base}`, join(paths.companionStore, 'current')); await writeJson(paths.config, config);
  let prepare = 0;
  await runEngine({ paths, createGitHub: () => ({ discover: async () => ({ candidate: { sha }, deployedSha: base, observedSha: sha }) }), createAdapter: () => ({ prepare: async () => { prepare++; }, recoveryRecord: async () => {} }) });
  assert.equal(prepare, 0); assert.equal((await readJson(paths.state)).observedRemoteSha, sha);
  const control = new UpdateControl(paths.control); assert.equal(control.status().automatic, false); control.close();
});

test('stable bootstrap resumes the previous engine after a switch and rejects altered recovery identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'updater-bootstrap-')); t.after(() => rm(root, { recursive: true, force: true }));
  const paths = defaultPaths(root), old = 'b'.repeat(40), next = 'a'.repeat(40), marker = join(root, 'executed');
  for (const sha of [old, next]) {
    const scripts = join(paths.companionStore, 'releases', sha, 'updater/scripts'); await mkdir(scripts, { recursive: true });
    await writeFile(join(scripts, 'local-updater.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.CMUX_TEST_MARKER, '${sha}');\n`);
  }
  await mkdir(paths.stateRoot, { recursive: true }); await symlink(`releases/${next}`, join(paths.companionStore, 'current'));
  const bootstrap = new URL('../updater/scripts/bootstrap.mjs', import.meta.url).pathname;
  const options = { env: { HOME: root, CMUX_COMPANION_HOME: root, CMUX_TEST_MARKER: marker }, timeoutMs: 10000 };
  await run(process.execPath, [bootstrap], options); assert.equal(await readFile(marker, 'utf8'), next);
  const recoveryEngine = join(paths.companionStore, 'releases', old, 'updater/scripts/local-updater.mjs');
  const { sha256 } = await import('../updater/src/fs-safe.mjs');
  await writeJson(paths.transaction, { schemaVersion: 2, id: 'recovery-001', recoveryEngine, expectedEngineDigest: await sha256(recoveryEngine) });
  await run(process.execPath, [bootstrap], options); assert.equal(await readFile(marker, 'utf8'), old);
  await writeFile(recoveryEngine, '// altered'); await assert.rejects(run(process.execPath, [bootstrap], options), /digest changed/);
  await writeJson(paths.transaction, { schemaVersion: 1 }); await assert.rejects(run(process.execPath, [bootstrap], options), /Legacy update transaction/);
});

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => child.once('exit', resolve));
  return child.pid;
}

test('bootstrap reclaims an orphaned spawn claim once its owner is dead and stale, but keeps a fresh or live one', async t => {
  const root = await mkdtemp(join(tmpdir(), 'updater-bootstrap-claim-')); t.after(() => rm(root, { recursive: true, force: true }));
  const paths = defaultPaths(root), sha = 'a'.repeat(40), marker = join(root, 'executed');
  const scripts = join(paths.companionStore, 'releases', sha, 'updater/scripts'); await mkdir(scripts, { recursive: true });
  await writeFile(join(scripts, 'local-updater.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.CMUX_TEST_MARKER, '${sha}');\n`);
  await mkdir(paths.stateRoot, { recursive: true }); await symlink(`releases/${sha}`, join(paths.companionStore, 'current'));
  const bootstrap = new URL('../updater/scripts/bootstrap.mjs', import.meta.url).pathname;
  const options = { env: { HOME: root, CMUX_COMPANION_HOME: root, CMUX_TEST_MARKER: marker }, timeoutMs: 10000 };
  const owner = join(paths.lock, 'owner.json'), pid = await deadPid(), stale = new Date(Date.now() - 16 * 60_000);
  const claim = async (details, at) => {
    await rm(paths.lock, { recursive: true, force: true }); await mkdir(paths.lock, { mode: 0o700 });
    await writeFile(owner, JSON.stringify({ pid, createdAt: new Date().toISOString(), spawnClaim: true, ...details }));
    if (at) await utimes(paths.lock, at, at);
  };
  // A fresh claim with no engine pid protects an engine spawn that is still being recorded.
  await claim({}); await run(process.execPath, [bootstrap], options);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  // A stale claim whose owner is dead is an orphan; the bootstrap reclaims it and runs.
  await claim({}, stale); await run(process.execPath, [bootstrap], options);
  assert.equal(await readFile(marker, 'utf8'), sha);
  // A stale claim with a live engine stays protected.
  await rm(marker); await claim({ enginePid: process.pid }, stale); await run(process.execPath, [bootstrap], options);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await claim({ pid: process.pid }, stale); await run(process.execPath, [bootstrap], options);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('acquireLock treats a dead, stale spawn claim without an engine pid as an orphan', async t => {
  const root = await mkdtemp(join(tmpdir(), 'updater-lock-claim-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, 'lock'), owner = join(lock, 'owner.json'), pid = await deadPid(), now = Date.now();
  const claim = async details => { await rm(lock, { recursive: true, force: true }); await mkdir(lock, { mode: 0o700 }); await writeFile(owner, JSON.stringify({ pid, spawnClaim: true, ...details })); };
  await claim({}); assert.equal(await acquireLock(lock, { now }), null);
  await claim({}); assert.equal(await acquireLock(lock, { now, staleMs: 60_000 }), null, 'fresh mtime still protects the claim');
  await claim({}); await utimes(lock, new Date(now - 16 * 60_000), new Date(now - 16 * 60_000));
  const release = await acquireLock(lock, { now }); assert.equal(typeof release, 'function'); await release();
  await claim({ pid: process.pid }); await utimes(lock, new Date(now - 16 * 60_000), new Date(now - 16 * 60_000));
  assert.equal(await acquireLock(lock, { now }), null, 'a live owner keeps the claim');
  await claim({ enginePid: process.pid }); await utimes(lock, new Date(now - 16 * 60_000), new Date(now - 16 * 60_000));
  assert.equal(await acquireLock(lock, { now }), null, 'a live engine keeps the claim');
});
