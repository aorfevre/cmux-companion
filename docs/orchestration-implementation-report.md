# Orchestration core implementation evidence

Owner: primary implementation agent (`/root`), accountable for integration,
verification and removal of obsolete paths.
Contract: [redesign spec](superpowers/specs/2026-09-11-orchestration-core-refactor-design.md), `3f3102f`.
Plan: [implementation plan](superpowers/plans/2026-09-11-orchestration-core-redesign.md), including review/test-repository clarification `e31d088`.

## Final local delivery status

T01–T15 are implemented for the plan's source and local-verification scope.
PR: https://github.com/aorfevre/cmux-companion/pull/115, targeting `main`.
The sections after this final summary are chronological checkpoints; their
then-pending work is superseded by the evidence here.

| Scope | Final implementation and decisive local evidence |
| --- | --- |
| T01 | Pure domain/capability contracts; domain and import-boundary suites. |
| T02 | Separate journal, transactional effects, idempotency and ownership; storage/recovery suites. |
| T03 | Paired commands and scoped bridge tools; API, bridge, tool and result-authority suites. |
| T04 | Exclusive scheduling, bounded admission and reconciliation; scheduler/ownership/reconciler suites. |
| T05 | Distinct interactive/background contracts and concurrent scripted agents; runtime/parallel suites. |
| T06 | Planning, independent review and bounded repair; planning/role-result/delivery suites. |
| T07 | Isolated worktrees and independent candidate proof; Git/candidate-result suites. |
| T08 | Serialized recoverable integration and scoped repair; integration/delivery/fault suites. |
| T09 | Exact-head verification and one reconciled PR; verification/publication/delivery suites. |
| T10 | Isolated service, durable consumers and public SSE; composition/events/dev suites. |
| T11 | Capability-gated native adapters, supervisor and planner continuity; native capability/background/terminal/launch suites. Live enforcement remains unverified. |
| T12 | Mobile goal journey; UI suite plus real-backend/Git Cypress with overlapping implementers, repair and publication. |
| T13 | 93/93 fault/adapter/refusal cases and conservative cleanup; SIGKILL evidence and independent cleanup review. |
| T14 | Guarded source composition, disposable cutover/rollback and legacy retirement; cutover suite, monitoring regression tests and retirement inventory. |
| T15 | Contributor/configuration/recovery docs, final local gates and combined independent review. |

### Final checks

| Command / scope | Result | Local evidence |
| --- | --- | --- |
| `npm run verify` | Passed: backend 613 passed, one platform skip; UI 114 passed; lint/types/build passed | `/tmp/cmux-t15-verify.log` |
| `npm run test:coverage` | Passed; backend line coverage **98.34%** | `coverage/backend.lcov`, `/tmp/cmux-t15-backend-coverage.log` |
| `npm run test:ui:coverage` | Passed 114 tests; UI line coverage **96.10%** | `coverage/ui/lcov.info`, `/tmp/cmux-t15-ui-coverage-final.log` |
| `npm run test:e2e:local` with Chrome/port 3327 | Passed 78 monitoring tests; three real-service cases intentionally pending in this mode | `/tmp/cmux-t15-cypress.log` |
| Real-service orchestration Cypress | Passed two writable workflow tests; read-only case belongs to separate mode | `/tmp/cmux-t14-cypress-core.log` |
| Real-service orchestration Cypress `--read-only` | Passed read-only case; writable cases intentionally pending | `/tmp/cmux-t14-cypress-readonly.log` |
| Independent combined architecture review | Approved; 125/125 cross-boundary tests passed, including four real-Git journeys and SIGKILL recovery | Reviewer `/root/domain_review`; final source review after T14 edits |
| Independent retirement/docs review | Approved; strict monitoring schemas, removed entrypoints, model-setting scope and operator limitations reviewed | Reviewer `/root/scheduler_admission_review`; final source review after documentation corrections |

The Cypress commands use `--orchestration --spec cypress/e2e/orchestration-core.cy.ts`
for real-service mode. Chrome was explicitly selected and port 3327 avoided an
existing listener; no port owner was killed. Fixtures use private disposable
paths, fake agents/GitHub and real temporary Git. The three mode-specific cases
all ran across writable/read-only invocations. Browser evidence and diffs are
retained under ignored `cypress/results/`; logs and coverage are local artifacts,
not public source files.

### Review fixes and interventions

The retirement checkpoint exposed obsolete tests for removed routes, timer
consumers, planner controls and heading structure; those were retired or ported
while preserving monitoring cases. The concrete cmux-client suite was restored
after an overbroad initial test retirement. Final independent review caught
misleading model controls: only supported manual coder defaults remain visible,
with accurate scope text. Existing saved keys are preserved.

Cutover review caught ignored/hidden-file cleanup risks (fixed in T13), empty
startup reservations stranding corrected configuration, pathname-only journal
binding, legacy/replacement database overlap and inherited Fastify coercion.
Regression cases prove the fixes. During final coverage, one asynchronous queue
read exceeded the default one-second UI readiness wait under concurrent load;
its wait is now five seconds, with unchanged save-failure/retry assertions. The
focused coverage run and complete 114-test coverage rerun passed. Initial failed
checkpoints are retained below; there are no unresolved final local test failures.

### Delivery boundaries and remaining operational work

The [retirement map](orchestration-retirement.md) and
[machine inventory](orchestration-retirement-inventory.json) identify removed and
retained modules, routes, UI and tests against `b33569a`. The
[architecture/configuration map](orchestration-architecture.md) documents the
command vocabulary, graph/review rules, execution bounds and retention policy.
Source wiring requires explicit private configuration before background work;
legacy approval is never imported automatically.

