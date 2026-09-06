# Server planning and contracts review

## Summary

T7 validation update (2026-09-06): findings were checked against post-refactor commit `c89984a`; original executed probes below remain attributed to their area review. Current consolidated dispositions and verification are in [the final review](README.md). Historical branch-isolation limitations below describe the original investigation, not missing assembled reports.

Review version: 1. Reviewed source: `444adaa059496acd27f24e75208e90bddf5cce38`, on 2026-09-05. Scope: T1, 15 assigned modules, all read in full (5,464 lines). This report changes documentation only.

The strongest foundations are transactional plan updates, explicit contract references, injectable process boundaries, and observable background work. Nine verified findings follow: three high, five medium, and one low; none critical. Eight failure cases were reproduced locally with isolated dependencies; the remaining finding is confirmed duplication, not an observed behavioral divergence.

Prioritize session ownership first (PLN-001 and PLN-002), then issue creation deduplication (PLN-003). Next align serialization limits across planning, completion, and history (PLN-004 through PLN-006). Fix scheduler shutdown and backlog completeness (PLN-007 and PLN-008). Extract the small duplicated policy functions last (PLN-009). These are recommendations for subsequent work, not fixes included in T1.

Verification: after `npm ci --ignore-scripts`, `npm test` passed all 882 tests and `npm run test:ui` passed all 95 tests in two files. The first Node run had 793 passes and four failures caused by absent fastify, playwright-core, and web-push dependencies; the successful rerun supersedes that environment failure. Eight additional assertion-based probes passed, meaning they reproduced the defects described below. They used temporary files/in-memory SQLite, injected Git/cmux/planner dependencies, and one local Node child; no real agent, GitHub mutation, or production store was used.

## Coverage

The block below is a machine-readable JSON array, bounded by literal markers. Membership means full source review, including paths with no verified finding. Adjacent callers and tests are supporting evidence, not additional ownership.

<!-- coverage:start -->
```json
[
  "server/worktree-planner.mjs",
  "server/worktree-plan-store.mjs",
  "server/delivery-contract.mjs",
  "server/spec-options.mjs",
  "server/review-options.mjs",
  "server/worktree-planner-options.mjs",
  "server/planner-progress.mjs",
  "server/planner-runs.mjs",
  "server/github-issue-planner.mjs",
  "server/github-issue-store.mjs",
  "server/github-issue-board.mjs",
  "server/github-issue-sync.mjs",
  "server/github-issue-sync-scheduler.mjs",
  "server/agent-brief.mjs",
  "server/agent-capacity.mjs"
]
```
<!-- coverage:end -->

Tests were located by assigned basenames, imports/re-exports, exported names (including `PlannerRuns`, `assignAgents`, `streamExecFile`, `scopeDrift`, and board predicates), and API operations. Assertions and fixtures relevant to the claims below were inspected; this is not a claim to have read every test file in full.

