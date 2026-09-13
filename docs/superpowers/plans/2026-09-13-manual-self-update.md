# Bundled self-update implementation

Implements the approved [contract](../specs/2026-09-13-manual-self-update-design.md).
Human review: user approved after 392144c on 2026-09-13.
Owner: implementing agent; all integration and cleanup remain with that owner.

1. Import updater source, license and tests at recorded upstream commit into
   `updater/`. Integrate root test discovery and verification. Inspect bootstrap,
   transaction, retention and installer paths before changing packaging.
2. Add a private durable update-control store with revision-checked default-off
   automatic policy, exact-commit manual requests, cancellation, deduplication and
   transaction-start serialization. Add trusted exact-workflow CI eligibility and
   bounded periodic discovery independent of installation.
3. Integrate updater transaction authorization, shared application maintenance
   fencing, idle/uncertain worker checks, monitoring launch/queue protection,
   data backup/compatibility and exact-version health/recovery.
4. Consolidate installation and bootstrap under a single source repository;
   retain recovery-capable separate process and explicit guarded legacy migration.
   Update wrappers, retention integration and configuration documentation.
5. Add paired same-origin update APIs and in-app notification/settings controls:
   check, changes, Later, exact-commit confirmation, queue/cancel, default-off
   automatic-installation toggle and transaction status/reconnect.
6. Exercise disposable packaging, CI eligibility, approval races, restart,
   quarantine, migration, recovery, API security and Cypress journeys. Run
   `npm run verify`, both coverage commands and local Cypress; investigate failures
   and preserve coverage requirements. Do not run installed/live operator commands.
7. Review the final diff; record detailed passed/failed/unverified evidence and
   remaining live acceptance paths in a delivery report and PR targeting main.
   Do not merge or release.

Tests use temporary directories/repositories and fake launchd, GitHub, native
processes and health adapters. Existing user changes and the sibling source
repository remain untouched. Any contract correction is committed to the spec
before this plan or implementation changes.
