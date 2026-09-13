import { DatabaseSync, backup } from 'node:sqlite';
import { lstat, readFile, rm, copyFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDir, sha256, writeJson, readJson, atomicWrite } from './fs-safe.mjs';

const CONTRACT_FILES = ['server/local-settings.mjs', 'server/orchestration/storage/schema.mjs'];
export async function assertDataCompatibility(previous, candidate) {
  // Initial updater accepts unchanged migration code only. A schema-changing
  // release needs a separately verified migration contract, not optimistic rollback.
  for (const path of CONTRACT_FILES) if (await sha256(join(previous, path)) !== await sha256(join(candidate, path))) throw new Error('Update changes the data contract; explicit migration is required');
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
