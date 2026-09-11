# Orchestration core implementation evidence

Owner: primary implementation agent (`/root`), accountable for integration,
verification and removal of obsolete paths.
Contract: [redesign spec](superpowers/specs/2026-09-11-orchestration-core-refactor-design.md), `3f3102f`.
Plan: [implementation plan](superpowers/plans/2026-09-11-orchestration-core-redesign.md), including review/test-repository clarification `e31d088`.

## Current delivery status

The complete goal is still in progress. This report records evidence, not a
substitute acceptance criterion for the whole replacement.

| Scope | State | Evidence / remaining work |
| --- | --- | --- |
| T01: domain and ports | Foundation implemented | Typed pure graph/state/review rules, explicit result versus worker liveness, command identities and adapter capability contracts. |
| T02: persistence | Foundation implemented | Explicit-path SQLite state, immutable contracts, indexed attempt ownership, atomic event/intent/receipt writes, private artifacts and journal cursors. |
| T03: authority transport | Foundation implemented | Paired user API, scoped hashed agent credentials, bridge subprocess commands, repository allow-list and stale-authority checks. Structured candidate submission now connects independent Git proof to atomic acceptance; integration-repair submission still fails closed. |
| M1 durable-decision gate | Passed for foundation | Review and verification below; no production scheduling activated. |
| T04: scheduler and recovery | Implemented, independently reviewed | Exclusive nonce-fenced ownership, transactional capacity, durable FIFO, explicit retries, abort reconciliation and fresh-process crash recovery. |
| T05–T06 / M2 | In progress | Runtime, concurrent real-Git fake implementers, scheduled planning/review, revision requests and durable role-result intake pass targeted tests. Scheduled A/B/C task review, repair and integration now pass; cancellation ownership and remaining M2 fault gates remain. |
| T07–T09 / M3 | In progress | Real Git worktrees, candidate proof/acceptance, serialized delta integration and crash receipts implemented. Conflict-repair acceptance, combined verification and PR adapter remain. |
| T10–T12 / M4 | Pending | Runnable isolated composition, durable consumers, actual provider/cmux adapters and new mobile/Cypress journey. |
| T13–T15 / M5 | Pending | Full crash matrix, cleanup, disposable cutover rehearsal, legacy removal, documentation and final acceptance. |

## M1 foundation: commit `8994832`

### Passed

- `node --test tests/orchestration-*.test.mjs tests/security.test.mjs`: 57 tests passed.
- Independent reviewer reran domain, boundaries, storage, API and bridge suites:
  52 tests passed (the separate existing security suite accounts for the difference).
- `npm run verify`: 1,267 backend tests, 257 UI tests, lint, typecheck and build passed.
- `npm run test:coverage`: 1,267 tests passed; backend line coverage 98.18%.
- Targeted new-code lint and checked-JavaScript type validation passed.
- `git diff --check` passed before commit.

The new tests use disposable SQLite files and an actual separate bridge process
against the actual Fastify routes. They cover task graph ordering, exact review
identity, bounded repair, revoked/stale commands, transaction failpoints,
post-commit response loss, worker liveness, protected journal retention, SQLite
sidecar permissions, encoded-route authentication and withdrawn repositories.
They do not yet run the planned real Git fixture/E2E journey.

### Independent implementation review

Reviewer: `/root/domain_review`, separate read-only agent conversation; no recursive
delegation. The reviewed source snapshot is committed as `8994832`.

Several incremental reviews found blocking lifecycle and authorization defects;
they were fixed with regression tests before the foundation was committed:

- Result submission released physical worker ownership; ownership now persists
  until stopped-process evidence, including abort and uncertain dispatch gaps.
- Conflict/final-repair transitions, failed-check repair and explicit stop/retry
  handling were incomplete; the domain now represents those transitions.
- PR completion lacked saved operation identity; late observations now require it.
- Task ownership depended on commit target, and late liveness failure could overwrite
  successful evidence; identity and result/liveness handling are now separate.
- Agent receipt replay, durable consumer restart and private WAL/SHM creation
  needed corrections; each now has a direct regression case.
- Matched encoded API paths bypassed raw-prefix auth; security now follows Fastify's
  registered route identity, covering encoded reads and cross-origin mutations.
- Repository withdrawal was only checked at creation; new non-termination intents
  now require current repository permission.

Final reviewer assessment: no remaining blocking issue identified in the reviewed
T01–T03 foundation slice. Scheduler, Git evidence, production adapters and complete
end-to-end delivery were explicitly outside that approval.

### Failed checks and interventions

