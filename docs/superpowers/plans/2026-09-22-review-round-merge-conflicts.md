# Review round merge conflicts implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A review round resolves merge conflicts as well as review comments, and one automatic round starts when the merge poll observes a conflict.

**Architecture:** `readPull` reports GitHub's `mergeable` verdict. A conflicting or unknown verdict moves the round to a new `merging` state. Companion computes the merge with `git merge-tree --write-tree`, commits the resulting tree with the pull request head and the target head as its two parents, pins it under an owned ref, and records the conflicted paths. The fixer's target becomes that merge commit, so the existing worktree provisioning and candidate proof work unchanged.

**Tech Stack:** Node.js 22, plain ESM with JSDoc types, `node:test`, Vitest for UI, SQLite journal, argv-only Git and `gh` calls.

**Spec:** `docs/superpowers/specs/2026-09-22-review-round-merge-conflicts-design.md`

---

## File structure

**Domain (pure, no I/O):**
- `server/orchestration/types.d.ts` — round fields, port signatures.
- `server/orchestration/domain/review-round.mjs` — `parseConflictPaths`, `reviewRoundPhase`.
- `server/orchestration/domain/transitions.mjs` — `record_review_threads`, new `record_review_merge`, `accept_review_fix_result`, `request_review_fix`, `record_merge_sync`.
- `server/orchestration/domain/scheduling.mjs` — dispatch the fixer on threads or conflicts.

**Adapters (I/O boundaries):**
- `server/orchestration/adapters/github-cli.mjs` — `readPull` returns `mergeable`.
- `server/orchestration/adapters/github.mjs` — `reviewThreads` returns the verdict with the threads.
- `server/orchestration/adapters/review-merge.mjs` — **new file**, `ReviewMerge.prepare`.

**Coordinators (effects under the ownership fence):**
- `server/orchestration/review-fix-coordinator.mjs` — drive the `merging` state.
- `server/orchestration/merge-coordinator.mjs` — start the automatic round.
- `server/orchestration/production.mjs` — compose `ReviewMerge`.

**UI:**
- `app/orchestration/goal-detail.tsx` — merge phase and round card fields.

**Tests:**
- `tests/orchestration-review-fix.test.mjs` — domain and coordinator.
- `tests/orchestration-merge-sync.test.mjs` — `readPull` and the automatic round.
- `tests/orchestration-review-merge.test.mjs` — **new file**, the Git adapter.
- `tests/ui-orchestration.test.tsx` — the rendered phase and card.
- `tests/helpers/orchestration/fake-github.mjs` — the `mergeable` verdict.

---

## Task 1: Report the mergeable verdict from the GitHub CLI

**Files:**
- Modify: `server/orchestration/adapters/github-cli.mjs:30-45`
- Modify: `server/orchestration/types.d.ts:166`
- Test: `tests/orchestration-merge-sync.test.mjs`

GitHub's REST `pulls/{number}` response carries `mergeable` as `true`, `false` or `null`, and `mergeable_state`. `null` means GitHub has not finished computing. Map it: `true` to `mergeable`, `false` to `conflicting`, anything else to `unknown`. Never map an unexpected value to `mergeable`.

- [ ] **Step 1: Write the failing test**

Append to `tests/orchestration-merge-sync.test.mjs`:

```javascript
test('the pull request read reports a bounded mergeable verdict', async () => {
  let response = { number: 7, html_url: 'https://github.com/owner/repo/pull/7', base: { repo: { full_name: 'owner/repo' }, sha: 'a'.repeat(40) }, state: 'open', merged: false, mergeable: true };
  const cli = new GitHubCli({ repositories: new Map([['repo', 'owner/repo']]), cwd: tmpdir(), env: {}, execute: async () => JSON.stringify(response) });
  assert.equal((await cli.readPull('repo', 7)).mergeable, 'mergeable');
  response = { ...response, mergeable: false };
  assert.equal((await cli.readPull('repo', 7)).mergeable, 'conflicting');
  response = { ...response, mergeable: null };
  assert.equal((await cli.readPull('repo', 7)).mergeable, 'unknown');
  response = { ...response, mergeable: 'yes' };
  assert.equal((await cli.readPull('repo', 7)).mergeable, 'unknown', 'an unexpected value never reads as mergeable');
  delete response.mergeable;
  assert.equal((await cli.readPull('repo', 7)).mergeable, 'unknown');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/orchestration-merge-sync.test.mjs`
Expected: FAIL, because `mergeable` is `undefined`.

- [ ] **Step 3: Return the verdict**

In `server/orchestration/adapters/github-cli.mjs`, replace the final `return` of `readPull`:

```javascript
    return { number, url: pr.html_url, state: pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed',
      mergeable: pr.mergeable === true ? /** @type {const} */ ('mergeable') : pr.mergeable === false ? /** @type {const} */ ('conflicting') : /** @type {const} */ ('unknown') };
```

Update the JSDoc return type on the same method:

```javascript
  /** @returns {Promise<{ number:number; url:string; state:'open'|'closed'|'merged'; mergeable:'mergeable'|'conflicting'|'unknown' }>} */
```

- [ ] **Step 4: Widen the port type**

In `server/orchestration/types.d.ts`, replace the `readPull` line inside `GitHubPort`:

```typescript
  readPull?(repositoryId: string, number: number): Promise<{ number: number; url: string; state: 'open' | 'closed' | 'merged'; mergeable: MergeableVerdict }>;
```

Add above `interface ReviewThread`:

```typescript
export type MergeableVerdict = 'mergeable' | 'conflicting' | 'unknown';
```

- [ ] **Step 5: Run the tests and the type check**