**Not performed or claimed:** installed cutover, merge, deployment, release or
open-source publication. Real provider permission enforcement/model quality,
cmux continuity and live GitHub behavior remain unverified. No live-test
execution was authorized. Offline adapter tests do not substitute for those
operational checks.

The sibling updater installer does not currently propagate the required
`CMUX_COMPANION_ORCHESTRATION_CONFIG` into its LaunchAgent environment. Before an
installed rollout, the operator must establish persistent configuration, complete
installer compatibility, inventory/backup/drain old owners and rehearse startup
and rollback as documented. Local source delivery does not make the installed
upgrade ready. This operational integration is explicitly outside the plan's
source-only cutover and local acceptance boundary.

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

## T08 conflict-repair acceptance

Verified integrator output now becomes a durable repair intent before any Git
mutation. The scheduler-owned coordinator advances the recorded integration ref;
agents cannot invoke the preparation/settlement commands. Git creates a commit
with the verified repair tree and recorded integration parent, then atomically
records the goal/applied refs. The private proposal binds goal, repository,
integration operation, effect, attempt, generation/revision, target, candidate and
proof identity. Replays cannot substitute another repair, and read-only observation
requires the private proof and delta artifacts to remain available.

Workflow settlement records the integrated task, result disposition and receipt in
one transaction. Unsent work is cancelled on abort or repository withdrawal. Sent
work remains owned until external evidence is known; late success after abort is
recorded without reviving approval or accepting stale agent authority. A stopped
worker releases capacity while the pending result/effect retains its lifecycle.
Duplicate output cannot fail the attempt owning an already prepared repair.

The real scheduled fixture now has both nonconflicting and conflicting sibling
variants. In the conflict variant, an isolated integration agent resolves the
recorded A/B conflict, Git proof and ref advancement complete, and C starts from
the combined head. C then fails its exact-checkout acceptance test, receives an
independent blocking review, repairs once, passes renewed review and integrates.
Both variants pass final fixture checks without live providers or GitHub.

Independent `/root/domain_review` approved the coordinator/domain slice and its
incremental duplicate-output fix; `/root/scheduler_admission_review` approved the
Git repair adapter and observation hardening. Corrections from review:

- Cancelling an unsent result after worker exit left its attempt running/stopped:
  the exact owning attempt now settles failed or cancelled as appropriate.
- Repair observation did not bind the complete target identity: it now refuses
  changed goal, repository, base, role or other recorded identity fields.
- Observation could report success without readable private proof: missing proof
  or delta evidence now yields unknown ownership.

Coordinator coverage includes pending abort/withdrawal, sent abort with observed
success, unknown observations, before/after settlement-commit failures, and prepared
result/early duplicate isolation. Scheduler plus inbox suites passed 35/35. The
reviewer independently reran the coordinator suite before the duplicate addition
(21/21), and inspected that final addition afterward. Git acceptance/tree/replay
checks and three additional real SIGKILL boundaries (private repair proposal,
proposed ref, atomic advance) passed 4/4; final missing-proof regression passed.

An early long-running Git suite loaded the old repair identity format in its
parent while new child processes loaded an edited format, causing three ownership
mismatch failures. A stable-source rerun passed all four repair cases. No safety
check was relaxed. Full `npm run verify` passed on the final implementation:
1,398 backend tests, one platform skip, 257 UI tests, lint, both typechecks and build.

Concurrent coverage then reported `TERMINATION_UNCERTAIN` instead of `OUTPUT_LIMIT`
in the existing immediately-exiting UTF-8 fixture. That fixture now stays alive
until its output-limit termination, as the combined-output fixture already does.
The byte-budget and cause assertions remain intact; no runtime code changed.
Targeted runtime coverage passed 15/15 and the fixture correction received separate
review. Full coverage then passed without a competing verification suite:
1,398 tests passed, one macOS filename skip, backend line coverage 98.28%. The
final fixture also passed targeted ESLint. Logs: `/tmp/cmux-orchestration-repair-verify.log`,
`/tmp/cmux-orchestration-repair-coverage.log` (initial failure), and
`/tmp/cmux-orchestration-repair-coverage-final.log` (passed rerun).

Final-review/check repair, combined verification and publication, production
adapters, complete service-process fault matrix, scripted cancellation ownership,
mobile E2E and retirement remain unfinished. Settlement interruption tests here
use transaction failpoints; the Git-boundary tests use actual SIGKILL. No live or
installed service, merge, deployment or public release was exercised.

## T09 combined-commit verification

The scheduler now records verification intents for fully integrated approved goals
and executes checks asynchronously in a separate owned checkout at the exact
combined commit. Repository policy resolves approved argv to explicit executables,
environment identities and bounded process policies. Private per-check artifacts
record outcomes, output, target SHA and environment evidence; mutation of the
checkout, unavailable commands, failure and cancellation cannot pass.

A durable request precedes provisioning and launch. Completed operation receipts
replay without rerunning commands and bind the goal, repository, target, check set
and approved arguments to immutable artifacts. Interrupted work without a receipt
remains uncertain. Unknown verification ownership retains the global verification
slot across coordinator replacement, independently of ordinary agent capacity.
Shutdown aborts and joins locally owned jobs before releasing scheduler ownership.
Late results remain history after abort; failed stopped checks require explicit
retry, and unsettled checks block final repair and publication.

