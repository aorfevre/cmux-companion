import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePrepare } from '../server/prepare-command.mjs';

const policy = { ceilingMs: 1000, idleMs: 1000, maxOutputBytes: 8192, killGraceMs: 100 };
test('prepare resolves only commanded sources through PATH and returns null otherwise', () => {
  const env = { PATH: process.env.PATH };
  assert.equal(resolvePrepare({ prepare: { source: 'none' } }, { env, environmentId: 'settings-1', policy }), null);
  assert.equal(resolvePrepare({ prepare: { source: 'disabled' } }, { env, environmentId: 'settings-1', policy }), null);
  assert.equal(resolvePrepare({}, { env, environmentId: 'settings-1', policy }), null);
  const resolved = resolvePrepare({ prepare: { source: 'detected', executable: 'node', args: ['-e', '0'] } }, { env, environmentId: 'settings-1', policy });
  assert.equal(resolved.bin, process.execPath); assert.deepEqual(resolved.argv, ['-e', '0']);
  assert.equal(resolved.environmentId, 'settings-1-prepare'); assert.deepEqual(resolved.env, env); assert.equal(resolved.policy, policy);
  assert.throws(() => resolvePrepare({ prepare: { source: 'custom', executable: 'definitely-missing-binary', args: [] } }, { env, environmentId: 'settings-1', policy }), { code: 'UNSUPPORTED_CAPABILITY' });
});
