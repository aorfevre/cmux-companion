# Address Review Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A delivered goal offers `Address review comments`. One press fetches unresolved PR review threads, runs one fixer agent, verifies the fix, pushes to the PR branch, replies to every thread and returns the goal to `delivered`.

**Architecture:** The pure domain in `server/orchestration/domain/transitions.mjs` gains status `addressing_review`, a `reviewRound` aggregate and role `review_fixer`. A new `ReviewFixCoordinator` drives the external effects (GitHub reads and writes, verification, push) under the scheduler's ownership fence, in the same style as `merge-coordinator.mjs`. The GitHub CLI adapter gains three argv-only methods. The UI renders the projected action and round evidence.

**Tech Stack:** Node 22 ESM, SQLite journal, Fastify routes, React 19 UI, `node --test`, Vitest, Cypress. Spec: `docs/superpowers/specs/2026-09-22-address-review-comments-design.md`.

**Verification commands:** `node --test tests/<name>.test.mjs` for one backend file. `npm test`, `npm run test:ui`, `npm run lint`, `npm run typecheck` per phase. `npm run test:e2e:local` for the Cypress phase.

**Commit convention:** one commit per task, message in the form `feat|test|docs: <what>`, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File structure

| File | Responsibility |
| --- | --- |
| `server/orchestration/types.d.ts` | Add `Role` member, `GoalStatus` member, `ReviewRound`, `ReviewThread`, `ReviewReply`, GitHub port methods, `RoleOutput` member, intent kind. |
| `server/orchestration/domain/review-round.mjs` (new) | Pure helpers: `parseReviewThreads`, `parseReviewReplies`, `activeReviewRound`, `reviewRoundPhase`. |
| `server/orchestration/domain/transitions.mjs` | New commands, status guards, role dispatch, generation fencing. |
| `server/orchestration/domain/role-result.mjs` | Parse the `review_fixer` result. |
| `server/orchestration/domain/scheduling.mjs` | Offer `review_fixer` work while the round is `fixing`. |
| `server/orchestration/domain/recovery.mjs` | Hold reason kind `review_fix`; recovery ends the round. |
| `server/orchestration/domain/action-view.mjs` | Offer `request_review_fix`. |
| `server/orchestration/domain/state-view.mjs` | Project `reviewRound` and `reviewRounds`. |
| `server/orchestration/domain/commands.mjs` | Allow the user command. |
| `server/orchestration/domain/teams.mjs` | Map `review_fixer` onto the integrator assignment. |
| `server/orchestration/service.mjs` | Accept the role at admission. |
| `server/orchestration/agent-results.mjs` | Route the fixer result through Git proof to `accept_review_fix_result`. |
| `server/orchestration/adapters/github-cli.mjs` | `listReviewThreads`, `replyToThread`, `resolveThread`. |
| `server/orchestration/adapters/github.mjs` | `reviewThreads`, `pushFix`, `replyAndResolve` with sent markers. |
| `server/orchestration/adapters/role-prompts.mjs` | Fixer instructions and output protocol. |
| `server/orchestration/adapters/ccs.mjs`, `agent-mcp.mjs`, `agent-tools.mjs`, `agent-commits.mjs`, `native-background.mjs` | Grant the fixer the integrator tool set and commit right. |
| `server/orchestration/review-fix-coordinator.mjs` (new) | Drives fetch, verification, push, reply, settle. |
| `server/orchestration/scheduler.mjs` | Compose and run the coordinator; permit dispatch during `addressing_review`. |
| `server/orchestration/verification-coordinator.mjs` | Run `verify` intents whose owner is a review round. |
| `tests/helpers/orchestration/fake-github.mjs` | Threads, replies, resolutions, failure injection. |
| `tests/helpers/orchestration/domain-fixture.mjs` | `deliver()` helper. |
| `tests/orchestration-review-fix.test.mjs` (new) | Domain and coordinator tests. |
| `tests/orchestration-publication.test.mjs` | GitHub CLI boundary tests for the new methods. |
| `app/orchestration/goal-detail.tsx`, `goal-fleet.tsx`, `attention.ts`, `goal-activity.tsx` | Button, eyebrow, phase line, round card, stage and labels. |
| `tests/ui-orchestration.test.tsx` | UI tests. |
| `scripts/run-orchestration-dev.mjs`, `cypress/e2e/orchestration-core.cy.ts` | Scripted fixer and one browser round. |
| `docs/code-review-workflow.md`, `README.md` | Document the round. |

---

## Phase 1: Types, domain helpers and the round lifecycle

### Task 1: Types and pure helpers

**Files:**
- Modify: `server/orchestration/types.d.ts`
- Create: `server/orchestration/domain/review-round.mjs`
- Test: `tests/orchestration-review-fix.test.mjs`

- [ ] **Step 1: Write the failing helper test**

Create `tests/orchestration-review-fix.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReviewThreads, parseReviewReplies, activeReviewRound, reviewRoundPhase } from '../server/orchestration/domain/review-round.mjs';

const thread = (id, extra = {}) => ({ id, path: 'src/a.mjs', line: 3, author: 'coderabbitai', body: 'Do not intercept non-file drops.', isBot: true, ...extra });

test('review threads are bounded, unique and literal', () => {
  const parsed = parseReviewThreads([thread('PRRT_1'), thread('PRRT_2', { line: null, isBot: false, author: 'alex' })]);
  assert.equal(parsed.length, 2); assert.equal(parsed[1].line, null); assert.equal(parsed[1].isBot, false);
  assert.throws(() => parseReviewThreads([thread('PRRT_1'), thread('PRRT_1')]), /Duplicate/);
  assert.throws(() => parseReviewThreads([thread('PRRT_1', { path: '../x' })]));
  assert.throws(() => parseReviewThreads([thread('PRRT_1', { extra: true })]));
  assert.throws(() => parseReviewThreads(Array.from({ length: 201 }, (_, i) => thread(`PRRT_${i}`))));
});

test('replies cover every thread exactly once with a known action', () => {
  const threads = parseReviewThreads([thread('PRRT_1'), thread('PRRT_2')]);
  const ok = parseReviewReplies([{ threadId: 'PRRT_1', action: 'fixed', body: 'Fixed in this commit.' }, { threadId: 'PRRT_2', action: 'declined', body: 'Out of scope.' }], threads);
  assert.equal(ok.length, 2);
  assert.throws(() => parseReviewReplies([{ threadId: 'PRRT_1', action: 'fixed', body: 'x' }], threads), /every thread/);
  assert.throws(() => parseReviewReplies([{ threadId: 'PRRT_1', action: 'fixed', body: 'x' }, { threadId: 'PRRT_1', action: 'fixed', body: 'x' }], threads), /Duplicate/);
  assert.throws(() => parseReviewReplies([{ threadId: 'PRRT_1', action: 'fixed', body: 'x' }, { threadId: 'PRRT_9', action: 'fixed', body: 'x' }], threads), /Unknown thread/);
  assert.throws(() => parseReviewReplies([{ threadId: 'PRRT_1', action: 'merge', body: 'x' }, { threadId: 'PRRT_2', action: 'fixed', body: 'x' }], threads), /action/);
});

test('phase labels follow the round state', () => {
  assert.equal(activeReviewRound({ status: 'delivered' }), null);
  const round = { id: 'r1', prHeadSha: 'a'.repeat(40), threads: [thread('PRRT_1')], state: 'fixing', startedAt: 1 };
  assert.equal(activeReviewRound({ status: 'addressing_review', reviewRound: round }), round);
  assert.equal(reviewRoundPhase({ ...round, state: 'fetching' }), 'Fetching review threads');
  assert.equal(reviewRoundPhase(round), 'Fixing 1 thread');
  assert.equal(reviewRoundPhase({ ...round, state: 'verifying' }), 'Verifying fix');
  assert.equal(reviewRoundPhase({ ...round, state: 'pushing' }), 'Pushing and replying');
  assert.equal(reviewRoundPhase({ ...round, state: 'replying' }), 'Pushing and replying');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test tests/orchestration-review-fix.test.mjs`
Expected: FAIL, `Cannot find module .../review-round.mjs`.

- [ ] **Step 3: Add the types**

In `server/orchestration/types.d.ts` change:

```ts
export type Role = 'planner' | 'implementer' | 'reviewer' | 'integrator' | 'review_fixer';
export type GoalStatus = 'discovering' | 'awaiting_approval' | 'building' | 'ready_to_publish' | 'delivered' | 'addressing_review' | 'merged' | 'aborted';
```

Add after `GoalReference`:

```ts
export interface ReviewThread { id: string; path: string | null; line: number | null; author: string; body: string; isBot: boolean }
export interface ReviewReply { threadId: string; action: 'fixed' | 'declined' | 'comment'; body: string }
export type ReviewRoundState = 'fetching' | 'fixing' | 'verifying' | 'pushing' | 'replying' | 'settled' | 'failed' | 'unknown';
export type ReviewRoundOutcome = 'addressed' | 'nothing_to_address' | 'failed';
export interface ReviewRound {
  id: string; prHeadSha: string; startedAt: number; state: ReviewRoundState; threads: ReviewThread[];
  attemptId?: string; fixHeadSha?: string; replies?: ReviewReply[]; verificationOperationId?: string;
  posted?: string[]; unconfirmed?: string[]; resolved?: string[]; outcome?: ReviewRoundOutcome; error?: string | null; settledAt?: number;
}
```

In `Goal` add after `mergeSync`:

```ts
  reviewRound?: ReviewRound | null; reviewRounds?: ReviewRound[];
```

Change the hold reason kind union to:

```ts
  hold?: { id: string; reasons: { kind: 'attempt' | 'review' | 'integration' | 'verification' | 'publication' | 'review_fix'; target: string; message: string }[] } | null;
```

Add to `RoleOutput`:

```ts
  | { role: 'review_fixer'; output: { headSha: string; summary: string; replies: ReviewReply[] } };
```

Add to `GitHubPort`:

```ts
  listReviewThreads?(repositoryId: string, number: number): Promise<ReviewThread[]>;
  replyToThread?(repositoryId: string, threadId: string, body: string, options?: { beforeSend?: () => boolean }): Promise<void>;
  resolveThread?(repositoryId: string, threadId: string, options?: { beforeSend?: () => boolean }): Promise<void>;
```

Add to `PublicationPort`:

```ts
  reviewThreads?(input: PublicationInput, pr: NonNullable<Goal['pr']>): Promise<ReviewThread[]>;
  pushFix?(input: PublicationInput, fix: { roundId: string; expectedHead: string; headSha: string }): Promise<'pushed' | 'remote_moved' | 'unknown'>;
  replyAndResolve?(input: PublicationInput, fix: { roundId: string; replies: ReviewReply[] }): Promise<{ posted: string[]; unconfirmed: string[]; resolved: string[] }>;
```

- [ ] **Step 4: Create the helper module**

Create `server/orchestration/domain/review-round.mjs`:

```js
import { array, identifier, integer, object, requireValue, text } from './contracts.mjs';
import { ownedArea } from './graph.mjs';

export const MAX_REVIEW_THREADS = 200;
const ACTIONS = /** @type {const} */ (['fixed', 'declined', 'comment']);

/** @param {unknown} value @returns {import('../types.d.ts').ReviewThread[]} */
export function parseReviewThreads(value) {
  const threads = array(value, MAX_REVIEW_THREADS).map((entry) => {
    const item = object(entry);
    requireValue(Object.keys(item).length === 6 && ['id', 'path', 'line', 'author', 'body', 'isBot'].every((key) => Object.hasOwn(item, key)), 'Unexpected review thread field');
    requireValue(typeof item.isBot === 'boolean', 'Missing thread author kind');
    return { id: identifier(item.id), path: item.path === null ? null : ownedArea(item.path), line: item.line === null ? null : integer(item.line, 1), author: text(item.author, 200), body: text(item.body, 16000), isBot: item.isBot };
  });
  requireValue(new Set(threads.map((thread) => thread.id)).size === threads.length, 'Duplicate review thread');
  return threads;
}

/** Exactly one reply per recorded thread, no unknown targets.
 * @param {unknown} value @param {import('../types.d.ts').ReviewThread[]} threads @returns {import('../types.d.ts').ReviewReply[]} */
export function parseReviewReplies(value, threads) {
  const replies = array(value, MAX_REVIEW_THREADS).map((entry) => {
    const item = object(entry);
    requireValue(Object.keys(item).length === 3 && ['threadId', 'action', 'body'].every((key) => Object.hasOwn(item, key)), 'Unexpected reply field');
    requireValue(ACTIONS.includes(/** @type {typeof ACTIONS[number]} */ (item.action)), 'Unknown reply action');
    return { threadId: identifier(item.threadId), action: /** @type {typeof ACTIONS[number]} */ (item.action), body: text(item.body, 8000) };
  });
  requireValue(new Set(replies.map((reply) => reply.threadId)).size === replies.length, 'Duplicate reply thread');
  for (const reply of replies) requireValue(threads.some((thread) => thread.id === reply.threadId), 'Unknown thread in reply');
  requireValue(replies.length === threads.length, 'Replies must cover every thread');
  return replies;
}

/** @param {Pick<import('../types.d.ts').Goal, 'status' | 'reviewRound'>} goal */
export function activeReviewRound(goal) {
  return goal.status === 'addressing_review' && goal.reviewRound ? goal.reviewRound : null;
}

/** @param {import('../types.d.ts').ReviewRound} round */
export function reviewRoundPhase(round) {
  if (round.state === 'fetching') return 'Fetching review threads';
  if (round.state === 'fixing') return `Fixing ${round.threads.length} ${round.threads.length === 1 ? 'thread' : 'threads'}`;
  if (round.state === 'verifying') return 'Verifying fix';
  if (round.state === 'pushing' || round.state === 'replying') return 'Pushing and replying';
  return round.state === 'settled' ? 'Round complete' : round.state === 'unknown' ? 'Push outcome uncertain' : 'Round failed';
}
```

