import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.mjs';

test('the production entry point starts paired onboarding without config JSON or available native tools', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'settings-startup-'));
  const server = await startServer({ port: 0, dataDirectory: directory, legacyConfigPath: null, cmuxClient: { bin: '/nonexistent/fixture-cmux', socketPassword: null } });
  t.after(async () => { await server.app.close(); rmSync(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.port}/api/settings/local`;
  assert.equal((await fetch(url)).status, 401);
  const token = readFileSync(server.tokenPath, 'utf8').trim();
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).settings.onboarding.completed, false);
  assert.equal(server.tokenPath, join(directory, 'token'));
  assert.equal(readFileSync(server.tokenPath, 'utf8').trim().length >= 32, true);
  const { LocalSettings } = await import('../server/local-settings.mjs');
  const registry = new LocalSettings({ path: join(directory, 'settings.sqlite') });
  assert.equal(registry.read().settings.onboarding.completed, false);
  assert.deepEqual(registry.read().settings.projects, []); registry.close();
});