Run: `node --test tests/orchestration-merge-sync.test.mjs && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add server/orchestration/adapters/github-cli.mjs server/orchestration/types.d.ts tests/orchestration-merge-sync.test.mjs
git commit -m "feat: report the GitHub mergeable verdict from the pull request read

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Carry the verdict through the publication adapter and the fake

**Files:**
- Modify: `server/orchestration/adapters/github.mjs:16-29`
- Modify: `server/orchestration/types.d.ts:176-178`
- Modify: `tests/helpers/orchestration/fake-github.mjs:10-19`
- Test: `tests/orchestration-review-fix.test.mjs`

`reviewThreads` already calls `readPull` for the identity guard. It now returns that verdict and the target head with the threads, so the round reads both in one GitHub call.

- [ ] **Step 1: Write the failing test**

Append to `tests/orchestration-review-fix.test.mjs`:

```javascript
test('the publication adapter returns the mergeable verdict with the threads', async () => {
  const calls = [];
  const github = {
    identity: () => 'fake',
    async readPull(repositoryId, number) { calls.push(['readPull', number]); return { number, url: 'https://example.test/pr/1', state: 'open', mergeable: 'conflicting' }; },
    async listReviewThreads() { calls.push(['threads']); return [thread('PRRT_1')]; },
    async find() { return []; },
    async create() {},
  };
  const { GitHubPublication } = await import('../server/orchestration/adapters/github.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'companion-pub-'));
  try {
    const publication = new GitHubPublication({ directory, remote: { identity: () => 'r', async head() { return null; }, async push() {} }, github });
    const observed = await publication.reviewThreads({ repositoryId: 'repo' }, { number: 1, url: 'https://example.test/pr/1', headSha: HEAD_B });
    assert.equal(observed.mergeable, 'conflicting');
    assert.equal(observed.threads.length, 1);
    assert.deepEqual(calls, [['readPull', 1], ['threads']]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/orchestration-review-fix.test.mjs`
Expected: FAIL, because `reviewThreads` returns a bare array.

- [ ] **Step 3: Return the verdict with the threads**

In `server/orchestration/adapters/github.mjs`, replace the body of `reviewThreads` after the identity guard:

```javascript
    return { threads: await this.github.listReviewThreads(input.repositoryId, pr.number), mergeable: observed.mergeable };
```

- [ ] **Step 4: Widen the port type**

In `server/orchestration/types.d.ts`, replace the `reviewThreads` line inside `PublicationPort`:

```typescript
  reviewThreads?(input: PublicationInput, pr: NonNullable<Goal['pr']>): Promise<{ threads: ReviewThread[]; mergeable: MergeableVerdict }>;
```

Replace the `observeMerge` line in the same interface:

```typescript
  observeMerge?(input: PublicationInput, pr: NonNullable<Goal['pr']>): Promise<{ number: number; url: string; state: 'open' | 'closed' | 'merged'; mergeable: MergeableVerdict }>;
```

- [ ] **Step 5: Teach the fake the verdict**

In `tests/helpers/orchestration/fake-github.mjs`, replace `readPull`:

```javascript
  async readPull(repositoryId, number) {
    const pr = this.pulls.find(pr => pr.repositoryId === repositoryId && pr.number === number);
    if (!pr) throw new Error('PR not found');
    return { number: pr.number, url: pr.url, state: pr.state, mergeable: pr.mergeable ?? 'mergeable' };
  }
```

- [ ] **Step 6: Run the tests and the type check**

Run: `node --test tests/orchestration-review-fix.test.mjs && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add server/orchestration/adapters/github.mjs server/orchestration/types.d.ts tests/helpers/orchestration/fake-github.mjs tests/orchestration-review-fix.test.mjs
git commit -m "feat: return the mergeable verdict with the review threads

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add the merging state to the domain

**Files:**
- Modify: `server/orchestration/types.d.ts:49-55`
- Modify: `server/orchestration/domain/review-round.mjs:1-20, 53-60`
- Modify: `server/orchestration/domain/transitions.mjs:717-729`
- Test: `tests/orchestration-review-fix.test.mjs`

`record_review_threads` gains `mergeable`. A `mergeable` verdict with zero threads still settles as `nothing_to_address`. Any other verdict moves the round to `merging`, even with zero threads.

- [ ] **Step 1: Write the failing test**

Append to `tests/orchestration-review-fix.test.mjs`:

```javascript
test('a conflicting or unknown verdict merges rather than settling', () => {
  const clean = fixture(); clean.deliver(); clean.command('request_review_fix', {}, clean.user);
  clean.command('record_review_threads', { roundId: clean.goal.reviewRound.id, threads: [], mergeable: 'mergeable' });
  assert.equal(clean.goal.status, 'delivered');
  assert.equal(clean.goal.reviewRounds[0].outcome, 'nothing_to_address');

  const conflicting = fixture(); conflicting.deliver(); conflicting.command('request_review_fix', {}, conflicting.user);
  conflicting.command('record_review_threads', { roundId: conflicting.goal.reviewRound.id, threads: [], mergeable: 'conflicting' });
  assert.equal(conflicting.goal.status, 'addressing_review');
  assert.equal(conflicting.goal.reviewRound.state, 'merging');
  assert.equal(conflicting.goal.reviewRound.mergeable, 'conflicting');
  assert.equal(reviewRoundPhase(conflicting.goal.reviewRound), 'Merging the target branch');

  const unknown = fixture(); unknown.deliver(); unknown.command('request_review_fix', {}, unknown.user);
  unknown.command('record_review_threads', { roundId: unknown.goal.reviewRound.id, threads: threads(), mergeable: 'unknown' });
  assert.equal(unknown.goal.reviewRound.state, 'merging', 'an uncomputed verdict is decided by the local merge');
  assert.equal(readyWork(unknown.goal).length, 0, 'no fixer runs before the merge is recorded');

  const threadsOnly = fixture(); threadsOnly.deliver(); threadsOnly.command('request_review_fix', {}, threadsOnly.user);
  threadsOnly.command('record_review_threads', { roundId: threadsOnly.goal.reviewRound.id, threads: threads(), mergeable: 'mergeable' });
  assert.equal(threadsOnly.goal.reviewRound.state, 'fixing');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/orchestration-review-fix.test.mjs`
Expected: FAIL with "Unknown reply action" or a state mismatch on `merging`.

- [ ] **Step 3: Extend the round type**

In `server/orchestration/types.d.ts`, replace the `ReviewRoundState` line and the `ReviewRound` fields:

```typescript
export type ReviewRoundState = 'fetching' | 'merging' | 'fixing' | 'verifying' | 'pushing' | 'replying' | 'settled' | 'failed' | 'unknown';
export type ReviewRoundOutcome = 'addressed' | 'nothing_to_address' | 'failed';
export interface ReviewRound {
  id: string; prHeadSha: string; startedAt: number; state: ReviewRoundState; threads: ReviewThread[];
  trigger?: 'user' | 'conflict'; mergeable?: MergeableVerdict;
  mergedBaseSha?: string; mergeCommitSha?: string; conflictPaths?: string[];
  attemptId?: string; summary?: string; fixHeadSha?: string; replies?: ReviewReply[]; verificationOperationId?: string;
  posted?: string[]; unconfirmed?: string[]; resolved?: string[]; outcome?: ReviewRoundOutcome; error?: string | null; settledAt?: number;
}
```

- [ ] **Step 4: Add the merge phase label**

In `server/orchestration/domain/review-round.mjs`, replace `reviewRoundPhase`:

```javascript
/** @param {import('../types.d.ts').ReviewRound} round */
export function reviewRoundPhase(round) {
  if (round.state === 'fetching') return 'Fetching review threads';
  if (round.state === 'merging') return 'Merging the target branch';
  if (round.state === 'fixing') {
    const conflicts = round.conflictPaths?.length ?? 0;
    const threads = `${round.threads.length} ${round.threads.length === 1 ? 'thread' : 'threads'}`;
    return conflicts ? `Fixing ${threads} and ${conflicts} ${conflicts === 1 ? 'conflict' : 'conflicts'}` : `Fixing ${threads}`;
  }
  if (round.state === 'verifying') return 'Verifying fix';
  if (round.state === 'pushing' || round.state === 'replying') return 'Pushing and replying';
  return round.state === 'settled' ? 'Round complete' : round.state === 'unknown' ? 'Push outcome uncertain' : 'Round failed';
}
```

- [ ] **Step 5: Record the verdict in the transition**

In `server/orchestration/domain/transitions.mjs`, replace the body of `case 'record_review_threads':`:

```javascript
    case 'record_review_threads': {
      requireAuthority(authority, 'system');
      const round = activeRound(goal, input.roundId);
      requireValue(round.state === 'fetching', 'Review threads were already recorded', 'STALE_OPERATION');
      requireValue(['mergeable', 'conflicting', 'unknown'].includes(String(input.mergeable)), 'Invalid mergeable verdict');
      round.threads = parseReviewThreads(input.threads);
      round.mergeable = /** @type {import('../types.d.ts').MergeableVerdict} */ (input.mergeable);
      if (round.mergeable !== 'mergeable') {
        round.state = 'merging';
        emit('review_merge_requested', { roundId: round.id, mergeable: round.mergeable, count: round.threads.length }); break;
      }
      if (!round.threads.length) {
        closeRound(goal, round, 'nothing_to_address', integer(input.at ?? 0));
        emit('review_fix_settled', { roundId: round.id, outcome: 'nothing_to_address' }); break;
      }
      round.state = 'fixing';
      emit('review_threads_recorded', { roundId: round.id, count: round.threads.length }); break;
    }
```

- [ ] **Step 6: Run the tests and the type check**

Run: `node --test tests/orchestration-review-fix.test.mjs && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add server/orchestration/types.d.ts server/orchestration/domain/review-round.mjs server/orchestration/domain/transitions.mjs tests/orchestration-review-fix.test.mjs
git commit -m "feat: move a conflicting review round to a merging state

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Record the prepared merge

**Files:**
- Modify: `server/orchestration/domain/review-round.mjs`
- Modify: `server/orchestration/domain/transitions.mjs`
- Modify: `server/orchestration/domain/scheduling.mjs:24-29`
- Test: `tests/orchestration-review-fix.test.mjs`

`record_review_merge` records what Companion's merge produced. Zero conflicted paths and zero threads skip the agent; anything else dispatches the fixer against the merge commit.

- [ ] **Step 1: Write the failing test**

Append to `tests/orchestration-review-fix.test.mjs`:

```javascript
const MERGE_COMMIT = 'e'.repeat(40);
const BASE_HEAD = 'f'.repeat(40);

test('a clean merge with no threads skips the agent and verifies the merge commit', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  f.command('record_review_threads', { roundId, threads: [], mergeable: 'conflicting' });
  f.command('record_review_merge', { roundId, mergedBaseSha: BASE_HEAD, mergeCommitSha: MERGE_COMMIT, conflictPaths: [] });
  assert.equal(f.goal.reviewRound.state, 'verifying');
  assert.equal(f.goal.reviewRound.fixHeadSha, MERGE_COMMIT);
  assert.equal(f.goal.reviewRound.mergedBaseSha, BASE_HEAD);
  assert.equal(readyWork(f.goal).length, 0, 'no fixer is dispatched for a clean merge with no threads');
});

test('a conflicted merge dispatches the fixer against the merge commit', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  f.command('record_review_threads', { roundId, threads: [], mergeable: 'conflicting' });
  f.command('record_review_merge', { roundId, mergedBaseSha: BASE_HEAD, mergeCommitSha: MERGE_COMMIT, conflictPaths: ['src/a.mjs', 'package-lock.json'] });
  assert.equal(f.goal.reviewRound.state, 'fixing');
  assert.deepEqual(f.goal.reviewRound.conflictPaths, ['src/a.mjs', 'package-lock.json']);
  assert.deepEqual(readyWork(f.goal).map((entry) => [entry.role, entry.target]), [['review_fixer', MERGE_COMMIT]]);
  f.request('fx', 'review_fixer'); const attempt = f.goal.attempts.at(-1);
  assert.equal(attempt.baseSha, MERGE_COMMIT, 'the fixer worktree starts on the merge, with its conflict markers');
  assert.equal(reviewRoundPhase(f.goal.reviewRound), 'Fixing 0 threads and 2 conflicts');
});

test('a merge record is refused outside the merging state and rejects an unowned path', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  fails(() => f.command('record_review_merge', { roundId, mergedBaseSha: BASE_HEAD, mergeCommitSha: MERGE_COMMIT, conflictPaths: [] }), 'NOT_READY');
  f.command('record_review_threads', { roundId, threads: [], mergeable: 'conflicting' });
  fails(() => f.command('record_review_merge', { roundId, mergedBaseSha: BASE_HEAD, mergeCommitSha: MERGE_COMMIT, conflictPaths: ['../outside'] }));
  fails(() => f.command('record_review_merge', { roundId, mergedBaseSha: BASE_HEAD, mergeCommitSha: HEAD_B, conflictPaths: [] }), 'STALE_TARGET');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/orchestration-review-fix.test.mjs`
Expected: FAIL with "Unknown command" for `record_review_merge`.

- [ ] **Step 3: Parse the conflicted paths**

In `server/orchestration/domain/review-round.mjs`, add after `parseReviewThreads`:

```javascript
export const MAX_CONFLICT_PATHS = 1000;

/** Conflicted paths are Git's own output, recorded literally and bounded. They
 * widen the fixer's allowed scope, so they are validated as repository paths.
 * @param {unknown} value @returns {string[]} */
export function parseConflictPaths(value) {
  const paths = array(value, MAX_CONFLICT_PATHS).map((entry) => ownedArea(entry));
  requireValue(new Set(paths).size === paths.length, 'Duplicate conflict path');
  return paths;
}
```

- [ ] **Step 4: Add the transition**

In `server/orchestration/domain/transitions.mjs`, import `parseConflictPaths` alongside the existing `parseReviewThreads` import from `./review-round.mjs`, then add a case immediately after `record_review_threads`:

```javascript
    case 'record_review_merge': {
      requireAuthority(authority, 'system');
      const round = activeRound(goal, input.roundId);
      requireValue(round.state === 'merging', 'A merge is not awaited', 'NOT_READY');
      const mergedBaseSha = sha(input.mergedBaseSha), mergeCommitSha = sha(input.mergeCommitSha);
      requireValue(mergeCommitSha !== round.prHeadSha && mergeCommitSha !== mergedBaseSha, 'A merge needs a new commit', 'STALE_TARGET');
      round.mergedBaseSha = mergedBaseSha; round.mergeCommitSha = mergeCommitSha;
      round.conflictPaths = parseConflictPaths(input.conflictPaths);
      if (!round.conflictPaths.length && !round.threads.length) {
        round.fixHeadSha = mergeCommitSha; round.state = 'verifying';
        emit('review_merge_recorded', { roundId: round.id, headSha: mergeCommitSha, conflicts: 0 }); break;
      }
      round.state = 'fixing';
      emit('review_merge_recorded', { roundId: round.id, headSha: mergeCommitSha, conflicts: round.conflictPaths.length }); break;
    }
```

- [ ] **Step 5: Let a conflict-only round request a fixer**

The `request_attempt` case in the same file gates `review_fixer` on threads and
pins the pull request head as the target. A conflict-only round has zero
threads and must target the merge commit. Replace that block:

```javascript
      if (role === 'review_fixer') {
        const round = goal.reviewRound;
        // A conflict is work even with no thread: the merge markers need resolving.
        requireValue(goal.status === 'addressing_review' && round?.state === 'fixing' && (round.threads.length > 0 || round.conflictPaths?.length), 'No review threads or conflicts await a fix', 'NOT_READY');
        requireValue(!goal.verificationRuns?.some((run) => run.workerState !== 'stopped'), 'Verification worker is not settled', 'NOT_READY');
        target = round.mergeCommitSha ?? round.prHeadSha;
      }
```

- [ ] **Step 6: Dispatch the fixer on threads or conflicts**

In `server/orchestration/domain/scheduling.mjs`, replace the `addressing_review` block:

```javascript
  if (goal.status === 'addressing_review') {
    const round = goal.reviewRound;
    if (round?.state === 'fixing' && (round.threads.length || round.conflictPaths?.length)
      && !goal.attempts.some((attempt) => attempt.role === 'review_fixer' && attempt.generation === goal.generation && attempt.revision === goal.revision)) {
      add('review_fixer', null, round.mergeCommitSha ?? round.prHeadSha);
    }
    return result;
  }
```

- [ ] **Step 7: Run the tests and the type check**

Run: `node --test tests/orchestration-review-fix.test.mjs && npx tsc --noEmit`
Then: `npm test` and `npx eslint server app --quiet`.
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add server/orchestration/domain/review-round.mjs server/orchestration/domain/transitions.mjs server/orchestration/domain/scheduling.mjs tests/orchestration-review-fix.test.mjs
git commit -m "feat: record the prepared review merge and dispatch the fixer on it

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Accept a fixer result on a merged round

**Files:**
- Modify: `server/orchestration/domain/transitions.mjs` (`accept_review_fix_result`)
- Modify: `server/orchestration/agent-results.mjs:74-90`
- Test: `tests/orchestration-review-fix.test.mjs`

Today the result must equal the pull request head when no reply is `fixed`. A merged round has a merge commit as its target, so the head must equal the merge commit when nothing was fixed, and differ from it when something was. The Git proof widens to the owned areas plus the recorded conflicted paths.

- [ ] **Step 1: Write the failing test**

Append to `tests/orchestration-review-fix.test.mjs`:

```javascript
test('a merged round validates the fix head against the merge commit', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  f.command('record_review_threads', { roundId, threads: threads(), mergeable: 'conflicting' });
  f.command('record_review_merge', { roundId, mergedBaseSha: BASE_HEAD, mergeCommitSha: MERGE_COMMIT, conflictPaths: ['src/a.mjs'] });
  f.request('fx', 'review_fixer'); f.dispatch('fx');
  fails(() => f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_B, summary: 's', replies: replies('comment') }), 'STALE_TARGET');
  f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 'Resolved', replies: replies('fixed') });
  assert.equal(f.goal.reviewRound.state, 'verifying');
  assert.equal(f.goal.reviewRound.fixHeadSha, HEAD_C);
});

