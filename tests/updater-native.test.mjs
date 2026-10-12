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

async function bootstrapFixture(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix)); t.after(() => rm(root, { recursive: true, force: true }));
  const paths = defaultPaths(root), sha = 'a'.repeat(40), marker = join(root, 'executed');
  const scripts = join(paths.companionStore, 'releases', sha, 'updater/scripts'); await mkdir(scripts, { recursive: true });
  await writeFile(join(scripts, 'local-updater.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.CMUX_TEST_MARKER, '${sha}');\n`);
  await mkdir(paths.stateRoot, { recursive: true }); await symlink(`releases/${sha}`, join(paths.companionStore, 'current'));
  const bootstrap = new URL('../updater/scripts/bootstrap.mjs', import.meta.url).pathname;
  const env = { HOME: root, CMUX_COMPANION_HOME: root, CMUX_TEST_MARKER: marker };
  const cycle = (extraEnv = {}) => run(process.execPath, [bootstrap], { env: { ...env, ...extraEnv }, timeoutMs: 10000, allowFailure: true });
  return { paths, sha, marker, cycle };
}

test('bootstrap reclaims dead or ownerless stale locks, keeps fresh or live ones, and exits 3 when held', async t => {
  const f = await bootstrapFixture(t, 'updater-bootstrap-claim-');
  const owner = join(f.paths.lock, 'owner.json'), pid = await deadPid(), stale = new Date(Date.now() - 16 * 60_000);
  const claim = async (contents, at) => {
    await rm(f.paths.lock, { recursive: true, force: true }); await mkdir(f.paths.lock, { mode: 0o700 });
    if (contents !== null) await writeFile(owner, typeof contents === 'string' ? contents : JSON.stringify({ pid, createdAt: new Date().toISOString(), spawnClaim: true, ...contents }));
    if (at) await utimes(f.paths.lock, at, at);
  };
  const held = async label => { const result = await f.cycle(); assert.equal(result.code, 3, `${label}: exit 3 while held`); await assert.rejects(readFile(f.marker), { code: 'ENOENT' }, `${label}: engine not run`); };
  const reclaimed = async label => { const result = await f.cycle(); assert.equal(result.code, 0, `${label}: exit 0`); assert.equal(await readFile(f.marker, 'utf8'), f.sha, `${label}: engine ran`); await rm(f.marker); };
  // Fresh claims of every shape protect a spawn that is still being recorded.
  await claim({}); await held('fresh dead pid');
  await claim(null); await held('fresh missing owner');
  await claim(''); await held('fresh empty owner');
  // Stale claims without a live process are orphans.
  await claim({}, stale); await reclaimed('stale dead pid');
  await claim(null, stale); await reclaimed('stale missing owner');
  await claim('', stale); await reclaimed('stale empty owner');
  await claim({ pid: undefined, enginePid: undefined, spawnClaim: true }, stale); await reclaimed('stale pid-less owner');
  // Live processes keep their lock however old it is.
  await claim({ enginePid: process.pid }, stale); await held('stale live engine');
  await claim({ pid: process.pid }, stale); await held('stale live owner');
});

test('bootstrap reports an engine that exits 3 or 4 as a plain failure', async t => {
  const f = await bootstrapFixture(t, 'updater-bootstrap-engine-exit-');
  const engine = join(f.paths.companionStore, 'releases', f.sha, 'updater/scripts/local-updater.mjs');
  await writeFile(engine, 'process.exit(3);\n');
  assert.equal((await f.cycle()).code, 1, 'engine exit 3 is not reported as lock held');
  await writeFile(engine, 'process.exit(4);\n');
  assert.equal((await f.cycle()).code, 1, 'engine exit 4 is not reported as low disk');
});

test('bootstrap removes the lock directory when its owner write fails', async t => {
  const f = await bootstrapFixture(t, 'updater-bootstrap-write-');
  const result = await f.cycle({ CMUX_COMPANION_UPDATER_FAILPOINT: 'owner-write' });
  assert.equal(result.code, 1); assert.match(result.stderr, /ENOSPC/);
  await assert.rejects(readFile(f.paths.lock), { code: 'ENOENT' }, 'no ownerless directory survives');
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
  const next = await f.cycle(); assert.equal(next.code, 0, 'the next cycle is not blocked'); assert.equal(await readFile(f.marker, 'utf8'), f.sha);
});

test('bootstrap refuses to claim the lock below the free-space floor and exits 4', async t => {
  const f = await bootstrapFixture(t, 'updater-bootstrap-disk-');
  const result = await f.cycle({ CMUX_COMPANION_UPDATER_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER) });
  assert.equal(result.code, 4);
  await assert.rejects(readFile(f.paths.lock), { code: 'ENOENT' }, 'no lock directory was created');
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
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

test('acquireLock reclaims a stale lock whose owner file is missing, empty or pid-less, and protects a fresh one', async t => {
  const root = await mkdtemp(join(tmpdir(), 'updater-lock-orphan-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, 'lock'), owner = join(lock, 'owner.json');
  const shapes = [
    ['missing', null],
    ['empty', ''],
    ['pid-less', JSON.stringify({ createdAt: '2026-09-16T09:23:42.601Z', spawnClaim: true })],
    ['zero pid', JSON.stringify({ pid: 0, createdAt: '2026-09-16T09:23:42.601Z' })],
  ];
  for (const [label, contents] of shapes) {
    await rm(lock, { recursive: true, force: true }); await mkdir(lock, { mode: 0o700 });
    if (contents !== null) await writeFile(owner, contents);
    assert.equal(await acquireLock(lock, { now: Date.now() }), null, `${label}: a fresh lock stays protected`);
    const release = await acquireLock(lock, { now: Date.now() + 16 * 60_000 });
    assert.equal(typeof release, 'function', `${label}: a stale ownerless lock is an orphan`);
    assert.equal((await readJson(owner)).pid, process.pid, `${label}: the reclaimer records itself`);
    await release();
  }
});

test('acquireLock removes the directory it created when the owner write fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'updater-lock-write-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, 'lock');
  await assert.rejects(acquireLock(lock, { write: async () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } }), { code: 'ENOSPC' });
  await assert.rejects(readFile(join(lock, 'owner.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(lock), { code: 'ENOENT' });
  const release = await acquireLock(lock); assert.equal(typeof release, 'function', 'the next claimant is not blocked'); await release();
});

test('acquireLock serializes stale reclamation so concurrent claimants cannot replace each other', async t => {
  const root = await mkdtemp(join(tmpdir(), 'updater-lock-race-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, 'lock'); await mkdir(lock, { mode: 0o700 });
  const stale = new Date(Date.now() - 16 * 60_000); await utimes(lock, stale, stale);
  // Many claimants inspect the same stale directory at once; exactly one wins.
  const results = await Promise.all(Array.from({ length: 12 }, () => acquireLock(lock, { now: Date.now() })));
  const winners = results.filter(result => typeof result === 'function');
  assert.equal(winners.length, 1, 'exactly one claimant owns the reclaimed lock');
  assert.equal((await readJson(join(lock, 'owner.json'))).pid, process.pid);
  await assert.rejects(readFile(`${lock}.reclaim`), { code: 'ENOENT' }, 'the reclaim marker is released');
  await winners[0]();
  await assert.rejects(readFile(lock), { code: 'ENOENT' });
});

test('acquireLock yields without deleting when its owner write finds the directory gone', async t => {
  const root = await mkdtemp(join(tmpdir(), 'updater-lock-enoent-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, 'lock');
  // Simulate a reclaimer that replaced the directory with another claimant's lock
  // between this claimant's mkdir and its owner write.
  const write = async () => { await rm(lock, { recursive: true, force: true }); await mkdir(lock); await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid })); throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  assert.equal(await acquireLock(lock, { write }), null, 'ownership is lost');
  assert.equal((await readJson(join(lock, 'owner.json'))).pid, process.pid, 'the other claim survives');
});

test('acquireLock reclaims a stale lock behind a stale reclaim marker and respects a fresh one', async t => {
  const root = await mkdtemp(join(tmpdir(), 'updater-lock-marker-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, 'lock'), marker = `${lock}.reclaim`; await mkdir(lock, { mode: 0o700 }); await mkdir(marker, { mode: 0o700 });
  const stale = new Date(Date.now() - 16 * 60_000); await utimes(lock, stale, stale);
  assert.equal(await acquireLock(lock, { now: Date.now() }), null, 'a fresh marker means another reclaimer is working');
  await utimes(marker, stale, stale);
  const release = await acquireLock(lock, { now: Date.now() });
  assert.equal(typeof release, 'function', 'a stale marker from a crashed reclaimer is replaced'); await release();
});

test('bootstrap serializes stale reclamation across concurrent cycles and respects a fresh reclaim marker', async t => {
  const f = await bootstrapFixture(t, 'updater-bootstrap-race-');
  const stale = new Date(Date.now() - 16 * 60_000);
  await mkdir(f.paths.lock, { mode: 0o700 }); await utimes(f.paths.lock, stale, stale);
  const results = await Promise.all(Array.from({ length: 6 }, () => f.cycle()));
  const ran = results.filter(result => result.code === 0).length;
  assert.equal(ran, 1, 'exactly one concurrent cycle reclaims and runs the engine');
  assert.ok(results.every(result => [0, 3].includes(result.code)), 'the others report the lock as held');
  assert.equal(await readFile(f.marker, 'utf8'), f.sha);
  await assert.rejects(readFile(`${f.paths.lock}.reclaim`), { code: 'ENOENT' }, 'the reclaim marker is released');
  await rm(f.marker);
  await mkdir(f.paths.lock, { mode: 0o700 }); await utimes(f.paths.lock, stale, stale); await mkdir(`${f.paths.lock}.reclaim`, { mode: 0o700 });
  assert.equal((await f.cycle()).code, 3, 'a fresh reclaim marker means another reclaimer is working');
  await rm(`${f.paths.lock}.reclaim`, { recursive: true, force: true });
});