Independent reviewers approved the domain/coordinator and runner slices.
The coordinator review found a P1: the original in-memory job count released the
verification slot after an unknown result or restart. The durable cross-goal gate
and two-goal/restart regression fixed it; the reviewer independently passed all
30 scheduler tests. The runner reviewer approved receipt binding and independently
passed the request-rebinding regression. Checked-JS initially found three missing
callback type annotations in that hardening; annotations now pass typechecking.

Focused scheduler, verification and real-Git delivery tests passed 42/42.
Both real scheduled fixture variants now run the actual verification adapter and
require passing evidence at the same head as the independent final review before
publication intent. Full `npm run verify` passed: 1,416 backend tests, one platform
skip, 257 UI tests, lint, frontend/backend typechecks and build.
Evidence: `/tmp/cmux-orchestration-verification-focused.log` and
`/tmp/cmux-orchestration-verification-verify.log`.

This slice does not close T09: final-review/check repair ref advancement, target
branch movement, push and PR adapters remain required. Incomplete verification
process recovery currently fails closed; the remaining fault/reconciliation work
must establish worker termination before retry. Production composition, mobile
real-backend Cypress, retirement and final architecture review are still pending.
No live or installed integration, merge, deployment or release ran.

The first coverage run failed only the new restart regression's assumption that
goal h always queues second. Verification operations can tie in ordering, and the
one-launch assertion already passed. The corrected assertion requires exactly one
unknown worker and one pending run across both goals, retaining the launch count
and ordinary-admission checks. Targeted scheduler coverage passed 30/30; independent
review approved the correction. Initial log:
`/tmp/cmux-orchestration-verification-coverage.log`.

Final isolated backend coverage passed: 1,416 tests, one platform skip, **98.24%
line coverage**. Log:
`/tmp/cmux-orchestration-verification-coverage-final.log`.
No UI code changed in this slice; real-backend Cypress remains unimplemented.

## T05 scripted cancellation correction

The scripted-agent fixture now owns an AbortController per launch. Termination
requests signal cancellation without marking the script stopped. Script execution
and in-flight result delivery must finish before observation reports stopped;
aborted output that has not been submitted is suppressed. A lost launch response
no longer prevents the already-recorded worker's script from starting.

Barrier tests exercise a script that ignores cancellation, cancellation before
script startup, in-flight result delivery, ignored termination and lost response.
A real service/scheduler abort test verifies capacity remains owned while the
aborted script still runs, then releases after exit with no late result or new
launch. Its initial fixture omitted provisioning baseSha, so the script never
launched; the corrected fixture returns the full recorded identity and explicitly
asserts launch before waiting on its barrier.

Independent reviewer `/root/domain_review` approved the fixture correction and
the incremental scheduler regression, independently passing all four parallel
tests. Dependent delivery, inbox, reconciliation and parallel checks passed 29/29
before the fourth test; scheduler/planning/parallel checks then passed 37/37.
Targeted ESLint passed. Logs: `/tmp/cmux-orchestration-script-cancellation.log`
and `/tmp/cmux-orchestration-script-lifecycle.log`.

This corrects test-harness ownership; it does not establish production provider
termination or close the remaining full service-process fault matrix. No production
code or UI changed in this correction. Full verify and 98.24% backend coverage
above apply to `f4a9cdd`; this follow-up runs the affected fixture consumers.

The remaining fixture consumers (candidate-result and runtime suites) passed
24/24. Log: `/tmp/cmux-orchestration-script-dependents.log`.

## T09 final-review and failed-check repair

Final integrator results now pass the same independent Git candidate proof as
conflict repairs, bounded to the union of approved task-owned areas. Intake reserves
a durable final integration effect before mutation. The existing scheduler-owned
repair coordinator applies it; agents cannot advance the integration ref or accept
their own output. Task checkpoints remain history, while the final repair records
its own integration receipt and clears verification at the previous head.

Final repair uses a private operation manifest, verified candidate tree, proposal
identity and atomic goal/applied refs. The durable identity includes taskId, which
distinguishes final and conflict repair. Replays cannot switch that identity or
overwrite a moved goal head. A new head requires independent final review and a
fresh run of every approved check.

The real scheduled fixture now has four journeys: ordinary siblings, a sibling
conflict, a blocking final review, and a failing required combined-commit check.
The failing check verifies dependency injection in composition; final repair adds
that behavior without changing verification or test files. Both final-repair
journeys assert publication is blocked before repair, one bounded repair, two
distinct verification targets and accepted independent review at the final head.

Independent domain review found a recovery blocker: an externally completed final
repair followed by a DomainError left integration failed, and later observed
success could not settle. The final path now accepts proven success for its owned
failed operation, matching conflict recovery. The expanded coordinator matrix
covers both kinds across unsent cancellation/withdrawal, sent abort, unknown
observation, external success followed by error, and before/after database
settlement interruption; exactly one application is required.

Reviewer `/root/domain_review` approved the fix and independently ran 38/38
scheduler tests. Reviewer `/root/scheduler_admission_review` approved the adapter
and independently ran three identity/replay/moved-head regressions. An initial
review comment that taskId was missing relied on stale code; the reviewer re-read
the diff and explicitly retracted it. The added null/A/B mismatch tests confirm
both acceptance and observation refuse a different repair identity.

