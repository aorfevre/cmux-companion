import { execFile } from 'node:child_process';
import { mkdirSync, realpathSync, lstatSync, renameSync, copyFileSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { DomainError, identifier, requireValue, sha, branchName } from '../domain/contracts.mjs';
import { randomUUID } from 'node:crypto';
import { git, pathExists } from './git.mjs';

/** Remote operations run in an isolated bare repository, so target-repository
 * URL rewrites, credential helpers and remote hooks cannot control publication.
 * The composition supplies each allowed destination and its transport policy.
 */
export class GitRemote {
  /** @param {{ repositories: import('./git.mjs').GitRepository; directory: string; destinations: ReadonlyMap<string, { url: string; protocol: 'file' | 'ssh' | 'https'; env: NodeJS.ProcessEnv }>; baseFiles?: { copyFileSync: typeof copyFileSync; renameSync: typeof renameSync; rmSync: typeof rmSync } }} options */
  constructor({ repositories, directory, destinations, baseFiles = { copyFileSync, renameSync, rmSync } }) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.baseFiles = baseFiles;
    this.directory = realpathSync(directory); this.repositories = repositories; this.destinations = destinations;
    /** @type {Map<string,Promise<string>>} */ this.initializations = new Map();
  }
  /** @param {string} repositoryId */
  destination(repositoryId) {
    identifier(repositoryId); const policy = this.destinations.get(repositoryId);
    requireValue(policy, 'Publication destination is not configured', 'UNSUPPORTED_CAPABILITY');
    if (policy.protocol === 'file') requireValue(isAbsolute(policy.url) && realpathSync(policy.url) === policy.url, 'Local remote identity changed', 'OWNERSHIP_UNCERTAIN');
    else {
      const url = new URL(policy.url);
      requireValue(url.protocol === `${policy.protocol}:` && !url.password && (policy.protocol === 'ssh' || !url.username) && !url.search && !url.hash, 'Unsupported remote URL');
    }
    return policy;
  }
  /** @param {string} repositoryId */
  identity(repositoryId) { const policy = this.destination(repositoryId); return `${policy.protocol}:${policy.url}`; }
  /** @param {string} repositoryId */
  async stage(repositoryId) {
    this.destination(repositoryId);
    requireValue(realpathSync(this.directory) === this.directory, 'Remote staging directory changed', 'OWNERSHIP_UNCERTAIN');
    const directory = join(this.directory, repositoryId);
    const pending = this.initializations.get(repositoryId);
    if (pending) await pending;
    else if (!pathExists(directory)) {
      mkdirSync(directory, { mode: 0o700 });
      const initialize = git(directory, ['init', '--bare', '--initial-branch=main']); this.initializations.set(repositoryId, initialize);
      try { await initialize; } finally { this.initializations.delete(repositoryId); }
    }
    requireValue(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink() && realpathSync(directory) === directory, 'Remote staging repository changed', 'OWNERSHIP_UNCERTAIN');
    requireValue((await git(directory, ['rev-parse', '--is-bare-repository'])).trim() === 'true', 'Remote staging repository is not bare', 'OWNERSHIP_UNCERTAIN');
    return directory;
  }
  /** @param {string} repositoryId @param {string[]} argv @param {()=>boolean} [beforeSend] */
  async remote(repositoryId, argv, beforeSend) {
    const policy = this.destination(repositoryId), cwd = await this.stage(repositoryId);
    if (beforeSend && !beforeSend()) return '';
    return new Promise((resolve, reject) => {
      const child = execFile('git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', `protocol.${policy.protocol}.allow=always`, ...argv], {
        cwd, env: { PATH: policy.env.PATH, HOME: policy.env.HOME, SSH_AUTH_SOCK: policy.env.SSH_AUTH_SOCK, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' },
        timeout: 30000, maxBuffer: 1024 * 1024,
      }, (error, stdout) => error ? reject(new DomainError(child.pid === undefined ? 'EXTERNAL_NOT_SENT' : 'REMOTE_OPERATION_UNCERTAIN', 'Remote operation did not return confirmed success')) : resolve(stdout));
    });
  }
  /** @param {string} repositoryId @param {string} branch */
  async head(repositoryId, branch) {
    branchName(branch);
    const output = String(await this.remote(repositoryId, ['ls-remote', '--refs', this.destination(repositoryId).url, `refs/heads/${branch}`])).trim();
    if (!output) return null;
    const entries = output.split('\n'); requireValue(entries.length === 1, 'Remote branch is ambiguous', 'OWNERSHIP_UNCERTAIN');
    const [head, ref] = entries[0].split('\t');
    requireValue(ref === `refs/heads/${branch}`, 'Remote returned another branch', 'OWNERSHIP_UNCERTAIN');
    return sha(head);
  }
  /** Fetch into private staging, then import immutable objects without moving any user refs.
   * @param {string} repositoryId @param {string} branch */
  async fetchBase(repositoryId, branch) {
    branchName(branch);
    const directory = await this.stage(repositoryId);
    const ref = `refs/companion/fetch/${randomUUID()}`;
    try {
      await this.remote(repositoryId, ['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', this.destination(repositoryId).url, `refs/heads/${branch}:${ref}`]);
    } catch {
      throw new DomainError('BASE_FETCH_FAILED', `Could not fetch ${branch}. Check that the branch exists and GitHub access is available, then retry startup.`);
    }
    const head = sha((await git(directory, ['rev-parse', `${ref}^{commit}`])).trim());
    const { repository, common } = await this.repositories.repository(repositoryId);
    const prefix = join(directory, `base-${randomUUID()}`);
    const digest = sha((await git(directory, ['pack-objects', '--revs', prefix], `${head}\n`)).trim());
    for (const extension of ['pack', 'idx']) {
      const source = `${prefix}-${digest}.${extension}`;
      const destination = join(common, 'objects', 'pack', `pack-${digest}.${extension}`);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        // Copy across volumes, then publish atomically on the repository's own volume.
        this.baseFiles.copyFileSync(source, temporary);
        this.baseFiles.renameSync(temporary, destination);
      } finally {
        this.baseFiles.rmSync(temporary, { force: true });
        this.baseFiles.rmSync(source, { force: true });
      }
    }
    await git(repository, ['cat-file', '-e', `${head}^{commit}`]);
    return head;
  }
  /** @param {Parameters<import('../types.d.ts').RemotePort['push']>[0]} input @param {{ beforeSend?: ()=>boolean }} [options] */
  async push({ repositoryId, branch, headSha, expectedHead }, { beforeSend } = {}) {
    sha(headSha); if (expectedHead !== null) sha(expectedHead);
    branchName(branch);
    const { repository } = await this.repositories.repository(repositoryId);
    const directory = await this.stage(repositoryId);
    // Git writes pack/index files directly to private disk; reachable history is
    // not buffered in Node or limited by a stdout collection budget.
    const prefix = join(directory, `incoming-${randomUUID()}`);
    const digest = sha((await git(repository, ['pack-objects', '--revs', prefix], `${headSha}\n`)).trim());
    for (const extension of ['pack', 'idx']) renameSync(`${prefix}-${digest}.${extension}`, join(directory, 'objects', 'pack', `pack-${digest}.${extension}`));
    await git(directory, ['cat-file', '-e', `${headSha}^{commit}`]);
    await this.remote(repositoryId, ['push', '--porcelain', `--force-with-lease=refs/heads/${branch}:${expectedHead ?? ''}`, this.destination(repositoryId).url, `${headSha}:refs/heads/${branch}`], beforeSend);
  }
}
