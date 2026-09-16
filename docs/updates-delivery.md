# Bundled update delivery

Implements the [approved specification](superpowers/specs/2026-09-13-manual-self-update-design.md)
and [implementation plan](superpowers/plans/2026-09-13-manual-self-update.md).
The user approved the revised default-off automatic-installation contract after
392144c. The spec approval was recorded before the plan commit.

## Result and ownership

Companion contains its updater in `updater/`, preserving the upstream MIT notice
and recording imported source c9557aa0859f60b21c42edf04d9dc4dcf7f20190. One root npm
manifest, lockfile and supported Node version govern both components. The sibling
repository was read only and remains untouched.

A paired phone can see an update notice and changes, dismiss a candidate, check
for updates, confirm one exact commit, queue until idle, cancel a queued request,
and explicitly opt into automatic installation. The installation-wide toggle is
false by default and stays separate from discovery. Legacy `enabled: true` never
becomes automatic installation permission. Manual and automatic requests share
CI validation, durable authorization, admission fencing and transactional recovery.

The implementing agent owns all touched layers and cleanup. No implementation work
was delegated. Installed services, user credentials, Tailscale, live agent sessions,
and the untracked burst-scan plan were not changed.

## Acceptance evidence

| Contract boundary | Implementation and verification |
| --- | --- |
| One repository / one source commit | Bundled installer, root wrappers, preserved license and one configured target; `updater-recovery.test.mjs` stages a disposable committed checkout without a sibling source. |
| Default-off installation | Durable SQLite control state separates discovery from authorization. Control/transaction tests prove zero activation from discovery and one activation after explicit automatic opt-in. |
| Exact trusted successful main | GitHub workflow identity, repository, branch, event, commit and latest run/attempt are checked. Eligibility tests reject wrong identities, failed/pending/missing evidence, divergence and inaccessible API responses. |
| Notifications and controls | `ui-updates.test.tsx` covers read-only controls, default-off opt-in, confirmation, exact SHA, check, cancel, retry, Later, persistence and errors. Real-service Cypress exercises the mobile journey and records exactly one fake activation. |
| Durable approval and cancellation | `updater-control.test.mjs` covers restart persistence, revision conflicts, request replay, automatic disable/start races, suppression and quarantine. API responses omit backup paths and internal service identity. |
| Safely idle activation | Service middleware fences mutations; scheduler and prompt draining consult the durable fence. Maintenance tests race an in-flight launch, reject active/unknown work and unavailable cmux evidence, and reject a changed service identity. |
| Build ownership | Native-adapter tests execute isolated npm builds under the existing independent watchdog and reuse durable receipts. Unknown process ownership retains maintenance; explicit recovery requires every receipt to prove stopped. |
| Startup / rollback | Transaction tests inject failed health, interrupted switching, incomplete recovery and accepted-transaction restart. Native-adapter tests stage exact Git content, preserve a dirty source checkout, back up SQLite, switch versions, stop/restore and verify SHA/assets with fake launchd and health endpoints. |
| Stable bootstrap | Bootstrap tests select the previous engine after an interrupted current-link switch, reject altered engine digests and legacy transactions, retain locks for unknown claims/live orphan engines, and reclaim a stale spawn claim whose owner died before recording its engine pid. |
| Legacy migration | A disposable legacy configuration and plist rehearsal proves explicit migration, disabled automatic policy, unchanged token and retained old release evidence. Installer failure restores backed-up configuration/data after proving stopped ownership. |
| API security / lifecycle | Pairing, origin, strict schemas and private operator handshake are tested. Production-entry-point tests compose real update routes and recover from a failed update-store setup without retaining resources. |
| Documentation | `docs/updates.md` separates fresh installation, explicit cmux/Tailscale setup, legacy migration, phone/CLI operations and recovery. README and the agent guide now describe settings-backed startup accurately. |

## Passed checks

- `npm run verify`: backend, UI, lint, both TypeScript projects and production build.
  Recorded full run: 753 backend passes, one platform skip; 124 UI tests across
  13 files. Later bootstrap/startup/migration corrections also passed their scoped
  suites and lint/type checks. The PR workflow validates the final committed tree.
- `npm run test:coverage`: expanded to include `updater/src/**` in addition to the
  existing backend. Recorded line coverage: **97.38%** (above the 90% requirement).
- `npm run test:ui:coverage`: **95.25% line coverage** (above 90%).
- `CMUX_COMPANION_CYPRESS_PORT=3323 npm run test:e2e:local`: **78 passed**, five
  separate-mode cases pending; no failures.
- `CMUX_COMPANION_CYPRESS_PORT=3322 npm run test:e2e:local -- --settings --spec cypress/e2e/updates.cy.ts`:
  **one passed** against a real disposable service with fake update effects.
- Targeted control, native adapter, bootstrap, migration, data recovery,
  transaction, API and production-startup suites passed.
- Shell entry-point syntax and `git diff --check` passed.
- Mobile screenshot visually reviewed after correcting toggle dimensions.

Local logs and the retained mobile screenshot are under ignored
`outputs/update-verification/`. Backend coverage is in `coverage/backend.lcov`.
These local paths are evidence artifacts, not application runtime dependencies.

## Interventions and failed attempts

- Initial Cypress attempt refused occupied port 3221. Used free ports 3322/3323;
  no existing owner was stopped.
- Initial update API tests used a fixture Origin that did not match Fastify's
  default Host, correctly receiving 403. Fixed the fixture Host; security behavior
  was retained and the suite passed.
- Imported lint findings (unused imports, empty catch blocks and an unnecessary
  regex escape) and new hook warnings were corrected; lint passes without warnings.
- Visual review found inherited checkbox styling compressed the toggles. Corrected
  their dimensions and re-ran the mobile journey before reviewing the final image.
- Review tightened bootstrap lock ownership, restart request identity, installer
  failure cleanup, preservation of transport/PATH, and uncertain build recovery;
  added focused regression evidence rather than bypassing these checks.

The backend's non-UTF-8 filename test is skipped on macOS because that filesystem
rejects the invalid name before Git can observe it. The ordinary browser run's
pending tests belong to separate settings/orchestration modes; the new update
journey was run explicitly. No failed assertion remains unresolved.

## Operational limits and unverified paths

No installed migration, self-update, rollback, live GitHub eligibility, native
cmux continuity or Tailscale operation was run. Local launchd and activation
rehearsals use fake effects; they do not prove those live boundaries. Installation
and release remain separately authorized operator decisions.

Before an installed rollout, unload the identified legacy updater and follow the
migration runbook. A still-enabled old unattended updater can retain its old
behavior when main advances; changing source does not change that external owner.

Initial self-update supports unchanged settings/schema migration source only.
Schema-changing releases are refused and require a separately verified migration
contract. GitHub discovery uses authenticated `gh`, trusted github.com origin/main,
and a bounded 100-commit window. Missing or inaccessible evidence is a refusal,
not permission to install. Recovery that cannot prove stopped processes or intact
backups retains maintenance and requires operator reconciliation.

This delivery does not make the repository public, scan its entire Git history,
merge the PR, install the new code or change any external account configuration.
