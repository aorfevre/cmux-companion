# Server goal supervision and sessions review

## Summary

T7 validation update (2026-09-06): findings were checked against post-refactor commit `c89984a`; original executed probes below remain attributed to their area review. Current consolidated dispositions and verification are in [the final review](README.md). Historical branch-isolation limitations below describe the original investigation, not missing assembled reports.

Reviewed all 18 assigned modules in full (3,075 lines) at commit `444adaa059496acd27f24e75208e90bddf5cce38`, on 2026-09-05. This is the T2 area report for the combined review; it does not certify the other four area reports or implement T6's Git refactor.

The strongest existing protections are per-plan integration serialization, separate assemble/settle timers, exact pushed-head readiness checks, conservative restored-session matching, and durable retirement records. The highest-value work is to close the late-abort and stale-session-activity windows, prevent simultaneous follow-up writers, and make timer/process shutdown and recovery reliable. These are verified code/probe findings, not claims of incidents in a live installation.

Priority order: GOAL-001–003 protect active work; GOAL-004–006 restore reliable supervision and diagnostics; GOAL-007–009 improve debugging, memory bounds, and shared execution maintenance. High means a demonstrated path can launch or close an agent contrary to the lifecycle or allow competing writers. Medium means a recoverable supervision/recovery failure. Low means bounded operational impact or maintainability debt. No finding quota was used.

## Coverage

Every path below was read completely. Supporting files were read to trace callers, persistence, dependency injection, and relevant tests; those supporting reads do not claim ownership of another area's coverage.

<!-- coverage:start -->
```json
[
  "server/goal-board.mjs",
  "server/goal-followup.mjs",
  "server/goal-followup-actions.mjs",
  "server/goal-health.mjs",
  "server/goal-integrator.mjs",
  "server/goal-merge-watch.mjs",
  "server/goal-session-collector.mjs",
  "server/goal-session-reaper.mjs",
  "server/goal-watchdog.mjs",
  "server/goal-worktree-proof.mjs",
  "server/restored-goal-sessions.mjs",
  "server/task-branch.mjs",
  "server/task-association.mjs",
  "server/launch-runs.mjs",
  "server/session-name.mjs",
  "server/event-hub.mjs",
  "server/supervisor.mjs",
  "server/index.mjs"
]
```
<!-- coverage:end -->

| Reviewed behavior | Relevant existing validation identified through imports/callers |
| --- | --- |
| Board derivation, follow-up validation and launch, naming | `tests/goal-board.test.mjs`, `tests/goal-followup-actions.test.mjs`, `tests/goal-followup.test.mjs`, `tests/session-name.test.mjs` |
| Readiness, integration, waves, locks, abort, missed hooks | `tests/goal-integrator.test.mjs`, `tests/goal-recovery.test.mjs` |
| Health, watchdog, collection, recorded/restored session retirement | `tests/goal-health.test.mjs`, `tests/goal-watchdog.test.mjs`, `tests/goal-session-collector.test.mjs`, `tests/goal-session-reaper.test.mjs` |
| PR matching, exact worktree proof, recovery association | `tests/worktree-dashboard.test.mjs`, `tests/worktree-cleanup.test.mjs`, `tests/task-association.test.mjs` |
| Branch fallback, launch registry and background API lifecycle | `tests/worktree-planner.test.mjs`, `tests/planner-background.test.mjs` |
| UI presentation of cleanup, follow-ups, background launch and retry | `cypress/e2e/goal-session-cleanup.cy.ts`, `cypress/e2e/goal-board-accuracy.cy.ts`, `cypress/e2e/goal-launch-fire-and-forget.cy.ts`, `cypress/e2e/task-branch-retry.cy.ts` |
| Event process, supervisor, executable entry point | Traced production wiring in `server/app.mjs`; no directly importing tests found for these three entry/process modules. Event subprocess behavior additionally probed below. |

### Verification evidence

Local regression command:

```sh
node --test tests/goal-*.test.mjs tests/task-association.test.mjs tests/session-name.test.mjs tests/worktree-cleanup.test.mjs tests/worktree-dashboard.test.mjs tests/worktree-planner.test.mjs tests/planner-background.test.mjs
```

Initial run: 536 passed, 1 failed because the checkout lacked the declared `web-push` dependency (`tests/goal-watchdog.test.mjs:161`). Installed locked dependencies with `npm ci --ignore-scripts` and reran; final run: **537 passed, 0 failed, 0 skipped** (14.26 seconds). The missing package was an environment prerequisite, not a verified source defect.