| Reviewed surface | Relevant test locations and behavior |
| --- | --- |
| Planner, engines, runs and progress | `tests/worktree-planner.test.mjs`, `tests/planner-background.test.mjs`, `tests/planner-progress.test.mjs`: parsing, retries, engine flags, quota fallback, persistence recovery, background concurrency, abort, discussion, launch and progress replay. `PlannerRuns` coverage lives in planner-background, not a same-named test. |
| Contract, spec and review options | `tests/delivery-contract.test.mjs`, `tests/spec-options.test.mjs`, `tests/review-options.test.mjs`; planner and store tests additionally exercise propagation, legacy values and stored options. |
| Durable plan lifecycle | `tests/worktree-plan-store.test.mjs`, `tests/goal-integrator.test.mjs`, `tests/goal-recovery.test.mjs`, `tests/goal-session-collector.test.mjs`, `tests/goal-session-reaper.test.mjs`, `tests/task-association.test.mjs`, `tests/goal-watchdog.test.mjs`; also related follow-up, board, health, cleanup and session-name suites in the full Node run. |
| GitHub planning, storage and board | `tests/github-issue-planner.test.mjs`, `tests/github-issue-sync.test.mjs`, `tests/github-issue-sync-scheduler.test.mjs`. Store and board predicates are directly tested inside github-issue-sync. |
| Agent brief and capacity | `tests/agent-brief.test.mjs`, `tests/agent-capacity.test.mjs`; planner, recovery and integrator tests cover brief consumption and assignment. |
| HTTP and rendered UI | `tests/api.test.mjs` exercises planner routing and validation; `tests/ui-features.test.tsx` exercises planner sheets, issue cards, capacity and contract discussion. Both ran through the Node/UI commands above. API tests with an injected planner establish delegation, not real planner concurrency safety. |
| Cypress behavior located | `cypress/e2e/goal-spec-options.cy.ts`, `cypress/e2e/spec-challenge.cy.ts`, `cypress/e2e/github-issue-sync.cy.ts`, `cypress/e2e/github-issue-column.cy.ts`, `cypress/e2e/goal-launch-fire-and-forget.cy.ts`, `cypress/e2e/task-branch-retry.cy.ts`; related board-search, collapsed-column and session-cleanup specs. `cypress/live/real-goal.cy.ts` is the opt-in integration surface. Cypress was not run for this documentation-only investigation. |

Production routing was checked in `server/app.mjs:642` and `server/app.mjs:813`; the issue scheduler is shared between manual and scheduled sync at `server/app.mjs:807`. Recovery/cleanup scripts also import the plan store. No claim is made that the other four area reports or the union of all server coverage blocks is complete: those documents are absent on this task branch. The baseline has 56 tracked server modules; T1 owns 15 of them. Combined AC-1 validation belongs to assembled delivery.

## What is good

