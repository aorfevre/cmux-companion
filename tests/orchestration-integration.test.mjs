import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { GitRepository } from '../server/orchestration/adapters/git.mjs';
import { GitIntegration } from '../server/orchestration/adapters/git-integration.mjs';
import { ArtifactStore } from '../server/orchestration/storage/artifacts.mjs';
import { createRepositoryFixture, fixtureGit } from './helpers/orchestration/fixture.mjs';

async function fixture(t, options) {
  const repo = await createRepositoryFixture(options); t.after(() => repo.close());
  const artifacts = new ArtifactStore({ directory: join(repo.directory, 'artifacts') });
  const repositories = new GitRepository({ repositories: new Map([['repo', repo.repository]]), directory: join(repo.directory, 'resources'), artifacts });
  const adapter = new GitIntegration({ repositories });
  const a = await repo.checkout('a'), b = await repo.checkout('b');
  const aSha = await repo.implement(a.worktree, 'A'), bSha = await repo.implement(b.worktree, 'B');
  const input = { goalId: 'g', repositoryId: 'repo', operationId: 'integrate_a', expectedHead: repo.baseSha, baseSha: repo.baseSha, candidateSha: aSha };
  return { repo, repositories, adapter, input, bSha };
}

test('serial integration applies independent sibling deltas and C builds from the combined head', async (t) => {
  const f = await fixture(t);
  const a = await f.adapter.integrate(f.input); assert.equal(a.status, 'integrated');
  assert.deepEqual(await new GitIntegration({ repositories: f.repositories }).integrate(f.input), a);
  const b = await f.adapter.integrate({ ...f.input, operationId: 'integrate_b', expectedHead: a.headSha, candidateSha: f.bSha });
  assert.equal(b.status, 'integrated');
  const c = await f.repo.checkout('c', b.headSha);
  await f.repo.implement(c.worktree, 'C');
  assert.equal((await f.repo.verify(c.worktree)).passed, true);
  assert.equal(await fixtureGit(f.repo.repository, ['rev-parse', `${b.headSha}^`]), a.headSha);
  assert.equal(await fixtureGit(f.repo.repository, ['rev-parse', 'refs/heads/main']), f.repo.baseSha);
});

for (const point of ['goal_reserved', 'proposal_recorded', 'proposed', 'advanced']) test(`integration resumes once after ${point}`, async (t) => {
  const f = await fixture(t);
  const crashing = new GitIntegration({ repositories: f.repositories, failpoint: (at) => { if (at === point) throw new Error('interrupted'); } });
  await assert.rejects(crashing.integrate(f.input), /interrupted/);
  const result = await new GitIntegration({ repositories: f.repositories }).integrate(f.input);
  assert.equal(result.status, 'integrated');
  assert.equal(await fixtureGit(f.repo.repository, ['rev-list', '--count', `${f.repo.baseSha}..${result.headSha}`]), '1');
  assert.equal(await fixtureGit(f.repo.repository, ['rev-parse', 'refs/companion/integrations/integrate_a/applied']), result.headSha);
});

test('moved goal heads and reused operations are refused', async (t) => {
  const f = await fixture(t);
  const a = await f.adapter.integrate(f.input);
  await assert.rejects(f.adapter.integrate({ ...f.input, candidateSha: f.bSha }), { code: 'IDEMPOTENCY_CONFLICT' });
  await fixtureGit(f.repo.repository, ['update-ref', 'refs/heads/companion-goals/g', f.bSha, a.headSha]);
  await assert.rejects(f.adapter.integrate(f.input), { code: 'OWNERSHIP_UNCERTAIN' });
});

test('overlapping siblings preserve conflict evidence without advancing the goal head', async (t) => {
  const f = await fixture(t, { conflict: true });
  const a = await f.adapter.integrate(f.input);
  const result = await f.adapter.integrate({ ...f.input, operationId: 'integrate_b', expectedHead: a.headSha, candidateSha: f.bSha });
  assert.equal(result.status, 'conflict');
  assert.match(readFileSync(join(result.worktree, 'src/composition.mjs'), 'utf8'), /<<<<<<<|>>>>>>>/);
  assert.deepEqual(await f.adapter.integrate({ ...f.input, operationId: 'integrate_b', expectedHead: a.headSha, candidateSha: f.bSha }), result);
  assert.equal(await fixtureGit(f.repo.repository, ['rev-parse', 'refs/heads/companion-goals/g']), a.headSha);
  assert.match(await fixtureGit(f.repo.repository, ['rev-parse', 'refs/companion/integrations/integrate_b/conflict']), /^[a-f0-9]{40}$/);
});

