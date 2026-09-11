import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { GitRepository } from '../server/orchestration/adapters/git.mjs';
import { GitRemote } from '../server/orchestration/adapters/git-remote.mjs';
import { GitHubPublication } from '../server/orchestration/adapters/github.mjs';
import { ArtifactStore } from '../server/orchestration/storage/artifacts.mjs';
import { FakeGitHub } from './helpers/orchestration/fake-github.mjs';
import { createRepositoryFixture, fixtureGit } from './helpers/orchestration/fixture.mjs';

async function fixture(t) {
  const repo = await createRepositoryFixture(); t.after(() => repo.close());
  const artifacts = new ArtifactStore({ directory: join(repo.directory, 'artifacts') });
  const repositories = new GitRepository({ repositories: new Map([['repo', repo.repository]]), directory: join(repo.directory, 'resources'), artifacts });
  const remote = new GitRemote({ repositories, directory: join(repo.directory, 'remote-stage'), destinations: new Map([['repo', { url: realpathSync(repo.remote), protocol: 'file', env: { PATH: process.env.PATH } }]]) });
  const github = new FakeGitHub({ remote }), directory = join(repo.directory, 'publication');
  const options = { directory, remote, github };
  const publisher = new GitHubPublication(options);
  const candidate = await repo.checkout('candidate'), headSha = await repo.implement(candidate.worktree, 'A');
  const input = { operationId: 'publish_g', goalId: 'g', repositoryId: 'repo', branch: 'companion-goals/g', baseBranch: 'main', baseSha: repo.baseSha, headSha, marker: '<!-- companion-goal:g -->' };
  return { repo, repositories, remote, github, options, publisher, input };
}

for (const lost of [false, true]) test(`real remote publication reconciles one goal-marked PR after lost response=${lost}`, async (t) => {
  const f = await fixture(t); f.github.loseResponse = lost;
  if (lost) await assert.rejects(f.publisher.publish(f.input), /Lost successful PR response/);
  else assert.equal((await f.publisher.publish(f.input)).status, 'published');
  for (let restart = 0; restart < 2; restart++) {
    const result = await new GitHubPublication(f.options).publish(f.input);
    assert.equal(result.status, 'published'); assert.equal(result.pr.headSha, f.input.headSha);
  }
  assert.equal(f.github.creates.length, 1);
  assert.equal(await f.remote.head('repo', f.input.branch), f.input.headSha);
  assert.equal(await f.remote.head('repo', 'main'), f.repo.baseSha);
  await assert.rejects(f.publisher.publish({ ...f.input, headSha: f.repo.baseSha }), { code: 'IDEMPOTENCY_CONFLICT' });
});

for (const boundary of ['publication_requested', 'push_sent', 'push_returned', 'pr_sent', 'pr_returned']) test(`publication interruption at ${boundary} never duplicates sent requests`, async (t) => {
  const f = await fixture(t);
  const adapter = new GitHubPublication({ ...f.options, failpoint: (point) => { if (point === boundary) throw new Error('interrupted'); } });
  await assert.rejects(adapter.publish(f.input), /interrupted/);
  const result = await new GitHubPublication(f.options).publish(f.input);
  const uncertain = ['push_sent', 'pr_sent'].includes(boundary);
  assert.equal(result.status, uncertain ? 'unknown' : 'published');
  assert.equal(f.github.creates.length, uncertain ? 0 : 1);
});

for (const boundary of ['before', 'push_returned', 'during_pr']) test(`abort at ${boundary} fences future PR requests and observes sent success honestly`, async (t) => {
  const f = await fixture(t), controller = new AbortController();
  if (boundary === 'before') controller.abort();
  if (boundary === 'during_pr') f.github.beforeCreate = async () => controller.abort();
  const adapter = new GitHubPublication({ ...f.options, failpoint: (point) => { if (point === boundary) controller.abort(); } });
  const result = await adapter.publish(f.input, { signal: controller.signal });
  assert.equal(result.status, boundary === 'during_pr' ? 'published' : 'cancelled');
  assert.equal(f.github.creates.length, boundary === 'during_pr' ? 1 : 0);
  assert.equal(await f.remote.head('repo', f.input.branch), boundary === 'before' ? null : f.input.headSha);
});

