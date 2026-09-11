import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { ArtifactStore } from '../server/orchestration/storage/artifacts.mjs';
import { OrchestrationService } from '../server/orchestration/service.mjs';
import { AgentResults } from '../server/orchestration/agent-results.mjs';
import { Scheduler } from '../server/orchestration/scheduler.mjs';
import { GitRepository } from '../server/orchestration/adapters/git.mjs';
import { GitIntegration } from '../server/orchestration/adapters/git-integration.mjs';
import { ScriptedAgents, barrier } from './helpers/orchestration/fake-agents.mjs';
import { createRepositoryFixture, fixtureGit } from './helpers/orchestration/fixture.mjs';

for (const conflict of [false, true]) test(`scheduler plans, overlaps A/B, integrates siblings and repairs C; conflict=${conflict}`, { timeout: 60000 }, async (t) => {
  const repo = await createRepositoryFixture({ conflict });
  const store = new OrchestrationStore({ path: join(repo.directory, 'workflow.sqlite') });
  const artifacts = new ArtifactStore({ directory: join(repo.directory, 'artifacts') });
  const repositories = new GitRepository({ repositories: new Map([['repo', repo.repository]]), directory: join(repo.directory, 'resources'), artifacts });
  const integrations = new GitIntegration({ repositories });
  const started = new Map([['A', barrier()], ['B', barrier()]]), release = barrier();
  let results, cAttempts = 0;
  const agents = new ScriptedAgents({
    script: async ({ attempt }) => {
      if (attempt.role === 'planner') return { contract: repo.contract };
      if (attempt.role === 'implementer') {
        if (started.has(attempt.taskId)) { started.get(attempt.taskId).release(); await release.promise; }
        const failing = attempt.taskId === 'C' && ++cAttempts === 1;
        const headSha = await repo.implement(attempt.worktree, attempt.taskId, { failing });
        return { headSha, summary: 'Implemented fixture module', evidence: [] };
      }
      if (attempt.role === 'integrator') {
        writeFileSync(join(attempt.worktree, 'src/composition.mjs'), "export function composition() { return 'Resolved, awaiting C'; }\n");
        await fixtureGit(attempt.worktree, ['add', 'src']);
        await fixtureGit(attempt.worktree, ['commit', '-m', 'Resolve sibling composition conflict']);
        return { headSha: await fixtureGit(attempt.worktree, ['rev-parse', 'HEAD']), operationId: store.get('g').integration.operationId, summary: 'Resolved the recorded conflict', evidence: [] };
      }
      assert.equal(attempt.role, 'reviewer');
      const failing = attempt.taskId === 'C' && !(await repo.verify(attempt.worktree)).passed;
      return { schemaVersion: 1, target: attempt.target, disposition: failing ? 'request_changes' : 'accept', findings: failing ? [{ id: 'wrong_composition', severity: 'high', blocking: true, title: 'Composition subtracts instead of adding', evidence: 'Acceptance test fails on the exact review checkout', suggestion: 'Add a() and b()' }] : [] };
    },
    onResult: async ({ goalId, attempt }, output) => results.receive({ kind: 'agent', goalId, attemptId: attempt.id, role: attempt.role, generation: attempt.generation, revision: attempt.revision }, attempt.operationId,
      JSON.stringify({ schemaVersion: 1, goalId, attemptId: attempt.id, operationId: attempt.operationId, role: attempt.role, generation: attempt.generation, revision: attempt.revision, target: attempt.target, output })),
  });
  const service = new OrchestrationService({ store, agents, repositoryIds: new Set(['repo']), limits: { global: 2, perGoal: 2 } });
  results = new AgentResults({ service, artifacts, repositories });
  const errors = [], scheduler = new Scheduler({ service, repositories, integrations, results, onError: (error) => errors.push(error) });
  t.after(async () => { release.release(); await agents.drain(); await scheduler.stop(); store.close(); await repo.close(); });
  service.execute({ id: 'create', goalId: 'g', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'Deliver fixture', baseSha: repo.baseSha } }, { kind: 'user' });
  await scheduler.start();
  for (let i = 0; i < 8 && !store.get('g').reviews.length; i++) { await agents.drain(); await scheduler.tick(); }
  assert.equal(store.get('g').reviews[0].disposition, 'accept');
  service.execute({ id: 'approve', goalId: 'g', expectedVersion: store.get('g').version, type: 'approve', payload: { revision: 1 } }, { kind: 'user' });
  await scheduler.tick(); await Promise.all([...started.values()].map((entry) => entry.promise));
  const siblings = store.get('g').attempts.filter((attempt) => attempt.role === 'implementer');
  assert.equal(siblings.length, 2); assert.equal(new Set(siblings.map((attempt) => attempt.worktree)).size, 2);
  assert.ok(siblings.every((attempt) => attempt.baseSha === repo.baseSha));
  assert.equal(store.get('g').tasks[2].status, 'pending');
  release.release();
  for (let i = 0; i < 20 && !store.get('g').tasks.every((task) => task.status === 'integrated'); i++) { await agents.drain(); await scheduler.tick(); }
  const goal = store.get('g');
  assert.deepEqual(errors, []); assert.deepEqual(agents.errors, []);
  assert.ok(goal.tasks.every((task) => task.status === 'integrated'), JSON.stringify(goal.tasks));
  assert.equal(goal.attempts.filter((attempt) => attempt.role === 'integrator').length, conflict ? 1 : 0);
  if (conflict) assert.equal(goal.results.filter((result) => result.repair && result.status === 'accepted').length, 1);
  assert.equal(cAttempts, 2); assert.equal(goal.tasks[2].repairCount, 1);
  const combined = goal.integrationResults.filter((result) => result.taskId === 'A' || result.taskId === 'B').at(-1).headSha;
  assert.ok(goal.attempts.filter((attempt) => attempt.role === 'implementer' && attempt.taskId === 'C').every((attempt) => attempt.baseSha === combined));
  assert.equal(goal.reviews.filter((review) => review.kind === 'task' && review.disposition === 'request_changes').length, 1);
  const final = await repo.checkout('final', goal.integrationHead);
  assert.equal((await repo.verify(final.worktree)).passed, true);
  assert.equal(store.events({ limit: 500 }).filter((event) => event.kind === 'task_integrated').length, 3);
});
