# Additional full xclaude Fable PR review

This is the native reviewer's report, not yet a confirmation of every finding.
It began on `5de0b86`; focused fixes landed in `f2fef6e` while it ran.
Every finding must be checked against the current source and the design contract.
No commands or tests were run by this reviewer.

I've finished reading the core scheduler, domain, storage, adapters, cutover, cleanup and the test suites. Writing up the review now.

# Review of PR #115 (head `5de0b86`, base `54bfaa7`)

Scope reviewed: AGENTS.md, spec, plan, implementation report, architecture/retirement/recovery docs, and the full source of `server/orchestration/` (domain, service, scheduler, reconciler, coordinators, storage, Git/GitHub/verification/native-background adapters, cutover, cleanup, routes, bridge auth, runtime composition), plus the orchestration test suites and fixtures. I read the code and the tests; I did not run anything. Intentional legacy retirement is not flagged.

## Confirmed defects

### P1-1. Publication dead-ends whenever the local base branch is not exactly at the remote head, and nothing can recover it
- **Where:** `server/orchestration/create-runtime.mjs:64-67` (configuration reports the *local* `refs/heads/<baseBranch>` as `baseSha`), `server/orchestration/adapters/github.mjs:68` (`target_moved` when remote base head ≠ `input.baseSha`), `server/orchestration/domain/transitions.mjs:489-491` (`request_publication` pins `goal.baseSha` from goal creation), `server/orchestration/publication-coordinator.mjs:55-64`, `server/orchestration/domain/scheduling.mjs:10`, `server/orchestration/domain/action-view.mjs`.
- **Trigger:** Any real repository where the local default branch is behind or ahead of `origin/<base>` at goal creation (very common), or where the remote moves during the multi-hour build. The whole A/B/C/review/verify journey completes, then `observe()` returns `target_moved` on every tick.
- **Consequence:** Goal sits in `ready_to_publish`; `readyWork` returns nothing; `request_revision`/`publish_contract` are refused (`!goal.publication`), no user command exists to renew the base, rebase, or re-plan. The only exit is `abort`. Spec §Scheduling says updating the integration result “requires renewed review and verification”, implying a path; none exists. The coordinator also re-runs `git ls-remote` ×2 + `gh api` every 2.5 s forever.
- **Evidence:** tests `orchestration-publication.test.mjs:60-67` assert `target_moved` but never a recovery; all delivery/Cypress journeys use a local bare remote kept in sync with the fixture’s `main`, so the divergence case is never exercised.
- **Fix direction:** Report remote head in `/configuration` (or fetch base from the configured remote at `create_goal`), and add an explicit user command (e.g. `renew_base`) that cancels the pending publication intent, records the new base, and returns the goal to `building` with cleared final review/verification so the integration ref can be rebased/re-integrated under renewed evidence. Add a test with local `main` behind the remote.

### P1-2. “Uncertain” workers and verification runs have no operator resolution; they leak capacity forever and deadlock verification globally
- **Where:** `server/orchestration/domain/commands.mjs:8` (no user command touches `workerState`), `server/orchestration/domain/transitions.mjs:308-335, 368-375, 213-218, 438-443` (`retry_attempt`, `approve`, `retry_verification` all require stopped workers), `server/orchestration/verification-coordinator.mjs:64-66` (any goal with an `unknown` run blocks verification for **all** goals), `server/orchestration/adapters/native-background.mjs:180` (dead group without `outcome.json` → `unknown`, permanently), `server/orchestration/reconciler.mjs:46-48`, `server/orchestration/cleanup.mjs:20`, `server/orchestration/cutover.mjs:111`, `server/orchestration/storage/store.mjs:161-165` (capacity counts every non-stopped attempt across all goals, including aborted ones).
- **Trigger:** Supervisor SIGKILL / reboot before `outcome.json`; service crash mid-verification (see P2-6); adapter `observe` throwing. All produce `workerState: 'unknown'` that no later observation can convert to `stopped`.
- **Consequence:** Global background slots are permanently consumed (4 such events exhaust the default `global: 4` for every goal); one uncertain verification run blocks verification for every goal forever, even after the owning goal is aborted (`cancel_verification` requires `pending`); `approve` on a revised contract is blocked by a stale-generation unknown worker; cleanup and rollback are refused. Spec §User journey step 8 requires “an explicit recovery action”.
- **Evidence:** `tests/orchestration-scheduler.test.mjs:326-337, 379-390` and `tests/orchestration-verification.test.mjs:72-80` prove the block but no test demonstrates any resolution, because there is none.
- **Fix direction:** Add a user-authority command (e.g. `confirm_worker_stopped { attemptId | verification operationId, evidence }`) that records operator-confirmed termination as `stopped` with the reason preserved, gated on the adapter reporting `unknown`/dead group; surface it in `actionView`; scope the verification global gate to non-terminal goals; add fault-matrix cases that resolve uncertainty and then reuse capacity.