test('a merged round with replies only keeps the merge commit as the fix head', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  f.command('record_review_threads', { roundId, threads: threads(), mergeable: 'conflicting' });
  f.command('record_review_merge', { roundId, mergedBaseSha: BASE_HEAD, mergeCommitSha: MERGE_COMMIT, conflictPaths: [] });
  f.request('fx', 'review_fixer'); f.dispatch('fx');
  f.command('accept_review_fix_result', { attemptId: 'fx', headSha: MERGE_COMMIT, summary: 'Answered only', replies: replies('comment') });
  assert.equal(f.goal.reviewRound.state, 'verifying', 'the merge itself still needs the approved checks');
  assert.equal(f.goal.reviewRound.fixHeadSha, MERGE_COMMIT);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/orchestration-review-fix.test.mjs`
Expected: FAIL, because the transition compares against `prHeadSha` only.

- [ ] **Step 3: Compare against the round's own target**

In `server/orchestration/domain/transitions.mjs`, replace the body of `case 'accept_review_fix_result':` from the `requireValue` on the round through the `if (fixed)` line:

```javascript
      const round = goal.reviewRound;
      const roundTarget = round?.mergeCommitSha ?? round?.prHeadSha;
      requireValue(goal.status === 'addressing_review' && round?.state === 'fixing' && round.attemptId === attempt.id && attempt.target === roundTarget, 'Review round target changed', 'STALE_TARGET');
      const headSha = sha(input.headSha), replies = parseReviewReplies(input.replies, round.threads);
      const fixed = replies.some((reply) => reply.action === 'fixed');
      requireValue(fixed ? headSha !== roundTarget : headSha === roundTarget, fixed ? 'A fix needs a new commit' : 'Replies without a fix must keep the recorded round head', 'STALE_TARGET');
      round.replies = replies; round.summary = text(input.summary, 8000);
      // A merged round verifies its merge commit even when the agent changed nothing.
      if (fixed || round.mergeCommitSha) { round.fixHeadSha = headSha; round.state = 'verifying'; } else round.state = 'replying';
```

- [ ] **Step 4: Widen the Git proof scope**

In `server/orchestration/agent-results.mjs`, replace the `review_fixer` proof block:

```javascript
        if (parsed.role === 'review_fixer') {
          requireValue(this.repositories, 'Repository evidence verification is unavailable', 'UNSUPPORTED_CAPABILITY');
          requireValue(this.service.repositoryIds.has(goal.repositoryId), 'Repository is no longer allowed', 'FORBIDDEN');
          const round = goal.reviewRound;
          requireValue(round && round.attemptId === attempt.id, 'Review round changed', 'STALE_TARGET');
          // A conflicted path is Companion's own merge output, so resolving it is
          // in scope even when the contract does not own that file.
          const ownedAreas = [...new Set([...currentContract(goal).tasks.flatMap((entry) => entry.ownedAreas), ...round.conflictPaths ?? []])];
          if (parsed.output.headSha !== (round.mergeCommitSha ?? round.prHeadSha)) {
            const proof = await this.repositories.candidate({ repositoryId: goal.repositoryId, attempt, headSha: parsed.output.headSha, ownedAreas });
            requireValue(proof.headSha === parsed.output.headSha, 'Git proof targets a different fix', 'STALE_TARGET');
            this.artifacts.get(proof.artifactId);
            requireValue(this.service.repositoryIds.has(goal.repositoryId), 'Repository is no longer allowed', 'FORBIDDEN');
          }
          this.service.execute({ id: this.id(), goalId: goal.id, expectedVersion: goal.version, type: 'accept_review_fix_result', payload: { attemptId: attempt.id, headSha: parsed.output.headSha, summary: parsed.output.summary, replies: parsed.output.replies } }, { kind: 'system' });
          const settled = this.store.get(goal.id);
          if (settled?.results?.find((entry) => entry.id === pending.id)?.status === 'pending') {
            this.service.execute({ id: this.id(), goalId: goal.id, expectedVersion: settled.version, type: 'mark_result_accepted', payload: { resultId: pending.id } }, { kind: 'system' });
          }
          continue;
        }
```

- [ ] **Step 5: Write the scope test**

The widened scope needs its own proof. Append to `tests/orchestration-review-fix.test.mjs`:

```javascript
test('the fixer scope is the owned areas plus the recorded conflicted paths', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  f.command('record_review_threads', { roundId, threads: threads(), mergeable: 'conflicting' });
  f.command('record_review_merge', { roundId, mergedBaseSha: BASE_HEAD, mergeCommitSha: MERGE_COMMIT, conflictPaths: ['package-lock.json'] });
  const round = f.goal.reviewRound;
  const owned = [...new Set([...contract().tasks.flatMap((task) => task.ownedAreas), ...round.conflictPaths])];
  assert.ok(owned.includes('package-lock.json'), 'a conflicted file outside the contract is still resolvable');
  assert.ok(owned.includes('src/a.mjs'), 'the contract owned areas stay in scope');
  assert.ok(!owned.includes('docs/readme.md'), 'no other path is admitted');
});
```

Import `contract` from the fixture at the top of the file if it is not already imported:

```javascript
import { fixture, contract, HEAD_B } from './helpers/orchestration/domain-fixture.mjs';
```

The rejection itself is enforced by `candidate()` in `server/orchestration/adapters/git.mjs`, which already raises `SCOPE_VIOLATION` for a path outside the list it is given. Task 11 proves it against a real repository.

- [ ] **Step 6: Run the backend tests and the type check**

Run: `node --test tests/orchestration-review-fix.test.mjs tests/orchestration-role-results.test.mjs && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add server/orchestration/domain/transitions.mjs server/orchestration/agent-results.mjs tests/orchestration-review-fix.test.mjs
git commit -m "feat: validate a merged round fix against its merge commit and conflicted paths

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Prepare the merge in Git