test('target movement is explicit and prevents publication before a PR request', async (t) => {
  const f = await fixture(t);
  await fixtureGit(f.repo.repository, ['push', 'origin', `${f.input.headSha}:refs/heads/main`]);
  const result = await f.publisher.publish(f.input);
  assert.equal(result.status, 'target_moved'); assert.equal(result.baseHeadSha, f.input.headSha);
  assert.equal(f.github.creates.length, 0);
  assert.equal(await f.remote.head('repo', f.input.branch), null);
});

test('a target movement during an already sent PR is reported with the observed PR', async (t) => {
  const f = await fixture(t);
  f.github.beforeCreate = async () => fixtureGit(f.repo.repository, ['push', 'origin', `${f.input.headSha}:refs/heads/main`]);
  const result = await f.publisher.publish(f.input);
  assert.equal(result.status, 'published'); assert.equal(result.baseHeadSha, f.input.headSha);
  assert.equal(result.pr.headSha, f.input.headSha); assert.equal(f.github.creates.length, 1);
});

test('pre-existing remote branches and unrelated or ambiguous PR identities are refused', async (t) => {
  const f = await fixture(t);
  await f.remote.push({ repositoryId: 'repo', branch: f.input.branch, headSha: f.repo.baseSha, expectedHead: null });
  assert.equal((await f.publisher.publish(f.input)).status, 'unknown');
  assert.equal(f.github.creates.length, 0);
  await assert.rejects(f.remote.push({ repositoryId: 'repo', branch: f.input.branch, headSha: f.input.headSha, expectedHead: null }));
  assert.equal(await f.remote.head('repo', f.input.branch), f.repo.baseSha);
});

test('receipt tampering and ambiguous PR matches cannot establish delivery', async (t) => {
  const f = await fixture(t); await f.publisher.publish(f.input);
  f.github.pulls.push({ ...f.github.pulls[0], number: 2 });
  assert.equal((await f.publisher.observe(f.input)).status, 'unknown');
  f.github.pulls.pop(); f.github.pulls[0].marker = '<!-- companion-goal:unrelated -->';
  assert.equal((await f.publisher.observe(f.input)).status, 'unknown');
  f.github.pulls[0].marker = f.input.marker;
  const path = join(f.options.directory, f.input.operationId, 'push.sent.json'), original = readFileSync(path);
  writeFileSync(path, JSON.stringify({ branch: f.input.branch, expectedHead: null, headSha: f.repo.baseSha }));
  await assert.rejects(f.publisher.observe(f.input), { code: 'OWNERSHIP_UNCERTAIN' });
  writeFileSync(path, original);
  for (const state of ['open', 'closed', 'merged']) {
    f.github.pulls[0].state = state;
    const result = await f.publisher.observe(f.input);
    assert.equal(result.status, 'published'); assert.equal(result.pr.state, state);
  }
  await fixtureGit(f.repo.repository, ['push', 'origin', `:refs/heads/${f.input.branch}`]);
  for (const state of ['closed', 'merged']) {
    f.github.pulls[0].state = state;
    const result = await f.publisher.observe(f.input);
    assert.equal(result.status, 'published'); assert.equal(result.pr.state, state);
    assert.equal(result.pr.headSha, f.input.headSha);
  }
  f.github.pulls[0].state = 'open';
  assert.equal((await f.publisher.observe(f.input)).status, 'unknown');
  assert.equal(f.github.creates.length, 1);
});

