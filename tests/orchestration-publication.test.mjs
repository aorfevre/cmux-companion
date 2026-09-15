import assert from 'node:assert/strict';
import test from 'node:test';
import { join, dirname } from 'node:path';
import { realpathSync, readFileSync, writeFileSync, copyFileSync, renameSync, rmSync } from 'node:fs';
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
  assert.equal(result.status, 'cancelled');
  if (boundary === 'during_pr') { assert.equal(f.github.pulls[0].draft, true); assert.equal(f.github.promotions.length, 0); }
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

for (const divergence of ['behind', 'ahead']) test(`explicit acceptance publishes an unchanged reviewed head when local main is ${divergence} the remote`, async t => {
  const f = await fixture(t);
  if (divergence === 'behind') await fixtureGit(f.repo.repository, ['push', 'origin', `${f.input.headSha}:refs/heads/main`]);
  else f.input.baseSha = f.input.headSha;
  const observed = await f.publisher.publish(f.input);
  assert.equal(observed.status, 'target_moved');
  const requestPath = join(f.options.directory, f.input.operationId, 'request.json'), original = readFileSync(requestPath);
  const accepted = { ...f.input, acceptedTargets: [{ id: 'accept_target', previousBaseSha: f.input.baseSha, baseHeadSha: observed.baseHeadSha }] };
  const result = await new GitHubPublication(f.options).publish(accepted);
  assert.equal(result.status, 'published'); assert.equal(result.pr.headSha, f.input.headSha);
  assert.deepEqual(readFileSync(requestPath), original);
  assert.deepEqual(JSON.parse(readFileSync(join(f.options.directory, f.input.operationId, 'targets.accepted.json'), 'utf8')), accepted.acceptedTargets);
  assert.equal((await new GitHubPublication(f.options).publish(accepted)).status, 'published');
  assert.equal(f.github.creates.length, 1);
  await assert.rejects(f.publisher.publish({ ...accepted, baseSha: observed.baseHeadSha }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.publisher.publish(f.input), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.publisher.publish({ ...accepted, acceptedTargets: [...accepted.acceptedTargets, { id: 'after_send', previousBaseSha: observed.baseHeadSha, baseHeadSha: f.input.baseSha }] }), { code: 'STALE_TARGET' });
});

test('accepting an observed target cannot silently accept a newer remote commit or send after abort', async t => {
  const f = await fixture(t);
  await fixtureGit(f.repo.repository, ['push', 'origin', `${f.input.headSha}:refs/heads/main`]);
  assert.equal((await f.publisher.publish(f.input)).status, 'target_moved');
  const accepted = { ...f.input, acceptedTargets: [{ id: 'accept_target', previousBaseSha: f.input.baseSha, baseHeadSha: f.input.headSha }] };
  await fixtureGit(f.repo.repository, ['push', '--force', 'origin', `${f.input.baseSha}:refs/heads/main`]);
  const stale = await f.publisher.publish(accepted);
  assert.equal(stale.status, 'target_moved'); assert.equal(stale.baseHeadSha, f.input.baseSha);
  assert.equal(f.github.creates.length, 0); assert.equal(await f.remote.head('repo', f.input.branch), null);
  await fixtureGit(f.repo.repository, ['push', 'origin', `${f.input.headSha}:refs/heads/main`]);
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.publisher.publish(accepted, { signal: controller.signal })).status, 'cancelled');
  assert.equal(f.github.creates.length, 0); assert.equal(await f.remote.head('repo', f.input.branch), null);
});

test('target acceptance after an owned push preserves the push and records every deliberate target change', async t => {
  const f = await fixture(t), push = f.remote.push.bind(f.remote); let pushes = 0;
  f.remote.push = async (...args) => {
    pushes++; await push(...args);
    await fixtureGit(f.repo.repository, ['push', 'origin', `${f.input.headSha}:refs/heads/main`]);
  };
  assert.equal((await f.publisher.publish(f.input)).status, 'target_moved');
  assert.equal(await f.remote.head('repo', f.input.branch), f.input.headSha);
  const first = { id: 'accept_first', previousBaseSha: f.input.baseSha, baseHeadSha: f.input.headSha };
  await fixtureGit(f.repo.repository, ['push', '--force', 'origin', `${f.input.baseSha}:refs/heads/main`]);
  assert.equal((await f.publisher.publish({ ...f.input, acceptedTargets: [first] })).status, 'target_moved');
  const accepted = { ...f.input, acceptedTargets: [first, { id: 'accept_second', previousBaseSha: first.baseHeadSha, baseHeadSha: f.input.baseSha }] };
  assert.equal((await f.publisher.publish(accepted)).status, 'published');
  assert.equal(pushes, 1); assert.equal(f.github.creates.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(f.options.directory, f.input.operationId, 'targets.accepted.json'), 'utf8')), accepted.acceptedTargets);
});