**Files:**
- Create: `server/orchestration/adapters/review-merge.mjs`
- Modify: `server/orchestration/types.d.ts` (`RepositoryPort`)
- Test: `tests/orchestration-review-merge.test.mjs` (create)

The adapter fetches the target branch, computes the merge with `git merge-tree --write-tree`, commits the tree with two parents, and pins it under `refs/companion/review-merges/<roundId>`. A repeat call for the same round observes the pinned ref instead of merging again.

**Verified Git behaviour** (probed against git 2.50.1; do not assume otherwise):

- Use `-z`, so a path containing a space or a newline stays unambiguous.
- A clean merge exits 0. The whole output is the tree SHA and one NUL byte.
- A conflicted merge exits 1. The output is the tree SHA, one NUL, then one
  record per conflicted stage entry, each `mode SP oid SP stage TAB path` and
  NUL-terminated. A file conflicting on all three stages appears three times,
  so the path list must be de-duplicated.
- The written tree carries the conflict markers inline as ordinary stage-0
  blobs. `git ls-tree` therefore shows **no** stage numbers; reading conflicts
  from the tree is impossible. The stdout record list is the only source.
- `git commit-tree` accepts a conflicted tree, and a worktree checked out at the
  resulting commit shows the markers in the file.

The existing `gitBytes(cwd, argv, input, allowConflict)` helper already takes a
fourth argument that tolerates exit 1; the integration path uses it for exactly
this call. Both `git` and `gitBytes` are exported from `./git.mjs`.

- [ ] **Step 1: Write the failing test**

Create `tests/orchestration-review-merge.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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

function adapter(repository, { targetHead, onFetch = () => {} }) {
  return new ReviewMerge({
    repositories: { async repository() { return { repository: repository.directory, common: join(repository.directory, '.git') }; } },
    remote: { async fetchBase() { onFetch(); return targetHead(); } },
  });
}

test('a clean merge produces one commit with the pull request head and the target head as parents', async (t) => {
  const repo = await repository(t);
  await git(repo.directory, ['checkout', 'main']);
  writeFileSync(join(repo.directory, 'shared.txt'), 'base plus unrelated\n');
  await git(repo.directory, ['commit', '-am', 'unrelated target change']);
  const targetHead = await git(repo.directory, ['rev-parse', 'main']);
  const merge = adapter(repo, { targetHead: () => targetHead });
  const prepared = await merge.prepareReviewMerge({ goalId: 'goal', repositoryId: 'repo', roundId: 'round1', prHeadSha: repo.prHead, baseBranch: 'main' });
  assert.equal(prepared.mergedBaseSha, targetHead);
  assert.deepEqual(prepared.conflictPaths, []);
  const parents = (await git(repo.directory, ['rev-list', '--parents', '-n', '1', prepared.mergeCommitSha])).split(' ').slice(1);
  assert.deepEqual(parents, [repo.prHead, targetHead]);
  assert.equal(await git(repo.directory, ['show', `${prepared.mergeCommitSha}:src/a.mjs`]), 'export const a = 2;');
  assert.equal(await git(repo.directory, ['show', `${prepared.mergeCommitSha}:shared.txt`]), 'base plus unrelated');
});

test('a conflicted merge still commits, and reports the conflicted paths from the written tree', async (t) => {
  const repo = await repository(t);
  await git(repo.directory, ['checkout', 'main']);
  writeFileSync(join(repo.directory, 'src', 'a.mjs'), 'export const a = 3;\n');
  await git(repo.directory, ['commit', '-am', 'conflicting target change']);
  const targetHead = await git(repo.directory, ['rev-parse', 'main']);
  const merge = adapter(repo, { targetHead: () => targetHead });
  const prepared = await merge.prepareReviewMerge({ goalId: 'goal', repositoryId: 'repo', roundId: 'round1', prHeadSha: repo.prHead, baseBranch: 'main' });
  assert.deepEqual(prepared.conflictPaths, ['src/a.mjs']);
  const parents = (await git(repo.directory, ['rev-list', '--parents', '-n', '1', prepared.mergeCommitSha])).split(' ').slice(1);
  assert.deepEqual(parents, [repo.prHead, targetHead]);
  assert.match(await git(repo.directory, ['show', `${prepared.mergeCommitSha}:src/a.mjs`]), /<<<<<<</);
});

test('a repeated call for the same round observes the pinned merge instead of merging again', async (t) => {
  const repo = await repository(t);
  await git(repo.directory, ['checkout', 'main']);
  writeFileSync(join(repo.directory, 'shared.txt'), 'moved\n');
  await git(repo.directory, ['commit', '-am', 'target change']);
  let head = await git(repo.directory, ['rev-parse', 'main']);
  let fetches = 0;
  const merge = adapter(repo, { targetHead: () => head, onFetch: () => { fetches++; } });
  const first = await merge.prepareReviewMerge({ goalId: 'goal', repositoryId: 'repo', roundId: 'round1', prHeadSha: repo.prHead, baseBranch: 'main' });
  writeFileSync(join(repo.directory, 'shared.txt'), 'moved again\n');
  await git(repo.directory, ['commit', '-am', 'later target change']);
  head = await git(repo.directory, ['rev-parse', 'main']);
  const second = await merge.prepareReviewMerge({ goalId: 'goal', repositoryId: 'repo', roundId: 'round1', prHeadSha: repo.prHead, baseBranch: 'main' });
  assert.deepEqual(second, first, 'a later target move never rewrites a recorded merge');
  assert.equal(fetches, 1);
});

test('a merge for another pull request head is refused rather than silently re-merged', async (t) => {
  const repo = await repository(t);
  const targetHead = await git(repo.directory, ['rev-parse', 'main']);
  const merge = adapter(repo, { targetHead: () => targetHead });
  await merge.prepareReviewMerge({ goalId: 'goal', repositoryId: 'repo', roundId: 'round1', prHeadSha: repo.prHead, baseBranch: 'main' });
  await assert.rejects(merge.prepareReviewMerge({ goalId: 'goal', repositoryId: 'repo', roundId: 'round1', prHeadSha: repo.baseSha, baseBranch: 'main' }), { code: 'IDEMPOTENCY_CONFLICT' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/orchestration-review-merge.test.mjs`