Focused probes P1–P9 were executed against the imported modules with assertions, in local Node stdin programs. They used injected cmux/Git collaborators and an in-memory store where noted; no live agents, PRs, or repositories were modified. P6 used an actual child-process spawn of a deliberately absent executable. Probe recipes and exact observations appear with findings. The initial P1 invocation exited on an unsettled top-level await because its only timer was unreferenced; the successful rerun explicitly referenced the first timer.

This documentation-only task adds no runtime logic or user-visible behavior. Existing Node regressions and focused probes are the closest relevant local validation. Cypress was inspected, not executed; its stubbed cleanup routes explicitly test presentation rather than actual session closure (`cypress/e2e/goal-session-cleanup.cy.ts:1`). No source or test files were changed. New unit/e2e tests and the parser/runner refactor remain T6 work under the brief's allocation.

## What is good

- **Different operations do not steal each other's results.** Integrator lock keys include operation and plan, while a second map serializes all operations for that plan; completion releases only the matching promise (`server/goal-integrator.mjs:209`). Assemble and settle use different timer maps (`server/goal-integrator.mjs:119`). The held-assemble/queued-settle regression actually checks the PR query, and the task-Stop regression preserves the merge-Stop timer (`tests/goal-integrator.test.mjs:544`, `tests/goal-integrator.test.mjs:563`). Concurrent healing starts one merge (`tests/goal-integrator.test.mjs:936`).
- **Delivery is checked against Git, not an agent's assertion alone.** Clean status, ahead count, ready marker, matching remote SHA and v2 completion report validation precede readiness (`server/goal-integrator.mjs:468`). Merge instructions pin task commits (`server/goal-integrator.mjs:668`). Missing/invalid evidence remains pending (`tests/goal-integrator.test.mjs:174`, `tests/goal-integrator.test.mjs:186`); dirty, unpushed, unreadable and missing-report recovery are covered (`tests/goal-integrator.test.mjs:963`). This strength does not imply the ready-marker substring check is an exact trailer parser.
- **Retirement shares policy and records partial success.** Collection deduplicates by plan (`server/goal-session-collector.mjs:11`), and reaper calls serialize (`server/goal-session-reaper.mjs:98`). Production passes the same reaper to the collector (`server/app.mjs:133`) and watchdog (`server/app.mjs:187`). Unavailable inventory refuses closure, failed closes retry, and missing workspaces retire without repeat commands (`server/goal-session-reaper.mjs:169`, `tests/goal-session-collector.test.mjs:53`, `tests/goal-session-reaper.test.mjs:140`). GOAL-002 limits the freshness guarantee for recorded sessions.
- **Restored identities require corroboration.** Exact checkout paths and current/legacy Companion titles must yield one match; recorded follow-ups are excluded (`server/restored-goal-sessions.mjs:6`). Restored closures re-read identity and status and protect unknown/dirty activity (`server/goal-session-reaper.mjs:146`, `server/restored-goal-sessions.mjs:44`). Ambiguity, foreign paths, follow-ups and changed activity are exercised (`tests/goal-session-reaper.test.mjs:335`, `tests/goal-session-reaper.test.mjs:353`). A short title fragment alone is not used as ownership proof.
- **Destructive worktree eligibility has stronger evidence than session tidiness.** Repository common-directory identity, merged PR branch/base, exact head, and exact integrated-task trailer are checked (`server/goal-worktree-proof.mjs:18`). Real temporary Git fixtures reject an older merged PR authorizing newer commits and validate squash integration (`tests/worktree-cleanup.test.mjs:189`, `tests/worktree-cleanup.test.mjs:197`). Task reassociation repeats inspection under the workspace-launch lock (`server/task-association.mjs:56`); its real-Git test rejects dirty, active, wrong-branch, unpushed and stale-reviewed candidates (`tests/task-association.test.mjs:9`).
- **Presentation rules are pure and shared.** Board derivation gives terminal status priority and distinguishes closed PRs (`server/goal-board.mjs:27`, `tests/goal-board.test.mjs:78`, `tests/goal-board.test.mjs:94`). Follow-up actions validate before storage/side effects (`server/goal-followup-actions.mjs:58`, `tests/goal-followup.test.mjs:150`). Session titles have explicit budgets and environment stamps retain the full plan ID (`server/session-name.mjs:113`, `server/session-name.mjs:151`, `tests/session-name.test.mjs:203`, `tests/session-name.test.mjs:332`).
- **Failure-tolerant supervision has useful distinctions.** cmux read failures become unknown; unread output is not automatically a question (`server/goal-health.mjs:174`, `server/goal-health.mjs:303`, `tests/goal-health.test.mjs:168`, `tests/goal-health.test.mjs:193`). Push dedupe records only delivered notifications and prunes goals leaving the sweep (`server/goal-watchdog.mjs:107`, `tests/goal-watchdog.test.mjs:112`, `tests/goal-watchdog.test.mjs:184`). PR observations are scoped by repository and prefer stored identity over branch inference; pre-launch branch matches are rejected (`server/goal-merge-watch.mjs:124`, `tests/worktree-dashboard.test.mjs:1342`, `tests/worktree-dashboard.test.mjs:1382`).

