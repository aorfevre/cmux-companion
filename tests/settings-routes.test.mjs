import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../server/app.mjs';
import { LocalSettings, defaultSettings } from '../server/local-settings.mjs';
const token = 's'.repeat(48);
const headers = { host: 'localhost', authorization: `Bearer ${token}`, origin: 'http://localhost' };
async function fixture(t) {
  const settings = new LocalSettings();
  const changes = [];
  const app = await buildApp({ token, localSettings: settings, onSettingsChange: value => { changes.push(value.revision); }, probeProvider: async () => ({ ready: true }), repoCatalog: { list: async () => [] } });
  t.after(async () => { await app.close(); settings.close(); });
  return { app, settings, changes };
}
test('settings endpoints enforce pairing, same origin and revision checks', async t => {
  const { app, changes } = await fixture(t);
  const payload = { expectedRevision: 0, settings: defaultSettings() };
  assert.equal((await app.inject({ url: '/api/settings/local' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/local', headers: { ...headers, origin: 'https://foreign.example' }, payload })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/local', headers, payload })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/local', headers, payload })).statusCode, 409);
  assert.deepEqual(changes, [1]);
  assert.equal((await app.inject({ url: '/api/settings/local', headers })).json().revision, 1);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/local', headers, payload: { ...payload, secret: 'x' } })).statusCode, 400);
});
test('setup completion requires a project and provider validation cannot run shell commands', async t => {
  const { app } = await fixture(t);
  const settings = defaultSettings(); settings.onboarding.completed = true;
  const result = await app.inject({ method: 'PUT', url: '/api/settings/local', headers, payload: { expectedRevision: 0, settings } });
  assert.equal(result.statusCode, 400); assert.match(result.json().error, /enabled project/);
  const invalid = await app.inject({ method: 'POST', url: '/api/settings/providers/validate', headers, payload: { provider: 'codex', command: { executable: 'sh', args: ['-c', 'echo no'], model: 'default' } } });
  assert.equal(invalid.statusCode, 400);
  const missing = await app.inject({ method: 'POST', url: '/api/settings/providers/validate', headers, payload: { provider: 'codex', command: { executable: '/missing/codex', args: [], model: 'default' } } });
  assert.equal(missing.statusCode, 200); assert.equal(missing.json().ready, false);
  assert.equal((await app.inject({ method: 'POST', url: '/api/settings/projects/inspect', headers, payload: { path: 'relative' } })).statusCode, 400);
});

test('favorite routes authenticate scoped writes and reject invalid and stale updates', async t => {
  const { app, settings, changes } = await fixture(t);
  settings.write(0, { ...defaultSettings(), projects: [{ id: 'p', name: 'P', path: '/disposable', enabled: false, github: null, remote: null, checks: [] }] });
  const url = '/api/settings/projects/p/favorite', payload = { expectedRevision: 1, favorite: true };
  assert.equal((await app.inject({ url: '/api/settings/favorites' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'PATCH', url, payload })).statusCode, 401);
  assert.equal((await app.inject({ method: 'PATCH', url, headers: { ...headers, origin: 'https://foreign.example' }, payload })).statusCode, 403);
  for (const body of [{ ...payload, enabled: true }, { ...payload, favorite: 'yes' }, { favorite: true }]) assert.equal((await app.inject({ method: 'PATCH', url, headers, payload: body })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings/projects/unknown/favorite', headers, payload })).statusCode, 400);
  assert.deepEqual((await app.inject({ method: 'PATCH', url, headers, payload })).json(), { revision: 2, ids: ['p'] });
  assert.equal((await app.inject({ method: 'PATCH', url, headers, payload })).statusCode, 409);
  assert.deepEqual((await app.inject({ url: '/api/settings/favorites', headers })).json(), { revision: 2, ids: ['p'] });
  assert.equal(settings.read().settings.projects[0].enabled, false);
  assert.deepEqual(changes, []); // Preference writes do not recompose the runtime.
});
