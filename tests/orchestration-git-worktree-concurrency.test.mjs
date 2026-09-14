import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { git } from '../server/orchestration/adapters/git.mjs';
import { createRepositoryFixture, fixtureGit } from './helpers/orchestration/fixture.mjs';

async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(25); }
  assert.fail('Disposable Git command did not reach its barrier');
}

for (const mutation of ['add', 'remove']) test(`worktree ${mutation} excludes another add/list across linked paths while other repositories progress`, async t => {
  const repo = await createRepositoryFixture(), other = await createRepositoryFixture();
  const directory = realpathSync(repo.directory), bin = join(directory, 'bin'); mkdirSync(bin);
  const linked = await repo.checkout('linked');
  const alias = join(directory, 'alias'); symlinkSync(linked.worktree, alias);
  const ready = join(directory, 'ready'), gate = join(directory, 'gate'), entered = join(directory, 'entered');
  const common = await fixtureGit(repo.repository, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const incomplete = join(common, 'worktrees', 'incomplete');
  const held = join(repo.worktrees, 'held'), next = join(repo.worktrees, 'next');
  if (mutation === 'remove') await fixtureGit(repo.repository, ['worktree', 'add', '--detach', held, repo.baseSha]);
  // Emulate Git's non-atomic registry creation/removal at the exact vulnerable
  // boundary: directory exists but commondir does not. Competing real Git must
  // never enumerate that partial registration while our mutation owns it.
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2), index = args.indexOf('worktree');
if (index >= 0 && args.includes(${JSON.stringify(held)})) {
  fs.mkdirSync(${JSON.stringify(incomplete)});
  fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(${JSON.stringify(gate)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  fs.rmSync(${JSON.stringify(incomplete)}, { recursive: true });
}
if (index >= 0 && (args.includes(${JSON.stringify(next)}) || (args[index + 1] === 'list' && fs.realpathSync(process.cwd()) === ${JSON.stringify(realpathSync(linked.worktree))}))) fs.writeFileSync(${JSON.stringify(entered)}, 'entered');
const result = cp.spawnSync('/usr/bin/git', args, { stdio: 'inherit' }); process.exit(result.status ?? 1);
`); chmodSync(join(bin, 'git'), 0o700);
  const saved = process.env.PATH; process.env.PATH = `${bin}:${saved}`;
  const pending = [];
  t.after(async () => { writeFileSync(gate, 'release'); await Promise.allSettled(pending); process.env.PATH = saved; await repo.close(); await other.close(); });
  const first = git(repo.repository, mutation === 'add' ? ['worktree', 'add', '--detach', held, repo.baseSha] : ['worktree', 'remove', held]); pending.push(first);
  await until(() => existsSync(ready));
  // Start through a symlink to a linked worktree, not the configured root.
  const second = git(alias, ['worktree', 'add', '--detach', next, repo.baseSha]); pending.push(second); second.catch(() => {});
  const listing = git(alias, ['worktree', 'list', '--porcelain']); pending.push(listing); listing.catch(() => {});
  await git(other.repository, ['worktree', 'add', '--detach', join(other.worktrees, 'independent'), other.baseSha]);
  assert.equal(existsSync(entered), false, 'same-repository command entered incomplete registry');
  writeFileSync(gate, 'release');
  await Promise.all(pending);
  assert.equal(await fixtureGit(next, ['rev-parse', 'HEAD']), repo.baseSha);
  // A rejected mutation must release its queue; it must not poison later work.
  await assert.rejects(git(alias, ['worktree', 'remove', join(repo.worktrees, 'missing')]), { code: 'GIT_OPERATION_FAILED' });
  assert.match(await git(alias, ['worktree', 'list', '--porcelain']), /worktree /);
});
