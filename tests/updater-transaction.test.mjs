import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateControl } from '../updater/src/control.mjs';
import { updateCycle, executeUpdate } from '../updater/src/transaction.mjs';
const sha = 'a'.repeat(40), base = 'b'.repeat(40);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'update-transaction-'));
  const control = new UpdateControl(join(root, 'control.sqlite'));
  t.after(() => { control.close(); rmSync(root, { recursive: true, force: true }); });
  const calls = [], adapter = Object.fromEntries(['prepare', 'verifyFence', 'activate', 'restart', 'health', 'accept', 'stop', 'restore'].map(name => [name, async (...args) => { calls.push([name, ...args]); }]));
  adapter.backup = async () => { calls.push(['backup']); return { previousSha: base, files: [] }; };
  const candidate = { sha, changesUrl: 'https://github.com/example/repo/compare/base...head' };
  const options = { control, adapter, deployedSha: base, discover: async () => ({ candidate, observedSha: sha, deployedSha: base }), revalidate: async () => {}, maintenance: async id => { control.fence(id, 'service'); return { ready: true, serviceId: 'service' }; }, id: () => 'automatic-001' };
  return { control, adapter, calls, options };
}
test('discovery is inert by default; manual confirmation activates exactly once', async t => {
  const f = fixture(t); await updateCycle(f.options); assert.deepEqual(f.calls, []);
  f.control.request({ id: 'manual-001', sha, whenIdle: true });
  await updateCycle(f.options); assert.equal(f.control.status().request.status, 'succeeded');
  assert.deepEqual(f.calls.map(call => call[0]), ['prepare', 'verifyFence', 'backup', 'verifyFence', 'activate', 'restart', 'health', 'accept']);
  await updateCycle(f.options); assert.equal(f.calls.filter(call => call[0] === 'activate').length, 1);
});
test('opt-in queues while busy, cancellation suppresses repetition and manual requests survive disable', async t => {
  const f = fixture(t); f.control.policy(0, true);
  await updateCycle({ ...f.options, maintenance: async () => ({ ready: false }) });
  assert.equal(f.control.status().request.status, 'queued'); assert.deepEqual(f.calls, []);
  f.control.cancel('automatic-001'); await updateCycle(f.options); assert.deepEqual(f.calls, []);
  f.control.request({ id: 'manual-002', sha, whenIdle: true }); f.control.policy(1, false);
  await updateCycle(f.options); assert.equal(f.control.status().request.status, 'succeeded');
});
test('disable during admission cannot start; update now does not silently wait for busy work', async t => {
  const f = fixture(t); f.control.policy(0, true);
  await updateCycle({ ...f.options, maintenance: async id => { f.control.fence(id, 'service'); f.control.policy(1, false); return { ready: true, serviceId: 'service' }; } });
  assert.deepEqual(f.calls, []); assert.equal(f.control.status().maintenance, false);
  f.control.request({ id: 'manual-003', sha });
  await updateCycle({ ...f.options, maintenance: async () => ({ ready: false }) });
  assert.equal(f.control.status().request.status, 'cancelled');
});
test('CI and maintenance errors do not activate or lose manual approval', async t => {
  const f = fixture(t);
  await updateCycle({ ...f.options, discover: async () => { throw new Error('offline'); } });
  assert.match(f.control.status().checkError, /unavailable/);
  f.control.check(); await updateCycle(f.options); f.control.request({ id: 'manual-004', sha, whenIdle: true });
  await updateCycle({ ...f.options, revalidate: async () => { throw new Error('pending'); } });
  assert.match(f.control.status().request.error, /successful CI/);
  await updateCycle({ ...f.options, maintenance: async () => { throw new Error('offline'); } });
  assert.deepEqual(f.calls, []); assert.equal(f.control.status().request.status, 'queued');
});
test('preparation failure preserves running application; health failure restores previous data and version', async t => {
  const f = fixture(t); await updateCycle(f.options); f.control.request({ id: 'manual-005', sha });
  await updateCycle({ ...f.options, adapter: { ...f.adapter, prepare: async () => { throw new Error('build'); } } });
  assert.equal(f.control.status().request.status, 'failed'); assert.deepEqual(f.calls, []);
  const g = fixture(t); await updateCycle(g.options); g.control.request({ id: 'manual-006', sha });
  await updateCycle({ ...g.options, adapter: { ...g.adapter, health: async candidate => { if (candidate === sha) throw new Error('bad startup'); g.calls.push(['health', candidate]); } } });
  assert.equal(g.control.status().request.status, 'failed'); assert.equal(g.control.status().maintenance, false);
  assert.deepEqual(g.calls.filter(call => ['stop', 'restore', 'activate'].includes(call[0])).map(call => call[0]), ['activate', 'stop', 'restore', 'activate']);
  assert.equal(g.calls.findLast(call => call[0] === 'activate')[1], base);
});
test('interrupted activation recovers; failed recovery retains fence and never retries automatically', async t => {
  const f = fixture(t); await updateCycle(f.options); f.control.request({ id: 'manual-007', sha }); f.control.fence('manual-007', 'service'); f.control.start('manual-007', 'service');
  f.control.change(state => Object.assign(state.requests['manual-007'], { phase: 'switching', backup: { previousSha: base, files: [] }, previousSha: base }));
  await executeUpdate({ control: f.control, request: { id: 'manual-007' }, adapter: { ...f.adapter, restore: async () => { throw new Error('corrupt backup'); } } });
  assert.equal(f.control.status().request.status, 'recovery_required'); assert.equal(f.control.status().maintenance, true);
  const count = f.calls.length; await updateCycle(f.options); assert.equal(f.calls.length, count);
});
test('accepted transaction resumes only bootstrap refresh, then releases maintenance', async t => {
  const f = fixture(t); await updateCycle(f.options); f.control.request({ id: 'manual-008', sha }); f.control.fence('manual-008', 'service'); f.control.start('manual-008', 'service'); f.control.phase('manual-008', 'accepted');
  await updateCycle(f.options); assert.deepEqual(f.calls, [['accept', sha]]); assert.equal(f.control.status().request.status, 'succeeded');
});

