# Mission Control delivery evidence

Status: redesign implemented and verified; real Codex evaluation published a reviewed test PR and is waiting for external GitHub merge.
The final results below supersede intermediate counts and pending notes in the chronological delivery record.
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

## Acceptance map

| Requirement | Evidence |
| --- | --- |
| Fleet, stage/wave/workers, decisions and responsive actions | Mission Control Cypress, UI stage/ownership tests and inspected phone/desktop screenshots. |
| Setup projects/profiles/readiness/usage | Five Setup fixture journeys; two real-service onboarding journeys; eight account-usage/reconnect journeys. |
| Brief, links, files/images and scoped agent reads | `orchestration-goal-references` lifecycle/security tests and real-service input journey. |
| Combined planner/design/team gate | Team/domain/native tests and real-service planning/approval Cypress; real Codex goal independently reviewed and approved. |
| Parallel waves and verified integration barriers | `orchestration-waves` launch-order/restart tests and real-Git Cypress. Real native evaluation uses one wave. |
| Visible judgment agents; background deterministic effects | cmux/native adapter tests; real Codex planner, implementer and reviewers ran visibly; service verification passed. Claude live execution is unverified. |
| Durable goal holds and manual recovery | Multi-goal/recovery/provisioning-race tests, real-service Cypress and real native restart/held/recover path. |
| Capacity reasons, overrides and immutable attempts | `orchestration-teams`, runtime routing/restart tests and team Cypress. |
| Exact-head review/checks and publication approval | Publication authority/receipt/restart tests and real-service Cypress; native evaluation published the exact reviewed head and observed the PR still open. |
| Passive waiting-only GitHub merge sync | Fake-clock/restart/identity/error tests; no Companion merge action. Native merged observation awaits an external merge. |
| Sessions retained, obsolete product surfaces retired | Retained Sessions/ownership/pairing/launch Cypress; authenticated retired-route 404 tests and composition cleanup. |
| Updater controls, busy safety and recovery | Updater suites, isolated real-service browser journey and archived settings reader with saved team round-trip/backup restore. Installed update activation not run. |
| Restart and identity preservation | Core/SIGKILL, holds, references, routing, merge cadence and live stopped-planner recovery evidence. |

Final baseline: full verification passed (838 backend, one intentional skip; 155 UI;
lint, frontend/backend types and build). Backend/UI line coverage exceeds 90%; the
final coverage is 97.19% backend lines and 95.09% UI lines. No product merge,
deployment or installed-state reset has occurred. The representative repository is
now user-selected (`cmux-e2e-cypress`); a success target remains unspecified.

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

## Explicit waves delivery

- New planner/design contracts use schema version 2 with ordered waves, task
  membership, shared resource ownership and per-wave checks. Validation rejects
  overlapping paths/resources within a wave, missing tasks/checks and dependencies
  in the same or later waves. The final barrier runs all approved checks.
- The scheduler and domain both enforce the barrier. Verification receipts pin
  wave identity and check sets as well as the integrated commit. Same-head waves
  cannot reuse each other's receipts. Checked output survives later integration,
  restart and manual recovery; a revised plan cannot reuse earlier approval.
- Intermediate verification failures use the existing durable goal hold and
  bounded integrated repair path. Exact-target review and Git integration remain
  required. Existing version 1 journals retain their already-approved semantics;
  new goal creation enforces version 2, and the native MCP tool rejects an older
  plan before durable intake so the agent can correct it without a human gate.
- Replaced task Kanban and retired its CSS. Goal workspaces show ordered wave
  cards, active/waiting barriers and checked commits; fleet rows show current wave.
- Domain/scheduler/MCP bounded suite: 113 passed. Expanded wave restart suite: five
  passed. Full UI: 167 passed before adding one dedicated wave-view test.
- Chrome real-service Cypress: two writable journeys passed with wave barriers,
  attachments, explicit recovery and publication. Phone rendering inspected;
  desktop capture width corrected to fit Chrome's screenshot surface.
- The real-Git backend delivery reached the expected result, but its new event
  ordering assertion requested an unsupported 1000-event page. Corrected to the
  supported 500-event bound; the full verification run includes that rerun.
- Typecheck and lint passed. Full verification and the final visual capture are
  in progress; this slice does not complete the redesign.

- Initial full wave verification: 871 backend passed, one failed, one intentional
  skip. The failure was an obsolete exact MCP schema-field list; updated it to
  require waves, schema version 2 and task resources. All seven result/MCP tests
  passed afterward. The new-goal boundary/settings/API suite passed all 26 tests.
