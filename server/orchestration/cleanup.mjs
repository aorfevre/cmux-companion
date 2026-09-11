import { git, pathExists } from './adapters/git.mjs';
import { requireValue, identifier } from './domain/contracts.mjs';
import { ownsWorker } from './domain/transitions.mjs';

/** Cleanup is a separately receipted side effect. It retains branches, ownership
 * refs, manifests, artifacts and all workflow evidence; it never replays delivery.
 * Only clean, exactly registered, terminated attempt worktrees are eligible.
 */
export class ResourceCleanup {
  /** @param {{ service: import('./service.mjs').OrchestrationService; repositories: import('./adapters/git.mjs').GitRepository; assertOwned: () => void; failpoint?: (point: string) => void }} options */
  constructor({ service, repositories, assertOwned, failpoint = () => {} }) {
    this.service = service; this.repositories = repositories; this.assertOwned = assertOwned; this.failpoint = failpoint;
    /** @type {Set<string>} */ this.active = new Set();
  }
  /** @param {string} goalId @param {number} version */
  eligible(goalId, version) {
    const goal = this.service.store.get(goalId);
    requireValue(goal && goal.version === version, 'Goal version changed', 'VERSION_CONFLICT');
    requireValue(['delivered', 'aborted'].includes(goal.status), 'Only delivered or aborted goals can be cleaned', 'NOT_READY');
    requireValue(!goal.attempts.some(ownsWorker), 'Worker termination remains uncertain', 'OWNERSHIP_UNCERTAIN');
    requireValue(!this.service.store.operations().some(operation => operation.goalId === goalId), 'Pending effects require reconciliation', 'NOT_READY');
    return goal;
  }
  /** @param {import('./types.d.ts').Goal} goal @param {import('./types.d.ts').Attempt} attempt */
  async inspect(goal, attempt) {
    const resource = this.repositories.resource(attempt.operationId);
    requireValue(resource && resource.repositoryId === goal.repositoryId && resource.worktree === attempt.worktree && resource.branch === attempt.branch && resource.baseSha === attempt.baseSha, 'Recorded resource identity changed', 'OWNERSHIP_UNCERTAIN');
    const { repository, common } = await this.repositories.repository(goal.repositoryId);
    requireValue(repository === resource.repository && common === resource.common, 'Repository identity changed', 'OWNERSHIP_UNCERTAIN');
    requireValue(await this.repositories.ref(repository, `refs/companion/resources/${attempt.operationId}`) === resource.baseSha, 'Ownership evidence changed', 'OWNERSHIP_UNCERTAIN');
    const head = await this.repositories.ref(repository, `refs/heads/${resource.branch}`);
    requireValue(head, 'Retained branch evidence is missing', 'OWNERSHIP_UNCERTAIN');
    if (pathExists(resource.worktree)) {
      requireValue(await this.repositories.checkCheckout(resource) === head, 'Checkout head changed', 'STALE_TARGET');
      await this.requireEmptyCheckout(resource.worktree);
    }
    const registered = await this.registration(resource);
    if (registered) requireValue(registered.includes(`HEAD ${head}`) && registered.includes(`branch refs/heads/${resource.branch}`), 'Worktree registration changed', 'OWNERSHIP_UNCERTAIN');
    return { resource, head, exists: pathExists(resource.worktree), registered: Boolean(registered) };
  }
  /** @param {import('./adapters/git.mjs').Resource} resource */
  async registration(resource) {
    return (await git(resource.repository, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0').map(record => record.split('\0')).find(fields => fields[0] === `worktree ${resource.worktree}`);
  }
  /** Ignored files are still user data. @param {string} worktree */
  async requireEmptyCheckout(worktree) {
    const entries = (await git(worktree, ['ls-files', '-v', '-z'])).split('\0').filter(Boolean);
    requireValue(!entries.some(entry => /^[a-zS]/.test(entry)), 'Index flags may hide user changes', 'DIRTY_WORKTREE');
    requireValue(!(await git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'])), 'Worktree contains changed, untracked or ignored files', 'DIRTY_WORKTREE');
  }
  /** @param {string} goalId */
  async preview(goalId) {
    const goal = this.service.store.get(goalId); requireValue(goal, 'Unknown goal', 'NOT_FOUND');
    let blocked = null;
    try { this.eligible(goalId, goal.version); } catch (error) { blocked = error instanceof Error ? error.message : 'Cleanup unavailable'; }
    const candidates = [];
    for (const attempt of goal.attempts.filter(attempt => attempt.worktree)) {
      const receipt = this.service.store.db.prepare('SELECT status,error FROM resource_cleanup WHERE goal_id=? AND attempt_id=?').get(goalId, attempt.id);
      try {
        requireValue(!blocked, blocked ?? 'Cleanup unavailable', 'NOT_READY');
        const inspected = await this.inspect(goal, attempt);
        candidates.push({ attemptId: attempt.id, eligible: inspected.exists || Boolean(receipt), headSha: inspected.head, status: receipt?.status ?? 'available', reason: inspected.exists || receipt ? null : 'Resource disappeared without cleanup receipt' });
      } catch (error) { candidates.push({ attemptId: attempt.id, eligible: false, headSha: null, status: receipt?.status ?? 'blocked', reason: error instanceof Error ? error.message : 'Cleanup unavailable' }); }
    }
    return { goalId, expectedVersion: goal.version, candidates };
  }
  /** @param {{goalId:string; expectedVersion:number; attemptId:string}} input */
  async execute({ goalId, expectedVersion, attemptId }) {
    identifier(goalId); identifier(attemptId); this.assertOwned();
    const key = JSON.stringify([goalId, attemptId]); requireValue(!this.active.has(key), 'Cleanup is in progress', 'NOT_READY'); this.active.add(key);
    const db = this.service.store.db;
    try {
      const goal = this.eligible(goalId, expectedVersion), attempt = goal.attempts.find(a => a.id === attemptId);
      requireValue(attempt, 'Unknown attempt', 'NOT_FOUND');
      const inspected = await this.inspect(goal, attempt);
      this.assertOwned(); this.eligible(goalId, expectedVersion);
      const existing = db.prepare('SELECT head_sha,status FROM resource_cleanup WHERE goal_id=? AND attempt_id=?').get(goalId, attemptId);
      requireValue(!existing || existing.head_sha === inspected.head, 'Retained evidence changed since cleanup was requested', 'STALE_TARGET');
      requireValue(inspected.exists || existing, 'Resource disappeared without a cleanup receipt', 'OWNERSHIP_UNCERTAIN');
      if (existing?.status === 'completed') { requireValue(!inspected.exists && !inspected.registered, 'Cleaned path or registration was recreated', 'OWNERSHIP_UNCERTAIN'); return { cleaned: true }; }
      db.prepare("INSERT INTO resource_cleanup(goal_id,attempt_id,head_sha,status,error) VALUES (?,?,?,'pending',NULL) ON CONFLICT(goal_id,attempt_id) DO UPDATE SET status='pending',error=NULL").run(goalId, attemptId, inspected.head);
      this.failpoint('cleanup_intent');
      if (inspected.exists) {
        requireValue(await this.repositories.checkCheckout(inspected.resource) === inspected.head && await this.repositories.ref(inspected.resource.repository, `refs/heads/${inspected.resource.branch}`) === inspected.head, 'Checkout head changed during cleanup', 'STALE_TARGET');
        await this.requireEmptyCheckout(inspected.resource.worktree);
        this.assertOwned(); this.eligible(goalId, expectedVersion);
      }
      // A crash inside Git can remove the directory before its registration.
      if (inspected.exists || inspected.registered) {
        this.assertOwned(); this.eligible(goalId, expectedVersion);
        // Never force: Git must independently refuse dirt, locks and submodules.
        await git(inspected.resource.repository, ['worktree', 'remove', inspected.resource.worktree]);
      }
      requireValue(!pathExists(inspected.resource.worktree) && !await this.registration(inspected.resource), 'Worktree removal is incomplete', 'OWNERSHIP_UNCERTAIN');
      this.failpoint('cleanup_removed'); this.assertOwned();
      db.prepare("UPDATE resource_cleanup SET status='completed',error=NULL WHERE goal_id=? AND attempt_id=?").run(goalId, attemptId);
      return { cleaned: true };
    } catch (error) {
      db.prepare("UPDATE resource_cleanup SET status='failed',error='Cleanup failed; inspect ownership and retry explicitly' WHERE goal_id=? AND attempt_id=? AND status!='completed'").run(goalId, attemptId);
      throw error;
    } finally { this.active.delete(key); }
  }
}