test('explicit automatic opt-in installs one eligible commit through the same transaction without per-update confirmation', async t => {
  const f = fixture(t); f.control.policy(0, true);
  await updateCycle(f.options);
  assert.equal(f.control.status().request.source, 'automatic'); assert.equal(f.control.status().request.status, 'succeeded');
  assert.equal(f.calls.filter(call => call[0] === 'activate').length, 1);
  await updateCycle(f.options); assert.equal(f.calls.filter(call => call[0] === 'activate').length, 1);
});
test('uncertain build ownership retains maintenance instead of allowing a replacement installation', async t => {
  const f = fixture(t); await updateCycle(f.options); f.control.request({ id: 'uncertain-001', sha });
  await updateCycle({ ...f.options, adapter: { ...f.adapter, prepare: async () => { throw Object.assign(new Error('unknown'), { code: 'OWNERSHIP_UNCERTAIN' }); } } });
  assert.equal(f.control.status().request.status, 'recovery_required'); assert.equal(f.control.status().maintenance, true);
});

test('unsupported data migrations report a specific safe reason without exposing adapter details', async t => {
  const f = fixture(t); await updateCycle(f.options); f.control.request({ id: 'migration-001', sha });
  await updateCycle({ ...f.options, adapter: { ...f.adapter, prepare: async () => { throw Object.assign(new Error('private path and command output'), { code: 'DATA_COMPATIBILITY' }); } } });
  assert.equal(f.control.status().request.error, 'This update requires a supported data migration. The running version was preserved.');
  assert.equal(f.control.status().request.status, 'failed'); assert.equal(f.control.status().maintenance, false);
  assert.deepEqual(f.calls, []);
});
