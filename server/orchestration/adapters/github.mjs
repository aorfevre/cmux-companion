import { mkdirSync, lstatSync, readFileSync, realpathSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError, identifier, requireValue, sha, branchName } from '../domain/contracts.mjs';
import { pathExists } from './git.mjs';

/** Publication pushes a branch, creates a draft and promotes the completed PR. Sent markers precede each request;
 * reconciliation observes exact remote/PR identity and never creates another PR.
 */
export class GitHubPublication {
  /** @param {{ directory: string; remote: import('../types.d.ts').RemotePort; github: import('../types.d.ts').GitHubPort; failpoint?: (point: string) => void }} options */
  constructor({ directory, remote, github, failpoint = () => {} }) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(directory); this.remote = remote; this.github = github; this.failpoint = failpoint;
  }
  /** @param {import('../types.d.ts').PublicationInput} input @param {NonNullable<import('../types.d.ts').Goal['pr']>} pr */
  async observeMerge(input, pr) {
    requireValue(this.github.readPull, 'GitHub merge observation is unavailable', 'UNSUPPORTED_CAPABILITY');
    const observed = await this.github.readPull(input.repositoryId, pr.number);
    requireValue(observed.number === pr.number && observed.url === pr.url, 'Saved PR identity changed', 'STALE_TARGET');
    return observed;
  }
  /** @param {import('../types.d.ts').PublicationInput} input @param {NonNullable<import('../types.d.ts').Goal['pr']>} pr */
  async reviewThreads(input, pr) {
    requireValue(this.github.listReviewThreads && this.github.readPull, 'GitHub review threads are unavailable', 'UNSUPPORTED_CAPABILITY');
    const observed = await this.github.readPull(input.repositoryId, pr.number);
    requireValue(observed.number === pr.number && observed.url === pr.url, 'Saved PR identity changed', 'STALE_TARGET');
    return { threads: await this.github.listReviewThreads(input.repositoryId, pr.number), mergeable: observed.mergeable };
  }
  /** Sent marker per round. A lost response is resolved by reading the remote head,
   * never by pushing again.
   * @param {import('../types.d.ts').PublicationInput} input
   * @param {{ roundId: string; expectedHead: string; headSha: string }} fix
   * @returns {Promise<'pushed' | 'remote_moved' | 'unknown'>} */
  async pushFix(input, fix) {
    const { directory } = this.request(input);
    identifier(fix.roundId); sha(fix.expectedHead); sha(fix.headSha);
    const path = join(directory, `fix.${fix.roundId}.push.sent.json`);
    const current = await this.remote.head(input.repositoryId, input.branch);
    if (current === fix.headSha) return 'pushed';
    if (pathExists(path)) {
      requireValue(JSON.stringify(this.read(path)) === JSON.stringify({ roundId: fix.roundId, expectedHead: fix.expectedHead, headSha: fix.headSha }), 'Fix push request was reused', 'IDEMPOTENCY_CONFLICT');
      return current === fix.expectedHead ? 'unknown' : 'remote_moved';
    }
    if (current !== fix.expectedHead) return 'remote_moved';
    let claimed = false;
    try {
      await this.remote.push({ repositoryId: input.repositoryId, branch: input.branch, headSha: fix.headSha, expectedHead: fix.expectedHead }, { beforeSend: () => {
        claimed = this.claim(path, { roundId: fix.roundId, expectedHead: fix.expectedHead, headSha: fix.headSha });
        if (claimed) this.failpoint('fix_push_sent');
        return claimed;
      } });
    } catch (error) {
      if (claimed && error instanceof DomainError && error.code === 'EXTERNAL_NOT_SENT') { unlinkSync(path); return 'remote_moved'; }
      return 'unknown';
    }
    const pushed = await this.remote.head(input.repositoryId, input.branch);
    return pushed === fix.headSha ? 'pushed' : pushed === fix.expectedHead ? 'remote_moved' : 'unknown';
  }
  /** One sent marker per thread write. A lost response becomes unconfirmed, never re-sent.
   * @param {import('../types.d.ts').PublicationInput} input
   * @param {{ roundId: string; replies: import('../types.d.ts').ReviewReply[] }} fix */
  async replyAndResolve(input, fix) {
    const { directory } = this.request(input); identifier(fix.roundId);
    requireValue(this.github.replyToThread && this.github.resolveThread, 'GitHub thread writes are unavailable', 'UNSUPPORTED_CAPABILITY');
    /** @type {string[]} */ const posted = [];
    /** @type {string[]} */ const unconfirmed = [];
    /** @type {string[]} */ const resolved = [];
    for (const reply of fix.replies) {
      identifier(reply.threadId);
      const sent = join(directory, `fix.${fix.roundId}.reply.${reply.threadId}.sent.json`);
      const done = join(directory, `fix.${fix.roundId}.reply.${reply.threadId}.done.json`);
      if (pathExists(done)) posted.push(reply.threadId);
      else if (pathExists(sent)) unconfirmed.push(reply.threadId);
      else {
        let claimed = false;
        try {
          await this.github.replyToThread(input.repositoryId, reply.threadId, reply.body, { beforeSend: () => {
            claimed = this.claim(sent, { roundId: fix.roundId, threadId: reply.threadId });
            if (claimed) this.failpoint('fix_reply_sent');
            return claimed;
          } });
          if (claimed) { this.save(done, { roundId: fix.roundId, threadId: reply.threadId }); posted.push(reply.threadId); }
        } catch (error) {
          if (claimed && error instanceof DomainError && error.code === 'EXTERNAL_NOT_SENT') unlinkSync(sent);
          throw error;
        }
      }
      if (reply.action !== 'fixed') continue;
      const resolveSent = join(directory, `fix.${fix.roundId}.resolve.${reply.threadId}.sent.json`);
      if (pathExists(resolveSent)) { resolved.push(reply.threadId); continue; }
      let claimedResolve = false;
      try {
        await this.github.resolveThread(input.repositoryId, reply.threadId, { beforeSend: () => {
          claimedResolve = this.claim(resolveSent, { roundId: fix.roundId, threadId: reply.threadId });
          return claimedResolve;
        } });
        if (claimedResolve) resolved.push(reply.threadId);
      } catch (error) {
        if (claimedResolve && error instanceof DomainError && error.code === 'EXTERNAL_NOT_SENT') unlinkSync(resolveSent);
        throw error;
      }
    }
    return { posted, unconfirmed, resolved };
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
      if (typeof pr.draft !== 'boolean') return { status: 'unknown', baseHeadSha, pr: null };
      if (pr.state === 'closed' && pr.draft) return { status: 'unknown', baseHeadSha, pr: null };
      if (pr.state === 'open' && !pr.draft) {
        const confirmedBaseHeadSha = await this.remote.head(input.repositoryId, input.baseBranch);
        if (baseHeadSha !== targetSha || confirmedBaseHeadSha !== baseHeadSha) return { status: 'unknown', baseHeadSha: confirmedBaseHeadSha, pr: null };
      }
      if (pr.state === 'open' && pr.draft) return { status: baseHeadSha === targetSha ? 'pending' : 'target_moved', baseHeadSha, pr: null };
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
    if (pathExists(join(directory, 'pr.sent.json'))) return this.promote(input, signal);
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
    return this.promote(input, signal);
  }
  /** Idempotent promotion reconciles lost responses without another create.
   * @param {import('../types.d.ts').PublicationInput} input @param {AbortSignal} [signal]
   * @returns {Promise<import('../types.d.ts').PublicationResult>} */
  async promote(input, signal) {
    const observed = await this.observe(input);
    if (observed.status !== 'pending') return observed;
    if (signal?.aborted) return { ...observed, status: /** @type {const} */ ('cancelled') };
    requireValue(this.github.ready, 'Draft promotion is unavailable', 'UNSUPPORTED_CAPABILITY');
    this.failpoint('pr_ready');
    const promotion = await this.github.ready(input, { beforeSend: () => !signal?.aborted });
    if (promotion === 'cancelled') return { ...observed, status: 'cancelled' };
    if (promotion === 'unknown') return { status: 'unknown', baseHeadSha: null, pr: null };
    this.failpoint('pr_ready_returned');
    return this.observe(input);
  }

}