One full verification attempt and one independent test run failed because the new
withdrawal regression assumed a termination intent would sort last. Same-millisecond
operations are secondarily sorted by id, so that assertion was invalid. It was
changed to find the exact operation id. Targeted tests, independent review, backend
coverage and full verification then passed. No coverage threshold was reduced.

An early import-boundary test used an overbroad regex; it was replaced with
TypeScript AST import/global inspection. Early lint/type errors were corrected,
including checked JSDoc on reused security helpers. No failing check is being
waived as a requirement exception.

### Not run / not delivered

- New test repository and orchestration Cypress journey: not implemented yet.
- Live provider permission enforcement, cmux continuity and GitHub delivery:
  unverified; no live suite was authorized or run.
- Installed-service cutover, rollback operation, merge, deployment and public
  release: not performed.
- Legacy orchestration removal: pending after the replacement journey passes.

The installed application remains untouched. New routes/modules are exercised
through isolated tests and are not wired into installed-service startup. The
pre-existing untracked burst-scan plan is unchanged.

## T04: exclusive scheduling and recovery, commit `b4c25aa`

The scheduler reserves capacity and launch intents in the same SQLite transaction,
uses persisted first-readiness order and waits for integrated dependencies. Planner
capacity is separate; uncertain and successful-but-live workers still occupy slots.
Failed, confirmed-stopped planners/reviewers require explicit user retry. Readiness
is backfilled when opening an earlier foundation database.

Ownership uses an atomic PID/nonce record on a canonical database path. Only kernel
ESRCH permits takeover; live/reused/ambiguous PIDs block it. Hardlinked database
files are rejected to prevent separate WAL aliases. Dispatch persists resources
before launch, checks authority again after provisioning, and reconciles uncertain
responses by operation identity. Shutdown joins all started dispatches before
releasing ownership.

### Independent implementation review

Reviewer: `/root/scheduler_admission_review`, separate read-only conversation.
Incremental review identified and resolved:

- FIFO reset when an unrelated integration advanced the head: logical task keys
  and upsert now preserve continuous readiness order.
- Failed planner/reviewer attempts lacked explicit retry: added stopped-worker
  retry authorization without automatic relaunch.
- Earlier databases lacked ready entries: added constructor backfill.
- Abort followed by provisioning rejection retained capacity despite no launch:
  record confirmed termination for the fenced attempt.
- A dispatch rejection released ownership while a sibling launch still awaited:
  join every dispatch with `Promise.allSettled` before propagating errors.
- A completion-commit acknowledgement failure could misclassify a live launch as
  a provisioning failure: track the crossed launch boundary independently of the
  pending-operation query.

Reviewer reran ownership, scheduler and reconciler tests: 24/24 passed, with no
remaining blocker identified. The additional real-process recovery harness was
independently reviewed and rerun: 3/3 passed. Each case SIGKILLs its owned service
child after intent commit, external launch, or completion commit, then restarts
twice against the same SQLite database. An independent persistent launch log
proves exactly one external launch. External workers are a persistent fake
inventory; this does not establish production process survival/provider lookup.

### Verification and interventions

- `npm run verify`: 1,294 backend tests and 257 UI tests passed; lint, checked
  backend/frontend types and production build passed on Node 22.23.1.
- Targeted backend type/lint checks and `git diff --check` passed.
- The first coverage run passed 1,293/1,294 tests (98.15% backend lines), failing
  the existing `streamExecFile does not kill a child that keeps printing` test
  on its 200 ms idle limit while full verification ran concurrently. The same
  instrumented test passed alone. No timeout or coverage assertion was weakened;
  full coverage then passed 1,294/1,294 tests with 98.13% backend line coverage
  without a competing full suite.

The scheduler currently dispatches launches and reconciles termination; actual
Git integration and PR publication effects remain T07–T09. Execution-mode/provider
contracts, the checked-in Git fixture, mobile E2E and legacy retirement remain
outstanding. No installed or live service was exercised.

## T05 in progress: disposable Git fixture

The checked-in dependency-free fixture now exists under
`tests/fixtures/orchestration-repo/`. Its builder creates an isolated temporary
repository and local bare remote, disables inherited Git configuration/hooks and
makes real A/B/C commits. Harness tests establish independent sibling bases,
combined dependency contents, a failing C candidate, a repaired SHA with passing
unchanged checks, and an intentional A/B merge conflict. Both fixture tests and
their targeted lint pass. Initial fixture checks intentionally fail until tasks
are implemented; this is test input, not a failing Companion test suite.

