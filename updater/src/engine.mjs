import { supervisedBuildRunner } from './build-process.mjs';
import { access, readlink, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { defaultPaths, LABELS } from './constants.mjs';
import { loadConfig } from './config.mjs';
import { atomicSymlink, writeJson, sha256, assertPathInside } from './fs-safe.mjs';
import { verifyRepository, addWorktree, lockWorktree, ensureDiskSpace } from './git.mjs';
import { buildCandidate, validateManifest, MANIFEST } from './manifest.mjs';
import { run } from './process.mjs';
import { health } from './health.mjs';
import { UpdateControl, exactSha } from './control.mjs';
import { GitHubUpdates } from './eligibility.mjs';
import { updateCycle } from './transaction.mjs';
import { assertDataCompatibility, backupData, restoreData, replaceExecutable } from './data-recovery.mjs';
import { recordRelease, retention } from './retention.mjs';
export { checkCompanionHealth } from './health.mjs';

export async function linkedSha(target, name = 'current') {
  try {
    const linked = await readlink(join(target.releaseRoot, name));
    const sha = basename(linked);
    if (!/^[0-9a-f]{40}$/.test(sha) || linked !== `releases/${sha}`) return null;
    await access(join(target.releaseRoot, 'releases', sha)); return sha;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function deploymentNeedsActivation(remoteSha, deployedSha, physicalSha, quarantinedSha) {
  return remoteSha !== quarantinedSha && (remoteSha !== deployedSha || remoteSha !== physicalSha);
}

export function nativeUpdateAdapter({ paths, config, control, github, fetchImpl = fetch, execute = run }) {
  const target = config.targets[0];
  const release = sha => join(target.releaseRoot, 'releases', exactSha(sha));
  const operator = async (action, id, serviceId) => {
    const token = (await import('node:fs/promises')).readFile(config.tokenFile, 'utf8');
    const response = await fetchImpl(new URL('/api/updater/maintenance', config.healthUrl), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${(await token).trim()}` }, body: JSON.stringify({ action, id, ...(serviceId ? { serviceId } : {}) }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Maintenance handshake failed');
    return response.json();
  };
  const service = `gui/${process.getuid()}/${LABELS.companion}`;
  return {
    maintenance: id => operator('acquire', id),
    verifyFence: (id, serviceId) => operator('verify', id, serviceId),
    async prepare(sha) {
      await verifyRepository(target);
      const previousSha = await linkedSha(target); exactSha(previousSha);
      await github.revalidate(previousSha, sha);
      await execute('git', ['-C', target.repositoryPath, 'fetch', '--no-tags', target.remote, 'refs/heads/main'], { timeoutMs: 120000 });
      // Candidate can be an older successful main commit; never substitute FETCH_HEAD.
      await execute('git', ['-C', target.repositoryPath, 'merge-base', '--is-ancestor', sha, 'FETCH_HEAD']);
      await execute('git', ['-C', target.repositoryPath, 'merge-base', '--is-ancestor', previousSha, sha]);
      await ensureDiskSpace(target.releaseRoot, config.minimumFreeBytes);
      const path = release(sha); await assertPathInside(join(target.releaseRoot, 'releases'), path, { allowMissing: true });
      let built = false;
      try { await access(join(path, MANIFEST)); built = true; } catch { /* Resume an owned incomplete build. */ }
      if (!built) {
        let exists = false; try { await access(path); exists = true; } catch { /* New candidate. */ }
        if (!exists) { await addWorktree(target, path, sha); await recordRelease(paths, target, sha, 'staging'); }
        const actual = (await execute('git', ['-C', path, 'rev-parse', 'HEAD'])).stdout.trim();
        if (actual !== sha) throw new Error('Candidate identity changed');
        await buildCandidate(target, path, sha, null, { execute: supervisedBuildRunner(join(paths.stateRoot, 'builds', control.read().activeId)) });
      }
      await validateManifest(target, path, sha); await lockWorktree(target, path);
      await assertDataCompatibility(release(previousSha), path);
      await recordRelease(paths, target, sha, 'verified'); return path;
    },
    async backup(id) {
      const previousSha = await linkedSha(target); exactSha(previousSha);
      return backupData({ root: join(paths.stateRoot, 'backups'), id, files: config.dataFiles, previousSha });
    },
    async activate(sha) {
      await validateManifest(target, release(sha), sha);
      const old = await linkedSha(target);
      if (old && old !== sha) await atomicSymlink(`releases/${old}`, join(target.releaseRoot, 'previous'));
      await atomicSymlink(`releases/${sha}`, join(target.releaseRoot, 'current'));
    },
    async restart() {
      const present = await execute('/bin/launchctl', ['print', service], { allowFailure: true });
      if (present.code !== 0) await execute('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, join(paths.launchAgents, `${LABELS.companion}.plist`)]);
      await execute('/bin/launchctl', ['kickstart', '-k', service], { timeoutMs: 15000 });
    },
    async stop() {
      await execute('/bin/launchctl', ['bootout', service], { allowFailure: true });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const status = await execute('/bin/launchctl', ['print', service], { allowFailure: true });
        if (status.code !== 0) {
          // Require the listener gone too before overwriting any SQLite files.
          try { await fetchImpl(config.healthUrl, { signal: AbortSignal.timeout(1000) }); }
          catch { return; }
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error('Previous application process has not stopped');
    },
    restore: backup => restoreData(backup, config.dataFiles),
    health: sha => health(config.healthUrl, sha, config.healthTimeoutSeconds, { fetchImpl }),
    async accept(sha) {
      const path = release(sha); await validateManifest(target, path, sha);
      await replaceExecutable(join(path, 'updater/scripts/bootstrap.mjs'), paths.bootstrap);
      await replaceExecutable(join(path, 'updater/scripts/launch-companion.mjs'), paths.launcher);
      await recordRelease(paths, target, sha, 'success');
    },
    async recoveryRecord() {
      const state = control.read(), item = state.activeId ? state.requests[state.activeId] : null;
      if (!item) { await rm(paths.transaction, { force: true }); return; }
      // Bootstrap must resume with the old engine, even after current switched.
      const engine = resolve(process.argv[1]);
      await writeJson(paths.transaction, { schemaVersion: 2, id: item.id, target: 'companion', candidateSha: item.sha, recoveryEngine: engine, expectedEngineDigest: await sha256(engine) });
    },
  };
}

export async function runEngine({ paths = defaultPaths(process.env.CMUX_COMPANION_HOME), now = new Date(), resumeId = null, configPath = paths.config, createGitHub = repository => new GitHubUpdates({ repository }), createAdapter = nativeUpdateAdapter } = {}) {
  const config = await loadConfig(configPath);
  const control = new UpdateControl(paths.control);
  try {
    if (resumeId && control.read().activeId !== resumeId) { await rm(paths.transaction, { force: true }); return; }
    const github = createGitHub(config.repository);
    const adapter = createAdapter({ paths, config, control, github });
    const wrapped = { ...adapter, prepare: async sha => { await adapter.recoveryRecord(); return adapter.prepare(sha); } };
    await updateCycle({ control, discover: sha => github.discover(sha), revalidate: (base, sha) => github.revalidate(base, sha), deployedSha: await linkedSha(config.targets[0]), maintenance: adapter.maintenance, adapter: wrapped, now: now.getTime(), intervalMs: config.pollSeconds * 1000 });
    await adapter.recoveryRecord();
    const status = control.status();
    await writeJson(paths.state, { deployedSha: status.deployedSha, observedRemoteSha: status.observedSha, updaterDeployedSha: status.deployedSha, updaterObservedRemoteSha: status.observedSha, pendingSha: status.request?.status === 'running' ? status.request.sha : null, phase: status.request?.status === 'running' ? status.request.phase : 'idle', lastCheckAt: status.lastCheckAt, lastHeartbeatAt: new Date().toISOString(), lastError: status.request?.error ?? status.checkError });
    if (!control.read().activeId && !control.read().fence) await retention(paths, config, { command: 'scheduled', locked: true });
  } finally { control.close(); }
}