- Final Chrome real-service rerun: two writable journeys passed; both actual
  implementers are asserted running before capturing phone (390px) and desktop
  (1200px) wave views. Both captures were inspected; no clipping or page overflow.
  Read-only-only browser coverage remains separately unverified.
- Dedicated wave UI suite now passes 21 tests. Full verification rerun passed: 873 backend tests passed, one intentional skip,
  168 UI tests passed, lint/typecheck/build passed.

The final wave slice is committed only after the corrected full verification
passed. Native cmux/provider and installed updater live validation remain
unverified; the full routine suite includes their deterministic regressions.
Remaining work is team allocation/approval, Setup and Sessions, activity/evidence
polish, retired-feature cleanup, coverage audit and the final PR.

## Team allocation and saved launch profiles

- Setup configures named supported Claude/Codex/CCS commands, eligible roles and
  role defaults. Disabling a profile or removing its role clears affected defaults.
  Commands use the existing restricted argv validation, never shell passthrough.
- Goal creation freezes commands, resolutions, models, readiness and dated CCS
  provider-pool signals. Missing, failed, stale and timed-out quota readings remain
  unknown. Suggestions consider eligibility, available capacity and role preference;
  they do not claim account-level selection or dollar balances.
- The existing plan gate approves the proposed team and design together. Manual
  role choices carry into task assignments; revisions retain prior team evidence.
  Overrides apply only to future attempts, cannot replace an owned worker and
  never release a failure hold. Each attempt pins its actual profile/model.
- Saved-settings runtime routes launch, observe, resume, open, terminate and
  updater handoff by the saved attempt profile. The restart regression launches
  siblings through different providers and proves later workspace edits do not
  change the original factories/models. Legacy fixed composition supplies an
  explicit unknown-capacity profile and rejects changed model/profile launches.
- API forbids forged allocation configuration, unpaired/cross-origin edits,
  agent overrides and read-only overrides. The new API security suite passed all
  ten tests; bounded domain/settings/runtime suites passed 21 tests. Compact team
  UI initially passed three tests; final full verification includes the additional
  default-reset assertions.
- Real-service Chrome Cypress passed both writable journeys, including a manual
  task override before combined approval and the recorded attempt assignment.
  Read-only-only browser journey remains pending in this writable fixture.
- Desktop team capture inspected successfully; phone capture revealed shrinking
  goal tabs whose labels overlapped. The layout correction and final checks are
  recorded below. Native providers/cmux and installed updater remain unverified.

- Final full verification passed: 881 backend tests, one intentional skip, 171 UI
  tests, lint, types and production build. The subsequent CSS-only correction
  prevents tab shrinking on narrow screens; a browser regression asserts separate
  tab rectangles and labels fitting their buttons. Both writable Chrome journeys
  passed again and the corrected phone capture was inspected. Typecheck passed
  after the browser assertion. Final coverage and remaining redesign work remain.

## Unified Setup delivery

- Extracted the shared Mission Control shell for goal and Setup destinations.
  Desktop uses the same sidebar; narrow screens keep primary and Setup navigation
  visible. Overview links to projects, profiles, CCS capacity and the updater.
- Projects/favorites and validated named launch profiles retain saved revision
  checks, conflict review, onboarding and unsaved-draft protection. Device terminal
  input protection and install prompts remain available. Removed notification and
  local-preview settings links/fields; their underlying retirement remains separate.
- Account usage now lives within Setup and displays source/freshness. Stale,
  failed and unavailable readings cannot expose cached percentages as current.
  Refresh updates the view clock so newly returned readings are immediately valid.
- Updater control behavior remains unchanged, with clearer installed/candidate,
  confirmation and request panels. Exact-commit confirmation, protected changes,
  idle admission, automatic preferences, cancellation and recovery remain owned by
  the updater service; no installed updater or native integration was exercised.
- First bounded UI run had one obsolete category name (41 passed, one failed);
  updated the navigation assertion. The freshness test exposed a clock snapshot
  lag after refresh and now covers the correction. Final bounded UI: 36 passed.
- First Setup Cypress run had four passed and one failed because an old mobile
  CSS rule hid category navigation. Corrected specificity; all five browser checks
  passed. Both real-service onboarding/project/favorite journeys passed after
  updating obsolete Kanban/navigation selectors. Phone capacity and desktop Setup
  screenshots inspected. Retired push/preview settings browser tests were replaced
  with current Setup checks; retained device protection and installation tests stay.

- Disposable updater Cypress passed (one journey), including no activation before
  confirmation, busy-work waiting, cancellation, automatic opt-in/out, one eligible
  activation and restart persistence. Desktop and phone updater captures inspected.