- **Durable changes are transactional.** `server/worktree-plan-store.mjs:187` groups the round, tasks, submitted answers and event; `server/worktree-plan-store.mjs:1094` rolls back on failure. `tests/worktree-plan-store.test.mjs:415` injects a task getter failure and verifies that the previous session, round and event history survive. Reopening and legacy migration are covered at `tests/worktree-plan-store.test.mjs:512` and `tests/worktree-plan-store.test.mjs:530`. This verifies logical atomicity, not power-loss durability of every file.
- **Ownership and evidence are structured.** `server/delivery-contract.mjs:237` validates criterion references, dependencies, duplicate branches, ownership and verification; `server/delivery-contract.mjs:342` detects dependency cycles. `tests/delivery-contract.test.mjs:43`, `tests/delivery-contract.test.mjs:48` and `tests/delivery-contract.test.mjs:79` assert waves, invalid references and overlap warnings. Downstream enforcement is exercised by `tests/goal-integrator.test.mjs:165` and `tests/goal-integrator.test.mjs:186`. Size-boundary exceptions are PLN-004 and PLN-006.
- **Shared catalogs avoid UI/server option drift.** Frozen engine/spec data at `server/worktree-planner-options.mjs:5` and `server/worktree-planner-options.mjs:57` feed strict request normalization at `server/spec-options.mjs:8` and `server/review-options.mjs:30`. Tests at `tests/spec-options.test.mjs:41` and `tests/review-options.test.mjs:41` reject unknown keys and non-booleans. `tests/worktree-planner.test.mjs:246` and `tests/worktree-planner.test.mjs:273` verify provider/model/effort forwarding and opposite-provider review. Requested rigor and post-delivery review remain distinct contracts.
- **Background observability has explicit state and isolation.** `server/worktree-planner.mjs:739` registers detached work and handles settlement; `server/planner-runs.mjs:33` validates stages. `tests/planner-background.test.mjs:126` verifies independent goals can run concurrently; `tests/planner-background.test.mjs:169` verifies refusal while a background round owns the plan. Abort cleanup is exercised at `tests/planner-background.test.mjs:402` and `tests/planner-background.test.mjs:745`. These strengths do not establish that awaited launch paths share the same lock (PLN-001).
- **Replay and model artifacts have useful bounds.** UUID admission, a 40-event window and a 64-trace cap are implemented at `server/planner-progress.mjs:25` and `server/planner-progress.mjs:57`; replay, eviction and listener isolation are asserted at `tests/planner-progress.test.mjs:29`, `tests/planner-progress.test.mjs:56` and `tests/planner-progress.test.mjs:78`. The artifact text budget at `server/delivery-contract.mjs:79` is tested at `tests/delivery-contract.test.mjs:254`. These are specific bounds, not a blanket assertion that all active runs or stored events are capped.
- **GitHub fetch failures are isolated and existing cards survive reconciliation.** Four fetch workers at `server/github-issue-sync.mjs:114` limit process fan-out; only healthy repositories are replaced at `server/github-issue-sync.mjs:55`. Atomic file replacement at `server/github-issue-store.mjs:119` avoids exposing partially written JSON. Persistence/reconciliation assertions are at `tests/github-issue-sync.test.mjs:164` and `tests/github-issue-sync.test.mjs:177`. Board predicates at `server/github-issue-board.mjs:57` restore an issue when its linked goal is absent; `tests/github-issue-sync.test.mjs:68` covers it. Existing-goal lookup works sequentially, but is not an atomic claim (PLN-003).
- **Issue analysis checks selected work against refreshed evidence.** `server/github-issue-planner.mjs:58` refreshes issues before preparing topics and checks existing claims. `tests/github-issue-planner.test.mjs:98` exercises changed timestamps and existing ownership. The model prompt explicitly labels repository issue fields untrusted and denies tools; `tests/github-issue-planner.test.mjs:51` checks the invocation flags. This verifies prompt/argument construction, not universal resistance to prompt injection.
- **Private briefs and quota explanations have concrete tests.** `server/agent-brief.mjs:29` writes complete briefs with private permissions and validates identifiers; `tests/agent-brief.test.mjs:10`, `tests/agent-brief.test.mjs:21` and `tests/agent-brief.test.mjs:42` verify content, traversal refusal and aging. Capacity calls the real dispatcher at `server/agent-capacity.mjs:30`; `tests/agent-capacity.test.mjs:133` compares their verdicts. Window selection and unavailable usage are tested at `tests/agent-capacity.test.mjs:29` and `tests/agent-capacity.test.mjs:123`.

## Findings

### PLN-001 — Awaited launches bypass the launch claim

- **Severity:** high. **Category:** concurrency / session ownership.
- **Location:** `server/worktree-planner.mjs:1201`; compare the claim at `server/worktree-planner.mjs:1216`.
- **Consequence:** two awaited launches of the same ready plan can both pass validation and create task sessions. They can reuse the same clean checkout before either agent writes, leaving competing agents and only the last recorded workspace identity. The default HTTP launch route and GitHub topic launch use this awaited path (`server/app.mjs:643`, `server/github-issue-planner.mjs:103`).
- **Evidence:** an in-memory ready one-task plan, empty injected inventory, asynchronous successful acquisition, and `Promise.all([planner.launch('p'), planner.launch('p')])` called `workspaceCreate` twice. Neither call registers a launch. The actual dashboard can reuse a checkout at the base and uses the supplied inventory (`server/worktree-dashboard.mjs:621`, `server/worktree-dashboard.mjs:773`); it is not a plan-level claim. `tests/planner-background.test.mjs:491` covers a background launch acquiring the lock first, which misses this inverse ordering. The probe verifies planner admission; it did not spawn real agents.
- **Recommended action:** put one per-plan claim/release around both launch entry points, acquired before shared asynchronous launch work. Preserve background 202 responses, independent-plan concurrency, notifications, cache invalidation and release on failure. Test awaited/awaited and awaited/background orderings, not just background-first.

### PLN-002 — An arbitrary close failure still starts a replacement agent

