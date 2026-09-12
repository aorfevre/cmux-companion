import { existsSync, linkSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { LocalSettings } from '../server/local-settings.mjs';
import { loadProductionConfig } from '../server/orchestration/production.mjs';

export async function importSettings({ database, configPath, modelsPath }) {
  if (!database || !isAbsolute(database) || !configPath && !modelsPath) throw new TypeError('Supply an absolute settings database and at least one private configuration source');
  const orchestration = configPath ? loadProductionConfig(configPath) : undefined;
  let models;
  if (modelsPath) {
    const stat = lstatSync(modelsPath);
    if (!isAbsolute(modelsPath) || !stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 1048576) throw new TypeError('Model settings must be a private regular file');
    models = JSON.parse(readFileSync(modelsPath, 'utf8'));
  }
  const temporary = existsSync(database) ? null : `${database}.import-${randomUUID()}`;
  const settings = new LocalSettings({ path: temporary || database });
  let result;
  try { result = await settings.importLegacy(0, { orchestration, models }); }
  catch (error) { settings.close(); if (temporary) rmSync(temporary, { force: true }); throw error; }
  settings.close();
  if (temporary) {
    try { linkSync(temporary, database); } // Exclusive publication; never overwrite a concurrent owner.
    finally { rmSync(temporary, { force: true }); }
  }
  return { revision: result.revision, projects: result.settings.projects.length };
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const options = {}, names = { '--database': 'database', '--config': 'configPath', '--models': 'modelsPath' };
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = names[process.argv[index]];
      if (!key || !process.argv[index + 1] || options[key]) throw new TypeError('Usage: node scripts/import-settings.mjs --database /private/settings.sqlite [--config /private/orchestration.json] [--models /private/model-settings.json]');
      options[key] = process.argv[index + 1];
    }
    const result = await importSettings(options);
    console.log(`Imported ${result.projects} projects into settings revision ${result.revision}. Source files were preserved.`);
  } catch { console.error('Settings import failed. Check private source permissions, supported fields, accessible Git roots and an unconfigured destination. No credentials are printed.'); process.exitCode = 1; }
}
