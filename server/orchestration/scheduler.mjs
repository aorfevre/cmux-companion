import { AgentPreparationError } from './agent-preparation-error.mjs';
import { randomUUID } from 'node:crypto';
import { DomainError, integer, requireValue } from './domain/contracts.mjs';
import { requireCapability } from './ports.mjs';
import { SchedulerOwnership } from './storage/ownership.mjs';
import { MergeCoordinator } from './merge-coordinator.mjs';
import { PublicationCoordinator } from './publication-coordinator.mjs';
import { VerificationCoordinator } from './verification-coordinator.mjs';
import { IntegrationRepairs } from './integration-repairs.mjs';
import { revisablePlan, repairableReviews } from './domain/review-repairs.mjs';
import { Reconciler } from './reconciler.mjs';

export class Scheduler {
  /** @param {{ service: import('./service.mjs').OrchestrationService; repositories: Pick<import('./types.d.ts').RepositoryPort,'provision'>; integrations?: Pick<import('./types.d.ts').RepositoryPort, 'integrate'> & Partial<Pick<import('./types.d.ts').RepositoryPort, 'provisionRepair' | 'observeIntegration' | 'acceptRepair' | 'observeRepair'>>; verifier?: import('./types.d.ts').VerificationPort; publisher?: import('./types.d.ts').PublicationPort; results?: { drain(): void | Promise<void> }; ownership?: SchedulerOwnership; id?: () => string; intervalMs?: number; planReviewEnabled?: () => boolean; prepareGoal?: (goal: import('./types.d.ts').Goal) => Promise<string>; onError?: (error: unknown) => void }} options */
  constructor({ service, repositories, integrations, verifier, publisher, results, ownership = new SchedulerOwnership({ store: service.store }), id = randomUUID, intervalMs = 2500, planReviewEnabled = () => true, prepareGoal, onError = () => {} }) {
    this.service = service; this.store = service.store; this.agents = service.agents; this.repositories = repositories;
    this.ownership = ownership; this.id = id; this.intervalMs = integer(intervalMs, 1); this.onError = onError;
    this.reconciler = new Reconciler({ service, ownership, results, id });
    this.prepareGoal = prepareGoal; this.planReviewEnabled = planReviewEnabled;
    /** @type {Map<string, Promise<void>>} */ this.startupJobs = new Map();
    this.results = results; this.integrations = integrations;
    this.stopped = true; this.again = false;
    this.paused = () => false;
    /** @type {Promise<void> | null} */ this.sweep = null;
    /** @type {ReturnType<typeof setInterval> | null} */ this.timer = null;
    this.verifications = verifier ? new VerificationCoordinator({ service, verifier, ownership, id, onError }) : null;
    this.publications = publisher ? new PublicationCoordinator({ service, publisher, ownership, id, onError }) : null;
    this.merges = publisher ? new MergeCoordinator({ service, publisher, ownership, id, onError }) : null;
    this.previousNotify = this.store.onCommit;
    /** @param {number} cursor */
    this.notify = (cursor) => { try { this.previousNotify(cursor); } finally { this.verifications?.cancelRevoked(); this.publications?.cancelRevoked(); void this.tick().catch(this.onError); } };
  }
  /** @param {{ releaseOwnershipOnFailure?: boolean }} [options] */
  async start({ releaseOwnershipOnFailure = true } = {}) {
    requireValue(this.stopped, 'Scheduler is already started'); this.ownership.acquire();
    this.service.ownership = this.ownership; this.stopped = false; if (this.merges) this.merges.stopped = false; if (this.verifications) this.verifications.stopped = false; if (this.publications) this.publications.stopped = false; this.store.onCommit = this.notify;
    this.timer = setInterval(() => { void this.tick().catch(this.onError); }, this.intervalMs); this.timer.unref();
    try {
      this.store.rebuildReady(() => this.ownership.assertOwned());
      await this.tick();
    } catch (error) { await this.stop({ releaseOwnership: releaseOwnershipOnFailure }); throw error; }
  }
  /** @param {{ releaseOwnership?: boolean }} [options] */
  async stop({ releaseOwnership = true } = {}) {
    this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null;
    if (this.store.onCommit === this.notify) this.store.onCommit = this.previousNotify;
    try {
      const settled = await Promise.allSettled([this.sweep, ...this.startupJobs.values(), this.verifications?.stop(), this.publications?.stop(), this.merges?.stop()]);
      const failures = settled.filter((entry) => entry.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map((entry) => entry.reason), 'Scheduler shutdown failed');
    } finally { if (releaseOwnership) this.ownership.release(); }
  }
  tick() {
    if (this.stopped || this.paused()) return Promise.resolve();
    this.again = true;
    if (!this.sweep) this.sweep = Promise.resolve().then(async () => {
      while (!this.stopped && !this.paused() && this.again) { this.again = false; await this.pass(); }
    }).finally(() => { this.sweep = null; });
    return this.sweep;
  }
  async pass() {
    this.ownership.assertOwned(); await this.results?.drain(); await this.reconciler.run();
    if (this.stopped) return;
    this.revisePlans();
    this.prepareGoals();
    await this.integrate();
    await this.verifications?.run();
    await this.publications?.run();
    this.merges?.run();
    if (this.stopped) return;
    for (const work of this.store.ready()) {
      if (this.stopped) return;
      const goal = this.store.get(work.goalId); if (!goal) continue;
      try {
        const attemptId = this.id();
        this.service.execute({ id: this.id(), goalId: goal.id, expectedVersion: goal.version, type: 'request_attempt', payload: { attemptId, operationId: this.id(), role: work.role, taskId: work.taskId, conversationId: this.id() } }, { kind: 'system' });
      } catch (error) {
        if (!(error instanceof DomainError) || !['CAPACITY_FULL', 'FORBIDDEN', 'NOT_READY', 'ALREADY_RUNNING', 'RETRY_REQUIRED', 'UNSUPPORTED_CAPABILITY'].includes(error.code)) throw error;
      }
    }
    // A failed dispatch must not release ownership while sibling effects are in flight.
    const dispatched = await Promise.allSettled(this.store.operations().filter((operation) => operation.kind === 'launch' && operation.status === 'pending').map((operation) => this.dispatch(operation)));
    const failures = dispatched.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Agent dispatch failed');
  }
  revisePlans() {
    for (const snapshot of this.store.list()) {
      if (this.stopped || this.paused()) return;
      if (!this.service.repositoryIds.has(snapshot.repositoryId)) continue;
      let goal = snapshot;
      const enabled = this.planReviewEnabled();
      this.ownership.assertOwned();
      if ((!goal.startup || goal.startup.status === 'ready') && ['discovering', 'awaiting_approval'].includes(goal.status) && (goal.planReviewEnabled ?? true) !== enabled) {
        this.service.execute({ id: this.id(), goalId: goal.id, expectedVersion: goal.version,
          type: 'set_plan_review_policy', payload: { enabled } }, { kind: 'system' });
        const latest = this.store.get(goal.id); requireValue(latest, 'Goal disappeared', 'NOT_FOUND'); goal = latest;
      }
      const review = revisablePlan(goal);
      if (review) this.service.execute({ id: this.id(), goalId: goal.id, expectedVersion: goal.version,
        type: 'revise_rejected_plan', payload: { reviewId: review.id } }, { kind: 'system' });
      else if (repairableReviews(goal)) this.service.execute({ id: this.id(), goalId: goal.id, expectedVersion: goal.version,
        type: 'repair_review_findings', payload: { holdId: goal.hold?.id ?? '' } }, { kind: 'system' });
    }
  }
  prepareGoals() {
    // One bounded fetch job at a time; network latency must not stall agent
    // reconciliation, dispatch, verification or publication for other goals.
    if (this.stopped || this.paused() || this.startupJobs.size) return;
    const goal = this.store.list().find(goal => goal.startup?.status === 'pending' && goal.status === 'discovering');
    if (!goal) return;
    const job = Promise.resolve().then(async () => {
      if (this.stopped || this.paused()) return;
      try {
        this.ownership.assertOwned();
        requireValue(this.service.repositoryIds.has(goal.repositoryId), 'Repository is no longer allowed', 'FORBIDDEN');
        requireValue(this.prepareGoal, 'Fetching the goal base is unavailable; configure a supported GitHub repository and retry', 'NOT_READY');
        const baseSha = await this.prepareGoal(goal);
        this.ownership.assertOwned();
        const latest = this.store.get(goal.id);
        if (latest?.startup?.status === 'pending' && latest.status === 'discovering') this.reconciler.record(goal.id, 'record_startup', { baseSha });
      } catch (error) {
        this.ownership.assertOwned();
        const latest = this.store.get(goal.id);
        if (latest?.startup?.status === 'pending' && latest.status === 'discovering') this.reconciler.record(goal.id, 'fail_startup', { error: error instanceof DomainError ? error.message : 'Could not fetch the goal base. Check repository access and retry.' });
      }
    }).finally(() => {
      this.startupJobs.delete(goal.id);
      void this.tick().catch(this.onError);
    });
    this.startupJobs.set(goal.id, job);
    void job.catch(this.onError);
  }
  /** @param {import('./types.d.ts').Goal} goal @param {import('./types.d.ts').Attempt} attempt */
  async provisionRepair(goal, attempt) {
    requireValue(this.integrations?.provisionRepair && goal.integration, 'Conflict repair provisioning is unavailable', 'UNSUPPORTED_CAPABILITY');
    return this.integrations.provisionRepair({ goalId: goal.id, repositoryId: goal.repositoryId, integrationOperationId: goal.integration.operationId, attempt });
  }
  async integrate() {
    if (!this.integrations) return;
    if (this.integrations.acceptRepair && this.integrations.observeRepair) await new IntegrationRepairs({ service: this.service, integrations: { acceptRepair: this.integrations.acceptRepair.bind(this.integrations), observeRepair: this.integrations.observeRepair.bind(this.integrations) }, ownership: this.ownership, id: this.id }).run();
    for (const operation of this.store.operations().filter((entry) => entry.kind === 'integrate')) {
      try {
        const goal = this.store.get(operation.goalId);
        if (goal?.integrationResults?.some((result) => result.operationId === operation.id)) {
          this.ownership.assertOwned(); this.store.advanceOperation(operation.id, operation.status, 'completed');
        } else if (goal?.integration?.operationId === operation.id && goal.integration.state === 'conflict') {
          this.ownership.assertOwned(); this.store.advanceOperation(operation.id, operation.status, 'completed');
        } else if (goal?.integration?.operationId === operation.id && this.integrations.observeIntegration) {
          if (goal.results?.some((result) => result.status === 'pending' && result.repair?.integrationOperationId === operation.id)) continue;
          const observed = await this.integrations.observeIntegration(operation.id);
          this.ownership.assertOwned();
          if (observed.status === 'integrated' && observed.headSha) {
            this.reconciler.record(goal.id, 'record_integration', { operationId: operation.id, headSha: observed.headSha });
            this.store.advanceOperation(operation.id, operation.status, 'completed');
          } else if (observed.status === 'pending' && ['aborted', 'merged'].includes(goal.status)) {
            this.reconciler.record(goal.id, 'cancel_integration', { operationId: operation.id });
            this.store.advanceOperation(operation.id, operation.status, 'completed');
          } else if (goal.integration.state === 'failed' && goal.integration.retryRequested && !goal.hold && goal.status === 'building' && this.service.repositoryIds.has(goal.repositoryId)) {
            this.reconciler.record(goal.id, observed.status === 'pending' ? 'resume_integration' : 'record_integration_failure', { operationId: operation.id, code: 'OWNERSHIP_UNCERTAIN' });
          } else if (observed.status === 'unknown' && goal.integration.state === 'applying') {
            this.reconciler.record(goal.id, 'record_integration_failure', { operationId: operation.id, code: 'OWNERSHIP_UNCERTAIN' });
          }
        }
      } catch (error) {
        // A damaged receipt must retain its unresolved intent without starving
        // unrelated goals. Loss of scheduler ownership still stops the pass.
        this.ownership.assertOwned();
        if (!(error instanceof DomainError)) throw error;
        this.onError(error);
      }
    }
    for (const snapshot of this.store.list()) {
      if (this.stopped) return;
      this.ownership.assertOwned();
      let goal = this.store.get(snapshot.id);
      if (!goal || goal.hold || goal.status !== 'building' || !this.service.repositoryIds.has(goal.repositoryId)) continue;
      if (!goal.integration) {
        if (goal.attempts.some((attempt) => attempt.role === 'integrator' && attempt.workerState !== 'stopped')) continue;
        const task = goal.tasks.find((entry) => entry.status === 'accepted');
        if (!task) continue;
        this.reconciler.record(goal.id, 'request_integration', { taskId: task.id, operationId: this.id() });
        const latest = this.store.get(goal.id); requireValue(latest, 'Goal disappeared', 'NOT_FOUND'); goal = latest;
      }
      const operation = goal?.integration;
      if (!goal || !operation || operation.state !== 'applying') continue;
      const intent = this.store.operations().find((entry) => entry.id === operation.operationId);
      requireValue(intent?.kind === 'integrate', 'Integration intent disappeared');
      if (intent.status === 'pending') this.store.advanceOperation(intent.id, 'pending', 'dispatching');
      try {
        requireValue(this.service.repositoryIds.has(goal.repositoryId), 'Repository is no longer allowed', 'FORBIDDEN');
        const result = await this.integrations.integrate({ goalId: goal.id, repositoryId: goal.repositoryId, operationId: operation.operationId, expectedHead: operation.expectedHead, baseSha: operation.baseSha, candidateSha: operation.candidateSha });
        this.ownership.assertOwned();
        // Record external success even if abort arrived during Git; no further
        // task dispatch follows a terminal goal, but its evidence is retained.
        this.reconciler.record(goal.id, result.status === 'integrated' ? 'record_integration' : 'record_integration_conflict', { operationId: operation.operationId, ...(result.status === 'integrated' ? { headSha: result.headSha } : {}) });
        this.store.advanceOperation(intent.id, 'dispatching', 'completed');
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        this.reconciler.record(goal.id, 'record_integration_failure', { operationId: operation.operationId, code: error.code });
      }
    }
  }
  /** @param {import('./types.d.ts').Intent} operation */
  async dispatch(operation) {
    this.ownership.assertOwned();
    let goal = this.store.get(operation.goalId), attempt = goal?.attempts.find((entry) => entry.id === operation.attemptId);
    if (!goal || !attempt) return;
    if (attempt.workerState === 'stopped') { this.store.advanceOperation(operation.id, 'pending', 'completed'); return; }
    const permitted = () => goal !== null && !this.stopped && this.service.repositoryIds.has(goal.repositoryId) && operation.generation === goal.generation && operation.revision === goal.revision && !['aborted', 'merged'].includes(goal.status);
    if (!permitted()) {
      this.reconciler.record(goal.id, 'record_stopped', { attemptId: attempt.id });
      this.store.advanceOperation(operation.id, 'pending', 'completed'); return;
    }
    if (goal.hold) return;
    let launchStarted = false;
    try {
      requireCapability(this.agents, attempt.role, attempt.mode);
      const resources = attempt.worktree && attempt.branch ? { worktree: attempt.worktree, branch: attempt.branch, baseSha: attempt.baseSha }
        : attempt.role === 'integrator' && attempt.taskId && goal.integration?.state === 'conflict'
          ? await this.provisionRepair(goal, attempt)
          : await this.repositories.provision({ operationId: operation.id, repositoryId: goal.repositoryId, branch: `companion/${goal.id}/${attempt.id}`, baseSha: attempt.baseSha });
      this.ownership.assertOwned();
      goal = this.store.get(operation.goalId); attempt = goal?.attempts.find((entry) => entry.id === operation.attemptId);
      if (!goal || !attempt) return;
      if (!attempt.worktree) this.reconciler.record(goal.id, 'record_provision', { attemptId: attempt.id, ...resources });
      goal = this.store.get(goal.id);
      if (!goal) return;
      attempt = goal.attempts.find((entry) => entry.id === operation.attemptId);
      requireValue(attempt, 'Provisioned attempt disappeared');
      if (!permitted() || attempt.workerState === 'stopped') {
        if (attempt.workerState !== 'stopped') this.reconciler.record(goal.id, 'record_stopped', { attemptId: attempt.id });
        this.store.advanceOperation(operation.id, 'pending', 'completed'); return;
      }
      if (goal.hold) return;
      if (!this.store.advanceOperation(operation.id, 'pending', 'dispatching')) return;
      // All durable intent/resource checks precede the first possible agent launch.
      launchStarted = true;
      const launched = await this.agents.launch({ operationId: operation.id, goalId: goal.id, attempt });
      this.ownership.assertOwned();
      this.reconciler.record(goal.id, 'record_dispatch', { attemptId: attempt.id, identity: launched.identity, ...resources });
      this.store.advanceOperation(operation.id, 'dispatching', 'completed');
    } catch (error) {
      this.ownership.assertOwned();
      const pending = this.store.operations().find((entry) => entry.id === operation.id);
      if (launchStarted && error instanceof AgentPreparationError) {
        const latest = this.store.get(operation.goalId);
        if (latest && latest.generation === operation.generation && !['aborted', 'merged'].includes(latest.status)) this.reconciler.record(latest.id, 'record_failure', { attemptId: operation.attemptId, confirmedStopped: true, error: error.message });
        else if (latest) this.reconciler.record(latest.id, 'record_stopped', { attemptId: operation.attemptId });
        this.store.advanceOperation(operation.id, 'dispatching', 'completed'); return;
      }
      if (launchStarted || pending?.status === 'dispatching') { await this.reconciler.observe(operation.goalId, operation.attemptId ?? ''); return; }
      const latest = this.store.get(operation.goalId);
      if (latest && latest.generation === operation.generation && !['aborted', 'merged'].includes(latest.status)) this.reconciler.record(latest.id, 'record_failure', { attemptId: operation.attemptId, confirmedStopped: true, error: error instanceof DomainError ? error.message : 'Workspace provisioning failed' });
      else if (latest?.attempts.some((entry) => entry.id === operation.attemptId && entry.workerState !== 'stopped')) this.reconciler.record(latest.id, 'record_stopped', { attemptId: operation.attemptId });
      this.store.advanceOperation(operation.id, 'pending', 'completed');
    }
  }
}
