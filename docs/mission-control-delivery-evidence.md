# Mission Control delivery evidence

Status: implementation in progress; this report does not claim full delivery.
Contract: [redesign spec](superpowers/specs/2026-09-15-mission-control-redesign.md).
Plan: [implementation sequence](superpowers/plans/2026-09-15-mission-control-redesign.md).

## Implemented so far

- Mission Control fleet with search, filters, summary counts and Needs You.
- Four primary navigation destinations, full-page goal details, keyboard-operated
  sections and responsive styling based on the supplied prototype.
- Removed the obsolete goal modal and goal Kanban component.
- Service-owned merge observation, persisted through the orchestration journal,
  with 15-minute cadence for delivered PRs only. Direct GitHub PR lookup validates
  saved identity; closed-unmerged and unavailable results cannot complete a goal.
- Exact-head human PR publication approval creates the external intent only after
  approval; pending proposals can be revised, invalidating the old approval.
- Production scheduler owns polling; pending remote reads do not block admission
  or other goals. Shutdown prevents late observation writes after release.

## Verification so far

- `node --test tests/orchestration-merge-sync.test.mjs`: 4 passed, covering durable
  restart cadence, concurrent/failed observations, closed PRs, shutdown and direct
  GitHub identity validation with fake external requests.
- `node --test tests/orchestration-publication.test.mjs tests/orchestration-scheduler.test.mjs`:
  96 passed after merge coordinator integration.
- Bounded orchestration/navigation/fleet UI suites: 21 passed.
- `npm run typecheck`: passed after the new Cypress fixture typing was corrected.
- Scoped ESLint on changed UI/core and new tests: passed.
- `CMUX_COMPANION_CYPRESS_PORT=3247 npm run test:e2e:local -- --spec cypress/e2e/mission-control.cy.ts`:
  3 passed, including desktop 1440px, phone 390px, selected-goal reload, return,
  filtering and Needs You. APIs are stubbed: this proves navigation, not real
  provider execution. Screenshots are retained under ignored `cypress/screenshots`.
- Full UI suite initially reported 161 passes and two obsolete navigation-label
  failures. After correcting the approved navigation expectations, both affected
  suites passed all 42 tests in their bounded rerun.

- Publication gate: domain/role/scheduler checks passed (100 before two additional
  scheduler cases; final scheduler rerun 70/70); real Git delivery 5/5 passed.
- `npm run typecheck`, full `npm run lint`, and bounded orchestration UI 16/16 passed.
- `goal-workspace.cy.ts`: 1/1 passed on desktop and phone.
- Real-service `orchestration-core.cy.ts`: 2/2 applicable journeys passed on port
  3248 after correcting goal selection; the read-only-only case is excluded in
  this writable fixture and remains separately unverified.
- Updater routes 9/9 passed, including approval/waiting-merge idle state versus
  pending/active publication and uncertain worker update fences.

## Interventions

- Real-service Cypress initially passed publication but failed abort because the
  test selected the last fleet row (the prior goal). Select the requested goal by
  title; both journeys passed on rerun. No product exception was suppressed.
- Port 3221 was already occupied. Used 3247; did not stop the existing owner.
- Cypress exposed a hydration mismatch on selected-goal reload. Replaced the
  browser-only initial selection with hydration-safe external URL state; rerun
  passed without suppressing browser exceptions.
- Screenshot inspection exposed inherited sidebar grid/body-spacing rules.
  Corrected them and added a desktop link-position regression assertion.
- A navigation-test rerun consumed sustained CPU while reporting an obsolete DOM
  assertion. Stopped only that owned test process after inspection; corrected the
  remaining Sessions expectation before rerunning.

## Remaining contract work

| Requirement | Current status |
| --- | --- |
| Fleet stages, active wave and last activity | Fleet implemented; wave/activity projection still needed. |
| Setup redesign and account usage | Existing implementation retained; redesign incomplete. |
| Brief/files/images and authorized agent context | Not implemented. |
| Combined planner/design with approved suggested team | Existing planner retained; role/routing contract changes pending. |
| Explicit wave barriers with verification | Not implemented; current scheduler still uses task dependencies. |
| All judgment agents visible in cmux | Not implemented; non-planner adapters still use background mode. |
| Goal-scoped holds and manual recovery | Not implemented; existing automatic repair remains to be replaced. |
| Assignment proposals, reasons and snapshots | Not implemented. |
| Human publication approval | Implemented; exact-head authority/restart/receipt tests and real-service Cypress passed. |
| Passive merge sync | Implemented and bounded tests passed; broader acceptance integration remains. |
| Standalone sessions and retired feature cleanup | Sessions navigation retained; Inbox/queue/preview/notification removal pending. |
| Updater regression and redesigned controls | Approval/waiting-merge idle regression passed; redesigned controls and final regression pending. |
| Complete restart behavior | Existing core and new merge sync tested; new attachments/holds/teams pending. |

Full `npm run verify`, final backend/UI coverage, real-service redesigned Cypress
journeys, completion audit and PR review remain outstanding. Native cmux/provider
and installed updater validation have not run and require separate live authority.
No merge, deployment, installed data reset or external account change performed.