- [ ] **Step 5: Run the test**

Run: `node --test tests/orchestration-review-fix.test.mjs`
Expected: 3 passing.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`. Expected: no errors (the new union members are additive).

```bash
git add server/orchestration/types.d.ts server/orchestration/domain/review-round.mjs tests/orchestration-review-fix.test.mjs
git commit -m "feat: add review round types and pure helpers"
```

### Task 2: Round lifecycle commands in the domain

**Files:**
- Modify: `server/orchestration/domain/transitions.mjs`
- Modify: `server/orchestration/domain/recovery.mjs`
- Modify: `tests/helpers/orchestration/domain-fixture.mjs`
- Test: `tests/orchestration-review-fix.test.mjs`

- [ ] **Step 1: Add a `deliver` helper to the domain fixture**

In `tests/helpers/orchestration/domain-fixture.mjs`, after `const recover = ...` add:

```js
  /** Drive a single-task goal to delivered with PR #1 at HEAD_B. */
  const deliver = () => {
    const c = contract(); c.tasks = [c.tasks[0]]; approve(c);
    request('a', 'implementer', 'A'); dispatch('a'); command('confirm_candidate', { attemptId: 'a', headSha: HEAD_A }); command('record_stopped', { attemptId: 'a' });
    request('ar', 'reviewer', 'A'); dispatch('ar'); review('ar', HEAD_A);
    command('request_integration', { taskId: 'A', operationId: 'integrate' });
    command('record_integration', { operationId: 'integrate', headSha: HEAD_B });
    request('final', 'reviewer'); dispatch('final'); review('final', HEAD_B);
    command('record_verification', { headSha: HEAD_B, checks: [{ id: 'unit', passed: true, artifactId: 'log' }] });
    command('request_publication', { operationId: 'publish' });
    command('approve_publication', { operationId: 'publish', headSha: HEAD_B }, user);
    command('record_pr', { operationId: 'publish', number: 1, url: 'https://example.test/pr/1', headSha: HEAD_B });
  };
```

Return it: `return { recover, deliver, get goal() ...`.

- [ ] **Step 2: Write the failing lifecycle tests**

Append to `tests/orchestration-review-fix.test.mjs`:

```js
import { fixture, HEAD_A, HEAD_B } from './helpers/orchestration/domain-fixture.mjs';
import { transition } from '../server/orchestration/domain/transitions.mjs';
import { readyWork } from '../server/orchestration/domain/scheduling.mjs';
const fails = (fn, code) => assert.throws(fn, code ? (error) => error.code === code : undefined);
const HEAD_C = 'd'.repeat(40);
const threads = () => [thread('PRRT_1'), thread('PRRT_2', { isBot: false, author: 'alex' })];
const replies = (action = 'fixed') => [{ threadId: 'PRRT_1', action, body: 'Reply one.' }, { threadId: 'PRRT_2', action: 'declined', body: 'Reply two.' }];

test('a review round is offered only to a delivered goal with an open PR and settled workers', () => {
  const f = fixture();
  fails(() => f.command('request_review_fix', {}, f.user), 'NOT_READY');
  f.deliver();
  fails(() => f.command('request_review_fix', {}), 'FORBIDDEN');
  const before = f.goal.generation;
  const started = f.command('request_review_fix', {}, f.user);
  assert.equal(f.goal.status, 'addressing_review'); assert.equal(f.goal.generation, before + 1);
  assert.deepEqual(started.events.at(-1).kind, 'review_fix_requested');
  assert.equal(f.goal.reviewRound.state, 'fetching'); assert.equal(f.goal.reviewRound.prHeadSha, HEAD_B);
  fails(() => f.command('request_review_fix', {}, f.user), 'NOT_READY');
  fails(() => f.command('request_revision', { message: 'x' }, f.user), 'INVALID_STATE');
});

test('a closed PR and an aborted or merged goal refuse a round', () => {
  const f = fixture(); f.deliver();
  f.command('record_merge_sync', { number: 1, url: 'https://example.test/pr/1', state: 'closed', checkedAt: 5 });
  fails(() => f.command('request_review_fix', {}, f.user), 'NOT_READY');
  const g = fixture(); g.deliver(); g.command('record_merged');
  fails(() => g.command('request_review_fix', {}, g.user), 'TERMINAL_GOAL');
});

test('zero threads settle the round at once and unknown fetch fails it with a hold', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  const round = f.goal.reviewRound.id;
  f.command('record_review_threads', { roundId: round, threads: [] });
  assert.equal(f.goal.status, 'delivered'); assert.equal(f.goal.reviewRound, null);
  assert.equal(f.goal.reviewRounds[0].outcome, 'nothing_to_address'); assert.equal(f.goal.mergeSync, undefined);
  const g = fixture(); g.deliver(); g.command('request_review_fix', {}, g.user);
  g.command('fail_review_fix', { roundId: g.goal.reviewRound.id, code: 'GITHUB_UNAVAILABLE', message: 'GitHub review threads were unavailable.' });
  assert.equal(g.goal.status, 'addressing_review'); assert.equal(g.goal.reviewRound.state, 'failed');
  assert.equal(g.goal.hold.reasons[0].kind, 'review_fix');
  g.recover();
  assert.equal(g.goal.status, 'delivered'); assert.equal(g.goal.reviewRounds[0].outcome, 'failed'); assert.equal(g.goal.pr.headSha, HEAD_B);
});

test('threads move the round to fixing and expose review_fixer work at the PR head', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  f.command('record_review_threads', { roundId: f.goal.reviewRound.id, threads: threads() });
  assert.equal(f.goal.reviewRound.state, 'fixing');
  const work = readyWork(f.goal);
  assert.deepEqual(work.map((entry) => [entry.role, entry.target]), [['review_fixer', HEAD_B]]);
  f.request('fx', 'review_fixer'); const attempt = f.goal.attempts.at(-1);
  assert.equal(attempt.baseSha, HEAD_B); assert.equal(attempt.target, HEAD_B); assert.equal(attempt.mode, 'background');
  assert.equal(readyWork(f.goal).length, 0);
  fails(() => f.request('fx2', 'review_fixer'), 'ALREADY_RUNNING');
});

test('a fix result with a new head needs verification; replies only skip to replying', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  f.command('record_review_threads', { roundId: f.goal.reviewRound.id, threads: threads() });
  f.request('fx', 'review_fixer'); f.dispatch('fx');
  fails(() => f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_B, summary: 's', replies: replies('fixed') }), 'STALE_TARGET');
  fails(() => f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 's', replies: replies('declined') }), 'STALE_TARGET');
  fails(() => f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 's', replies: [replies()[0]] }));
  f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 'Fixed drop handling', replies: replies('fixed') });
  assert.equal(f.goal.reviewRound.state, 'verifying'); assert.equal(f.goal.reviewRound.fixHeadSha, HEAD_C);
  assert.equal(f.goal.attempts.at(-1).status, 'succeeded');
  const g = fixture(); g.deliver(); g.command('request_review_fix', {}, g.user);
  g.command('record_review_threads', { roundId: g.goal.reviewRound.id, threads: threads() });
  g.request('fx', 'review_fixer'); g.dispatch('fx');
  g.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_B, summary: 'No code change', replies: replies('declined') });
  assert.equal(g.goal.reviewRound.state, 'replying'); assert.equal(g.goal.reviewRound.fixHeadSha, undefined);
});

test('verification of the fix head gates the push and a failed check holds the goal', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  f.command('record_review_threads', { roundId, threads: threads() });
  f.request('fx', 'review_fixer'); f.dispatch('fx');
  f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 's', replies: replies('fixed') }); f.command('record_stopped', { attemptId: 'fx' });
  const requested = f.command('request_review_fix_verification', { roundId, operationId: 'verify_fix' });
  assert.equal(requested.intents[0].kind, 'verify'); assert.equal(requested.intents[0].payload.headSha, HEAD_C);
  assert.equal(f.goal.verificationRuns.at(-1).operationId, 'verify_fix');
  fails(() => f.command('record_review_fix_push', { roundId }), 'NOT_READY');
  f.command('record_verification_result', { operationId: 'verify_fix', result: { verification: { headSha: HEAD_C, checks: [{ id: 'unit', passed: false, artifactId: 'log' }] }, workerState: 'stopped', artifactId: 'a'.repeat(64) } });
  f.command('record_review_fix_verification', { roundId, operationId: 'verify_fix' });
  assert.equal(f.goal.reviewRound.state, 'failed'); assert.equal(f.goal.hold.reasons[0].kind, 'review_fix');
  assert.equal(f.goal.pr.headSha, HEAD_B);
  f.recover(); assert.equal(f.goal.status, 'delivered'); assert.equal(f.goal.reviewRounds[0].outcome, 'failed');
});

test('a passed fix verification, push and settlement advance the PR head and clear merge sync', () => {
  const f = fixture(); f.deliver();
  f.command('record_merge_sync', { number: 1, url: 'https://example.test/pr/1', state: 'open', checkedAt: 5 });
  f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  f.command('record_review_threads', { roundId, threads: threads() });
  f.request('fx', 'review_fixer'); f.dispatch('fx');
  f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 's', replies: replies('fixed') }); f.command('record_stopped', { attemptId: 'fx' });
  f.command('request_review_fix_verification', { roundId, operationId: 'verify_fix' });
  f.command('record_verification_result', { operationId: 'verify_fix', result: { verification: { headSha: HEAD_C, checks: [{ id: 'unit', passed: true, artifactId: 'log' }] }, workerState: 'stopped', artifactId: 'a'.repeat(64) } });
  f.command('record_review_fix_verification', { roundId, operationId: 'verify_fix' });
  assert.equal(f.goal.reviewRound.state, 'pushing');
  f.command('record_review_fix_push', { roundId });
  assert.equal(f.goal.reviewRound.state, 'replying'); assert.equal(f.goal.pr.headSha, HEAD_C); assert.equal(f.goal.publication.headSha, HEAD_C); assert.equal(f.goal.mergeSync, undefined);
  f.command('settle_review_fix', { roundId, posted: ['PRRT_1', 'PRRT_2'], unconfirmed: [], resolved: ['PRRT_1'] });
  assert.equal(f.goal.status, 'delivered'); assert.equal(f.goal.reviewRound, null);
  assert.equal(f.goal.reviewRounds[0].outcome, 'addressed'); assert.deepEqual(f.goal.reviewRounds[0].resolved, ['PRRT_1']);
  fails(() => f.command('settle_review_fix', { roundId, posted: [], unconfirmed: [], resolved: [] }), 'STALE_OPERATION');
});

test('an uncertain push holds the round until the remote head confirms one outcome', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  const roundId = f.goal.reviewRound.id;
  f.command('record_review_threads', { roundId, threads: threads() });
  f.request('fx', 'review_fixer'); f.dispatch('fx');
  f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 's', replies: replies('fixed') }); f.command('record_stopped', { attemptId: 'fx' });
  f.command('request_review_fix_verification', { roundId, operationId: 'verify_fix' });
  f.command('record_verification_result', { operationId: 'verify_fix', result: { verification: { headSha: HEAD_C, checks: [{ id: 'unit', passed: true, artifactId: 'log' }] }, workerState: 'stopped', artifactId: 'a'.repeat(64) } });
  f.command('record_review_fix_verification', { roundId, operationId: 'verify_fix' });
  f.command('fail_review_fix', { roundId, code: 'PUSH_UNCERTAIN', message: 'Push outcome is uncertain.' });
  assert.equal(f.goal.reviewRound.state, 'unknown'); assert.ok(f.goal.hold);
  fails(() => f.command('recover_goal', { holdId: f.goal.hold.id }, f.user), 'OWNERSHIP_UNCERTAIN');
  f.command('record_review_fix_push', { roundId });
  assert.equal(f.goal.hold, null); assert.equal(f.goal.reviewRound.state, 'replying'); assert.equal(f.goal.pr.headSha, HEAD_C);
});

test('abort during a round terminates the fixer and keeps the old PR head', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  f.command('record_review_threads', { roundId: f.goal.reviewRound.id, threads: threads() });
  f.request('fx', 'review_fixer'); f.dispatch('fx');
  const aborted = f.command('abort', {}, f.user);
  assert.equal(aborted.intents[0].kind, 'terminate'); assert.equal(f.goal.status, 'aborted'); assert.equal(f.goal.pr.headSha, HEAD_B);
  fails(() => f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 's', replies: replies() }), 'TERMINAL_GOAL');
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `node --test tests/orchestration-review-fix.test.mjs`
Expected: the new tests FAIL with `Unknown orchestration command` or `Unknown role`.

- [ ] **Step 4: Implement the commands in `transitions.mjs`**

Import at the top:

```js
import { parseReviewThreads, parseReviewReplies } from './review-round.mjs';
```

Add after the `hasPendingRepairResult` export:

```js
/** @param {Goal} goal @param {unknown} roundId */
function activeRound(goal, roundId) {
  const round = goal.reviewRound;
  requireValue(goal.status === 'addressing_review' && round && round.id === identifier(roundId), 'Review round changed', 'STALE_OPERATION');
  return round;
}
/** Close the active round and return the goal to waiting for merge.
 * @param {Goal} goal @param {import('../types.d.ts').ReviewRound} round @param {import('../types.d.ts').ReviewRoundOutcome} outcome @param {number} settledAt */
function closeRound(goal, round, outcome, settledAt) {
  (goal.reviewRounds ??= []).push({ ...round, state: outcome === 'failed' ? 'failed' : 'settled', outcome, settledAt });
  goal.reviewRound = null; goal.status = 'delivered';
}
```

