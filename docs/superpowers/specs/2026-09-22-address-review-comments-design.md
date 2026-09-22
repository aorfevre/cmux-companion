# Address pull request review comments

Date: 2026-09-22
Status: Awaiting human review after this spec commit.
Owner: Implementing agent, including domain, adapters, UI, tests and cleanup.

## Problem

A delivered goal waits for merge on GitHub. CodeRabbit and human reviewers open
review threads on the pull request. Companion shows only "Waiting for merge".
The user must open GitHub, read every thread, fix the code by hand or start an
unrelated agent session, push, and reply. The goal's evidence chain stops at
the first PR head.

## Outcome

A delivered goal offers one action, `Address review comments`. One press runs
one review round. Companion fetches every unresolved review thread on the PR,
runs one agent in a fresh worktree at the PR head, verifies the fix head with
the approved project checks, pushes to the same PR branch, posts one reply per
thread, resolves the threads that were fixed, and returns the goal to
`delivered` with the new PR head. The merge check continues on that head.

## User journey

1. The user opens a goal in `Waiting for merge`. The Overview card shows
   `Address review comments` next to `Abort goal`. The button is disabled with
   a banner reason when the domain refuses the action.
2. The user presses the button. The eyebrow reads `ADDRESSING REVIEW · PLAN n`.
   A status line shows the phase: `Fetching review threads`, `Fixing n threads`,
   `Verifying fix`, `Pushing and replying`. Mission Control counts the goal
   under `Running`.
3. If the PR has zero unresolved review threads, the round ends at once with
   outcome `nothing_to_address` and the goal returns to `delivered`.
4. The agent fixes valid findings inside the approved scope, declines others
   with a reason, or leaves a comment. It commits and reports the new head and
   one reply per thread. It never pushes.
5. If at least one thread is `fixed`, verification runs prepare and the approved
   checks on the fix head. A failed check creates a hold with the existing
   `Recover goal` action. A round with replies only skips verification.
6. Companion pushes with force-with-lease against the recorded PR head. A moved
   remote head fails the round with reason `remote_moved`; nothing is posted.
7. Companion posts the replies and resolves `fixed` threads. Declined and
   comment threads stay open for the human.
8. The goal returns to `delivered`. The Run report tab lists the round with its
   threads, actions, reply text, outcome and new head. The fixer session appears
   in `Waves & sessions`.
9. The user may press the button again once the round settles. Rounds are
   unlimited and always manual.

## Domain

- New status `addressing_review`. Only a `delivered` goal with a recorded PR
  and `mergeSync.state` not `closed` enters it. The merge coordinator skips it.
- `request_review_fix` (user). Requires status `delivered`, no unsettled
  workers or verification runs, no active round. Records
  `reviewRound = { id, prHeadSha, threads: [], state: 'fetching' }`, sets status
  `addressing_review`, increments generation.
- `record_review_threads` (system). Stores
  `{ id, path, line, author, body, isBot }[]`. Zero threads settles the round
  with outcome `nothing_to_address`.
- `settle_review_fix` (system). Records pushed head, posted replies, resolved
  thread ids. Sets `pr.headSha` and `publication.headSha` to the new head,
  clears `mergeSync`, sets status `delivered`, appends the round to
  `reviewRounds`.
- Attempt role `review_fixer`, background mode, worktree at the PR head on a
  private branch. Result: `{ headSha, summary, replies: [{ threadId, action:
  'fixed' | 'declined' | 'comment', body }] }`. Exactly one reply per thread id.
  A `fixed` reply requires `headSha` to differ from the PR head. Existing result
  intake, rejection and hold rules apply.
- Failure at any step creates a hold with reason kind `review_fix`. Recovery
  returns the goal to `delivered` with the old PR head and records outcome
  `failed`. An uncertain push marks the round `unknown`; the goal stays on hold
  until observation of the remote branch head confirms one outcome.

## Adapters and effects

- GitHub port additions: `listReviewThreads(repositoryId, number)` via one
  paginated GraphQL query that returns unresolved threads only and fails closed
  with `unknown` on a missing page; `replyToThread(repositoryId, threadId, body)`;
  `resolveThread(repositoryId, threadId)`. Each write is preceded by a sent
  marker file in the publication operation directory, so a crash never posts
  twice. The real adapter uses argv-based `gh api`. The fake adapter records
  calls and injects `unknown` and failures.
- A `ReviewFixCoordinator` next to the merge coordinator drives the round under
  ownership fencing: fetch, dispatch through the scheduler, verify through the
  existing verification runner, push through the remote port with
  `--force-with-lease`, reply, resolve, settle.
- The fixer prompt: fix valid findings inside the approved scope, decline with
  a reason otherwise, never change unrelated files, never push.
- The fixer worktree and the verification worktree are removed on settlement or
  failure through the existing cleanup path.

## API and UI

- No new route. The goal command route accepts `request_review_fix`. The goal
  projection gains `reviewRound` and `reviewRounds`. `actionView` projects the
  button and its refusal reason.
- Overview card: button, eyebrow, phase status line.
- Run report tab: `Review rounds` card.

## Non-goals

No automatic rounds. No thread selection. No independent reviewer on the fix.
No merge, rebase or target-branch update. No reply to plain PR comments or
resolved threads. No change to first publication, CodeRabbit configuration or
auto-merge.

## Acceptance criteria

- `request_review_fix` is offered only for a `delivered` goal with an open PR
  and settled workers; every other status is refused with a reason.
  Verification: domain transition tests.
- Zero unresolved threads settle the round without an attempt.
  Verification: coordinator test with fake GitHub.
- A result with a missing, duplicate or unknown thread id is rejected and holds
  the goal. Verification: domain result intake tests.
- A `fixed` reply triggers verification; a failed check holds the goal before
  any push. Verification: coordinator test with fake verification.
- A moved remote head fails the round and posts nothing.
  Verification: coordinator test with fake remote.
- A crash between push and reply resumes without a duplicate reply.
  Verification: coordinator failpoint test.
- `listReviewThreads` fails closed on a missing page and uses argv only.
  Verification: GitHub CLI boundary test.
- The button, eyebrow, status line and round card render per status.
  Verification: Vitest UI test.
- One full round completes against the disposable backend.
  Verification: Cypress orchestration spec.

## Success measure

One round on a PR with CodeRabbit threads pushes one commit, leaves every
unresolved thread replied, and returns the goal to `delivered` with the merge
check running on the new head.