This validates the fixture itself, using explicit Git commands in the harness.
It does not yet prove the service schedules/integrates these commits; runtime
contracts and fake-agent/service wiring remain T05–T09 work. Full verification
reported above precedes this fixture addition.

## T05 in progress: execution contracts and parallel implementers

`adapters/agent-runtime.mjs` now routes interactive planning/resume through its
own injected driver and uses durable attempt lookup for observation/termination.
Unknown lookup never becomes stopped evidence. Background execution uses argv,
explicit environment, injected identity/clock, mandatory ceiling/idle/output/grace
limits, process-group signals and a separate private-output/structured-error result.
Identity recording precedes launch acknowledgement. Process success is not a
workflow acceptance command or proof about provider resources outside its group.

The real scheduler now launches two scripted implementers into different fixture
worktrees. Named barriers prove A and B overlap while occupying two slots; each
makes a real commit descended from the recorded base. C remains pending even
after both commits exist, because no accepted integration checkpoint exists yet.
The fixture seeds plan review through service commands; this test does not claim
scheduled planning/review, candidate proof or actual service integration is done.

### Independent runtime review and corrections

Reviewer: `/root/scheduler_admission_review`, separate read-only conversation.
Review found these issues, all corrected with direct regressions:

- Parent close cancelled SIGKILL escalation while resistant descendants remained:
  group cleanup now retains escalation and checks group disappearance.
- An unresolved asynchronous identity callback stranded launch after process exit:
  identity acknowledgement now races bounded process completion.
- UTF-8 replacement characters could expand truncated output beyond the byte cap:
  returned encoded output is bounded and incomplete suffixes are omitted.
- An escaped descendant could hold pipes open indefinitely and prevent close:
  bounded drain cleanup destroys readers and reports unknown worker ownership.

The reviewer independently reran runtime and parallel tests: 16/16 passed; no
remaining blocker identified in this slice. Test-owned descendant groups were
explicitly cleaned up. Production identity/permissions remain unverified.
`ScriptedAgents` is currently used for concurrent commits, not abort correctness;
cooperative cancellation/drain semantics must precede its use for abort coverage.

### Checks and remaining work

- Targeted orchestration/security suites: 102/102 passed.
- Backend checked-JavaScript types, targeted lint and `git diff --check`: passed.
- An initial spawn-failure test exposed notification before timer cleanup; launch
  rejection now follows cleanup. An initial parallel harness run rejected UUIDs
  beginning with a digit as fixture checkout names; names now have an explicit
  `op_` prefix, and the test asserts launch count before waiting at barriers.
- `npm run verify`: 1,312 backend tests, 257 UI tests, lint, frontend/backend types
  and build passed for this runtime slice on Node 22.23.1.
- `npm run test:coverage`: 1,312 tests passed; backend line coverage 98.14%.

M2 is not declared complete. The T06 slice below adds role output schemas and
planner/reviewer result reception/commit crash coverage; complete task review/repair
and an A/B/C integration journey remain required in T06–T09. The native interactive driver and production permission waits
are still T11 work; fake routing does not establish live terminal behavior.

## T06 in progress: reviewed revisions and durable structured results

Each role now has a strict versioned output envelope bound to goal, generation,
revision, role, attempt, operation and exact target. Candidate/repair outputs carry
bounded repository-relative evidence references. Role contexts clone the pinned
contract, task, review history and applicable verification evidence. Prompt text
states required permissions; provider enforcement remains a separate T11 gate.

The user can request a revision with feedback. The command fences old workers and
approval immediately, preserves immutable contracts and review history, and queues
a new planner. A new published revision requires its own independent plan review
and explicit user approval. Both revision request and direct contract publication
refuse while an integration/publication operation remains unresolved, preserving
the operation identity needed to record late external success.

The internal result inbox persists raw output privately before creating a pending
descriptor in the authoritative goal aggregate. Acceptance/rejection commits with
its lifecycle change and journal event. Early output waits for dispatch identity;
malformed/stale output remains evidence without granting approval or releasing
worker ownership. The scheduler drains results before observing exits and again
after awaited observations. A stopped but uncorrelated worker with pending output
remains uncertain until identity can be established.

### Independent review and corrections

Reviewer: `/root/domain_review`, separate read-only conversation. Blocking findings
resolved with regressions:

- Revision discarded unresolved integration/publication ownership: both revision
  paths now require those operations to be reconciled first.
- Failed-check-only integrators lacked the failed check IDs/artifacts: exact-target
  verification is included in their pinned context.
- Output arriving during an awaited stopped observation could be cancelled before
  acceptance: reconciliation now drains that output before settlement, including
  correlated queued/uncertain results.