- Shared-shell orchestration Cypress passed both writable journeys; read-only-only
  journey pending in this fixture. Typecheck passed; full verification is running.

### Remaining retirement boundary trace

The Sessions rewrite must remove Inbox/context actions, queued prompt controls and
preview discovery from `app/page.tsx`, while retaining deliberate text/image/key
input, replay, terminal selection, repository changes and session ownership checks.
`server/index.mjs` currently constructs PushService, PreviewManager and PromptQueue;
`server/app.mjs` still registers their routes and attaches their background jobs.
These owners and their exclusive modules/tests/storage consumers must be removed.
`update-maintenance.mjs` has an explicit prompt-drain fence that becomes obsolete
only when the queue owner is removed; worker, verification, publication, mutation
and handoff fencing remain required. Release-retention preview routes are updater
functionality and must not be removed with local-app previews. CCS reconnect,
reference/image storage and pairing are retained shared boundaries.

Final Setup verification passed: 881 backend tests, one intentional skip, 172 UI
tests, lint, typecheck and build. The full routine suite includes deterministic
updater regressions; installed/native live paths remain unverified. Remaining
redesign work is Sessions and legacy feature retirement, fleet last activity and
run-evidence polish, final coverage/audit and the PR targeting main.


## Standalone Sessions and retired product owners

Sessions now shares the Mission Control shell, searchable cards and a responsive
terminal detail with visible terminal selection, health/changes navigation and
explicit input protection. Retained text/image/key input, shortcuts, Markdown,
terminal follow/fit controls and stale-response ownership checks.

Removed Inbox, prompt queues, local-app preview capture/management, push
notifications, their authenticated routes and startup/job owners, exclusive tests,
service-worker push handlers, CSS and web-push dependency. Retired route requests
return 404; no removed cmux feed RPC is used by session control. Local URLs in
terminal output are inert while safe Markdown remains inspectable. Old navigation
links redirect to Mission Control or the corresponding Setup section.

Settings APIs and Setup no longer expose preview ports or Chrome capture paths.
The two obsolete fields remain inert in schema-2 disk JSON solely for updater
rollback compatibility. Current reads strip them; writes preserve their original
values. Historical goal snapshots, projects, favorites and imported/revision
metadata survive restart. The archived previous reader still reads and writes
upgraded data, and backup restoration returns the exact pre-update data. An
initial schema-3 deletion was discarded after the compatibility audit, before
commit; no installed data was used or changed.

Updater queue draining no longer references retired prompt queues. Owned workers,
verification, publication, mutation fencing and handoff still block unsafe updates.
Pairing, same-origin validation, loopback binding and repository restrictions remain.

Verification interventions: repaired low-contrast inherited Sessions text and a
phone minimum-height that hid its composer; removed an obsolete CSS assertion;
updated retired navigation fixtures and restored a reconnect fixture's required
fresh timestamp. Cypress explicitly checks composer bounds and narrow overflow.
Final check results are recorded below after the completion run.

Retirement checks: `npm run verify` passed (833 backend passed, one intentional
skip; 149 UI; lint, frontend/backend types and build). Retained Sessions/ownership,
responsive interface matrix, pairing, launch, goal navigation, deployment health
and Setup browser journeys passed. Account usage passed all eight journeys after
correcting the fixture timestamp; both real-service onboarding journeys passed.
The updater browser journey passed separately. Its initial combined run correctly
stayed busy because onboarding had created live fixture work; isolation removed
the cross-suite state without weakening the updater fence. Installed/native live
paths remain unrun. Final redesign coverage is still pending.


## Activity, ownership and run evidence

Fleet rows show the most recent retained meaningful journal event; routine merge
poll observations do not replace it. Activity pages list newest-first goal-scoped
metadata with older/newer navigation and explicit retention limits. Private event
payloads are not exposed. Wave task inspection now includes ownership, shared
resources, acceptance IDs and candidate/integrated commits. Verification stages
follow actual pending checks and held failures instead of guessing from task counts.

Run reports include current/historical verification status and exact-head check
output on deliberate inspection, plus background integration status/results.
Evidence access requires pairing, an allowed goal repository and an artifact
referenced by that goal's checks; the artifact hash and check/head binding are
verified. Only bounded stdout/stderr and check metadata are returned, excluding
execution environments and agent envelopes. React escapes output; scripts remain
text. Goal details now start directly below navigation without a redundant fleet
heading or creation control.