## Findings

### GOAL-001 — High — Lifecycle / cancellation

**Location:** `server/goal-integrator.mjs:299`, `server/goal-integrator.mjs:305`, `server/goal-integrator.mjs:306`; dependent-wave equivalent at `server/goal-integrator.mjs:550` and `server/goal-integrator.mjs:575`.

**Scenario/consequence:** Abort after the final lifecycle read but while brief writing is awaited. Assembly still creates a merge workspace and records a running merge on an aborted goal. The task-wave loop similarly awaits worktree acquisition and brief writing after its per-task check. Cancellation only removes timers (`server/goal-integrator.mjs:88`); it cannot stop in-flight calls.

**Evidence:** P7 used the real in-memory `WorktreePlanStore`, two launched tasks, injected valid legacy Git evidence, and an existing integration directory. The injected `briefs.write` called `recordGoalAborted('p')` before returning. `workspaceCreate` asserted that the store was already aborted, then returned a workspace ID. Observed: `workspace created=1 board=aborted merge=running`. The store's `recordMergeLaunched` has no terminal predicate (`server/worktree-plan-store.mjs:426`). Existing abort tests cover the earlier worktree-create boundary and an abort before settle, not this brief-write boundary (`tests/goal-integrator.test.mjs:891`, `tests/goal-integrator.test.mjs:903`). The wave variant is traced, not separately executed.

**Action:** Recheck lifecycle after awaited preparation immediately before launch/resume, serialize terminal transitions with launch reservation, and define compensation for an abort arriving during the cmux create itself. Keep already-created workspace identity recoverable. Add deferred-brief, deferred-create and per-wave cancellation regressions.

### GOAL-002 — High — Session safety / concurrency

**Location:** `server/goal-session-reaper.mjs:113`, `server/goal-session-reaper.mjs:118`, `server/goal-session-reaper.mjs:173`.

**Scenario/consequence:** A pass computes all recorded-session close candidates from one inventory. While an earlier close awaits cmux, a later workspace can resume work or ask for input. It is still closed without reading its current status. The reaper's queue protects competing reaper calls, not agent activity.

**Evidence:** P5 supplied a merged plan owning workspaces A and B, both idle in the initial list. Closing A changed B's simulated activity to running. The injected `workspaceStatus` would return that fresh state, but it was never called. Observed: B closed while running; `fresh status reads=0`. The restored-session branch already performs a fresh status check (`server/goal-session-reaper.mjs:154`), so this is a verified asymmetry rather than a claim that all cleanup lacks protection. Existing running-agent coverage sets the activity before the initial inventory (`tests/goal-session-reaper.test.mjs:155`).

**Action:** Re-read recorded ownership/lifecycle and fresh status before each close, refuse unknown status, and coordinate with local relaunch/workspace operations. A last-moment external cmux change may still require an atomic cmux close-if-idle contract; do not claim a preflight eliminates that residual window.

### GOAL-003 — High — Concurrent follow-up launch / identity

**Location:** `server/goal-followup.mjs:26`, `server/goal-followup.mjs:49`, `server/goal-followup.mjs:58`.

**Scenario/consequence:** Two simultaneous requests read the same follow-up count, choose the same brief ID and open two agents in the same delivery checkout. Different requests can overwrite each other's brief; both agents can edit/commit the same files. The only competing-writer check examines the merge agent, not existing or pending follow-ups.

**Evidence:** P2 invoked `Promise.all` on `launch('probe', {actions:['tests']})` and `launch('probe', {actions:['review']})` with independent store snapshots. Observed brief IDs: `["followup-1","followup-1"]`, sessions: `2`. Production writes directly to the deterministic plan/task filename (`server/agent-brief.mjs:37`), and the API delegates directly without a launch lock (`server/app.mjs:704`). The distinct-brief test awaits the launches sequentially (`tests/goal-followup.test.mjs:139`).

