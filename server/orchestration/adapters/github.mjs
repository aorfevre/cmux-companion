import { mkdirSync, lstatSync, readFileSync, realpathSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError, identifier, requireValue, sha, branchName } from '../domain/contracts.mjs';
import { pathExists } from './git.mjs';

/** Publication has two external effects. Sent markers precede each request;
 * reconciliation observes exact remote/PR identity and never creates another PR.
 */
export class GitHubPublication {
  /** @param {{ directory: string; remote: import('../types.d.ts').RemotePort; github: import('../types.d.ts').GitHubPort; failpoint?: (point: string) => void }} options */
  constructor({ directory, remote, github, failpoint = () => {} }) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(directory); this.remote = remote; this.github = github; this.failpoint = failpoint;
  }
  /** @param {string} path @param {unknown} value */
  save(path, value) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path);
  }
  /** @param {string} path @param {unknown} value */
  claim(path, value) {
    try { writeFileSync(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); return true; }
    catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') return false; throw error; }
  }
  /** @param {string} path */
  read(path) {
    requireValue(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Publication evidence changed', 'OWNERSHIP_UNCERTAIN');
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  /** @param {import('../types.d.ts').PublicationInput} input */
  request(input) {
    identifier(input.operationId); identifier(input.goalId); identifier(input.repositoryId); sha(input.headSha); sha(input.baseSha);
    for (const branch of [input.branch, input.baseBranch]) branchName(branch);
    requireValue(input.branch !== input.baseBranch && input.marker === `<!-- companion-goal:${input.goalId} -->`, 'Publication identity changed');
    requireValue(realpathSync(this.directory) === this.directory, 'Publication directory changed', 'OWNERSHIP_UNCERTAIN');
    const directory = join(this.directory, input.operationId);
    if (pathExists(directory)) requireValue(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'Publication operation directory changed', 'OWNERSHIP_UNCERTAIN');
    // The original base remains part of operation identity. User acceptances
    // extend a separately persisted chain; they never rewrite request.json.
    const { acceptedTargets = [], ...original } = input;
    const request = { ...original, remote: this.remote.identity(input.repositoryId), github: this.github.identity(input.repositoryId) };
    const path = join(directory, 'request.json');
    if (pathExists(path)) requireValue(JSON.stringify(this.read(path)) === JSON.stringify(request), 'Publication operation was reused', 'IDEMPOTENCY_CONFLICT');
    let targetSha = input.baseSha;
    const ids = new Set();
    for (const target of acceptedTargets) {
      identifier(target.id); sha(target.previousBaseSha); sha(target.baseHeadSha);
      requireValue(Object.keys(target).length === 3 && !ids.has(target.id) && target.previousBaseSha === targetSha && target.baseHeadSha !== targetSha, 'Publication target acceptance chain changed', 'IDEMPOTENCY_CONFLICT');
      ids.add(target.id); targetSha = target.baseHeadSha;
    }
    const targetsPath = join(directory, 'targets.accepted.json');
    const recorded = pathExists(targetsPath) ? this.read(targetsPath) : [];
    requireValue(Array.isArray(recorded) && recorded.length <= acceptedTargets.length && JSON.stringify(recorded) === JSON.stringify(acceptedTargets.slice(0, recorded.length)), 'Publication target acceptance was rewritten', 'IDEMPOTENCY_CONFLICT');
    const newTargets = recorded.length < acceptedTargets.length;
    requireValue(!newTargets || !pathExists(join(directory, 'pr.sent.json')), 'A sent PR request cannot accept another target', 'STALE_TARGET');
    return { directory, path, request, targetSha, targetsPath, acceptedTargets, newTargets };
  }
  /** Read-only reconciliation. Absence after a sent PR request never permits a
   * second create: the original request may still complete.
   * @param {import('../types.d.ts').PublicationInput} input
   * @returns {Promise<import('../types.d.ts').PublicationResult>}
   */
  async observe(input) {
    const { directory, path, targetSha } = this.request(input);
    if (!pathExists(path)) return { status: 'pending', baseHeadSha: null, pr: null };
    const pushPath = join(directory, 'push.sent.json'), prPath = join(directory, 'pr.sent.json');
    const pushed = pathExists(pushPath), requested = pathExists(prPath);
    if (pushed) requireValue(JSON.stringify(this.read(pushPath)) === JSON.stringify({ branch: input.branch, expectedHead: null, headSha: input.headSha }), 'Push receipt changed', 'OWNERSHIP_UNCERTAIN');
    if (requested) requireValue(pushed && JSON.stringify(this.read(prPath)) === JSON.stringify({ marker: input.marker, branch: input.branch, baseBranch: input.baseBranch, headSha: input.headSha, baseHeadSha: targetSha }), 'PR receipt changed', 'OWNERSHIP_UNCERTAIN');
    const baseHeadSha = await this.remote.head(input.repositoryId, input.baseBranch);
    const head = await this.remote.head(input.repositoryId, input.branch);
    const matches = await this.github.find(input.repositoryId, input.branch);
    if (matches.length > 1 || matches.some((pr) => pr.marker !== input.marker || pr.branch !== input.branch || pr.baseBranch !== input.baseBranch)) return { status: 'unknown', baseHeadSha, pr: null };
    const pr = matches[0];
    if (pr) {
      if (!pathExists(join(directory, 'pr.sent.json')) || (head !== input.headSha && !(head === null && ['closed', 'merged'].includes(pr.state))) || pr.headSha !== input.headSha || !['open', 'closed', 'merged'].includes(pr.state)) return { status: 'unknown', baseHeadSha, pr: null };
      return { status: 'published', baseHeadSha, pr: { number: pr.number, url: pr.url, headSha: pr.headSha, state: pr.state } };
    }
    if (pathExists(join(directory, 'pr.sent.json'))) return { status: 'unknown', baseHeadSha, pr: null };
    if (head !== null && (!pathExists(join(directory, 'push.sent.json')) || head !== input.headSha)) return { status: 'unknown', baseHeadSha, pr: null };
    if (pushed && head === null) return { status: 'unknown', baseHeadSha, pr: null };
    return { status: baseHeadSha === targetSha ? 'pending' : 'target_moved', baseHeadSha, pr: null };
  }
  /** @param {import('../types.d.ts').PublicationInput} input @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<import('../types.d.ts').PublicationResult>}
   */
  async publish(input, { signal } = {}) {
    const { directory, path, request, targetsPath, acceptedTargets, newTargets } = this.request(input);
    if (!pathExists(path)) {
      requireValue(!pathExists(directory), 'Publication directory lacks ownership', 'OWNERSHIP_UNCERTAIN');
      mkdirSync(directory, { mode: 0o700 }); this.save(path, request); this.failpoint('publication_requested');
    }
    let observed = await this.observe(input);
    if (observed.status !== 'pending') return observed;
    if (signal?.aborted) return { ...observed, status: 'cancelled' };
    if (newTargets) { this.request(input); this.save(targetsPath, acceptedTargets); }
    const pushPath = join(directory, 'push.sent.json');
    if (!pathExists(pushPath)) {
      let claimed = false;
      try {
        await this.remote.push({ repositoryId: input.repositoryId, branch: input.branch, headSha: input.headSha, expectedHead: null }, { beforeSend: () => {
          if (signal?.aborted) return false;
          claimed = this.claim(pushPath, { branch: input.branch, expectedHead: null, headSha: input.headSha });
          if (claimed) this.failpoint('push_sent');
          return claimed;
        } });
      } catch (error) {
        if (claimed && error instanceof DomainError && error.code === 'EXTERNAL_NOT_SENT') unlinkSync(pushPath);
        throw error;
      }
      if (!claimed) return signal?.aborted ? { ...observed, status: 'cancelled' } : this.observe(input);
      this.failpoint('push_returned');
    }
    const pushed = await this.remote.head(input.repositoryId, input.branch);
    if (pushed !== input.headSha) return { ...observed, status: 'unknown' };
    observed = await this.observe(input);
    if (observed.status !== 'pending') return observed;
    if (signal?.aborted) return { ...observed, status: 'cancelled' };
    // Record the target immediately before the irreversible request. A later
    // target movement is reported in the observed result; it cannot undo a PR.
    const prPath = join(directory, 'pr.sent.json');
    let claimed = false;
    try {
      await this.github.create(input, { beforeSend: () => {
        if (signal?.aborted) return false;
        claimed = this.claim(prPath, { marker: input.marker, branch: input.branch, baseBranch: input.baseBranch, headSha: input.headSha, baseHeadSha: observed.baseHeadSha });
        if (claimed) this.failpoint('pr_sent');
        return claimed;
      } });
    } catch (error) {
      if (claimed && error instanceof DomainError && error.code === 'EXTERNAL_NOT_SENT') unlinkSync(prPath);
      throw error;
    }
    if (!claimed) return signal?.aborted ? { ...observed, status: 'cancelled' } : this.observe(input);
    this.failpoint('pr_returned');
    return this.observe(input);
  }
}
