import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { Reconciler } from '../server/orchestration/reconciler.mjs';
import { AgentResults } from '../server/orchestration/agent-results.mjs';
import { GitRepository } from '../server/orchestration/adapters/git.mjs';
import { ArtifactStore } from '../server/orchestration/storage/artifacts.mjs';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { OrchestrationService } from '../server/orchestration/service.mjs';
import { FakeAgents } from './helpers/orchestration/fake-agents.mjs';
import { createRepositoryFixture } from './helpers/orchestration/fixture.mjs';

async function fixture(t, withSibling = false) {
  const repo = await createRepositoryFixture();
  const artifacts = new ArtifactStore({ directory: join(repo.directory, 'artifacts') });
  const store = new OrchestrationStore({ path: join(repo.directory, 'state.sqlite') });
  t.after(async () => { store.close(); await repo.close(); });
  const service = new OrchestrationService({ store, agents: new FakeAgents(), repositoryIds: new Set(['repo']) });
  const repositories = new GitRepository({ repositories: new Map([['repo', repo.repository]]), directory: join(repo.directory, 'resources'), artifacts });
  const results = new AgentResults({ service, artifacts, repositories });
  let next = 0;
  const command = (type, payload, kind = 'system') => service.execute({ id: `cmd${++next}`, goalId: 'g', expectedVersion: store.get('g')?.version ?? 0, type, payload }, { kind });
  command('create_goal', { repositoryId: 'repo', title: 'Candidate verification', baseSha: repo.baseSha }, 'user');
  command('publish_contract', { contract: repo.contract }, 'user');
  command('request_attempt', { role: 'reviewer', attemptId: 'review', operationId: 'review_op', conversationId: 'review' });
  const review = store.get('g').attempts[0];
  command('record_dispatch', { attemptId: review.id, identity: 'review_worker', worktree: '/tmp/review', branch: 'review' });
  command('record_review', { attemptId: review.id, reviewId: 'plan_review', review: { schemaVersion: 1, target: review.target, disposition: 'accept', findings: [] } });
  command('record_stopped', { attemptId: review.id });
  command('approve', { revision: 1 }, 'user');
  if (withSibling) {
    command('request_attempt', { role: 'implementer', taskId: 'B', attemptId: 'b', operationId: 'op_b', conversationId: 'b' });
    command('record_dispatch', { attemptId: 'b', identity: 'worker_b', worktree: '/tmp/racing-sibling', branch: 'sibling' });
  }
  command('request_attempt', { role: 'implementer', taskId: 'A', attemptId: 'a', operationId: 'op_a', conversationId: 'a' });
  const resource = await repositories.provision({ repositoryId: 'repo', operationId: 'op_a', branch: 'companion/g/a', baseSha: repo.baseSha });
  command('record_dispatch', { attemptId: 'a', identity: 'worker_a', ...resource });
  const attempt = store.get('g').attempts.at(-1);
  const authority = { kind: 'agent', goalId: 'g', attemptId: attempt.id, role: attempt.role, generation: attempt.generation, revision: attempt.revision };
  const submit = (headSha) => results.receive(authority, 'candidate', JSON.stringify({ schemaVersion: 1, goalId: 'g', attemptId: attempt.id, operationId: attempt.operationId, role: attempt.role, generation: attempt.generation, revision: attempt.revision, target: attempt.target, output: { headSha, summary: 'Implemented A', evidence: [] } }));
  return { repo, artifacts, store, service, repositories, results, resource, command, submit, authority };
}

test('verified candidate result atomically records proof and requires independent same-commit review', async (t) => {
  const f = await fixture(t), headSha = await f.repo.implement(f.resource.worktree, 'A');
  f.submit(headSha); await f.results.drain();
  const goal = f.store.get('g');
  assert.equal(goal.results[0].status, 'accepted');
  const proof = JSON.parse(f.artifacts.get(goal.results[0].proofArtifactId).toString());
  assert.equal(proof.headSha, headSha); assert.deepEqual(proof.changedPaths, ['src/a.mjs']);
  assert.equal(goal.tasks[0].status, 'in_review'); assert.equal(goal.attempts.at(-1).workerState, 'running');
  assert.equal(goal.integrationHead, f.repo.baseSha);
  f.command('request_attempt', { role: 'reviewer', taskId: 'A', attemptId: 'task_review', operationId: 'task_review_op', conversationId: 'independent' });
  const reviewer = f.store.get('g').attempts.at(-1);
  assert.equal(reviewer.target, headSha); assert.equal(reviewer.baseSha, headSha);
  assert.notEqual(reviewer.conversationId, 'a');
  await f.results.drain();
  assert.equal(f.store.events().filter((entry) => entry.kind === 'candidate_verified').length, 1);
});

test('out-of-scope candidate is rejected without granting review or releasing its worker', async (t) => {
  const f = await fixture(t), headSha = await f.repo.implement(f.resource.worktree, 'B');
  f.submit(headSha); await f.results.drain();
  const goal = f.store.get('g');
  assert.equal(goal.results[0].code, 'SCOPE_VIOLATION'); assert.equal(goal.tasks[0].status, 'failed');
  assert.equal(goal.tasks[0].candidateSha, null); assert.equal(goal.attempts.at(-1).workerState, 'running');
});

