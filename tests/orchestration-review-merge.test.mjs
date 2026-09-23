import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ReviewMerge } from '../server/orchestration/adapters/review-merge.mjs';

const run = promisify(execFile);
const git = (cwd, argv) => run('git', ['--no-pager', ...argv], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@invalid' } }).then(({ stdout }) => stdout.trim());

/** A disposable repository with a base branch and a diverged pull request branch. */
async function repository(t) {
  const directory = mkdtempSync(join(tmpdir(), 'companion-review-merge-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await git(directory, ['init', '--initial-branch=main', '.']);
  writeFileSync(join(directory, 'shared.txt'), 'base\n');
  mkdirSync(join(directory, 'src'), { recursive: true });
  writeFileSync(join(directory, 'src', 'a.mjs'), 'export const a = 1;\n');
  await git(directory, ['add', '.']); await git(directory, ['commit', '-m', 'base']);
  const baseSha = await git(directory, ['rev-parse', 'HEAD']);
  await git(directory, ['checkout', '-b', 'pr']);
  writeFileSync(join(directory, 'src', 'a.mjs'), 'export const a = 2;\n');
  await git(directory, ['commit', '-am', 'pr change']);
  const prHead = await git(directory, ['rev-parse', 'HEAD']);
  await git(directory, ['checkout', 'main']);
  return { directory, baseSha, prHead };
}

function adapter(repo, { targetHead, onFetch = () => {} }) {
  return new ReviewMerge({
    repositories: { async repository() { return { repository: repo.directory, common: join(repo.directory, '.git') }; } },
    remote: { async fetchBase() { onFetch(); return targetHead(); } },
  });
}

test('a clean merge produces one commit with both parents', async (t) => {
  const repo = await repository(t);
  writeFileSync(join(repo.directory, 'shared.txt'), 'target change\n');
  await git(repo.directory, ['commit', '-am', 'target change']);
  const targetHead = await git(repo.directory, ['rev-parse', 'HEAD']);
  const merge = adapter(repo, { targetHead: () => targetHead });
  const result = await merge.prepareReviewMerge({ goalId: 'goal1', repositoryId: 'repo1', roundId: 'round1', prHeadSha: repo.prHead, baseBranch: 'main' });
  assert.equal(result.mergedBaseSha, targetHead);
  assert.deepEqual(result.conflictPaths, []);
  const parents = (await git(repo.directory, ['rev-list', '--parents', '-n', '1', result.mergeCommitSha])).split(' ');
  assert.deepEqual(parents.slice(1), [repo.prHead, targetHead]);
  assert.equal(await git(repo.directory, ['show', `${result.mergeCommitSha}:src/a.mjs`]), 'export const a = 2;');
  assert.equal(await git(repo.directory, ['show', `${result.mergeCommitSha}:shared.txt`]), 'target change');
});

test('a conflicted merge still commits, and reports the conflicted path once', async (t) => {
  const repo = await repository(t);
  writeFileSync(join(repo.directory, 'src', 'a.mjs'), 'export const a = 3;\n');
  await git(repo.directory, ['commit', '-am', 'target conflicting change']);
  const targetHead = await git(repo.directory, ['rev-parse', 'HEAD']);
  const merge = adapter(repo, { targetHead: () => targetHead });
  const result = await merge.prepareReviewMerge({ goalId: 'goal1', repositoryId: 'repo1', roundId: 'round1', prHeadSha: repo.prHead, baseBranch: 'main' });
  assert.deepEqual(result.conflictPaths, ['src/a.mjs']);
  const parents = (await git(repo.directory, ['rev-list', '--parents', '-n', '1', result.mergeCommitSha])).split(' ');
  assert.deepEqual(parents.slice(1), [repo.prHead, targetHead]);
  const content = await git(repo.directory, ['show', `${result.mergeCommitSha}:src/a.mjs`]);
  assert.match(content, /<<<<<<</);
});

test('a path containing a space is reported intact', async (t) => {
  const repo = await repository(t);
  await git(repo.directory, ['checkout', 'pr']);
  writeFileSync(join(repo.directory, 'a file with spaces.txt'), 'pr change\n');
  await git(repo.directory, ['add', '.']); await git(repo.directory, ['commit', '-m', 'pr spaced change']);
  const prHead = await git(repo.directory, ['rev-parse', 'HEAD']);
  await git(repo.directory, ['checkout', 'main']);
  writeFileSync(join(repo.directory, 'a file with spaces.txt'), 'target change\n');
  await git(repo.directory, ['add', '.']); await git(repo.directory, ['commit', '-m', 'target spaced change']);
  const targetHead = await git(repo.directory, ['rev-parse', 'HEAD']);
  const merge = adapter(repo, { targetHead: () => targetHead });
  const result = await merge.prepareReviewMerge({ goalId: 'goal1', repositoryId: 'repo1', roundId: 'round1', prHeadSha: prHead, baseBranch: 'main' });
  assert.ok(result.conflictPaths.includes('a file with spaces.txt'));
});

test('a repeated call for the same round observes the pinned merge', async (t) => {
  const repo = await repository(t);
  writeFileSync(join(repo.directory, 'shared.txt'), 'target change\n');
  await git(repo.directory, ['commit', '-am', 'target change']);
  let targetHead = await git(repo.directory, ['rev-parse', 'HEAD']);
  let fetches = 0;
  const merge = adapter(repo, { targetHead: () => targetHead, onFetch: () => { fetches += 1; } });
  const first = await merge.prepareReviewMerge({ goalId: 'goal1', repositoryId: 'repo1', roundId: 'round1', prHeadSha: repo.prHead, baseBranch: 'main' });
  writeFileSync(join(repo.directory, 'shared.txt'), 'target change again\n');
  await git(repo.directory, ['commit', '-am', 'target moved again']);
  targetHead = await git(repo.directory, ['rev-parse', 'HEAD']);
  const second = await merge.prepareReviewMerge({ goalId: 'goal1', repositoryId: 'repo1', roundId: 'round1', prHeadSha: repo.prHead, baseBranch: 'main' });
  assert.deepEqual(second, first);
  assert.equal(fetches, 1);
});

test('a merge recorded for a different pull request head is refused', async (t) => {
  const repo = await repository(t);
  writeFileSync(join(repo.directory, 'shared.txt'), 'target change\n');
  await git(repo.directory, ['commit', '-am', 'target change']);
  const targetHead = await git(repo.directory, ['rev-parse', 'HEAD']);
  const merge = adapter(repo, { targetHead: () => targetHead });
  await merge.prepareReviewMerge({ goalId: 'goal1', repositoryId: 'repo1', roundId: 'round1', prHeadSha: repo.prHead, baseBranch: 'main' });
  await git(repo.directory, ['checkout', 'pr']);
  writeFileSync(join(repo.directory, 'src', 'a.mjs'), 'export const a = 4;\n');
  await git(repo.directory, ['commit', '-am', 'pr second change']);
  const otherPrHead = await git(repo.directory, ['rev-parse', 'HEAD']);
  await git(repo.directory, ['checkout', 'main']);
  await assert.rejects(
    merge.prepareReviewMerge({ goalId: 'goal1', repositoryId: 'repo1', roundId: 'round1', prHeadSha: otherPrHead, baseBranch: 'main' }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
});

test('a worktree at the merge commit shows the markers', async (t) => {
  const repo = await repository(t);
  writeFileSync(join(repo.directory, 'src', 'a.mjs'), 'export const a = 3;\n');
  await git(repo.directory, ['commit', '-am', 'target conflicting change']);
  const targetHead = await git(repo.directory, ['rev-parse', 'HEAD']);
  const merge = adapter(repo, { targetHead: () => targetHead });
  const result = await merge.prepareReviewMerge({ goalId: 'goal1', repositoryId: 'repo1', roundId: 'round1', prHeadSha: repo.prHead, baseBranch: 'main' });
  const worktree = mkdtempSync(join(tmpdir(), 'companion-review-merge-wt-'));
  t.after(async () => {
    try { await run('git', ['-C', repo.directory, 'worktree', 'remove', '--force', worktree]); } catch { /* best effort */ }
    rmSync(worktree, { recursive: true, force: true });
  });
  await run('git', ['-C', repo.directory, 'worktree', 'add', '--detach', worktree, result.mergeCommitSha]);
  const content = readFileSync(join(worktree, 'src', 'a.mjs'), 'utf8');
  assert.match(content, /<<<<<<</);
});

test('a commit that still carries conflict markers is reported as unresolved', async (t) => {
  const repo = await repository(t);
  await git(repo.directory, ['checkout', 'main']);
  writeFileSync(join(repo.directory, 'src', 'a.mjs'), 'export const a = 3;\n');
  await git(repo.directory, ['commit', '-am', 'conflicting target change']);
  const targetHead = await git(repo.directory, ['rev-parse', 'main']);
  const merge = adapter(repo, { targetHead: () => targetHead });
  const prepared = await merge.prepareReviewMerge({ goalId: 'goal', repositoryId: 'repo', roundId: 'round1', prHeadSha: repo.prHead, baseBranch: 'main' });
  assert.deepEqual(prepared.conflictPaths, ['src/a.mjs']);

  // The merge commit itself carries the markers.
  assert.deepEqual(await merge.unresolvedPaths({ repositoryId: 'repo', headSha: prepared.mergeCommitSha, conflictPaths: prepared.conflictPaths }), ['src/a.mjs']);

  // A careless fixer edits the file but leaves the markers in place. Ancestry
  // and changed-path scope both pass, so only a content proof catches it.
  await git(repo.directory, ['branch', 'careless', prepared.mergeCommitSha]);
  const careless = join(repo.directory, 'careless-wt');
  await git(repo.directory, ['worktree', 'add', '-q', careless, 'careless']);
  writeFileSync(join(careless, 'src', 'a.mjs'), `${await git(careless, ['show', 'HEAD:src/a.mjs'])}\n// touched\n`);
  await git(careless, ['commit', '-am', 'not really resolved']);
  const carelessHead = await git(careless, ['rev-parse', 'HEAD']);
  await assert.doesNotReject(git(repo.directory, ['merge-base', '--is-ancestor', prepared.mergeCommitSha, carelessHead]));
  assert.deepEqual(await merge.unresolvedPaths({ repositoryId: 'repo', headSha: carelessHead, conflictPaths: prepared.conflictPaths }), ['src/a.mjs'],
    'a new in-scope commit descending from the merge is still unresolved');

  // A real resolution is accepted.
  await git(repo.directory, ['branch', 'resolved', prepared.mergeCommitSha]);
  const resolved = join(repo.directory, 'resolved-wt');
  await git(repo.directory, ['worktree', 'add', '-q', resolved, 'resolved']);
  writeFileSync(join(resolved, 'src', 'a.mjs'), 'export const a = 3;\n');
  await git(resolved, ['commit', '-am', 'resolved']);
  const resolvedHead = await git(resolved, ['rev-parse', 'HEAD']);
  assert.deepEqual(await merge.unresolvedPaths({ repositoryId: 'repo', headSha: resolvedHead, conflictPaths: prepared.conflictPaths }), []);
});
