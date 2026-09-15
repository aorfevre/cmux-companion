import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LocalSettings } from '../server/local-settings.mjs';
import { initializeSchema } from '../server/orchestration/storage/schema.mjs';
import { buildCandidate, validateManifest } from '../updater/src/manifest.mjs';
import { assertDataCompatibility, backupData, restoreData } from '../updater/src/data-recovery.mjs';
const source = new URL('../', import.meta.url);
const legacyFile = new URL('./fixtures/updater/local-settings-before-favorites.mjs', import.meta.url);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'data-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = join(root, 'old'), candidate = join(root, 'candidate');
  for (const path of [old, candidate]) {
    await mkdir(join(path, 'server/orchestration/storage'), { recursive: true });
    await copyFile(new URL('server/local-settings.mjs', source), join(path, 'server/local-settings.mjs'));
    await copyFile(new URL('server/orchestration/storage/schema.mjs', source), join(path, 'server/orchestration/storage/schema.mjs'));
  }
  await copyFile(legacyFile, join(old, 'server/local-settings.mjs'));
  const contract = JSON.parse(await readFile(new URL('server/data-contract.json', source), 'utf8'));
  await writeFile(join(candidate, 'server/data-contract.json'), JSON.stringify(contract));
  return { root, old, candidate, contract };
}
test('versioned compatibility admits the legacy favorites migration and schema-stable implementation edits', async t => {
  const { old, candidate, contract } = await fixture(t);
  await assertDataCompatibility(old, candidate);
  await writeFile(join(old, 'server/data-contract.json'), JSON.stringify(contract));
  await writeFile(join(candidate, 'server/local-settings.mjs'), 'compatible implementation edit');
  await assertDataCompatibility(old, candidate);
  for (const invalid of [{ ...contract, settings: 3 }, { ...contract, orchestration: 2 }, { ...contract, version: 2 }, { ...contract, settings: -1 }, { ...contract, extra: true }, null]) {
    await writeFile(join(candidate, 'server/data-contract.json'), JSON.stringify(invalid));
    await assert.rejects(assertDataCompatibility(old, candidate), { code: 'DATA_COMPATIBILITY' });
  }
  await writeFile(join(candidate, 'server/data-contract.json'), 'invalid JSON');
  await assert.rejects(assertDataCompatibility(old, candidate), { code: 'DATA_COMPATIBILITY' });
  await writeFile(join(candidate, 'server/data-contract.json'), ' '.repeat(1025));
  await assert.rejects(assertDataCompatibility(old, candidate), { code: 'DATA_COMPATIBILITY' });
  await rm(join(candidate, 'server/data-contract.json'));
  await symlink(join(old, 'server/data-contract.json'), join(candidate, 'server/data-contract.json'));
  await assert.rejects(assertDataCompatibility(old, candidate), { code: 'DATA_COMPATIBILITY' });
});
test('unknown legacy implementations cannot borrow a candidate compatibility declaration', async t => {
  const { old, candidate } = await fixture(t);
  await writeFile(join(old, 'server/local-settings.mjs'), 'unknown settings implementation');
  await assert.rejects(assertDataCompatibility(old, candidate), { code: 'DATA_COMPATIBILITY' });
});
test('archived pre-favorites reader can read and write populated upgraded data, and backup restores the exact prior state', async t => {
  const { root, contract } = await fixture(t);
  const archived = await readFile(legacyFile, 'utf8');
  assert.equal(createHash('sha256').update(archived).digest('hex'), '82e6ec9beaf625545c8ca55813819446f29da43a293ad1d27a36c332fa35c042');
  const rewritten = archived.replaceAll("'./model-options.mjs'", JSON.stringify(new URL('server/model-options.mjs', source).href)).replaceAll("'./dev-repositories.mjs'", JSON.stringify(new URL('server/dev-repositories.mjs', source).href));
  const { LocalSettings: PreviousSettings } = await import(`data:text/javascript;base64,${Buffer.from(rewritten).toString('base64')}`);
  const path = join(root, 'settings.sqlite');
  let old = new PreviousSettings({ path });
  const settings = old.read().settings;
  settings.projects.push({ id: 'p', name: 'Existing', path: join(root, 'repo'), enabled: true, github: 'example/repo', remote: 'git@github.com:example/repo.git', checks: [{ id: 'test', executable: 'npm', args: ['test'] }] });
  await old.update(0, settings, { inspect: async path => ({ path }) });
  const snapshot = old.snapshotGoal('existing-goal', 'p'), prior = old.read(); old.close();
  const backup = await backupData({ root: join(root, 'backup'), id: 'migration', files: [path], previousSha: 'a'.repeat(40) });
  let current = new LocalSettings({ path });
  assert.equal(Number(current.db.prepare('PRAGMA user_version').get().user_version), contract.settings);
  current.setFavorite(prior.revision, 'p', true);
  const teamSettings = current.read().settings;
  teamSettings.launchProfiles = [{ id: 'test-profile', label: 'Retained profile', provider: 'codex', command: { executable: 'codex', args: [], model: 'default' }, roles: ['planner', 'implementer', 'reviewer', 'integrator'], enabled: true }];
  teamSettings.teamDefaults = { planner: 'test-profile', implementer: 'test-profile', reviewer: 'test-profile', integrator: 'test-profile' };
  await current.update(current.read().revision, teamSettings); current.close();
  old = new PreviousSettings({ path });
  assert.deepEqual(old.read().settings, prior.settings); assert.deepEqual(old.goalConfiguration('existing-goal'), snapshot);
  await old.update(old.read().revision, { ...old.read().settings, provider: 'codex' }); old.close();
  current = new LocalSettings({ path });
  assert.deepEqual(current.favorites().ids, ['p']); assert.equal(current.read().settings.provider, 'codex');
  assert.deepEqual(current.read().settings.launchProfiles, teamSettings.launchProfiles);
  assert.deepEqual(current.read().settings.teamDefaults, teamSettings.teamDefaults);
  assert.deepEqual(current.goalConfiguration('existing-goal'), snapshot); current.close();
  await restoreData(backup, [path]);
  old = new PreviousSettings({ path }); assert.deepEqual(old.read(), prior); assert.deepEqual(old.goalConfiguration('existing-goal'), snapshot); old.close();
  const db = new DatabaseSync(':memory:');
  try { initializeSchema(db); assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), contract.orchestration); } finally { db.close(); }
});

test('release validation binds the data compatibility declaration to its built manifest', async t => {
  const { candidate } = await fixture(t);
  await mkdir(join(candidate, 'updater/scripts'), { recursive: true });
  for (const path of ['package.json', 'package-lock.json', ...['local-updater.mjs', 'bootstrap.mjs', 'launch-companion.mjs'].map(name => `updater/scripts/${name}`)]) await writeFile(join(candidate, path), '{}');
  const target = { name: 'companion', bundled: true, entryPoints: ['server/local-settings.mjs'] }, sha = 'a'.repeat(40);
  await buildCandidate(target, candidate, sha, null, { execute: async () => ({ stdout: '10.9.2' }) });
  await validateManifest(target, candidate, sha);
  await writeFile(join(candidate, 'server/data-contract.json'), '{}');
  await assert.rejects(validateManifest(target, candidate, sha), /Data contract digest/);
  await rm(join(candidate, 'server/data-contract.json'));
  await assert.rejects(validateManifest(target, candidate, sha), /Data contract digest/);
});
