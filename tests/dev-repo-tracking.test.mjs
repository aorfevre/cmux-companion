import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { LocalSettings, defaultSettings, inspectProject } from '../server/local-settings.mjs';
import { createDevRepoTracking } from '../server/dev-repo-tracking.mjs';
async function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tracking-'))), root = { id: 'root', name: 'Root', path: join(dir, 'root') };
  mkdirSync(root.path); const path = join(root.path, 'repo'); execFileSync('git', ['init', '-q', path]);
  const settings = new LocalSettings(); await settings.update(0, { ...defaultSettings(), devRepos: [root] });
  t.after(() => { settings.close(); rmSync(dir, { recursive: true, force: true }); });
  const entry = await inspectProject(path);
  return { settings, root, entry, options: { settings, inspect: inspectProject, onChange: async () => {} } };
}
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
test('simultaneous discovery coalesces, retains concurrent preferences and never approves checks', async t => {
  const { settings, root, entry, options } = await fixture(t), wait = gate(); let scans = 0, notifications = 0;
  const tracking = createDevRepoTracking({ ...options, onChange: async () => { notifications++; }, scan: async () => { scans++; await wait.promise; return { repositories: [entry, entry], partial: true, reason: 'Partial' }; } });
  const first = tracking.one(root.id), second = tracking.one(root.id);
  assert.equal(first, second);
  await settings.update(1, { ...settings.read().settings, provider: 'codex' }); wait.release(); await first;
  const saved = settings.read(); assert.equal(scans, 1); assert.equal(notifications, 1); assert.equal(saved.settings.provider, 'codex');
  assert.equal(saved.settings.projects.length, 1); assert.deepEqual(saved.settings.projects[0].checks, []);
  const project = { ...saved.settings.projects[0], enabled: false, name: 'Custom', checks: [{ id: 'test', executable: 'npm', args: ['test'] }] };
  await settings.update(saved.revision, { ...saved.settings, projects: [project] });
  settings.setFavorite(settings.read().revision, project.id, true);
  const revision = settings.read().revision; await tracking.one(root.id);
  assert.deepEqual(settings.favorites().ids, [project.id]);
  assert.equal(settings.read().revision, revision); assert.deepEqual(settings.read().settings.projects, [project]);
});
test('a removed root cannot be resurrected by an in-flight scan', async t => {
  const { settings, root, entry, options } = await fixture(t), wait = gate();
  const tracking = createDevRepoTracking({ ...options, scan: async () => { await wait.promise; return { repositories: [entry], partial: false }; } });
  const task = tracking.one(root.id); await settings.update(1, { ...settings.read().settings, devRepos: [] }); wait.release();
  await assert.rejects(task, /changed/); assert.deepEqual(settings.read().settings.projects, []);
  assert.throws(() => tracking.one('unknown'), /saved Dev repo/);
});
test('failed roots do not block healthy roots and diagnostics remain private', async t => {
  const { settings, root, entry, options } = await fixture(t);
  const second = { id: 'second', name: 'Second', path: join(root.path, '..', 'second') }; mkdirSync(second.path);
  await settings.update(1, { ...settings.read().settings, devRepos: [second, root] });
  const tracking = createDevRepoTracking({ ...options, scan: async selected => { if (selected.id === 'second') throw new Error('private diagnostic'); return { repositories: [entry, { error: 'Unreadable' }], partial: true, reason: 'Limit' }; } });
  const result = await tracking.all(); assert.equal(result.scans.second.partial, true); assert.equal(result.scans.root.partial, true);
  assert.equal(result.settings.projects.length, 1); assert.equal(JSON.stringify(result).includes('private diagnostic'), false);
});
test('revision conflicts rebase discoveries without dropping concurrent changes and stop after a bounded retry', async t => {
  const { settings, entry, options } = await fixture(t); const update = settings.update.bind(settings); let attempts = 0;
  settings.update = async (...args) => { if (++attempts === 1) await update(settings.read().revision, { ...settings.read().settings, provider: 'codex' }); return update(...args); };
  const tracking = createDevRepoTracking({ ...options, scan: async () => ({ repositories: [entry] }) });
  const result = await tracking.all(); assert.equal(attempts, 2); assert.equal(result.settings.provider, 'codex'); assert.equal(result.settings.projects.length, 1);
  settings.update = async () => { const error = new Error('conflict'); error.statusCode = 409; throw error; };
  const failing = createDevRepoTracking({ ...options, scan: async () => ({ repositories: [{ ...entry, path: entry.path + '-new' }] }) });
  assert.equal((await failing.all()).scans.root.partial, true);
});

test('the settings capacity produces an explicit partial result without removing saved repositories', async t => {
  const { settings, entry, options } = await fixture(t);
  const snapshot = settings.read();
  snapshot.settings.projects = Array.from({ length: 500 }, (_, i) => ({ id: `saved-${i}`, path: `/existing/${i}` }));
  const tracking = createDevRepoTracking({ ...options, settings: { read: () => snapshot, update: async () => assert.fail('Capacity must not replace saved repositories') }, scan: async () => ({ repositories: [entry], partial: false }) });
  const result = await tracking.all();
  assert.equal(result.settings.projects.length, 500); assert.equal(result.scans.root.partial, true); assert.match(result.scans.root.reason, /500/);
});

test('discovered repositories keep the prepare command detected during the scan', async t => {
  const { settings, root, entry, options } = await fixture(t);
  writeFileSync(join(entry.path, 'package-lock.json'), '{}');
  const tracking = createDevRepoTracking({ ...options, scan: async () => ({ repositories: [{ ...entry, prepare: { source: 'detected', executable: 'npm', args: ['ci'] } }], partial: false, reason: null }) });
  await tracking.one(root.id);
  assert.deepEqual(settings.read().settings.projects[0].prepare, { source: 'detected', executable: 'npm', args: ['ci'] });
});
