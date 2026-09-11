import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { SchedulerOwnership, processLiveness } from '../server/orchestration/storage/ownership.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'orchestration-ownership-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'state.sqlite') };
}
function connection(t, path) { const store = new OrchestrationStore({ path }); t.after(() => store.close()); return store; }

test('only one process-instance nonce can own a database, including a second instance in the same process', (t) => {
  const { path } = fixture(t); const a = connection(t, path), b = connection(t, path);
  const owner = new SchedulerOwnership({ store: a }).acquire();
  const contender = new SchedulerOwnership({ store: b });
  assert.throws(() => contender.acquire(), { code: 'OWNERSHIP_UNCERTAIN' });
  owner.assertOwned(); assert.throws(() => owner.acquire(), { code: 'ALREADY_RUNNING' });
  owner.release(); contender.acquire(); contender.assertOwned(); contender.release();
  assert.throws(() => owner.assertOwned(), { code: 'OWNERSHIP_UNCERTAIN' });
});

test('unknown or reused PID ownership is not stolen; only verified death permits recovery', (t) => {
  const { path } = fixture(t), store = connection(t, path);
  const owner = new SchedulerOwnership({ store, pid: 4242 }).acquire();
  for (const state of ['alive', 'unknown']) assert.throws(() => new SchedulerOwnership({ store, liveness: () => state }).acquire(), { code: 'OWNERSHIP_UNCERTAIN' });
  const recovered = new SchedulerOwnership({ store, liveness: () => 'dead' }).acquire();
  assert.throws(() => owner.assertOwned(), { code: 'OWNERSHIP_UNCERTAIN' });
  assert.throws(() => owner.release(), { code: 'OWNERSHIP_UNCERTAIN' });
  recovered.assertOwned(); recovered.release();
});

test('parent-directory aliases share the same durable owner', (t) => {
  const { dir, path } = fixture(t); const alias = `${dir}-alias`;
  symlinkSync(dir, alias); t.after(() => rmSync(alias));
  const original = connection(t, path), other = connection(t, join(alias, 'state.sqlite'));
  const owner = new SchedulerOwnership({ store: original }).acquire();
  assert.throws(() => new SchedulerOwnership({ store: other }).acquire(), { code: 'OWNERSHIP_UNCERTAIN' });
  owner.release();
});

function childOwner(path) {
  const script = `import { OrchestrationStore } from './server/orchestration/storage/store.mjs';
    import { SchedulerOwnership } from './server/orchestration/storage/ownership.mjs';
    const store = new OrchestrationStore({path:process.argv[1]});
    const owner = new SchedulerOwnership({store}).acquire();
    process.stdout.write('OWNED\\n'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, path], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { child, ready: new Promise((resolve, reject) => {
    let stderr = ''; child.stderr.on('data', (chunk) => stderr += chunk);
    child.once('error', reject); child.once('exit', (code) => reject(new Error(`owner exited ${code}: ${stderr}`)));
    child.stdout.once('data', () => resolve());
  }) };
}

test('actual child-process death releases ownership without relying on a lease timeout', async (t) => {
  const { path } = fixture(t); const { child, ready } = childOwner(path);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await ready; const store = connection(t, path), owner = new SchedulerOwnership({ store });
  assert.equal(processLiveness(child.pid), 'alive');
  assert.throws(() => owner.acquire(), { code: 'OWNERSHIP_UNCERTAIN' });
  const exited = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  assert.equal(processLiveness(child.pid), 'dead'); owner.acquire(); owner.assertOwned(); owner.release();
});
