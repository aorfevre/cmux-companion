/** Browser-safe state projection. Never expose provider credentials or raw contexts.
 * @param {import('../types.d.ts').Goal} goal
 */
export function goalView(goal) {
  return { id: goal.id, version: goal.version, generation: goal.generation, title: goal.title,
    status: goal.status, revision: goal.revision, approvedRevision: goal.approvedRevision,
    integrationHead: goal.integrationHead, pr: goal.pr, verification: goal.verification,
    tasks: goal.tasks.map((task) => ({ id: task.id, title: task.title, dependsOn: task.dependsOn,
      status: task.status, candidateSha: task.candidateSha, integratedSha: task.integratedSha,
      repairCount: task.repairCount, repairLimit: task.repairLimit })),
    attempts: goal.attempts.map((attempt) => ({ id: attempt.id, role: attempt.role, taskId: attempt.taskId,
      status: attempt.status, workerState: attempt.workerState, target: attempt.target, error: attempt.error })),
    reviews: goal.reviews.map((review) => ({ id: review.id, kind: review.kind, taskId: review.taskId,
      target: review.target, disposition: review.disposition, findings: review.findings })),
  };
}