test('a target movement during draft creation prevents ready promotion', async (t) => {
  const f = await fixture(t);
  f.github.beforeCreate = async () => fixtureGit(f.repo.repository, ['push', 'origin', `${f.input.headSha}:refs/heads/main`]);
  const result = await f.publisher.publish(f.input);
  assert.equal(result.status, 'target_moved'); assert.equal(result.baseHeadSha, f.input.headSha);
  assert.equal(result.pr, null); assert.equal(f.github.creates.length, 1);
  assert.equal(f.github.pulls[0].draft, true); assert.equal(f.github.promotions.length, 0);
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
  const pr = { number: 3, html_url: 'https://github.com/Owner/Repo/pull/3', state: 'open', draft: true, body: f.input.marker, head: { ref: f.input.branch, sha: f.input.headSha, repo: { full_name: 'Owner/Repo' } }, base: { ref: 'main', sha: f.input.baseSha, repo: { full_name: 'Owner/Repo' } } };
  const cli = new GitHubCli({ repositories: new Map([['repo', 'owner/repo']]), cwd: f.repo.directory, env: {}, execute: async (argv, input) => { calls.push({ argv, input }); return JSON.stringify(argv.includes('POST') ? {} : [pr]); } });
  const matches = await cli.find('repo', f.input.branch);
  assert.equal(matches[0].number, 3); assert.equal(matches[0].marker, f.input.marker);
  assert.equal(cli.identity('repo'), 'github.com:owner/repo');
  await cli.create(f.input);
  assert.deepEqual(calls[1].argv, ['api', '--hostname', 'github.com', '--method', 'POST', 'repos/owner/repo/pulls', '--input', '-']);
  const body = JSON.parse(calls[1].input);
  assert.equal(body.draft, true); assert.equal(body.head, f.input.branch); assert.equal(body.base, 'main'); assert.ok(body.body.includes(f.input.marker));
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

for (const scenario of ['pack_failure', 'abort']) test(`local push preparation ${scenario} does not claim a remote send`, async (t) => {
  const f = await fixture(t), controller = new AbortController();
  const repository = f.repositories.repository.bind(f.repositories);
  f.repositories.repository = async (...args) => {
    const result = await repository(...args);
    if (scenario === 'abort') controller.abort();
    // A real pack-objects failure before the network boundary.
    return scenario === 'pack_failure' ? { ...result, repository: f.repo.directory } : result;
  };
  if (scenario === 'pack_failure') await assert.rejects(f.publisher.publish(f.input), { code: 'GIT_OPERATION_FAILED' });
  else assert.equal((await f.publisher.publish(f.input, { signal: controller.signal })).status, 'cancelled');
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(f.options.directory, f.input.operationId, 'push.sent.json')), false);
  assert.equal(await f.remote.head('repo', f.input.branch), null);
  assert.equal(f.github.creates.length, 0);
  f.repositories.repository = repository;
  assert.equal((await f.publisher.publish(f.input)).status, 'published');
  assert.equal(f.github.creates.length, 1);
});

for (const kind of ['push', 'pr']) test(`proven ${kind} spawn failure is retryable without duplicating an external request`, async (t) => {
  const f = await fixture(t);
  const { existsSync } = await import('node:fs');
  let restore;
  if (kind === 'pr') {
    const { GitHubCli } = await import('../server/orchestration/adapters/github-cli.mjs');
    const cli = new GitHubCli({ repositories: new Map([['repo', 'owner/repo']]), cwd: f.repo.directory, env: { PATH: join(f.repo.directory, 'missing-bin') } });
    const create = f.github.create.bind(f.github);
    f.github.create = cli.create.bind(cli); restore = () => { f.github.create = create; };
  } else {
    const policy = f.remote.destinations.get('repo'), original = policy.env.PATH;
    f.publisher.failpoint = (point) => { if (point === 'push_sent') policy.env.PATH = join(f.repo.directory, 'missing-bin'); };
    restore = () => { policy.env.PATH = original; f.publisher.failpoint = () => {}; };
  }
  await assert.rejects(f.publisher.publish(f.input), { code: 'EXTERNAL_NOT_SENT' });
  assert.equal(existsSync(join(f.options.directory, f.input.operationId, `${kind}.sent.json`)), false);
  restore();
  assert.equal((await f.publisher.publish(f.input)).status, 'published');
  assert.equal(f.github.creates.length, 1);
});

