# Safety review follow-ups

Delivery: one combined PR, with phase-based commits. The source review PR #74
was merged as `8fede3f`. This work addresses issues #78–#85; it does not include
merging the follow-up PR, deployment or live-agent tests.

## Completion ledger

| Issue | Required outcome | Status |
| --- | --- | --- |
| #81 | Existing automation config and new backups stay private, including unchanged config | Implemented; two disposable configuration regressions pass |
| #82 | API fixtures never open operator persistence; cleanup covers setup failure | Implemented; 82 API tests and an instrumented child regression pass without an API-suite home preload |
| #78 | Manual single/bulk removal requires fresh Git and session evidence under the launch lock | Pending |
| #79 | Failed prompt saves prevent send and preserve visible feedback/edited text | Pending |
| #83 | Single launch writer and confirmed closure before replacement | Pending |
| #84 | Atomic issue/follow-up ownership and durable unique identities | Pending |
| #85 | Cancellation compensation and fresh recorded-session closure checks | Pending |
| #80 | Obsolete terminal/reconnect responses cannot overwrite current state | Pending |

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
