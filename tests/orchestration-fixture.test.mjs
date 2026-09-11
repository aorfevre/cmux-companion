import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createRepositoryFixture, fixtureGit } from './helpers/orchestration/fixture.mjs';

test('disposable repository has isolated siblings, a combined dependent, and real failing/repair commits', async (t) => {
  const f = await createRepositoryFixture(); t.after(() => f.close());
  assert.equal(await fixtureGit(f.remote, ['rev-parse', 'main']), f.baseSha);
  assert.equal((await f.verify(f.repository)).passed, false);
  const a = await f.checkout('A'), b = await f.checkout('B');
  const checks = await readFile(join(f.repository, 'test/acceptance.test.mjs'), 'utf8');
  const [shaA, shaB] = await Promise.all([f.implement(a.worktree, 'A'), f.implement(b.worktree, 'B')]);
  assert.equal(await fixtureGit(a.worktree, ['rev-parse', 'HEAD^']), f.baseSha);
  assert.equal(await fixtureGit(b.worktree, ['rev-parse', 'HEAD^']), f.baseSha);
  const combined = await f.checkout('integration');
  await fixtureGit(combined.worktree, ['cherry-pick', shaA, shaB]);
  const combinedSha = await fixtureGit(combined.worktree, ['rev-parse', 'HEAD']);
  const c = await f.checkout('C', combinedSha);
  const failedSha = await f.implement(c.worktree, 'C', { failing: true });
  assert.equal((await f.verify(c.worktree)).passed, false);
  const repairedSha = await f.implement(c.worktree, 'C');
  assert.notEqual(repairedSha, failedSha); assert.equal((await f.verify(c.worktree)).passed, true);
  assert.equal(await readFile(join(c.worktree, 'test/acceptance.test.mjs'), 'utf8'), checks);
  assert.equal(await fixtureGit(f.remote, ['rev-parse', 'main']), f.baseSha);
});

test('conflict variant produces a genuine Git conflict without editing acceptance checks', async (t) => {
  const f = await createRepositoryFixture({ conflict: true }); t.after(() => f.close());
  const a = await f.checkout('A'), b = await f.checkout('B'), combined = await f.checkout('integration');
  const shaA = await f.implement(a.worktree, 'A'), shaB = await f.implement(b.worktree, 'B');
  await fixtureGit(combined.worktree, ['cherry-pick', shaA]);
  await assert.rejects(fixtureGit(combined.worktree, ['cherry-pick', shaB]));
  assert.equal(await fixtureGit(combined.worktree, ['diff', '--name-only', '--diff-filter=U']), 'src/composition.mjs');
  await assert.rejects(f.checkout('../escape'), /Invalid fixture checkout identity/);
});