Targeted real Git acceptance and actual SIGKILL checks passed 9/9 before the
additional moved-head regression. Final repair adds four process-kill boundaries:
manifest recorded, private proposal recorded, proposed ref and atomic advancement.
Each reopens twice and proves one commit; these are completed durable boundaries,
not arbitrary interruption of still-running Git commands. Checked-JS and targeted
ESLint passed. Logs: `/tmp/cmux-orchestration-final-repair-git.log`,
`/tmp/cmux-orchestration-final-repair-focused.log`, and
`/tmp/cmux-orchestration-final-repair-coordinator.log`.

T09 remains incomplete until target-branch observation, safe push, PR publication
and remote-response reconciliation are implemented. Production/mobile composition,
full process fault recovery, cleanup, retirement and final architecture review
remain required. No installed or live integration, merge or release ran.

Full `npm run verify` passed on the final reviewed implementation: 1,435 backend
tests, one macOS filename skip, 257 UI tests, lint, frontend/backend typechecks and
build. Log: `/tmp/cmux-orchestration-final-repair-verify.log`.

Final backend coverage passed all 1,435 tests with one platform skip and **98.25%
line coverage**. Log: `/tmp/cmux-orchestration-final-repair-coverage.log`.
Real-backend mobile Cypress remains a later required gate; no UI code changed.

## T09 durable publication through an observed PR

Publication intent now records repository, head branch/SHA, base branch/SHA and
stable goal marker before external work. The scheduler admits publication only
after passing required checks and independent final review at the current head,
with no live workers or integration effect. Asynchronous publication does not
block ordinary agent admission; shutdown joins local requests and retains a
resumable intent for an otherwise authorized goal.

A private publication manifest binds configured remote and GitHub identities.
Exclusive sent-marker claims precede conditional push and PR creation. Replay
observes exact remote/PR identity; absence after an uncertain sent request never
causes a second create. Abort fences requests not yet sent, while a previously
sent PR is recorded honestly without reactivating the goal. Matching closed/merged
PRs remain historical delivery evidence even if their source branch was deleted;
an open missing branch or present mismatching branch remains uncertain.

Git pushes run from an isolated bare staging repository, excluding source-repo
URL rewrites, credential helpers and remote hooks. Git writes pack/index files
directly to private disk; reachable history is not buffered in Node. Destinations
and transport environments are explicitly injected. GitHub CLI calls use bounded
API requests and JSON stdin, with exact repository, branch, marker and head checks.
The fake composition uses only a disposable local bare remote and fake GitHub,
without loading account credentials or invoking gh.

Target movement before a PR request is explicit and blocks publication. Movement
after an already sent request is reported alongside its observed result. No
automatic rebase or target-branch rewrite is performed; abort remains available.
Changing an integration commit continues to require renewed review/verification.

All four real scheduled Git journeys now finish with one fake-GitHub PR whose
head equals the verified/reviewed integration commit and the actual remote branch.
Adapter tests cover lost successful responses, interrupted request boundaries,
ambiguous/unrelated PRs, remote branch conflicts, target movement, abort timing,
tampered receipts, concurrent resumes, staging initialization and an 18 MiB
incompressible history. Offline GitHub CLI tests verify canonical repository
casing, request identities, JSON stdin and malformed inventory refusal.

Independent review and corrections:

- The adapter initially overwrote PR sent markers after an awaited observation,
  permitting two concurrent creates. Atomic exclusive claims fixed the reproduced
  race; the concurrent-resume regression proves one create.
- A bounded stdout buffer initially constrained full repository history. Disk
  pack/index output removes that limit; the large-history regression passes.
- GitHub URL casing now accepts canonical owner/repository casing while retaining
  the exact host, repository identity and PR number.
- Coordinator restart initially attempted dispatching → dispatching, an invalid
  transition. Only pending operations now transition; existing sends reconcile.
- Shutdown initially completed cancelled intents for still-ready goals, stranding
  them. The intent now remains resumable, and a restart regression reaches delivery.
- A test used a nonexistent ownership property and closed its database before
  failed-test cleanup joined scheduler work. The assertion and cleanup order were
  corrected; no safety assertions or coverage thresholds were removed.
- A later review extended closed/merged PR reconciliation to deleted branches,
  preserving exact sent evidence and the PR head SHA.

Reviewer `/root/domain_review` independently passed 44 scheduler tests after
the recovery corrections. Reviewer `/root/scheduler_admission_review` passed
five adapter regressions, then the terminal-PR/real-branch-deletion regression.
Both approved their final incremental slices. Earlier combined testing had
69 passes and two scheduler failures; corrected targeted scheduler checks passed
44/44. Adapter checks passed 19/19 before the final terminal-state expansion,
which passed separately. Checked-JS and targeted lint passed at those snapshots.

Logs: `/tmp/cmux-orchestration-publication-journey.log` (initial scheduler failures),
`/tmp/cmux-orchestration-publication-coordinator.log`,
`/tmp/cmux-orchestration-publication-adapter-final.log`, and
`/tmp/cmux-orchestration-publication-terminal-pr.log`.

Publication interruption tests here use failpoints and durable filesystem receipts.
The full service-process/external-subprocess fault matrix remains T13 work.
Native SSH/GitHub authentication and subprocess survival are unverified; no live
adapter test, installed service, merge, deployment or release ran. Isolated runtime
composition, event consumers, provider/cmux permissions, mobile real-backend Cypress,
cleanup, cutover/retirement and final architecture review remain required.

Full `npm run verify` passed on the final reviewed publication slice: 1,460
backend tests, one macOS filename skip, 257 UI tests, lint, frontend/backend
typechecks and build. Log: `/tmp/cmux-orchestration-publication-verify.log`.
The four account-free real-Git journeys now reach the M3 observed-PR outcome;
remaining M4/M5 work is not implied complete.