Checks: 31 API/storage tests passed, including pagination, retention, restart,
private-payload exclusion, cross-goal denial, exact-head mismatch and output bounds.
Full verify passed with 836 backend tests (one intentional skip), 155 UI, lint,
types and build. Backend line coverage 97.18%; UI line coverage 95.09%. All 11
Mission Control/workspace/provider/model Cypress journeys passed; final responsive
Activity/output screenshots were inspected at 390 and 1440 pixels. Writable
real-service orchestration passed both applicable journeys; read-only mode passed
its dedicated journey. Opposite-mode cases are intentionally skipped in each run.

The user subsequently authorized real goals in the test-only cmux-e2e-cypress
repository. Evaluation uses an isolated clone and private temporary service state;
installed state and the original checkout are unchanged. The first real startup
exposed missing GitHub authentication in the isolated HTTPS transport. A fixed,
GitHub-only gh credential helper and explicit startup retry allowed the same saved
goal to reach a visible Codex planner. Native evaluation remains in progress.


## Native evaluation findings and fixes

- The existing schema-2 reader rejects new top-level settings keys. Moved named
  profiles/team defaults into an additive private table, keeping old JSON readable.
  The archived-reader test now saves a real team, reopens/writes with the old
  reader, then verifies the team and goal snapshots after reopening the redesign.
  Backup restore still returns the exact previous state. 28 bounded settings/team
  and updater compatibility tests passed.
- Isolated GitHub HTTPS transport intentionally disables repository/global Git
  credential helpers. Added a fixed askpass helper that obtains credentials via
  `gh auth token` only for the exact GitHub HTTPS username/password prompts.
  Credentials travel through private child-process pipes, never argv or settings.
  Redirected/unrecognized hosts are refused; fake-credential helper tests passed.
  The real saved goal's startup retry fetched main and launched its planner.
- The real Codex 0.154.0 planner asked for manual permission on scoped MCP reads.
  Current official [MCP settings](https://developers.openai.com/codex/mcp/) and
  [configuration reference](https://developers.openai.com/codex/config-reference/)
  document server-specific approval policy. Only Companion's two fixed scoped MCP
  servers now use `default_tools_approval_mode = "approve"`; shell/computer tools
  remain disabled, filesystem sandbox remains read-only, and role hooks/server
  authority remain enforced. Seven Codex/files tests passed. Restarting the owned
  evaluation service stopped the earlier planner, retained its cancelled attempt
  and placed the goal on a hold; explicit Recover goal launched its replacement.


## Final native evaluation and completion checks

The user-authorized test repository completed one task in one wave using real
Codex 0.154.0 agents in managed cmux workspaces, real scoped MCP access, local Git
integration, service-run verification and GitHub publication:
[cmux-e2e-cypress PR #4](https://github.com/aorfevre/cmux-e2e-cypress/pull/4).
Only `src/left.mjs` and its matching assertion in `test/fixture.test.mjs` changed;
the right label and run marker were preserved. Both task and integration reviews
accepted without findings. The approved `npm test` passed on the published head
`d290f84af3c86efa43a16769026fd5d81970fbbc`, independently confirmed through GitHub.
The card remains Waiting for merge (internal `delivered`), with persisted merge
observation `open`; it has not been marked Complete.

The first plan incorrectly excluded all PR publication. A human revision requested
that Companion may publish after approval and clarified that its service executes
checks; the revised plan/team was approved through the same gate. Role prompts
now explain these responsibilities. Following approval, implementation, task
review, integration, verification and final review ran without another manual
step until the explicit publication approval. Earlier startup retry and stopped
planner recovery interventions are recorded above. This is a successful bounded
native journey, not evidence of an agreed intervention/performance target.

Final verification: `npm run verify` passed with 838 backend tests, one intentional
skip, 155 UI tests, lint, frontend/backend type checks and production build.
Final backend coverage passed all 838 tests with 97.19% lines; unchanged UI line
coverage is 95.09%. Relevant Chrome Cypress journeys passed, including responsive
Sessions/Setup/fleet/activity, real writable/read-only orchestration, onboarding
and isolated updater activation. Earlier failures and their fixes remain recorded
above; no unresolved routine check failure remains.

After publication settled and all owned workers stopped, the isolated evaluation
service was gracefully stopped. Its private temporary database, artifacts and
clone were retained for a later merge-observation check; restart locally with
`node /tmp/cmux-evaluation-service.mjs` while those temporary files remain.
The original test checkout and installed Companion state were not modified.

Unverified: real Claude/CCS execution, installed updater activation, native
multi-wave concurrency and actual externally merged-PR observation. Deterministic
coverage exercises those workflow boundaries, but does not substitute for their
native evaluation. Neither test nor product PR was merged; no deployment ran.
The user has not specified the representative success/intervention threshold.