test('goal base fetch imports latest main without changing a dirty feature checkout or refs', async t => {
  const f = await fixture(t);
  let copies = 0;
  f.remote.baseFiles = { copyFileSync: (...args) => { copies++; return copyFileSync(...args); }, rmSync,
    renameSync: (from, to) => {
      if (dirname(from) !== dirname(to)) throw Object.assign(new Error('Cross-device rename'), { code: 'EXDEV' });
      return renameSync(from, to);
    },
  };
  const other = join(f.repo.directory, 'other-clone');
  await fixtureGit(f.repo.directory, ['clone', f.repo.remote, other]);
  const remoteHead = await f.repo.implement(other, 'B');
  await fixtureGit(other, ['push', 'origin', 'main']);
  await assert.rejects(fixtureGit(f.repo.repository, ['cat-file', '-e', remoteHead]));
  await fixtureGit(f.repo.repository, ['switch', '-c', 'feature-user']);
  writeFileSync(join(f.repo.repository, 'user-untracked.txt'), 'preserve me');
  const status = await fixtureGit(f.repo.repository, ['status', '--porcelain']);
  const refs = await fixtureGit(f.repo.repository, ['show-ref']);
  const fetched = await f.remote.fetchBase('repo', 'main');
  assert.equal(fetched, remoteHead); assert.equal(copies, 2);
  assert.equal(await fixtureGit(f.repo.repository, ['symbolic-ref', '--short', 'HEAD']), 'feature-user');
  assert.equal(await fixtureGit(f.repo.repository, ['status', '--porcelain']), status);
  assert.equal(await fixtureGit(f.repo.repository, ['show-ref']), refs);
  const worktree = await f.repositories.provision({ operationId: 'goal-base-proof', repositoryId: 'repo', branch: 'companion/newgoal/planner', baseSha: fetched });
  assert.equal(await fixtureGit(worktree.worktree, ['rev-parse', 'HEAD']), fetched);
  await assert.rejects(f.remote.fetchBase('repo', 'missing-branch'), { code: 'BASE_FETCH_FAILED' });
  await assert.rejects(f.remote.fetchBase('repo', '--upload-pack=evil'), /branch/i);
});

for (const lost of [false, true]) test(`draft PR promotion reconciles once after lost response=${lost}`, async t => {
  const f = await fixture(t); f.github.loseReadyResponse = lost;
  f.publisher.failpoint = point => { if (point === 'pr_returned') throw new Error('crash after draft'); };
  await assert.rejects(f.publisher.publish(f.input), /crash after draft/);
  assert.equal(f.github.pulls[0].draft, true);
  assert.equal((await f.publisher.observe(f.input)).status, 'pending');
  assert.equal(f.github.promotions.length, 0);
  const restarted = new GitHubPublication(f.options);
  if (lost) await assert.rejects(restarted.publish(f.input), /Lost successful promotion/);
  assert.equal((await restarted.publish(f.input)).status, 'published');
  assert.equal(f.github.pulls[0].draft, false);
  assert.equal(f.github.creates.length, 1); assert.equal(f.github.promotions.length, 1);
});

test('revoked publication leaves its created PR in draft', async t => {
  const f = await fixture(t), controller = new AbortController();
  f.publisher.failpoint = point => { if (point === 'pr_returned') controller.abort(); };
  assert.equal((await f.publisher.publish(f.input, { signal: controller.signal })).status, 'cancelled');
  assert.equal(f.github.pulls[0].draft, true); assert.equal(f.github.promotions.length, 0);
});

for (const accepted of [false, true]) test(`GitHub promotion checks exact draft identity and accepted target=${accepted}`, async t => {
  const { GitHubCli } = await import('../server/orchestration/adapters/github-cli.mjs');
  const f = await fixture(t), calls = [];
  const pr = { node_id: 'PR_node', number: 3, html_url: 'https://github.com/owner/repo/pull/3', state: 'open', draft: true, body: f.input.marker, head: { ref: f.input.branch, sha: f.input.headSha, repo: { full_name: 'owner/repo' } }, base: { ref: 'main', sha: f.input.baseSha, repo: { full_name: 'owner/repo' } } };
  const cli = new GitHubCli({ repositories: new Map([['repo', 'owner/repo']]), cwd: f.repo.directory, env: {}, execute: async (argv, input) => {
    calls.push({ argv, input });
    return JSON.stringify(argv.includes('graphql') ? { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } } : argv.at(-1).includes('?') ? [pr] : pr);
  } });
  const input = accepted ? { ...f.input, acceptedTargets: [{ id: 'accept', previousBaseSha: f.input.baseSha, baseHeadSha: f.input.headSha }] } : f.input;
  if (accepted) pr.base.sha = f.input.headSha;
  assert.equal(await cli.ready(input, { beforeSend: () => false }), 'cancelled'); assert.equal(calls.length, 2);
  await cli.ready(input); assert.deepEqual(JSON.parse(calls.find(call => call.argv.includes('graphql')).input).variables, { id: 'PR_node' });
  pr.head.sha = f.repo.baseSha;
  await assert.rejects(cli.ready(f.input), { code: 'STALE_TARGET' });
});

