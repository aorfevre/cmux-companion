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
- Claude/CCS and Codex production adapters now host implementer, reviewer and
  repair supervisors in visible cmux workspaces. Their existing noninteractive
  permission policy, time/output limits, process groups and private result receipts
  remain enforced. Terminal output is bounded and closing it requests termination.
- Goal workspace controls open each current owned execution terminal, including
  a worker that submitted its result but has not yet stopped.
- Durable goal failure holds stop new agent, integration, verification and
  publication dispatch. Active siblings/checks settle without releasing the hold;
  unrelated goals remain eligible. Queued identities survive provisioning races.
- Explicit recovery preserves failed evidence, reconciles unknown workers before
  replacement and authorizes a bounded repair pass (or a stopped-check retry).
  Blocking plan findings require a revision and renewed approval.
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

- Full backend run: 850 passed, 1 failed, 1 intentionally skipped. The failure
  was the disposable HTTP demo test still expecting automatic publication; its
  HTTP approval and pre-approval no-PR assertions were updated and both demo
  tests passed on the bounded rerun.
- Full UI suite: 163/163 passed after publication approval integration.

- Failure-hold domain/role/scheduler/restart bounded suite: 107/107 passed.
- Updated planning/result/crash-recovery and real service-worker browser checks:
  38/38 passed. Existing SIGKILL coverage was retained.
- Full UI suite including held-goal recovery controls: 164/164 passed.
- Chrome real-service `orchestration-core.cy.ts`: both writable journeys passed,
  now with explicit recovery after blocking task review and failed final checks.
  The read-only case remains separately unverified.
- Typecheck and lint passed; production build passed independently.
- UI line coverage: 96.06% (required minimum 90%).
- Full `npm run verify` stopped in backend tests: 856 passed, one failed, one
  intentionally skipped. The only remaining failure was the offline service-worker
  browser test's second navigation timing out. It also failed without concurrent
  Cypress, so concurrent Cypress alone does not explain it. Instrumented diagnostics and a focused concurrent
  Git-delivery/browser run passed all six cases. Limiting backend file concurrency
  to four then allowed the complete verification run below to pass.
- Final graph admission and uncertain integration-repair refinements passed their
  bounded domain/scheduler rerun.

- Latest complete `npm run verify`: **passed**, with 857 backend tests passed,
  one intentional skip, 164 UI tests passed, lint/typecheck/build passed.
  Backend file concurrency is now four in both ordinary and coverage commands;
  no tests or assertions were removed to obtain this result.

- Visible-role adapter/API/runtime/Codex suites: 56 passed; expanded API/runtime
  rerun passed after covering submitted-but-running workers.
- Visible-role full UI suite: 165 passed. Typecheck and lint passed.
- Chrome Mission Control Cypress: 4/4 passed, including responsive terminal control
  with an exact owned-attempt request. Real native cmux/provider integration remains
  unverified; the adapter tests use a fake cmux boundary and real local supervisors.
- Full backend coverage run passed: 97.36% line coverage (minimum 90%); no
  failures. Latest visible-role full UI run passed all 165 tests.

## Interventions

- The first broader failure-hold run reported 846 passes, 10 failures and one
  intentional skip. Nine failures were old automatic-repair/retry fixtures or
  expected error codes; updated them to exercise explicit recovery. The tenth
  was a service-worker browser navigation timeout while Cypress was also running.
  All affected checks passed in a bounded rerun without concurrent Cypress.
- Electron Cypress failed to connect to its browser before any journey ran.
  Switched to Chrome as prescribed by AGENTS.md; both journeys passed.
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
| Brief/files/images and authorized agent context | Implemented with private durable references, scoped agent reads and real-service Cypress. Full verification passed. |
| Combined planner/design with approved suggested team | Existing planner retained; role/routing contract changes pending. |
| Explicit wave barriers with verification | Not implemented; current scheduler still uses task dependencies. |
| All judgment agents visible in cmux | Production adapters launch all judgment roles through cmux; bounded noninteractive policy is retained internally. Adapter/UI/API checks passed; native live validation unverified. |
| Goal-scoped holds and manual recovery | Implemented with persistence, sibling/provisioning-race tests and real-service manual-recovery Cypress; final full verification passed for this slice. |
| Assignment proposals, reasons and snapshots | Not implemented. |
| Human publication approval | Implemented; exact-head authority/restart/receipt tests and real-service Cypress passed. |
| Passive merge sync | Implemented and bounded tests passed; broader acceptance integration remains. |
| Standalone sessions and retired feature cleanup | Sessions navigation retained; Inbox/queue/preview/notification removal pending. |
| Updater regression and redesigned controls | Approval/waiting-merge idle regression passed; redesigned controls and final regression pending. |
| Complete restart behavior | Existing core, merge sync and holds tested; attachments/teams pending. |

Final backend coverage, remaining redesigned Cypress
journeys, completion audit and PR review remain outstanding. Native cmux/provider
and installed updater validation have not run and require separate live authority.
No merge, deployment, installed data reset or external account change performed.

## Goal inputs delivery

- Added an optional explicit title, separate full brief/links and up to eight
  durable UTF-8 source/text or PNG/JPEG/WebP references (1 MiB each).
- Private content-addressed bytes precede journal metadata; paired downloads and
  goal-scoped agent reads enforce repository and credential boundaries. HTML/SVG
  remain plain-text attachments. Reviewers gain only reference/status MCP tools.
- UI preserves file/title/brief drafts and exact uncertain command retries.
- Reference lifecycle/security suites: four passed, including journal and blob
  reopen, tamper detection, rejected files, revoked credentials and bounded reads.
- Bounded native/API/presentation/MCP run: 48 passed, one obsolete empty-reviewer
  tool-list expectation failed. Updated it to assert the two read-only tools;
  the complete ten-test MCP suite then passed. No mutation-denial assertion removed.
- UI orchestration suite: 20 passed. Typecheck and lint passed after adding scoped
  explanations for intentional control-byte rejection regexes.
- Chrome real-service orchestration Cypress: two writable journeys passed with
  image/source uploads, authenticated safe download, recovery and publication.
  The first invocation omitted `--orchestration` and ran zero journeys (three
  pending); corrected invocation ran the real disposable service. Read-only-only
  journey remains separately unverified. Full verification passed: 865 backend
  tests passed, one intentional skip, 167 UI tests passed, lint/types/build passed.
  The additional journal-restart reference test separately passed after that run
  began.

## Setup-backed merge synchronization correction

The saved-settings publisher wrapper omitted `observeMerge`, silently disabling
merge polling in the primary onboarding composition. It now delegates reads to
the goal's saved publication adapter. A runtime regression changes workspace
settings after goal creation, confirms the original GitHub destination is read,
marks the waiting card merged, and proves already-merged cards are not queried.
All 15 saved-settings/merge-sync tests passed. No GitHub writes or live calls ran.