In the terminal-goal guard list (the `requireValue(!['aborted', 'merged'].includes(before.status) || [...]` line), no change is needed: those commands are not in the list, so a merged or aborted goal refuses them with `TERMINAL_GOAL`.

In `request_revision` and `publish_contract`, extend the existing delivered guard:

```js
      requireValue(goal.status !== 'delivered' && goal.status !== 'addressing_review', 'Delivered goals require a new goal', 'INVALID_STATE');
```

In `request_attempt`, change the role allow-list and add the branch:

```js
      requireValue(['planner', 'implementer', 'reviewer', 'integrator', 'review_fixer'].includes(String(input.role)), 'Unknown role');
```

and after the `if (role === 'integrator') { ... }` block:

```js
      if (role === 'review_fixer') {
        const round = goal.reviewRound;
        requireValue(goal.status === 'addressing_review' && round?.state === 'fixing' && round.threads.length > 0, 'No review threads await a fix', 'NOT_READY');
        requireValue(!goal.verificationRuns?.some((run) => run.workerState !== 'stopped'), 'Verification worker is not settled', 'NOT_READY');
        target = round.prHeadSha;
      }
```

In the same case, the `ALREADY_RUNNING` guard treats the fixer like the integrator (one at a time):

```js
      requireValue(!goal.attempts.some((attempt) => ownsWorker(attempt) && attempt.role === role && (role === 'integrator' || role === 'review_fixer' || (attempt.taskId === taskId && (role === 'implementer' || role === 'planner' || attempt.target === target)))), 'Attempt already active', 'ALREADY_RUNNING');
```

The attempt `baseSha` line becomes:

```js
      const attempt = { id, operationId, role, mode, taskId, target, generation: goal.generation, revision: goal.revision, status: 'queued', workerState: 'pending', identity: null, baseSha: role === 'reviewer' && !target.startsWith('contract:') ? target : role === 'review_fixer' ? target : goal.integrationHead, worktree: null, branch: null, conversationId, error: null };
```

After the attempt is pushed, record the id on the round:

```js
      if (role === 'review_fixer' && goal.reviewRound) goal.reviewRound.attemptId = id;
```

Add the new cases before `case 'abort':`:

```js
    case 'request_review_fix': {
      requireAuthority(authority, 'user');
      requireValue(goal.status === 'delivered' && goal.pr && goal.publication, 'Only a delivered goal with a pull request can address review comments', 'NOT_READY');
      requireValue(goal.mergeSync?.state !== 'closed', 'The pull request is closed on GitHub', 'NOT_READY');
      requireValue(!goal.reviewRound, 'A review round is already active', 'NOT_READY');
      requireValue(!goal.attempts.some(ownsWorker) && !goal.verificationRuns?.some((run) => run.workerState !== 'stopped') && !goal.results?.some((result) => result.status === 'pending'), 'Workers still active', 'NOT_READY');
      goal.generation++;
      goal.reviewRound = { id: command.id, prHeadSha: goal.pr.headSha, startedAt: integer(input.startedAt ?? 0), state: 'fetching', threads: [] };
      goal.status = 'addressing_review';
      emit('review_fix_requested', { roundId: command.id, prHeadSha: goal.pr.headSha }); break;
    }
    case 'record_review_threads': {
      requireAuthority(authority, 'system');
      const round = activeRound(goal, input.roundId);
      requireValue(round.state === 'fetching', 'Review threads were already recorded', 'STALE_OPERATION');
      round.threads = parseReviewThreads(input.threads);
      if (!round.threads.length) { closeRound(goal, round, 'nothing_to_address', integer(input.at ?? 0)); emit('review_fix_settled', { roundId: round.id, outcome: 'nothing_to_address' }); break; }
      round.state = 'fixing'; emit('review_threads_recorded', { roundId: round.id, count: round.threads.length }); break;
    }
    case 'accept_review_fix_result': {
      // Internal: the service verifies Git evidence before issuing it, like confirm_candidate.
      requireAuthority(authority, 'system');
      const attempt = attemptById(goal, input.attemptId); ownsResult(authority, attempt);
      requireValue(attempt.role === 'review_fixer', 'Not a review fixer', 'FORBIDDEN');
      const round = goal.reviewRound;
      requireValue(goal.status === 'addressing_review' && round?.state === 'fixing' && round.attemptId === attempt.id && attempt.target === round.prHeadSha, 'Review round target changed', 'STALE_TARGET');
      const headSha = sha(input.headSha), replies = parseReviewReplies(input.replies, round.threads);
      const fixed = replies.some((reply) => reply.action === 'fixed');
      requireValue(fixed ? headSha !== round.prHeadSha : headSha === round.prHeadSha, fixed ? 'A fix needs a new commit' : 'Replies without a fix must keep the PR head', 'STALE_TARGET');
      round.replies = replies; round.summary = text(input.summary, 8000);
      if (fixed) { round.fixHeadSha = headSha; round.state = 'verifying'; } else round.state = 'replying';
      attempt.status = 'succeeded';
      emit('review_fix_result_accepted', { roundId: round.id, headSha, fixed }); break;
    }
    case 'request_review_fix_verification': {
      requireAuthority(authority, 'system');
      const round = activeRound(goal, input.roundId);
      requireValue(round.state === 'verifying' && round.fixHeadSha && !round.verificationOperationId, 'Fix verification is not awaited', 'NOT_READY');
      requireValue(!goal.attempts.some(ownsWorker) && !goal.verificationRuns?.some((run) => run.workerState !== 'stopped'), 'Verification ownership is occupied', 'NOT_READY');
      const operationId = identifier(input.operationId), checks = currentContract(goal).verification;
      round.verificationOperationId = operationId;
      (goal.verificationRuns ??= []).push({ operationId, generation: goal.generation, revision: goal.revision, headSha: round.fixHeadSha, status: 'pending', workerState: 'pending' });
      intent('verify', operationId, null, { headSha: round.fixHeadSha, checks: checks.map((check) => ({ id: check.id, argv: check.argv })) });
      emit('review_fix_verification_requested', { roundId: round.id, operationId, headSha: round.fixHeadSha }); break;
    }
    case 'record_review_fix_verification': {
      requireAuthority(authority, 'system');
      const round = activeRound(goal, input.roundId);
      const run = goal.verificationRuns?.find((entry) => entry.operationId === input.operationId);
      requireValue(round.state === 'verifying' && run && run.operationId === round.verificationOperationId && run.result, 'Fix verification is not complete', 'NOT_READY');
      const passed = run.workerState === 'stopped' && run.result.verification.checks.every((check) => check.passed);
      if (passed) { round.state = 'pushing'; emit('review_fix_verified', { roundId: round.id, headSha: round.fixHeadSha }); break; }
      round.state = 'failed'; round.error = run.workerState === 'stopped' ? 'Required verification failed on the fix head.' : 'Fix verification ownership is uncertain.';
      emit('review_fix_failed', { roundId: round.id, code: 'VERIFICATION_FAILED' }); break;
    }
    case 'record_review_fix_push': {
      requireAuthority(authority, 'system');
      const round = activeRound(goal, input.roundId);
      requireValue(['pushing', 'unknown'].includes(round.state) && round.fixHeadSha && goal.pr && goal.publication, 'Fix push is not awaited', 'NOT_READY');
      goal.pr.headSha = round.fixHeadSha; goal.publication.headSha = round.fixHeadSha; goal.publication.plan.headSha = round.fixHeadSha;
      delete goal.mergeSync;
      if (round.state === 'unknown' && goal.hold) {
        goal.hold.reasons = goal.hold.reasons.filter((reason) => !(reason.kind === 'review_fix' && reason.target === round.id));
        if (!goal.hold.reasons.length) { (goal.recoveries ??= []).push({ commandId: command.id, hold: goal.hold }); goal.hold = null; }
      }
      round.state = 'replying'; round.error = null;
      emit('review_fix_pushed', { roundId: round.id, headSha: round.fixHeadSha }); break;
    }
    case 'settle_review_fix': {
      requireAuthority(authority, 'system');
      const round = activeRound(goal, input.roundId);
      requireValue(round.state === 'replying' && round.replies, 'Fix replies are not awaited', 'STALE_OPERATION');
      const ids = new Set(round.threads.map((thread) => thread.id));
      const list = (/** @type {unknown} */ value) => { const items = identifiers(value, 200); for (const id of items) requireValue(ids.has(id), 'Unknown settled thread'); return items; };
      round.posted = list(input.posted); round.unconfirmed = list(input.unconfirmed); round.resolved = list(input.resolved);
      closeRound(goal, round, 'addressed', integer(input.at ?? 0));
      emit('review_fix_settled', { roundId: round.id, outcome: 'addressed', headSha: goal.pr?.headSha ?? '' }); break;
    }
    case 'fail_review_fix': {
      requireAuthority(authority, 'system');
      const round = activeRound(goal, input.roundId);
      requireValue(!['failed', 'unknown'].includes(round.state), 'Review round already failed', 'STALE_OPERATION');
      const code = identifier(input.code);
      round.state = code === 'PUSH_UNCERTAIN' ? 'unknown' : 'failed'; round.error = text(input.message, 500);
      for (const attempt of goal.attempts.filter(ownsWorker)) {
        if (attempt.identity) intent('terminate', `${command.id}_${attempt.id}`, attempt.id, { identity: attempt.identity });
        if (attempt.workerState === 'pending') attempt.workerState = 'unknown';
      }
      emit('review_fix_failed', { roundId: round.id, code }); break;
    }
```

Import `identifiers` from `./contracts.mjs` in the first import line.

In `case 'abort'`, nothing changes: the goal becomes `aborted`, and the fixer receives a terminate intent through the existing loop.

- [ ] **Step 5: Hold and recovery in `recovery.mjs`**

In `captureFailureHold`, change the first guard so `addressing_review` rounds can hold:

```js
  if (['aborted', 'merged', 'delivered'].includes(goal.status) || goal.generation !== before.generation || goal.revision !== before.revision) return;
```

stays. Add after the publication reason:

```js
  const round = goal.reviewRound;
  if (goal.status === 'addressing_review' && round && ['failed', 'unknown'].includes(round.state) && before.reviewRound?.state !== round.state) {
    reasons.push({ kind: 'review_fix', target: round.id, message: round.state === 'unknown' ? 'The fix push outcome is uncertain; Companion is confirming the remote branch.' : `Addressing review comments failed. ${round.error ?? ''}`.trim() });
  }
```

Also the attempt reason loop must not fire for a fixer whose failure is already the round's failure. Leave it: a fixer crash produces an `attempt` reason plus the coordinator's `fail_review_fix`, and recovery clears both.

In `recoverGoal`, after the `OWNERSHIP_UNCERTAIN` guard add:

```js
  requireValue(goal.reviewRound?.state !== 'unknown', 'Confirm the fix push outcome before recovery', 'OWNERSHIP_UNCERTAIN');
```

and before `(goal.recoveries ??= []).push(...)`:

```js
  if (goal.status === 'addressing_review' && goal.reviewRound) {
    const round = goal.reviewRound;
    (goal.reviewRounds ??= []).push({ ...round, state: 'failed', outcome: 'failed', settledAt: 0 });
    goal.reviewRound = null; goal.status = 'delivered';
  }
```

Import nothing new; `recovery.mjs` already imports `requireValue`.

- [ ] **Step 6: Scheduling in `scheduling.mjs`**

Change the early return:

```js
  if (['aborted', 'merged', 'delivered', 'ready_to_publish'].includes(goal.status)) return [];
  /** @type {ReadyWork[]} */
  const result = [];
```

and immediately after `const add = ...` definition, before the planner line, add:

```js
  if (goal.status === 'addressing_review') {
    const round = goal.reviewRound;
    if (round?.state === 'fixing' && round.threads.length && !goal.attempts.some((attempt) => attempt.role === 'review_fixer' && attempt.generation === goal.generation && attempt.revision === goal.revision)) add('review_fixer', null, round.prHeadSha);
    return result;
  }
```

- [ ] **Step 7: Run the tests**

Run: `node --test tests/orchestration-review-fix.test.mjs tests/orchestration-domain.test.mjs`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add server/orchestration/domain/transitions.mjs server/orchestration/domain/recovery.mjs server/orchestration/domain/scheduling.mjs tests/helpers/orchestration/domain-fixture.mjs tests/orchestration-review-fix.test.mjs
git commit -m "feat: add the review round lifecycle to the goal domain"
```

### Task 3: Result parsing, teams, service admission, projection and action view

**Files:**
- Modify: `server/orchestration/domain/role-result.mjs`
- Modify: `server/orchestration/domain/teams.mjs`
- Modify: `server/orchestration/service.mjs`
- Modify: `server/orchestration/domain/action-view.mjs`
- Modify: `server/orchestration/domain/state-view.mjs`
- Modify: `server/orchestration/domain/commands.mjs`
- Test: `tests/orchestration-review-fix.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append:

```js
import { parseRoleResult } from '../server/orchestration/domain/role-result.mjs';
import { goalView } from '../server/orchestration/domain/state-view.mjs';
import { actionView } from '../server/orchestration/domain/action-view.mjs';
import { USER_COMMANDS } from '../server/orchestration/domain/commands.mjs';

test('review fixer results carry a head, summary and replies', () => {
  const attempt = { id: 'fx', operationId: 'op', generation: 2, revision: 1, role: 'review_fixer', target: HEAD_B };
  const envelope = { schemaVersion: 1, goalId: 'g', attemptId: 'fx', operationId: 'op', generation: 2, revision: 1, role: 'review_fixer', target: HEAD_B, output: { headSha: HEAD_C, summary: 'Fixed', replies: replies() } };
  const parsed = parseRoleResult(envelope, { goalId: 'g', attempt });
  assert.equal(parsed.role, 'review_fixer'); assert.equal(parsed.output.replies.length, 2);
  assert.throws(() => parseRoleResult({ ...envelope, output: { headSha: HEAD_C, summary: 'x' } }, { goalId: 'g', attempt }));
  assert.throws(() => parseRoleResult({ ...envelope, output: { ...envelope.output, replies: [{ threadId: 'PRRT_1', action: 'push', body: 'x' }] } }, { goalId: 'g', attempt }));
});

test('the action view offers the round to the user and the projection exposes rounds without thread bodies leaking secrets', () => {
  const f = fixture();
  assert.ok(!actionView(f.goal).actions.some((action) => action.type === 'request_review_fix'));
  f.deliver();
  const offered = actionView(f.goal).actions.find((action) => action.type === 'request_review_fix');
  assert.equal(offered.label, 'Address review comments');
  assert.ok(USER_COMMANDS.has('request_review_fix'));
  f.command('request_review_fix', {}, f.user);
  assert.ok(!actionView(f.goal).actions.some((action) => action.type === 'request_review_fix'));
  const view = goalView(f.goal);
  assert.equal(view.status, 'addressing_review'); assert.equal(view.reviewRound.state, 'fetching'); assert.equal(view.reviewRound.phase, 'Fetching review threads');
  assert.deepEqual(view.reviewRounds, []);
});

test('the fixer inherits the integrator team assignment', () => {
  const f = fixture(); f.deliver();
  const configured = { ...f.goal, teamConfiguration: { capturedAt: 'now', defaults: { planner: 'p', implementer: 'p', reviewer: 'p', integrator: 'p' }, profiles: [{ id: 'p', label: 'P', provider: 'claude', model: 'm', roles: ['planner', 'implementer', 'reviewer', 'integrator'], ready: true, reason: '', capacity: { remainingPercent: null, source: 's', checkedAt: null, reason: '' } }] },
    team: { revision: 1, approved: true, assignments: [{ key: 'integrator:*', role: 'integrator', taskId: null, profileId: 'p', manual: false, reason: '' }], changes: [] } };
  const { assignmentFor } = await_import_teams();
  const assignment = assignmentFor(configured, 'review_fixer', null);
  assert.equal(assignment.profileId, 'p'); assert.equal(assignment.role, 'integrator');
});
```

Add at the top of the file, with the other imports:

```js
import * as teams from '../server/orchestration/domain/teams.mjs';
const await_import_teams = () => teams;
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test tests/orchestration-review-fix.test.mjs`
Expected: the three new tests FAIL.

- [ ] **Step 3: Parse the fixer result**

In `server/orchestration/domain/role-result.mjs` import `parseReviewReplies`:

```js
import { parseReviewReplies } from './review-round.mjs';
```

Add a case to the switch:

```js
    case 'review_fixer': {
      fields(output, ['headSha', 'summary', 'replies']);
      // Thread identity is validated again against the recorded round at acceptance.
      const replies = array(output.replies, 200).map((entry) => { const item = object(entry); fields(item, ['threadId', 'action', 'body']); return { threadId: identifier(item.threadId), action: item.action, body: text(item.body, 8000) }; });
      requireValue(replies.every((reply) => ['fixed', 'declined', 'comment'].includes(String(reply.action))), 'Unknown reply action');
      return { ...common, role: 'review_fixer', output: { headSha: sha(output.headSha), summary: text(output.summary, 8000), replies: /** @type {import('../types.d.ts').ReviewReply[]} */ (replies) } };
    }
```

Remove the unused `parseReviewReplies` import if lint reports it; the acceptance command already validates against the round.

- [ ] **Step 4: Team assignment**

In `server/orchestration/domain/teams.mjs`, `assignmentFor` becomes:

```js
export function assignmentFor(goal, role, taskId) {
  // The review fixer has no configured team role; it reuses the integrator's profile.
  const lookup = role === 'review_fixer' ? 'integrator' : role;
  const assignment = goal.team?.assignments.find(entry => entry.key === assignmentKey(lookup, taskId)) ?? goal.team?.assignments.find(entry => entry.key === assignmentKey(lookup, null));
  if (!goal.teamConfiguration) return undefined;
  requireValue(assignment?.profileId, 'Choose a ready team profile before dispatch', 'NOT_READY');
  const profile = goal.teamConfiguration.profiles.find(entry => entry.id === assignment.profileId);
  requireValue(profile && profile.ready && profile.roles.includes(lookup), 'Assigned profile is not ready for this role', 'NOT_READY');
  return { ...structuredClone(assignment), provider: profile.provider, model: profile.model, label: profile.label };
}
```

`TEAM_ROLES` stays unchanged; `Record<Role, string>` for `defaults` must exclude the fixer, so change the type in `types.d.ts`:

```ts
export type TeamRole = 'planner' | 'implementer' | 'reviewer' | 'integrator';
export interface TeamConfiguration { profiles: TeamProfile[]; defaults: Record<TeamRole, string>; capturedAt: string }
```

and `TeamProfile.roles: TeamRole[]`, `TeamAssignment.role: TeamRole`. Fix any typecheck fallout in `teams.mjs` JSDoc by using `TeamRole` where the value comes from `TEAM_ROLES`.

- [ ] **Step 5: Service, commands, action view, projection**

`server/orchestration/service.mjs`: extend the allow-list

```js
        requireValue(['planner', 'implementer', 'reviewer', 'integrator', 'review_fixer'].includes(String(payload.role)), 'Unknown role');
```

`server/orchestration/domain/commands.mjs`: add `'request_review_fix'` to `USER_COMMANDS`. Add to `AGENT_COMMANDS`:

```js
  review_fixer: new Set(['submit_review_fix']),
```

`server/orchestration/domain/action-view.mjs`: after the `abort` offer add

```js
  offer('request_review_fix', 'Address review comments', {});
```

`server/orchestration/domain/state-view.mjs`: import `reviewRoundPhase` and add to the returned object after `mergeSync`:

```js
    reviewRound: goal.reviewRound ? { ...goal.reviewRound, phase: reviewRoundPhase(goal.reviewRound) } : null, reviewRounds: goal.reviewRounds ?? [],
```

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `node --test tests/orchestration-review-fix.test.mjs && npm run typecheck && npm run lint`
Expected: pass. Fix every reported error before the commit.

- [ ] **Step 7: Commit**

```bash
git add server/orchestration/domain server/orchestration/service.mjs server/orchestration/types.d.ts tests/orchestration-review-fix.test.mjs
git commit -m "feat: project the review round and admit the review fixer role"
```

### Task 4: Phase 1 verification

- [ ] **Step 1: Run the full backend and UI suites**

Run: `npm test && npm run test:ui && npm run lint && npm run typecheck`
Expected: pass. The UI tests may fail on the `GoalStatus` union in `goal-fleet.tsx` only if a switch is exhaustive; there is none today.

- [ ] **Step 2: Fix any failure, then commit the fix separately if code changed.**

---

## Phase 2: Adapters, agent integration and the coordinator

### Task 5: GitHub CLI thread methods

**Files:**
- Modify: `server/orchestration/adapters/github-cli.mjs`
- Test: `tests/orchestration-publication.test.mjs`

- [ ] **Step 1: Write the failing CLI boundary test**

Append to `tests/orchestration-publication.test.mjs`:

```js
test('GitHub CLI lists unresolved review threads through bounded GraphQL pages and fails closed', async (t) => {
  const { GitHubCli } = await import('../server/orchestration/adapters/github-cli.mjs');
  const f = await fixture(t), calls = [];
  const node = (id, resolved, path = 'src/a.mjs') => ({ id, isResolved: resolved, isOutdated: false, path, line: 4, comments: { nodes: [{ author: { login: 'coderabbitai', __typename: 'Bot' }, body: 'Fix this.' }] } });
  let pages = [
    { data: { repository: { pullRequest: { number: 3, reviewThreads: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [node('PRRT_1', false), node('PRRT_2', true)] } } } } },
    { data: { repository: { pullRequest: { number: 3, reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node('PRRT_3', false, null)] } } } } },
  ];
  const cli = new GitHubCli({ repositories: new Map([['repo', 'owner/repo']]), cwd: f.repo.directory, env: {}, execute: async (argv, input) => { calls.push({ argv, input }); return JSON.stringify(pages.shift()); } });
  const threads = await cli.listReviewThreads('repo', 3);
  assert.deepEqual(threads.map((thread) => thread.id), ['PRRT_1', 'PRRT_3']);
  assert.equal(threads[0].isBot, true); assert.equal(threads[1].path, null);
  assert.deepEqual(calls[0].argv, ['api', '--hostname', 'github.com', 'graphql', '--input', '-']);
  assert.equal(JSON.parse(calls[1].input).variables.after, 'c1');
  pages = [{ data: { repository: { pullRequest: { number: 3, reviewThreads: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [] } } } } }, { errors: [{ message: 'rate limited' }] }];
  await assert.rejects(cli.listReviewThreads('repo', 3), { code: 'GITHUB_OPERATION_UNCERTAIN' });
  pages = [{ data: { repository: { pullRequest: { number: 4, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }];
  await assert.rejects(cli.listReviewThreads('repo', 3), { code: 'OWNERSHIP_UNCERTAIN' });
});

test('GitHub CLI thread writes send JSON on stdin and honour the beforeSend claim', async (t) => {
  const { GitHubCli } = await import('../server/orchestration/adapters/github-cli.mjs');
  const f = await fixture(t), calls = [];
  const cli = new GitHubCli({ repositories: new Map([['repo', 'owner/repo']]), cwd: f.repo.directory, env: {}, execute: async (argv, input) => { calls.push({ argv, input }); return JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id: 'C1' } }, resolveReviewThread: { thread: { isResolved: true } } } }); } });
  await cli.replyToThread('repo', 'PRRT_1', 'Fixed in the latest commit.');
  assert.deepEqual(calls[0].argv, ['api', '--hostname', 'github.com', 'graphql', '--input', '-']);
  assert.equal(JSON.parse(calls[0].input).variables.threadId, 'PRRT_1');
  assert.ok(!calls[0].argv.join(' ').includes('Fixed in'));
  await cli.resolveThread('repo', 'PRRT_1');
  assert.equal(JSON.parse(calls[1].input).variables.threadId, 'PRRT_1');
  await cli.replyToThread('repo', 'PRRT_2', 'x', { beforeSend: () => false });
  assert.equal(calls.length, 2);
  await assert.rejects(cli.replyToThread('repo', 'bad id', 'x'));
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test tests/orchestration-publication.test.mjs`
Expected: the two new tests FAIL, `listReviewThreads is not a function`.

- [ ] **Step 3: Implement the methods in `github-cli.mjs`**

Add before `find`:

```js
  /** Unresolved review threads only; every page must arrive or the read fails closed.
   * @param {string} repositoryId @param {number} number @returns {Promise<import('../types.d.ts').ReviewThread[]>} */
  async listReviewThreads(repositoryId, number) {
    const slug = this.repository(repositoryId); integer(number, 1);
    const [owner, name] = slug.split('/');
    /** @type {import('../types.d.ts').ReviewThread[]} */ const threads = [];
    let after = null;
    for (let page = 1; page <= 10; page++) {
      const response = JSON.parse(await this.execute(['api', '--hostname', 'github.com', 'graphql', '--input', '-'], JSON.stringify({
        query: 'query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){number reviewThreads(first:50,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved path line comments(first:1){nodes{body author{login __typename}}}}}}}}',
        variables: { owner, name, number, after },
      })));
      const pull = response?.data?.repository?.pullRequest;
      requireValue(!response.errors && pull, 'GitHub review threads did not return confirmed data', 'GITHUB_OPERATION_UNCERTAIN');
      requireValue(pull.number === number && Array.isArray(pull.reviewThreads?.nodes) && pull.reviewThreads.pageInfo, 'GitHub review thread identity changed', 'OWNERSHIP_UNCERTAIN');
      for (const node of pull.reviewThreads.nodes) {
        requireValue(typeof node.id === 'string' && typeof node.isResolved === 'boolean', 'GitHub review thread shape changed', 'OWNERSHIP_UNCERTAIN');
        if (node.isResolved) continue;
        const first = node.comments?.nodes?.[0];
        threads.push({ id: identifier(node.id), path: typeof node.path === 'string' ? node.path : null, line: Number.isSafeInteger(node.line) && node.line > 0 ? node.line : null,
          author: typeof first?.author?.login === 'string' ? first.author.login.slice(0, 200) : 'unknown', body: typeof first?.body === 'string' ? first.body.slice(0, 16000) : '', isBot: first?.author?.__typename === 'Bot' });
      }
      if (!pull.reviewThreads.pageInfo.hasNextPage) return threads;
      after = pull.reviewThreads.pageInfo.endCursor; requireValue(typeof after === 'string', 'GitHub pagination cursor missing', 'GITHUB_OPERATION_UNCERTAIN');
    }
    throw new DomainError('OWNERSHIP_UNCERTAIN', 'GitHub review thread inventory exceeded the bounded observation limit');
  }
  /** @param {string} repositoryId @param {string} threadId @param {string} body @param {{ beforeSend?: () => boolean }} [options] */
  async replyToThread(repositoryId, threadId, body, { beforeSend } = {}) {
    this.repository(repositoryId); identifier(threadId); text(body, 8000);
    if (beforeSend && !beforeSend()) return;
    const response = JSON.parse(await this.execute(['api', '--hostname', 'github.com', 'graphql', '--input', '-'], JSON.stringify({
      query: 'mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id}}}', variables: { threadId, body },
    })));
    requireValue(!response.errors && response.data?.addPullRequestReviewThreadReply?.comment?.id, 'Thread reply was not confirmed', 'GITHUB_OPERATION_UNCERTAIN');
  }
  /** @param {string} repositoryId @param {string} threadId @param {{ beforeSend?: () => boolean }} [options] */
  async resolveThread(repositoryId, threadId, { beforeSend } = {}) {
    this.repository(repositoryId); identifier(threadId);
    if (beforeSend && !beforeSend()) return;
    const response = JSON.parse(await this.execute(['api', '--hostname', 'github.com', 'graphql', '--input', '-'], JSON.stringify({
      query: 'mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}', variables: { threadId },
    })));
    requireValue(!response.errors && response.data?.resolveReviewThread?.thread?.isResolved === true, 'Thread resolution was not confirmed', 'GITHUB_OPERATION_UNCERTAIN');
  }
```

