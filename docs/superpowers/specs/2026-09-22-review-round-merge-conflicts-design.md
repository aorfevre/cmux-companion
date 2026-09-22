# Resolve merge conflicts in a review round

Date: 2026-09-22
Status: Awaiting human review after this spec commit.
Owner: Implementing agent, including domain, adapters, UI, tests and cleanup.

## Problem

A delivered goal waits for merge. The target branch moves. GitHub then reports
`This branch has conflicts that must be resolved`, and the pull request cannot
merge. Companion offers `Address review comments`, which fetches unresolved
review threads only. A conflicted pull request with zero threads settles the
round as `nothing_to_address` and changes nothing. The goal is finished work
that can never land, and the user must resolve the conflict by hand.

## Outcome

A review round also resolves merge conflicts. Companion reads the mergeable
verdict with the review threads. A conflicted pull request makes Companion
import the target branch head, merge it into the pull request branch, let the
fixer resolve what Git could not, verify the merged head with the approved
checks, and push. A conflict observed by the merge poll starts one round on its
own, with no press. Every other round stays manual.

## User journey

1. A `delivered` goal shows `Waiting for merge on GitHub`. The merge poll runs
   every 15 minutes.
2. The poll observes `conflicting`. Companion starts one round by itself. The
   eyebrow reads `ADDRESSING REVIEW · PLAN n`. The status line reads
   `Merging <base branch>`. Mission Control counts the goal under `Running`.
3. The user may also press `Address review comments` at any permitted time. A
   pressed round behaves the same; only the recorded trigger differs.
4. Companion merges the recorded target head into the pull request branch in
   the fixer worktree.
5. A clean merge with zero unresolved threads runs no agent. Companion commits
   the merge and verifies it.
6. A conflicted merge, or any unresolved thread, starts the fixer. The status
   line reads `Fixing n threads and m conflicts`. The agent resolves the
   conflict markers, answers every thread and commits once.
7. Verification runs the approved checks on the merged head. A failed check
   creates a hold with the existing `Recover goal` action.
8. Companion pushes the merged head to the same pull request branch, posts one
   reply per thread and resolves the threads it fixed.
9. The goal returns to `delivered` with the new pull request head. The Run
   report tab lists the round with its trigger, merged target head, conflicted
   paths, threads, replies and outcome.

## Domain

- New round state `merging`, between `fetching` and `fixing`.
- `record_review_threads` also records `mergeable` (`mergeable`, `conflicting`
  or `unknown`) and `baseHeadSha`, the target head GitHub reported the verdict
  against. A `mergeable` verdict with zero threads still settles the round with
  outcome `nothing_to_address`. Any other verdict moves the round to `merging`,
  even with zero threads. An `unknown` verdict merges too: GitHub has not
  computed an answer, and the local merge produces the true one.
- New round fields: `trigger` (`user` or `conflict`), `mergeable`,
  `mergedBaseSha`, `mergeCommitSha` and `conflictPaths`.
- `record_review_merge` (system). Records `mergedBaseSha`, `mergeCommitSha` and
  `conflictPaths` after Companion prepares the merge. Zero conflicted paths and
  zero threads move the round to `verifying` with `fixHeadSha` set to the merge
  commit; no attempt is dispatched. Any other case moves the round to `fixing`,
  and the fixer attempt targets the merge commit.
- `accept_review_fix_result` today requires the reported head to equal the pull
  request head when no reply is `fixed`. A round with a recorded
  `mergedBaseSha` requires the reported head to differ from the pull request
  head in every case, because the merge itself is a new commit.
- Scheduling dispatches `review_fixer` when the round state is `fixing` and
  either a thread or a conflicted path exists.
- `fail_review_fix` gains no new state. A merge that cannot be prepared fails
  the round with a recorded code, as every other step does.
- The automatic trigger: `record_merge_sync` records the observed `mergeable`
  verdict and target head. A `delivered` goal with `conflicting`, no active
  round and no earlier automatic round for the same pair of pull request head
  and target head admits one system-authority `request_review_fix` with
  `trigger: 'conflict'`. The goal records that pair so one observation never
  starts two rounds. A failed automatic round never restarts by itself.

## Scope proof

Companion always creates the merge commit, clean or conflicted.
`git merge-tree --write-tree` returns a tree in both cases; a conflicted tree
carries the conflict markers, exactly as the existing integration path already
commits one for an integrator. The merge commit has two parents, the pull
request head and the merged target head, so the fix head still descends from
the pull request head.