### P1-3. Integration `failed` is a terminal state with no retry; any Git `DomainError` bricks the goal
- **Where:** `server/orchestration/scheduler.mjs:119-122` (every `DomainError` from `integrate()` → `record_integration_failure`), `server/orchestration/domain/transitions.mjs:401-406` (`state='failed'`; nothing ever clears it except `record_integration` which the scheduler never re-issues for `failed`), `scheduler.mjs:107` (only `state === 'applying'` is retried), `server/orchestration/domain/scheduling.mjs:25-28` (no integrator readiness for `failed`), `server/orchestration/adapters/git.mjs:18` (`GIT_OPERATION_FAILED` is a `DomainError`, thrown on the 30 s timeout, index.lock contention, etc.), `transitions.mjs:185,199` (`request_revision`/`publish_contract` refused while `goal.integration` exists).
- **Trigger:** A transient Git failure (timeout, lock, `merge-tree` unsupported, see P2-8) during any task integration or conflict-repair application.
- **Consequence:** Task stays `accepted`, integration stays `failed`, verification/publication blocked, revision blocked; only `abort` is possible after possibly hours of agent work. Same outcome for `integration-repairs.mjs:49-52`, where additionally the `integrate_repair` operation stays `dispatching` and the result stays `pending` forever.
- **Evidence:** `tests/orchestration-scheduler.test.mjs:158-185` (scenario `failure`) asserts only that the state is `failed`; no test retries or recovers.
- **Fix direction:** Add a user `retry_integration` command (or automatic bounded retry for `GIT_OPERATION_FAILED`) that resets `state` to `applying` (or `repairing`) after `observeIntegration` proves nothing was applied; expose in `actionView`; test transient-failure → retry → integrated with exactly one applied commit.

### P2-4. Aborted goals with an unresolved conflict or an unsent repair effect keep `integrate`/`integrate_repair` operations open forever, blocking cleanup and rollback
- **Where:** `server/orchestration/scheduler.mjs:81-93` (a `dispatching` integrate intent in `conflict`/`failed` state only completes when `integrationResults` gains its id), `server/orchestration/integration-repairs.mjs:24-42` (a `dispatching` effect whose `observeRepair` is `pending` on an unauthorized goal is skipped, never cancelled), `server/orchestration/cleanup.mjs:21`, `server/orchestration/cutover.mjs:112`.
- **Trigger:** Abort after a recorded conflict (the common “give up on this conflict” case) or crash between `advanceOperation(pending→dispatching)` and `acceptRepair`.
- **Consequence:** `operations()` never empties for that goal → cleanup refuses every worktree of the goal; `assertRollback` refuses (“Replacement effects remain unsettled”) for the whole database.
- **Fix direction:** `git-integration.mjs` writes the proposal/manifest before any ref mutation, so `observeIntegration`/`observeRepair` returning `pending` on a terminal goal is proof of no external effect; complete/cancel those intents in that case (mirror the `pending_abort` path). Add cleanup/rollback tests for an aborted goal that was in `conflict`.

### P2-5. Publication sent-markers are claimed before purely local failures, converting certain non-sends into permanent `unknown`
- **Where:** `server/orchestration/adapters/github.mjs:83-88` (`push.sent.json` claimed, then `remote.push` runs `pack-objects`, `renameSync`, `cat-file` locally before the network push), `github.mjs:96-98` (`pr.sent.json` claimed, then `gh` spawn may fail with ENOENT/config error), `server/orchestration/adapters/git-remote.mjs:69-81`, `github.mjs:65-67` (marker present + missing remote branch/PR → `unknown`).
- **Trigger:** `pack-objects` exceeding the 30 s timeout on a large history, `gh` not installed/authenticated, staging dir I/O error.
- **Consequence:** Retries skip the push (`pushPath` exists) and observe `head === null` → `unknown` forever; no command retries. Only `abort`.
- **Evidence:** `tests/orchestration-publication.test.mjs:39-47` covers failpoints only at the marker boundaries, not a failure inside the local staging steps.
- **Fix direction:** Stage the pack and verify `cat-file` before claiming `push.sent.json`; claim immediately before the `git push`/`gh api POST` spawn; treat spawn-level ENOENT as not-sent. Add a test where `pack-objects` fails after the claim.

