import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitRemote } from '../server/orchestration/adapters/git-remote.mjs';
import { GitRepository } from '../server/orchestration/adapters/git.mjs';
import { ArtifactStore } from '../server/orchestration/storage/artifacts.mjs';
import { createRepositoryFixture, fixtureGit } from './helpers/orchestration/fixture.mjs';

test('SCP destination fetches latest main and publishes with unchanged destination identity and local branch', async t => {
  const repo = await createRepositoryFixture(); t.after(() => repo.close());
  const bin = join(repo.directory, 'bin'), calls = join(repo.directory, 'ssh-calls'); mkdirSync(bin);
  // Real Git transport through a disposable SSH substitute; no network or shell
  // evaluation of the remote command. Only the exact fixture destination runs.
  writeFileSync(join(bin, 'ssh'), `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process'), assert = require('node:assert/strict');
const args = process.argv.slice(2);
if (args.includes('-G')) process.exit(0);
assert.equal(args.at(-2), 'git@github.com');
const command = args.at(-1); assert.ok(["git-upload-pack 'HaLx-Inc/dicteeenligne.git'", "git-receive-pack 'HaLx-Inc/dicteeenligne.git'"].includes(command));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
const result = cp.spawnSync('/usr/bin/git', [command.startsWith('git-upload-pack') ? 'upload-pack' : 'receive-pack', ${JSON.stringify(repo.remote)}], {stdio:'inherit'});
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  const artifacts = new ArtifactStore({ directory: join(repo.directory, 'artifacts') });
  const repositories = new GitRepository({ repositories: new Map([['repo', repo.repository]]), directory: join(repo.directory, 'resources'), artifacts });
  const url = 'git@github.com:HaLx-Inc/dicteeenligne.git';
  const options = { repositories, directory: join(repo.directory, 'remote-stage'), destinations: new Map([['repo', { url, protocol: 'ssh', env: { PATH: `${bin}:${process.env.PATH}`, HOME: repo.directory } }]]) };
  const remote = new GitRemote(options);
  assert.equal(remote.identity('repo'), `ssh:${url}`);
  const upstream = await repo.checkout('upstream'), latest = await repo.implement(upstream.worktree, 'A');
  await fixtureGit(upstream.worktree, ['push', 'origin', `${latest}:refs/heads/main`]);
  const original = await fixtureGit(repo.repository, ['rev-parse', 'HEAD']);
  assert.equal(await remote.fetchBase('repo', 'main'), latest);
  assert.equal(await remote.head('repo', 'main'), latest);
  assert.equal(await fixtureGit(repo.repository, ['rev-parse', 'HEAD']), original);
  await remote.push({ repositoryId: 'repo', branch: 'companion/scp-proof', headSha: latest, expectedHead: null });
  assert.equal(await new GitRemote(options).head('repo', 'companion/scp-proof'), latest);
  assert.equal(new GitRemote(options).identity('repo'), `ssh:${url}`);
  assert.ok(readFileSync(calls, 'utf8').includes('git-receive-pack'));
});

test('remote transport validation accepts supported URL forms and rejects SCP protocol confusion and shell syntax', async t => {
  const repo = await createRepositoryFixture(); t.after(() => repo.close());
  const destinations = new Map(), remote = new GitRemote({ repositories: {}, directory: join(repo.directory, 'stage'), destinations });
  for (const [url, protocol] of [
    ['git@github.com:owner/repo.git', 'ssh'], ['git@github-work:owner/repo.git', 'ssh'],
    ['ssh://git@github.com/owner/repo.git', 'ssh'], ['https://github.com/owner/repo.git', 'https'],
  ]) {
    destinations.set('repo', { url, protocol, env: {} }); assert.equal(remote.destination('repo').url, url);
  }
  for (const [url, protocol] of [
    ['git@github.com:owner/repo.git', 'https'], ['git@github.com:owner/repo;touch-x', 'ssh'],
    ['git@github.com:-option', 'ssh'], ['git@github.com:owner/repo\n', 'ssh'],
    ['git@github.com:owner/repo?token=x', 'ssh'], ['git@github.com:owner/repo#x', 'ssh'],
    ['https://user:secret@github.com/owner/repo', 'https'], ['https://user@github.com/owner/repo', 'https'],
    ['ssh://git:secret@github.com/owner/repo', 'ssh'], ['not-a-remote', 'ssh'],
  ]) {
    destinations.set('repo', { url, protocol, env: {} }); assert.throws(() => remote.destination('repo'), /Unsupported remote URL/);
  }
});