- **Severity:** high. **Category:** error propagation / recovery safety.
- **Location:** `server/worktree-planner.mjs:952`; replacement and identity retirement follow at `server/worktree-planner.mjs:958`.
- **Consequence:** `closeLive: true` authorizes closing a live task session, but a transport timeout does not prove closure. Continue mode still starts another agent in the same checkout, then overwrites the old workspace identity. A still-running old agent can conflict with the replacement and becomes harder to recover through the stored task.
- **Evidence:** seeded a launched task with workspace `old` and a real temporary directory; inventory kept reporting `old`, close threw a transport error, and create returned `new`. Relaunch succeeded and the stored identity became `new`. `tests/goal-recovery.test.mjs:182` deliberately permits failure for the narrower “no such workspace” case; the implementation catches every error without distinguishing that case or rechecking inventory.
- **Recommended action:** treat a verified missing-workspace response as already closed; for other failures re-read authoritative inventory and refuse if closure cannot be established. Retire the old identity only after that evidence. Test missing session, transport failure, still-live session and unavailable recheck separately.

### PLN-003 — Issue lookup and goal creation are not an atomic claim

- **Severity:** high. **Category:** concurrency / idempotency.
- **Location:** `server/github-issue-sync.mjs:84` and `server/github-issue-sync.mjs:90`; analogous check-then-create sequence at `server/github-issue-planner.mjs:65`.
- **Consequence:** two requests starting one unclaimed issue can both observe an empty plan list, then each create a plan. The issue card retains one plan ID while duplicate background model rounds consume resources; later launches can duplicate work. Topic preparation also checks before starting any selected plan, with no shared claim against issue-card starts.
- **Evidence:** two concurrent `startGoal` calls with real in-memory plan rows, a temporary issue store and an asynchronous injected creator produced distinct `p1` and `p2` rows for issue 1. The HTTP route has no extra claim (`server/app.mjs:813`); draft creation always generates a new UUID (`server/worktree-planner.mjs:531`). `tests/github-issue-sync.test.mjs:228` starts with an already-existing plan and makes sequential calls, so it never tests the race. The topic variant is established by the same inspected control flow; the executed probe covered the issue-card path.
- **Recommended action:** centralize repository/issue ownership lookup and atomic reservation at plan creation, shared by issue sync and topic preparation. Retrying a request should return its existing reservation/plan. Include failed creation/release, overlapping topic/card requests and unrelated issues progressing independently.

### PLN-004 — A valid contract can require an unparseable completion report

- **Severity:** medium. **Category:** validation consistency / delivery correctness.
- **Location:** `server/delivery-contract.mjs:362`, `server/delivery-contract.mjs:380`, `server/delivery-contract.mjs:433`.
- **Consequence:** contract validation accepts verification lists that cannot fit the completion parser's 4,000-character JSON ceiling. An agent following the generated instruction exactly cannot make the branch ready, even when every requested check passed.
- **Evidence:** one otherwise-valid task with ten distinct 500-character verification strings passed `validateDeliveryContract`. Its generated `Cmux-Goal-Report` line was 5,383 characters; feeding that line to `parseCompletionReport` returned “The completion report is empty or too large.” Even omitting optional limitations cannot reduce the required ten check strings below 4,000. `tests/delivery-contract.test.mjs:90` tests only a short round trip; the oversized-brief test at `tests/delivery-contract.test.mjs:68` measures a different limit.
- **Recommended action:** make completion-report serialization part of contract readiness, or raise the parser limit to a shared, explicitly bounded maximum covering every accepted contract. Test exact-limit, limit-plus-one, quotes/backslashes and the generated-report round trip before an agent is launched.

### PLN-005 — Output saturation discards the final model result

