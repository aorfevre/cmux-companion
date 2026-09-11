# Orchestration contributor map

The [design contract](superpowers/specs/2026-09-11-orchestration-core-refactor-design.md)
owns product decisions. This map explains the implementation boundaries.

| Boundary | Owner and invariant |
| --- | --- |
| Browser/API | `app/orchestration`, `routes.mjs`: paired, same-origin commands; versioned projections expose valid actions and omit private adapter output. |
| Domain | `domain/`: pure graph/state/review decisions; no process, filesystem, SQL or browser dependencies. |
| Persistence | `storage/store.mjs`: one transaction records state, events and effect intents; command receipts make same-ID retries idempotent. |
| Admission | `service.mjs`, `scheduler.mjs`: durable capacity reservation, one current owner per attempt, dependency readiness and explicit retry authority. |
| Processes | Native adapters and supervisor: distinct interactive/background contracts, identity-fenced launch/activation and observed termination. |
| Git | Git adapters: isolated task worktrees, pinned commits, serialized integration, recoverable operations and conflict repair. |
| Review/checks | Independent exact-target review and operator-approved argv checks; stale evidence cannot authorize publication. |
| External publication | Remote/GitHub adapters: reconcile uncertain push/PR outcomes before repeating an external effect. |
| Events | Durable consumers acknowledge only applied events; browser SSE is bounded and reconnects through snapshots. |
| Operations | Cutover, ownership and cleanup: no second repository owner; uncertain workers block reuse; cleanup retains refs and evidence. |

## Commands and identities

User commands include `create_goal`, `publish_contract`, `request_revision`,
`approve`, `abort`, `authorize_repair`, `retry_task`, `retry_attempt`,
`retry_verification` and `resume_planner`. Every command carries an ID, goal ID,
expected version, type and payload. Refresh after a version conflict. After an
unknown transport outcome, retry the identical request with the same ID.

Goal generation fences obsolete attempts; contract revision fences obsolete
approval. Worker state is separate from task/result state. A completed result
does not release an unproven worker. Public projections include task dependency,
candidate/integrated SHA, repair counts, review targets, verification and PR
evidence. Use service-projected actions rather than recreating authorization in
the browser.

Graphs reject missing/self/cyclic dependencies and invalid ownership. Independent
ready tasks may overlap subject to capacity. Dependents use integrated dependency
commits. Implementers cannot approve themselves, reviewers cannot implement, and
integrators receive only scoped repair authority. Contract/task/final reviews
target the exact revision or commit. Repair consumes a bounded budget; a changed
head requires new review and checks. See the native adapter guide for the
capability probe and the limits of offline permission evidence.

## Production configuration shape

This illustrative shape uses placeholder paths and an intentionally invalid
inventory digest. Substitute a reviewed operator configuration; it cannot start
production as written. Secrets belong only in a private mode-0600 configuration
and private credential sources, never in this repository.

```json
{
  "schemaVersion": 1,
  "storage": {
    "database": "/absolute/private/new/core.sqlite",
    "artifacts": "/absolute/private/new/artifacts",
    "resources": "/absolute/private/new/resources"
  },
  "limits": { "global": 4, "perGoal": 4, "planners": 2 },
  "policy": { "ceilingMs": 1800000, "idleMs": 240000, "maxOutputBytes": 1048576, "killGraceMs": 5000 },
  "native": {
    "directory": "/absolute/private/new/native",
    "ccsBin": "/absolute/bin/ccs",
    "claudeBin": "/absolute/bin/claude",
    "engine": { "provider": "claude", "model": "default" },
    "env": {},
    "cmux": { "bin": "/Applications/cmux.app/Contents/Resources/bin/cmux", "env": {} }
  },
  "repositories": [{
    "id": "example",
    "path": "/absolute/disposable/example",
    "github": "example/example",
    "remote": { "url": "ssh://git@github.com/example/example.git", "protocol": "ssh", "env": {} },
    "checks": [{ "id": "unit", "argv": ["node", "--test"], "bin": "/absolute/bin/node", "env": {}, "environmentId": "reviewed-node22" }]
  }],
  "cutover": { "legacyDatabases": [], "legacyOwnerPids": [], "legacySessionIds": [], "inventoryDigest": "REPLACE_WITH_READ_ONLY_INVENTORY_DIGEST" }
}
```

There is no default storage path or implicit legacy adoption. Limits default to
4 global, 4 per goal and 2 planners; all are positive integers. Background policy
fields are mandatory positive integers bounded by the native timer range.
Native adapters also cap output at 2 MiB and terminal termination grace at
30000 ms. Executable/environment capability validation occurs before worker admission.
Production remote protocols are SSH or HTTPS; file remotes and scripted agents
belong to the separate disposable entry point.

Journal pruning is conservative and explicit: `pruneEvents(through)` cannot
advance beyond the slowest registered consumer, active goals, owned workers or
unsettled operations. There is no automatic age-based evidence deletion.
Browser consumers do not hold durable retention; expired cursors receive a
resynchronization snapshot. Worktree cleanup has separate durable receipts and
does not delete branches or native evidence. Back up the journal and referenced
artifacts together; follow the recovery/cutover runbooks before changing owners.

For account-free development use [the disposable fixture](orchestration-development.md).
For production capability requirements use [native adapters](orchestration-native-adapters.md).
For faults and rollback use [recovery](orchestration-recovery.md) and
[retirement](orchestration-retirement.md). No local check establishes installed
cutover, live provider enforcement or public release readiness.