**Action:** Allocate unique durable follow-up IDs before writing briefs and guard checkout writers with a per-worktree reservation plus a live-follow-up policy. Serializing creation alone does not stop the first agent still working when the second is created. Revalidate lifecycle after awaited preparation.

### GOAL-004 — Medium — Shutdown / timer lifecycle

**Canonical disposition:** open; also owns the same stop/finalizer defect in the issue scheduler (PLN-007, [planning report](server-planning.md)). Both sites remain acceptance targets; they count once in the final canonical totals.

**Location:** `server/goal-watchdog.mjs:60`, `server/goal-watchdog.mjs:66`, `server/goal-watchdog.mjs:73`.

**Scenario/consequence:** `stop()` during an in-flight `check()` clears the old timer; the check's unconditional `finally(tick)` arms a new one afterward. App closure can therefore leave a watchdog running against resources already closed (`server/app.mjs:1100`). This does not prove the standalone executable stays alive, since its stop handler exits the process (`server/index.mjs:47`).

**Evidence:** P1 held `health.sweep()` on a deferred promise, started the watchdog, explicitly referenced its initial unref timer, waited until sweep entered, called `stop()`, released the sweep, and waited 5 ms. Asserted that `watchdog.timer` was non-null again; then stopped it for cleanup. Existing timer coverage stops between fast sweeps (`tests/goal-watchdog.test.mjs:203`).

**Action:** Use an active flag/generation checked before scheduling, make stop idempotent, and expose an awaitable drain for active work before closing the store. Test stop during success/failure, stop-start overlap and repeated detach.

### GOAL-005 — Medium — Event subprocess recovery

**Location:** `server/event-hub.mjs:50`, `server/event-hub.mjs:51`.

**Scenario/consequence:** Spawn failure (for example an unavailable cmux binary) emits `error` and `close`, but no `exit`. The error handler only emits disconnected state. The failed child stays in `this.process`, preventing a subsequent `start()` and scheduling no retry, even with active consumers. Event-driven Stop handling remains unavailable until consumers fully detach/restart the hub.

**Evidence:** P6 created a real `CmuxEventHub` with `bin:'/definitely-missing-t2-cmux'` and a 1 ms retry delay, attached a state listener, added one consumer and waited 40 ms. Assertions: exactly one spawn error, retained process object, null retry timer. It then removed the consumer. The executable was deliberately absent; no live cmux was contacted.

**Action:** Share idempotent child finalization for spawn error/close and normal termination. Clear only the matching current child and retry only while consumers remain. Drain or explicitly ignore stderr (`server/event-hub.mjs:32`) and isolate JSON parse failure from subscriber exceptions (`server/event-hub.mjs:43`) during this refactor; pipe saturation/subscriber failure were inspected concerns, not executed findings here.

### GOAL-006 — Medium — Recovery classification / swallowed GitHub errors

**Location:** `server/goal-integrator.mjs:422`, `server/goal-integrator.mjs:390`.

**Scenario/consequence:** Authentication/network/timeout failure while checking the merge PR is treated exactly like confirmed PR absence. Settle persists “stopped without opening a pull request,” blocking a goal whose PR may actually exist. Healing deliberately does not retry such permanent-looking blocked errors (`server/goal-integrator.mjs:161`); later independent merge reconciliation may recover it, but its availability is not guaranteed.

**Evidence:** P8 settled a running plan with no remaining task integration checks and injected an executor rejecting with `Error('authentication unavailable')`, code 42. The call resolved to blocked with “The merge agent stopped without opening a pull request…” rather than preserving uncertainty. JSON parsing also returns null on malformed output (`server/goal-integrator.mjs:771`). Existing tests cover PR present/absent (`tests/goal-integrator.test.mjs:375`, `tests/goal-integrator.test.mjs:386`). RepoCatalog already distinguishes known no-PR diagnostics from unavailable GitHub (`server/repo-catalog.mjs:301`).

**Action:** Return a typed observed/absent/unavailable outcome, preserve diagnostic context, and leave transient/unavailable observations eligible for bounded retries. Test unauthorized, timeout, malformed JSON, confirmed absence and later recovery.

### GOAL-007 — Low — Error context / maintainability

**Location:** `server/goal-integrator.mjs:334`, `server/goal-integrator.mjs:343`, `server/goal-integrator.mjs:799`.

