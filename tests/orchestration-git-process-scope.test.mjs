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
