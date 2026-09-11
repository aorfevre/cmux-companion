# Orchestration retirement and cutover

The replacement owns planning, parallel implementation, independent review,
integration, verification and PR publication. General cmux monitoring remains a
separate encapsulated Fastify plugin. This is a source cutover: no installed
service, user database or existing session was changed during implementation.

The [machine inventory](orchestration-retirement-inventory.json) lists deleted
source, tests and scripts and the removed/retained monitoring routes against
`b33569a`. Replacement routes are registered by the orchestration runtime.

| Former owner or entry point | Disposition and replacement |
| --- | --- |
| WorktreePlanner, plan store and schema | Removed; domain commands and the separate orchestration SQLite journal own new goals. |
| GoalSessionService, bridge and runner | Removed; capability-scoped bridge and native agent adapters own planner continuity. |
| GoalIntegrator and followups | Removed; scheduler effects and serialized Git integration own task delivery. |
| GoalReviews, PlannerAssessments and GoalOutcomeStore | Removed; exact-target independent review, repair lineage and publication evidence live in the new journal. |
| Burst scanner, scheduling and review; issue-driven goal launch | Removed; excluded product workflows have no constructor, timer or route in production. |
| Watchdog, merge observation, session collectors and legacy cleanup | Removed; worker supervision and receipt-based conservative cleanup replace orchestration lifecycle management. |
| Legacy dashboard, board, goal popups and worktree controls | Removed; `/orchestration` is the goal workflow. Sessions retain Inbox, local apps and terminal controls. |
| Pairing, same-origin validation, repository catalog, terminal input and replay | Retained; strict schemas also apply when monitoring is composed under the new runtime. |
| Account quota, model settings, previews, prompt queue, push and deployment health | Retained for monitoring/manual sessions; quota does not control scheduler admission. |
| Dedicated legacy unit/UI/Cypress tests | Removed with their behavior; new orchestration suites cover authority, graph concurrency, review, integration, publication and recovery. Mixed monitoring suites retain their relevant cases. |
| Legacy installed/live audit scripts | Removed with obsolete orchestration paths; replacement live checks remain explicit opt-in. |

`server/index.mjs` requires an explicit private configuration before starting
services. `production.mjs` checks the legacy inventory and the actual Git
`merge-tree` option contract before repository locks,
checks it again after acquiring locks, probes native capabilities and then
constructs the new runtime. `server/app.mjs` no longer constructs legacy SQL
writers or orchestration background timers. It retains monitoring services only.
Git must support `--write-tree`, `--no-messages` and `--merge-base` (upstream
Git 2.40 or newer). The bounded help probe uses the service's `PATH`, loads no
repository configuration and makes no repository changes. If startup reports
`UNSUPPORTED_CAPABILITY`, install a supported Git and restart with its directory
on that `PATH`; a newer Git in an interactive shell alone does not change the
service environment. Vendor builds are checked by their advertised options,
rather than their version label. This probe applies to read-only production too;
the account-free disposable runtime does not load native production probes.

## Operator procedure

Perform this procedure separately from reviewing or merging the source change.
Use a maintenance window and record every intervention. Never run both versions
against the same repositories while transferring ownership.

1. Identify every legacy database and the exact service/worker PIDs, cmux
   workspace IDs and worktrees they own. Run the read-only inventory with explicit
   absolute paths: `node scripts/orchestration-inventory.mjs legacy /absolute/legacy.sqlite`.
   The output omits prompts but still contains private resource identifiers.
2. Drain or explicitly retire active legacy goals using the old service. Stop its
   owner and only the sessions/resources positively identified as its workers.
   Unknown ownership is a reason to stop the cutover. Do not bulk-kill cmux.
3. Take a consistent SQLite backup after the old writers stop; retain associated
   artifacts, refs and worktrees. Preserve the original database and do not point
   replacement storage at it. Rerun inventory and retain the resulting digest.
4. Prepare a mode-0600 regular JSON file with `schemaVersion: 1`, separate absolute
   `storage.database`, `storage.artifacts` and `storage.resources`, approved
   `repositories`, native adapter configuration, execution `policy`, capacity
   `limits` and `cutover`. The latter contains `legacyDatabases`,
   `legacyOwnerPids`, `legacySessionIds` and the exact `inventoryDigest`.
   A fresh installation still explicitly records an empty inventory.
5. Each repository configuration identifies its absolute allow-listed root,
   GitHub `owner/repo`, remote protocol/destination/environment and nonempty
   verification checks (`id`, `argv`, absolute `bin`, `env`, `environmentId`).
   Native configuration supplies absolute supervisor directory, CCS/Claude/cmux
   executable paths, engine and explicit environments. Keep credentials private.
6. Rehearse with disposable Git repositories and databases first. The automated
   `tests/orchestration-cutover.test.mjs` exercises rejected active legacy owners,
   repository ownership, rollback, failed-setup recovery, journal replacement and
   legacy/replacement path separation without starting installed services.
7. Only after operator approval, point `CMUX_COMPANION_ORCHESTRATION_CONFIG` at the
   prepared file and start the replacement through the approved operational
   process. The server remains loopback-only. Do not migrate legacy approvals:
   manually create and approve a new goal when adopting unfinished work.

## Rollback and evidence

Stop replacement admission and reconcile/stop its workers and pending effects
through the replacement workflow. Stop the replacement owner, then run
`node scripts/orchestration-inventory.mjs rollback /absolute/new.sqlite`.
This command is read-only and refuses active or uncertain owners/workers and
unsettled effects. A successful result is a prerequisite, not an automatic
restart of the legacy service. Review repository changes and preserved evidence
before restoring the old configuration. Do not delete repository ownership
databases or replace journal files to bypass a refusal.

Repository bindings persist both database path and journal identity. A corrected
configuration may replace an empty startup reservation; a replaced journal at
the same path is rejected. Switching databases requires the previously bound
journal to pass rollback checks. Cleanup never deletes retained branches or
agent evidence as part of this cutover.

Local rehearsal does not prove installed cutover, native provider permission
enforcement, model quality, cmux continuity or live GitHub publication. Those
remain separately authorized acceptance paths. Final local verification and
coverage evidence are recorded in the implementation report and PR.

### Recovery after an interrupted worker

Verification commands now run under an independent watchdog. A service crash
leaves its ceiling, idle and output limits active; restart observes the durable
outcome without launching the remaining checks. A failed, stopped verification
can be explicitly retried against its recorded target.

An uncertain worker continues to consume capacity, including after abort. Neither
an operator assertion nor disappearance of its original process group proves that
escaped descendants stopped. Native launches and verification requests record the
kernel boot identity. After an operator-managed reboot, reconciliation can prove
all processes from the earlier boot stopped and release their capacity. Do not
reboot automatically, delete evidence, or forge stopped receipts. Older receipts
without boot evidence remain conservative and require separately established
termination evidence; this change does not fabricate proof for old launches.

Scheduler locks additionally record boot and process birth identity. A proven
new boot or different process birth permits reclaiming a stale PID without killing
its current owner. Missing evidence retains the existing refusal. Never delete an
ownership database to bypass that refusal.