Import `text` from `../domain/contracts.mjs` in the first import line. GitHub node ids like `PRRT_kwDOA...` match `identifier` (letters, digits, `_`, `-`).

- [ ] **Step 4: Run, then commit**

Run: `node --test tests/orchestration-publication.test.mjs`
Expected: pass.

```bash
git add server/orchestration/adapters/github-cli.mjs tests/orchestration-publication.test.mjs
git commit -m "feat: read and answer PR review threads through the GitHub CLI boundary"
```

### Task 6: Publication adapter round effects and the fake GitHub

**Files:**
- Modify: `server/orchestration/adapters/github.mjs`
- Modify: `tests/helpers/orchestration/fake-github.mjs`
- Test: `tests/orchestration-publication.test.mjs`

- [ ] **Step 1: Extend the fake**

In `tests/helpers/orchestration/fake-github.mjs` add to the constructor: `this.threads = new Map(); this.replies = []; this.resolutions = []; this.loseReplyResponse = false; this.threadsUnavailable = false;` and the methods:

```js
  async listReviewThreads(repositoryId, number) {
    if (this.threadsUnavailable) throw new Error('GraphQL unavailable');
    if (!this.pulls.some(pr => pr.repositoryId === repositoryId && pr.number === number)) throw new Error('PR not found');
    return structuredClone(this.threads.get(number) ?? []).filter(thread => !thread.resolved).map(({ resolved, ...thread }) => thread);
  }
  async replyToThread(repositoryId, threadId, body, { beforeSend } = {}) {
    if (beforeSend && !beforeSend()) return;
    this.replies.push({ repositoryId, threadId, body });
    if (this.loseReplyResponse) throw new Error('Lost reply response');
  }
  async resolveThread(repositoryId, threadId, { beforeSend } = {}) {
    if (beforeSend && !beforeSend()) return;
    this.resolutions.push({ repositoryId, threadId });
    for (const list of this.threads.values()) for (const thread of list) if (thread.id === threadId) thread.resolved = true;
  }
```

- [ ] **Step 2: Write the failing adapter tests**

Append to `tests/orchestration-publication.test.mjs`:

```js
async function delivered(t) {
  const f = await fixture(t);
  assert.equal((await f.publisher.publish(f.input)).status, 'published');
  const pr = { number: 1, url: f.github.pulls[0].url, headSha: f.input.headSha };
  f.github.threads.set(1, [{ id: 'PRRT_1', path: 'src/a.mjs', line: 1, author: 'coderabbitai', body: 'Return 2.', isBot: true }, { id: 'PRRT_2', path: null, line: null, author: 'alex', body: 'Nit.', isBot: false }]);
  return { ...f, pr };
}

test('review threads are read for the exact saved PR and fail closed when unavailable', async (t) => {
  const f = await delivered(t);
  const threads = await f.publisher.reviewThreads(f.input, f.pr);
  assert.deepEqual(threads.map(thread => thread.id), ['PRRT_1', 'PRRT_2']);
  await assert.rejects(f.publisher.reviewThreads(f.input, { ...f.pr, number: 9 }));
  f.github.threadsUnavailable = true;
  await assert.rejects(f.publisher.reviewThreads(f.input, f.pr));
});

test('a fix push is leased against the recorded PR head and reports movement or uncertainty', async (t) => {
  const f = await delivered(t);
  const fixWorktree = await f.repo.checkout('fix', f.input.headSha);
  await writeFile(join(fixWorktree.worktree, 'src/a.mjs'), 'export function a() { return 2; } // fixed\n');
  await fixtureGit(fixWorktree.worktree, ['add', 'src']); await fixtureGit(fixWorktree.worktree, ['commit', '-m', 'Address review']);
  const fixHead = await fixtureGit(fixWorktree.worktree, ['rev-parse', 'HEAD']);
  assert.equal(await f.publisher.pushFix(f.input, { roundId: 'r1', expectedHead: f.input.headSha, headSha: fixHead }), 'pushed');
  assert.equal(await f.remote.head('repo', f.input.branch), fixHead);
  // A second call with the same round is idempotent.
  assert.equal(await f.publisher.pushFix(f.input, { roundId: 'r1', expectedHead: f.input.headSha, headSha: fixHead }), 'pushed');
  // A human moved the branch: the lease refuses and nothing changes.
  await fixtureGit(f.repo.repository, ['push', f.repo.remote, `${f.input.headSha}:refs/heads/${f.input.branch}`, '--force']);
  assert.equal(await f.publisher.pushFix(f.input, { roundId: 'r2', expectedHead: fixHead, headSha: fixHead }), 'remote_moved');
  assert.equal(await f.remote.head('repo', f.input.branch), f.input.headSha);
});

test('replies post once per thread, resolve fixed threads, and never resend after a lost response', async (t) => {
  const f = await delivered(t);
  const replies = [{ threadId: 'PRRT_1', action: 'fixed', body: 'Fixed.' }, { threadId: 'PRRT_2', action: 'declined', body: 'Out of scope.' }];
  f.github.loseReplyResponse = true;
  await assert.rejects(f.publisher.replyAndResolve(f.input, { roundId: 'r1', replies }), /Lost reply response/);
  f.github.loseReplyResponse = false;
  const outcome = await new GitHubPublication(f.options).replyAndResolve(f.input, { roundId: 'r1', replies });
  assert.deepEqual(outcome.unconfirmed, ['PRRT_1']); assert.deepEqual(outcome.posted, ['PRRT_2']); assert.deepEqual(outcome.resolved, ['PRRT_1']);
  assert.equal(f.github.replies.length, 2, 'the lost reply was sent once and never repeated');
  assert.equal(f.github.resolutions.length, 1);
  const again = await new GitHubPublication(f.options).replyAndResolve(f.input, { roundId: 'r1', replies });
  assert.deepEqual(again, outcome); assert.equal(f.github.replies.length, 2);
});
```

Add `import { writeFile } from 'node:fs/promises';` at the top if not present.

- [ ] **Step 3: Run it to see it fail**

Run: `node --test tests/orchestration-publication.test.mjs`
Expected: three new tests FAIL.

- [ ] **Step 4: Implement in `github.mjs`**

Add after `observeMerge`:

```js
  /** @param {import('../types.d.ts').PublicationInput} input @param {NonNullable<import('../types.d.ts').Goal['pr']>} pr */
  async reviewThreads(input, pr) {
    requireValue(this.github.listReviewThreads && this.github.readPull, 'GitHub review threads are unavailable', 'UNSUPPORTED_CAPABILITY');
    const observed = await this.github.readPull(input.repositoryId, pr.number);
    requireValue(observed.number === pr.number && observed.url === pr.url, 'Saved PR identity changed', 'STALE_TARGET');
    return this.github.listReviewThreads(input.repositoryId, pr.number);
  }
  /** Sent marker per round; a lost response is resolved by reading the remote head.
   * @param {import('../types.d.ts').PublicationInput} input @param {{ roundId: string; expectedHead: string; headSha: string }} fix
   * @returns {Promise<'pushed' | 'remote_moved' | 'unknown'>} */
  async pushFix(input, fix) {
    const { directory } = this.request(input); identifier(fix.roundId); sha(fix.expectedHead); sha(fix.headSha);
    const path = join(directory, `fix.${fix.roundId}.push.sent.json`);
    const current = await this.remote.head(input.repositoryId, input.branch);
    if (current === fix.headSha) return 'pushed';
    if (pathExists(path)) {
      // A request went out before. Only the remote head can say what happened.
      requireValue(JSON.stringify(this.read(path)) === JSON.stringify({ roundId: fix.roundId, expectedHead: fix.expectedHead, headSha: fix.headSha }), 'Fix push request was reused', 'IDEMPOTENCY_CONFLICT');
      return current === fix.expectedHead ? 'unknown' : 'remote_moved';
    }
    if (current !== fix.expectedHead) return 'remote_moved';
    let claimed = false;
    try {
      await this.remote.push({ repositoryId: input.repositoryId, branch: input.branch, headSha: fix.headSha, expectedHead: fix.expectedHead }, { beforeSend: () => { claimed = this.claim(path, { roundId: fix.roundId, expectedHead: fix.expectedHead, headSha: fix.headSha }); if (claimed) this.failpoint('fix_push_sent'); return claimed; } });
    } catch (error) {
      if (claimed && error instanceof DomainError && error.code === 'EXTERNAL_NOT_SENT') { unlinkSync(path); return 'remote_moved'; }
      return 'unknown';
    }
    const pushed = await this.remote.head(input.repositoryId, input.branch);
    return pushed === fix.headSha ? 'pushed' : pushed === fix.expectedHead ? 'remote_moved' : 'unknown';
  }
  /** One sent marker per thread write. Lost responses become unconfirmed, never re-sent.
   * @param {import('../types.d.ts').PublicationInput} input @param {{ roundId: string; replies: import('../types.d.ts').ReviewReply[] }} fix */
  async replyAndResolve(input, fix) {
    const { directory } = this.request(input); identifier(fix.roundId);
    requireValue(this.github.replyToThread && this.github.resolveThread, 'GitHub thread writes are unavailable', 'UNSUPPORTED_CAPABILITY');
    /** @type {string[]} */ const posted = [], unconfirmed = [], resolved = [];
    for (const reply of fix.replies) {
      const sent = join(directory, `fix.${fix.roundId}.reply.${reply.threadId}.sent.json`), done = `${sent.slice(0, -'.sent.json'.length)}.done.json`;
      if (pathExists(done)) posted.push(reply.threadId);
      else if (pathExists(sent)) unconfirmed.push(reply.threadId);
      else {
        let claimed = false;
        try {
          await this.github.replyToThread(input.repositoryId, reply.threadId, reply.body, { beforeSend: () => { claimed = this.claim(sent, { roundId: fix.roundId, threadId: reply.threadId }); if (claimed) this.failpoint('fix_reply_sent'); return claimed; } });
          if (claimed) { this.save(done, { roundId: fix.roundId, threadId: reply.threadId }); posted.push(reply.threadId); }
        } catch (error) {
          if (claimed && error instanceof DomainError && error.code === 'EXTERNAL_NOT_SENT') { unlinkSync(sent); }
          throw error;
        }
      }
      if (reply.action !== 'fixed') continue;
      const resolveSent = join(directory, `fix.${fix.roundId}.resolve.${reply.threadId}.sent.json`);
      if (pathExists(resolveSent)) { resolved.push(reply.threadId); continue; }
      let claimed = false;
      try {
        await this.github.resolveThread(input.repositoryId, reply.threadId, { beforeSend: () => { claimed = this.claim(resolveSent, { roundId: fix.roundId, threadId: reply.threadId }); return claimed; } });
        if (claimed) resolved.push(reply.threadId);
      } catch (error) {
        if (claimed && error instanceof DomainError && error.code === 'EXTERNAL_NOT_SENT') unlinkSync(resolveSent);
        throw error;
      }
    }
    return { posted, unconfirmed, resolved };
  }
```

Note on the `unconfirmed` test: the first call throws after the reply was sent (marker exists, no done file). The second call sees the marker, records `PRRT_1` as unconfirmed, still resolves it because the fixer marked it fixed, then posts `PRRT_2`. The third call reproduces the same outcome from markers alone.

- [ ] **Step 5: Run, then commit**

Run: `node --test tests/orchestration-publication.test.mjs`
Expected: pass.

```bash
git add server/orchestration/adapters/github.mjs tests/helpers/orchestration/fake-github.mjs tests/orchestration-publication.test.mjs
git commit -m "feat: push review fixes and answer threads with sent markers"
```

### Task 7: Agent integration for the fixer role

**Files:**
- Modify: `server/orchestration/adapters/role-prompts.mjs`
- Modify: `server/orchestration/adapters/ccs.mjs`
- Modify: `server/orchestration/agent-mcp.mjs`
- Modify: `server/orchestration/agent-tools.mjs`
- Modify: `server/orchestration/adapters/agent-commits.mjs`
- Modify: `server/orchestration/adapters/native-background.mjs`
- Modify: `server/orchestration/adapters/native-inputs.mjs`
- Modify: `server/orchestration/agent-results.mjs`
- Test: `tests/orchestration-role-results.test.mjs`, `tests/orchestration-review-fix.test.mjs`

- [ ] **Step 1: Write the failing prompt test**

Append to `tests/orchestration-role-results.test.mjs`:

```js
test('the review fixer prompt pins the threads, forbids pushing and demands one reply per thread', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  f.command('record_review_threads', { roundId: f.goal.reviewRound.id, threads: [{ id: 'PRRT_1', path: 'src/a.mjs', line: 1, author: 'coderabbitai', body: 'Return two.', isBot: true }] });
  f.request('fx', 'review_fixer');
  const attempt = f.goal.attempts.at(-1), context = roleContext(f.goal, attempt), prompt = rolePrompt(f.goal, attempt);
  assert.equal(context.requiredAccess, 'assigned-worktree'); assert.equal(context.reviewThreads.length, 1); assert.equal(context.reviewThreads[0].id, 'PRRT_1');
  assert.match(prompt, /never push/i); assert.match(prompt, /exactly one reply per thread/i); assert.match(prompt, /replies:\[\{threadId,action,body\}\]/);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test tests/orchestration-role-results.test.mjs`
