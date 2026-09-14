# Automatic Dev repo tracking delivery plan

Spec: ../specs/2026-09-13-settings-dev-repositories-design.md
Human review: user approved spec commit 6ccf292 with “do it” on 2026-09-14.
Owner: implementing agent; no delegation.

1. Introduce bounded, coalesced server reconciliation using existing settings revisions and validation. Persist eligible discoveries without changing existing preferences. Skip linked worktrees and isolate failed roots.
2. Reconcile when adding/refreshing Dev repos and opening Settings/Goals. Preserve dirty drafts and display partial/failure feedback. Remove discovery selection controls.
3. Keep disabled/unconfigured repositories visible in Goals while preserving execution gates and existing goal snapshots.
4. Extend backend security/concurrency tests, UI draft/automatic-discovery tests and real-service Cypress journey. Run verify, coverage and local Cypress; inspect responsive screenshots.
5. Update onboarding documentation and publish PR evidence. No merge/install or unrelated updater changes. Operational cleanup remains separate; four in-use worktrees remain untouched.
