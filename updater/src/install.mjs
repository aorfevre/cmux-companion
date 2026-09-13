import { LEGACY_SERVICE_LABEL, LEGACY_UPDATER_LABEL } from '../../server/service-identity.mjs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { defaultPaths, LABELS, INITIAL_STATE } from './constants.mjs';
import { atomicSymlink, atomicWrite, ensurePrivateDir, readJson, writeJson } from './fs-safe.mjs';
import { addWorktree, lockWorktree, primaryWorktree, verifyRepository } from './git.mjs';
import { buildCandidate, validateManifest } from './manifest.mjs';
import { linkedSha, checkCompanionHealth } from './engine.mjs';
import { launchAgentPlist } from './launchd.mjs';
import { acquireLock } from './lock.mjs';
import { UpdateControl } from './control.mjs';
import { run } from './process.mjs';
import { replaceExecutable, assertDataCompatibility, backupData, restoreData } from './data-recovery.mjs';

export function installationConfig({ sourceRoot, repository, paths, port = 3210, frontendPort = 3211, dataDirectory = paths.configRoot, settingsPath = join(dataDirectory, 'settings.sqlite'), tokenFile = join(dataDirectory, 'token') }) {
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Use a GitHub owner/repository without credentials');
  if (![port, frontendPort].every(value => Number.isInteger(value) && value > 1023 && value < 65536) || port === frontendPort) throw new Error('Choose distinct local service ports');
  for (const path of [sourceRoot, dataDirectory, settingsPath, tokenFile]) if (path !== resolve(path)) throw new Error('Installation paths must be absolute');
  const npmPath = join(dirname(process.execPath), 'npm');
  return { schemaVersion: 2, repository, pollSeconds: 300, healthUrl: `http://127.0.0.1:${port}/api/health`, healthTimeoutSeconds: 30, minimumFreeBytes: 536870912,
    dataDirectory, settingsPath, tokenFile, port, frontendPort, dataFiles: [settingsPath, join(dataDirectory, 'core.sqlite')],
    targets: [{ name: 'companion', bundled: true, repositoryPath: sourceRoot, expectedRemote: `https://github.com/${repository}.git`, remote: 'origin', branch: 'main', releaseRoot: paths.companionStore, npmPath,
      entryPoints: ['server/supervisor.mjs', 'dist/server/index.js', 'updater/scripts/local-updater.mjs', 'updater/scripts/bootstrap.mjs', 'updater/scripts/launch-companion.mjs'], verificationCommands: [[npmPath, 'run', 'verify']] }],
  };
}