Expected: FAIL, `reviewThreads` undefined.

- [ ] **Step 3: Prompt and context**

In `role-prompts.mjs` `roleContext`, add to the returned object:

```js
    reviewThreads: attempt.role === 'review_fixer' ? (goal.reviewRound?.threads ?? []) : [],
    prHeadSha: attempt.role === 'review_fixer' ? goal.reviewRound?.prHeadSha ?? null : null,
```

and change `requiredAccess`: the fixer is `'assigned-worktree'`, which the existing ternary already yields for any role other than reviewer and planner.

In `rolePrompt` add to `instructions`:

```js
    review_fixer: 'Address the pinned pull request review threads inside the approved contract scope. For each thread decide: fixed (change the code and commit), declined (explain briefly why not), or comment (answer a question). Write each reply body as a short professional GitHub comment. Never push, never resolve threads, never change files outside the contract owned areas. Commit with companion.commit_candidate when you change code; report the resulting headSha. If you change nothing, report the recorded PR head as headSha. Provide exactly one reply per thread.',
```

Change the output protocol line so the fixer gets its shape. Replace the final ternary chain with:

```js
    plannerMcp ? '...' : attempt.role === 'planner' ? 'output: {contract: <schemaVersion:2 contract>} or {question: <one focused question>}' : attempt.role === 'reviewer'
      ? 'output: {schemaVersion:1,target,disposition,findings:[{id,severity,blocking,title,evidence,suggestion}]}'
      : attempt.role === 'review_fixer'
        ? 'output: {headSha,summary,replies:[{threadId,action,body}]}. action is fixed, declined or comment. Provide exactly one reply per thread id from the pinned reviewThreads.'
        : `output: {headSha,${attempt.role === 'integrator' ? 'operationId,' : ''}summary,evidence:[{path,line,description}]}. Evidence paths are repository-relative and lines are positive integers.`,
```

Keep the existing plannerMcp string unchanged where the `'...'` placeholder appears above; only the ternary tail changes.

- [ ] **Step 4: Tool allow-lists and commit right**

`ccs.mjs`: add to `NATIVE_TOOLS` and `BRIDGE_TOOLS`:

```js
  review_fixer: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
```
```js
  review_fixer: ['mcp__companion__read_reference', 'mcp__companion__get_status', 'mcp__companion__commit_candidate'],
```

`agent-mcp.mjs` line 37: the role tool list includes the fixer:

```js
const roleTools = (role) => role === 'planner' ? ['read_reference', 'get_status', 'submit_result'] : ['implementer', 'integrator', 'review_fixer'].includes(role) ? ['read_reference', 'get_status', 'commit_candidate'] : ['read_reference', 'get_status'];
```

`agent-tools.mjs` `authorize`: allow the fixer while the round is fixing.

```js
      const fixing = goal.status === 'addressing_review' && goal.reviewRound?.state === 'fixing' && authority.role === 'review_fixer';
      requireValue(this.service.repositoryIds.has(goal.repositoryId) && (fixing || (goal.status === 'building' && goal.approvedRevision === goal.revision && ['implementer', 'integrator'].includes(authority.role))), 'This attempt cannot commit', 'FORBIDDEN');
```

`agent-commits.mjs` line 24:

```js
    requireValue(['implementer', 'integrator', 'review_fixer'].includes(attempt.role), 'This role cannot commit', 'FORBIDDEN');
```

`native-background.mjs` lines 33 and 34: add `'review_fixer'` to both role lists.

`native-inputs.mjs` line 51: the else branch already covers every non-planner, non-reviewer role, so the fixer gets the "Edit only the assigned scope" instruction. No change.

- [ ] **Step 5: Route the fixer result through Git proof**

In `agent-results.mjs` `drain`, extend the Git-proof branch:

```js
        if (parsed.role === 'implementer' || parsed.role === 'integrator' || parsed.role === 'review_fixer') {
          requireValue(this.repositories, 'Repository evidence verification is unavailable', 'UNSUPPORTED_CAPABILITY');
          requireValue(this.service.repositoryIds.has(goal.repositoryId), 'Repository is no longer allowed', 'FORBIDDEN');
          if (parsed.role === 'review_fixer') {
            const round = goal.reviewRound; requireValue(round && round.attemptId === attempt.id, 'Review round changed', 'STALE_TARGET');
            if (parsed.output.headSha !== round.prHeadSha) {
              const proof = await this.repositories.candidate({ repositoryId: goal.repositoryId, attempt, headSha: parsed.output.headSha, ownedAreas: [...new Set(currentContract(goal).tasks.flatMap((entry) => entry.ownedAreas))] });
              requireValue(proof.headSha === parsed.output.headSha, 'Git proof targets a different fix', 'STALE_TARGET');
              this.artifacts.get(proof.artifactId);
            }
            this.service.execute({ id: this.id(), goalId: goal.id, expectedVersion: goal.version, type: 'accept_review_fix_result', payload: { attemptId: attempt.id, headSha: parsed.output.headSha, summary: parsed.output.summary, replies: parsed.output.replies } }, { kind: 'system' });
            const latest = this.store.get(goal.id), saved = latest?.results?.find((entry) => entry.id === pending.id);
            if (saved?.status === 'pending') this.service.execute({ id: this.id(), goalId: goal.id, expectedVersion: latest.version, type: 'mark_result_accepted', payload: { resultId: pending.id } }, { kind: 'system' });
            continue;
          }
          const task = goal.tasks.find((entry) => entry.id === attempt.taskId);
```

Add the small `mark_result_accepted` command in `transitions.mjs` next to `reject_role_result`:

```js
    case 'mark_result_accepted': {
      requireAuthority(authority, 'system');
      const submission = goal.results?.find((entry) => entry.id === input.resultId);
      requireValue(submission?.status === 'pending' && !submission.repair, 'Result is not pending', 'STALE_ATTEMPT');
      submission.status = 'accepted';
      emit('agent_result_accepted', { resultId: submission.id, attemptId: submission.attemptId, artifactId: submission.artifactId }); break;
    }
```

Import `currentContract` in `agent-results.mjs` from `./domain/transitions.mjs`.

- [ ] **Step 6: Add a result-intake test**

Append to `tests/orchestration-review-fix.test.mjs`:

```js
test('a fixer result with the PR head and replies only is accepted without Git proof', () => {
  const f = fixture(); f.deliver(); f.command('request_review_fix', {}, f.user);
  f.command('record_review_threads', { roundId: f.goal.reviewRound.id, threads: threads() });
  f.request('fx', 'review_fixer'); f.dispatch('fx');
  f.command('receive_role_result', { resultId: 'res1', attemptId: 'fx', artifactId: 'b'.repeat(64) });
  f.command('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_B, summary: 'Answered', replies: replies('comment') });
  f.command('mark_result_accepted', { resultId: 'res1' });
  assert.equal(f.goal.results[0].status, 'accepted'); assert.equal(f.goal.reviewRound.state, 'replying');
});
```

- [ ] **Step 7: Run, lint, typecheck, commit**

Run: `node --test tests/orchestration-role-results.test.mjs tests/orchestration-review-fix.test.mjs && npm run lint && npm run typecheck`
Expected: pass.

```bash
git add server/orchestration tests/orchestration-role-results.test.mjs tests/orchestration-review-fix.test.mjs
git commit -m "feat: let the review fixer edit, commit and report inside its round"
```

### Task 8: The review fix coordinator

**Files:**
- Create: `server/orchestration/review-fix-coordinator.mjs`
- Modify: `server/orchestration/scheduler.mjs`
- Modify: `server/orchestration/verification-coordinator.mjs`
- Test: `tests/orchestration-review-fix.test.mjs`

- [ ] **Step 1: Write the failing coordinator tests**

Append to `tests/orchestration-review-fix.test.mjs`:

```js
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { OrchestrationService } from '../server/orchestration/service.mjs';
import { ReviewFixCoordinator } from '../server/orchestration/review-fix-coordinator.mjs';

function coordinatorFixture(t) {
  const store = new OrchestrationStore({ path: ':memory:' }); t.after(() => store.close());
  const agents = { capabilities: [{ role: 'planner', mode: 'interactive' }, ...['implementer', 'reviewer', 'integrator', 'review_fixer'].map((role) => ({ role, mode: 'background' }))] };
  const service = new OrchestrationService({ store, agents, repositoryIds: new Set(['repo']) });
  const f = fixture(); f.deliver();
  store.apply({ id: 'seed', goalId: 'goal', expectedVersion: 0, type: 'create_goal', payload: {} }, { kind: 'user' }, () => ({ goal: f.goal, events: [], intents: [] }));
  const calls = { threads: 0, pushes: [], replies: [] };
  const publisher = {
    threads: threads(), threadsError: null, pushResult: 'pushed', replyOutcome: { posted: ['PRRT_1', 'PRRT_2'], unconfirmed: [], resolved: ['PRRT_1'] },
    async reviewThreads() { calls.threads++; if (publisher.threadsError) throw publisher.threadsError; return publisher.threads; },
    async pushFix(plan, fix) { calls.pushes.push(fix); return publisher.pushResult; },
    async replyAndResolve(plan, fix) { calls.replies.push(fix); return publisher.replyOutcome; },
  };
  const coordinator = new ReviewFixCoordinator({ service, publisher, ownership: { assertOwned() {} }, now: () => 1000, id: (() => { let n = 0; return () => `id${++n}`; })() });
  const user = (type, payload = {}) => service.execute({ id: `u${Date.now()}${Math.random()}`, goalId: 'goal', expectedVersion: store.get('goal').version, type, payload }, { kind: 'user' });
  const system = (type, payload = {}) => service.execute({ id: `s${Date.now()}${Math.random()}`, goalId: 'goal', expectedVersion: store.get('goal').version, type, payload }, { kind: 'system' });
  return { store, service, publisher, coordinator, calls, user, system };
}
const settle = (coordinator) => Promise.all(coordinator.active.values());

test('the coordinator fetches threads once and settles an empty round without an attempt', async (t) => {
  const f = coordinatorFixture(t); f.publisher.threads = [];
  f.user('request_review_fix');
  await f.coordinator.run(); await settle(f.coordinator); await f.coordinator.run();
  assert.equal(f.calls.threads, 1);
  const goal = f.store.get('goal');
  assert.equal(goal.status, 'delivered'); assert.equal(goal.reviewRounds[0].outcome, 'nothing_to_address'); assert.equal(goal.attempts.filter(a => a.role === 'review_fixer').length, 0);
});

test('an unavailable GitHub read fails the round with a sanitized hold', async (t) => {
  const f = coordinatorFixture(t); f.publisher.threadsError = new Error('secret token in output');
  f.user('request_review_fix');
  await f.coordinator.run(); await settle(f.coordinator);
  const goal = f.store.get('goal');
  assert.equal(goal.reviewRound.state, 'failed'); assert.equal(goal.hold.reasons[0].kind, 'review_fix');
  assert.doesNotMatch(JSON.stringify(goal), /secret token/);
});

test('threads become fixing work; a replies-only result skips verification, pushes nothing and replies', async (t) => {
  const f = coordinatorFixture(t);
  f.user('request_review_fix'); await f.coordinator.run(); await settle(f.coordinator);
  let goal = f.store.get('goal'); assert.equal(goal.reviewRound.state, 'fixing'); assert.equal(f.store.ready().length, 1);
  f.system('request_attempt', { attemptId: 'fx', operationId: 'opfx', role: 'review_fixer', taskId: null, conversationId: 'cfx' });
  f.system('record_dispatch', { attemptId: 'fx', identity: 'w', worktree: '/tmp/fx', branch: 'companion/goal/fx' });
  f.system('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_B, summary: 's', replies: replies('declined') });
  f.system('record_stopped', { attemptId: 'fx' });
  await f.coordinator.run(); await settle(f.coordinator);
  goal = f.store.get('goal');
  assert.equal(f.calls.pushes.length, 0); assert.equal(f.calls.replies.length, 1);
  assert.equal(goal.status, 'delivered'); assert.equal(goal.pr.headSha, HEAD_B); assert.equal(goal.reviewRounds[0].outcome, 'addressed');
});

test('a fixed result requests verification, then pushes and replies after the checks pass', async (t) => {
  const f = coordinatorFixture(t);
  f.user('request_review_fix'); await f.coordinator.run(); await settle(f.coordinator);
  f.system('request_attempt', { attemptId: 'fx', operationId: 'opfx', role: 'review_fixer', taskId: null, conversationId: 'cfx' });
  f.system('record_dispatch', { attemptId: 'fx', identity: 'w', worktree: '/tmp/fx', branch: 'companion/goal/fx' });
  f.system('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 's', replies: replies('fixed') });
  f.system('record_stopped', { attemptId: 'fx' });
  await f.coordinator.run(); await settle(f.coordinator);
  let goal = f.store.get('goal');
  assert.equal(goal.reviewRound.state, 'verifying'); const operationId = goal.reviewRound.verificationOperationId; assert.ok(operationId);
  assert.equal(f.store.operations().find(op => op.id === operationId)?.kind, 'verify');
  assert.equal(f.calls.pushes.length, 0);
  f.system('record_verification_result', { operationId, result: { verification: { headSha: HEAD_C, checks: [{ id: 'unit', passed: true, artifactId: 'log' }] }, workerState: 'stopped', artifactId: 'a'.repeat(64) } });
  await f.coordinator.run(); await settle(f.coordinator); await f.coordinator.run(); await settle(f.coordinator);
  goal = f.store.get('goal');
  assert.deepEqual(f.calls.pushes[0], { roundId: goal.reviewRounds[0].id, expectedHead: HEAD_B, headSha: HEAD_C });
  assert.equal(goal.status, 'delivered'); assert.equal(goal.pr.headSha, HEAD_C); assert.deepEqual(goal.reviewRounds[0].resolved, ['PRRT_1']);
});

test('a moved remote head fails the round before any reply; an unknown push holds until confirmed', async (t) => {
  for (const [result, state] of [['remote_moved', 'failed'], ['unknown', 'unknown']]) {
    const f = coordinatorFixture(t); f.publisher.pushResult = result;
    f.user('request_review_fix'); await f.coordinator.run(); await settle(f.coordinator);
    f.system('request_attempt', { attemptId: 'fx', operationId: 'opfx', role: 'review_fixer', taskId: null, conversationId: 'cfx' });
    f.system('record_dispatch', { attemptId: 'fx', identity: 'w', worktree: '/tmp/fx', branch: 'companion/goal/fx' });
    f.system('accept_review_fix_result', { attemptId: 'fx', headSha: HEAD_C, summary: 's', replies: replies('fixed') });
    f.system('record_stopped', { attemptId: 'fx' });
    await f.coordinator.run(); await settle(f.coordinator);
    const operationId = f.store.get('goal').reviewRound.verificationOperationId;
    f.system('record_verification_result', { operationId, result: { verification: { headSha: HEAD_C, checks: [{ id: 'unit', passed: true, artifactId: 'log' }] }, workerState: 'stopped', artifactId: 'a'.repeat(64) } });
    await f.coordinator.run(); await settle(f.coordinator); await f.coordinator.run(); await settle(f.coordinator);
    const goal = f.store.get('goal');
    assert.equal(goal.reviewRound.state, state); assert.equal(f.calls.replies.length, 0); assert.equal(goal.pr.headSha, HEAD_B); assert.ok(goal.hold);
    if (result === 'unknown') {
      f.publisher.pushResult = 'pushed';
      await f.coordinator.run(); await settle(f.coordinator); await f.coordinator.run(); await settle(f.coordinator);
      assert.equal(f.store.get('goal').status, 'delivered'); assert.equal(f.store.get('goal').pr.headSha, HEAD_C);
    }
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test tests/orchestration-review-fix.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Create the coordinator**

Create `server/orchestration/review-fix-coordinator.mjs`:

```js
import { randomUUID } from 'node:crypto';
import { DomainError, requireValue } from './domain/contracts.mjs';