for (const mutation of ['abort', 'request_revision']) test(`${mutation} during Git verification fences candidate acceptance`, async (t) => {
  const f = await fixture(t), headSha = await f.repo.implement(f.resource.worktree, 'A');
  const candidate = f.repositories.candidate.bind(f.repositories);
  f.repositories.candidate = async (input) => {
    const proof = await candidate(input);
    f.command(mutation, mutation === 'request_revision' ? { message: 'Change scope' } : {}, 'user');
    return proof;
  };
  f.submit(headSha); await f.results.drain(); await f.results.drain();
  const goal = f.store.get('g');
  assert.equal(goal.results[0].status, 'rejected'); assert.equal(goal.tasks[0].candidateSha, null);
  assert.equal(goal.status, mutation === 'abort' ? 'aborted' : 'discovering');
  if (mutation === 'request_revision') assert.equal(goal.generation, 3);
  assert.equal(f.store.events().filter((entry) => entry.kind === 'candidate_verified').length, 0);
});

test('acceptance response loss retains one committed candidate proof', async (t) => {
  const f = await fixture(t), headSha = await f.repo.implement(f.resource.worktree, 'A');
  f.submit(headSha);
  f.store.failpoint = (point) => { if (point === 'after_commit') throw new Error('lost response'); };
  await assert.rejects(f.results.drain(), /lost response/);
  f.store.failpoint = () => {};
  await new AgentResults({ service: f.service, artifacts: f.artifacts, repositories: f.repositories }).drain();
  assert.equal(f.store.get('g').results[0].status, 'accepted');
  assert.equal(f.store.events().filter((entry) => entry.kind === 'candidate_verified').length, 1);
});

test('a concurrent inbox mutation retries Git verification without failing the implementer', async (t) => {
  const f = await fixture(t, true), headSha = await f.repo.implement(f.resource.worktree, 'A');
  const candidate = f.repositories.candidate.bind(f.repositories); let intervene = true;
  f.repositories.candidate = async (input) => {
    const proof = await candidate(input);
    if (intervene) {
      intervene = false;
      // Another implementer can mutate the inbox while A's Git proof is in flight.
      f.command('receive_role_result', { resultId: 'sibling_result', attemptId: 'b', artifactId: f.store.get('g').results[0].artifactId });
    }
    return proof;
  };
  f.submit(headSha); await f.results.drain();
  assert.equal(f.store.get('g').results[0].status, 'pending');
  assert.equal(f.store.get('g').attempts.at(-1).status, 'running');
  await f.results.drain();
  assert.equal(f.store.get('g').results[0].status, 'accepted');
  assert.equal(f.store.get('g').attempts.at(-1).status, 'succeeded');
  assert.equal(f.store.events().filter((entry) => entry.kind === 'candidate_verified').length, 1);
});

test('scoped agent cannot bypass Git verification with an internal candidate command', async (t) => {
  const f = await fixture(t), headSha = await f.repo.implement(f.resource.worktree, 'A');
  f.submit(headSha);
  const goal = f.store.get('g');
  const raw = JSON.parse(f.artifacts.get(goal.results[0].artifactId).toString());
  assert.throws(() => f.service.execute({ id: 'bypass', goalId: 'g', expectedVersion: goal.version, type: 'accept_candidate_result', payload: { resultId: 'candidate', result: raw, proofArtifactId: goal.results[0].artifactId } }, f.authority), { code: 'FORBIDDEN' });
  assert.equal(f.store.get('g').tasks[0].candidateSha, null);
});

for (const outcome of ['accept', 'reject']) test(`stopped observation preserves candidate disposition after a Git version race: ${outcome}`, async (t) => {
  const f = await fixture(t, true), headSha = await f.repo.implement(f.resource.worktree, 'A');
  const candidate = f.repositories.candidate.bind(f.repositories); let intervene = true;
  f.repositories.candidate = async (input) => {
    const proof = await candidate(input);
    if (intervene) {
      intervene = false;
      // Another implementer can mutate the inbox while A's Git proof is in flight.
      f.command('receive_role_result', { resultId: 'sibling_result', attemptId: 'b', artifactId: f.store.get('g').results[0].artifactId });
    }
    return proof;
  };
  f.service.agents.observe = async () => ({ status: 'stopped', identity: 'worker_a' });
  const reconciler = new Reconciler({ service: f.service, results: f.results, ownership: { assertOwned() {} } });
  f.submit(headSha); await reconciler.observe('g', 'a');
  assert.equal(f.store.get('g').results[0].status, 'pending');
  assert.equal(f.store.get('g').attempts.at(-1).status, 'running');
  assert.equal(f.store.get('g').attempts.at(-1).workerState, 'stopped');
  if (outcome === 'reject') await f.repo.implement(f.resource.worktree, 'B');
  await f.results.drain();
  assert.equal(f.store.get('g').results[0].status, outcome === 'accept' ? 'accepted' : 'rejected');
  assert.equal(f.store.get('g').attempts.at(-1).status, outcome === 'accept' ? 'succeeded' : 'failed');
  assert.equal(f.store.get('g').attempts.at(-1).workerState, 'stopped');
});