- Rejecting a historical implementer result failed its running replacement's task:
  rejection side effects now require a current owned active attempt.
- Final acceptance/repair readiness could reuse a verdict from an old contract
  when the same SHA reappeared: review gates and nonplanner contexts now require
  the review attempt's current generation and revision. Planner revision context
  retains historical findings as feedback, never as approval authority.

The reviewer independently ran planning/result-contract tests (8/8) and internal
inbox tests (13/13), approving both reviewed slices after the fixes. Six inbox crash
cases SIGKILL a real service child at receipt, before acceptance commit and after
acceptance commit, for planner and reviewer roles; two fresh restarts per case
prove exactly one receipt/acceptance, including planner generation replacement.
The final historical-verdict correction received a separate incremental review;
the reviewer independently reran the expanded role-result suite (6/6).

### Checks and scope

- Targeted orchestration/security tests: 123/123 passed.
- Backend checked-JavaScript types, targeted lint and `git diff --check`: passed.
- Final `npm run verify`: 1,334 backend tests, 257 UI tests, lint, frontend/backend
  types and build passed on Node 22.23.1.
- Final `npm run test:coverage`: 1,334 tests passed; backend line coverage 98.20%.
- Initial test-only failures assumed A/B launch response order and double-closed a
  fixture database; assertions/fixture ownership were corrected before rerunning.
  The later historical-verdict regression reused a fixed fixture review id;
  assigning its new attempt a unique id resolved that test setup failure.

This result intake currently serves trusted internal adapters; HTTP/bridge result
transport is not connected yet. Candidate and integration-repair acceptance still
fail closed until independent repository evidence is available. A fully scheduled
task repair/integration journey, remaining adapter/result fault cases and M2 are
still incomplete. No live or installed service was exercised, merged or deployed.

## Authenticated result transport and initial T07 Git evidence

The scoped bridge and HTTP result endpoint now accept only `{id, raw}` and return
bounded receipt metadata. Historical credential bindings support exact settled
receipt replay after a lost response, including the planner's own publication;
they cannot authorize changed/new output, later revisions, explicit revocation or
aborted goals. Bridge buffering is bounded before newline parsing.

The new local Git adapter records operation manifests and atomically reserves
branch/ownership refs before creating isolated worktrees. It reconciles recorded
reservations, refuses unowned paths (including dangling symlinks), and verifies
native worktree registration, exact branch/head/base, clean checkout, ancestry,
nonmerge history and approved changed paths. Configured checkout filters and new
symlink/submodule modes fail closed. Candidate reports reference a byte-preserved
binary patch artifact. Reviewer attempts use their exact commit target as base.

Independent reviewers `/root/domain_review` and `/root/scheduler_admission_review`
approved their respective transport and Git slices after corrections. The Git
review found UTF-8 decoding corrupted non-UTF-8 blob patches and replacement refs
could substitute object evidence. Patches now preserve raw bytes, metadata rejects
unsupported encodings, and Git disables replacement objects. A real patch apply
must reproduce the candidate's exact tree; a replacement-ref regression verifies
the original commit's delta.

Full `npm run verify` passed: 1,349 backend tests, one platform skip, 257 UI
tests, lint, frontend/backend types and build.

Checks: targeted API/bridge/Git tests passed 24 with one platform skip; checked JS,
targeted ESLint and `git diff --check` passed. Backend coverage passed 1,349 tests
with one skip and 98.24% lines. The invalid-filename test initially failed during
fixture creation with macOS EILSEQ; it now explicitly skips macOS, whose filesystem
rejects those names. Its rejection path remains unverified locally and is covered
by the test on Linux. Provisioning recovery here uses injected exceptions/reopen,
not yet real process termination.

Candidate acceptance remains disconnected and fails closed. Real integration,
production adapters, full fixture E2E, cutover/retirement and remaining T01–T15 gates
are incomplete. PR #115 remains draft; no live service, merge or deployment ran.

## T07 candidate-result acceptance wiring

The durable inbox now awaits independent Git verification for implementer output
when a repository adapter is supplied. Raw output remains private. A system-only
command commits the proof artifact reference, candidate state and result receipt
atomically; scoped agents cannot invoke it to substitute their own evidence.
Repository allow-list checks surround the awaited read. Independent task reviewers
are pinned to the accepted candidate SHA, and integration remains unchanged until
separate reviewed integration evidence arrives.

