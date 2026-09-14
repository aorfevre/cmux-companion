import { setTimeout as delay } from 'node:timers/promises';
import { trackGitCommand } from './git-process-scope.mjs';
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DomainError, identifier, requireValue, sha } from '../domain/contracts.mjs';
import { ownedArea } from '../domain/graph.mjs';

/** Local Git operations use fixed argv and no inherited credential/config hooks.
 * No fetch/push or checkout of submodules is performed by this adapter.
 * @param {string} cwd @param {string[]} argv @param {string | Buffer} [input] @param {boolean} [allowConflict]
 * @returns {Promise<Buffer>} 
 */
export async function gitBytes(cwd, argv, input, allowConflict = false) {
  const tracked = trackGitCommand();
  const args = ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'protocol.allow=never', ...argv];
  const env = { PATH: process.env.PATH, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' };
  if (tracked) return trackedGitBytes(cwd, args, env, input, allowConflict, tracked);
  return new Promise((resolveResult, reject) => {
    const child = execFile('git', args, { cwd, env, timeout: 30000, maxBuffer: 16 * 1024 * 1024, encoding: null }, (error, stdout) => {
      if (error && !(allowConflict && error.code === 1)) reject(Object.assign(new DomainError('GIT_OPERATION_FAILED', 'Local Git operation failed; reconcile recorded repository evidence'), { exitCode: error.code }));
      else resolveResult(stdout);
    });
    // Git may reject a command before consuming stdin. Its exit callback owns
    // the operation result; a broken pipe must not escape as an uncaught error.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

/** spawn is required: execFile does not forward detached to its child.
 * @param {string} cwd @param {string[]} argv @param {NodeJS.ProcessEnv} env
 * @param {string|Buffer|undefined} input @param {boolean} allowConflict
 * @param {NonNullable<ReturnType<typeof trackGitCommand>>} tracked
 * @returns {Promise<Buffer>} */
function trackedGitBytes(cwd, argv, env, input, allowConflict, tracked) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('git', argv, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    /** @type {Buffer[]} */ const output = []; let stdoutSize = 0, stderrSize = 0, settled = false, interrupted = false;
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let escalation;
    /** @type {unknown} */ let identityError;
    let cleanupDeadline = 0;
    const failure = (/** @type {unknown} */ code) => Object.assign(new DomainError('GIT_OPERATION_FAILED', 'Local Git operation failed; reconcile recorded repository evidence'), { exitCode: code });
    const finish = async (/** @type {unknown} */ error, neverSpawned = false) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(escalation);
      try {
        let stopped = tracked.complete(child.pid, neverSpawned);
        // A successful leader close can precede short-lived group cleanup. Wait
        // briefly for actual ESRCH evidence; elapsed time never proves stopped.
        let deadline = interrupted ? cleanupDeadline : Date.now() + 250;
        while (!stopped && (!error || interrupted) && Date.now() < deadline) {
          await delay(10); stopped = tracked.complete(child.pid, neverSpawned);
        }
        if (!stopped && interrupted) {
          // Leader close does not discharge its descendants. finish owns the
          // escalation after cancelling the timer, including an early close.
          signal('SIGKILL'); deadline = Date.now() + 250;
          while (!stopped && Date.now() < deadline) {
            await delay(10); stopped = tracked.complete(child.pid, neverSpawned);
          }
        }
        if (!stopped && !error) error = new DomainError('OWNERSHIP_UNCERTAIN', 'Git process group has not stopped');
      } catch (evidenceError) { error = evidenceError; }
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (error) reject(error); else resolveResult(Buffer.concat(output));
    };
    const signal = (/** @type {NodeJS.Signals} */ value) => { if (child.pid !== undefined) { try { process.kill(-child.pid, value); } catch { /* Group state remains independently observed. */ } } };
    const stop = () => {
      if (interrupted || settled) return; interrupted = true; cleanupDeadline = Date.now() + 250; signal('SIGTERM');
      escalation = setTimeout(() => { signal('SIGKILL'); finish(failure('TERMINATED')); }, 250);
    };
    const timer = setTimeout(stop, 30000);
    child.on('error', error => finish(failure(/** @type {NodeJS.ErrnoException} */ (error).code), child.pid === undefined));
    child.stdin.on('error', () => { /* Git may reject input before reading it; close supplies its exit code. */ });
    child.stdout.on('data', chunk => { stdoutSize += chunk.length; if (stdoutSize > 16 * 1024 * 1024) stop(); else output.push(chunk); });
    child.stderr.on('data', chunk => { stderrSize += chunk.length; if (stderrSize > 16 * 1024 * 1024) stop(); });
    child.on('close', (code) => finish(identityError ?? (!interrupted && (code === 0 || (allowConflict && code === 1)) ? null : failure(code))));
    if (child.pid !== undefined) {
      try { tracked.identity(child.pid); } catch (error) {
        // Keep the child handle until close can prove its group stopped. Losing
        // the identity write must not turn a reaped child into a boot-only gap.
        identityError = error; interrupted = true; signal('SIGKILL');
        escalation = setTimeout(() => finish(error), 250);
        return;
      }
    }
    child.stdin.end(input);
  });
}

