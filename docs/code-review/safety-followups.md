# Safety review follow-ups

Delivery: one combined PR, with phase-based commits. The source review PR #74
was merged as `8fede3f`. This work addresses issues #78–#85; it does not include
merging the follow-up PR, deployment or live-agent tests.

## Completion ledger

| Issue | Required outcome | Status |
| --- | --- | --- |
| #81 | Existing automation config and new backups stay private, including unchanged config | Implemented; two disposable configuration regressions pass |
| #82 | API fixtures never open operator persistence; cleanup covers setup failure | Implemented; 82 API tests and an instrumented child regression pass without an API-suite home preload |
| #78 | Manual single/bulk removal requires fresh Git and session evidence under the launch lock | Implemented; 107 dashboard/parser/lock tests and single/bulk Cypress cases pass |
| #79 | Failed prompt saves prevent send and preserve visible feedback/edited text | Implemented; integrated Home unit test and local Cypress scenario pass |
| #83 | Single launch writer and confirmed closure before replacement | Implemented; concurrent launches/recovery, capacity and closure regressions pass |
| #84 | Atomic issue/follow-up ownership and durable unique identities | Implemented; store, planning and follow-up ownership regressions pass |
| #85 | Cancellation compensation and fresh recorded-session closure checks | Implemented; cancellation, compensation recovery and fresh-status regressions pass |
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

Final verification results are recorded below.

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
corrected to Karven; both pass in the subsequent run. React lint also caught
mutable memo state and effect-based UI resets in the initial implementation;
these were replaced by effect-owned request refs and render-time selection reset.
Standalone lint and types then passed. No failing assertion was removed.


## Phase 3 evidence

PLN-001/002 (#83): awaited and background launches share a live claim; the
registry refuses overflow instead of evicting a writer. Task recovery claims
its operation before external awaits and releases on failure. All recovery
modes require fresh proof that the old workspace is absent before replacement,
even when close was acknowledged. Failed close plus unavailable/still-present
inventory creates/removes nothing; failed close plus proven absence can recover.

PLN-003/GOAL-003 (#84): issue reservation and saved-plan creation share the SQLite
transaction. Single-issue and topic planning use this boundary, and failure
prevents the planner process from starting. Same-issue sync requests coalesce;
independent issues proceed. Follow-up and merge creation share an application
store/goal claim before awaits. Follow-ups check uncached checkout inventory
before brief creation and again before workspace creation, refusing existing
recorded or unrecorded writers. UUID brief identities are persisted with launch
history; lifecycle changes compensate only the newly created session.

GOAL-001/002 (#85): merge creation checks lifecycle after brief writing and after
cmux create returns. Cancellation records the created identity before attempting
close, preserving terminal board state and leaving retirement pending until a
later reaper observation. Tests simulate cancellation within brief/create calls,
failed compensation and reaper recovery. Recorded retirement refreshes inventory,
durable ownership and status per candidate; explicit idle and clean signals are
required. Replaced task identities cannot inherit an old session's retirement
stamp. Running, unknown, dirty, unavailable and replaced observations refuse
closure. Existing idle fixtures now provide explicit false status signals.

The first full verification found five additional API/watchdog fixtures with
ambiguous idle status. Those fixtures were corrected and the targeted suites
pass. Full verification and the corrected Cypress run pass.
No live agents, cmux workspaces or deployment were used for validation.


## Final validation

- `npm run verify`: passed, 973 backend tests and 103 UI tests, lint, types,
  and production build. Build reports its existing large-chunk/classification
  advisories; no check fails.
- Final targeted store/follow-up/integrator/reaper tests: 189 passed, including
  the persisted follow-up identity assertions added after the full run.
- `node docs/code-review/check-review.mjs`: passed. This audits the original
  `f4052f1` review snapshot (48 findings, 854 citations) and current membership
  of all 49 Node test suites; it is not a fresh full-source code review.
- `git diff --check`: passed.
- `npm run test:e2e:local`: all 69 tests passed across 15 specs. The previous run
  passed 68/69, including both deletion
  cases. The remaining terminal fixture used request counts while polling could
  add reads; it now changes its response at an explicit selection phase.
- Hosted CI: pending publication. Live cmux, live agents, deployment, and merge
  of this follow-up PR are not part of these checks.