Final backend coverage passed: 1,460 tests, one platform skip, **98.23% line
coverage**. Log: `/tmp/cmux-orchestration-publication-coverage.log`.
No UI code changed in this slice; real-backend mobile Cypress remains outstanding.

## T10: isolated composition, durable consumers and disposable development

The explicit asynchronous composition root now constructs the new service,
repository/check/publication adapters, scoped result intake, scheduler, journal
consumers, public SSE and paired HTTP routes without constructing legacy services.
Construction is inert. Listener binding precedes scheduling; concurrent start/bind
paths cannot bypass that ordering. Shutdown joins work while retaining exclusive
scheduler ownership, and a failed cleanup permits only cleanup retry, never restart.

A persistent journal identity namespaces consumer idempotency keys and browser
cursors across database reopen/replacement. Durable consumers acknowledge only
after delivery; sinks must deduplicate the stable key across delivery-before-ack
crashes. Public events omit private payloads/command IDs and invalidate snapshots.
SSE supports consistent snapshot/replay and expired/foreign-cursor resync. Each
client buffers at most one bounded frame and pauses until drain; a bounded drain
timeout removes stalled clients without pinning journal retention.

`npm run orchestration:dev` runs real temporary SQLite/Git/check adapters with
scripted agents and fake GitHub. Pairing/token files are private; stdout contains
only connection paths/address. Explicit loopback ports fail safely if occupied.
Inherited Companion configuration cannot activate live adapters. The HTTP journey
covers separate A/B workers, C review/repair, an intentional final-check failure,
renewed review/checks on the repaired SHA, and exactly one fake PR. SIGTERM cleanup
is tested in a real child process. See [development instructions](orchestration-development.md).

Independent review:

- `/root/domain_review` reproduced P1 ownership release before adapter cleanup and
  P1 concurrent start bypassing listener binding. Ownership is now retained until
  cleanup joins, and startup paths are coordinated. Barrier-driven regressions
  cover both. Reviewer then found P2 successful startup after failed cleanup;
  permanent shutdown fencing fixes it while preserving close retries.
- `/root/scheduler_admission_review` reproduced P1 healthy-client disconnect for a
  113,965-byte snapshot above Node's 65,536-byte high-water mark. The stream now
  honors accepted writes and pauses until drain. A real HTTP large-snapshot
  regression and deterministic drain/timeout/error tests cover the correction.
- Both reviewers approved their corrected slices. Domain reviewer independently
  passed 11 composition and two dev tests; stream reviewer passed the event suite
  and real HTTP regression. No remaining blocking findings in these slices.

Checks passed: 92 targeted backend tests, checked-JS, repository lint and
`npm run verify` (1,481 backend passes, one existing macOS filename skip; 257 UI
passes; lint, both typechecks and build). An initial lint failure was one unused
import, removed. One initial dev test failed because its assertion used the wrong
verification-run field; corrected to the recorded result's verification checks.
No safety assertion or coverage threshold was removed.

Logs: `/tmp/cmux-orchestration-t10-focused.log`,
`/tmp/cmux-orchestration-t10-lint.log`, `/tmp/cmux-orchestration-t10-verify.log`.
Backend coverage passed with 1,481 tests, one platform skip and **98.24% line coverage**; log: `/tmp/cmux-orchestration-t10-coverage.log`. No UI code changed; new mobile
controls and real-backend Cypress remain T12. Production provider/cmux adapters,
full fault matrix, cleanup/cutover/retirement and final combined review remain
required. Live adapters, installed cutover, merge and release were not exercised.

## T11 in progress: native role policy and scoped agent tools

The CCS/native Claude command contract now separates interactive planning from
bounded background roles, requires restricted/manual permission capabilities and
strict MCP configuration, and supplies private context through a system-prompt
file. Reviewer tools are Read/Grep/Glob only; planner tools add questions and scoped
proposal submission. Implementer/integrator tools add native file edits and a
scoped commit tool. Shell execution, delegation, unknown MCP tools and approval
are unavailable. A separate hook process denies unsupported tools without granting
native permissions. Structured native output must contain one successful result
for the recorded conversation; application-level role/Git proof remains mandatory.

The scoped commit tool takes only an idempotency ID, expected head and message.
Server credentials select the goal, attempt, worktree and approved scope; the caller
cannot supply another path or branch. Fixed Git operations capture and validate an
immutable tree, then atomically advance the owned attempt branch and its commit
receipt. Resource ownership refs are checked before staging and in the ref
transaction. Lost responses reconcile the same commit. This tool does not accept,
integrate or publish work. Actual sibling-conflict repair checkouts are covered.

The stateless MCP subprocess binds planner output identities from its private
configuration, exposes only named role tools, and still relies on server authority
if local role configuration is spoofed. Both input and output frames are bounded;
output completion is awaited before consuming another request. A stalled reader
causes bounded protocol failure and immediate subprocess exit, preserving server
receipts for retry. No database imports or generic shell command were added to
the agent transport.

Independent reviews and corrections:

- `/root/domain_review` reproduced a missing resource ownership-ref check (P1) and
  found mutable-index scope validation before tree capture (P2). The adapter now
  validates ownership before work and during atomic ref advancement, and validates
  the immutable tree actually committed. Regressions exercise missing/revoked refs
  and concurrent index edits.