for (const mode of ['restored', 'lost-conversion-response', 'conversion-failed', 'confirmation-failed', 'identity-changed']) test(`promotion target race: ${mode}`, async t => {
  const { GitHubCli } = await import('../server/orchestration/adapters/github-cli.mjs');
  const f = await fixture(t);
  const pr = { node_id: 'PR_node', number: 3, html_url: 'https://github.com/owner/repo/pull/3', state: 'open', draft: true, body: f.input.marker, head: { ref: f.input.branch, sha: f.input.headSha, repo: { full_name: 'owner/repo' } }, base: { ref: 'main', sha: f.input.baseSha, repo: { full_name: 'owner/repo' } } };
  let conversions = 0;
  const cli = new GitHubCli({ repositories: new Map([['repo', 'owner/repo']]), cwd: f.repo.directory, env: {}, execute: async (argv, payload) => {
    if (argv.includes('graphql')) {
      const { query } = JSON.parse(payload);
      if (query.includes('markPullRequestReadyForReview')) {
        pr.draft = false; pr.base.sha = f.input.headSha;
        await fixtureGit(f.repo.remote, ['update-ref', 'refs/heads/main', f.input.headSha]);
        if (mode === 'identity-changed') pr.body = '<!-- companion-goal:another -->';
        return JSON.stringify({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
      }
      conversions++;
      if (mode === 'conversion-failed') throw new Error('conversion refused');
      pr.draft = true;
      if (mode === 'lost-conversion-response') throw new Error('lost response');
      return JSON.stringify({ data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } });
    }
    if (conversions && mode === 'confirmation-failed') throw new Error('read unavailable');
    return JSON.stringify(argv.at(-1).includes('?') ? [pr] : pr);
  } });
  f.publisher.failpoint = point => { if (point === 'pr_returned') throw new Error('pause'); };
  await assert.rejects(f.publisher.publish(f.input), /pause/);
  // Keep real Git/publication receipts, but exercise the production GitHub adapter.
  const publisher = new GitHubPublication({ ...f.options, github: { identity: id => f.github.identity(id), find: (...args) => cli.find(...args), ready: (...args) => cli.ready(...args) } });
  const result = await publisher.publish(f.input);
  assert.equal(result.status, ['restored', 'lost-conversion-response'].includes(mode) ? 'target_moved' : 'unknown');
  assert.equal(result.pr, null);
  assert.equal(conversions, mode === 'identity-changed' ? 0 : 1);
  assert.equal(f.github.creates.length, 1);
});

test('observation refuses missing draft metadata and moved targets on open ready PRs', async t => {
  const f = await fixture(t);
  assert.equal((await f.publisher.publish(f.input)).status, 'published');
  delete f.github.pulls[0].draft;
  assert.equal((await f.publisher.observe(f.input)).status, 'unknown');
  f.github.pulls[0].draft = false;
  await fixtureGit(f.repo.remote, ['update-ref', 'refs/heads/main', f.input.headSha]);
  assert.equal((await f.publisher.observe(f.input)).status, 'unknown');
  // Historical merged evidence survives normal target advancement.
  f.github.pulls[0].state = 'merged';
  assert.equal((await f.publisher.observe(f.input)).status, 'published');
});

test('observation rejects target advancement during GitHub inventory', async t => {
  const f = await fixture(t);
  assert.equal((await f.publisher.publish(f.input)).status, 'published');
  const find = f.github.find.bind(f.github);
  f.github.find = async (...args) => {
    await fixtureGit(f.repo.remote, ['update-ref', 'refs/heads/main', f.input.headSha]);
    return find(...args);
  };
  const result = await f.publisher.observe(f.input);
  assert.equal(result.status, 'unknown'); assert.equal(result.pr, null);
  assert.equal(result.baseHeadSha, f.input.headSha);
});

test('closed drafts never prove delivery, while closed ready PRs retain historical evidence', async t => {
  const f = await fixture(t);
  f.publisher.failpoint = point => { if (point === 'pr_returned') throw new Error('pause before promotion'); };
  await assert.rejects(f.publisher.publish(f.input), /pause before promotion/);
  f.github.pulls[0].state = 'closed';
  assert.equal((await f.publisher.observe(f.input)).status, 'unknown');
  f.github.pulls[0].draft = false;
  assert.equal((await f.publisher.observe(f.input)).status, 'published');
});

test('abort at the promotion send boundary returns cancellation and leaves the PR draft', async t => {
  const f = await fixture(t), controller = new AbortController();
  f.publisher.failpoint = point => { if (point === 'pr_ready') controller.abort(); };
  const result = await f.publisher.publish(f.input, { signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(result.pr, null);
  assert.equal(f.github.pulls[0].draft, true); assert.equal(f.github.promotions.length, 0);
  assert.equal((await f.publisher.publish(f.input, { signal: controller.signal })).status, 'cancelled');
});