- **Severity:** medium. **Category:** process output / error handling.
- **Location:** `server/worktree-planner.mjs:74` and `server/worktree-planner.mjs:76`.
- **Consequence:** the comment promises that old lines are dropped to retain the final result, but the implementation keeps the prefix and rejects later lines that do not fit. A verbose successful round can therefore lose its result, appear unusable and be retried, wasting the round's time and cost.
- **Evidence:** ran the actual `streamExecFile` with `maxBuffer: 64` and a Node child printing 63 `x` characters plus newline, followed by a JSON result line. The child exited successfully; returned stdout contained the prefix and no result. The same condition applies to the production 4 MiB ceiling. Existing real-child tests at `tests/worktree-planner.test.mjs:692`, `tests/worktree-planner.test.mjs:700` and `tests/worktree-planner.test.mjs:708` cover idle/ceiling behavior, not saturation.
- **Recommended action:** retain a bounded tail or explicitly retain the latest complete result envelope with an independently bounded size. Preserve progress callbacks, abort cleanup and injected executor behavior. Define and test oversized single-line handling rather than silently succeeding with incomplete output.

### PLN-006 — Event size clipping turns valid history into empty objects

- **Severity:** medium. **Category:** persistence integrity / serialization.
- **Location:** `server/worktree-plan-store.mjs:1021`; decode fallback at `server/worktree-plan-store.mjs:1289`.
- **Consequence:** slicing serialized JSON mid-value produces an invalid event. The current plan/task rows still exist, but reading the historical event silently yields `{}`, losing the evidence of the split that was stored.
- **Evidence:** eight tasks with distinct IDs/branches and 12,000 quote characters each in their prompts passed contract readiness individually. Recording that round to an in-memory store succeeded; its final `tasks` event read back with payload `{}`. JSON escaping expands the aggregate past 128 KiB even though every individual brief fits. The constant's comment at `server/worktree-plan-store.mjs:15` claims enough room for the validated maximum; the rollback test at `tests/worktree-plan-store.test.mjs:415` does not detect a successful write of invalid JSON.
- **Recommended action:** never cut serialized JSON. Preserve complete bounded payloads, or store an explicit valid summary/truncation record with a deliberate history contract. Validate serialized size (including escaping) and test a complete round/event round trip at aggregate boundaries.

### PLN-007 — Stop during a sync pass reactivates the scheduler — consolidated into GOAL-004

- **Disposition:** consolidated into GOAL-004, the canonical stop/finalizer lifecycle finding; this scheduler remains an open affected site.
- **Severity:** medium. **Category:** lifecycle / concurrency.
- **Location:** `server/github-issue-sync-scheduler.mjs:38`, `server/github-issue-sync-scheduler.mjs:45`, `server/github-issue-sync-scheduler.mjs:52`.
- **Consequence:** `stop()` clears the current timer but does not disable the in-flight pass's unconditional `finally(tick)`. When it settles, another timer is scheduled, so shutdown/detachment does not actually stop future GitHub fetches and store writes while the process remains alive. Stop/start during a pass can also leave an obsolete timer chain.
- **Evidence:** blocked the first injected pass, called stop, released it, then observed four further calls over 25 ms with a 5 ms interval. The existing stop test at `tests/github-issue-sync-scheduler.test.mjs:95` stops before the first pass fires. Concurrent manual sync is correctly deduplicated by the separate in-flight guard (`tests/github-issue-sync-scheduler.test.mjs:65`), which does not solve timer lifecycle.
- **Recommended action:** track enabled state or a start generation and check it before scheduling the next tick. Stop must invalidate old finalizers. Cover stop during successful/failed work and stop/start before old work settles.

### PLN-008 — The issue truncation test supplies output the command cannot return

- **Severity:** medium. **Category:** completeness / test fidelity.
- **Location:** `server/github-issue-sync.mjs:129` and `server/github-issue-sync.mjs:144`; test at `tests/github-issue-sync.test.mjs:292`.
- **Consequence:** fetching at most 100 issues and checking whether the response contains more than 100 can never flag a larger repository. A 101-issue backlog looks complete with 100 cards; reconciliation also removes previously stored issues that fall outside the fetched window.
- **Evidence:** an executor fake containing 101 available issues but honoring the requested `--limit` returned 100; sync reported `issueCount: 100, truncated: false`. The existing test returns 101 despite asserting elsewhere that the CLI is called with `--limit 100` (`tests/github-issue-sync.test.mjs:116`), so its green assertion does not cover the production boundary. No live GitHub request was needed to establish the contradictory limit/check.
- **Recommended action:** request 101, retain 100 and report the extra row, or use pagination/total-count evidence. Define how a partial snapshot reconciles stored cards. Make the fake honor the CLI limit; cover 99, 100 and 101 available issues and issue movement across the cutoff.

