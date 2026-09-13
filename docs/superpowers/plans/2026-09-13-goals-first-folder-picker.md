# Goals-first navigation and folder picker delivery plan

Implements the user-reviewed amendment at spec commit 2645a3a in
`../specs/2026-09-13-settings-dev-repositories-design.md`; user approved “go”.
One implementing agent owns all changes and cleanup.

1. Make untargeted home/PWA navigation render Goals and preserve explicit legacy
   destinations. Use Goals, Inbox, Settings navigation and optional Sessions
   access within Goals, with clear return and setup paths.
2. Add a bounded, authenticated directory-only browser within canonical home
   and saved roots, enforcing exclusions, containment and fresh path validation.
   No storage migration, background scanner or external service changes.
3. Build an accessible folder dialog with breadcrumbs, Up, explicit selection,
   cancellation, errors and stale-response protection. Integrate both Dev repo
   and individual-repository editors. Prefill unique names, retain advanced paths,
   and preserve drafts and explicit repository admission.
4. Add backend boundary, UI interaction and Cypress no-typing/navigation coverage.
   Run verify, backend/UI coverage and local Cypress; inspect responsive states.
5. Review changes on PR #120, recording passed/failed/unverified evidence and any
   interventions. No merge or installed-service changes in this implementation.
