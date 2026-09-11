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
| T04–T06 / M2 | Pending | Exclusive scheduler ownership, real capacity reservation, reconciliation, deterministic agent harness and scheduled review/repair workflow. |
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