- The reviewer then found `/agent/commit` missing from agent authentication route
  exclusions (P1). Corrected; real HTTP and MCP subprocess tests prove valid agent
  calls work while reviewer credentials, spoofed local roles, abort and lost
  scheduler ownership remain denied. Reviewer passed all eight then-current
  scoped-tool tests and approved the final route correction.
- `/root/scheduler_admission_review` approved the five native argv/hook/output
  tests, then found unbounded MCP stdout under backpressure (P2). Response limits,
  awaited writes and a deadline resolve it. The first slow-reader regression
  exposed Node waiting on blocked stdout even after destroy; immediate stateless
  bridge exit fixes the hang. Reviewer independently passed the final real
  non-reading-client regression with exit code 2 and empty stderr.

Passed on the final slice: **40 targeted tests** across native tools/policy,
API/bridge, import boundaries, composition and disposable full Git journey;
checked-JavaScript and targeted lint. Logs:
`/tmp/cmux-orchestration-native-tools-final.log` and
`/tmp/cmux-orchestration-native-mcp-stall.log`. Initial failures included the
missing auth exclusion, one stale hard-coded review target in the new test and
the slow-reader exit hang; all were investigated and corrected.

The last complete verify/coverage run remains T10 (`341b090`, 1,481 backend passes,
257 UI passes, 98.24% backend lines). These new targeted checks do not replace the
remaining M4/M5 full gates. Native CLI help/version metadata was read locally
(Claude Code 2.1.268, CCS package 8.9.0); no provider session or live account request
was launched. Production process/session execution, durable identity/recovery,
cmux ownership, native input-file lifecycle and opt-in live adapter cases remain
T11 work. Native permission enforcement is unverified until the authorized live
suite runs; offline hook/argv tests do not establish it.

## T11 in progress: independent native background supervisor

Native input preparation now writes immutable private context, hook/settings and
scoped bridge files outside the worktree. A durable background adapter records
operation bindings before spawning a separate Node supervisor. That supervisor
owns the native process group, output bounds, idle/ceiling timers and atomic result
receipt independently of the service process. Recovery verifies process birth and
command identity, replays result delivery, and never relaunches an uncertain sent
operation. Shutdown attempts all managed workers and retains ownership unless
bounded observation establishes stopped evidence. Constructors start no workers.

Independent incremental reviews by `/root/domain_review` and
`/root/scheduler_admission_review` identified and verified corrections for:

- Service-owned timers disappearing on service SIGKILL: moved execution limits to
  the independent supervisor and tested actual service death.
- Concurrent duplicate bindings and retained completed handles: reject mismatched
  in-flight requests and release completed in-memory handles.
- Escaped descendants losing uncertainty when the original group disappears:
  preserve the executor's durable unknown evidence across reopen.
- PID reuse: require the unique operation-directory command marker when capturing
  process stamps, and revalidate stamps during watcher polling and termination.
- JSON control-byte expansion: cap raw output at 2 MiB in both driver and worker;
  allow a bounded 16 MiB serialized receipt. Invalid output preserves stopped proof
  while producing `INVALID_RESULT`, including exactly 2 MiB of NUL bytes.
- Partial shutdown failure and the signal/receipt race: signal every managed worker,
  join watchers and poll independently for durable stopped evidence within a bound.
  Initial added regression failures exposed immediate unknown observations before
  receipt persistence; the corrected tests and independent re-review pass.

Passed: **11 native-background tests**, **29 related runtime/native-policy/scoped-tool
tests**, backend checked-JavaScript and targeted lint. Evidence:
`/tmp/cmux-orchestration-native-revision.log` and
`/tmp/cmux-orchestration-native-contracts.log`. The two reviewers independently
passed the serialization and lifecycle regressions and reported no remaining
blockers within this slice. Tests use disposable executable fixtures, actual
subprocesses and explicit ready/release barriers; no live providers were used.
The escaped-descendant test explicitly kills only its own extra process and clears
test-instance shutdown bookkeeping afterward; production uncertainty is preserved.

T11 remains incomplete: interactive cmux ownership/resume, production capability
probing, composition/credential handshake and opt-in live contracts remain.
T12–T15 and final full verification/coverage/browser gates remain outstanding.
The prior T10 full-suite snapshot still applies only to its committed code.
Installed cutover, live acceptance, merge and release have not been performed.

## T11 in progress: authoritative native dispatch activation

The composition root now supplies pinned role context and private scoped credentials
to native input preparation. Credentials can be minted for a provisioned attempt
only after its launch intent enters `dispatching`; they remain unusable for agent
status or mutations until `record_dispatch` commits. The independent supervisor
persists its identity, then waits for the loopback `/agent/ready` endpoint before
recording `provider-sent` or spawning the provider. Readiness requires current
running authority, an allowed repository and exclusive scheduler ownership; it
returns no workflow data. Reviewers receive no MCP tool credential. Activation
waits are bounded, cancellable and redirect-free; private credentials and response
bodies are never logged or reflected. Failure before provider send preserves
stopped evidence and a structured cause.

Passed: four new native-launch tests and 35 related supervisor, composition,
API/bridge and import-boundary tests; checked-JavaScript and targeted lint.
The real SQLite/scheduler/HTTP/Git scenario pauses after supervisor identity,
proves there is no provider send or process before dispatch commits, then accepts
one pinned independent review without granting user approval. Its abort variant
proves no provider process starts. Authority tests cover missing ownership,
repository removal, replaced generations and explicit revocation. Evidence:
`/tmp/cmux-orchestration-native-launch.log` and
`/tmp/cmux-orchestration-native-handshake-related.log`.