The fixer works from that merge commit, not from the pull request head. Its
recorded base is the merge commit. The existing candidate proof therefore needs
no new comparison: it measures the agent's delta from the merge commit, so the
target branch's own files never appear in that delta, and the merge commit's
second parent falls outside the range it inspects.

A conflicted path outside the contract's owned areas is still legitimate work.
Companion records the conflicted path list from its own merge, never from the
agent's report, and accepts changes inside the owned areas plus exactly those
paths. Every set is computed by Companion. An agent that changes nothing
reports the merge commit itself, and Companion skips the delta proof for that
one case.

## Adapters and effects

- `GitHubCli.readPull` returns `mergeable` and the target head. The existing
  identity guards are unchanged. A missing or unexpected value reads as
  `unknown`, never as `mergeable`.
- `GitHubPublication.reviewThreads` already calls `readPull` for identity. It
  now returns the threads with that verdict and target head, so the round reads
  both in one GitHub call. The merge poll reads the same verdict through
  `observeMerge`.
- The recorded `baseHeadSha` is GitHub's observation. The recorded
  `mergedBaseSha` is the head Companion actually imported. They may differ when
  the target moves between the two reads. The merge, the verification and the
  proof all use `mergedBaseSha`.
- New repository port method `prepareReviewMerge`. It imports the target head
  with the existing `fetchBase`, computes the merge with
  `git merge-tree --write-tree`, commits the resulting tree with the pull
  request head and the merged target head as parents, and records the merge
  commit under an owned ref. It returns the merged target head, the merge
  commit and the conflicted paths. It is idempotent per round id: a repeat call
  observes the recorded evidence rather than merging again.
- New repository port method `provisionReviewMerge`. The scheduler calls it in
  place of `provision` for a `review_fixer` attempt whose round recorded a
  merge. It provisions the attempt worktree at the merge commit, so the agent
  sees the conflict markers in place. It mirrors the existing
  `provisionRepair`.
- The `review_fixer` prompt states the merge state: the recorded conflicted
  paths, the merged target head, and the rule that the resolution and the
  thread answers are one commit. The agent never merges, fetches or pushes.
- A round that runs no agent records the merge commit as `fixHeadSha` and
  proceeds to verification directly.

## API and UI

- No new route. The goal command route already accepts `request_review_fix`;
  system authority is added for the conflict trigger.
- The round projection gains `trigger`, `mergeable`, `mergedBaseSha` and
  `conflictPaths`. The phase text covers `merging`.
- The Overview status line shows the merge phase and the conflict count.
- The Run report round card lists the trigger, the merged target head and the
  conflicted paths.
- `attention` reports a conflicted pull request that has no active round, so a
  goal never waits silently when the automatic round cannot start.

## Non-goals

No rebase. No merge of the pull request itself. No automatic round for review
threads alone. No conflict resolution outside a review round. No change to the
push, reply or resolve steps. No new project setting.

## Acceptance criteria

- A `mergeable` verdict with zero threads still settles as
  `nothing_to_address`. Verification: domain transition test.
- A `conflicting` verdict with zero threads moves the round to `merging`.
  Verification: domain transition test.
- An `unknown` verdict merges rather than settles.
  Verification: domain transition test.
- A clean merge with zero threads runs no agent and verifies the merge commit.
  Verification: coordinator test with a fake repository port.
- A conflicted merge dispatches the fixer with the conflicted paths pinned.
  Verification: coordinator test plus scheduling test.
- A fix head that changes a path outside the owned areas and outside the
  recorded conflicted paths is rejected and holds the goal.
  Verification: domain result intake test.
- A fix head that carries only the target branch's own changes is accepted.
  Verification: service test against a disposable Git repository.
- `prepareReviewMerge` called twice for one round merges once.
  Verification: repository adapter test.
- The merge commit carries the pull request head and the merged target head as
  its two parents. Verification: repository adapter test.
- `readPull` reports an unexpected mergeable value as `unknown`.
  Verification: GitHub CLI boundary test.
- One observed conflict starts exactly one automatic round; a second
  observation of the same heads starts none.
  Verification: merge coordinator test.
- The merge phase, conflict count and round card render.
  Verification: Vitest UI test.
- One conflicted round completes against the disposable backend.
  Verification: Cypress orchestration spec.

## Success measure

A delivered goal whose pull request GitHub reports as conflicting returns to
`delivered` with a merged, verified and pushed head, without a press and
without a hand-written conflict resolution.