### P2-6. Verification checks run under the service process, not the independent supervisor; a service crash orphans an unbounded child and produces the P1-2 global deadlock
- **Where:** `server/orchestration/adapters/verification.mjs:79-83` calls `startBackgroundProcess` (`server/orchestration/adapters/agent-runtime.mjs:35`, `detached: true`, timers in-process). Contrast with `native-background.mjs` which was moved to a separate supervisor precisely for this (report §T11).
- **Trigger:** SIGKILL/crash of the service while a repository check runs.
- **Consequence:** The detached check keeps running with no ceiling/idle/output limit (a watch-mode test runs forever); on restart `receipt()` is null → `verification_uncertain` → global verification block with no exit.
- **Fix direction:** Run checks through the same durable supervisor (worker JSON, identity stamp, outcome receipt) so restart can observe stopped/running; at minimum add a supervisor-style identity+stamp so `observe` can prove termination.

### P2-7. Scheduler ownership relies on PID-only liveness; after a reboot or PID reuse, startup is refused with no documented remedy
- **Where:** `server/orchestration/storage/ownership.mjs:8-11, 32` (`process.kill(pid,0)`: reused PID → `alive`, other-user PID → EPERM → `unknown`; both refuse), `server/orchestration/cutover.mjs:109` (same for rollback), `docs/orchestration-retirement.md:76-77` (“Do not delete repository ownership databases … to bypass a refusal”).
- **Trigger:** Crash/power loss, then reboot; the LaunchAgent’s old low PID is now owned by another daemon.
- **Consequence:** `OWNERSHIP_UNCERTAIN` at every start; operator has no sanctioned procedure. The native adapters already solve this with birth-time + command stamps (`native-process.mjs:11-17`).
- **Fix direction:** Record `{pid, startTime/stamp, hostBootId}` in `scheduler_owner` and compare the stamp; document an explicit force-takeover command that requires the stamp mismatch.

### P2-8. Minimum Git version is neither probed nor documented; `merge-tree --merge-base` needs Git ≥ 2.40
- **Where:** `server/orchestration/adapters/git-integration.mjs:75`; `git.mjs:14` uses whatever `git` is on `PATH`. No `git --version` check anywhere; README/docs have no Git requirement (grep empty).
- **Trigger:** Stock Apple Git (2.39.x) first on `PATH`.
- **Consequence:** Every task integration fails with `GIT_OPERATION_FAILED` → P1-3 dead end, with an opaque message.
- **Fix direction:** Probe `git --version` in production composition (like `native-capabilities.mjs`), pin the executable path in config, document the requirement.

### P2-9. Native background watcher spawns `/bin/ps` every 20 ms per worker
- **Where:** `server/orchestration/adapters/native-background.mjs:130-138` (loop: `nativeGroupState` + `await nativeProcessStamp` (execFile ps) + 20 ms sleep, for up to `ceilingMs`), also `close()` at `:211-216` via `observe`.
- **Consequence:** ~50 process spawns/second per active worker (~90k over a 30-minute ceiling); under load `ps` can time out/return null → `OWNERSHIP_UNCERTAIN` thrown from `watch`, ending the watcher early (delivery then depends on later reconciliation). CPU/thermal cost on a laptop with 4 workers is significant.
- **Fix direction:** Poll at ~1–2 s with `fs.watch` on the outcome path, or stamp-check only every N iterations.

### P3-10. An unexpected `DomainError` in the read-only integration loop starves the whole scheduler
- **Where:** `server/orchestration/scheduler.mjs:81-93` – `record()` errors are not caught; `pass()` throws before agent admission (`:58`) every tick. The withdrawn-repository fix (`:98`) shows this class was already hit once.
- **Fix direction:** Wrap per-operation work in try/catch with `onError`, as done for launch dispatch.

### P3-11. Authenticated agents can create unbounded pending results/artifacts
- **Where:** `server/orchestration/agent-results.mjs:36-49` (each distinct `id` writes a ≤2 MiB artifact and appends to `goal.results`), `routes.mjs:126-139`.
- **Consequence:** Disk exhaustion and goal-state growth by a misbehaving worker while it is `running`; only `result.status` checks prevent lifecycle impact.
- **Fix direction:** Limit to one pending result per attempt and a small total per attempt; reject extra ids with `IDEMPOTENCY_CONFLICT`.