test('concurrent resumes atomically claim one PR request', async (t) => {
  const f = await fixture(t);
  const interrupted = new GitHubPublication({ ...f.options, failpoint: (point) => { if (point === 'push_returned') throw new Error('pause after push'); } });
  await assert.rejects(interrupted.publish(f.input), /pause after push/);
  const outcomes = await Promise.all([new GitHubPublication(f.options).publish(f.input), new GitHubPublication(f.options).publish(f.input)]);
  assert.ok(outcomes.every((result) => ['published', 'unknown'].includes(result.status)));
  assert.equal(f.github.creates.length, 1);
  assert.equal((await f.publisher.observe(f.input)).status, 'published');
});

test('concurrent remote observations share owned staging initialization', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await Promise.all([f.remote.head('repo', 'main'), f.remote.head('repo', 'main')]), [f.repo.baseSha, f.repo.baseSha]);
});

test('publication stages histories larger than the metadata output budget on disk', async (t) => {
  const { randomBytes } = await import('node:crypto');
  const f = await fixture(t);
  writeFileSync(join(f.repo.repository, 'large.bin'), randomBytes(18 * 1024 * 1024));
  await fixtureGit(f.repo.repository, ['add', 'large.bin']); await fixtureGit(f.repo.repository, ['commit', '-m', 'Large incompressible fixture object']);
  const input = { ...f.input, headSha: await fixtureGit(f.repo.repository, ['rev-parse', 'HEAD']) };
  const result = await f.publisher.publish(input);
  assert.equal(result.status, 'published');
  assert.equal(await f.remote.head('repo', input.branch), input.headSha);
});

test('GitHub CLI contracts use explicit API identities, bounded inventory and JSON stdin', async (t) => {
  const { GitHubCli } = await import('../server/orchestration/adapters/github-cli.mjs');
  const f = await fixture(t), calls = [];
  const pr = { number: 3, html_url: 'https://github.com/Owner/Repo/pull/3', state: 'open', body: f.input.marker, head: { ref: f.input.branch, sha: f.input.headSha, repo: { full_name: 'Owner/Repo' } }, base: { ref: 'main', repo: { full_name: 'Owner/Repo' } } };
  const cli = new GitHubCli({ repositories: new Map([['repo', 'owner/repo']]), cwd: f.repo.directory, env: {}, execute: async (argv, input) => { calls.push({ argv, input }); return JSON.stringify(argv.includes('POST') ? {} : [pr]); } });
  const matches = await cli.find('repo', f.input.branch);
  assert.equal(matches[0].number, 3); assert.equal(matches[0].marker, f.input.marker);
  assert.equal(cli.identity('repo'), 'github.com:owner/repo');
  await cli.create(f.input);
  assert.deepEqual(calls[1].argv, ['api', '--hostname', 'github.com', '--method', 'POST', 'repos/owner/repo/pulls', '--input', '-']);
  const body = JSON.parse(calls[1].input);
  assert.equal(body.head, f.input.branch); assert.equal(body.base, 'main'); assert.ok(body.body.includes(f.input.marker));
  assert.ok(!calls[1].argv.includes(body.body));
  pr.head.repo.full_name = 'unrelated/repo';
  await assert.rejects(cli.find('repo', f.input.branch), { code: 'OWNERSHIP_UNCERTAIN' });
});

test('GitHub CLI refuses malformed inventory and exposes no default write permission', async (t) => {
  const { GitHubCli } = await import('../server/orchestration/adapters/github-cli.mjs');
  const f = await fixture(t);
  const empty = new GitHubCli({ repositories: new Map(), cwd: f.repo.directory, env: {}, execute: async () => { throw new Error('Must not execute'); } });
  await assert.rejects(empty.create(f.input), { code: 'UNSUPPORTED_CAPABILITY' });
  const cli = new GitHubCli({ repositories: new Map([['repo', 'owner/repo']]), cwd: f.repo.directory, env: {}, execute: async () => '{}' });
  await assert.rejects(cli.find('repo', f.input.branch), { code: 'OWNERSHIP_UNCERTAIN' });
});