for (const boundary of ['conflict_reported', 'conflict_recorded', 'conflict_materialized']) test(`conflict evidence recovers after ${boundary}`, async (t) => {
  const f = await fixture(t, { conflict: true });
  const a = await f.adapter.integrate(f.input);
  const input = { ...f.input, operationId: 'integrate_b', expectedHead: a.headSha, candidateSha: f.bSha };
  const crashing = new GitIntegration({ repositories: f.repositories, failpoint: (point) => { if (point === boundary) throw new Error('interrupted conflict'); } });
  await assert.rejects(crashing.integrate(input), /interrupted conflict/);
  const result = await new GitIntegration({ repositories: f.repositories }).integrate(input);
  assert.equal(result.status, 'conflict');
  const report = JSON.parse(readFileSync(join(f.repositories.directory, 'integrations/integrate_b.conflict.json'), 'utf8'));
  assert.ok(f.repositories.artifacts.get(report.artifactId).length);
  assert.match(readFileSync(join(result.worktree, 'src/composition.mjs'), 'utf8'), /<<<<<<<|>>>>>>>/);
});

test('conflict materialization preserves ignored private files', async (t) => {
  const f = await fixture(t, { conflict: true });
  const a = await f.adapter.integrate(f.input);
  const input = { ...f.input, operationId: 'integrate_b', expectedHead: a.headSha, candidateSha: f.bSha };
  const crashing = new GitIntegration({ repositories: f.repositories, failpoint: (point) => {
    if (point === 'conflict_recorded') {
      const resource = f.repositories.resource('integrate_b');
      writeFileSync(join(resource.worktree, 'private.txt'), 'private data');
      writeFileSync(join(f.repo.repository, '.git/info/exclude'), 'private.txt\n');
    }
  } });
  await assert.rejects(crashing.integrate(input), { code: 'OWNERSHIP_UNCERTAIN' });
  const resource = f.repositories.resource('integrate_b');
  assert.equal(readFileSync(join(resource.worktree, 'private.txt'), 'utf8'), 'private data');
  assert.doesNotMatch(readFileSync(join(resource.worktree, 'src/composition.mjs'), 'utf8'), /<<<<<<<|>>>>>>>/);
});

test('substituted proposal refs cannot advance the goal', async (t) => {
  const f = await fixture(t);
  const crashing = new GitIntegration({ repositories: f.repositories, failpoint: (point) => { if (point === 'proposed') throw new Error('pause'); } });
  await assert.rejects(crashing.integrate(f.input), /pause/);
  await fixtureGit(f.repo.repository, ['update-ref', 'refs/companion/integrations/integrate_a/proposed', f.bSha]);
  await assert.rejects(f.adapter.integrate(f.input), { code: 'OWNERSHIP_UNCERTAIN' });
  assert.equal(await fixtureGit(f.repo.repository, ['rev-parse', 'refs/heads/companion-goals/g']), f.repo.baseSha);
});