Expected: FAIL, because `server/orchestration/adapters/review-merge.mjs` does not exist.

- [ ] **Step 3: Write the adapter**

Create `server/orchestration/adapters/review-merge.mjs`:

```javascript
import { identifier, requireValue, sha } from '../domain/contracts.mjs';
import { git, gitBytes } from './git.mjs';

/** Companion's own merge of the target branch into the pull request branch.
 * The merge is committed whether or not it conflicts: a conflicted tree carries
 * the markers for the fixer to resolve, exactly as an integration conflict does.
 * One merge per round is pinned under an owned ref, so a retry after a crash
 * never merges a target that has moved in the meantime.
 */
export class ReviewMerge {
  /** @param {{ repositories: { repository(repositoryId: string): Promise<{ repository: string; common: string }> }; remote: Pick<import('../types.d.ts').RemotePort, 'fetchBase'> & { fetchBase(repositoryId: string, branch: string): Promise<string> } }} options */
  constructor({ repositories, remote }) { this.repositories = repositories; this.remote = remote; }
  /** @param {string} roundId */
  ref(roundId) { return `refs/companion/review-merges/${identifier(roundId)}`; }
  /** @param {string} repository @param {string} name */
  async read(repository, name) {
    try { return (await git(repository, ['rev-parse', '--verify', '--quiet', name])).trim(); }
    catch (error) { if (/** @type {{exitCode?: unknown}} */ (error).exitCode === 1) return null; throw error; }
  }
  /** Parse `merge-tree -z` output: the tree SHA, then one NUL-terminated
   * `mode SP oid SP stage TAB path` record per conflicted stage entry. The
   * written tree holds stage-0 blobs with markers inline, so this list is the
   * only record of which paths Git could not resolve.
   * @param {Buffer} output @returns {{ treeSha: string; conflictPaths: string[] }} */
  parse(output) {
    const records = output.toString('utf8').split('\0');
    const treeSha = sha(records[0].trim());
    /** @type {string[]} */ const conflictPaths = [];
    for (const record of records.slice(1)) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      if (tab === -1) continue;
      const path = record.slice(tab + 1);
      if (path && !conflictPaths.includes(path)) conflictPaths.push(path);
    }
    return { treeSha, conflictPaths };
  }
  /** The port method name matches the coordinator's call, so the adapter drops
   * straight into the repository port without a wrapper.
   * @param {{ goalId: string; repositoryId: string; roundId: string; prHeadSha: string; baseBranch: string }} input
   * @returns {Promise<{ mergedBaseSha: string; mergeCommitSha: string; conflictPaths: string[] }>} */
  async prepareReviewMerge(input) {
    identifier(input.goalId); identifier(input.repositoryId); sha(input.prHeadSha);
    const { repository } = await this.repositories.repository(input.repositoryId);
    const ref = this.ref(input.roundId);
    const recorded = await this.read(repository, ref);
    if (recorded) return this.observe(repository, ref, recorded, input);
    const mergedBaseSha = sha(await this.remote.fetchBase(input.repositoryId, input.baseBranch));
    requireValue(mergedBaseSha !== input.prHeadSha, 'The target branch head equals the pull request head', 'STALE_TARGET');
    await git(repository, ['cat-file', '-e', `${input.prHeadSha}^{commit}`]);
    // allowConflict: a conflicted merge exits 1 and still writes a valid tree.
    const { treeSha, conflictPaths } = this.parse(await gitBytes(repository,
      ['merge-tree', '--write-tree', '--no-messages', '-z', input.prHeadSha, mergedBaseSha], undefined, true));
    const message = `Merge ${input.baseBranch} into the pull request branch for review round ${input.roundId}\n`;
    const commit = sha((await git(repository, ['-c', 'user.name=Companion', '-c', 'user.email=companion@example.invalid',
      'commit-tree', treeSha, '-p', input.prHeadSha, '-p', mergedBaseSha], message)).trim());
    // The ref is the durable record. A crash after this point replays the same
    // merge; a target that moved afterwards never rewrites it. A lost race is
    // resolved by reading whichever commit the ref actually holds.
    try { await git(repository, ['update-ref', ref, commit, '0'.repeat(40)]); }
    catch { const raced = await this.read(repository, ref); requireValue(raced, 'Review merge ref could not be reserved', 'OWNERSHIP_UNCERTAIN'); return this.observe(repository, ref, raced, input); }
    return { mergedBaseSha, mergeCommitSha: commit, conflictPaths };
  }
  /** Re-derive a recorded merge from Git alone, so a replay never re-merges a
   * target that moved since.
   * @param {string} repository @param {string} ref @param {string} recorded
   * @param {{ prHeadSha: string }} input */
  async observe(repository, ref, recorded, input) {
    const parents = (await git(repository, ['rev-list', '--parents', '-n', '1', recorded])).trim().split(' ').slice(1);
    requireValue(parents.length === 2 && parents[0] === input.prHeadSha, 'A review merge is recorded for another pull request head', 'IDEMPOTENCY_CONFLICT');
    // Recompute against the same two parents: identical inputs, identical tree.
    const { conflictPaths } = this.parse(await gitBytes(repository,
      ['merge-tree', '--write-tree', '--no-messages', '-z', parents[0], parents[1]], undefined, true));
    return { mergedBaseSha: sha(parents[1]), mergeCommitSha: sha(recorded), conflictPaths };
  }
}
```

- [ ] **Step 4: Confirm the helper signature**

Run: `grep -n "export async function gitBytes\|export async function git" server/orchestration/adapters/git.mjs`
Expected: `gitBytes(cwd, argv, input, allowConflict = false)` at line 21 and `git(cwd, argv, input)` at line 117. Both are already exported. If the fourth `gitBytes` argument is named differently, use whatever that file actually declares.

- [ ] **Step 5: Declare the port method**

In `server/orchestration/types.d.ts`, add to `RepositoryPort`:

```typescript
  prepareReviewMerge?(input: { goalId: string; repositoryId: string; roundId: string; prHeadSha: string; baseBranch: string }): Promise<{ mergedBaseSha: string; mergeCommitSha: string; conflictPaths: string[] }>;
```

- [ ] **Step 6: Run the tests and the type check**

Run: `node --test tests/orchestration-review-merge.test.mjs && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add server/orchestration/adapters/review-merge.mjs server/orchestration/types.d.ts tests/orchestration-review-merge.test.mjs
git commit -m "feat: commit the target branch merge for a review round

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Drive the merge from the coordinator

**Files:**
- Modify: `server/orchestration/review-fix-coordinator.mjs`
- Modify: `server/orchestration/scheduler.mjs:30` (the coordinator is built here, not in `production.mjs`)
- Modify: `server/orchestration/create-runtime.mjs:32, 45, 70`
- Modify: `server/orchestration/production.mjs:78-82`
- Test: `tests/orchestration-review-fix.test.mjs`

**Naming:** `Scheduler` already owns `this.merges`, the `MergeCoordinator`. The
review merge port is therefore called `reviewMerges` everywhere, so the two
never read as the same thing.

The coordinator gains one branch for the `merging` state. It calls `prepareReviewMerge` under the ownership fence, then records the result. A missing method is a configuration fault, as every other capability is.

- [ ] **Step 1: Write the failing test**

Append to `tests/orchestration-review-fix.test.mjs`. `coordinatorFixture` is defined near the end of this file; extend its `publisher` object and add a `merges` port in the same call shape the coordinator uses.

```javascript
test('the coordinator prepares the merge and records it', async (t) => {
  const c = coordinatorFixture(t);
  c.publisher.threads = [];
  c.publisher.mergeable = 'conflicting';
  const prepared = [];
  c.coordinator.reviewMerges = { async prepareReviewMerge(input) { prepared.push(input); return { mergedBaseSha: 'f'.repeat(40), mergeCommitSha: 'e'.repeat(40), conflictPaths: ['src/a.mjs'] }; } };
  c.send('request_review_fix', {}, 'user');
  await c.coordinator.run(); await settle(c.coordinator);
  assert.equal(c.store.get('goal').reviewRound.state, 'merging');
  await c.coordinator.run(); await settle(c.coordinator);
  const round = c.store.get('goal').reviewRound;
  assert.equal(round.state, 'fixing');
  assert.equal(round.mergeCommitSha, 'e'.repeat(40));
  assert.deepEqual(round.conflictPaths, ['src/a.mjs']);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].prHeadSha, round.prHeadSha);
});

