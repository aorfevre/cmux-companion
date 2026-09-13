import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importSettings } from '../scripts/import-settings.mjs';
import { LocalSettings } from '../server/local-settings.mjs';

test('failed configuration import cannot activate an empty replacement database', async t => {
  const root = mkdtempSync(join(tmpdir(), 'settings-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = join(root, 'settings.sqlite'), modelsPath = join(root, 'models.json');
  writeFileSync(modelsPath, JSON.stringify({ version: 1, roles: { coder: { models: { codex: 'bad model' } } } }), { mode: 0o600 });
  await assert.rejects(importSettings({ database, modelsPath }));
  assert.equal(existsSync(database), false);
  const source = JSON.stringify({ version: 1, roles: { coder: { models: { codex: 'custom-model' } } } });
  writeFileSync(modelsPath, source);
  assert.deepEqual(await importSettings({ database, modelsPath }), { revision: 1, projects: 0 });
  assert.equal(readFileSync(modelsPath, 'utf8'), source);
  const settings = new LocalSettings({ path: database });
  assert.equal(settings.read().settings.providers.codex.model, 'custom-model'); settings.close();
  await assert.rejects(importSettings({ database, modelsPath }));
  assert.equal(readFileSync(modelsPath, 'utf8'), source);
});
