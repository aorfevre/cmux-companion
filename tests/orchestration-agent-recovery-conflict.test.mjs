import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntime } from '../server/orchestration/create-runtime.mjs';
import { ScriptedAgents, barrier } from './helpers/orchestration/fake-agents.mjs';
import { createRepositoryFixture, fixtureGit } from './helpers/orchestration/fixture.mjs';
import { goalView } from '../server/orchestration/domain/state-view.mjs';

test('an explicitly adopted legacy goal repairs a real sibling Git conflict without a recovery click', { timeout: 60000 }, async t => {
  const repo = await createRepositoryFixture({ conflict: true });
  const siblings = barrier(), arrived = new Set(), errors = [];
  let runtime, agents;
  const profile = { id: 'fixture', label: 'Fixture', provider: 'claude', model: 'fixture', roles: ['planner', 'implementer', 'reviewer', 'integrator'], ready: true, reason: 'Fake adapter', capacity: { remainingPercent: null, source: 'fixture', checkedAt: null, reason: 'No external account' } };
  runtime = await createRuntime({
    storage: { database: join(repo.directory, 'state.sqlite'), artifacts: join(repo.directory, 'artifacts'), resources: join(repo.directory, 'resources') },
    repositories: new Map([['repo', repo.repository]]), token: 'disposable-conflict-token-at-least-32-characters', limits: { global: 3, perGoal: 3 }, planReviewEnabled: () => false,
    createAgents: ({ onResult }) => {
      agents = new ScriptedAgents({
        script: async ({ goalId, attempt }) => {
          if (attempt.role === 'implementer') {
            if (['A', 'B'].includes(attempt.taskId)) { arrived.add(attempt.taskId); if (arrived.size === 2) siblings.release(); await siblings.promise; }
            return { headSha: await repo.implement(attempt.worktree, attempt.taskId), summary: 'Implement owned module', evidence: [] };
          }
          if (attempt.role === 'integrator') {
            await writeFile(join(attempt.worktree, 'src/composition.mjs'), "export function composition() { return 'resolved'; }\n");
            await fixtureGit(attempt.worktree, ['add', 'src/composition.mjs']);
            await fixtureGit(attempt.worktree, ['commit', '-m', 'Resolve recorded conflict']);
            return { headSha: await fixtureGit(attempt.worktree, ['rev-parse', 'HEAD']), operationId: runtime.store.get(goalId).integration.operationId, summary: 'Resolved conflicting sibling edits', evidence: [] };
          }
          assert.equal(attempt.role, 'reviewer');
          return { schemaVersion: 1, target: attempt.target, disposition: 'accept', findings: [] };
        },
        onResult: ({ goalId, attempt }, output) => onResult({ goalId, attempt, operationId: attempt.operationId }, JSON.stringify({ schemaVersion: 1, goalId, operationId: attempt.operationId, attemptId: attempt.id, generation: attempt.generation, revision: attempt.revision, role: attempt.role, target: attempt.target, output })),
      });
      const launch = agents.launch.bind(agents);
      // A standing fake supervisor owns no model process; background roles run
      // real isolated Git work. It does not authorize any recovery commands.
      agents.launch = request => request.attempt.role === 'planner' ? Promise.resolve(agents.beginLaunch(request)) : launch(request);
      agents.close = async () => { siblings.release(); for (const controller of agents.controllers.values()) controller.abort(); await agents.drain(); };
      return agents;
    },
    resolveCheck: (_repo, check) => ({ bin: process.execPath, argv: check.argv.slice(1), env: { PATH: process.env.PATH, NODE_OPTIONS: `--import=${new URL('./helpers/orchestration/await-verification-identity.mjs', import.meta.url).href}` }, environmentId: 'fixture', policy: { ceilingMs: 10000, idleMs: 5000, maxOutputBytes: 8192, killGraceMs: 100 } }),
    createPublisher: () => ({ publish: async () => { throw new Error('No publication approval was given'); } }), onError: error => errors.push(error),
  });
  t.after(async () => { await runtime.close(); await repo.close(); });
  const command = (type, payload, kind = 'user') => runtime.service.execute({ id: randomUUID(), goalId: 'g', expectedVersion: runtime.store.get('g')?.version ?? 0, type, payload }, { kind });
  command('create_goal', { repositoryId: 'repo', title: 'Repair sibling conflict', baseSha: repo.baseSha, teamConfiguration: { profiles: [profile], defaults: Object.fromEntries(profile.roles.map(role => [role, profile.id])), capturedAt: new Date().toISOString() } });
  command('set_plan_review_policy', { enabled: false }, 'system');
  command('publish_contract', { contract: repo.contract }); command('approve', { revision: 1 });
  command('adopt_agent_recovery', {});
  await runtime.listen();
  for (let i = 0; i < 1000 && runtime.store.get('g').status !== 'ready_to_publish'; i++) {
    const recovery = goalView(runtime.store.get('g')).recovery;
    assert.notEqual(recovery?.state, 'blocked', recovery?.reason);
    assert.deepEqual(errors, []);
    await delay(40);
  }
  const goal = runtime.store.get('g');
  assert.equal(goal.status, 'ready_to_publish', JSON.stringify({ hold: goal.hold, tasks: goal.tasks, errors: errors.map(error => error.message) }));
  assert.ok(goal.recoveryPolicy.decisions.some(entry => entry.evidence.some(item => item.cause === 'INTEGRATION_CONFLICT')));
  assert.ok(goal.recoveries.every(entry => goal.recoveryPolicy.decisions.some(decision => decision.holdId === entry.hold.id)));
  assert.equal(goal.approvedRevision, 1); assert.equal(goal.pr, null);
  assert.ok(goal.verification.checks.every(check => check.passed));
  assert.equal(goal.verification.headSha, goal.integrationHead);
  t.diagnostic(JSON.stringify({ scenario: 'integration-conflict', recoveryClicks: 0, actions: goal.recoveryPolicy.decisions.length, verifiedHead: goal.integrationHead }));
});
