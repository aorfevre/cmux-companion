import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apiFixture } from './helpers/orchestration/api-fixture.mjs';
import { contract } from './helpers/orchestration/domain-fixture.mjs';
import { createBridge } from '../server/orchestration/bridge.mjs';

function submit(config, command) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/orchestration/bridge.mjs'], { env: { ...process.env, CMUX_ORCHESTRATION_BRIDGE_CONFIG: config }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', (chunk) => output += chunk); child.stderr.on('data', (chunk) => errors += chunk);
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve({ ...JSON.parse(output), errors }) : reject(new Error(errors)));
    child.stdin.end(`${JSON.stringify(command)}\n`);
  });
}

test('separate bridge process publishes a valid contract only through scoped service commands', async (t) => {
  const { app, planner, store } = await apiFixture(t); const credential = planner();
  const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
  const directory = mkdtempSync(join(tmpdir(), 'orchestration-bridge-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, 'bridge.json'); writeFileSync(config, JSON.stringify({ endpoint, credential }), { mode: 0o600 });
  const forbidden = await submit(config, { id: 'approve', goalId: 'goal', expectedVersion: 3, type: 'approve', payload: { revision: 1 } });
  assert.equal(forbidden.ok, false); assert.equal(forbidden.code, 'FORBIDDEN');
  const published = await submit(config, { id: 'publish', goalId: 'goal', expectedVersion: 3, type: 'publish_contract', payload: { contract: contract() } });
  assert.equal(published.ok, true); assert.equal(store.get('goal').revision, 1);
  assert.ok(!JSON.stringify(published).includes(credential));
  const revoked = await submit(config, { id: 'again', goalId: 'goal', expectedVersion: 4, type: 'publish_contract', payload: { contract: contract() } });
  assert.equal(revoked.code, 'FORBIDDEN'); assert.equal(store.get('goal').version, 4);
});

test('bridge refuses off-machine endpoints and contains no workflow database dependency', () => {
  for (const endpoint of ['https://127.0.0.1', 'http://example.com', 'http://user:pass@127.0.0.1']) assert.throws(() => createBridge({ endpoint, credential: 'secret' }));
  const source = readFileSync('server/orchestration/bridge.mjs', 'utf8');
  assert.doesNotMatch(source, /node:sqlite|storage\/|WorktreePlanStore/);
});
