# Companion update readiness

Owner: Codex. Branch: `fix/update-admission-diagnostics`; target: `main`.

## Outcome and contract

Implements the existing approved updater contract in
`docs/superpowers/specs/2026-09-13-manual-self-update-design.md`, especially journey
steps 6–7: preserve cmux sessions and explain the actual blocking effect. No new
force/termination behavior or handoff policy is introduced.

The existing Update now action restarts Companion only after its maintenance
checks. Standalone cmux sessions do not participate in admission, and supported
interactive planners retain the existing verified handoff. Settings now describes
this accurately and calls deferred installation “Update when ready”.

## Findings and changes

The updater previously discarded every negative maintenance response's reason,
including unsupported planner handoff and uncertain-state errors, replacing it
with “Waiting for Companion-managed work to finish”. A transport failure also
left the previous waiting message untouched indefinitely. Both paths now report
their actual admission outcome without exposing raw transport errors.

A read-only, paired update-status request now reports the current categories of
blocking effects: repository fetch, verification, publication, unsettled operation,
agent handoff, pending result, or in-flight mutation. Reading readiness neither
fences admission nor transfers workers. A planner listed before installation may
qualify for handoff when the transaction verifies its receipts; the UI says so.
Messages contain no terminal contents, credentials, repository paths or prompts.
No storage migration is needed; existing durable request errors carry the detail.

The installed Mac's records showed no active attempts or unfinished operations.
That does **not** prove the live service is idle: in-memory jobs and requests also
participate. The exact cause of that installation's waiting state remains
unverified. This PR fixes lost diagnostics; it does not claim that the installed
service has updated or that a speculative idle bypass is safe.

## Verification

Passed:

- `node --test tests/updater-routes.test.mjs tests/updater-transaction.test.mjs`.
- `npm run verify`: backend 862 tests, 861 passed, one platform skip; UI 163
  passed; lint, TypeScript and production build passed. Backend/UI line coverage:
  97.27% / 95.12%.
- Chrome `npm run test:e2e:local -- --settings --spec cypress/e2e/updates.cy.ts`:
  one journey passed, covering confirmation, detailed waiting reason, cancellation,
  automatic-policy persistence and installation after readiness. Disposable service
  and simulated update adapter only. Mobile screenshot inspected; no overflow.
- `git diff --check`.

Interventions and limitations:

- First Cypress invocation refused occupied port 3221. Re-ran on free port 3237;
  the existing owner was untouched. The second run and owned fixture cleanup passed.
- Backend skip: macOS rejects invalid UTF-8 filenames before Git can observe them.
- Build emitted vinext's existing informational route-classification warning.
- Logs: `/tmp/cmux-update-targeted.log`, `/tmp/cmux-update-verify.log`,
  `/tmp/cmux-update-cypress.log`; ignored screenshots under
  `cypress/screenshots/updates.cy.ts/`.

## Boundaries and remaining gaps

- UI, paired API, maintenance admission and background updater are covered.
- Existing CI, exact-commit authorization, fence, backup, health and rollback rules
  remain enforced. No cmux stop operation is added.
- Live installation, restart, native handoff and installed waiting-state recovery
  were not performed. Delivery requires merge and installation of this change;
  an existing blocked installation may need separately authorized recovery.
- The two unrelated untracked user documents were preserved.
