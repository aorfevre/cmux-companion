# Native planner update handoff implementation

Implements the native planning terminal handoff amendment in
`../specs/2026-09-13-manual-self-update-design.md`. The user reviewed and approved
that amendment with “Approve this handoff design” after its standalone commit.
The implementing agent owns backend lifecycle integration and cleanup; the parent
agent owns final review, CI, release and live verification.

1. Add a versioned native planner handoff protocol and durable planner-result
   outbox. Bind each entry to the existing scoped attempt/result identity; retry
   transient maintenance/offline errors with stable bytes; settle server receipts
   without granting authority or silently dropping a plan.
2. Expose explicit prepare/adopt/detach capabilities through native adapters and
   runtime composition. Verify immutable runner/workspace/attempt receipts and
   process-instance stamps. Preserve ordinary close/abort semantics and fail closed
   for older clients, active effects and unknown worker identities.
3. Integrate handoff evidence into the durable updater fence. Candidate startup
   adopts/reconciles preserved planners before healthy acceptance while scheduler
   and mutations remain fenced. Recovery restores SQLite and original credentials
   without replaying launch or losing durable outbox submissions.
4. Pin original release dependencies using durable, privately stored native
   handoff metadata. Retention revalidates stopped/outbox proof before unpinning.
5. Add disposable tests for successful detach/adopt, offline/503/lost-response
   result delivery, exact-once acceptance, stale authority, failed candidate
   rollback, multiple-release retention and legacy-client refusal. Run bounded
   suites first, then full verification; no installed agent manipulation or live
   external messages are part of routine tests.

The delivery report distinguishes passed disposable validation from unverified
launchd/native-provider continuity. Existing in-process background, verification,
publication, Git and prompt-delivery fences remain effective.
