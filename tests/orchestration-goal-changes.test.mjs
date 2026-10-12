import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { GitRepository } from '../server/orchestration/adapters/git.mjs';
import { ArtifactStore } from '../server/orchestration/storage/artifacts.mjs';
import { createRepositoryFixture, fixtureGit } from './helpers/orchestration/fixture.mjs';
import { apiFixture, HEADERS } from './helpers/orchestration/api-fixture.mjs';
import { BASE } from './helpers/orchestration/domain-fixture.mjs';

test('changes show the immutable integrated commit, including binary and unusual names, without reading dirty files', async t => {
  const repo = await createRepositoryFixture(); t.after(() => repo.close());
  const adapter = new GitRepository({ repositories: new Map([['repo', repo.repository]]), directory: join(repo.directory, 'resources'), artifacts: new ArtifactStore({ directory: join(repo.directory, 'artifacts') }) });
  const odd = 'odd\nname.txt';
  await writeFile(join(repo.repository, odd), 'committed text\n');
  await writeFile(join(repo.repository, 'binary.dat'), Buffer.from([0, 1, 2]));
  await fixtureGit(repo.repository, ['add', '.']); await fixtureGit(repo.repository, ['commit', '-m', 'Add fixture changes']);
  const head = await fixtureGit(repo.repository, ['rev-parse', 'HEAD']);
  await writeFile(join(repo.repository, odd), 'dirty text must not appear');
  const result = await adapter.changes({ repositoryId: 'repo', baseSha: repo.baseSha, integrationHead: head });
  assert.equal(result.headSha, head); assert.equal(result.baseSha, repo.baseSha);
  assert.deepEqual(result.files, [{ status: 'A', path: 'binary.dat' }, { status: 'A', path: odd }]);
  assert.match(result.patch, /committed text/); assert.match(result.patch, /Binary files/);
  assert.ok(!result.patch.includes('dirty text')); assert.equal(result.patchTruncated, false);
  await assert.rejects(adapter.changes({ repositoryId: 'other', baseSha: repo.baseSha, integrationHead: head }), { code: 'FORBIDDEN' });
  await assert.rejects(adapter.changes({ repositoryId: 'repo', baseSha: repo.baseSha, integrationHead: '--all' }));
  await writeFile(join(repo.repository, 'large.txt'), 'x'.repeat(270000));
  await fixtureGit(repo.repository, ['add', 'large.txt']); await fixtureGit(repo.repository, ['commit', '-m', 'Large change']);
  const large = await adapter.changes({ repositoryId: 'repo', baseSha: head, integrationHead: await fixtureGit(repo.repository, ['rev-parse', 'HEAD']) });
  assert.equal(Buffer.byteLength(large.patch), 262144); assert.equal(large.patchTruncated, true);
});

const evidence = { baseSha: BASE, headSha: BASE, fileCount: 0, files: [], filesTruncated: false, patch: '', patchTruncated: false, patchUnavailable: false };
const url = `/api/orchestration/goals/goal/changes?head=${BASE}`;
test('change API requires pairing and exact saved head, supports read-only, and does not accept arbitrary Git targets', async t => {
  let calls = 0;
  const f = await apiFixture(t, { readOnly: true, changes: async goal => { calls++; assert.equal(goal.integrationHead, BASE); return evidence; } }); f.planner();
  assert.equal((await f.app.inject({ url })).statusCode, 401);
  assert.equal((await f.app.inject({ url, headers: HEADERS })).statusCode, 200);
  assert.equal((await f.app.inject({ url: url.replace(BASE, 'b'.repeat(40)), headers: HEADERS })).statusCode, 409);
  assert.equal((await f.app.inject({ url: url.replace(BASE, '--all'), headers: HEADERS })).statusCode, 400);
  assert.equal(calls, 1);
  f.service.repositoryIds.clear();
  assert.equal((await f.app.inject({ url, headers: HEADERS })).statusCode, 404);
});

test('change API rejects a moved result or repository withdrawal during Git reads', async t => {
  let f;
  f = await apiFixture(t, { changes: async () => { f.service.repositoryIds.clear(); return evidence; } }); f.planner();
  assert.equal((await f.app.inject({ url, headers: HEADERS })).statusCode, 409);
  f.service.repositoryIds.add('repo');
  const moved = await apiFixture(t, { changes: async () => ({ ...evidence, headSha: 'b'.repeat(40) }) }); moved.planner();
  assert.equal((await moved.app.inject({ url, headers: HEADERS })).statusCode, 409);
});