/** @param {string} cwd @param {string[]} argv @param {string | Buffer} [input] */
export async function git(cwd, argv, input) {
  const bytes = await gitBytes(cwd, argv, input);
  const text = bytes.toString('utf8');
  requireValue(Buffer.from(text).equals(bytes), 'Git metadata contains unsupported filename encoding', 'UNSUPPORTED_CAPABILITY');
  return text;
}

/** Unlike existsSync, includes dangling symlinks. @param {string} path */
export function pathExists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return false; throw error; }
}

/** @typedef {{ schemaVersion: 1; operationId: string; repositoryId: string; repository: string; common: string; worktree: string; branch: string; baseSha: string }} Resource */
export class GitRepository {
  /** @param {{ repositories: ReadonlyMap<string,string>; directory: string; artifacts: import('../storage/artifacts.mjs').ArtifactStore; failpoint?: (point: 'reserved' | 'worktree_created') => void }} options */
  constructor({ repositories, directory, artifacts, failpoint = () => {} }) {
    this.repositories = repositories; this.artifacts = artifacts; this.failpoint = failpoint;
    requireValue(directory.length > 0, 'Explicit repository resource directory required');
    mkdirSync(resolve(directory), { recursive: true, mode: 0o700 });
    this.directory = realpathSync(directory);
    this.manifests = join(this.directory, 'manifests'); this.worktrees = join(this.directory, 'worktrees');
    for (const path of [this.manifests, this.worktrees]) {
      mkdirSync(path, { recursive: true, mode: 0o700 }); requireValue(!lstatSync(path).isSymbolicLink(), 'Resource directory is a symlink');
    }
  }
  /** @param {string} repositoryId */
  async repository(repositoryId) {
    identifier(repositoryId); const configured = this.repositories.get(repositoryId);
    requireValue(configured, 'Repository is not allowed', 'FORBIDDEN');
    const repository = realpathSync(configured);
    requireValue((await git(repository, ['rev-parse', '--show-toplevel'])).trim() === repository, 'Repository root changed', 'OWNERSHIP_UNCERTAIN');
    const common = realpathSync((await git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    // Local filter configuration could execute a smudge/clean process during
    // checkout. Unsupported filters fail before any worktree mutation.
    let filters = '';
    try { filters = await git(repository, ['config', '--get-regexp', '^(filter\\.|merge\\..*\\.driver$)']); }
    catch (error) { if (/** @type {{exitCode?: unknown}} */ (error).exitCode !== 1) throw error; }
    requireValue(!filters, 'Repository filters/merge drivers require an explicit supported adapter policy', 'UNSUPPORTED_CAPABILITY');
    return { repository, common };
  }
  /** @param {string} operationId @returns {Resource | null} */
  resource(operationId) {
    identifier(operationId); const path = join(this.manifests, `${operationId}.json`);
    for (const directory of [this.directory, this.manifests, this.worktrees]) requireValue(realpathSync(directory) === directory && !lstatSync(directory).isSymbolicLink(), 'Resource directory identity changed', 'OWNERSHIP_UNCERTAIN');
    if (!pathExists(path)) return null;
    requireValue(!lstatSync(path).isSymbolicLink(), 'Resource manifest is a symlink', 'OWNERSHIP_UNCERTAIN');
    const resource = JSON.parse(readFileSync(path, 'utf8'));
    requireValue(resource.schemaVersion === 1 && resource.operationId === operationId && resource.worktree === join(this.worktrees, operationId), 'Resource manifest identity changed', 'OWNERSHIP_UNCERTAIN');
    return resource;
  }
  /** @param {string} repository @param {string} ref */
  async ref(repository, ref) {
    try { return (await git(repository, ['rev-parse', '--verify', '--quiet', ref])).trim(); }
    catch (error) { if (/** @type {{exitCode?: unknown}} */ (error).exitCode === 1) return null; throw error; }
  }
  /** @param {Resource} resource @param {boolean} [clean] */
  async checkCheckout(resource, clean = true) {
    requireValue(!lstatSync(resource.worktree).isSymbolicLink() && realpathSync(resource.worktree) === resource.worktree, 'Recorded worktree path changed', 'OWNERSHIP_UNCERTAIN');
    const common = realpathSync((await git(resource.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    const gitDirectory = realpathSync((await git(resource.worktree, ['rev-parse', '--absolute-git-dir'])).trim());
    requireValue(lstatSync(join(resource.worktree, '.git')).isFile() && realpathSync(readFileSync(join(gitDirectory, 'gitdir'), 'utf8').trim()) === realpathSync(join(resource.worktree, '.git')), 'Worktree registration changed', 'OWNERSHIP_UNCERTAIN');
    requireValue(common === resource.common && (await git(resource.worktree, ['rev-parse', '--show-toplevel'])).trim() === resource.worktree, 'Worktree repository identity changed', 'OWNERSHIP_UNCERTAIN');
    requireValue((await git(resource.worktree, ['symbolic-ref', '--quiet', 'HEAD'])).trim() === `refs/heads/${resource.branch}`, 'Worktree branch changed', 'STALE_TARGET');
    if (clean) requireValue(!(await git(resource.worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])), 'Worktree has uncommitted changes', 'DIRTY_WORKTREE');
    return (await git(resource.worktree, ['rev-parse', 'HEAD'])).trim();
  }
  /** @param {Parameters<import('../types.d.ts').RepositoryPort['provision']>[0]} input */
  async provision({ operationId, repositoryId, branch, baseSha }) {
    identifier(operationId); sha(baseSha);
    requireValue(/^companion\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(branch), 'Branch must be derived from recorded goal and attempt identity');
    const { repository, common } = await this.repository(repositoryId);
    await git(repository, ['check-ref-format', `refs/heads/${branch}`]);
    await git(repository, ['cat-file', '-e', `${baseSha}^{commit}`]);
    const worktree = join(this.worktrees, operationId), ownershipRef = `refs/companion/resources/${operationId}`;
    /** @type {Resource} */ const requested = { schemaVersion: 1, operationId, repositoryId, repository, common, worktree, branch, baseSha };
    let resource = this.resource(operationId);
    if (resource) requireValue(JSON.stringify(resource) === JSON.stringify(requested), 'Provisioning identity was reused', 'IDEMPOTENCY_CONFLICT');
    else {
      requireValue(!pathExists(worktree) && !(await this.ref(repository, `refs/heads/${branch}`)) && !(await this.ref(repository, ownershipRef)), 'Provisioning resources already exist without ownership', 'OWNERSHIP_UNCERTAIN');
      writeFileSync(join(this.manifests, `${operationId}.json`), JSON.stringify(requested), { mode: 0o600, flag: 'wx' }); resource = requested;
    }
    const owned = await this.ref(repository, ownershipRef), branchHead = await this.ref(repository, `refs/heads/${branch}`);
    if (!owned && !branchHead) {
      // Branch and operation evidence are reserved atomically, closing the crash
      // gap between branch creation and its ownership record.
      await git(repository, ['update-ref', '--stdin'], `start\ncreate refs/heads/${branch} ${baseSha}\ncreate ${ownershipRef} ${baseSha}\nprepare\ncommit\n`);
    } else requireValue(owned === baseSha && branchHead === baseSha, 'Reserved Git identity changed', 'OWNERSHIP_UNCERTAIN');
    this.failpoint('reserved');
    if (!pathExists(worktree)) await git(repository, ['worktree', 'add', worktree, branch]);
    this.failpoint('worktree_created');
    requireValue(await this.checkCheckout(resource) === baseSha, 'Provisioned checkout moved from its recorded base', 'STALE_TARGET');
    return { worktree, branch, baseSha };
  }
  /** @param {{repositoryId: string; attempt: import('../types.d.ts').Attempt; headSha: string; ownedAreas: string[]}} input */
  async candidate({ repositoryId, attempt, headSha, ownedAreas }) {
    sha(headSha); const { repository, common } = await this.repository(repositoryId);
    const resource = this.resource(attempt.operationId);
    requireValue(resource && resource.repositoryId === repositoryId && resource.repository === repository && resource.common === common && resource.worktree === attempt.worktree && resource.branch === attempt.branch && resource.baseSha === attempt.baseSha, 'Candidate resource identity does not match its attempt', 'OWNERSHIP_UNCERTAIN');
    requireValue(await this.ref(repository, `refs/companion/resources/${attempt.operationId}`) === attempt.baseSha, 'Candidate ownership evidence changed', 'OWNERSHIP_UNCERTAIN');
    requireValue(await this.checkCheckout(resource) === headSha && await this.ref(repository, `refs/heads/${resource.branch}`) === headSha, 'Submitted candidate is not the recorded branch head', 'STALE_TARGET');
    await git(repository, ['cat-file', '-e', `${headSha}^{commit}`]);
    await git(repository, ['merge-base', '--is-ancestor', attempt.baseSha, headSha]);
    requireValue(!(await git(repository, ['rev-list', '--min-parents=2', `${attempt.baseSha}..${headSha}`])).trim(), 'Merge history needs explicit reconciliation', 'UNSUPPORTED_HISTORY');
    const areas = ownedAreas.map(ownedArea); requireValue(areas.length > 0, 'Candidate needs approved owned areas');
    const changedPaths = (await git(repository, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', attempt.baseSha, headSha])).split('\0').filter(Boolean);
    requireValue(changedPaths.length > 0 && changedPaths.length <= 1000, 'Candidate delta is empty or too large', 'INVALID_CANDIDATE');
    for (const path of changedPaths) requireValue(ownedArea(path) === path && areas.some((area) => path === area || path.startsWith(`${area}/`)), 'Candidate changes paths outside approved task ownership', 'SCOPE_VIOLATION');
    const raw = await git(repository, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--raw', attempt.baseSha, headSha]);
    requireValue(!/^:\d+ (120000|160000) /m.test(raw), 'Symlink/submodule changes need explicit supported verification', 'UNSUPPORTED_HISTORY');
    const delta = await gitBytes(repository, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index', attempt.baseSha, headSha]);
    const deltaArtifact = this.artifacts.put(delta);
    requireValue(await this.checkCheckout(resource) === headSha && await this.ref(repository, `refs/heads/${resource.branch}`) === headSha, 'Candidate changed during verification', 'STALE_TARGET');
    const report = this.artifacts.put(JSON.stringify({ schemaVersion: 1, repositoryId, operationId: attempt.operationId, baseSha: attempt.baseSha, headSha, changedPaths, deltaArtifactId: deltaArtifact.id }));
    return { headSha, changedPaths, artifactId: report.id };
  }
}
