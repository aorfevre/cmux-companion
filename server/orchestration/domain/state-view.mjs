import { shortGoalTitle } from './goal-presentation.mjs';
import { actionView } from './action-view.mjs';
/** Browser-safe state projection. Never expose provider credentials or raw contexts.
 * @param {import('../types.d.ts').Goal} goal
 */
export function goalView(goal) {
  return { ...actionView(goal), repositoryId: goal.repositoryId, id: goal.id, version: goal.version, generation: goal.generation, title: goal.description === undefined ? shortGoalTitle(goal.title) : goal.title, description: goal.description ?? goal.title, projectCode: goal.projectCode, plannerName: goal.plannerName, clarification: goal.clarification ?? null,
    baseBranch: goal.baseBranch, baseSha: goal.baseSha, startup: goal.startup ?? null,
    status: goal.status, revision: goal.revision, approvedRevision: goal.approvedRevision,
    integrationHead: goal.integrationHead, pr: goal.pr, mergeSync: goal.mergeSync ?? null, verification: goal.verification,
    publication: goal.publication ? { branch: goal.publication.plan.branch, baseBranch: goal.publication.plan.baseBranch, baseSha: goal.publication.plan.baseSha, approved: Boolean(goal.publication.approval), observation: goal.publication.observation ?? null } : null,
    tasks: goal.tasks.map((task) => ({ id: task.id, title: task.title, dependsOn: task.dependsOn,
      status: task.status, candidateSha: task.candidateSha, integratedSha: task.integratedSha,
      repairCount: task.repairCount, repairLimit: task.repairLimit })),
    attempts: goal.attempts.map((attempt) => ({ id: attempt.id, role: attempt.role, taskId: attempt.taskId,
      current: attempt.generation === goal.generation && attempt.revision === goal.revision, mode: attempt.mode, status: attempt.status, workerState: attempt.workerState, target: attempt.target, error: attempt.error })),
    reviews: goal.reviews.map((review) => ({ id: review.id, kind: review.kind, taskId: review.taskId,
      target: review.target, disposition: review.disposition, findings: review.findings })),
  };
}