`/root/domain_review` approved the authority/composition slice and independently
passed the initial three launch cases, 11 composition cases and four bridge cases.
`/root/scheduler_admission_review` approved the lifecycle slice, independently
passed the initial launch suite and additional local HTTP retry, denial, abort and
10-second timeout checks. An initial checked-JS error from an overbroad route edit
was fixed before validation. No live provider, cmux, account or installed state was
exercised. Actual service SIGKILL during this activation handshake remains a T13
matrix case; the earlier native supervisor SIGKILL scenario has no activation wait.
Production capability probing and interactive cmux/resume still remain in T11;
T12–T15 and the final full verification gates remain open.

## T11 offline adapter milestone complete

Production `createNativeAgents` now combines explicit, probed CCS/Claude inputs
with independent background supervision and a dedicated cmux terminal adapter.
`probeNativeCapabilities` validates the initial supported CLI versions and required
flags, pins the canonical native executable, and rechecks installation evidence
before provider startup. Production construction requires that probe; only
standalone fixture drivers can inject capabilities directly. Metadata probing does
not invoke CCS startup, discover provider profiles or inherit credentials.

Interactive planners inherit a real terminal's stdin/stdout/stderr, have no idle
or ceiling timeout during user/permission waits, and retain one native conversation
UUID across explicit resumes. Cmux creation and runner-send receipts precede their
effects; recovery correlates operation, workspace and process birth/command identity.
Lost responses never create a second workspace. Terminal foreground interruption
is forwarded to the owned provider group. A paused conversation retains ownership;
explicit stop joins the group or reports uncertainty. No terminal prose or Stop
notification produces workflow acceptance.

The `resume_planner` user command persists a versioned intent. Stable internal
hash-derived IDs make response loss and result-before-intent-settlement recoverable
without duplicate provider runs or another conversation. Current-generation,
role, capability, repository and user-authority checks remain service-owned.
The paired terminal-opening route focuses only the current owned planner and denies
read-only clients, stale versions, cross-attempt targets, abort and missing ownership.

Independent reviews:

- `/root/domain_review` approved capability/installation binding and four capability
  tests, then found two P2 resume-ID problems: a maximum-length user ID exceeded the
  internal result-ID limit, and `initial` collided with a runner marker. Bounded
  hash-derived adapter/result IDs resolve both. The reviewer independently passed
  the 128-character regression, durable resume suite and terminal-opening guards,
  and approved the final integration changes.
- `/root/scheduler_admission_review` found a P2 resume/close race after an awaited
  observation. The post-await shutdown guard and real PTY barrier test resolve it.
  The reviewer passed all four then-current native-terminal cases and approved the
  fix. A final fifth test validates the narrow cmux transport's fixed command,
  target validation, quoting and credential-bearing error redaction.
- The reviewer reproduced an escaped detached descendant outside the provider's
  group. The declared adapter contract proves **owned process-group termination**,
  not arbitrary process-tree containment. The production constraint and live
  acceptance obligation are explicit in the native adapter runbook; neither this
  adapter nor background supervision claims an OS sandbox or whole-tree proof.

Validation passed: **306 orchestration tests**, **one platform skip**, no failures
in `/tmp/cmux-orchestration-t11-milestone.log`; then **27 targeted tests** after the
final resume-ID/route/transport changes in
`/tmp/cmux-orchestration-t11-final-targeted.log`. Backend checked-JavaScript and
orchestration lint passed. Native launch, background, capability, real PTY,
composition, API and domain/application boundaries were exercised. Discovery tests
confirm the new live suite remains excluded from ordinary runs. The PTY fixture
initially failed because BSD `script` rejects Node's socket-backed stdin; a fixed
shell pipe bridge resolves it without adding a package dependency or using cmux.

[`docs/orchestration-native-adapters.md`](orchestration-native-adapters.md) records
configuration, supported versions, authority, native input lifecycle, limitations,
and exact opt-in prerequisites. `tests/orchestration-agents.live.mjs` defines an
explicitly gated real-provider reviewer case in disposable Git; the runbook defines
operator-observed permission waits, resume, actual denial, group death and cmux
recovery cases. **No live case was run.** Offline evidence does not establish native
permission enforcement, terminal continuity in actual cmux or provider quality.

The replacement remains isolated from installed production wiring. T12's mobile
UI/real-backend Cypress milestone is next; T13 fault-matrix completion and cleanup,
T14 guarded source cutover/legacy retirement, and T15 final combined verification,
coverage, documentation and architecture review remain required. The previous full
`npm run verify`/coverage snapshot remains T10; the M4 full gate follows T12.
Installed cutover, merge, deployment and release remain unperformed.

### T12 / M4 — Mobile replacement journey

Implemented `/orchestration`: pairing, configured repositories/capacity, goal creation,
service-derived actions, reviewed revision approval/feedback, task graph, worker
ownership, independent findings, verification and PR evidence. Stale responses
refresh authoritative state; uncertain mutations retain the exact original command
for replay. Read-only guards cover UI and HTTP. SSE invalidations and polling
refresh the board; switching goals cannot invalidate the selected detail through
an older mutation. Failed revision feedback is retained.

The local Cypress runner now starts the real isolated replacement service and
actual temporary Git repositories, with only agent/GitHub boundaries scripted.
It proves simultaneous A/B work, C's integrated dependencies, blocking review and
repair, final verification failure/repair, exact publication SHA and one PR,
reload, mobile overflow, abort/reconciliation and separate read-only protection.
Owned processes/resources are cleaned; sanitized state and fixture diffs survive
under ignored `cypress/results/`. No workflow API responses are stubbed.