### PLN-009 — Shared decisions still contain duplicated normalization rules

- **Severity:** low. **Category:** maintainability / data shaping.
- **Location:** `server/agent-capacity.mjs:96` versus `server/worktree-planner.mjs:360`; also `server/worktree-planner.mjs:1853` versus `server/worktree-plan-store.mjs:1233`.
- **Consequence:** the capacity panel calls the dispatcher for its verdict, but independently computes the same deciding-window minimum, usable-status filtering and five-percent threshold for its availability/headroom display. A quota policy change can update the verdict while leaving the displayed explanation wrong. The identical safe-spec-options fallback also has two owners.
- **Evidence:** both headroom implementations select finite usage percentages from the 5h/weekly windows and take their minimum; both provider projections use ready/low accounts and a strict greater-than-five cutoff. The parity test at `tests/agent-capacity.test.mjs:133` covers one generous-quota sample. The safe-spec-options wrappers have the same normalize/catch/default behavior. Issue field normalization is also repeated at `server/github-issue-planner.mjs:260`, `server/github-issue-sync.mjs:191` and `server/github-issue-store.mjs:124`, although their extra provenance fields and trust boundaries differ. No current headroom divergence is claimed.
- **Recommended action:** extract a data-only quota policy helper and one safe spec-options reader, retaining strict request validation. Consider a shared issue-content projection only after preserving each boundary's validation/provenance. Keep public response shapes distinct. This is a small follow-up refactor, not justification for rewriting the 2,152-line planner class, which also owns process I/O, contracts, lifecycle, recovery and brief formatting. Any later decomposition should preserve the existing injected dependencies and explicit transaction/claim boundaries.

### Rejected or unverified claims

- **“The two stores have no atomic writes” — rejected.** SQLite transactions and JSON temp-file/rename are present. Neither proves rollback of in-memory issue mutations when saving fails, nor fsync-level crash durability. Those failure modes were not fault-injected here and are not reported as verified defects.
- **“Every storage error must fail a planner response” — rejected as a blanket claim.** `server/worktree-planner.mjs:1655` intentionally logs persistence failures while preserving a paid-for round; `tests/worktree-planner.test.mjs:1662` asserts that contract. Durable create/launch/abort failure reporting deserves separate design scrutiny, but this report does not claim that all best-effort writes should become fatal.
- **“All 200-row limits are hard storage caps” — rejected.** `server/worktree-plan-store.mjs:1105` preserves rows that still own unretired sessions/worktrees. `tests/goal-session-collector.test.mjs:39` covers old retained goals beyond the board window. Conversely, the issue claim lookups at `server/github-issue-sync.mjs:163` and `server/github-issue-planner.mjs:184` only request 200 rows. Missing ownership outside that window is a test gap, not an executed reproduction here.
- **“The active run registry has a hard 200-run ceiling” — rejected.** `server/planner-runs.mjs:38` evicts only finished runs; preserving active ownership is safer than pretending active runs ended. Global admission limits and a hard cap on events per retained plan were not established. `events()` bounds returned rows, not stored growth (`server/worktree-plan-store.mjs:873`).
- **“Missing requested rigor makes a contract unlaunchable” — rejected.** Option coverage is deliberately a warning (`server/delivery-contract.mjs:307`); `tests/delivery-contract.test.mjs:274` verifies permissive readiness. Changing this is a policy decision, not a behavior-preserving cleanup.
- **“Local regex validation is equivalent to Git branch validation” — rejected.** The planner uses a narrower preliminary check, while actual acquisition calls Git's `check-ref-format` (`server/worktree-dashboard.mjs:626`). Late invalid-name failure remains worth testing, but no shell injection or arbitrary Git execution is claimed.
- **“Browser tests prove backend idempotency” — rejected.** The issue-card Cypress test intercepts the start route (`cypress/e2e/github-issue-column.cy.ts:100`); it proves single-card UI behavior, not concurrent server requests. Likewise the source's CLI restrictions are not a live security audit of ccs or provider versions.
- **Git porcelain / low-level Git execution refactor — outside T1.** The goal assigns that implementation and its unit/Cypress edge cases to T6. No source or test code was changed and no claim is made that the refactor is delivered by this report.

