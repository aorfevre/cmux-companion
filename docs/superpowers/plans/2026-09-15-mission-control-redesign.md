# Mission Control implementation plan

Contract: [approved redesign](../specs/2026-09-15-mission-control-redesign.md).
Human review: user authorized implementation after spec commit `7c7e9b5`.
Owner: primary coding agent; no delegated implementation.

## Delivery sequence

1. Replace the goal Kanban/modal entry with a desktop Mission Control fleet,
   responsive navigation, Needs You and persistent goal detail sections. Preserve
   pairing, service-authorized commands, uncertain-request receipts and live reads.
   Refactor shared navigation/theme so Setup and standalone Sessions agree.
2. Add explicit title/brief and durable safe reference attachments, including
   agent context and authenticated retrieval. Validate input at the API boundary.
3. Combine planning/design responsibility and extend approved contracts with
   ordered waves, independent task ownership, team assignments and rationale.
   Add wave admission barriers and integration/check gates without weakening
   existing exact-target review or ownership checks.
4. Introduce goal-scoped dispatch holds and manual recovery across execution,
   blocking findings, verification and integration failure. Let active work settle
   while preserving the hold; unrelated goals continue.
5. Add explicit publication approval and durable passive GitHub PR observation.
   Poll only waiting PRs every 15 minutes, persist last checks/errors, isolate
   failures and stop polling confirmed merges. Add fake-clock/restart tests.
6. Rebuild Setup around projects, launch profiles, team defaults and existing
   account usage. Propose eligible allocations with source/freshness and unknown
   balances; approve the proposal with the plan. Preserve attempt snapshots.
7. Expose all judgment-agent attempts through visible cmux execution, retaining
   background deterministic checks/Git/publication and inspectable evidence.
8. Remove retired Inbox, prompt queue, preview and notification product code,
   APIs, jobs and obsolete storage consumers after tracing retained dependencies.
   Keep session input and updater paths; never reset installed state for tests.
9. Update documentation and Cypress journeys; run full verification, coverage and
   responsive browser checks. Review the complete diff and create a PR to main
   with passed/failed/unverified evidence and remaining live-validation limits.

## Verification and evidence

Each implementation step runs relevant bounded tests first. Maintain an evidence
report against every acceptance row in the spec; passing pre-existing tests alone
does not establish redesign behavior. Final checks: `npm run verify`, relevant
`npm run test:e2e:local`, backend/UI coverage at least 90%. Use disposable Git and
fake providers/GitHub; do not invoke native live suites or installed updater.

Updater regression must cover busy workers, publication/reconciliation operations
and waiting-for-merge idle behavior. Restart tests cover snapshots, attachments,
holds, assignments and poll cadence. UI tests cover keyboard navigation, empty,
loading/error/unknown states and narrow layouts as well as populated desktop views.

## Boundaries

UI consumes service projections; it cannot independently grant workflow authority.
API validates commands and attachment access. SQLite retains state and ownership;
background coordinators own admission, checks and merge observation. Native cmux,
provider CLIs and GitHub remain explicit external adapters. Worker hosting is
inapplicable to the local Mac bridge; no deployment, merge or installed-data reset
is part of implementation authorization.

Any spec error is corrected in a separate spec commit before revising this plan.
The representative evaluation goal and success target are user-deferred; record
them when selected without substituting simulated performance as success evidence.
