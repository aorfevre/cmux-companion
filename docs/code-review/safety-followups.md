# Safety review follow-ups

Delivery: one combined PR, with phase-based commits. The source review PR #74
was merged as `8fede3f`. This work addresses issues #78–#85; it does not include
merging the follow-up PR, deployment or live-agent tests.

## Completion ledger

| Issue | Required outcome | Status |
| --- | --- | --- |
| #81 | Existing automation config and new backups stay private, including unchanged config | Implemented; two disposable configuration regressions pass |
| #82 | API fixtures never open operator persistence; cleanup covers setup failure | Implemented; 82 API tests and an instrumented child regression pass without an API-suite home preload |
| #78 | Manual single/bulk removal requires fresh Git and session evidence under the launch lock | Implemented; 107 dashboard/parser/lock tests pass; browser fixture correction awaiting rerun |
| #79 | Failed prompt saves prevent send and preserve visible feedback/edited text | Implemented; integrated Home unit test and local Cypress scenario pass |
| #83 | Single launch writer and confirmed closure before replacement | Pending |
| #84 | Atomic issue/follow-up ownership and durable unique identities | Pending |
| #85 | Cancellation compensation and fresh recorded-session closure checks | Pending |
| #80 | Obsolete terminal/reconnect responses cannot overwrite current state | Implemented; deferred success/error, A-B-A and reconnect-close unit regressions pass; terminal selection Cypress passes |

## Phase 1 evidence

API fixture services now use per-test storage, an empty repository catalog,
disposable review-token/issue stores, brief/attachment directories and an inert
account source. Cleanup is registered before store/app construction. Explicit
service injections remain available to the route tests. Production app defaults
are unchanged; briefs and issue-store dependencies are newly injectable.

The isolation regression instruments filesystem access beneath a synthetic
operator home in a child process. It initially detected a credential read on
failed setup; the fixture now supplies a fake cmux binary and empty password.
It verifies zero operator-path access, an unchanged sentinel, removed fixture
storage and cleanup after rejected setup. Ordinary API tests need no home
preload. Config tests cover changed and already-correct JSON, preserving unrelated
content and backup bytes, 0600 config/credential/backup modes, and argv-based
reload through an injected executor. No real cmux reload occurred.

Full verification and local Cypress will run after the remaining phases.

## Phase 2 evidence

Manual removal uses the existing repository launch lock in strict mode (Git
lookup failure cannot bypass the lock), then obtains uncached cmux inventory,
refreshes worktree eligibility, and reads live Git status. Single/bulk/discard
regressions inject missing observations and a session appearing after the display
snapshot. The real-Git regression proves strict removal and launch share the
same lock and recover after release. Inventory unavailable is an explicit API
fact, not an empty-session assertion.

Queue updates return success/failure to the row. Send requires successful save;
failed edits remain in place with inline and detail-page accessible feedback.
Selection-owned reads share in-flight work only within one committed selection,
abort old requests and reject old continuations even if cancellation is ignored.
Reconnect terminal states cannot regress; close/unmount stops adoption and
success side effects from late start, poll and callback responses.

The first full local Cypress pass passed 67/69 tests. Two new deletion cases
used a repository root outside the board's Karven/Rekord filters; fixtures were
corrected to Karven. They must pass in the final rerun. React lint also caught
mutable memo state and effect-based UI resets in the initial implementation;
these were replaced by effect-owned request refs and render-time selection reset.
Standalone lint and types then passed. No failing assertion was removed.