export async function assertMigrationReady({ paths, existing, migrate, execute = run }) {
  if (await readJson(paths.transaction)) throw new Error('An active transaction must finish or recover before installation');
  if (existing && existing.schemaVersion !== 2 && !migrate) throw new Error('Legacy installation requires --migrate after stopping its identified service and updater owners');
  const labels = existing?.schemaVersion === 1 ? [LEGACY_SERVICE_LABEL, LEGACY_UPDATER_LABEL] : [LABELS.companion, LABELS.updater];
  for (const label of labels) {
    const status = await execute('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { allowFailure: true });
    if (status.code === 0) throw new Error('Stop the identified installed LaunchAgents before explicit installation or migration');
  }
  for (const label of [LABELS.companion, LABELS.updater]) {
    const status = await execute('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { allowFailure: true });
    if (status.code === 0) throw new Error('A bundled service owner is still registered');
  }
}

export async function installBundled({ sourceRoot, repository, migrate = false, paths = defaultPaths(process.env.CMUX_COMPANION_HOME), execute = run, build = buildCandidate, checkHealth = checkCompanionHealth, listenerStopped = async url => { try { await fetch(url, { signal: AbortSignal.timeout(1000) }); return false; } catch { return true; } }, port, frontendPort, dataDirectory, settingsPath, tokenFile }) {
  const existing = await readJson(paths.config);
  // Existing private transport identity must survive reinstall/migration. Values
  // are read from the backed-up plist, never guessed from another account.
  let preservedEnvironment = {}, priorPath = null;
  const priorLabel = existing?.schemaVersion === 1 ? LEGACY_SERVICE_LABEL : LABELS.companion;
  const priorPlist = join(paths.launchAgents, `${priorLabel}.plist`);
  if (existing) {
    try {
      const metadata = await lstat(priorPlist);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Invalid prior launch configuration');
      const parsed = JSON.parse((await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', priorPlist])).stdout);
      const environment = parsed.EnvironmentVariables || {};
      priorPath = typeof environment.PATH === 'string' ? environment.PATH : null;
      preservedEnvironment = Object.fromEntries(['CMUX_COMPANION_VAPID_SUBJECT', 'CMUX_COMPANION_TAILSCALE_PORT', 'CMUX_COMPANION_TAILSCALE_BIN', 'CMUX_SOCKET_PASSWORD_FILE'].filter(key => typeof environment[key] === 'string').map(key => [key, environment[key]]));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await assertMigrationReady({ paths, existing, migrate, execute });
  const config = installationConfig({ sourceRoot: await primaryWorktree(sourceRoot), repository, paths, port: port ?? existing?.port ?? 3210, frontendPort: frontendPort ?? existing?.frontendPort ?? 3211, dataDirectory: dataDirectory ?? existing?.dataDirectory ?? paths.configRoot, settingsPath: settingsPath ?? existing?.settingsPath, tokenFile: tokenFile ?? existing?.tokenFile });
  // Legacy custom storage requires explicit path selection; never guess from a
  // shell export that was not in the actual launch environment.
  if (existing?.schemaVersion === 1 && (!dataDirectory || !tokenFile)) throw new Error('Legacy migration requires explicit data-directory and token-file paths');
  const target = config.targets[0];
  await verifyRepository(target);
  for (const path of [paths.configRoot, paths.stateRoot, paths.libexec, paths.companionStore, join(paths.companionStore, 'releases'), paths.launchAgents, paths.logs]) await ensurePrivateDir(path);
  const unlock = await acquireLock(paths.lock); if (!unlock) throw new Error('Updater transaction is busy');
  const installationId = randomUUID();
  const backupRoot = join(paths.stateRoot, `installation-${installationId}`); await mkdir(backupRoot, { mode: 0o700 });
  const previousSha = await linkedSha(target);
  const oldFiles = new Map();
  let control, priorControl, dataBackup, attemptedStart = false;
  const registered = new Set();
  const legacyPlists = existing?.schemaVersion === 1 ? [LEGACY_SERVICE_LABEL, LEGACY_UPDATER_LABEL].map(label => join(paths.launchAgents, `${label}.plist`)) : [];
  const companionPlist = join(paths.launchAgents, `${LABELS.companion}.plist`), updaterPlist = join(paths.launchAgents, `${LABELS.updater}.plist`);
  try {
    for (const [index, path] of [paths.config, paths.state, paths.bootstrap, paths.launcher, companionPlist, updaterPlist, ...legacyPlists].entries()) {
      try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe installed file'); const bytes = await readFile(path); oldFiles.set(path, { bytes, mode: info.mode & 0o777 }); await atomicWrite(join(backupRoot, `${index}.bak`), bytes); }
      catch (error) { if (error.code !== 'ENOENT') throw error; oldFiles.set(path, null); }
    }
    const sha = (await execute('git', ['-C', sourceRoot, 'rev-parse', 'HEAD^{commit}'])).stdout.trim();
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid source commit');
    const release = join(target.releaseRoot, 'releases', sha);
    let ready = false; try { await validateManifest(target, release, sha); ready = true; } catch { /* Build exact committed source. */ }
    if (!ready) {
      let present = false; try { await lstat(release); present = true; } catch { /* New release. */ }
      if (present) throw new Error('An incomplete release already exists; inspect it before retrying installation');
      await addWorktree(target, release, sha); await build(target, release, sha);
    }
    await lockWorktree(target, release);
    if (previousSha) await assertDataCompatibility(join(target.releaseRoot, 'releases', previousSha), release);
    control = new UpdateControl(paths.control); priorControl = control.read();
    if (priorControl.activeId || priorControl.fence) throw new Error('Update control has unsettled maintenance');
    dataBackup = await backupData({ root: join(backupRoot, 'data'), id: installationId, files: config.dataFiles, previousSha });
    control.checked({ deployedSha: previousSha, observedSha: sha, candidate: { sha } });
    control.request({ id: installationId, sha }); control.fence(installationId, 'installer'); control.start(installationId, 'installer');
    if (previousSha && previousSha !== sha) await atomicSymlink(`releases/${previousSha}`, join(target.releaseRoot, 'previous'));
    await atomicSymlink(`releases/${sha}`, join(target.releaseRoot, 'current'));
    await writeJson(paths.config, config);
    await writeJson(paths.state, { ...INITIAL_STATE, deployedSha: sha, updaterDeployedSha: sha });
    await replaceExecutable(join(release, 'updater/scripts/bootstrap.mjs'), paths.bootstrap);
    await replaceExecutable(join(release, 'updater/scripts/launch-companion.mjs'), paths.launcher);
    const common = { HOME: paths.home, CMUX_COMPANION_HOME: paths.home, PATH: [dirname(process.execPath), ...(priorPath ? [priorPath] : []), join(paths.home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':'), NODE_ENV: 'production', TERM: 'dumb' };
    const env = { ...common, ...preservedEnvironment, CMUX_COMPANION_HOST: '127.0.0.1', CMUX_COMPANION_PORT: String(config.port), CMUX_COMPANION_FRONTEND_PORT: String(config.frontendPort), CMUX_COMPANION_DATA_DIR: config.dataDirectory, CMUX_COMPANION_SETTINGS_DB: config.settingsPath, CMUX_COMPANION_TOKEN_FILE: config.tokenFile, CMUX_COMPANION_UPDATER_CONFIG: paths.config, CMUX_COMPANION_UPDATER_STATE: paths.state, CMUX_COMPANION_UPDATER_CONTROL: paths.control };
    await atomicWrite(companionPlist, launchAgentPlist({ label: LABELS.companion, program: [process.execPath, paths.launcher], keepAlive: true, out: join(paths.logs, 'cmux-companion.log'), error: join(paths.logs, 'cmux-companion.error.log'), env }));
    await atomicWrite(updaterPlist, launchAgentPlist({ label: LABELS.updater, program: [process.execPath, join(target.releaseRoot, 'current/updater/scripts/launch-updater.mjs')], persistent: true, throttleSeconds: 5, out: join(paths.logs, 'cmux-companion-updater.log'), error: join(paths.logs, 'cmux-companion-updater.error.log'), env: common }));
    attemptedStart = true;
    await execute('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, companionPlist]);
    registered.add(LABELS.companion);
    const deadline = Date.now() + 30000; let healthy = false;
    while (Date.now() < deadline) { try { await checkHealth(config.healthUrl, sha); healthy = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 250)); } }
    if (!healthy) throw new Error('Installed service did not become healthy');
    for (const path of legacyPlists) await rm(path, { force: true });
    // Imported legacy enabled state is deliberately not copied into this policy.
    if (existing?.schemaVersion === 1) control.policy(control.status().revision, false);
    control.finish(installationId, { success: true });
    await execute('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, updaterPlist]);
    registered.add(LABELS.updater);
    // Preserve old private configuration and release stores for operator rollback.
    await writeJson(join(backupRoot, 'migration.json'), { previousSha, installedSha: sha, legacy: existing?.schemaVersion === 1 });
    return { sha, automatic: control.status().automatic, backupRoot };
  } catch (error) {
    if (attemptedStart) {
      for (const label of [LABELS.companion, LABELS.updater]) {
        if (!registered.has(label) && (await execute('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { allowFailure: true })).code === 0) throw new Error('An uncertain installation owner appeared; preserve evidence and recover manually');
      }
      for (const label of registered) await execute('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { allowFailure: true });
      const deadline = Date.now() + 15000; let stopped = false;
      while (Date.now() < deadline) {
        const states = await Promise.all([...registered].map(label => execute('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { allowFailure: true })));
        if (states.every(state => state.code !== 0) && await listenerStopped(config.healthUrl)) { stopped = true; break; }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!stopped) throw new Error('Installation failed and a service owner remains; preserve maintenance and recover manually');
    }
    if (dataBackup) await restoreData(dataBackup, config.dataFiles);
    if (control && priorControl) control.change(state => { for (const key of Object.keys(state)) delete state[key]; Object.assign(state, priorControl); });
    if (previousSha) await atomicSymlink(`releases/${previousSha}`, join(target.releaseRoot, 'current'));
    else if (dataBackup) await rm(join(target.releaseRoot, 'current'), { force: true });
    for (const [path, prior] of oldFiles) {
      if (prior) await atomicWrite(path, prior.bytes, prior.mode);
      else await rm(path, { force: true });
    }
    throw error;
  } finally { control?.close(); await unlock(); }
}