for (const boundary of ['goal_reserved', 'proposal_recorded', 'proposed', 'advanced', 'conflict_reported', 'conflict_recorded', 'conflict_materialized']) test(`real SIGKILL recovers integration evidence after ${boundary}`, async (t) => {
  const conflict = boundary.startsWith('conflict');
  const f = await fixture(t, { conflict });
  const a = conflict ? await f.adapter.integrate(f.input) : null;
  const input = conflict ? { ...f.input, operationId: 'integrate_b', expectedHead: a.headSha, candidateSha: f.bSha } : f.input;
  const path = join(f.repo.directory, 'crash.json');
  writeFileSync(path, JSON.stringify({ repository: f.repo.repository, directory: f.repositories.directory, artifacts: f.repositories.artifacts.directory, boundary, input }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/orchestration/integration-crash-child.mjs', import.meta.url)), path], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  assert.equal(exit.signal, 'SIGKILL', stderr);
  for (let restart = 0; restart < 2; restart++) {
    const result = await new GitIntegration({ repositories: f.repositories }).integrate(input);
    assert.equal(result.status, conflict ? 'conflict' : 'integrated');
    if (!conflict) assert.equal(await fixtureGit(f.repo.repository, ['rev-list', '--count', `${f.repo.baseSha}..${result.headSha}`]), '1');
    else assert.match(readFileSync(join(result.worktree, 'src/composition.mjs'), 'utf8'), /<<<<<<<|>>>>>>>/);
  }
});

test('read-only integration observation proves applied receipts and rejects moved evidence', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.adapter.observeIntegration(f.input.operationId), { status: 'pending', headSha: null });
  const result = await f.adapter.integrate(f.input);
  assert.deepEqual(await f.adapter.observeIntegration(f.input.operationId), result);
  await fixtureGit(f.repo.repository, ['update-ref', 'refs/companion/integrations/integrate_a/proposed', f.bSha]);
  assert.deepEqual(await f.adapter.observeIntegration(f.input.operationId), { status: 'unknown', headSha: null });
});

test('repair copies are isolated, replayable and preserve edits; substituted conflict refs are refused', async (t) => {
  const f = await fixture(t, { conflict: true });
  const a = await f.adapter.integrate(f.input);
  const input = { ...f.input, operationId: 'integrate_b', expectedHead: a.headSha, candidateSha: f.bSha };
  const conflict = await f.adapter.integrate(input);
  const repair = { goalId: 'g', repositoryId: 'repo', integrationOperationId: 'integrate_b', attempt: { id: 'repair_a', operationId: 'repair_op', role: 'integrator', baseSha: a.headSha, target: a.headSha } };
  const resource = await f.adapter.provisionRepair(repair);
  assert.notEqual(resource.worktree, conflict.worktree);
  assert.match(readFileSync(join(resource.worktree, 'src/composition.mjs'), 'utf8'), /<<<<<<<|>>>>>>>/);
  assert.deepEqual(await f.adapter.provisionRepair(repair), resource);
  writeFileSync(join(resource.worktree, 'src/composition.mjs'), 'preserve this repair');
  await assert.rejects(f.adapter.provisionRepair(repair), { code: 'OWNERSHIP_UNCERTAIN' });
  assert.equal(readFileSync(join(resource.worktree, 'src/composition.mjs'), 'utf8'), 'preserve this repair');
  const baseTree = await fixtureGit(f.repo.repository, ['rev-parse', `${f.repo.baseSha}^{tree}`]);
  await fixtureGit(f.repo.repository, ['update-ref', 'refs/companion/integrations/integrate_b/conflict', baseTree]);
  await assert.rejects(f.adapter.integrate(input), { code: 'OWNERSHIP_UNCERTAIN' });
  await assert.rejects(f.adapter.provisionRepair({ ...repair, attempt: { ...repair.attempt, id: 'repair_b', operationId: 'repair_b_op' } }), { code: 'OWNERSHIP_UNCERTAIN' });
  assert.equal(f.repositories.resource('repair_b_op'), null);
});

async function repairedFixture(t, final = false) {
  const f = await fixture(t, { conflict: !final });
  const a = await f.adapter.integrate(f.input);
  if (!final) await f.adapter.integrate({ ...f.input, operationId: 'integrate_b', expectedHead: a.headSha, candidateSha: f.bSha });
  const attempt = { id: 'repair_a', operationId: 'repair_op', role: 'integrator', taskId: final ? null : 'B', baseSha: a.headSha, target: a.headSha };
  Object.assign(attempt, final ? await f.repositories.provision({ operationId: attempt.operationId, repositoryId: 'repo', baseSha: attempt.baseSha, branch: 'companion/g/final_repair' }) : await f.adapter.provisionRepair({ goalId: 'g', repositoryId: 'repo', integrationOperationId: 'integrate_b', attempt }));
  writeFileSync(join(attempt.worktree, 'src/composition.mjs'), "export function composition() { return 'Resolved'; }\n");
  await fixtureGit(attempt.worktree, ['add', 'src']);
  await fixtureGit(attempt.worktree, ['commit', '-m', 'Repair conflict']);
  const headSha = await fixtureGit(attempt.worktree, ['rev-parse', 'HEAD']);
  const proof = await f.repositories.candidate({ repositoryId: 'repo', attempt, headSha, ownedAreas: ['src/b.mjs', 'src/composition.mjs'] });
  return { ...f, repair: { goalId: 'g', repositoryId: 'repo', integrationOperationId: final ? 'repair_effect' : 'integrate_b', effectId: 'repair_effect', attempt, headSha, proofArtifactId: proof.artifactId } };
}

