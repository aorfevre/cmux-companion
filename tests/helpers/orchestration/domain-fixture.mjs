import { transition, planTarget } from '../../../server/orchestration/domain/transitions.mjs';
export const BASE = 'a'.repeat(40);
export const HEAD_A = 'b'.repeat(40);
export const HEAD_B = 'c'.repeat(40);
export const contract = () => ({ schemaVersion: 1, outcome: 'Combine independently implemented modules', scope: ['Modules A and B and their composition'], exclusions: ['Publishing packages'],
  criteria: [{ id: 'works', text: 'The composition produces the required value', verification: 'unit' }],
  verification: [{ id: 'unit', argv: ['node', '--test'] }],
  tasks: [
    { id: 'A', title: 'Module A', prompt: 'Implement A', dependsOn: [], ownedAreas: ['src/a.mjs'], criterionIds: ['works'] },
    { id: 'B', title: 'Module B', prompt: 'Implement B', dependsOn: [], ownedAreas: ['src/b.mjs'], criterionIds: ['works'] },
    { id: 'C', title: 'Composition', prompt: 'Compose A and B', dependsOn: ['A', 'B'], ownedAreas: ['src/composition.mjs'], criterionIds: ['works'] },
  ] });
export function fixture() {
  let goal = null, next = 0;
  const user = { kind: 'user' }, system = { kind: 'system' };
  const command = (type, payload = {}, authority = system) => {
    const result = transition(goal, { id: `cmd${++next}`, goalId: 'goal', expectedVersion: goal?.version ?? 0, type, payload }, authority);
    goal = result.goal; return result;
  };
  command('create_goal', { repositoryId: 'repo', title: 'Build modules', baseSha: BASE }, user);
  /** @param {string} id @param {import('../../../server/orchestration/types.d.ts').Role} role @param {string | null} [taskId] */
  const request = (id, role, taskId = null) => command('request_attempt', { attemptId: id, operationId: `op_${id}`, role, taskId, conversationId: `conversation_${id}` });
  const dispatch = (id) => command('record_dispatch', { attemptId: id, identity: `process_${id}`, worktree: `/tmp/${id}`, branch: `goal/${id}` });
  const review = (id, target, blocking = false) => { const result = command('record_review', { attemptId: id, reviewId: `review_${id}`, review: { schemaVersion: 1, target, disposition: blocking ? 'request_changes' : 'accept', findings: blocking ? [{ id: 'F1', severity: 'high', blocking: true, title: 'Incorrect value', evidence: 'src/a.mjs:1', suggestion: 'Return the required value' }] : [] } }); command('record_stopped', { attemptId: id }); return result; };
  const approve = (value = contract()) => {
    command('publish_contract', { contract: value }, user);
    request('plan_review', 'reviewer'); dispatch('plan_review'); review('plan_review', planTarget(goal));
    command('approve', { revision: goal.revision }, user);
  };
  const recover = () => command('recover_goal', { holdId: goal.hold.id }, user);
  /** Drive a single-task goal to delivered with pull request 1 at HEAD_B. */
  const deliver = () => {
    const single = contract(); single.tasks = [single.tasks[0]]; approve(single);
    request('a', 'implementer', 'A'); dispatch('a'); command('confirm_candidate', { attemptId: 'a', headSha: HEAD_A }); command('record_stopped', { attemptId: 'a' });
    request('ar', 'reviewer', 'A'); dispatch('ar'); review('ar', HEAD_A);
    command('request_integration', { taskId: 'A', operationId: 'integrate' });
    command('record_integration', { operationId: 'integrate', headSha: HEAD_B });
    request('final', 'reviewer'); dispatch('final'); review('final', HEAD_B);
    command('record_verification', { headSha: HEAD_B, checks: [{ id: 'unit', passed: true, artifactId: 'log' }] });
    command('request_publication', { operationId: 'publish' });
    command('approve_publication', { operationId: 'publish', headSha: HEAD_B }, user);
    command('record_pr', { operationId: 'publish', number: 1, url: 'https://example.test/pr/1', headSha: HEAD_B });
  };
  return { recover, deliver, get goal() { return goal; }, command, request, dispatch, review, approve, user, system };
}
