import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitRepository } from '../server/orchestration/adapters/git.mjs';
import { ArtifactStore } from '../server/orchestration/storage/artifacts.mjs';
import { VerificationCoordinator } from '../server/orchestration/verification-coordinator.mjs';
import { createRepositoryFixture, fixtureGit } from './helpers/orchestration/fixture.mjs';

async function fixture(t) {
  const repo = await createRepositoryFixture(); t.after(() => repo.close());
  const artifacts = new ArtifactStore({ directory: join(repo.directory, 'artifacts') });
  const repositories = new GitRepository({ repositories: new Map([['repo', repo.repository]]), directory: join(repo.directory, 'resources'), artifacts });
  const provisioned = await repositories.provision({ operationId: 'verify_a', repositoryId: 'repo', branch: 'companion/g/verify_a', baseSha: repo.baseSha });
  return { repo, repositories, provisioned };
}

test('a verification worktree with installed dependencies is removed while branch, ref and manifest remain', async (t) => {
  const { repo, repositories, provisioned } = await fixture(t);
  mkdirSync(join(provisioned.worktree, 'node_modules')); writeFileSync(join(provisioned.worktree, 'node_modules', 'blob'), 'x');
  assert.deepEqual(await repositories.removeVerificationWorktree('verify_a'), { removed: true });
  assert.equal(existsSync(provisioned.worktree), false);
  assert.equal(await fixtureGit(repo.repository, ['rev-parse', '--verify', 'refs/heads/companion/g/verify_a']), repo.baseSha);
  assert.equal(await fixtureGit(repo.repository, ['rev-parse', '--verify', 'refs/companion/resources/verify_a']), repo.baseSha);
  assert.ok(repositories.resource('verify_a'));
  assert.deepEqual(await repositories.removeVerificationWorktree('verify_a'), { removed: false });
});

test('removal refuses a worktree whose branch no longer matches its manifest', async (t) => {
  const { repositories, provisioned } = await fixture(t);
  await fixtureGit(provisioned.worktree, ['checkout', '-q', '-b', 'someone-else']);
  await assert.rejects(repositories.removeVerificationWorktree('verify_a'), { code: 'STALE_TARGET' });
  assert.equal(existsSync(provisioned.worktree), true);
});

test('removal of an unknown operation is a no-op', async (t) => {
  const { repositories } = await fixture(t);
  assert.deepEqual(await repositories.removeVerificationWorktree('never_provisioned'), { removed: false });
});

test('the coordinator removes the worktree after a stopped result and sweeps leftovers on startup', async (t) => {
  const { repositories, provisioned } = await fixture(t);
  const removed = [];
  const port = { removeVerificationWorktree: async (id) => { removed.push(id); return repositories.removeVerificationWorktree(id); } };
  const head = 'h'.repeat(40);
  const goal = { id: 'g', status: 'building', generation: 1, revision: 1, integrationHead: head, repositoryId: 'repo', hold: { id: 'held', reasons: [] }, tasks: [], contracts: [], verificationRuns: [{ operationId: 'verify_a', generation: 1, revision: 1, headSha: head, status: 'complete', workerState: 'stopped', result: { verification: { headSha: head, checks: [] }, workerState: 'stopped', artifactId: 'a'.repeat(64) } }] };
  const store = { list: () => [goal], get: () => goal, operations: () => [], advanceOperation: () => true };
  const service = { store, repositoryIds: new Set(['repo']), execute: () => ({}) };
  const coordinator = new VerificationCoordinator({ service, verifier: { run: async () => { throw new Error('unused'); }, observe: async () => null }, ownership: { assertOwned() {} }, repositories: port });
  await Promise.all([coordinator.run(), coordinator.run()]);
  assert.deepEqual(removed, ['verify_a'], 'concurrent ticks share one removal');
  assert.equal(existsSync(provisioned.worktree), false);
  await coordinator.run();
  assert.deepEqual(removed, ['verify_a', 'verify_a']);
});

test('a removal failure is reported and never throws out of the coordinator', async (t) => {
  await fixture(t);
  const errors = [];
  const head = 'h'.repeat(40);
  const goal = { id: 'g', status: 'building', generation: 1, revision: 1, integrationHead: head, repositoryId: 'repo', hold: { id: 'held', reasons: [] }, tasks: [], contracts: [], verificationRuns: [{ operationId: 'verify_a', generation: 1, revision: 1, headSha: head, status: 'complete', workerState: 'stopped', result: { verification: { headSha: head, checks: [] }, workerState: 'stopped', artifactId: 'a'.repeat(64) } }] };
  const store = { list: () => [goal], get: () => goal, operations: () => [], advanceOperation: () => true };
  const service = { store, repositoryIds: new Set(['repo']), execute: () => ({}) };
  const coordinator = new VerificationCoordinator({ service, verifier: { run: async () => { throw new Error('unused'); }, observe: async () => null }, ownership: { assertOwned() {} }, repositories: { removeVerificationWorktree: async () => { throw new Error('disk busy'); } }, onError: (error) => errors.push(error.message) });
  await coordinator.run();
  assert.deepEqual(errors, ['disk busy']);
});
