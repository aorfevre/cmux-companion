import { identifier, object, requireValue, sha, text } from './domain/contracts.mjs';
import { currentContract, validateAuthority } from './domain/transitions.mjs';

/** Role-scoped filesystem tools have no lifecycle authority. The service remains
 * responsible for candidate verification, independent review and integration.
 */
export class AgentTools {
  /** @param {{ service: import('./service.mjs').OrchestrationService; commits: { commit(input: { repositoryId: string; attempt: import('./types.d.ts').Attempt; ownedAreas: string[]; id: string; expectedHead: string; message: string; assertAuthorized: () => void }): Promise<{headSha: string}> } }} options */
  constructor({ service, commits }) { this.service = service; this.commits = commits; }
  /** @param {Extract<import('./types.d.ts').Authority, {kind:'agent'}>} authority @param {unknown} value */
  async commit(authority, value) {
    const input = object(value);
    requireValue(Object.keys(input).length === 3 && ['id', 'expectedHead', 'message'].every((key) => Object.hasOwn(input, key)), 'Expected commit id, head and message');
    const id = identifier(input.id), expectedHead = sha(input.expectedHead), message = text(input.message, 1000);
    const authorize = () => {
      const goal = this.service.store.get(authority.goalId); requireValue(goal, 'Agent goal is unavailable', 'FORBIDDEN');
      validateAuthority(goal, authority);
      requireValue(this.service.repositoryIds.has(goal.repositoryId) && goal.status === 'building' && goal.approvedRevision === goal.revision && ['implementer', 'integrator'].includes(authority.role), 'This attempt cannot commit', 'FORBIDDEN');
      requireValue(this.service.ownership, 'Scheduler ownership is unavailable', 'OWNERSHIP_UNCERTAIN');
      this.service.ownership.assertOwned();
      return goal;
    };
    const goal = authorize(), attempt = goal.attempts.find((entry) => entry.id === authority.attemptId);
    requireValue(attempt, 'Attempt is unavailable', 'FORBIDDEN');
    const task = attempt.taskId ? goal.tasks.find((entry) => entry.id === attempt.taskId) : null;
    const ownedAreas = task ? task.ownedAreas : currentContract(goal).tasks.flatMap((entry) => entry.ownedAreas);
    return this.commits.commit({ repositoryId: goal.repositoryId, attempt, ownedAreas, id, expectedHead, message, assertAuthorized: () => { authorize(); } });
  }
}