## Test gaps

| Priority | Missing scenario | Closest existing coverage / proposed validation |
| --- | --- | --- |
| First | Awaited/awaited and awaited/background launches; competing task relaunches | Extend planner-background and recovery tests using barriers before external work. Assert one session owner, release after failure and independent-plan concurrency (PLN-001). Awaited answer/discussion exclusivity should be checked too: their controller map is not the background run registry. |
| First | Close fails while the old agent remains live; post-error inventory cannot be read | Split the missing-workspace fixture from transport failure in recovery tests and assert that no replacement or retirement occurs without closure evidence (PLN-002). |
| First | Simultaneous issue-card starts and overlapping topic preparation | Pair the real plan store with gated creators, then add HTTP integration coverage with the real services. A Cypress double-click check alone is insufficient (PLN-003). Also check claims outside the newest 200 plans and creation persistence failure. |
| Next | Accepted task → generated report → parsed report at the size ceiling | Add a round-trip invariant for all accepted verification-list sizes and escaping (PLN-004). |
| Next | Saturated stdout and a final result after saturation | Extend the existing local Node-child tests; cover exact buffer size, final envelope larger than the buffer and missing line terminators (PLN-005). SIGTERM-resistant children and escalation are additional unverified lifecycle boundaries. |
| Next | Aggregate escaped event JSON and historical replay | Assert nonempty, valid round/edit/launch events using eight maximum-length prompts and quote/backslash-heavy input (PLN-006). Add write/rename fault injection for issue-store memory/disk consistency and repeated event growth. |
| Next | Stop during a pass and stop/start before settlement | Use a held promise and controlled clock for both success and rejection (PLN-007). |
| Next | A fake that honors the real GitHub fetch limit | Exercise 99/100/101 issues and reconciliation at the cutoff (PLN-008). Issue analyzer retry, expiry, partial prepare failure and the eight-topic cap also merit direct boundary tests beyond the seven existing planner cases. |
| Later | Capacity/dispatcher parity across every policy boundary | Cover exactly 5%, exactly a 10-point gap, non-finite windows, unusable accounts and missing providers using the shared helper (PLN-009). Test duplicate shaping only where its contracts must agree. |
| Later | Active trace eviction, active-run admission and brief rewriting | Existing progress tests bound replay but do not combine the 64-trace cap with live listeners. Existing brief tests verify fresh private files, not concurrent writes/reads of the same brief or failed cleanup/save. No observed exploit is asserted. |

No Cypress or new unit test was added: the brief explicitly prohibits source/test changes, and this artifact has no user-visible runtime behavior to exercise. Existing Node/UI suites and isolated failure probes are the closest local validation; future behavior fixes should add the relevant deterministic local Cypress coverage under the repository policy. The requested parser/Git-runner tests, end-to-end changes and implementation refactor remain T6 work. The only owned change is this file; there are no adjacent source exceptions.

Delivery checks for this report: verify file existence; parse the coverage JSON and compare it exactly with the 15 assigned tracked paths; validate every backticked path:line citation against the referenced file; run `git diff --check`. The supplied grep verification text ends with an incomplete `||`; the executed equivalent completes it with `exit 1; done` so a missing path fails. The final commit records those outcomes. Four sibling reports and the three-report server union cannot be checked on this isolated branch and must be verified after assembly.
