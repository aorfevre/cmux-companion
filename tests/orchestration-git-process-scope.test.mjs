import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, realpathSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { gitScopeStopped, withGitProcessScope, trackGitCommand } from '../server/orchestration/adapters/git-process-scope.mjs';
import { gitBytes } from '../server/orchestration/adapters/git.mjs';
import { GitIntegration } from '../server/orchestration/adapters/git-integration.mjs';
import { bootIdentity } from '../server/orchestration/adapters/process-evidence.mjs';
import { createRepositoryFixture, fixtureGit } from './helpers/orchestration/fixture.mjs';

async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(50); }
  assert.fail('Owned process evidence did not settle');
}

test('Git child surviving service SIGKILL keeps integration observation unknown until its group stops', async t => {
  const repo = await createRepositoryFixture(); t.after(() => repo.close());
  const directory = join(realpathSync(repo.directory), 'resources'); mkdirSync(directory);
  const adapter = new GitIntegration({ repositories: { directory } });
  const scope = join(adapter.directory, 'delayed.processes');
  const bin = join(realpathSync(repo.directory), 'bin'); mkdirSync(bin);
  const ready = join(realpathSync(repo.directory), 'ready'), gate = join(realpathSync(repo.directory), 'gate'), complete = join(realpathSync(repo.directory), 'complete');
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!${process.execPath}\nconst fs=require('node:fs'); const cp=require('node:child_process');\nfs.writeFileSync(${JSON.stringify(ready)},String(process.pid));\nwhile(!fs.existsSync(${JSON.stringify(gate)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);\nprocess.stdout.write(cp.execFileSync('/usr/bin/git',process.argv.slice(2)));\nfs.writeFileSync(${JSON.stringify(complete)},'done');\n`); chmodSync(wrapper, 0o700);
  const config = join(realpathSync(repo.directory), 'config.json'); writeFileSync(config, JSON.stringify({ scope, repository: repo.repository, headSha: repo.baseSha }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/orchestration/git-process-crash-child.mjs', import.meta.url)), config], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(() => { child.kill('SIGKILL'); if (existsSync(ready)) { try { process.kill(-Number(readFileSync(ready, 'utf8')), 'SIGKILL'); } catch { /* Owned group already stopped. */ } } });
  await until(() => existsSync(ready) && readdirSync(scope).some(run => readdirSync(join(scope, run)).some(command => command.startsWith('command-') && existsSync(join(scope, run, command, 'identity.json')))));
  child.kill('SIGKILL'); await exited;
  assert.equal(gitScopeStopped(scope), false);
  assert.deepEqual(await adapter.observeIntegration('delayed'), { status: 'unknown', headSha: null });
  assert.deepEqual(await adapter.observeRepair({ integrationOperationId: 'delayed' }), { status: 'unknown', headSha: null });
  await assert.rejects(withGitProcessScope(scope, async () => {}), { code: 'OWNERSHIP_UNCERTAIN' });
  writeFileSync(gate, 'continue'); await until(() => existsSync(complete));
  await until(() => gitScopeStopped(scope));
  assert.equal(await fixtureGit(repo.repository, ['rev-parse', 'refs/heads/delayed']), repo.baseSha);
  assert.deepEqual(await adapter.observeIntegration('delayed'), { status: 'pending', headSha: null });
  assert.deepEqual(await adapter.observeRepair({ integrationOperationId: 'delayed' }), { status: 'pending', headSha: null });
});

test('started command without identity stays unknown until kernel boot evidence changes', async t => {
  const repo = await createRepositoryFixture(); t.after(() => repo.close()); const path = join(realpathSync(repo.directory), 'scope');
  await withGitProcessScope(path, async () => { trackGitCommand(); });
  assert.equal(gitScopeStopped(path), false);
  const run = join(path, readdirSync(path)[0]); const owner = join(run, 'run.json');
  const evidence = JSON.parse(readFileSync(owner, 'utf8')); evidence.boot = bootIdentity() === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64); writeFileSync(owner, JSON.stringify(evidence));
  assert.equal(gitScopeStopped(path), bootIdentity() !== null);
});

test('an active scope blocks outside observation between commands, but internal read-only inspection is allowed', async t => {
  const repo = await createRepositoryFixture(); t.after(() => repo.close()); const path = join(realpathSync(repo.directory), 'scope');
  let release; const gate = new Promise(resolve => { release = resolve; });
  const running = withGitProcessScope(path, async () => { assert.equal(gitScopeStopped(path), true); await gate; });
  assert.equal(gitScopeStopped(path), false); release(); await running;
  assert.equal(gitScopeStopped(path), true);
});

test('scoped Git launch failures and output limits leave verifiable stopped evidence', async t => {
  const repo = await createRepositoryFixture(); t.after(() => repo.close());
  const bin = join(realpathSync(repo.directory), 'bin'); mkdirSync(bin);
  const saved = process.env.PATH; process.env.PATH = bin; t.after(() => { process.env.PATH = saved; });
  const scope = join(realpathSync(repo.directory), 'scope');
  await assert.rejects(withGitProcessScope(scope, () => gitBytes(repo.repository, ['status'])), { code: 'GIT_OPERATION_FAILED', exitCode: 'ENOENT' });
  assert.equal(gitScopeStopped(scope), true);
  const wrapper = join(bin, 'git'); writeFileSync(wrapper, `#!${process.execPath}\nprocess.stdout.write(Buffer.alloc(17*1024*1024)); setInterval(()=>{},1000);\n`); chmodSync(wrapper, 0o700);
  await assert.rejects(withGitProcessScope(scope, () => gitBytes(repo.repository, ['status'])), { code: 'GIT_OPERATION_FAILED' });
  await until(() => gitScopeStopped(scope));
});

test('identity write failure waits for the spawned Git group to stop before rejecting', async t => {
  const repo = await createRepositoryFixture(); t.after(() => repo.close());
  const path = join(realpathSync(repo.directory), 'scope');
  const bin = join(realpathSync(repo.directory), 'bin'); mkdirSync(bin);
  const wrapper = join(bin, 'git'); writeFileSync(wrapper, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`); chmodSync(wrapper, 0o700);
  const savedPath = process.env.PATH; process.env.PATH = bin;
  const originalWrite = fs.writeFileSync;
  let injected = false;
  const write = t.mock.method(fs, 'writeFileSync', (...args) => {
    if (String(args[0]).endsWith('/identity.json') && !injected) {
      injected = true;
      throw Object.assign(new Error('Injected identity write failure'), { code: 'EIO' });
    }
    return originalWrite(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(withGitProcessScope(path, () => gitBytes(repo.repository, ['status'])), { code: 'EIO' });
  } finally { process.env.PATH = savedPath; write.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.equal(gitScopeStopped(path), true);
  const run = join(path, readdirSync(path)[0]);
  const command = join(run, readdirSync(run).find(name => name.startsWith('command-')));
  assert.equal(existsSync(join(command, 'identity.json')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(command, 'stopped.json'), 'utf8')), { stopped: true });
  await withGitProcessScope(path, () => gitBytes(repo.repository, ['status']));
});

for (const lingerMs of [150, 2000]) test(`successful tracked Git waits for actual group disappearance; descendant=${lingerMs}ms`, async t => {
  const repo = await createRepositoryFixture(); t.after(() => repo.close());
  const root = realpathSync(repo.directory), bin = join(root, 'bin'), scope = join(root, 'scope'), pidPath = join(root, 'owned-group'); mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
const {spawn}=require('node:child_process'); require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));
const child=spawn(process.execPath,['-e','setTimeout(()=>{},${lingerMs})'],{stdio:'ignore'}); child.unref(); process.stdout.write('complete');
`, { mode: 0o700 });
  const original = process.env.PATH; process.env.PATH = bin;
  t.after(() => { process.env.PATH = original; if (existsSync(pidPath)) { try { process.kill(-Number(readFileSync(pidPath, 'utf8')), 'SIGKILL'); } catch { /* The fixture group is already gone. */ } } });
  const run = () => withGitProcessScope(scope, () => gitBytes(repo.repository, ['fixture']));
  if (lingerMs < 250) {
    assert.equal((await run()).toString(), 'complete');
    assert.equal(gitScopeStopped(scope), true);
  } else {
    await assert.rejects(run(), { code: 'OWNERSHIP_UNCERTAIN' });
    assert.equal(gitScopeStopped(scope), false, 'elapsed time must not become stopped proof');
  }
});