**Scenario/consequence:** Guarded Git or worktree failure is reduced to a display string and replaced with a new TypeError. Callers/loggers lose the original stack, code, stderr object and typed worktree reason. Recovery currently recognizes a temporary lock by prose, which becomes harder to stabilize when structured metadata has been removed.

**Evidence:** P9 injected a Git error with code `EIO` and stderr `git failed` during assembly. The rejection retained the concise message, but both `cause` and `code` were undefined. The guard does not log the original error before replacing it. Task acquisition already demonstrates cause-preserving wrapping for frozen errors (`server/task-branch.mjs:178`). Existing failure tests check persisted state/message (`tests/goal-integrator.test.mjs:602`), not original cause retention.

**Action:** Preserve the concise public message and attach the original cause plus explicit retry classification; log structured context at the boundary. Split the long assembly workflow (`server/goal-integrator.mjs:225`) into preparation, guarded launch and publication stages only after regression coverage fixes the behavior contract. Avoid a broad rewrite of its queue/dependency-injection boundaries.

### GOAL-008 — Low — Memory retention

**Location:** `server/goal-health.mjs:35`, `server/goal-health.mjs:279`, `server/goal-health.mjs:289`.

**Scenario/consequence:** The screen cache's age check controls reuse but never removes old surface IDs. A long-lived process accumulates entries for every quiet terminal inspected, including closed/replaced sessions. This is unbounded in session churn, not in the size of any one screen (only the classified value is retained).

**Evidence:** P4 swept one launched workspace 25 times, changing its terminal surface ID each time; `readScreen` returned empty text. Observed `screenStateCache.size === 25` with only one current workspace. Full-module read found no deletion/clear path. By contrast, watchdog alert entries and integrator locks explicitly prune (`server/goal-watchdog.mjs:117`, `server/goal-integrator.mjs:218`).

**Action:** Evict entries for absent surfaces and add a bounded size/TTL policy compatible with single-plan inspect calls. Test clock advance, surface replacement, failed reads, overlapping inspect/sweep and active-entry reuse.

### GOAL-009 — Low — Duplicated low-level Git setup — open residual

**Location:** `server/task-association.mjs:7`, `server/task-association.mjs:8`; canonical runner at `server/worktree-operations.mjs:12`.

**Scenario/consequence:** Task association still owns a separate execFile/promisify Git wrapper (30 seconds, 1 MiB, trimmed stdout), so low-level invocation maintenance has one remaining independent site.

**Evidence:** T7 source comparison confirms that wrapper remains unchanged. The overlapping inventory/catalog/launch setup and inventory/dashboard parser claims are consolidated into canonical PLAT-007 and resolved by T6. Catalog still owns its semaphore and injected executor at `server/repo-catalog.mjs:310`; integrator delegates Git there at `server/goal-integrator.mjs:612` and separately executes gh at `server/goal-integrator.mjs:616`.

**Action:** Optionally migrate association onto runGit while preserving its timeout, buffer, stdout trimming and original rejection; retain `tests/task-association.test.mjs:9`. This residual was outside T6’s three execution sites. Do not count the delivered parser/runner duplication again as open.

### Rejected or unverified claims

- **Rejected: assemble and settle share a lock/timer key and lose the settle.** Operation-specific locks, per-plan chains, separate timer maps and the executed regressions above contradict that claim.
- **Rejected: watchdog and integrator always use independent cleanup locks.** Production shares one reaper through the collector and watchdog; calls serialize. Independently constructed/injected reapers can differ, but that is not evidence of a default production race.
- **Rejected: every swallowed error is a defect.** Unknown Git worktree proof preserves disk data (`server/goal-worktree-proof.mjs:36`), presentation failure cannot roll back committed delivery (`server/goal-integrator.mjs:431`), and a missing workspace is correctly retired. GOAL-006 concerns a specific destructive classification of uncertainty.
- **Rejected: retired CLOSED-PR original sessions are accidentally treated as completed.** That is an explicit policy with a passing regression (`tests/goal-session-collector.test.mjs:53`). Health deliberately treats the closed goal as development again. Product consistency may deserve discussion, but the policy alone is not a proven defect.
- **Limited probe P3:** An injected detailed inventory returning `{}` yields `sessionsAvailable:true` and a dead task (`server/goal-health.mjs:239`). Reaper rejects malformed inventory (`server/goal-session-reaper.mjs:232`). Production CmuxClient normalizes a missing workspaces field to an empty list before health sees it (`server/cmux-client.mjs:134`); this review did not reproduce a malformed response from live cmux. Keep a boundary-validation test gap, not an assertion of a real cmux incident.
- **Unverified operational impact:** LaunchRuns evicts its oldest entry at 200 (`server/launch-runs.mjs:29`), potentially losing an active admission marker. Existing tests cover ordinary admission/release (`tests/worktree-planner.test.mjs:2061`); no 201-live-launch end-to-end scenario was exercised. Do not claim demonstrated duplicate task creation.
- **No blanket memory-leak claim:** Follow-up history is durable and intentionally accumulative (`server/worktree-plan-store.mjs:445`); retention/archival requirements are unspecified. GOAL-008 concerns a disposable cache with a directly observed missing eviction policy.
- **Unverified process cases:** Supervisor waits have no per-fetch timeout (`server/supervisor.mjs:25`), and its post-start child-exit handler only stops on selected abnormal exits (`server/supervisor.mjs:50`). No hung-HTTP, clean frontend-exit, shutdown-signal or listen-failure probe was run; retain these as test gaps rather than confirmed production failures.

