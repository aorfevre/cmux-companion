import { currentWave } from './waves.mjs';
import { shortGoalTitle } from './goal-presentation.mjs';
import { actionView } from './action-view.mjs';
/** Browser-safe state projection. Never expose provider credentials or raw contexts.
 * @param {import('../types.d.ts').Goal} goal
 */
export function goalView(goal) {
  return { ...actionView(goal), repositoryId: goal.repositoryId, id: goal.id, version: goal.version, generation: goal.generation, title: goal.description === undefined ? shortGoalTitle(goal.title) : goal.title, description: goal.description ?? goal.title, projectCode: goal.projectCode, plannerName: goal.plannerName, clarification: goal.clarification ?? null,
    baseBranch: goal.baseBranch, baseSha: goal.baseSha, startup: goal.startup ?? null,
    waves: (goal.contracts.find(entry => entry.revision === goal.revision)?.contract.waves ?? []).map((wave, index) => { const proof = goal.waveResults?.filter(result => result.waveId === wave.id && result.generation === goal.generation && result.revision === goal.revision).at(-1); return { ...wave, number: index + 1, current: currentWave(goal)?.id === wave.id, checkedHead: proof?.headSha ?? null }; }),
    team: goal.team ?? null, teamHistory: goal.teamHistory ?? [], teamConfiguration: goal.teamConfiguration ? { ...goal.teamConfiguration, profiles: goal.teamConfiguration.profiles.map(profile => ({ ...profile, capacity: { ...profile.capacity, fresh: Boolean(profile.capacity.checkedAt && Date.now() - Date.parse(profile.capacity.checkedAt) <= 15 * 60 * 1000) } })) } : null, references: goal.references ?? [], status: goal.status, hold: goal.hold ?? null, recoveries: goal.recoveries ?? [], revision: goal.revision, approvedRevision: goal.approvedRevision,
    integrationHead: goal.integrationHead, integration: goal.integration ? { state: goal.integration.state, taskId: goal.integration.taskId, expectedHead: goal.integration.expectedHead, candidateSha: goal.integration.candidateSha, code: goal.integration.code ?? null } : null, integrationResults: goal.integrationResults ?? [], pr: goal.pr, mergeSync: goal.mergeSync ?? null, verification: goal.verification,
    verificationRuns: (goal.verificationRuns ?? []).map(run => ({ operationId: run.operationId, revision: run.revision, current: run.generation === goal.generation && run.revision === goal.revision, waveId: run.waveId ?? null, headSha: run.headSha, status: run.status, workerState: run.workerState, verification: run.result?.verification ?? null })),
    publication: goal.publication ? { branch: goal.publication.plan.branch, baseBranch: goal.publication.plan.baseBranch, baseSha: goal.publication.plan.baseSha, approved: Boolean(goal.publication.approval), observation: goal.publication.observation ?? null } : null,
    tasks: goal.tasks.map((task) => ({ id: task.id, title: task.title, dependsOn: task.dependsOn,
      ownedAreas: task.ownedAreas, criterionIds: task.criterionIds, resources: task.resources ?? [], status: task.status, candidateSha: task.candidateSha, integratedSha: task.integratedSha,
      repairCount: task.repairCount, repairLimit: task.repairLimit })),
    attempts: goal.attempts.map((attempt) => ({ id: attempt.id, role: attempt.role, taskId: attempt.taskId,
      assignment: attempt.assignment ?? null, current: attempt.generation === goal.generation && attempt.revision === goal.revision, mode: attempt.mode, status: attempt.status, workerState: attempt.workerState, target: attempt.target, error: attempt.error })),
    reviews: goal.reviews.map((review) => ({ id: review.id, kind: review.kind, taskId: review.taskId,
      target: review.target, disposition: review.disposition, findings: review.findings })),
  };
}