### P3-12. `BridgeAuthority.revoke` is dead code
- **Where:** `server/orchestration/bridge-auth.mjs:84`; no callers. Revocation works only implicitly via generation/status checks. Either wire it into `abort`/`request_revision` or delete it so the “tokens are revocable” claim matches code.

## Questions / design concerns (not confirmed defects)

- **Ownership DB inside the user’s `.git`**: `cutover.mjs:85` creates `companion-orchestration-owner.sqlite` (+WAL/SHM) in the repository common dir. AGENTS.md says not to touch unrelated user state; is writing into `.git` acceptable to the user?
- **Repair implementers restart from the integration head**: `transitions.mjs:233,270` give a `repair_required` task a fresh attempt at `goal.integrationHead`, not at the prior candidate branch, and the native implementer has no shell to cherry-pick. Work is redone from scratch each repair; the budget of 2 is consumed by full re-implementations. Intentional?
- **`record_merged` is unreachable** (no caller), and `cleanup.eligible` excludes `merged`. If GitHub observation is added later, cleanup will refuse merged goals.
- **Planner self-termination**: `publish_contract` by the planner creates a terminate intent for its own conversation (`transitions.mjs:201-204`); a revision then gets a fresh conversation, while the spec says interactive planning “preserves conversation identity”. Confirm this is the intended model.

## Test and fixture assessment

Strong: real SQLite/Git SIGKILL matrices, concurrent admission, exact-target review, publication reconciliation, cutover separation. Missing meaningful coverage:

- Local base ≠ remote base at publication (P1-1) and any recovery from `target_moved`.
- Recovery from integration `failed` (P1-3) and from unsettled intents on aborted goals (P2-4).
- Any resolution of `unknown` workers/verification runs (P1-2); the fault matrix only proves they stay blocked.
- Local-only failure after a sent-marker claim (P2-5).
- Service crash during a running verification check followed by a recovery, not just `OWNERSHIP_UNCERTAIN`.
- Git version gating (P2-8).
- The checked-in test repository (`tests/fixtures/orchestration-repo`) is adequate for A/B/C, conflict and failing-check variants; it does not exercise a base branch that diverges from the remote.

## Limits of this review

I did not read `event-stream.mjs`, `agent-mcp.mjs`, `agent-tool-hook.mjs`, `native-terminal*.mjs`, `native-inputs.mjs`, the UI components beyond `goal-detail.tsx`/`action-view`, or the Cypress spec in depth. Live provider enforcement, cmux continuity and installed cutover are documented as unverified and were not assessed. No tests or commands were run.

## Remediation checkpoint (uncommitted work, 2026-09-11)

The full review and a separate Fable recovery triage have completed. Claims below
are evaluated against source rather than accepted solely from reviewer prose.

- P1-1: explicit moved-target acceptance is implemented; original publication
  identity and exact reviewed/verified integration head remain immutable.
- P1-2/P2-6: verification now uses the independent native watchdog. A real service
  SIGKILL test proves its ceiling survives and restart observes stopped failure
  without launching remaining checks. Kernel boot identity supplies stronger
  recovery proof for uncertain native/verification workers after a reboot.
  Operator assertions and dead original groups are deliberately insufficient;
  escaped descendants and aborted goals continue to count against capacity.
- P1-3/P2-4: explicit retry and terminal-effect reconciliation have regression
  coverage. Normal recorded conflicts already completed their intents; the defect
  concerned crash windows, failures, and unsent repair effects. Additional Git
  subprocess tracking now ensures a pending observation cannot conceal a
  surviving ref mutation after service SIGKILL.
- P2-5: sent claims moved into adapters after preparation. Actual pack failure,
  cancellation during preparation, and Git/gh spawn-not-started failures now have
  regressions. Missing gh/auth usually fails the earlier GET before any marker;
  arbitrary CLI exits/timeouts remain uncertain, not retry permissions.
- P2-7: boot/process birth evidence strengthens scheduler ownership and rollback
  observations. Missing identity still refuses takeover.
- P2-8: actual required Git options are probed before production ownership/native
  creation; Git 2.40+ capability requirement documented. 17 bounded checks passed.
- P2-9: watcher polling reduced from 20ms to one second; watchdog limits unchanged.
- P3-10: a DomainError from one integration observation preserves that intent and
  reports the error while unrelated admission proceeds; loss of scheduler ownership
  still stops the pass. Regression passed.
