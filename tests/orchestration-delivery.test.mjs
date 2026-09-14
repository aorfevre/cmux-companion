import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { ArtifactStore } from '../server/orchestration/storage/artifacts.mjs';
import { OrchestrationService } from '../server/orchestration/service.mjs';
import { AgentResults } from '../server/orchestration/agent-results.mjs';
import { Scheduler } from '../server/orchestration/scheduler.mjs';
import { GitRepository } from '../server/orchestration/adapters/git.mjs';
import { VerificationRunner } from '../server/orchestration/adapters/verification.mjs';
import { GitRemote } from '../server/orchestration/adapters/git-remote.mjs';
import { GitHubPublication } from '../server/orchestration/adapters/github.mjs';
import { FakeGitHub } from './helpers/orchestration/fake-github.mjs';
import { GitIntegration } from '../server/orchestration/adapters/git-integration.mjs';
import { ScriptedAgents, barrier } from './helpers/orchestration/fake-agents.mjs';
import { createRepositoryFixture, fixtureGit } from './helpers/orchestration/fixture.mjs';

for (const { conflict, finalFailure = null, movedTarget = false } of [{ conflict: false }, { conflict: true }, { conflict: false, finalFailure: 'review' }, { conflict: false, finalFailure: 'check' }, { conflict: false, movedTarget: true }]) test(`scheduler plans, overlaps A/B, integrates siblings and repairs C; conflict=${conflict}, final=${finalFailure}, moved=${movedTarget}`, { timeout: 60000 }, async (t) => {
  const repo = await createRepositoryFixture({ conflict });
  if (movedTarget) {
    const target = await repo.checkout('remote_target');
    writeFileSync(join(target.worktree, 'target-update.txt'), 'Remote advanced before goal creation\n');
    await fixtureGit(target.worktree, ['add', 'target-update.txt']); await fixtureGit(target.worktree, ['commit', '-m', 'Advance remote target']);
    await fixtureGit(target.worktree, ['push', 'origin', 'HEAD:refs/heads/main']);
    assert.equal(await fixtureGit(repo.repository, ['rev-parse', 'refs/heads/main']), repo.baseSha);
  }
  if (finalFailure === 'check') repo.contract.verification.push({ id: 'injected_dependencies', argv: ['node', '--input-type=module', '-e', "import { composition } from './src/composition.mjs'; if (composition(() => 7, () => 11) !== 18) process.exit(1);"] });
  const store = new OrchestrationStore({ path: join(repo.directory, 'workflow.sqlite') });
  const artifacts = new ArtifactStore({ directory: join(repo.directory, 'artifacts') });
  const repositories = new GitRepository({ repositories: new Map([['repo', repo.repository]]), directory: join(repo.directory, 'resources'), artifacts });
  const integrations = new GitIntegration({ repositories });
  const remote = new GitRemote({ repositories, directory: join(repo.directory, 'remote-stage'), destinations: new Map([['repo', { url: realpathSync(repo.remote), protocol: 'file', env: { PATH: process.env.PATH } }]]) });
  const github = new FakeGitHub({ remote });
  const publisher = new GitHubPublication({ directory: join(repo.directory, 'publications'), remote, github });
  const verifier = new VerificationRunner({ repositories, resolveCheck: (repositoryId, check) => {
    assert.equal(repositoryId, 'repo'); assert.equal(check.argv[0], 'node');
    return { bin: process.execPath, argv: check.argv.slice(1), env: { PATH: process.env.PATH }, environmentId: 'fixture-node', policy: { ceilingMs: 10000, idleMs: 2000, maxOutputBytes: 8192, killGraceMs: 100 } };
  } });
  const started = new Map([['A', barrier()], ['B', barrier()]]), release = barrier();
  let results, cAttempts = 0, finalRepairs = 0;
  const agents = new ScriptedAgents({
    script: async ({ attempt }) => {
      if (attempt.role === 'planner') return { contract: repo.contract };
      if (attempt.role === 'implementer') {
        if (started.has(attempt.taskId)) { started.get(attempt.taskId).release(); await release.promise; }
        const failing = attempt.taskId === 'C' && ++cAttempts === 1;
        const headSha = await repo.implement(attempt.worktree, attempt.taskId, { failing });
        return { headSha, summary: 'Implemented fixture module', evidence: [] };
      }
      if (attempt.role === 'integrator' && attempt.taskId === null) {
        finalRepairs++;
        const current = store.get('g');
        assert.throws(() => service.execute({ id: 'premature_publication', goalId: 'g', expectedVersion: current.version, type: 'request_publication', payload: { operationId: 'premature' } }, { kind: 'system' }), { code: 'NOT_READY' });
        if (finalFailure === 'check') assert.ok(current.verification.checks.some((check) => !check.passed));
        writeFileSync(join(attempt.worktree, 'src/composition.mjs'), "import { a } from './a.mjs';\nimport { b } from './b.mjs';\nexport function composition(aSource = a, bSource = b) { return aSource() + bSource(); }\n");
        await fixtureGit(attempt.worktree, ['add', 'src']);
        await fixtureGit(attempt.worktree, ['commit', '-m', 'Allow independent composition dependencies']);
        return { headSha: await fixtureGit(attempt.worktree, ['rev-parse', 'HEAD']), operationId: null, summary: 'Repair final integration evidence', evidence: [] };
      }
      if (attempt.role === 'integrator') {
        writeFileSync(join(attempt.worktree, 'src/composition.mjs'), "export function composition() { return 'Resolved, awaiting C'; }\n");
        await fixtureGit(attempt.worktree, ['add', 'src']);
        await fixtureGit(attempt.worktree, ['commit', '-m', 'Resolve sibling composition conflict']);
        return { headSha: await fixtureGit(attempt.worktree, ['rev-parse', 'HEAD']), operationId: store.get('g').integration.operationId, summary: 'Resolved the recorded conflict', evidence: [] };
      }
      assert.equal(attempt.role, 'reviewer');
      const failing = (attempt.taskId === 'C' && !(await repo.verify(attempt.worktree)).passed) || (finalFailure === 'review' && !attempt.taskId && !attempt.target.startsWith('contract:') && finalRepairs === 0);
      return { schemaVersion: 1, target: attempt.target, disposition: failing ? 'request_changes' : 'accept', findings: failing ? [{ id: 'wrong_composition', severity: 'high', blocking: true, title: 'Composition subtracts instead of adding', evidence: 'Acceptance test fails on the exact review checkout', suggestion: 'Add a() and b()' }] : [] };
    },
    onResult: async ({ goalId, attempt }, output) => results.receive({ kind: 'agent', goalId, attemptId: attempt.id, role: attempt.role, generation: attempt.generation, revision: attempt.revision }, attempt.operationId,
      JSON.stringify({ schemaVersion: 1, goalId, attemptId: attempt.id, operationId: attempt.operationId, role: attempt.role, generation: attempt.generation, revision: attempt.revision, target: attempt.target, output })),
  });
  const service = new OrchestrationService({ store, agents, repositoryIds: new Set(['repo']), limits: { global: 2, perGoal: 2 } });
  results = new AgentResults({ service, artifacts, repositories });
  if (conflict) {
    // Force the CI race: confirmed exit changes the version during Git proof.
    // Result intake must retry its pending evidence before another repair launches.
    const candidate = repositories.candidate.bind(repositories); let stoppedDuringProof = false;
    repositories.candidate = async input => {
      const proof = await candidate(input);
      if (input.attempt.role === 'integrator' && !stoppedDuringProof) {
        stoppedDuringProof = true;
        const current = store.get('g');
        service.execute({ id: 'stop_during_repair_proof', goalId: 'g', expectedVersion: current.version, type: 'record_stopped', payload: { attemptId: input.attempt.id } }, { kind: 'system' });
      }
      return proof;
    };
  }
  const errors = [], scheduler = new Scheduler({ service, repositories, integrations, verifier, publisher, results, onError: (error) => errors.push(error) });
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
  await scheduler.tick();
  await Promise.all([...scheduler.verifications.active.values()].map((run) => run.job));
  await agents.drain(); await scheduler.tick();
  for (let i = 0; finalFailure && i < 12; i++) {
    await agents.drain(); await scheduler.tick();
    await Promise.all([...scheduler.verifications.active.values()].map((run) => run.job));
    await agents.drain(); await scheduler.tick();
    const latest = store.get('g');
    if (finalRepairs && latest.verification?.headSha === latest.integrationHead && latest.verification.checks.every((check) => check.passed) && latest.reviews.some((review) => review.kind === 'integration' && review.target === latest.integrationHead && review.disposition === 'accept')) break;
  }
  for (let i = 0; i < 10 && store.get('g').status !== 'delivered'; i++) {
    await agents.drain(); await scheduler.tick();
    await Promise.all([...scheduler.verifications.active.values()].map((run) => run.job));
    await Promise.all([...scheduler.publications.active.values()].map((run) => run.job));
    const current = store.get('g');
    if (movedTarget && current.publication?.observation?.status === 'target_moved') {
      const before = { head: current.integrationHead, reviews: current.reviews, verification: current.verification };
      service.execute({ id: 'accept_remote_target', goalId: 'g', expectedVersion: current.version, type: 'accept_moved_target', payload: { operationId: current.publication.operationId, baseHeadSha: current.publication.observation.baseHeadSha } }, { kind: 'user' });
      const accepted = store.get('g');
      assert.deepEqual({ head: accepted.integrationHead, reviews: accepted.reviews, verification: accepted.verification }, before);
    }
  }
  const goal = store.get('g');
  if (finalFailure) {
    assert.equal(finalRepairs, 1); assert.equal(goal.finalRepairCount, 1);
    assert.equal(goal.verificationRuns.length, 2);
    assert.notEqual(goal.verificationRuns[0].headSha, goal.verificationRuns[1].headSha);
    assert.ok(goal.reviews.some((review) => review.kind === 'integration' && review.target === goal.integrationHead && review.disposition === 'accept'));
    assert.equal(goal.integrationResults.filter((result) => result.taskId === null).length, 1);
  }
  assert.deepEqual(errors, []); assert.deepEqual(agents.errors, []);
  assert.ok(goal.tasks.every((task) => task.status === 'integrated'), JSON.stringify(goal.tasks));
  assert.equal(goal.attempts.filter((attempt) => attempt.role === 'integrator').length, (conflict ? 1 : 0) + (finalFailure ? 1 : 0), JSON.stringify(goal.attempts.filter((attempt) => attempt.role === 'integrator').map(({ id, taskId, status, workerState }) => ({ id, taskId, status, workerState }))));
  if (conflict) assert.equal(goal.results.filter((result) => result.repair && result.status === 'accepted').length, 1);
  assert.equal(goal.verification.headSha, goal.integrationHead);
  assert.ok(goal.verification.checks.every((check) => check.passed));
  assert.equal(goal.status, 'delivered', JSON.stringify(goal.publication));
  assert.equal(github.creates.length, 1); assert.equal(goal.pr.headSha, goal.integrationHead);
  if (movedTarget) assert.equal(goal.publication.plan.acceptedTargets.length, 1);
  assert.equal(await remote.head('repo', goal.publication.plan.branch), goal.integrationHead);
  assert.equal(cAttempts, 2); assert.equal(goal.tasks[2].repairCount, 1);
  const combined = goal.integrationResults.filter((result) => result.taskId === 'A' || result.taskId === 'B').at(-1).headSha;
  assert.ok(goal.attempts.filter((attempt) => attempt.role === 'implementer' && attempt.taskId === 'C').every((attempt) => attempt.baseSha === combined));
  assert.equal(goal.reviews.filter((review) => review.kind === 'task' && review.disposition === 'request_changes').length, 1);
  const final = await repo.checkout('final', goal.integrationHead);
  assert.equal((await repo.verify(final.worktree)).passed, true);
  assert.equal(store.events({ limit: 500 }).filter((event) => event.kind === 'task_integrated').length, 3);
});
