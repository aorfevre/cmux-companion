import { DatabaseSync, backup } from 'node:sqlite';
import { lstat, readFile, rm, copyFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDir, sha256, writeJson, readJson, atomicWrite } from './fs-safe.mjs';

const CONTRACT_FILES = ['server/local-settings.mjs', 'server/orchestration/storage/schema.mjs'];
// Immutable fingerprints identify the two legacy settings implementations whose
// additive favorites compatibility is exercised with the archived reader fixture.
const LEGACY_SETTINGS = new Set([
  '82e6ec9beaf625545c8ca55813819446f29da43a293ad1d27a36c332fa35c042',
  'fe85e7672a9ea77d780d5e6e35c7e66fa838a4878d1a0bd4717ce0bcb88150fa',
]);
const LEGACY_CORE = '564255c30427e672335236cb9046da8ad246986ba8d00577546ff1efcf28ec1c';
const compatibilityError = () => Object.assign(new Error('Update changes the data contract; explicit migration is required'), { code: 'DATA_COMPATIBILITY' });
async function dataContract(root, hashes) {
  const file = join(root, 'server/data-contract.json');
  let info;
  try { info = await lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!info) return LEGACY_SETTINGS.has(hashes[0]) && hashes[1] === LEGACY_CORE ? { version: 1, settings: 2, orchestration: 1 } : null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw compatibilityError();
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); } catch { throw compatibilityError(); }
  if (!value || Object.keys(value).sort().join(',') !== 'orchestration,settings,version' || value.version !== 1
      || !Number.isSafeInteger(value.settings) || value.settings < 1 || !Number.isSafeInteger(value.orchestration) || value.orchestration < 1) throw compatibilityError();
  return value;
}
export async function assertDataCompatibility(previous, candidate) {
  const hashes = await Promise.all([previous, candidate].map(root => Promise.all(CONTRACT_FILES.map(path => sha256(join(root, path))))));
  const [before, after] = await Promise.all([dataContract(previous, hashes[0]), dataContract(candidate, hashes[1])]);
  // Legacy-to-legacy releases retain the original strict fallback. Declared
  // contracts separate compatible implementation edits from data-format changes.
  if (!before && !after && hashes[0].every((hash, index) => hash === hashes[1][index])) return;
  if (!before || !after || before.settings !== after.settings || before.orchestration !== after.orchestration) throw compatibilityError();
}
export async function backupData({ root, id, files, previousSha }) {
  const directory = join(root, id); await ensurePrivateDir(directory);
  const manifestPath = join(directory, 'backup.json');
  const prior = await readJson(manifestPath);
  if (prior) { if (prior.previousSha !== previousSha || JSON.stringify(prior.files.map(item => item.path)) !== JSON.stringify(files)) throw new Error('Backup identity mismatch'); return prior; }
  const entries = [];
  for (const [index, path] of files.entries()) {
    let info;
    try { info = await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const destination = join(directory, `${index}.sqlite`);
    if (info) {
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe database backup source');
      const db = new DatabaseSync(path, { readOnly: true });
      try { await backup(db, destination); } finally { db.close(); }
      await chmod(destination, 0o600);
    }
    entries.push({ path, backup: destination, existed: Boolean(info), digest: info ? await sha256(destination) : null });
  }
  const manifest = { previousSha, files: entries };
  await writeJson(manifestPath, manifest); return manifest;
}
export async function restoreData(manifest, approvedFiles) {
  if (JSON.stringify(manifest.files.map(item => item.path)) !== JSON.stringify(approvedFiles)) throw new Error('Backup destinations changed');
  for (const item of manifest.files) {
    if (item.existed && await sha256(item.backup) !== item.digest) throw new Error('Backup digest changed');
    for (const path of [item.path, `${item.path}-wal`, `${item.path}-shm`]) {
      try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe restore destination'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  for (const item of manifest.files) {
    for (const suffix of ['-wal', '-shm']) await rm(`${item.path}${suffix}`, { force: true });
    if (item.existed) await atomicWrite(item.path, await readFile(item.backup), 0o600);
    else await rm(item.path, { force: true });
  }
}
export async function replaceExecutable(source, destination) {
  // Executable content is verified through the release manifest before this call.
  const temporary = `${destination}.next`;
  await copyFile(source, temporary); await chmod(temporary, 0o700);
  await atomicWrite(destination, await readFile(temporary), 0o700); await rm(temporary);
}