- P3-11: one outstanding result per attempt and eight retained submissions maximum;
  raw-size/replay/capacity checks precede artifact writes and repeat inside domain
  transactions. Legacy duplicate-result repair coverage remains explicitly seeded.
- P3-12: not a lifecycle/security defect. `authenticate` revalidates generation,
  revision and attempt state, while `receiptAuthority` rejects terminal goals;
  explicit `revoke` separately supports credential revocation. It is not claimed
  as the mechanism used by abort/revision, so no cosmetic deletion is needed.

Remaining review questions: repository `.git` metadata is confined to explicitly
configured repository ownership; repair attempts deliberately use the integration
checkpoint with prior findings/candidate evidence; external merge observation is
not implemented (`record_merged` is a future system transition); planner identity
is stable within an attempt/restart while a new scope generation creates a fresh
attempt. These are distinct from the confirmed recovery bugs above.

Checkpoint tests: publication 23/23; scheduler 62/62; supervisor/ownership/native
30/30 including real verification service SIGKILL. Full final gates and independent
post-fix review remain pending. No installed/live rollout was exercised.


The late-Git-child concern is now covered by a real service SIGKILL regression:
both normal integration and repair observations remain unknown while the detached
Git child can still mutate, then reconcile once its group is stopped. Git commands
use a durable scope owner and per-command sent/identity/completion records, with
bounded tracked `spawn` rather than `execFile` (which does not forward `detached`).
A command-started/no-PID gap requires stronger boot evidence, not an elapsed timer.
Four new Git process regressions pass; combined Git/integration suite: 43 passed,
one platform skip. Background GC/maintenance is disabled in local Git policy.

Moved-target coverage: publication 27/27, scheduler 65/65, delivery 5/5, UI 7/7,
and writable real-service Cypress 2/2. The full delivery matrix includes a remote
already ahead of the local base before goal creation. Original request/base/head
are immutable; acceptance is an append-only exact-target record. Missing remote
branches continue observation so restoration remains recoverable. Cypress used
an alternate free port (3287) because 3221 was occupied; its owner was untouched.

Two bounded native Fable post-fix reviews are running: supervision/identity and
publication/integration recovery. Full final verify/coverage results follow.


The first full recovery verify run reported 656 passed, one platform skip and ten
failures. Investigation found three race fixtures submitting a now-forbidden
second outstanding result for the same attempt, and seven publication crash
fixtures whose wrappers dropped the new beforeSend options. The race tests now
use a concurrent sibling implementer's inbox mutation; they retain version-race,
stopped-worker and exact-once candidate assertions. Publication wrappers forward
options and preserve all real SIGKILL boundaries/assertions (17/17 fault tests
passed afterward). No runtime guard or crash assertion was weakened to pass.
UI coverage passed at 96.10% lines. Final complete verify and backend coverage
are rerun after these fixture corrections.

## Supervision follow-up findings and fixes

The first bounded Fable supervision review found two medium correctness issues:
boot recovery checked boot identity before reading durable successful agent/check
output. Both adapters now process existing outcomes first, then apply boot proof
to missing/uncertain termination. Real successful native/check outcomes combined
with a simulated later boot have regressions; delivery remains idempotent.

Two low findings were addressed: the new supervisor protocol records an exclusive
sent claim immediately before spawn (an absent claim proves a prepared request was
not sent), and legacy post-boot evidence records OWNERSHIP_UNCERTAIN rather than
claiming a recorded launch never started. Spawn-not-started failures produce a
stopped failure receipt. Missing supervisor directories remain uncertain; existing
cleanup retains those directories and refuses unsettled effects.

The two sent-claim fixtures initially used a macOS `/var` alias and correctly hit
the canonical-path guard; tests now use the canonical resources directory (2/2
passed), with no production path guard changes. Full verify after earlier fixture
fixes passed 667 backend tests/one platform skip, 115 UI tests, lint/types/build.
Subsequent supervision corrections passed scoped types/lint and are included in
final backend coverage. Writable real-service Cypress passed 2/2 on current source;
read-only coverage and final independent follow-ups are running.

Fable's final supervision follow-up accepted all four corrections with no new
concrete blocker. It verified outcome-before-boot ordering, idempotent delivery,
new-versus-legacy spawn claims, and the missing-directory refusal. Its limitations:
read-only source review, no independent test execution or installed/live checks.

The first coverage process had already loaded the two non-canonical fixture paths
before their correction and reported 670 passed, one platform skip and those two
failures. Their corrected targeted run passed 2/2; coverage is being rerun against
the corrected files. No fresh production failure was inferred from that stale run.