Git verification may overlap another command. Optimistic version conflicts leave
output pending for fresh verification. Independent review reproduced a race where
stopped-worker reconciliation then cancelled that pending attempt. Process exit
now records the worker as stopped and releases its capacity while preserving a
current pending result's eligibility; its later acceptance or rejection settles
lifecycle independently. Historical generation/status guards remain enforced.
The revision-race regression initially used `feedback` instead of `message`, so it
only proved malformed-command rejection. It now asserts the actual discovering
status and incremented generation after revision.

Real disposable Git tests cover accepted proof and exact review target, scope
rejection, abort/revision during verification, lost acceptance response, concurrent
inbox mutations, agent bypass refusal and stopped-worker retry with both acceptance
and rejection. Independent reviewer `/root/domain_review` approved the corrections and reran
candidate/inbox suites: 22 passed, zero failed. Backend coverage passed 1,358 tests
with one platform skip and 98.23% lines. Full `npm run verify` passed: 1,358
backend tests, one platform skip, 257 UI tests, lint, both typechecks and build.
Serialized integration, full scheduled repair journey and later plan gates remain
incomplete.

## T08 serialized integration and scheduled A/B/C journey

The scheduler now requests one integration per goal, then applies accepted task
deltas through a dedicated Git adapter. An explicit merge base preserves sibling
changes while incorporating only the candidate delta. Separate operation-owned
checkouts, private goal/operation/proposal manifests and Git ownership refs guard
identity. A single Git ref transaction advances the goal branch and records its
applied-operation receipt. An atomic workflow receipt survives lost database
acknowledgement and prevents orphaned integration intents or duplicate application.

Conflict trees and reports are recorded before materialization. Ignored/untracked
files and modified conflict copies are preserved by refusal. Repair attempts get
separate owned copies of the exact recorded conflict tree. Private proposal and
conflict reports are checked against refs before replay or copying. Repository
filters and custom merge drivers are unsupported and rejected before Git effects.

The real scheduler test starts with discovery, schedules planner and independent
plan review, requires user approval, overlaps A/B in real Git worktrees, reviews
and serially integrates them, then starts C at the combined head. A real failing
fixture test makes C's independent reviewer request repair; a fresh implementer
fixes C, renewed review accepts its exact commit, and the combined checkout passes
acceptance tests. This uses scripted agents and no live provider or GitHub service.

### Review findings and interventions

- Git reviewer found ignored files could be overwritten by conflict materialization:
  all untracked/ignored files now block this integration-only checkout mutation.
- Conflict ref publication preceded its report, leaving an interruption gap:
  report now precedes ref publication, with recovery tests at both boundaries.
- Conflict refs were not compared to private reports on replay/repair-copy creation:
  both now validate the tree and artifact evidence; substituted refs are refused.
- Coordinator reviewer reproduced aborted dispatching integrations being skipped
  after restart: read-only observation now reconciles saved applied receipts for
  terminal goals without starting new Git work.
- A withdrawn repository could throw before the per-goal handler and interrupt
  unrelated scheduling: new integration requests now skip withdrawn repositories.
- The journey's first assertion read only 100 events; increasing to 1,000 exceeded
  the API's bound. It now uses the supported 500-event page for this bounded fixture.
  The earlier failures were assertion pagination errors, not missing integration.

Targeted integration/scheduler/delivery tests passed 36/36; checked JS and targeted
lint passed. The Git suite includes seven real SIGKILL boundaries: goal reservation,
proposal report, proposed ref, atomic advance, conflict report, conflict ref and
conflict materialization. Each case reopens twice and verifies one applied commit
or the same preserved conflict. Kills occur at completed durable boundaries, not
inside a still-running Git subprocess. Independent reviewers approved the corrected slices: `/root/domain_review` reran
scheduler/delivery checks (15/15); `/root/scheduler_admission_review` reran proposal,
repair-copy and read-only-observation regressions (3/3). The order-independent
combined-base assertion received incremental review.

Full `npm run verify` passed: 1,385 backend tests, one macOS filename skip, 257 UI
tests, lint, both typechecks and build. Backend coverage passed the same 1,385
tests with one skip and 98.24% lines. Logs: `/tmp/cmux-orchestration-t08-verify.log`
and `/tmp/cmux-orchestration-t08-coverage.log`. No UI code changed; the replacement
backend/mobile Cypress journey remains a later required gate.

Conflict-repair result acceptance and its ref-advance protocol remain unavailable;
no repair output can currently claim integration success. Combined verification/
final publication service, production adapters, complete process fault matrix,
mobile E2E and retirement remain incomplete. Scripted cancellation is still not an
abort proof. No installed/live integration, merge, deployment or release ran.