/** Drives one review round per goal: fetch threads, request fix verification,
 * push the fix, answer threads, settle. Every remote effect runs in a background
 * job under the scheduler's ownership fence; a lost response never repeats a write.
 */
export class ReviewFixCoordinator {
  /** @param {{ service: import('./service.mjs').OrchestrationService; publisher: import('./types.d.ts').PublicationPort; ownership: { assertOwned(): void }; now?: () => number; id?: () => string; onError?: (error: unknown) => void }} options */
  constructor({ service, publisher, ownership, now = Date.now, id = randomUUID, onError = () => {} }) {
    this.service = service; this.store = service.store; this.publisher = publisher; this.ownership = ownership; this.now = now; this.id = id; this.onError = onError; this.stopped = false;
    /** @type {Map<string, Promise<void>>} */ this.active = new Map();
  }
  /** @param {string} goalId @param {string} type @param {unknown} payload */
  record(goalId, type, payload) {
    this.ownership.assertOwned(); const goal = this.store.get(goalId); requireValue(goal, 'Review round goal disappeared');
    return this.service.execute({ id: this.id(), goalId, expectedVersion: goal.version, type, payload }, { kind: 'system' });
  }
  /** @param {string} goalId @param {string} roundId @param {string} code @param {string} message */
  fail(goalId, roundId, code, message) {
    const latest = this.store.get(goalId);
    if (latest?.reviewRound?.id === roundId && !['failed', 'unknown'].includes(latest.reviewRound.state)) this.record(goalId, 'fail_review_fix', { roundId, code, message });
  }
  /** @param {import('./types.d.ts').Goal} goal @param {(round: import('./types.d.ts').ReviewRound, plan: import('./types.d.ts').PublicationInput, pr: NonNullable<import('./types.d.ts').Goal['pr']>) => Promise<void>} work */
  spawn(goal, work) {
    const round = goal.reviewRound, plan = goal.publication?.plan, pr = goal.pr;
    requireValue(round && plan && pr, 'Review round has no publication');
    const job = Promise.resolve().then(async () => {
      if (this.stopped) return;
      try { await work(round, plan, pr); }
      catch (error) {
        this.ownership.assertOwned();
        if (error instanceof DomainError && error.code === 'VERSION_CONFLICT') return;
        /* Persist a sanitized message; never expose CLI output or credentials. */
        this.fail(goal.id, round.id, 'REVIEW_FIX_FAILED', 'Addressing review comments failed. Check GitHub access and retry.');
      }
    }).finally(() => this.active.delete(goal.id));
    this.active.set(goal.id, job); void job.catch(this.onError);
  }
  /** Same generation and round id, still active. @param {string} goalId @param {string} roundId */
  current(goalId, roundId) {
    const latest = this.store.get(goalId);
    return latest && latest.status === 'addressing_review' && latest.reviewRound?.id === roundId && this.service.repositoryIds.has(latest.repositoryId) ? latest : null;
  }
  async run() {
    if (this.stopped) return;
    this.ownership.assertOwned();
    for (const goal of this.store.list()) {
      const round = goal.reviewRound;
      if (goal.status !== 'addressing_review' || !round || !goal.pr || !goal.publication || this.active.has(goal.id) || !this.service.repositoryIds.has(goal.repositoryId)) continue;
      if (round.state === 'fetching') {
        this.spawn(goal, async (round, plan, pr) => {
          let threads;
          try { threads = await this.publisher.reviewThreads?.(plan, pr); requireValue(threads, 'GitHub review threads are unavailable', 'UNSUPPORTED_CAPABILITY'); }
          catch { this.ownership.assertOwned(); this.fail(goal.id, round.id, 'GITHUB_UNAVAILABLE', 'GitHub review threads were unavailable. Retry when your Mac is online.'); return; }
          this.ownership.assertOwned();
          if (this.current(goal.id, round.id)) this.record(goal.id, 'record_review_threads', { roundId: round.id, threads, at: this.now() });
        });
      } else if (round.state === 'verifying' && !round.verificationOperationId) {
        if (goal.hold || goal.attempts.some((attempt) => attempt.workerState !== 'stopped')) continue;
        try { this.record(goal.id, 'request_review_fix_verification', { roundId: round.id, operationId: this.id() }); }
        catch (error) { if (!(error instanceof DomainError) || !['NOT_READY', 'RETRY_REQUIRED'].includes(error.code)) throw error; }
      } else if (round.state === 'verifying' && round.verificationOperationId) {
        const run = goal.verificationRuns?.find((entry) => entry.operationId === round.verificationOperationId);
        if (run?.result && run.status !== 'pending') this.record(goal.id, 'record_review_fix_verification', { roundId: round.id, operationId: run.operationId });
      } else if (round.state === 'pushing' || round.state === 'unknown') {
        if (!round.fixHeadSha) continue;
        this.spawn(goal, async (round, plan) => {
          const result = await this.publisher.pushFix?.(plan, { roundId: round.id, expectedHead: round.prHeadSha, headSha: /** @type {string} */ (round.fixHeadSha) });
          this.ownership.assertOwned();
          if (!this.current(goal.id, round.id)) return;
          if (result === 'pushed') this.record(goal.id, 'record_review_fix_push', { roundId: round.id });
          else if (result === 'remote_moved') this.fail(goal.id, round.id, 'REMOTE_MOVED', 'The pull request branch moved on GitHub. Nothing was pushed or posted.');
          else if (round.state !== 'unknown') this.fail(goal.id, round.id, 'PUSH_UNCERTAIN', 'The fix push outcome is uncertain.');
        });
      } else if (round.state === 'replying') {
        this.spawn(goal, async (round, plan) => {
          const outcome = await this.publisher.replyAndResolve?.(plan, { roundId: round.id, replies: round.replies ?? [] });
          requireValue(outcome, 'GitHub thread writes are unavailable', 'UNSUPPORTED_CAPABILITY');
          this.ownership.assertOwned();
          if (this.current(goal.id, round.id)) this.record(goal.id, 'settle_review_fix', { roundId: round.id, ...outcome, at: this.now() });
        });
      }
    }
  }
  async stop() { this.stopped = true; await Promise.allSettled(this.active.values()); }
}
```

- [ ] **Step 4: Compose in the scheduler**

In `scheduler.mjs` import and construct:

```js
import { ReviewFixCoordinator } from './review-fix-coordinator.mjs';
```
```js
    this.reviewFixes = publisher ? new ReviewFixCoordinator({ service, publisher, ownership, id, onError }) : null;
```

In `start`, add `if (this.reviewFixes) this.reviewFixes.stopped = false;`. In `stop`, add `this.reviewFixes?.stop()` to the `Promise.allSettled` list. In `pass`, after `this.merges?.run();` add `await this.reviewFixes?.run();`.

In `dispatch`, `permitted` already allows `addressing_review` because it only excludes `aborted` and `merged`. No change.

- [ ] **Step 5: Let the verification coordinator run round verifications**

In `verification-coordinator.mjs`:

`cancelRevoked`: a run is current when the goal is `building` at the integration head, or `addressing_review` with a round whose `verificationOperationId` matches.

```js
  cancelRevoked() {
    for (const [operationId, run] of this.active) {
      const goal = this.store.get(run.goalId);
      const building = goal?.status === 'building' && goal.integrationHead === run.headSha;
      const fixing = goal?.status === 'addressing_review' && goal.reviewRound?.verificationOperationId === operationId && goal.reviewRound.fixHeadSha === run.headSha;
      if (!goal || !(building || fixing) || goal.generation !== run.generation || goal.revision !== run.revision || !this.service.repositoryIds.has(goal.repositoryId)) run.controller.abort();
    }
  }
```

In `run`, the `permitted` computation for a pending operation becomes:

```js
      const fixing = goal.status === 'addressing_review' && goal.reviewRound?.verificationOperationId === operation.id && goal.reviewRound.fixHeadSha === run.headSha;
      const permitted = ((goal.status === 'building' && goal.integrationHead === run.headSha) || fixing) && goal.generation === operation.generation && goal.revision === operation.revision && this.service.repositoryIds.has(goal.repositoryId);
```

The sweep that requests `request_verification` still filters `goal.status !== 'building'`; that is correct, the round requests its own verification.

- [ ] **Step 6: Run the tests**

Run: `node --test tests/orchestration-review-fix.test.mjs tests/orchestration-scheduler.test.mjs tests/orchestration-verification-cleanup.test.mjs`
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add server/orchestration/review-fix-coordinator.mjs server/orchestration/scheduler.mjs server/orchestration/verification-coordinator.mjs tests/orchestration-review-fix.test.mjs
git commit -m "feat: coordinate review rounds through fetch, verify, push and reply"
```

### Task 9: Phase 2 verification

- [ ] **Step 1:** Run `npm test && npm run lint && npm run typecheck`. Expected: pass.
- [ ] **Step 2:** Run `npm run test:coverage`. Expected: backend line coverage at or above 90%. Add tests for uncovered branches in `review-fix-coordinator.mjs` if the gate fails.
- [ ] **Step 3:** Commit any fix separately.

---

## Phase 3: UI

### Task 10: Goal detail, fleet, attention and activity labels

**Files:**
- Modify: `app/orchestration/goal-detail.tsx`
- Modify: `app/orchestration/goal-fleet.tsx`
- Modify: `app/orchestration/attention.ts`
- Modify: `app/orchestration/goal-activity.tsx`
- Test: `tests/ui-orchestration.test.tsx`

- [ ] **Step 1: Write the failing UI tests**

Append to `tests/ui-orchestration.test.tsx`:

```tsx
test('a delivered goal offers the review round and a running round shows its phase and card', async () => {
  const { GoalDetail } = await import('../app/orchestration/goal-detail');
  const { goalStage } = await import('../app/orchestration/goal-fleet');
  const { goalView } = await import('../server/orchestration/domain/state-view.mjs');
  const { fixture } = await import('./helpers/orchestration/domain-fixture.mjs');
  const f = fixture(); f.deliver();
  const delivered = { ...goalView(f.goal), contracts: [] };
  const act = vi.fn().mockResolvedValue(true);
  const { unmount } = render(<GoalDetail goal={delivered} disabled={false} terminal={false} act={act} control={vi.fn()} />);
  const button = screen.getByRole('button', { name: 'Address review comments' });
  fireEvent.click(button);
  expect(act).toHaveBeenCalledWith(delivered, delivered.actions.find(action => action.type === 'request_review_fix'));
  unmount();
  f.command('request_review_fix', {}, f.user);
  f.command('record_review_threads', { roundId: f.goal.reviewRound.id, threads: [{ id: 'PRRT_1', path: 'src/a.mjs', line: 1, author: 'coderabbitai', body: 'Return two.', isBot: true }] });
  const fixing = { ...goalView(f.goal), contracts: [] };
  expect(goalStage(fixing)).toBe('Addressing review');
  render(<GoalDetail goal={fixing} disabled={false} terminal={false} act={act} control={vi.fn()} />);
  expect(screen.getByText(/ADDRESSING REVIEW · PLAN 1/i)).toBeTruthy();
  expect(screen.getByRole('status', { name: 'Review round phase' })).toHaveTextContent('Fixing 1 thread');
  expect(screen.queryByRole('button', { name: 'Address review comments' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Run report' }));
  expect(screen.getByRole('heading', { name: 'Review rounds' })).toBeTruthy();
  expect(screen.getByText('coderabbitai')).toBeTruthy();
});

test('a settled round lists each thread action and an unconfirmed reply', async () => {
  const { GoalDetail } = await import('../app/orchestration/goal-detail');
  const { goalView } = await import('../server/orchestration/domain/state-view.mjs');
  const { fixture, HEAD_B } = await import('./helpers/orchestration/domain-fixture.mjs');
  const f = fixture(); f.deliver();
  const view = { ...goalView(f.goal), contracts: [], reviewRounds: [{ id: 'r1', prHeadSha: HEAD_B, startedAt: 1, settledAt: 2, state: 'settled' as const, outcome: 'addressed' as const, fixHeadSha: 'd'.repeat(40),
    threads: [{ id: 'PRRT_1', path: 'src/a.mjs', line: 1, author: 'coderabbitai', body: 'Return two.', isBot: true }, { id: 'PRRT_2', path: null, line: null, author: 'alex', body: 'Nit.', isBot: false }],
    replies: [{ threadId: 'PRRT_1', action: 'fixed' as const, body: 'Fixed.' }, { threadId: 'PRRT_2', action: 'declined' as const, body: 'Out of scope.' }], posted: ['PRRT_2'], unconfirmed: ['PRRT_1'], resolved: ['PRRT_1'] }] };
  render(<GoalDetail goal={view} disabled={false} terminal={false} act={vi.fn()} control={vi.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Run report' }));
  expect(screen.getByText(/Addressed · 2 threads · new head dddddddddddd/)).toBeTruthy();
  expect(screen.getByText(/fixed · resolved · reply unconfirmed/)).toBeTruthy();
  expect(screen.getByText(/declined/)).toBeTruthy();
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:ui`
Expected: the two new tests FAIL.

- [ ] **Step 3: Implement the UI**

`goal-fleet.tsx` `goalStage`: add before the `delivered` line:

```ts
  if (goal.status === 'addressing_review') return 'Addressing review';
```

In the filter expression, the `Running` filter includes it: replace `['discovering', 'building'].includes(goal.status)` with `['discovering', 'building', 'addressing_review'].includes(goal.status)`. In the `mission-next` text add `goal.status === 'addressing_review' ? goal.reviewRound?.phase ?? 'Addressing review comments' :` before the `delivered` branch.

`attention.ts`: after the `delivered && closed` line add:

```ts
  if (goal.status === 'addressing_review' && goal.reviewRound?.state === 'unknown') return 'The fix push outcome is uncertain. Companion is confirming the remote branch.';
```

`goal-activity.tsx` labels: add

```ts
    review_fix_requested: 'Review round started', review_threads_recorded: 'Review threads fetched', review_fix_result_accepted: 'Review fix committed', review_fix_verification_requested: 'Fix verification requested', review_fix_verified: 'Fix verification passed', review_fix_pushed: 'Fix pushed to the pull request', review_fix_settled: 'Review round finished', review_fix_failed: 'Review round failed',
```

`goal-detail.tsx`: after the `delivered` status paragraph add:

```tsx
      {goal.status === 'addressing_review' && goal.reviewRound && <p role="status" aria-label="Review round phase">{goal.reviewRound.phase}{goal.reviewRound.error ? ` · ${goal.reviewRound.error}` : ''}</p>}
```

The eyebrow already renders `goalStage(goal)` upper-cased through CSS, so `ADDRESSING REVIEW · PLAN n` needs no change beyond `goalStage`.

In the Run report tab, add a card before the `Independent reviews` card:

```tsx
    {tab === 'Run report' && (goal.reviewRound || goal.reviewRounds.length > 0) && <section className="orch-card"><h3>Review rounds</h3>{[...(goal.reviewRound ? [goal.reviewRound] : []), ...goal.reviewRounds].map(round => <div className="orch-review" key={round.id}>
      <strong>{round.outcome === 'addressed' ? 'Addressed' : round.outcome === 'nothing_to_address' ? 'Nothing to address' : round.outcome === 'failed' ? 'Failed' : round.phase ?? round.state} · {round.threads.length} {round.threads.length === 1 ? 'thread' : 'threads'}{round.fixHeadSha ? ` · new head ${round.fixHeadSha.slice(0, 12)}` : ''}</strong>
      <p>Started {new Date(round.startedAt).toLocaleString()}{round.error ? ` · ${round.error}` : ''}</p>
      {round.threads.map(thread => { const reply = round.replies?.find(entry => entry.threadId === thread.id); return <blockquote key={thread.id}><strong>{thread.author}{thread.path ? ` · ${thread.path}${thread.line ? `:${thread.line}` : ''}` : ''}</strong><p>{thread.body}</p>{reply && <p><em>{reply.action}{round.resolved?.includes(thread.id) ? ' · resolved' : ''}{round.unconfirmed?.includes(thread.id) ? ' · reply unconfirmed' : ''}</em> {reply.body}</p>}</blockquote>; })}
    </div>)}</section>}
```

Update the "no evidence yet" condition in the Run report tab to also check `!goal.reviewRound && goal.reviewRounds.length === 0`.

The `Goal` type comes from `goalView`, so `reviewRound.phase` and `reviewRounds` type-check once Task 3 is in place.

- [ ] **Step 4: Run UI tests, lint and typecheck**

Run: `npm run test:ui && npm run lint && npm run typecheck`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add app/orchestration tests/ui-orchestration.test.tsx
git commit -m "feat: offer and report review rounds in the goal detail"
```

### Task 11: Phase 3 verification

- [ ] **Step 1:** Run `npm run test:ui:coverage`. Expected: UI line coverage at or above 90%.
- [ ] **Step 2:** Run `npm run verify`. Expected: pass.

---

## Phase 4: End-to-end, docs and cleanup

### Task 12: Scripted fixer and Cypress round

**Files:**
- Modify: `scripts/run-orchestration-dev.mjs`
- Modify: `cypress.config.ts`
- Modify: `cypress/e2e/orchestration-core.cy.ts`

- [ ] **Step 1: Script the fixer in the dev harness**

In `scripts/run-orchestration-dev.mjs`, inside the script before the reviewer fallthrough, add:

```js
              if (attempt.role === 'review_fixer') {
                const status = demo.runtime.store.get(goalId), threads = status?.reviewRound?.threads ?? [];
                await writeFile(join(attempt.worktree, 'src/a.mjs'), 'export function a() { return 2; } // addressed review\n');
                await fixtureGit(attempt.worktree, ['add', 'src']); await fixtureGit(attempt.worktree, ['commit', '-m', 'Address review comments']);
                return { headSha: await fixtureGit(attempt.worktree, ['rev-parse', 'HEAD']), summary: 'Addressed fixture review', replies: threads.map((thread, index) => ({ threadId: thread.id, action: index === 0 ? 'fixed' : 'declined', body: index === 0 ? 'Fixed in the latest commit.' : 'Out of scope for this goal.' })) };
              }
```

`demo` is assigned after `createDevelopmentServer` resolves; the script runs later, so the reference is valid. Add a Cypress task that seeds threads on the fake PR: in the evidence `record` object add `threads: [...(fixtureGithub?.threads.values() ?? [])].flat()`, and expose a seeding hook by writing a file the harness watches. Simplest: in the `browserHarness` branch, poll for `join(directory, 'seed-threads')` inside the existing `record` timer:

```js
        const seed = join(demo.manifest.directory, 'seed-threads');
        if (existsSync(seed) && fixtureGithub && !fixtureGithub.threads.size) for (const pr of fixtureGithub.pulls) fixtureGithub.threads.set(pr.number, [
          { id: `PRRT_${pr.number}_1`, path: 'src/a.mjs', line: 1, author: 'coderabbitai', body: 'Document why a returns two.', isBot: true },
          { id: `PRRT_${pr.number}_2`, path: null, line: null, author: 'alex', body: 'Consider a rename later.', isBot: false },
        ]);
```

Also record `replies: fixtureGithub?.replies ?? [], resolutions: fixtureGithub?.resolutions ?? []` in the evidence object.

- [ ] **Step 2: Cypress task**

In `cypress.config.ts`, `orchestrationRelease` already writes `release-<name>`. Add a `seed-threads` case: extend that task so `stage === 'seed-threads'` writes `join(manifest.directory, 'seed-threads')`. Read its current body first and keep the `reset` branch behaviour.

- [ ] **Step 3: Extend the publishing spec**

In `cypress/e2e/orchestration-core.cy.ts`, at the end of the `publishes one exact-head PR` test, before the `scrollWidth` assertion, add:

```ts
    cy.task('orchestrationRelease', 'seed-threads');
    cy.findByRole('button', { name: 'Address review comments', timeout: 30000 }).should('be.enabled').click();
    cy.findByRole('status', { name: 'Review round phase', timeout: 30000 }).should('be.visible');
    cy.findByRole('button', { name: 'Address review comments', timeout: 60000 }).should('be.enabled');
    cy.findByRole('tab', { name: 'Run report' }).click();
    cy.findByRole('heading', { name: 'Review rounds' }).should('be.visible');
    cy.contains(/Addressed · 2 threads/).should('be.visible');
    cy.task<Evidence & { replies: unknown[]; resolutions: unknown[] }>('orchestrationEvidence', { title: 'Build the parallel fixture', status: 'delivered' }).then(evidence => {
      const goal = evidence.goals.find(entry => entry.title === 'Build the parallel fixture')!;
      expect(goal.reviewRounds!).to.have.length(1); expect(goal.reviewRounds![0].outcome).to.equal('addressed');
      expect(goal.pr!.headSha).to.equal(goal.reviewRounds![0].fixHeadSha); expect(goal.mergeSync).to.equal(undefined);
      expect(evidence.replies).to.have.length(2); expect(evidence.resolutions).to.have.length(1);
      cy.task<string>('orchestrationGit', { branch: evidence.pulls[0].branch, file: 'src/a.mjs' }).should('include', 'addressed review');
    });
```

Update the `Evidence` type at the top to include `replies: unknown[]; resolutions: unknown[]`.

- [ ] **Step 4: Run the browser suite**

Run: `npm run test:e2e:local`. If Electron fails: `CMUX_COMPANION_CYPRESS_BROWSER=chrome npm run test:e2e:local`.
Expected: the orchestration spec passes, including the new round. Record the run output for the PR.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-orchestration-dev.mjs cypress.config.ts cypress/e2e/orchestration-core.cy.ts
git commit -m "test: run one review round in the browser orchestration journey"
```

### Task 13: Documentation

**Files:**
- Modify: `docs/code-review-workflow.md`
- Modify: `README.md`

- [ ] **Step 1:** Add a section `## Addressing review comments` to `docs/code-review-workflow.md` after `## Goal publication`:

```markdown
## Addressing review comments

A delivered goal offers `Address review comments`. One press runs one review
round: Companion reads every unresolved review thread on the PR, runs one
background fixer agent in a fresh worktree at the PR head with the integrator's
team profile and tool set, and requires the approved project checks to pass on
the fix head before any push. The push uses force-with-lease against the
recorded PR head; a moved branch fails the round and posts nothing. Companion
then posts exactly one reply per thread and resolves the threads the agent
marked fixed. Declined and comment threads stay open for the human. Each reply
is preceded by a sent marker, so a lost response is recorded as unconfirmed and
never re-sent. Rounds are manual and unlimited; only one round runs at a time.
A failed round holds the goal with the existing `Recover goal` action and
leaves the PR head unchanged. The round does not review the fix independently
and never merges, rebases or edits the target branch.
```

- [ ] **Step 2:** In `README.md`, under the product behaviour section that describes `Waiting for merge`, add one sentence: `While a goal waits for merge, "Address review comments" runs one agent round that fixes or answers every unresolved PR review thread and pushes the verified fix to the same PR; see docs/code-review-workflow.md.` Find the right paragraph with `grep -n "Waiting for merge\|waits for merge" README.md`.

- [ ] **Step 3:** Commit:

```bash
git add docs/code-review-workflow.md README.md
git commit -m "docs: describe the review comment round"
```

### Task 14: Final verification and PR

- [ ] **Step 1:** Run `npm run verify`. Expected: pass.
- [ ] **Step 2:** Run `npm run test:e2e:local` once more if any file changed after Task 12.
- [ ] **Step 3:** Confirm `git status` is clean apart from the pre-existing untracked files listed at session start.
- [ ] **Step 4:** Open a draft PR against `main` with the evidence: passed checks, the Cypress output, and the untested paths (live GitHub GraphQL against a real repository is not exercised locally). Do not mark it ready and do not merge; those remain user decisions.

---

## Self-review notes

- Spec coverage: status and commands (Tasks 2, 3), role and proof (Tasks 3, 7), GitHub port methods and sent markers (Tasks 5, 6), coordinator (Task 8), verification of the fix head and worktree removal (Task 8 reuses the verification coordinator, which already removes stopped runs), UI (Task 10), tests per acceptance criterion (Tasks 1 to 12), docs (Task 13), unlimited manual rounds (Task 2 guard `!goal.reviewRound`).
- Type names used across tasks: `ReviewRound`, `ReviewThread`, `ReviewReply`, `review_fixer`, `addressing_review`, `request_review_fix`, `record_review_threads`, `accept_review_fix_result`, `request_review_fix_verification`, `record_review_fix_verification`, `record_review_fix_push`, `settle_review_fix`, `fail_review_fix`, `mark_result_accepted`, `reviewThreads`, `pushFix`, `replyAndResolve`, `listReviewThreads`, `replyToThread`, `resolveThread`.
- Known simplification: the fixer's Git proof reuses `repositories.candidate`, which requires the fix head to be the attempt branch head and inside owned areas. That is the spec's requirement.