test('a missing merge capability fails the round instead of waiting for a retry', async (t) => {
  const c = coordinatorFixture(t);
  c.publisher.threads = [];
  c.publisher.mergeable = 'conflicting';
  c.coordinator.reviewMerges = {};
  c.send('request_review_fix', {}, 'user');
  await c.coordinator.run(); await settle(c.coordinator);
  await c.coordinator.run(); await settle(c.coordinator);
  const round = c.store.get('goal').reviewRound;
  assert.equal(round.state, 'failed');
  assert.match(round.error, /UNSUPPORTED_CAPABILITY/);
});
```

In the same file, update `coordinatorFixture` so its `publisher.reviewThreads` returns the new shape:

```javascript
    threads: threads(), mergeable: 'mergeable', threadsError: null, pushResult: 'pushed', replyOutcome: { posted: ['PRRT_1', 'PRRT_2'], unconfirmed: [], resolved: ['PRRT_1'] },
    async reviewThreads() { calls.threads++; if (publisher.threadsError) throw publisher.threadsError; return { threads: publisher.threads, mergeable: publisher.mergeable }; },
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/orchestration-review-fix.test.mjs`
Expected: FAIL, because the round stays in `merging`.

- [ ] **Step 3: Accept the merge port in the coordinator**

In `server/orchestration/review-fix-coordinator.mjs`, replace the constructor signature and its first assignment line:

```javascript
  /** @param {{ service: import('./service.mjs').OrchestrationService; publisher: import('./types.d.ts').PublicationPort; reviewMerges?: Pick<import('./types.d.ts').RepositoryPort, 'prepareReviewMerge'>; ownership: { assertOwned(): void }; now?: () => number; id?: () => string; onError?: (error: unknown) => void }} options */
  constructor({ service, publisher, reviewMerges, ownership, now = Date.now, id = randomUUID, onError = () => {} }) {
    this.service = service; this.store = service.store; this.agents = service.agents; this.publisher = publisher; this.reviewMerges = reviewMerges; this.ownership = ownership;
```

- [ ] **Step 4: Record the verdict and drive the merge**

In the same file, replace the recording line inside the `fetching` branch:

```javascript
          if (this.current(goal.id, round.id)) this.record(goal.id, 'record_review_threads', { roundId: round.id, threads: threads.threads, mergeable: threads.mergeable, at: this.now() });
```

Then add a branch immediately after the closing brace of the `fetching` branch, before `else if (round.state === 'verifying' && !round.verificationOperationId)`:

```javascript
      } else if (round.state === 'merging') {
        this.spawn(goal, async (round, plan, pr) => {
          requireValue(this.reviewMerges?.prepareReviewMerge, 'Review merges are unavailable in this configuration', 'UNSUPPORTED_CAPABILITY');
          const prepared = await this.reviewMerges.prepareReviewMerge({ goalId: goal.id, repositoryId: goal.repositoryId, roundId: round.id, prHeadSha: round.prHeadSha, baseBranch: goal.baseBranch });
          if (this.stopped) return;
          this.ownership.assertOwned();
          if (this.current(goal.id, round.id)) this.record(goal.id, 'record_review_merge', { roundId: round.id, ...prepared });
        });
```

Also replace the `UNSUPPORTED_CAPABILITY` message branch inside `spawn` so a merge fault reads correctly; it already handles that code with a generic sentence, so no change is needed there.

- [ ] **Step 5: Compose the adapter through the runtime factory**

`ReviewMerge` needs a remote, and only the production layer knows the remote
destinations. It therefore follows the existing `createPublisher` pattern: the
runtime takes a factory, and production supplies it. Three files change.

**`server/orchestration/scheduler.mjs`.** Accept the port and pass it on.
Add `reviewMerges` to the destructured options and to the options JSDoc:

```javascript
  constructor({ service, repositories, integrations, verifier, publisher, reviewMerges, results, ownership = new SchedulerOwnership({ store: service.store }), id = randomUUID, intervalMs = 2500, planReviewEnabled = () => true, prepareGoal, onError = () => {} }) {
```

In the same options JSDoc type, add after the `publisher` entry:

```
reviewMerges?: Pick<import('./types.d.ts').RepositoryPort, 'prepareReviewMerge'>;
```

Then replace line 30:

```javascript
    this.reviewFixes = publisher ? new ReviewFixCoordinator({ service, publisher, reviewMerges, ownership, id, onError }) : null;
```

**`server/orchestration/create-runtime.mjs`.** Add an optional factory beside
`createPublisher`. In the options JSDoc, after the `createPublisher` line:

```
 * createReviewMerge?: (context: { repositories: GitRepository }) => Pick<import('./types.d.ts').RepositoryPort, 'prepareReviewMerge'>;
```

Add `createReviewMerge` to the destructured parameter list on the
`export async function createRuntime({ ... })` line, then pass it to the
scheduler on line 70 by adding this option to the existing `new Scheduler({...})`
call:

```javascript
      reviewMerges: createReviewMerge ? createReviewMerge({ repositories }) : undefined,
```

**`server/orchestration/production.mjs`.** Import the adapter:

```javascript
import { ReviewMerge } from './adapters/review-merge.mjs';
```

Then add a `createReviewMerge` factory beside the existing `createPublisher`
one, reusing the same remote construction that `createPublisher` already uses:

```javascript
      createReviewMerge: ({ repositories }) => new ReviewMerge({ repositories,
        remote: new GitRemote({ repositories, directory: join(config.storage.resources, 'remote-stage'), destinations: new Map(config.repositories.map(repo => [repo.id, repo.remote])) }) }),
```

Read each of the three call sites before editing. Keep every existing option in
place; add, never replace.

- [ ] **Step 6: Run the tests, the type check and the lint**

Run: `node --test tests/orchestration-review-fix.test.mjs && npx tsc --noEmit && npx eslint server app --quiet`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add server/orchestration/review-fix-coordinator.mjs server/orchestration/production.mjs tests/orchestration-review-fix.test.mjs
git commit -m "feat: prepare the review round merge from the coordinator

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Tell the fixer about the merge

**Files:**
- Modify: `server/orchestration/adapters/role-prompts.mjs:21-22, 40, 51-56`
- Test: `tests/orchestration-role-results.test.mjs`

The agent needs the conflicted paths and the merged target head in its pinned context, plus an instruction that names the conflict work. It still never merges, fetches or pushes.

- [ ] **Step 1: Write the failing test**

Append to `tests/orchestration-role-results.test.mjs`:

```javascript
test('a review fixer on a merged round sees the conflicted paths and the merged target', async () => {
  const { rolePrompt } = await import('../server/orchestration/adapters/role-prompts.mjs');
  const { fixture } = await import('./helpers/orchestration/domain-fixture.mjs');
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  f.command('record_review_threads', { roundId, threads: [], mergeable: 'conflicting' });
  f.command('record_review_merge', { roundId, mergedBaseSha: 'f'.repeat(40), mergeCommitSha: 'e'.repeat(40), conflictPaths: ['src/a.mjs'] });
  f.request('fx', 'review_fixer');
  const prompt = rolePrompt(f.goal, f.goal.attempts.at(-1));
  assert.match(prompt, /conflict/i);
  assert.match(prompt, /src\/a\.mjs/);
  assert.match(prompt, /f{40}/);
  assert.doesNotMatch(prompt, /git merge|git fetch/i, 'the agent never merges or fetches by itself');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/orchestration-role-results.test.mjs`
Expected: FAIL, because the prompt has no conflict text.

- [ ] **Step 3: Pin the merge state in the context**

In `server/orchestration/adapters/role-prompts.mjs`, replace the two `review_fixer` context lines:

```javascript
    reviewThreads: attempt.role === 'review_fixer' ? goal.reviewRound?.threads ?? [] : [],
    prHeadSha: attempt.role === 'review_fixer' ? goal.reviewRound?.prHeadSha ?? null : null,
    reviewMerge: attempt.role === 'review_fixer' && goal.reviewRound?.mergeCommitSha
      ? { mergedBaseSha: goal.reviewRound.mergedBaseSha ?? null, mergeCommitSha: goal.reviewRound.mergeCommitSha, conflictPaths: goal.reviewRound.conflictPaths ?? [] }
      : null,
```

- [ ] **Step 4: Extend the role instruction**

In the same file, replace the `review_fixer` instruction string:

```javascript
    review_fixer: 'Address the pinned pull request review threads inside the approved contract scope. For each thread decide: fixed (change the code and commit), declined (explain briefly why not), or comment (answer a question). Write each reply body as a short professional pull request comment. When reviewMerge is present, your worktree already contains Companion\'s merge of the target branch: resolve every conflict marker in its conflictPaths, and change no other file the merge brought in. Never merge, never fetch, never push, never resolve threads, and never change files outside the contract owned areas or the pinned conflictPaths. Commit with companion.commit_candidate when you change code and report the resulting headSha. If you change nothing, report the recorded target head from your pinned context as headSha. Provide exactly one reply per thread.',
```

- [ ] **Step 5: Run the tests and the type check**

Run: `node --test tests/orchestration-role-results.test.mjs && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add server/orchestration/adapters/role-prompts.mjs tests/orchestration-role-results.test.mjs
git commit -m "feat: pin the review merge state in the fixer prompt

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Start one automatic round on an observed conflict

**Files:**
- Modify: `server/orchestration/domain/transitions.mjs` (`record_merge_sync`, `request_review_fix`)
- Modify: `server/orchestration/types.d.ts` (`Goal.mergeSync`)
- Modify: `server/orchestration/merge-coordinator.mjs`
- Test: `tests/orchestration-merge-sync.test.mjs`, `tests/orchestration-review-fix.test.mjs`

`record_merge_sync` records the verdict. `request_review_fix` accepts system authority when the payload carries `trigger: 'conflict'` and the recorded verdict is `conflicting`. The goal records the pair of heads the automatic round covered, so one observation never starts two rounds.

- [ ] **Step 1: Write the failing domain test**

Append to `tests/orchestration-review-fix.test.mjs`:

```javascript
test('a conflicting observation admits exactly one automatic round per observed head pair', () => {
  const f = fixture(); f.deliver();
  fails(() => f.command('request_review_fix', { trigger: 'conflict' }), 'NOT_READY');
  f.command('record_merge_sync', { number: 1, url: 'https://example.test/pr/1', state: 'open', mergeable: 'conflicting', checkedAt: 5 });
  assert.equal(f.goal.mergeSync.mergeable, 'conflicting');
  f.command('request_review_fix', { trigger: 'conflict' });
  assert.equal(f.goal.status, 'addressing_review');
  assert.equal(f.goal.reviewRound.trigger, 'conflict');
  f.command('record_review_threads', { roundId: f.goal.reviewRound.id, threads: [], mergeable: 'mergeable' });
  assert.equal(f.goal.status, 'delivered');
  f.command('record_merge_sync', { number: 1, url: 'https://example.test/pr/1', state: 'open', mergeable: 'conflicting', checkedAt: 6 });
  fails(() => f.command('request_review_fix', { trigger: 'conflict' }), 'NOT_READY');
  assert.equal(f.goal.status, 'delivered', 'the same observed head pair never starts a second automatic round');
  f.command('request_review_fix', {}, f.user);
  assert.equal(f.goal.reviewRound.trigger, 'user', 'the user may still press the button');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/orchestration-review-fix.test.mjs`
Expected: FAIL with "user authority required".

- [ ] **Step 3: Record the verdict in the merge sync**

In `server/orchestration/domain/transitions.mjs`, inside `case 'record_merge_sync':`, replace the `goal.mergeSync` assignment:

```javascript
      requireValue(input.mergeable === undefined || ['mergeable', 'conflicting', 'unknown'].includes(String(input.mergeable)), 'Invalid mergeable verdict');
      goal.mergeSync = { checkedAt, state, error: state === 'unknown' ? 'GitHub sync unavailable. Will retry on the next scheduled check.' : null,
        ...(input.mergeable === undefined ? {} : { mergeable: /** @type {import('../types.d.ts').MergeableVerdict} */ (input.mergeable) }) };
```

- [ ] **Step 4: Admit the automatic trigger**

In the same file, replace the head of `case 'request_review_fix':`:

```javascript
    case 'request_review_fix': {
      const automatic = input.trigger === 'conflict';
      if (!automatic) requireAuthority(authority, 'user'); else requireAuthority(authority, 'system');
      requireValue(goal.status === 'delivered' && goal.pr && goal.publication, 'Only a delivered goal with a pull request can address review comments', 'NOT_READY');
      requireValue(goal.mergeSync?.state !== 'closed', 'The pull request is closed on GitHub', 'NOT_READY');
      requireValue(!goal.reviewRound, 'A review round is already active', 'NOT_READY');
      requireValue(!goal.attempts.some(ownsWorker) && !goal.verificationRuns?.some((run) => run.workerState !== 'stopped') && !goal.results?.some((result) => result.status === 'pending'), 'Workers still active', 'NOT_READY');
      // One automatic round per pull request head. A push moves that head, so a
      // conflict that survives a round needs a press, never an endless retry.
      if (automatic) {
        requireValue(goal.mergeSync?.mergeable === 'conflicting', 'No observed merge conflict', 'NOT_READY');
        requireValue(goal.conflictRoundKey !== goal.pr.headSha, 'This conflict already started a round', 'NOT_READY');
        goal.conflictRoundKey = goal.pr.headSha;
      }
      goal.generation++;
      goal.reviewRound = { id: command.id, prHeadSha: goal.pr.headSha, startedAt: integer(input.startedAt ?? 0), state: 'fetching', threads: [], trigger: automatic ? 'conflict' : 'user' };
      goal.status = 'addressing_review';
      emit('review_fix_requested', { roundId: command.id, prHeadSha: goal.pr.headSha, trigger: automatic ? 'conflict' : 'user' }); break;
    }
```

- [ ] **Step 5: Extend the goal type**

In `server/orchestration/types.d.ts`, inside `interface Goal`, replace the `mergeSync` line and add the key:

```typescript
  mergeSync?: { checkedAt: number; state: 'open' | 'closed' | 'merged' | 'unknown'; error: string | null; mergeable?: MergeableVerdict } | null;
  conflictRoundKey?: string;
```

Run `grep -n "mergeSync" server/orchestration/types.d.ts` first and keep whatever optionality that line already declares.

- [ ] **Step 6: Write the failing coordinator test**

Append to `tests/orchestration-merge-sync.test.mjs`:

```javascript
test('an observed conflict starts one automatic review round', async t => {
  const store = new OrchestrationStore({ path: ':memory:' }); t.after(() => store.close()); seed(store, 'a');
  let now = 1000;
  const coordinator = new MergeCoordinator({ service: service(store), ownership: { assertOwned() {} }, now: () => now, id: () => `auto${now}`,
    publisher: { async observeMerge(plan, pr) { return { ...pr, state: 'open', mergeable: 'conflicting' }; } } });
  coordinator.run(); await settle(coordinator);
  assert.equal(store.get('a').status, 'addressing_review');
  assert.equal(store.get('a').reviewRound.trigger, 'conflict');
});
```

- [ ] **Step 7: Start the round from the merge coordinator**

In `server/orchestration/merge-coordinator.mjs`, replace the `this.service.execute` line at the end of the job with:

```javascript
        this.service.execute({ id: this.id(), goalId: goal.id, expectedVersion: latest.version, type: 'record_merge_sync', payload: { number: pr.number, url: pr.url, state, mergeable, checkedAt: this.now() } }, { kind: 'system' });
        const observed = this.service.store.get(goal.id);
        // A conflicted pull request cannot merge, so the round is started here
        // rather than waiting for a press. A refusal is the expected outcome
        // once one round already covered this head.
        if (observed?.status === 'delivered' && observed.mergeSync?.mergeable === 'conflicting') {
          try { this.service.execute({ id: this.id(), goalId: goal.id, expectedVersion: observed.version, type: 'request_review_fix', payload: { trigger: 'conflict', startedAt: this.now() } }, { kind: 'system' }); }
          catch { /* A refusal is normal: another round is active, or this head already had one. */ }
        }
```

Declare `mergeable` beside `state` at the top of the same job and assign it from the observation:

```javascript
        /** @type {'open'|'closed'|'merged'|'unknown'} */ let state = 'unknown';
        /** @type {import('./types.d.ts').MergeableVerdict | undefined} */ let mergeable;
        try {
          const observation = await this.publisher.observeMerge?.(plan, pr);
          requireValue(observation?.number === pr.number && observation.url === pr.url, 'PR identity changed');
          state = observation.state; mergeable = observation.mergeable;
        } catch { /* Persist a sanitized error; never expose CLI output or credentials. */ }
```

- [ ] **Step 8: Run the tests, the type check and the lint**

Run: `node --test tests/orchestration-merge-sync.test.mjs tests/orchestration-review-fix.test.mjs && npx tsc --noEmit && npx eslint server app --quiet`
Expected: PASS, no errors.

- [ ] **Step 9: Commit**

```bash
git add server/orchestration/domain/transitions.mjs server/orchestration/types.d.ts server/orchestration/merge-coordinator.mjs tests/orchestration-merge-sync.test.mjs tests/orchestration-review-fix.test.mjs
git commit -m "feat: start one review round per observed merge conflict

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Project and render the merge state

**Files:**
- Modify: `app/orchestration/goal-detail.tsx:56-62`
- Modify: `app/orchestration/attention.ts:8`
- Test: `tests/ui-orchestration.test.tsx`

`goalView` already spreads the whole round, so the new fields reach the browser without a projection change. Confirm that before editing.

- [ ] **Step 1: Confirm the projection**

Run: `grep -n "reviewRound" server/orchestration/domain/state-view.mjs`
Expected: the line spreads `...goal.reviewRound`. If it lists fields explicitly instead, add `trigger`, `mergeable`, `mergedBaseSha`, `mergeCommitSha` and `conflictPaths` to that list.

- [ ] **Step 2: Write the failing UI test**

Append to `tests/ui-orchestration.test.tsx`, following the render helper that file already uses:

```tsx
test('a merged review round shows its conflicts and its trigger', () => {
  const goal = goalFixture({
    status: 'addressing_review',
    reviewRound: { id: 'r1', prHeadSha: 'a'.repeat(40), startedAt: 1, state: 'fixing', phase: 'Fixing 0 threads and 2 conflicts',
      trigger: 'conflict', mergeable: 'conflicting', mergedBaseSha: 'f'.repeat(40), mergeCommitSha: 'e'.repeat(40),
      conflictPaths: ['src/a.mjs', 'package-lock.json'], threads: [] },
    reviewRounds: [],
  });
  render(<GoalDetail goal={goal} />);
  expect(screen.getByLabelText('Review round phase').textContent).toContain('Fixing 0 threads and 2 conflicts');
  fireEvent.click(screen.getByRole('tab', { name: 'Run report' }));
  expect(screen.getByText(/Started automatically/)).toBeTruthy();
  expect(screen.getByText(/src\/a\.mjs/)).toBeTruthy();
  expect(screen.getByText(/package-lock\.json/)).toBeTruthy();
});
```

Read the top of `tests/ui-orchestration.test.tsx` first and match its existing fixture helper, render helper and import names exactly; the names above are placeholders for whatever that file already defines.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/ui-orchestration.test.tsx`
Expected: FAIL, because the conflict text is absent.

- [ ] **Step 4: Render the merge evidence**

In `app/orchestration/goal-detail.tsx`, replace the round card's `<p>` line:

```tsx
      <p>Started {new Date(round.startedAt).toLocaleString()}{round.trigger === 'conflict' ? ' · Started automatically by an observed merge conflict' : ''}{round.error ? ` · ${round.error}` : ''}</p>
      {round.mergeCommitSha && <p>Merged target <code>{round.mergedBaseSha?.slice(0, 12)}</code>{round.conflictPaths?.length ? ` · resolved ${round.conflictPaths.length} ${round.conflictPaths.length === 1 ? 'conflict' : 'conflicts'}: ${round.conflictPaths.join(', ')}` : ' · no conflicts'}</p>}
```

- [ ] **Step 5: Report a conflict that has no round**

In `app/orchestration/attention.ts`, add after the existing `closed` line:

```typescript
  if (goal.status === 'delivered' && goal.mergeSync?.mergeable === 'conflicting') return 'The PR conflicts with its target branch. A round starts automatically at the next merge check.';
```

- [ ] **Step 6: Run the UI tests and the type check**

Run: `npx vitest run tests/ui-orchestration.test.tsx tests/ui-mission-control.test.tsx && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add app/orchestration/goal-detail.tsx app/orchestration/attention.ts tests/ui-orchestration.test.tsx
git commit -m "feat: show the review round merge evidence and its automatic trigger

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Prove one conflicted round end to end

**Files:**
- Modify: `tests/orchestration-review-fix.test.mjs` or the closest service-level suite
- Test: `cypress/e2e/orchestration-core.cy.ts`

A service-level test against a disposable Git repository is the proof that the merge, the proof widening and the verification agree. Read `tests/helpers/orchestration/fixture.mjs` first: it builds the disposable repository and fake adapters the other service tests use.

- [ ] **Step 1: Write the failing service test**

Add to the service-level suite that uses `tests/helpers/orchestration/fixture.mjs`. Build a goal delivered with a pull request, move the target branch so it conflicts, run one round, and assert the pushed head.

```javascript
test('a conflicted pull request is merged, resolved, verified and pushed in one round', async (t) => {
  const harness = await serviceFixture(t);
  await harness.deliverGoal();
  await harness.moveTargetBranch({ path: 'src/a.mjs', content: 'export const a = 3;\n' });
  harness.github.setMergeable(harness.pr.number, 'conflicting');
  await harness.runMergePoll();
  assert.equal(harness.goal().status, 'addressing_review');
  assert.equal(harness.goal().reviewRound.trigger, 'conflict');
  await harness.runReviewRound({ resolve: 'export const a = 3;\n' });
  const goal = harness.goal();
  assert.equal(goal.status, 'delivered');
  assert.notEqual(goal.pr.headSha, harness.pr.headSha, 'the pull request advanced to the merged head');
  assert.equal(await harness.remoteHead(), goal.pr.headSha);
  assert.equal(goal.reviewRounds.at(-1).outcome, 'addressed');
});
```

The helper names above do not exist yet. Read the existing service fixture and use its real API; add only the smallest helper the test needs, next to the helpers already there.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/<the suite you extended>.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Make it pass**

Compose `ReviewMerge` into the test harness the same way Task 7 composed it into production. Add the `mergeable` setter to `tests/helpers/orchestration/fake-github.mjs`:

```javascript
  setMergeable(number, mergeable) {
    const pr = this.pulls.find(pr => pr.number === number);
    if (!pr) throw new Error('PR not found');
    pr.mergeable = mergeable;
  }
```

- [ ] **Step 4: Run the full backend suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Add the Cypress coverage**

In `cypress/e2e/orchestration-core.cy.ts`, extend the existing review round spec so it drives a conflicted round against the disposable backend. Follow the spec's existing setup exactly; it already runs a real backend with fake external adapters.

- [ ] **Step 6: Run the browser check**

Run: `npm run test:e2e:local`
Expected: PASS. If Electron fails, run `CMUX_COMPANION_CYPRESS_BROWSER=chrome npm run test:e2e:local`.

- [ ] **Step 7: Commit**

```bash
git add tests cypress
git commit -m "test: prove one conflicted review round end to end

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Full verification and documentation

**Files:**
- Modify: `README.md` if it documents the review round behaviour
- Modify: `docs/orchestration-development.md` if it lists the round states

- [ ] **Step 1: Check whether the docs describe the round**

Run: `grep -rn "Address review comments\|review round" README.md docs/*.md`
Expected: a list of files to update, or nothing.

- [ ] **Step 2: Update what that search found**

Describe the conflict behaviour in one or two sentences per location: a round also merges the target branch when GitHub reports a conflict, and one round starts automatically per observed conflict.

- [ ] **Step 3: Run the full verification**

Run: `npm run verify`
Expected: PASS. It runs backend and UI coverage, lint, types and build. Both coverage gates require 90% line coverage.

- [ ] **Step 4: Commit**

```bash
git add README.md docs
git commit -m "docs: describe the review round conflict behaviour

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Open the pull request**

```bash
git push -u origin feat/review-round-merge-conflicts
gh pr create --draft --title "Resolve merge conflicts in a review round" --body "$(cat <<'BODY'
## What

A review round now reads GitHub's mergeable verdict with the review threads.
A conflicting or uncomputed verdict makes Companion merge the target branch
into the pull request branch, let the fixer resolve what Git could not, verify
the merged head with the approved checks, and push. The merge poll starts one
round per observed conflict without a press.

## Spec

`docs/superpowers/specs/2026-09-22-review-round-merge-conflicts-design.md`.
It supersedes two non-goals in the earlier review round spec, amended in its
own commit.

## Verification

Record here which checks passed, which failed and which were not run.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

Do not mark the pull request ready until every check in Task 12 passed. Do not merge.

---

## Notes for the implementer

**Read before editing.** Several of these files are long single-line-dense modules. Re-read the exact region before each edit; a stale `old_string` fails silently in some tools.

**Grep before renaming.** `reviewRound`, `prHeadSha` and `record_review_threads` appear in the domain, the coordinator, the adapters, the projection, the UI and the tests. Search for each name separately across `server/`, `app/`, `tests/` and `cypress/`.

**Argv only.** Every Git and `gh` call passes an argument array. Never build a shell string.

**One commit per task.** Do not carry unrelated working-tree changes into a task commit.
