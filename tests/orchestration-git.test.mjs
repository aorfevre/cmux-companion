import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { GitRepository, gitBytes } from '../server/orchestration/adapters/git.mjs';
import { ArtifactStore } from '../server/orchestration/storage/artifacts.mjs';
import { createRepositoryFixture, fixtureGit } from './helpers/orchestration/fixture.mjs';

async function fixture(t) {
  const repo = await createRepositoryFixture(); t.after(() => repo.close());
  const artifacts = new ArtifactStore({ directory: join(repo.directory, 'artifacts') });
  const options = { repositories: new Map([['repo', repo.repository]]), directory: join(repo.directory, 'resources'), artifacts };
  const adapter = new GitRepository(options);
  const input = { operationId: 'op_a', repositoryId: 'repo', branch: 'companion/g/a', baseSha: repo.baseSha };
  const attempt = (resource) => ({ id: 'a', operationId: input.operationId, role: 'implementer', taskId: 'A', ...resource });
  return { repo, options, adapter, input, attempt, artifacts };
}

test('Git provisioning is idempotent and candidate evidence comes from the exact owned commit', async (t) => {
  const f = await fixture(t); const resource = await f.adapter.provision(f.input);
  assert.deepEqual(await new GitRepository(f.options).provision(f.input), resource);
  const headSha = await f.repo.implement(resource.worktree, 'A');
  const proof = await f.adapter.candidate({ repositoryId: 'repo', attempt: f.attempt(resource), headSha, ownedAreas: ['src/a.mjs'] });
  assert.deepEqual(proof.changedPaths, ['src/a.mjs']);
  const report = JSON.parse(f.artifacts.get(proof.artifactId).toString());
  assert.equal(report.baseSha, f.repo.baseSha); assert.equal(report.headSha, headSha);
  assert.match(f.artifacts.get(report.deltaArtifactId).toString(), /return 2/);
  await assert.rejects(f.adapter.candidate({ repositoryId: 'repo', attempt: f.attempt(resource), headSha: f.repo.baseSha, ownedAreas: ['src/a.mjs'] }), { code: 'STALE_TARGET' });
});

for (const boundary of ['reserved', 'worktree_created']) test(`provisioning recovers recorded Git resources after ${boundary}`, async (t) => {
  const f = await fixture(t);
  const crashing = new GitRepository({ ...f.options, failpoint: (point) => { if (point === boundary) throw new Error('interrupted provisioning'); } });
  await assert.rejects(crashing.provision(f.input), /interrupted provisioning/);
  const recovered = await new GitRepository(f.options).provision(f.input);
  assert.equal(await fixtureGit(recovered.worktree, ['rev-parse', 'HEAD']), f.repo.baseSha);
  const list = await fixtureGit(f.repo.repository, ['worktree', 'list', '--porcelain']);
  assert.equal(list.split('\n').filter((line) => line === `worktree ${recovered.worktree}`).length, 1);
});

test('unowned paths, branch collisions, wrong repositories and symlinked resources are refused', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.adapter.provision({ ...f.input, repositoryId: 'other' }), { code: 'FORBIDDEN' });
  await assert.rejects(f.adapter.provision({ ...f.input, operationId: '../outside' }));
  await assert.rejects(f.adapter.provision({ ...f.input, branch: 'main' }));
  await fixtureGit(f.repo.repository, ['branch', f.input.branch]);
  await assert.rejects(f.adapter.provision(f.input), { code: 'OWNERSHIP_UNCERTAIN' });
  const alternate = { ...f.input, operationId: 'other', branch: 'companion/g/other' };
  mkdirSync(join(f.options.directory, 'worktrees', 'other'));
  await assert.rejects(f.adapter.provision(alternate), { code: 'OWNERSHIP_UNCERTAIN' });
  symlinkSync(f.repo.repository, join(f.options.directory, 'worktrees', 'linked'));
  await assert.rejects(f.adapter.provision({ ...alternate, operationId: 'linked' }), { code: 'OWNERSHIP_UNCERTAIN' });
});

test('dirty and out-of-scope candidates cannot be verified', async (t) => {
  const f = await fixture(t), resource = await f.adapter.provision(f.input);
  const headSha = await f.repo.implement(resource.worktree, 'A');
  const input = { repositoryId: 'repo', attempt: f.attempt(resource), headSha, ownedAreas: ['src/b.mjs'] };
  await assert.rejects(f.adapter.candidate(input), { code: 'SCOPE_VIOLATION' });
  writeFileSync(join(resource.worktree, 'private-untracked'), 'uncommitted');
  await assert.rejects(f.adapter.candidate({ ...input, ownedAreas: ['src/a.mjs'] }), { code: 'DIRTY_WORKTREE' });
});

