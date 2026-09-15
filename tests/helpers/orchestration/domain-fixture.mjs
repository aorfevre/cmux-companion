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
  const request = (id, role, taskId = null) => command('request_attempt', { attemptId: id, operationId: `op_${id}`, role, taskId, conversationId: `conversation_${id}` });
  const dispatch = (id) => command('record_dispatch', { attemptId: id, identity: `process_${id}`, worktree: `/tmp/${id}`, branch: `goal/${id}` });
  const review = (id, target, blocking = false) => { const result = command('record_review', { attemptId: id, reviewId: `review_${id}`, review: { schemaVersion: 1, target, disposition: blocking ? 'request_changes' : 'accept', findings: blocking ? [{ id: 'F1', severity: 'high', blocking: true, title: 'Incorrect value', evidence: 'src/a.mjs:1', suggestion: 'Return the required value' }] : [] } }); command('record_stopped', { attemptId: id }); return result; };
  const approve = (value = contract()) => {
    command('publish_contract', { contract: value }, user);
    request('plan_review', 'reviewer'); dispatch('plan_review'); review('plan_review', planTarget(goal));
    command('approve', { revision: goal.revision }, user);
  };
  const recover = () => command('recover_goal', { holdId: goal.hold.id }, user);
  return { recover, get goal() { return goal; }, command, request, dispatch, review, approve, user, system };
}
