# Consolidated code review

> Historical review snapshot: the findings, counts and path:line citations below describe the source delivered in `f4052f1a8dc63761b50f874d452f7d551790d57a`. Later changes from main are reconciled in [PR #74 integration validation](integration-validation.md); they have not received another full repository review. The audit checks snapshot citations/inventories and separately checks current test membership.

## Overall verdict

Version 2.0 · 2026-09-06 · final source baseline `c89984a` (T6), following the original `444adaa` area investigations. This review covers all 56 tracked server modules, all 26 assigned client/PWA files, and the complete tracked tests, Cypress, scripts and named root tooling surface. The coverage partition is 15 planning + 18 goals + 23 platform modules. Files without findings remain in the area inventories.

The repository has strong transactional, dependency-injection, concurrency and UI regression foundations, but important failure paths remain unsafe. Prioritize preserving work during manual deletion, preventing competing session writers and ensuring the UI sends the instruction the user actually reviewed. Passing gates establish the covered contracts; they do not invalidate the deferred-response, cancellation and failed-evidence cases below. No critical or demonstrated unauthenticated execution exploit is established.

T6 delivered one bounded refactor: canonical Git worktree `--porcelain -z` tokenization and shared low-level Git invocation. Inventory and dashboard retain their different adapter shapes; RepoCatalog retains its shared FIFO admission, injected executor and finally-based release. The launch lookup retains canonical-path locking and its non-repository fallback. Caller-specific timeout, buffer, environment, stdout and rejection behavior remain tested. PLAT-007 is resolved. Task association’s separate wrapper remains GOAL-009; claiming that every Git execution site is centralized would be incorrect.

Area reports: [server planning](server-planning.md), [goal supervision and sessions](server-goals.md), [server platform](server-platform.md), [client and PWA](client.md), and [tests and tooling](tests-and-tooling.md).

## Evidence and validation method

T7 checked every numbered finding against its current cited implementation and compared all post-baseline source changes. Only four server modules changed in T6; the remaining reported implementation and existing test bodies are unchanged. Original isolated reproductions are attributed to T1–T5, not represented as newly executed T7 probes. T7 read the new parser/runner tests and browser spec, reviewed the refactor diff, refreshed shifted citations, added both new files to tooling coverage, and removed worktree-operations from the dedicated-suite gap list. The ledger distinguishes current code evidence from historical reproduction and unmeasured impact.

The machine-checkable audit is `node docs/code-review/check-review.mjs`: it checks required report sections, exact tracked coverage with duplicate rejection, npm membership, sorted gaps, ten ranked headings, links, every ledger ID and citation existence/line bounds. Line validity alone is not proof of a claim; semantic source checks underpin the individual dispositions. Current line counts below count physical lines, including blanks, rather than estimating cyclomatic complexity.

## What is good

| Verified strength | Code and test evidence | Limit of the evidence |
| --- | --- | --- |
| Transactional planning and explicit delivery evidence | `server/worktree-plan-store.mjs:187`, `server/worktree-plan-store.mjs:1094`; rollback test `tests/worktree-plan-store.test.mjs:415`; criterion/dependency validation `server/delivery-contract.mjs:237`, `tests/delivery-contract.test.mjs:48` | Logical rollback does not establish power-loss durability or size-boundary consistency. |
| Integration serialization and pushed-head readiness | `server/goal-integrator.mjs:209`, `server/goal-integrator.mjs:468`; competing-operation test `tests/goal-integrator.test.mjs:544`, recovery test `tests/goal-integrator.test.mjs:963` | Does not close the brief-write/abort window or all planner launch paths. |
| Conservative automatic cleanup and restored-session identity | `server/worktree-cleanup.mjs:109`, `server/goal-worktree-proof.mjs:18`, `server/restored-goal-sessions.mjs:6`; real-Git regressions `tests/worktree-cleanup.test.mjs:189`, `tests/worktree-cleanup.test.mjs:197`; restored ambiguity test `tests/goal-session-reaper.test.mjs:353` | Manual removal and recorded-session freshness have distinct weaknesses. |
| Shared Git concurrency survives extraction | `server/repo-catalog.mjs:310`, `server/worktree-operations.mjs:12`; slot/error test `tests/repo-catalog.test.mjs:271`, option/rejection matrix `tests/worktree-operations.test.mjs:65` | Bounded active processes does not imply bounded queued requests. |
| Canonical parser with compatibility adapters | `server/worktree-operations.mjs:16`, `server/worktree-inventory.mjs:16`, `server/worktree-dashboard.mjs:863`; exact shapes `tests/worktree-operations.test.mjs:43`, raw backend boundary `tests/worktree-operations.test.mjs:135`, UI `cypress/e2e/worktree-list-parsing.cy.ts:18` | Cypress uses API fixtures; NUL framing and LF/CRLF inside values are tested, not line-delimited porcelain support or every malformed stream. |
| Central authorization and filesystem containment | `server/app.mjs:204`, `server/security.mjs:40`, `server/repo-catalog.mjs:255`; `tests/api.test.mjs:610`, `tests/security.test.mjs:36`, `tests/repo-catalog.test.mjs:64` | No blanket ingress, race-free filesystem or outbound-network security certification. |
| Shared in-flight reads and useful UI assertions | `app/api-request.ts:5`; deferred fetch tests `tests/ui-api-request.test.tsx:5`, browser overload `cypress/e2e/dashboard-overload.cy.ts:57`, retry controls `cypress/e2e/task-branch-retry.cy.ts:46` | Request sharing does not reject obsolete selections. |
| Safe prose rendering and reviewable cleanup | `app/prompt-markdown.tsx:18`, `app/worktree-cleanup.tsx:45`; hostile-text test `tests/ui-features.test.tsx:745`, cleanup preview `cypress/e2e/goal-board-accuracy.cy.ts:117` | Does not prove whole-app accessibility or backend deletion safety. |

## Severity and category summary

There are 48 source IDs: 46 open canonical findings, one resolved (PLAT-007), and one consolidated (PLN-007 → GOAL-004). No numbered finding is wholly rejected; unsupported extensions of findings and obsolete claims are explicitly rejected below. Consolidation preserves both timer sites as required work.

| Severity | Open canonical | Resolved | Consolidated |
| --- | ---: | ---: | ---: |
| High | 12 | 0 | 0 |
| Medium | 23 | 1 | 1 |
| Low | 11 | 0 | 0 |
| Critical | 0 | 0 | 0 |

| Category family | Main consequences and source IDs |
| --- | --- |
| Destructive evidence and session ownership | PLAT-001/006; PLN-001/002/003; GOAL-001/002/003: lost work, stale closure evidence, competing agents. |
| Lifecycle and asynchronous ownership | GOAL-004/005, PLN-007, PLAT-002/004, CLIENT-001/009: obsolete continuations, unrecovered processes, cross-selection state. |
| Validation, persistence and error fidelity | PLN-004/005/006/008, PLAT-003/005/008, GOAL-006/007, CLIENT-002/003/006/007/008: inconsistent bounds, lost evidence and misleading outcomes. |
| UI access and presentation | CLIENT-004/005/011: misleading recovery controls, missing modal keyboard behavior and badge style mismatch. |
| Maintainability and resource bounds | PLN-009, GOAL-008/009, CLIENT-010, resolved PLAT-007: repeated policy/setup and cache retention. |
| Validation infrastructure | TEST-001–011: credential permissions, local-state isolation, membership, cleanup, process timing, fixtures and assertion limits. |

Categories describe cross-cutting themes, not additive counts; severity totals count canonical IDs once. High prioritizes loss of work, conflicting agents, wrong instructions or private local state. Medium denotes recoverable workflow and reliability failures; Low denotes narrower impact or maintenance cost.

## Ranked quality backlog

Exactly ten work packages follow, ordered by qualitative risk reduction per effort. S means a focused boundary fix, M means several related paths and regressions, L means coordination across lifecycle/ownership boundaries. Dependencies are implementation prerequisites, not permission to postpone independent protections. Items group related IDs without silently merging distinct defects; remaining lower-value open findings stay in the ledger and area actions.

### 1. Refuse manual deletion without fresh evidence

**Effort:** M · **Change risk:** medium · **Sources:** PLAT-001, PLAT-006. **Affected:** `server/worktree-dashboard.mjs:516`, `server/app.mjs:500`, `server/app.mjs:508`. **Dependencies:** existing repository operation lock and inventory contracts; no prior backlog item.

Highest return: a bounded change closes paths that can destroy edits or an active checkout. Require fresh status and known session availability under the launch/cleanup lock; preserve explicit discard semantics.

**Acceptance test:** With cached clean state, failed live Git/cmux reads or a newly appeared session, single and bulk removal issue no remove command and show a reason; a verified idle clean checkout remains removable.

### 2. Stop sends after failed saves and keep errors visible

**Effort:** S · **Change risk:** low · **Sources:** CLIENT-002, CLIENT-003. **Affected:** `app/page.tsx:125`, `app/page.tsx:137`, `app/page.tsx:305`. **Dependencies:** none.

A small mutation-result contract prevents sending obsolete instructions and makes failures observable across Home return branches.

**Acceptance test:** A Cypress failed PATCH followed by Send now produces zero send requests, preserves edited text and exposes a visible accessible error in terminal detail.

### 3. Protect operator state during tests and automation setup

**Effort:** M · **Change risk:** low · **Sources:** TEST-001, TEST-002, TEST-003. **Affected:** `scripts/configure-cmux-automation.mjs:63`, `scripts/configure-cmux-automation.mjs:66`, `tests/api.test.mjs:74`, `package.json:22`. **Dependencies:** none; provides safe fixtures for later work.

Isolate default stores, enforce private config/backup permissions and reject unclassified suites without enabling live discovery. These inexpensive guards improve every later validation run.

**Acceptance test:** Disposable CLI/config and API fixtures leave an operator-directory sentinel untouched, enforce 0600 on existing config/backups, and fail membership validation for an unlisted synthetic non-live suite while excluding live tests.

### 4. Claim session writers and revalidate cancellation and closure

**Effort:** L · **Change risk:** high · **Sources:** PLN-001, PLN-002, PLN-003, GOAL-001, GOAL-002, GOAL-003. **Affected:** `server/worktree-planner.mjs:1201`, `server/worktree-planner.mjs:952`, `server/github-issue-sync.mjs:84`, `server/github-issue-planner.mjs:65`, `server/goal-integrator.mjs:305`, `server/goal-session-reaper.mjs:173`, `server/goal-followup.mjs:49`. **Dependencies:** isolated stores from item 3; preserve shared launch/worktree locking from item 1.

Large effort is justified by six high-severity ownership failures. Implement reservations before asynchronous work, fresh status before closure, unique durable follow-up IDs, and recoverable compensation for abort during create. Avoid one global lock that stops independent goals.

**Acceptance test:** Deferred launch/brief/close and concurrent issue/follow-up tests establish one authorized writer, no replacement after unverified closure, no close of newly running sessions, no post-abort unowned workspace and independent-goal progress.

### 5. Reject obsolete client responses

**Effort:** M · **Change risk:** medium · **Sources:** CLIENT-001, CLIENT-009. **Affected:** `app/page.tsx:78`, `app/page.tsx:97`, `app/account-usage.tsx:81`, `app/account-usage.tsx:104`. **Dependencies:** none; preserve item 2’s feedback host.

Selection generations and monotonic reconnect terminal states prevent wrong-context decisions without replacing the polling fallback.

**Acceptance test:** Delayed A→B→A replay/queue responses never overwrite the current selection, and an older waiting poll cannot replace successful reconnect or invoke adoption after close.

### 6. Make accepted data survive its full round trip

**Effort:** M · **Change risk:** medium · **Sources:** PLN-004, PLN-005, PLN-006, PLAT-003. **Affected:** `server/delivery-contract.mjs:380`, `server/worktree-planner.mjs:76`, `server/worktree-plan-store.mjs:1021`, `server/prompt-queue.mjs:9`, `server/cmux-client.mjs:510`. **Dependencies:** item 3’s isolated fixtures.

Align accepted/reportable prompt and completion limits, retain final model output, and never slice serialized JSON into invalid history.

**Acceptance test:** Exact-limit, limit-plus-one and escaped aggregate cases either fail before acceptance or round-trip intact; a saturated stdout stream retains its final result, and an oversized legacy queue entry cannot indefinitely block valid work.

### 7. Invalidate stopped work and recover unavailable observations

**Effort:** M · **Change risk:** medium · **Sources:** GOAL-004, PLN-007, GOAL-005, GOAL-006, PLAT-004. **Affected:** `server/goal-watchdog.mjs:66`, `server/github-issue-sync-scheduler.mjs:45`, `server/event-hub.mjs:50`, `server/goal-integrator.mjs:422`, `server/ccs-reconnect.mjs:86`. **Dependencies:** item 3’s inert background fixtures; coordinate lifecycle generations with item 4.

Stop/start generations and typed absent/unavailable results address concrete stale-finalizer and false-permanent-failure paths. Keep retry bounds explicit.

**Acceptance test:** Held success/failure finalizers cannot restart stopped timers or complete cancelled reconnect; missing-binary recovery retries only with consumers, and transient gh failure remains retryable until a valid PR observation succeeds.

### 8. Fix small boundary errors and reserve preview ports

**Effort:** M · **Change risk:** medium · **Sources:** PLN-008, PLAT-002, PLAT-005, CLIENT-006, CLIENT-007. **Affected:** `server/github-issue-sync.mjs:129`, `server/preview-manager.mjs:169`, `server/security.mjs:34`, `app/page.tsx:61`, `app/context-links.mjs:42`. **Dependencies:** none; test fixtures from item 3 are useful.

These bounded fixes prevent silent backlog incompleteness, conflicting endpoints and render/request failures without architectural extraction.

**Acceptance test:** Limit-honoring 99/100/101-issue fixtures report completeness correctly; simultaneous previews reserve distinct ports; malformed cookies/links and throwing storage yield controlled outcomes while valid bearer, external links and defaults still work.

### 9. Make sheets and offline navigation reliable

**Effort:** M · **Change risk:** medium · **Sources:** CLIENT-004, CLIENT-005, CLIENT-008, CLIENT-011, TEST-011. **Affected:** `app/worktree-planner.tsx:528`, `app/worktree-planner.tsx:615`, `public/sw.js:25`, `app/features.css:276`, `tests/responsive-layout.test.mjs:7`. **Dependencies:** item 2’s accessible feedback; isolate worker-enabled tests from ordinary Cypress support.

Use one modal primitive, hide closed-goal mutations, preserve a healthy offline shell and verify rendered geometry/cascade. Preserve draft state during any worker update policy change.

**Acceptance test:** Keyboard-only local Cypress confines/restores focus, closed launched goals expose no recovery requests, Added badges have the intended style, and an isolated worker-enabled 503→offline scenario retains healthy shell and drafts.

### 10. Make validation failures clean up and report accurately

**Effort:** M · **Change risk:** low · **Sources:** TEST-004, TEST-005, TEST-006, TEST-007, TEST-008, TEST-009, TEST-010. **Affected:** `tests/prompt-queue.test.mjs:25`, `tests/live-cmux.test.mjs:26`, `cypress/live/real-goal.cy.ts:95`, `scripts/run-local-cypress.mjs:26`, `tests/worktree-planner.test.mjs:695`, `eslint.config.mjs:26`. **Dependencies:** item 3’s fixture/discovery boundary.

Register cleanup immediately, preserve created resource IDs, aggregate structured cleanup errors, bound runner shutdown/readiness and replace guessed waits. Extract only fresh-state fixture factories; scope static globals by runtime. Validate live cleanup logic with fakes first.

**Acceptance test:** Injected setup/cleanup/spawn/hanging-fetch failures release every acquired disposable resource, report leftovers and terminate within a deadline; deterministic suites pass under delayed scheduling and server lint rejects browser-only globals.

## Duplicate-code inventory

| Disposition | Sites / canonical source | Assessment |
| --- | --- | --- |
| Resolved — PLAT-007 | `server/worktree-operations.mjs:16`; adapters `server/worktree-inventory.mjs:16`, `server/worktree-dashboard.mjs:863` | One worktree-field tokenizer; boolean/primary versus detached/reason adapter projections are intentional contract differences. |
| Resolved — PLAT-007 | `server/worktree-operations.mjs:12`, `server/repo-catalog.mjs:310`, `server/worktree-inventory.mjs:13`, `server/worktree-operations.mjs:80` | Three sites share Git argv/invocation; execution policy and queue admission stay with callers. |
| Open — GOAL-009 | `server/task-association.mjs:8` | Remaining independent Git wrapper can reuse runGit while retaining 30 s/1 MiB/trim policy. Overlapping delivered duplication is counted only in PLAT-007. |
| Open — PLN-009 | `server/agent-capacity.mjs:96`, `server/worktree-planner.mjs:360`, `server/worktree-planner.mjs:1853`, `server/worktree-plan-store.mjs:1233` | Quota explanation and safe-spec fallback repeat policy; issue projections additionally differ in trust/provenance. No observed quota divergence. |
| Open — GOAL-004 (includes PLN-007) | `server/goal-watchdog.mjs:66`, `server/github-issue-sync-scheduler.mjs:45` | Same unconditional finalizer defect; fix both owners under one canonical finding. |
| Open — CLIENT-010/011 | `app/apps-view.tsx:15`, `app/page.tsx:121`, `app/image-attachments.tsx:35`, `app/features.css:643` | Compatible request/attachment mechanics and CSS rules repeat; preserve error messages, URLs and cascade rather than deleting every similar line. |
| Open — TEST-009 | `tests/planner-background.test.mjs:30`, `tests/worktree-planner.test.mjs:196`, `tests/goal-recovery.test.mjs:31`, `cypress/e2e/goal-spec-options.cy.ts:118` | Fresh-state dependency builders and 12 API fallback setups can share small factories. |
| Open — low-priority supplemental inventory | `server/repository-archive.mjs:14`, `server/repository-favorites.mjs:14` | Small Set persistence duplication; not another numbered defect. RepoCatalog’s package metadata read is not mutable JSON persistence. |

## Complexity-hotspot inventory

No historical size is used to infer a bug. These are current physical line counts and candidate responsibility seams; preserve DI, transaction and operation claims before moving code. Dense JSX/CSS means even short physical files can be hard to change.

| Current file | Lines | Responsibility boundaries / recommended seam |
| --- | ---: | --- |
| `server/worktree-planner.mjs:1` | 2,152 | Process I/O and provider policy; planning contracts; launch/recovery lifecycle; brief formatting. Stabilize ownership before decomposition. |
| `server/worktree-plan-store.mjs:1` | 1,302 | Schema/migration; transactions and row mutation; event serialization; lifecycle projection. Keep atomic writes explicit. |
| `server/app.mjs:1` | 1,229 | Service construction and disposal; auth/error hooks; route families; bootstrap caches; SSE/WebSocket leases. Extract cohesive route plugins after safety fixes. |
| `server/worktree-dashboard.mjs:1` | 1,069 | Snapshot scheduling; Git/PR/session projection; worktree acquisition and deletion; presentation adapters. Separate destructive policy from display. |
| `server/goal-integrator.mjs:1` | 815 | Per-plan queues/timers; readiness proof; assembly/waves; merge PR settlement; prompt formatting. Retain operation-specific queues. |
| `app/worktree-dashboard.tsx:1` | 1,164 | Polling; board filtering/columns; preferences; operation handlers; cards/dialogs. Extract state ownership before reusable chrome. |
| `app/worktree-planner.tsx:1` | 659 | SSE/poll lifecycle; draft/contract editing; launch/recovery handlers; sheet rendering. Shared modal plus owned request generations. |
| `app/page.tsx:1` | 345 | Auth/socket/selection/queue orchestration; terminal/launch/detail components; dense single-line handlers. Physical size understates mixed responsibilities. |
| `app/features.css:1` | 873 | Component rules, responsive rules and later overrides. Format first, preserve computed cascade during extraction. |
| `tests/ui-features.test.tsx:1` | 2,595 | Many UI families and broad mocks; split by behavior with fresh fixtures. |
| `tests/worktree-planner.test.mjs:1` | 2,293 | Provider/process contracts, lifecycle and launch fixtures; separate process integration from deterministic logic. |
| `tests/api.test.mjs:1` | 1,692 | Auth, routing, deployment and orchestration; isolated app factory before splitting. |
| `tests/worktree-dashboard.test.mjs:1` | 1,466 | Parsing, repositories, worktrees, PR and session reconciliation; preserve real-Git assertions. |
| `tests/worktree-plan-store.test.mjs:1` | 1,329 | Migration, transactions, round events and lifecycle contracts. |
| `tests/goal-integrator.test.mjs:1` | 1,035 | Readiness, waves, merge ownership and recovery scenarios. |
| `server/worktree-operations.mjs:1` | 91 | Now owns parser and runner as well as file/lock helpers; 91 lines is not evidence of an oversized abstraction. |

## Dedicated-suite gaps

Copied exactly from the tests report’s current marker block: 19 modules have no same-basename Node suite. This is a naming inventory, not an assertion that they are untested. worktree-operations is removed because T6 added its dedicated suite.

<!-- dedicated-test-gap:start -->
app
deployment-health
event-hub
github-issue-board
github-issue-store
goal-merge-watch
goal-worktree-proof
index
launch-runs
planner-runs
release-retention
repository-archive
repository-favorites
restored-goal-sessions
supervisor
task-branch
worktree-errors
worktree-inventory
worktree-planner-options
<!-- dedicated-test-gap:end -->

Indirect or differently named coverage is separate: app/deployment-health use API tests; GitHub issue board/store use github-issue-sync; merge-watch uses dashboard/collector; proof/inventory use cleanup; launch-runs/task-branch use planner; planner-runs uses background tests; archive/favorites use dashboard; restored sessions use reaper; errors use API/integrator/recovery/store; planner-options uses spec-options. The [per-module table](tests-and-tooling.md#dedicated-suite-gap-only) supplies exact import/assertion citations. event-hub has an app construction relationship without focused subprocess coverage; release-retention has forwarding/browser fixture relationships without focused backend wrapper assertions. index and supervisor have no dedicated startup/process regressions identified. Import relationships are not exhaustive behavioral coverage.

Prioritize startup/shutdown, event spawn/reconnect/backpressure and retention failure paths. Cypress’s service-worker reset at `cypress/support/e2e.ts:6` leaves real PWA lifecycle a separate browser gap. The new raw-Git integration and branch/Locked browser assertions complement each other; neither substitutes for the other.

## Disposition ledger

Every source ID occurs once below. “Open” means current source supports the bounded claim; area probe results remain attributed there. Similar risks with different causes remain separate IDs. “Resolved” is scoped to delivered code and tests; “consolidated” preserves an affected site under its canonical ID.

| Finding | Disposition | Current evidence / reason and destination |
| --- | --- | --- |
| PLN-001 | open | `server/worktree-planner.mjs:1201` — Awaited launch still bypasses begin; item 4. |
| PLN-002 | open | `server/worktree-planner.mjs:952` — Close errors still resolve before replacement; item 4. |
| PLN-003 | open | `server/github-issue-sync.mjs:84` — Issue claim remains check-then-create; item 4. |
| PLN-004 | open | `server/delivery-contract.mjs:362` — Accepted checks can exceed 4,000-character report parser; item 6. |
| PLN-005 | open | `server/worktree-planner.mjs:74` — Output buffer retains prefix and drops later result; item 6. |
| PLN-006 | open | `server/worktree-plan-store.mjs:1021` — Serialized event text is still sliced before JSON decode; item 6. |
| PLN-007 | consolidated | `server/github-issue-sync-scheduler.mjs:38` — Canonical GOAL-004 includes both unconditional timer-finalizer sites; item 7, not a second canonical count. |
| PLN-008 | open | `server/github-issue-sync.mjs:129` — CLI limit equals threshold, so >100 cannot arise from a limit-honoring response; item 8. |
| PLN-009 | open | `server/agent-capacity.mjs:96` — Quota/safe-options normalization still duplicated; optional focused refactor after safety backlog. |
| GOAL-001 | open | `server/goal-integrator.mjs:299` — Brief await still separates lifecycle read from create; item 4. |
| GOAL-002 | open | `server/goal-session-reaper.mjs:113` — Recorded closures do not repeat restored-session fresh-status guard; item 4. |
| GOAL-003 | open | `server/goal-followup.mjs:26` — Concurrent count-based brief IDs and checkout writers remain possible; item 4. |
| GOAL-004 | open | `server/goal-watchdog.mjs:60` — Watchdog and issue scheduler rearm in obsolete finalizers; canonical owner of PLN-007; item 7. |
| GOAL-005 | open | `server/event-hub.mjs:50` — Spawn error retains child and schedules no retry; item 7. |
| GOAL-006 | open | `server/goal-integrator.mjs:422` — gh rejection still becomes absent PR and permanent-looking block; item 7. |
| GOAL-007 | open | `server/goal-integrator.mjs:334` — TypeError wrapping still discards cause/code; preserve metadata during later integrator cleanup. |
| GOAL-008 | open | `server/goal-health.mjs:35` — Screen cache TTL controls reuse, with no churn eviction; bounded-cache follow-up. |
| GOAL-009 | open | `server/task-association.mjs:7` — Only association wrapper remains open; overlapping parser/three-site runner claims consolidated into resolved PLAT-007. Preserve association output policy on migration. |
| PLAT-001 | open | `server/worktree-dashboard.mjs:516` — Failed live status falls back to cached clean state before forced single removal; item 1. |
| PLAT-002 | open | `server/preview-manager.mjs:110` — No port reservation precedes external awaits; item 8. |
| PLAT-003 | open | `server/prompt-queue.mjs:9` — Queue permits 32,000, sender only 16,000; item 6. |
| PLAT-004 | open | `server/ccs-reconnect.mjs:66` — Callback continuation still registers after cancel; item 7. |
| PLAT-005 | open | `server/security.mjs:34` — Cookie decoding can throw before valid bearer fallback; request-local impact only; item 8. |
| PLAT-006 | open | `server/app.mjs:326` — Manual routes discard session availability and lack launch-lock recheck; item 1. |
| PLAT-007 | resolved | `server/worktree-operations.mjs:16` — T6 canonical parser and three invocation sites delivered; direct/adapter/backend tests plus local UI evidence. No claim of LF-delimited parsing or all Git wrappers migrated. |
| PLAT-008 | open | `server/app.mjs:55` — App combines lifecycle/routes; TypeError branch loses requested status. Extract later with explicit compatibility tests. |
| CLIENT-001 | open | `app/page.tsx:97` — Shared state accepts late replay/queue reads unconditionally; code trace, item 5. |
| CLIENT-002 | open | `app/page.tsx:305` — Caught PATCH error resolves onUpdate, so send proceeds; code trace, item 2. |
| CLIENT-003 | open | `app/page.tsx:137` — Detail early return omits Home notice host; item 2. |
| CLIENT-004 | open | `app/worktree-planner.tsx:615` — Closed launched rows still receive recovery callbacks; backend rejects mutation, item 9. |
| CLIENT-005 | open | `app/worktree-planner.tsx:528` — Custom modal roles lack focus containment/restore and Escape handling; conformance not measured, item 9. |
| CLIENT-006 | open | `app/page.tsx:61` — Home storage access is unguarded and font initialization unbounded; item 8. |
| CLIENT-007 | open | `app/context-links.mjs:42` — Unguarded URI decode and local resolution before scheme dispatch remain; item 8. |
| CLIENT-008 | open | `public/sw.js:25` — 503 may replace healthy shell; production mixed-version/device impact remains unverified; item 9. |
| CLIENT-009 | open | `app/account-usage.tsx:104` — Late poll adopts state without generation/terminal guard; code trace, item 5. |
| CLIENT-010 | open | `app/apps-view.tsx:15` — Request/upload mechanics remain duplicated with differing contracts; incremental follow-up. |
| CLIENT-011 | open | `app/features.css:276` — change-new CSS differs from change-added markup; other cascade duplication alone is not a visual defect, item 9. |
| TEST-001 | open | `scripts/configure-cmux-automation.mjs:66` — Creation mode does not chmod existing config; backups copy mode. Parent permissions determine exposure; item 3. |
| TEST-002 | open | `tests/api.test.mjs:74` — Default app fixtures still construct homedir plan store; T7 isolation avoids but does not fix it; item 3. |
| TEST-003 | open | `package.json:22` — 45 current non-live suites included; future suites need explicit membership update, item 3. |
| TEST-004 | open | `tests/prompt-queue.test.mjs:25` — Cleanup hooks still follow fallible operations; item 10. |
| TEST-005 | open | `tests/live-cmux.test.mjs:26` — Polling can overwrite known created workspace ID; independent cleanup can be skipped on close failure; item 10. |
| TEST-006 | open | `cypress/live/real-goal.cy.ts:95` — Live hook ignores structured cleanup errors; no live resource leak was reproduced, item 10. |
| TEST-007 | open | `scripts/run-local-cypress.mjs:26` — Fetch deadline and awaited process-tree teardown absent; no universal leak claim, item 10. |
| TEST-008 | open | `tests/worktree-planner.test.mjs:692` — Real-time margins and fixed sleeps remain; no measured flake rate, item 10. |
| TEST-009 | open | `tests/planner-background.test.mjs:30` — Fresh-state builders and API fallbacks repeat; current counts in hotspot inventory, item 10. |
| TEST-010 | open | `tsconfig.json:21` — Typecheck excludes checkJs and lint shares environment globals; passing gate does not prove server types, item 10. |
| TEST-011 | open | `tests/responsive-layout.test.mjs:7` — CSS regexes cannot verify computed geometry; capture depends on local Chrome, item 9. |

## Rejected, obsolete and unverified claims

The area reports retain their full rejected-claim records and probe limits. These dispositions prevent stronger claims being inferred from green tests or from findings’ titles.

| Claim | Disposition and reason |
| --- | --- |
| Parser and three low-level execution sites still duplicate T6’s delivered implementation | Rejected as obsolete; PLAT-007 is resolved. GOAL-009 is narrowed to association. |
| worktree-operations lacks a dedicated suite; 44 non-live suites and 11 deterministic specs describe the final tree | Rejected as obsolete; current counts are 45 suites, 12 specs, 19 dedicated gaps. |
| All tracked suites are automatically discovered, or npm test currently omits a suite | Rejected: exact membership is complete but explicitly enumerated. Synthetic future-member comparison confirms TEST-003. A broad glob would include live-cmux. |
| Missing same-basename suites mean modules are untested | Rejected: separately named imports and integration assertions are recorded above. |
| Git adapters are identical for every arbitrary malformed string; parser supports LF-delimited records | Unverified/rejected as a universal compatibility claim: tests establish supported NUL-framed Git records, missing final NUL and LF/CRLF inside values. Malformed streams with repeated fields or missing worktree values need an explicit contract before stronger claims. |
| Dashboard has a third independent Git executor; RepoCatalog duplicates mutable JSON persistence | Rejected: dashboard delegates to catalog; package script discovery is a read, not archive/favorite persistence. |
| All stores lack atomicity; every swallowed persistence failure is wrong | Rejected: transactions/temp rename and deliberately preserved paid-for rounds have tests. Filesystem fault durability remains unverified. |
| Assemble and settle steal a shared timer/lock; watchdog and collector use independent production reapers | Rejected: separate timers, per-plan queues and the shared production reaper are present and tested. |
| Closed-goal controls bypass server protection; simultaneous dashboard polling always duplicates reads | Rejected: backend terminal guards and shared in-flight request tests contradict these extensions of CLIENT-004/001. |
| Forwarded headers prove origin bypass; capture or push endpoint handling proves an exploit | Unverified: ingress, hostile-page and outbound-target attack paths were not reproduced. Retain targeted test gaps, not security incident claims. |
| Tight timeouts prove frequent flakes; runner always leaks; cache churn proves a measured production memory incident | Unverified: source establishes bounded claims and missing guards, not real-world rates or magnitudes. |
| Production PWA install/update/push, maskable icon quality or whole-app accessibility are certified | Unverified: worker is disabled in deterministic Cypress; real-device, pixel and full accessibility audits were not performed. |
| Empty Next configuration plus vinext is necessarily broken; dependency vulnerabilities or lockfile drift are proven | Rejected as established defects: build/typecheck validation and locked install are the relevant evidence; no advisory or exploit audit is claimed. |
| All validation passed in each original area investigation | Rejected: each area’s recorded command scope is preserved; T6/T7 combined gates are separate evidence. |
| Cypress should run in CI or live-agent validation is needed for this documentation pass | Rejected: repository policy keeps Cypress local-only; T6 backend and deterministic UI checks cover the refactor boundary. |

## Verification and completion evidence

Validation results are recorded here after execution. T7 changes only docs/code-review, including the reusable non-mutating audit. No runtime feature was added: new unit and Cypress edge-case coverage and the touched-code refactor pass were delivered by T6. Adding a second runtime refactor or unrelated feature tests would duplicate owned work.

The T6 matrix names empty/multiple/trailing records, bare/detached, reasonless/reasoned locked/prunable markers, unknown/early fields, unusual whitespace and prefix stripping; runner options/defaults/overrides, inherited environments, empty/missing output, rejection identity and no-repository launch fallback are directly tested. Supported NUL framing is distinct from LF text inside values. Backend raw porcelain tests cover the boundary unavailable to intercepted Cypress; the latter verifies existing branch and lock presentation with normal removal blocked.

T7 gate execution uses locked dependencies (`npm ci --ignore-scripts --no-audit --no-fund`) and disposable default-store isolation: a temporary Node preload redirects os.homedir and explicit CMUX_COMPANION_HOME/PLANS_DB/REPO_DB values point into a canonical temporary directory. Shell HOME is unchanged. This prevents TEST-002 from opening operator data; it does not count as fixing the fixture defect. No tracked runtime or configuration changes are needed for this execution environment.

| Executed check (2026-09-06) | Result |
| --- | --- |
| Locked dependency install | Passed; no tracked dependency changes. |
| `node docs/code-review/check-review.mjs` | Passed: server partition 15/18/23, client 26, tooling 88, 19 sorted gaps, 45 non-live Node members, 48 ledger IDs and 854 valid citations across six reports. |
| Literal `comm -23` dedicated-suite comparison | Passed; exact marker equality. |
| Standalone Node one-line citation checker | Passed: all 854 backticked path/line citations exist and are in bounds. |
| README existence, exactly ten numbered headings and all five links | Passed. |
| `npm run verify` | Passed: 906 backend tests (zero skipped), 95 UI tests, lint, typecheck and build; exit 0. |
| Audit utility ESLint check | Passed after final utility creation. |
| `npm run test:e2e:local` after verify | Passed: 45 tests in 12 specs, including worktree-list-parsing; exit 0. |
| Cypress configuration diff against T6 | Empty; no local/live configuration changes or CI enablement. |
| Severity/disposition recount and `git diff --check` | Passed: 12 high, 23 medium and 11 low open canonical findings. |

Build completed with advisory large-chunk and vinext route-classification messages; these are not test failures or measurements of production performance. Original missing-dependency attempts in the area reports remain historical environment failures; T7’s installed-dependency gate passed on its first execution. Detailed reproducible check logic is versioned alongside this report; full transient command logs were retained locally during execution.

No live-agent, installed-companion, real GitHub merge, deployment or CI Cypress configuration was changed or exercised. Security attack scenarios, production device behavior and full branch-coverage percentages remain outside demonstrated evidence, as explicitly recorded above. There are no ownership exceptions and no outstanding T7 implementation requests; lower-priority weaknesses are review outcomes, not uncompleted documentation work.