test('checkout filters fail before provisioning can execute repository-configured commands', async (t) => {
  const f = await fixture(t);
  await fixtureGit(f.repo.repository, ['config', 'filter.custom.smudge', 'false']);
  await assert.rejects(f.adapter.provision(f.input), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.equal(f.adapter.resource(f.input.operationId), null);
});

test('candidate patch preserves non-UTF-8 blob bytes and applies to the exact candidate tree', async (t) => {
  const f = await fixture(t), resource = await f.adapter.provision(f.input);
  writeFileSync(join(resource.worktree, 'src/a.mjs'), Buffer.from([0x61, 0xe9, 0x0a]));
  await fixtureGit(resource.worktree, ['add', 'src/a.mjs']);
  await fixtureGit(resource.worktree, ['commit', '-m', 'Non UTF-8 text']);
  const headSha = await fixtureGit(resource.worktree, ['rev-parse', 'HEAD']);
  const proof = await f.adapter.candidate({ repositoryId: 'repo', attempt: f.attempt(resource), headSha, ownedAreas: ['src/a.mjs'] });
  const report = JSON.parse(f.artifacts.get(proof.artifactId).toString());
  const patch = join(f.repo.directory, 'candidate.patch');
  writeFileSync(patch, f.artifacts.get(report.deltaArtifactId));
  const target = await f.repo.checkout('apply');
  await fixtureGit(target.worktree, ['apply', '--index', patch]);
  assert.equal(await fixtureGit(target.worktree, ['write-tree']), await fixtureGit(resource.worktree, ['rev-parse', `${headSha}^{tree}`]));
});

test('replacement refs cannot substitute candidate evidence', async (t) => {
  const f = await fixture(t), resource = await f.adapter.provision(f.input);
  const headSha = await f.repo.implement(resource.worktree, 'A');
  await fixtureGit(f.repo.repository, ['replace', headSha, f.repo.baseSha]);
  const proof = await f.adapter.candidate({ repositoryId: 'repo', attempt: f.attempt(resource), headSha, ownedAreas: ['src/a.mjs'] });
  assert.deepEqual(proof.changedPaths, ['src/a.mjs']);
  const report = JSON.parse(f.artifacts.get(proof.artifactId).toString());
  assert.match(f.artifacts.get(report.deltaArtifactId).toString(), /return 2/);
});

test('non-UTF-8 candidate filenames fail closed', { skip: process.platform === 'darwin' ? 'macOS rejects invalid UTF-8 filesystem names before Git can observe them' : false }, async (t) => {
  const f = await fixture(t), resource = await f.adapter.provision(f.input);
  writeFileSync(Buffer.concat([Buffer.from(`${resource.worktree}/src/`), Buffer.from([0xe9])]), 'text');
  await fixtureGit(resource.worktree, ['add', 'src']);
  await fixtureGit(resource.worktree, ['commit', '-m', 'Unsupported path encoding']);
  const headSha = await fixtureGit(resource.worktree, ['rev-parse', 'HEAD']);
  await assert.rejects(f.adapter.candidate({ repositoryId: 'repo', attempt: f.attempt(resource), headSha, ownedAreas: ['src'] }), { code: 'UNSUPPORTED_CAPABILITY' });
});

test('dangling resource symlinks are never treated as absent', async (t) => {
  const f = await fixture(t);
  symlinkSync(join(f.repo.directory, 'missing'), join(f.options.directory, 'worktrees', f.input.operationId));
  await assert.rejects(f.adapter.provision(f.input), { code: 'OWNERSHIP_UNCERTAIN' });
  symlinkSync(join(f.repo.directory, 'missing-manifest'), join(f.options.directory, 'manifests', 'dangling.json'));
  assert.throws(() => f.adapter.resource('dangling'), { code: 'OWNERSHIP_UNCERTAIN' });
});

test('an early Git exit rejects its operation without an unhandled stdin broken pipe', async t => {
  const f = await fixture(t);
  await assert.rejects(gitBytes(f.repo.repository, ['not-a-companion-git-command'], Buffer.alloc(2 * 1024 * 1024, 'x')), { code: 'GIT_OPERATION_FAILED' });
});
