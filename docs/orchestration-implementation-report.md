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
| T03: authority transport | Foundation implemented | Paired user API, scoped hashed agent credentials, bridge subprocess commands, repository allow-list and stale-authority checks. Candidate/repair submission deliberately remains unavailable until the Git evidence adapters in T07–T08 are connected. |
| M1 durable-decision gate | Passed for foundation | Review and verification below; no production scheduling activated. |
| T04: scheduler and recovery | Implemented, independently reviewed | Exclusive nonce-fenced ownership, transactional capacity, durable FIFO, explicit retries, abort reconciliation and fresh-process crash recovery. |
| T05–T06 / M2 | In progress | Runtime primitives and real-Git concurrent fake implementers now pass targeted tests; scheduled role-result/review/repair workflow and complete result crash cases remain. M2 has not passed. |
| T07–T09 / M3 | Pending | Disposable real Git task repository, worktrees, integration, verification and PR adapter. |
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

T05/M2 is not declared complete. Role output schemas, result reception/commit
crash coverage, scheduled review/repair and an A/B/C integration journey remain
required in T05–T09. The native interactive driver and production permission waits
are still T11 work; fake routing does not establish live terminal behavior.