## Test gaps

| Priority | Missing edge/recovery case | Closest current coverage and next validation |
| --- | --- | --- |
| High | Abort during brief write, wave acquisition, cmux create, or resume | Earlier abort boundaries pass; use deferred dependencies plus real in-memory store for GOAL-001, then local UI abort regression when implementing. |
| High | Recorded session changes activity/identity after candidate selection | Current recorded-session tests use initial activity; add held-close/fresh-status probes and concurrent relaunch with shared reaper for GOAL-002. |
| High | Simultaneous and still-running follow-ups; allocation and persistence failure | Sequential brief-identity test misses the overlap; add concurrent API test and UI duplicate-submit coverage for GOAL-003. |
| Medium | Stop while a sweep is pending; start-stop-start; store close while operations drain | Current watchdog stop test does not hold work. Add deferred-success/failure tests and buildApp shutdown integration. |
| Medium | Event child spawn error, normal exit, stale child exit, consumer detach and stderr backpressure | P6 proves spawn recovery gap; use injected child streams plus one absent-executable subprocess test. |
| Medium | gh unavailable versus absent; transient retry; malformed PR output | Current present/absent tests do not distinguish observation failure; add executor error variants and recovery transition assertions. |
| Low | Original error cause and typed reason; health-cache eviction; malformed inventories | P3/P4/P9 cover narrow probes, not committed regression tests. Add targeted backend tests when changing those contracts. |
| Low | Registry capacity, missing activity timestamps, post-restart follow-up retention | Define intended capacity/unknown-state policy before asserting desired behavior. Health currently treats absent activity time as zero quiet duration (`server/goal-health.mjs:195`). |
| Medium | Supervisor startup hang, clean/abnormal frontend exits, repeated signals; entrypoint listen failure cleanup | No direct importing tests found; use isolated subprocesses with temporary ports and fake frontend, without starting real agents. |
| Refactor | Parser framing/record types, marker reasons, unknown fields; runner options, environment, output and failures | T6 owns direct tests, behavior-preserving adapters and final touched-code review. Preserve existing cleanup, dashboard, catalog and association regressions; Cypress can observe branch/lock presentation but not raw porcelain framing. |

The Cypress files identified in Coverage primarily supply intercepted API fixtures. They are useful UI contracts, not evidence that real watchdog/reaper/integrator interleavings are safe. Full five-report existence, T1–T5 coverage union against tracked server files, and combined delivery/refactor verification remain assembly-level checks. This report's owned-file existence, exact 18-path coverage and citation validity are checked locally before commit.

Local document verification: the coverage block matches all 18 assigned tracked paths exactly; all required sections and all backticked path:line citations pass validation. The other four reports are absent in this isolated T2 checkout, so the five-report/server-union AC-1 assembly check cannot yet pass here. The brief’s supplied shell coverage command is truncated after `grep`; the executed equivalent below completes the intended membership check.

```sh
test -f docs/code-review/server-goals.md
for p in server/goal-board.mjs server/goal-followup.mjs server/goal-followup-actions.mjs server/goal-health.mjs server/goal-integrator.mjs server/goal-merge-watch.mjs server/goal-session-collector.mjs server/goal-session-reaper.mjs server/goal-watchdog.mjs server/goal-worktree-proof.mjs server/restored-goal-sessions.mjs server/task-branch.mjs server/task-association.mjs server/launch-runs.mjs server/session-name.mjs server/event-hub.mjs server/supervisor.mjs server/index.mjs; do
  grep -Fq "$p" docs/code-review/server-goals.md || exit 1
done
```