Passed: backend 1,526 tests, one existing platform skip; UI 262 at the full-run
checkpoint, then 6/6 targeted orchestration tests including both incremental UI
review fixes; lint, frontend/backend types and production build. Writable Cypress
2/2 passed; separate read-only run 1/1 passed (the mutually exclusive cases are
intentionally pending in each mode). Final writable rerun also retained fixture
diffs successfully. Logs: `/tmp/cmux-orchestration-t12-verify.log`,
`/tmp/cmux-t12-{ui,lint,types,build}.log`,
`/tmp/cmux-orchestration-t12-cypress-final.log`,
`/tmp/cmux-orchestration-t12-readonly.log`.

Investigated failures: occupied default port (used 3327 without stopping its owner),
ambiguous Cypress check selector, publication branch evidence lookup, missing test
matchers, and two lint issues. All corrected and affected checks rerun. Chrome
was selected explicitly, not as evidence of an Electron failure. Independent
reviews found projection scaling, captured-branch identity, evidence freshness,
recorder cleanup, startup cancellation, and UI feedback/selection races; fixes
and regressions address them. Reviewer fault injection independently confirmed
cleanup after evidence-write failure. Native permissions/cmux/live GitHub remain
unverified; final coverage, T13–T15 and installed cutover remain separate gates.

### T13 — Durable fault matrix and conservative cleanup

Added actual SIGKILL/restart cases for six SQLite transaction boundaries, all four
agent roles at intent/dispatch/identity settlement, all four role-result inboxes,
seven push/PR boundaries (including successful external effects before response),
abort/termination, consumer delivery and cleanup. Persistent fake external
inventories count actual launches/PR creation separately from workflow intent.
Integrator intake remains a prepared repair until the separately tested real-Git
integration protocol accepts it. Sent-but-unobservable publication stays unknown.

`node scripts/run-orchestration-faults.mjs` passed **93/93** local cases and wrote
`coverage/orchestration-faults.json` with fixed fixture seed, case status, failpoint
observations and expected invariants. Fifty-seven process-boundary cases carry
structured observed counts/state; the remaining cases are refusal/adapter
regressions with executable assertions. Real-Git integration/repair crash suites
are included, rather than replaced with thrown mock errors.

Added authenticated cleanup preview/execution and separate durable cleanup receipts.
Only terminated attempts on delivered/aborted goals without pending effects qualify.
Cleanups retain branches/refs/manifests/artifacts and never replay workflow effects.
Ignored files, hidden index flags, dirty/untracked data, changed heads/registration,
recreated paths and uncertain workers are refused. Actual crash recovery finishes
only the recorded worktree and its registration. Native sessions and retained
recovery evidence are not automatically collected.

Passed: 14 cleanup tests, 12 four-role dispatch recovery cases, 17 transaction/
publication/abort/consumer cases, 19 result-inbox tests, API/composition 19 tests,
checked JS/TypeScript and lint. Independent cleanup review approved after fixing
reproduced ignored-file and assume-unchanged data-loss risks, head revalidation,
and absent-directory registration replay; both flag-retention cases passed
independently. Fixture errors (canonical temporary remote path, integrator branch
provisioning and isolated candidate-proof fields) were investigated and corrected.
Logs: `/tmp/cmux-t13-matrix-final.log`, `/tmp/cmux-t13-{cleanup,role-recovery,faults,result-matrix,api,types,lint}.log`.
Runbook: `docs/orchestration-recovery.md`. T14 source retirement and T15 final
whole-project checks remain; no installed resources or live adapters exercised.


### T14 retirement checkpoint

The [retirement map and operator runbook](orchestration-retirement.md) and
[machine inventory](orchestration-retirement-inventory.json) record the removal.
Production now requires an explicit private configuration and separate journal;
monitoring remains encapsulated with strict input schemas. Native Inbox and
local-app navigation remain reachable from the sessions home.

Passed at this checkpoint: 88 targeted monitoring/client/cutover tests; 25 page
UI tests; 38 retained feature/helper/grid UI tests; lint and typecheck. The
independent cutover reviewer approved the journal-identity, failed-reservation
and legacy-path separation fixes after 7/7 cutover tests.

The initial complete backend run passed 612 tests, skipped one platform-specific
case and failed one discovery assertion referring to removed `test:installed`.
That obsolete entry was removed from the assertion; discovery then passed 2/2.
Complete verification is rerunning. Regular Cypress is running on explicit
Chrome and port 3327; it exposed remaining planner-only cases in the mixed model
settings spec. Those cases were retired while preserving settings persistence,
choice and error handling checks; their rerun remains pending. No installed or
live services were exercised. T14 is not yet committed or claimed complete.

Subsequent T14 checkpoint: the complete backend rerun passed 613/614 with one
platform skip. After limiting model settings to the supported manual coder role,
the UI settings regression was ported and all 114 UI tests passed. Lint,
typecheck and build passed on this source. The initial regular Cypress run had
73 passed, eight failed and three intentionally pending real-service cases;
affected model-settings and sessions-workspace specs then passed 14/14 after
retiring planner-only cases and updating the retained Sessions heading level.
The independent retirement reviewer approved the complete bounded audit,
including accurate manual-session model-setting scope. Real-service Cypress and
both coverage commands are in progress; no combined final gate is claimed yet.
