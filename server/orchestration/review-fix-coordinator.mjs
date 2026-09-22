import { randomUUID } from 'node:crypto';
import { DomainError, requireValue } from './domain/contracts.mjs';

/** Drives one review round per goal: fetch the unresolved threads, request fix
 * verification, push the verified fix, answer the threads and settle. Every
 * remote effect runs in a background job under the scheduler's ownership fence;
 * a lost response never repeats a write.
 */
export class ReviewFixCoordinator {
  /** @param {{ service: import('./service.mjs').OrchestrationService; publisher: import('./types.d.ts').PublicationPort; reviewMerges?: Pick<import('./types.d.ts').RepositoryPort, 'prepareReviewMerge'>; ownership: { assertOwned(): void }; now?: () => number; id?: () => string; onError?: (error: unknown) => void }} options */
  constructor({ service, publisher, reviewMerges, ownership, now = Date.now, id = randomUUID, onError = () => {} }) {
    this.service = service; this.store = service.store; this.agents = service.agents; this.publisher = publisher; this.reviewMerges = reviewMerges; this.ownership = ownership;
    this.now = now; this.id = id; this.onError = onError; this.stopped = false;
    /** @type {Map<string, Promise<void>>} */ this.active = new Map();
  }
  /** @param {string} goalId @param {string} type @param {unknown} payload */
  record(goalId, type, payload) {
    this.ownership.assertOwned(); const goal = this.store.get(goalId);
    requireValue(goal, 'Review round goal disappeared');
    return this.service.execute({ id: this.id(), goalId, expectedVersion: goal.version, type, payload }, { kind: 'system' });
  }
  /** Sanitized failure; external output and credentials never reach the journal.
   * @param {string} goalId @param {string} roundId @param {string} code @param {string} message */
  fail(goalId, roundId, code, message) {
    const latest = this.store.get(goalId);
    if (latest?.status === 'addressing_review' && latest.reviewRound?.id === roundId && !['failed', 'unknown'].includes(latest.reviewRound.state)) {
      this.record(goalId, 'fail_review_fix', { roundId, code, message });
    }
  }
  /** The same goal, round and repository are still active. @param {string} goalId @param {string} roundId */
  current(goalId, roundId) {
    const latest = this.store.get(goalId);
    return latest && latest.status === 'addressing_review' && latest.reviewRound?.id === roundId && this.service.repositoryIds.has(latest.repositoryId) ? latest : null;
  }
  /** @param {import('./types.d.ts').Goal} goal @param {(round: NonNullable<import('./types.d.ts').Goal['reviewRound']>, plan: import('./types.d.ts').PublicationInput, pr: NonNullable<import('./types.d.ts').Goal['pr']>) => Promise<void>} work */
  spawn(goal, work) {
    const round = goal.reviewRound, plan = goal.publication?.plan, pr = goal.pr;
    requireValue(round && plan && pr, 'Review round has no publication');
    const job = Promise.resolve().then(async () => {
      if (this.stopped) return;
      try { await work(round, plan, pr); }
      catch (error) {
        if (this.stopped) return;
        this.ownership.assertOwned();
        if (error instanceof DomainError && error.code === 'VERSION_CONFLICT') return;
        this.onError(error);
        // The code is Companion's own classification, never external output.
        const code = error instanceof DomainError ? error.code : 'REVIEW_FIX_FAILED';
        this.fail(goal.id, round.id, code, code === 'UNSUPPORTED_CAPABILITY'
          ? `Addressing review comments is unavailable in this configuration (${code}). A retry cannot succeed until Companion is updated or reconfigured.`
          : `Addressing review comments failed (${code}). Check GitHub access and retry.`);
      }
    }).finally(() => this.active.delete(goal.id));
    this.active.set(goal.id, job); void job.catch(this.onError);
  }
  async run() {
    if (this.stopped) return;
    this.ownership.assertOwned();
    for (const goal of this.store.list()) {
      const round = goal.reviewRound;
      if (goal.status !== 'addressing_review' || !round || !goal.pr || !goal.publication
        || this.active.has(goal.id) || !this.service.repositoryIds.has(goal.repositoryId)) continue;
      // A round whose fixer cannot be dispatched would otherwise stay in
      // fixing with no session, no error and nothing for the owner to act on.
      if (round.state === 'fixing' && round.threads.length && !this.agents.capabilities.some(capability => capability.role === 'review_fixer' && capability.mode === 'background')) {
        this.fail(goal.id, round.id, 'UNSUPPORTED_CAPABILITY', 'This Companion cannot start a review fixer. Waiting will not help; update or reconfigure Companion, then retry.');
        continue;
      }
      if (round.state === 'fetching') {
        this.spawn(goal, async (round, plan, pr) => {
          // A missing method is a composition fault, not a transport failure;
          // reporting it as an offline Mac sends the owner into endless retries.
          requireValue(this.publisher.reviewThreads, 'Review rounds are unavailable in this configuration', 'UNSUPPORTED_CAPABILITY');
          let threads;
          try {
            threads = await this.publisher.reviewThreads(plan, pr);
            requireValue(threads?.threads, 'GitHub review threads are unavailable', 'UNSUPPORTED_CAPABILITY');
          } catch (error) {
            if (this.stopped) return;
            // A capability fault raised inside the call is still a
            // configuration fault; only a transport failure reads as offline.
            if (error instanceof DomainError && error.code === 'UNSUPPORTED_CAPABILITY') throw error;
            this.ownership.assertOwned();
            this.fail(goal.id, round.id, 'GITHUB_UNAVAILABLE', 'GitHub review threads were unavailable. Retry when your Mac is online.');
            return;
          }
          if (this.stopped) return;
          this.ownership.assertOwned();
          if (this.current(goal.id, round.id)) this.record(goal.id, 'record_review_threads', { roundId: round.id, threads: threads.threads, mergeable: threads.mergeable, at: this.now() });
        });
      } else if (round.state === 'merging') {
        this.spawn(goal, async (round) => {
          requireValue(this.reviewMerges?.prepareReviewMerge, 'Review merges are unavailable in this configuration', 'UNSUPPORTED_CAPABILITY');
          const prepared = await this.reviewMerges.prepareReviewMerge({ goalId: goal.id, repositoryId: goal.repositoryId, roundId: round.id, prHeadSha: round.prHeadSha, baseBranch: goal.baseBranch });
          if (this.stopped) return;
          this.ownership.assertOwned();
          if (this.current(goal.id, round.id)) this.record(goal.id, 'record_review_merge', { roundId: round.id, ...prepared });
        });
      } else if (round.state === 'verifying' && !round.verificationOperationId) {
        if (goal.hold || goal.attempts.some((attempt) => attempt.workerState !== 'stopped')) continue;
        try { this.record(goal.id, 'request_review_fix_verification', { roundId: round.id, operationId: this.id() }); }
        catch (error) { if (!(error instanceof DomainError) || !['NOT_READY', 'RETRY_REQUIRED'].includes(error.code)) throw error; }
      } else if (round.state === 'verifying') {
        const run = goal.verificationRuns?.find((entry) => entry.operationId === round.verificationOperationId);
        if (run?.result && run.status !== 'pending') this.record(goal.id, 'record_review_fix_verification', { roundId: round.id, operationId: run.operationId });
      } else if ((round.state === 'pushing' || round.state === 'unknown') && round.fixHeadSha) {
        this.spawn(goal, async (round, plan) => {
          requireValue(this.publisher.pushFix, 'Review rounds are unavailable in this configuration', 'UNSUPPORTED_CAPABILITY');
          const result = await this.publisher.pushFix(plan, { roundId: round.id, expectedHead: round.prHeadSha, headSha: /** @type {string} */ (round.fixHeadSha) });
          if (this.stopped) return;
          this.ownership.assertOwned();
          if (!this.current(goal.id, round.id)) return;
          if (result === 'pushed') this.record(goal.id, 'record_review_fix_push', { roundId: round.id });
          else if (result === 'remote_moved') this.fail(goal.id, round.id, 'REMOTE_MOVED', 'The pull request branch moved on GitHub. Nothing was pushed or posted.');
          else if (round.state !== 'unknown') this.fail(goal.id, round.id, 'PUSH_UNCERTAIN', 'The fix push outcome is uncertain.');
        });
      } else if (round.state === 'replying') {
        this.spawn(goal, async (round, plan) => {
          requireValue(this.publisher.replyAndResolve, 'Review rounds are unavailable in this configuration', 'UNSUPPORTED_CAPABILITY');
          const outcome = await this.publisher.replyAndResolve(plan, { roundId: round.id, replies: round.replies ?? [] });
          requireValue(outcome, 'GitHub thread writes are unavailable', 'UNSUPPORTED_CAPABILITY');
          if (this.stopped) return;
          this.ownership.assertOwned();
          if (this.current(goal.id, round.id)) this.record(goal.id, 'settle_review_fix', { roundId: round.id, ...outcome, at: this.now() });
        });
      }
    }
  }
  async stop() { this.stopped = true; await Promise.allSettled([...this.active.values()]); }
}