for (const final of [false, true]) test(`repair acceptance binds the candidate proof and replays one integrated tree, final=${final}`, async (t) => {
  const f = await repairedFixture(t, final);
  const accepted = await f.adapter.acceptRepair(f.repair);
  assert.equal(accepted.status, 'integrated');
  assert.deepEqual(await new GitIntegration({ repositories: f.repositories }).acceptRepair(f.repair), accepted);
  assert.deepEqual(await f.adapter.observeRepair(f.repair), accepted);
  assert.equal(await fixtureGit(f.repo.repository, ['rev-parse', `${accepted.headSha}^{tree}`]), await fixtureGit(f.repo.repository, ['rev-parse', `${f.repair.headSha}^{tree}`]));
  assert.equal(await fixtureGit(f.repo.repository, ['rev-parse', `${accepted.headSha}^`]), f.repair.attempt.baseSha);
  await assert.rejects(f.adapter.acceptRepair({ ...f.repair, effectId: 'other_effect' }), { code: final ? 'STALE_TARGET' : 'OWNERSHIP_UNCERTAIN' });
  assert.equal((await f.adapter.observeRepair({ ...f.repair, effectId: 'other_effect' })).status, 'unknown');
  for (const changed of [{ goalId: 'wrong' }, { repositoryId: 'wrong' }, { attempt: { ...f.repair.attempt, baseSha: f.repo.baseSha } }, { attempt: { ...f.repair.attempt, role: 'implementer' } }]) assert.equal((await f.adapter.observeRepair({ ...f.repair, ...changed })).status, 'unknown');
  for (const taskId of [null, 'A', 'B'].filter((taskId) => taskId !== f.repair.attempt.taskId)) {
    const changed = { ...f.repair, attempt: { ...f.repair.attempt, taskId } };
    assert.equal((await f.adapter.observeRepair(changed)).status, 'unknown');
    await assert.rejects(f.adapter.acceptRepair(changed));
  }
  unlinkSync(f.repositories.artifacts.path(f.repair.proofArtifactId));
  assert.equal((await f.adapter.observeRepair(f.repair)).status, 'unknown');
});

for (const final of [false, true]) for (const boundary of [...(final ? ['final_repair_requested'] : []), 'repair_proposal_recorded', 'repair_proposed', 'repair_advanced']) test(`real SIGKILL preserves repair identity after ${boundary}, final=${final}`, async (t) => {
  const f = await repairedFixture(t, final);
  const path = join(f.repo.directory, 'repair-crash.json');
  writeFileSync(path, JSON.stringify({ action: 'repair', repository: f.repo.repository, directory: f.repositories.directory, artifacts: f.repositories.artifacts.directory, boundary, input: f.repair }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/orchestration/integration-crash-child.mjs', import.meta.url)), path], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  assert.equal(exit.signal, 'SIGKILL', stderr);
  for (let restart = 0; restart < 2; restart++) {
    const result = await new GitIntegration({ repositories: f.repositories }).acceptRepair(f.repair);
    assert.equal(await fixtureGit(f.repo.repository, ['rev-list', '--count', `${f.repair.attempt.baseSha}..${result.headSha}`]), '1');
    assert.deepEqual(await f.adapter.observeRepair(f.repair), result);
  }
});

test('final repair refuses a moved goal head without overwriting it', async (t) => {
  const f = await repairedFixture(t, true);
  await fixtureGit(f.repo.repository, ['update-ref', 'refs/heads/companion-goals/g', f.bSha, f.repair.attempt.baseSha]);
  await assert.rejects(f.adapter.acceptRepair(f.repair));
  assert.equal(await fixtureGit(f.repo.repository, ['rev-parse', 'refs/heads/companion-goals/g']), f.bSha);
  assert.equal(await f.repositories.ref(f.repo.repository, 'refs/companion/integrations/repair_effect/applied'), null);
});
