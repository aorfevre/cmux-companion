# Tests and tooling review

## Summary

T7 validation update (2026-09-06): findings were checked against post-refactor commit `c89984a`; original executed probes below remain attributed to their area review. Current consolidated dispositions and verification are in [the final review](README.md). Historical branch-isolation limitations below describe the original investigation, not missing assembled reports.

Review version 1, T5; source baseline `444adaa059496acd27f24e75208e90bddf5cce38`. This is an investigation, not an implementation change. The highest-value work is to isolate API-test persistence, harden automation-config permissions, and make failed cleanup observable. Next come safe test discovery and deterministic process/timer harnesses. Findings below distinguish code-path evidence from executed checks; no runtime incident or flake rate is inferred from source alone.

The existing suite has substantive assertions for authentication, persistence, concurrent work, failure recovery, and browser interactions. All 45 currently tracked non-live Node suites belong to `npm test`. Every one of the 12 deterministic Cypress specs has a catch-all API intercept. A same-basename comparison finds 19 server modules lacking a dedicated suite; many have explicit coverage inside differently named suites. This is not a count of untested modules.

Only this report is owned by T5. The other four area reports and the behavior-preserving parser/Git-runner refactor belong to the combined delivery. They were absent from this task checkout at review time; their existence, assigned-file coverage, and the union of their server coverage blocks cannot be certified here.

## Coverage

The machine-readable block below contains exactly the tracked paths returned by `git ls-files 'tests/**' 'cypress/**' 'scripts/**' package.json package-lock.json eslint.config.mjs vitest.config.ts vite.config.ts cypress.config.ts cypress.live.config.ts tsconfig.json next.config.ts postcss.config.mjs AGENTS.md CLAUDE.md README.md`. README coverage is limited to its test/safety sections. Inclusion records review, not a finding or proof that every behavior is tested. The per-file ledger records the evaluated responsibility; cross-cutting findings apply only where supported by the cited evidence.

<!-- coverage:start -->
AGENTS.md
CLAUDE.md
README.md
cypress.config.ts
cypress.live.config.ts
cypress/e2e/board-collapsed-columns.cy.ts
cypress/e2e/board-search-filter.cy.ts
cypress/e2e/dashboard-overload.cy.ts
cypress/e2e/github-issue-column.cy.ts
cypress/e2e/github-issue-sync.cy.ts
cypress/e2e/goal-board-accuracy.cy.ts
cypress/e2e/goal-launch-fire-and-forget.cy.ts
cypress/e2e/goal-session-cleanup.cy.ts
cypress/e2e/goal-spec-options.cy.ts
cypress/e2e/spec-challenge.cy.ts
cypress/e2e/task-branch-retry.cy.ts
cypress/e2e/worktree-list-parsing.cy.ts
cypress/live/real-goal.cy.ts
cypress/support/commands.d.ts
cypress/support/e2e.ts
eslint.config.mjs
next.config.ts
package-lock.json
package.json
postcss.config.mjs
scripts/configure-cmux-automation.mjs
scripts/e2e-live-audit.mjs
scripts/install-macos.sh
scripts/recover-task-association.mjs
scripts/run-live-agent-cypress.mjs
scripts/run-local-cypress.mjs
scripts/status.sh
scripts/uninstall-macos.sh
scripts/worktree-cleanup.mjs
tests/account-usage.test.mjs
tests/agent-brief.test.mjs
tests/agent-capacity.test.mjs
tests/api.test.mjs
tests/ccs-reconnect.test.mjs
tests/cmux-client.test.mjs
tests/cmux-groups.test.mjs
tests/context-links.test.mjs
tests/delivery-contract.test.mjs
tests/github-issue-planner.test.mjs
tests/github-issue-sync-scheduler.test.mjs
tests/github-issue-sync.test.mjs
tests/github-review-token.test.mjs
tests/goal-board.test.mjs
tests/goal-followup-actions.test.mjs
tests/goal-followup.test.mjs
tests/goal-health.test.mjs
tests/goal-integrator.test.mjs
tests/goal-recovery.test.mjs
tests/goal-session-collector.test.mjs
tests/goal-session-reaper.test.mjs
tests/goal-watchdog.test.mjs
tests/image-attachments.test.mjs
tests/installed-companion.live.mjs
tests/live-cmux.test.mjs
tests/planner-background.test.mjs
tests/planner-progress.test.mjs
tests/preview-capture.test.mjs
tests/preview-manager.test.mjs
tests/prompt-queue.test.mjs
tests/push-service.test.mjs
tests/repo-catalog.test.mjs
tests/repo-identity-store.test.mjs
tests/responsive-layout.test.mjs
tests/review-options.test.mjs
tests/security.test.mjs
tests/session-name.test.mjs
tests/slash-shortcuts.test.mjs
tests/spec-options.test.mjs
tests/tailscale-preview.live.mjs
tests/task-association.test.mjs
tests/terminal-follow.test.mjs
tests/terminal-grid.test.mjs
tests/ui-api-request.test.tsx
tests/ui-features.test.tsx
tests/ui-setup.ts
tests/worktree-cleanup.test.mjs
tests/worktree-dashboard.test.mjs
tests/worktree-operations.test.mjs
tests/worktree-plan-store.test.mjs
tests/worktree-planner.test.mjs
tsconfig.json
vite.config.ts
vitest.config.ts
<!-- coverage:end -->

### Per-file review ledger

T6 additions reviewed in full: `tests/worktree-operations.test.mjs:17` adds 24 parser, adapter, runner and backend cases; `cypress/e2e/worktree-list-parsing.cy.ts:18` adds branch/Locked/removal presentation coverage with an API fallback. `package.json:22` includes the new Node suite exactly once. The dedicated-suite gap is now 19; parser/runner boundary work is delivered, not pending.

| Tracked file | Review scope / assessment |
| --- | --- |
| `AGENTS.md` | Local-only Cypress feature-validation policy; consistent with README. |
| `CLAUDE.md` | Delegates repository validation policy to AGENTS. |
| `README.md` | Local deterministic, live audit, destructive fixture and adapter/Tailscale safety instructions; evaluated at lines 278–310, 395–409, 469–472, 495–502, 525–527. |
| `cypress.config.ts` | Deterministic spec path, fixed local URL, CI refusal and runner opt-in. |
| `cypress.live.config.ts` | Live guard, timeouts, credential task, scoped merges and artifact cleanup; TEST-006. |
| `cypress/e2e/board-collapsed-columns.cy.ts` | Collapse defaults, persistence/migration, accessible controls and mobile/desktop strip geometry. |
| `cypress/e2e/board-search-filter.cy.ts` | Query/title/label/issue-number filtering, empty state and clear behavior. |
| `cypress/e2e/dashboard-overload.cy.ts` | Slow request coalescing, 503 explanation, retry and disconnected-session rendering. |
| `cypress/e2e/github-issue-column.cy.ts` | Starred sync, issue-to-goal request identity, column order and no-star explanation. |
| `cypress/e2e/github-issue-sync.cy.ts` | Multi-repository sync, partial errors, persistence/reload and single goal launch; overlaps column suite. |
| `cypress/e2e/goal-board-accuracy.cy.ts` | Lifecycle transitions, cleanup review, retention presentation, failed/recovered tasks and follow-ups. |
| `cypress/e2e/goal-launch-fire-and-forget.cy.ts` | Accepted background launch closes sheet; settled state refresh; refusal keeps sheet. |
| `cypress/e2e/goal-session-cleanup.cy.ts` | Restored-session review, close/keep reasons, unknown liveness and individual failures. |
| `cypress/e2e/goal-spec-options.cy.ts` | Six controls submit request values and render covered/not-applicable/missing evidence. |
| `cypress/e2e/spec-challenge.cy.ts` | Discussion preserves ready contract/card, request state, thread and subsequent mutations. |
| `cypress/e2e/task-branch-retry.cy.ts` | Blocked branch preserved, new branch displayed, conflicting actions disabled and request encoded. |
| `cypress/live/real-goal.cy.ts` | Opt-in real planner/agent/PR/merge traversal; run ownership and cleanup feedback; TEST-006. |
| `cypress/support/commands.d.ts` | Cypress and testing-library ambient command declarations. |
| `cypress/support/e2e.ts` | Testing-library commands and per-origin service-worker/cache reset. |
| `eslint.config.mjs` | Flat recommended rules, environment globals, generated-file ignores; TEST-010. |
| `next.config.ts` | Empty Next options/type import; installation-dependent compatibility not verified. |
| `package-lock.json` | Parsed all package records; root maps match manifest, version 3, 977 entries, HTTPS integrity present; not an advisory audit. |
| `package.json` | Explicit Node membership, separate live/UI/Cypress commands, verify composition, engine and dependencies; TEST-003. |
| `postcss.config.mjs` | Tailwind v4 plugin declaration; agrees with manifest plugin package. |
| `scripts/configure-cmux-automation.mjs` | JSONC-preserving automation setup, backups, password reuse/reload fallbacks; TEST-001. |
| `scripts/e2e-live-audit.mjs` | Read-only live API/cmux comparison, structured problems and nonzero exit; non-atomic snapshots/unbounded fetch. |
| `scripts/install-macos.sh` | Strict quoted zsh wrapper; requires sibling updater and forwards repository path. |
| `scripts/recover-task-association.mjs` | Validated positional arguments, inspect by default, explicit apply, store finally. |
| `scripts/run-live-agent-cypress.mjs` | CI/opt-in guards, bounded one/two task selector, child error/exit propagation; live config owns safety. |
| `scripts/run-local-cypress.mjs` | Port probe, frontend readiness, browser override, Cypress exit propagation; TEST-007. |
| `scripts/status.sh` | Health/updater/launchctl/Tailscale diagnostics; token shown only by explicit flag; macOS-specific utilities. |
| `scripts/uninstall-macos.sh` | Strict wrapper with installed-updater fallback and explicit missing-operator failure. |
| `scripts/worktree-cleanup.mjs` | Dry-run inventory/report output, private creation mode, store finally; no deletion. |
| `tests/account-usage.test.mjs` | Assertions/fixtures reviewed for: normalizes CCS accounts and exposes only sanitized usage data; caches snapshots and coalesces concurrent refreshes. |
| `tests/agent-brief.test.mjs` | Assertions/fixtures reviewed for: writes the full brief to a private file inside the brief directory; rejects identifiers that try to escape the brief directory. |
| `tests/agent-capacity.test.mjs` | Assertions/fixtures reviewed for: the tighter deciding window sets an account's headroom; a monthly window never decides, because the dispatcher does not read it. |
| `tests/api.test.mjs` | Authenticated injection, route payload/error contracts, deployment health, planner/reaper orchestration; TEST-002/009. |
| `tests/ccs-reconnect.test.mjs` | Assertions/fixtures reviewed for: validates the exact localhost callback target, code, and OAuth state; reconnects only a server-resolved account and never exposes CCS identifiers. |
| `tests/cmux-client.test.mjs` | Assertions/fixtures reviewed for: uses argv-only cmux commands for screen reads; bounds concurrent cmux processes so polling cannot flood the socket. |
| `tests/cmux-groups.test.mjs` | Assertions/fixtures reviewed for: creates a group anchored on the first workspace when no group carries the name; reuses a group that already carries the name and adds the workspace to it. |
| `tests/context-links.test.mjs` | Assertions/fixtures reviewed for: finds Markdown and localhost links in terminal output; resolves only repository-relative Markdown and image links. |
| `tests/delivery-contract.test.mjs` | Assertions/fixtures reviewed for: normalizes the delivery contract and task metadata; computes execution waves from task dependencies. |
| `tests/github-issue-planner.test.mjs` | Assertions/fixtures reviewed for: parses a CCS envelope and preserves issues omitted by the model; analyzes, clarifies, and creates one durable goal plan per selected topic. |
| `tests/github-issue-sync-scheduler.test.mjs` | Assertions/fixtures reviewed for: runs a pass on every interval without any HTTP request; keeps the schedule after a pass throws, and logs the failure. |
| `tests/github-issue-sync.test.mjs` | Assertions/fixtures reviewed for: the issue column identity is frozen and keys one card per repository issue; the column hides a started issue only while its goal is on the board. |
| `tests/github-review-token.test.mjs` | Assertions/fixtures reviewed for: an unconfigured companion reports no token and never throws; saving validates through the GitHub CLI and records the account. |
| `tests/goal-board.test.mjs` | Assertions/fixtures reviewed for: exports the eight ordered columns with labels and descriptions; maps drafts to writing spec while the planner works. |
| `tests/goal-followup-actions.test.mjs` | Assertions/fixtures reviewed for: exports the waiting-for-merge state and four ordered actions; freezes the catalogue, its entries, and the agent list. |
| `tests/goal-followup.test.mjs` | Assertions/fixtures reviewed for: opens exactly one follow-up session with every selected action in its brief; a single-task goal follows its launched task branch and worktree. |
| `tests/goal-health.test.mjs` | Assertions/fixtures reviewed for: calls a launched task dead when its cmux session is gone; reports a running agent as working and never as stuck. |
| `tests/goal-integrator.test.mjs` | Ready evidence, dependency waves, shared integration/merge ownership, failures and recovery. |
| `tests/goal-recovery.test.mjs` | Relaunch/rebranch/skip guards and sibling evidence preservation; duplicate launch fixtures. |
| `tests/goal-session-collector.test.mjs` | Assertions/fixtures reviewed for: GitHub reconciliation closes a single-task goal session and preserves its PR; watchdog collects old merged goals even without active repositories or available cmux health. |
| `tests/goal-session-reaper.test.mjs` | Assertions/fixtures reviewed for: an open pull request retires the original task and merge sessions; an open pull request on a single-task goal retires its task session. |
| `tests/goal-watchdog.test.mjs` | Assertions/fixtures reviewed for: pushes one alert for a dead goal and carries the plan id for the deep link; does not repeat an alert while the goal stays in the same state. |
| `tests/image-attachments.test.mjs` | Assertions/fixtures reviewed for: stores validated images privately for local agent access; rejects disguised and oversized image payloads. |
| `tests/installed-companion.live.mjs` | Real HTTP pairing/read/control, uploads, queue, preview and cleanup; opt-in script only. |
| `tests/live-cmux.test.mjs` | Real isolated workspace/terminal/replay/viewport/prompt control; TEST-005. |
| `tests/planner-background.test.mjs` | Detached rounds, held replies, notifications, launch coordination, abort/discussion races; TEST-008/009. |
| `tests/planner-progress.test.mjs` | Assertions/fixtures reviewed for: delivers an event to a live subscriber; replays the buffered events to a late subscriber. |
| `tests/preview-capture.test.mjs` | URL restrictions and optional real-browser PNG/viewport assertions; hard-coded Chrome skip, TEST-011. |
| `tests/preview-manager.test.mjs` | Assertions/fixtures reviewed for: discovers localhost apps and manages isolated Tailscale Serve ports; auto-detects stable workspace ports and rejects unsafe targets. |
| `tests/prompt-queue.test.mjs` | Assertions/fixtures reviewed for: persists, edits, reorders, and removes queued prompts; sends one prompt after each agent stop and retains failed work. |
| `tests/push-service.test.mjs` | Assertions/fixtures reviewed for: persists per-device subscriptions and applies privacy/settings filters; targets test alerts and reports push failures without exposing provider details. |
| `tests/repo-catalog.test.mjs` | Assertions/fixtures reviewed for: discovers approved repositories and reports live Git changes; rejects unknown repositories and hides untracked symlink contents. |
| `tests/repo-identity-store.test.mjs` | Assertions/fixtures reviewed for: remembers a commit time and answers it back; refuses anything that is not a commit sha. |
| `tests/responsive-layout.test.mjs` | CSS source regex assertions only; TEST-011. |
| `tests/review-options.test.mjs` | Assertions/fixtures reviewed for: the catalog is frozen data with a usable label and hint; missing input normalizes to a fresh all-off object. |
| `tests/security.test.mjs` | Assertions/fixtures reviewed for: creates and reuses a private pairing token; authorizes only the pairing bearer or signed session cookie. |
| `tests/session-name.test.mjs` | Assertions/fixtures reviewed for: takes one initial per word for a multi-word repository name; treats every non-alphanumeric run as a word boundary. |
| `tests/slash-shortcuts.test.mjs` | Assertions/fixtures reviewed for: lists useful coding-agent slash shortcuts with provider labels; filters slash shortcuts from the current composer draft. |
| `tests/spec-options.test.mjs` | Assertions/fixtures reviewed for: the catalog lists the six options in a stable order; missing input returns a fresh all-false object. |
| `tests/tailscale-preview.live.mjs` | Real Serve enable/HTTPS/stop verification; chained finally can skip later cleanup if stop fails. |
| `tests/task-association.test.mjs` | Assertions/fixtures reviewed for: recovery verifies repository, branch, exact pushed identity, cleanliness and agent activity. |
| `tests/terminal-follow.test.mjs` | Assertions/fixtures reviewed for: detects the follow zone near the terminal bottom; initial output follows while history readers get an unseen marker. |
| `tests/terminal-grid.test.mjs` | Assertions/fixtures reviewed for: normalizes a cmux render grid and rejects unsafe spans; terminal signatures change with rendered content but not object identity. |
| `tests/ui-api-request.test.tsx` | Deferred fetch coalescing, mutation invalidation and failure retry; globals restored. |
| `tests/ui-features.test.tsx` | Rendered interactions across account, terminal, dashboard, planner and discussion; broad mocks and 2,595-line mixed suite. |
| `tests/ui-setup.ts` | RTL DOM cleanup and mock restoration, scroll/clipboard stubs; suite-specific globals/timers handled separately. |
| `tests/worktree-cleanup.test.mjs` | Assertions/fixtures reviewed for: recursive discovery deduplicates aliases by common directory and includes external registrations; disabled by default; grace observes exact HEAD; clean merged checkout deletes ignored build output but preserves branch. |
| `tests/worktree-dashboard.test.mjs` | Porcelain adapter, Git/session/PR grouping, archive/favorites, acquisition failures and merge reconciliation. |
| `tests/worktree-plan-store.test.mjs` | SQLite persistence/migration, lifecycle idempotence, event limits, relaunch and discussion invariants. |
| `tests/worktree-planner.test.mjs` | Parsing, provider choice, process ceilings, prompts, launches, persistence, abort/discussion; TEST-008/009. |
| `tsconfig.json` | Strict TS, bundler resolution, imported JS boundary, generated Next types; TEST-010. |
| `vite.config.ts` | vinext/Sites/Cloudflare plugins, API/WebSocket proxy, sandbox polling and local Wrangler state. |
| `vitest.config.ts` | React/jsdom setup and UI-only include convention; separate from Node runner. |

## What is good

- Authentication tests exercise both status and control boundaries, rather than merely constructing an app: `tests/api.test.mjs:73`, `tests/api.test.mjs:443`, `tests/api.test.mjs:610`. Failure cases inspect messages and response contracts as well as success status.
- Real temporary Git repositories test destructive-cleanup eligibility, locks, dirty/untracked content, unavailable activity, and exact merged evidence: `tests/worktree-cleanup.test.mjs:10`, `tests/worktree-cleanup.test.mjs:189`, `tests/worktree-cleanup.test.mjs:197`. These tests complement browser fixtures, which cannot observe raw Git porcelain.
- Concurrency tests use a held promise and assert one call and shared results (`tests/github-issue-sync-scheduler.test.mjs:65`, `tests/ui-api-request.test.tsx:5`). Existing RepoCatalog tests protect shared Git slots and release after errors (`tests/repo-catalog.test.mjs:271`); these should survive T6 unchanged in meaning.
- Cypress uses role-based selectors, request assertions, explicit state changes and aliases. The overload case checks that only one request is in flight (`cypress/e2e/dashboard-overload.cy.ts:57`). Retry coverage verifies the displayed effective branch and competing-action state (`cypress/e2e/task-branch-retry.cy.ts:18`). These are stronger than screenshot-only smoke checks.
- All deterministic specs register an API fallback before overrides; unmatched traffic receives 501 rather than reaching Vite's API proxy. Example: `cypress/e2e/dashboard-overload.cy.ts:36`. Shared support clears service-worker/cache storage for the fixture origin (`cypress/support/e2e.ts:6`). A 501 response is a network boundary, not necessarily a failed test if the UI handles the error; see recommendations.
- Both Cypress configs reject CI, and their spec patterns separate local and live suites (`cypress.config.ts:6`, `cypress.config.ts:11`, `cypress.live.config.ts:12`, `cypress.live.config.ts:24`). The live merge task validates the exact disposable GitHub repository, open state, and run marker (`cypress.live.config.ts:124`). README explicitly describes side effects and local-only execution (`README.md:278`, `README.md:300`). `AGENTS.md:7` and `CLAUDE.md:3` agree with that policy.
- Install/uninstall wrappers quote paths, use zsh strict failure handling, and fail clearly when the external updater is absent (`scripts/install-macos.sh:2`, `scripts/install-macos.sh:8`, `scripts/uninstall-macos.sh:10`). Their macOS/zsh dependency is intentional, not a cross-platform defect. Recovery requires `--apply` and closes its store in `finally` (`scripts/recover-task-association.mjs:6`); cleanup CLI only previews (`scripts/worktree-cleanup.mjs:19`).
- Lockfile version 3 has 977 package entries, its root dependency/devDependency/engine maps match package.json exactly, and every HTTPS-resolved entry has integrity metadata. This verifies manifest alignment, not dependency security or a successful clean installation (`package-lock.json:1`, `package.json:35`).

## Findings

Severity means potential consequence: High affects private credentials or persistent operator state; Medium affects validation reliability or safety feedback; Low is a bounded maintenance or coverage weakness. Priority ordering appears in the recommendations.

### TEST-001 — Existing automation config keeps permissive permissions

- **Severity:** High. **Category:** Script credential handling.
- **Path:line:** `scripts/configure-cmux-automation.mjs:66`; backup behavior at `scripts/configure-cmux-automation.mjs:63`.
- **Scenario/consequence:** An existing 0644 cmux.json in traversable directories receives a socket password but remains readable by other local users. An already password-bearing backup can retain the same permissions. Exposure depends on parent-directory access; no actual credential exposure was tested.
- **Evidence:** The credential sidecar is explicitly chmodded at `scripts/configure-cmux-automation.mjs:50`, but the config is only written with a creation mode; existing directories also are not chmodded. A disposable-file Node probe created 0644, rewrote with `mode: 0o600`, then statted 0644. This reproduces the filesystem primitive without touching real configuration.
- **Action:** Explicitly enforce private permissions on the password-bearing config and backups, including the unchanged-config path. Add isolated CLI tests for new/existing/permissive files, invalid JSONC, backup failure, and reload failure; preserve comments and password reuse.

### TEST-002 — API fixtures can open the operator's goal database

- **Severity:** High. **Category:** Test isolation.
- **Path:line:** `tests/api.test.mjs:74`, `tests/api.test.mjs:68`.
- **Scenario/consequence:** A normal local test run without a database override can create/open/migrate the real goal database. Concurrent test apps and the installed service can share persistence, and assertions depend on the operator's environment.
- **Evidence:** Those builders inject cmux and a token but neither a planner nor a plan store. `server/app.mjs:117` constructs a default WorktreePlanStore in that case. Its default is the homedir database (`server/worktree-plan-store.mjs:9`, `server/worktree-plan-store.mjs:149`). The npm command supplies no isolation environment (`package.json:22`); the suite does not set the database path. This is a verified construction path, not a claim that production goals were deleted.
- **Action:** Introduce a test app factory that injects temporary/in-memory stores and inert background dependencies by default, with explicit opt-ins for integration behavior. Register resource disposal before later setup awaits. Add a regression that fails if any default persistent directory is opened.

### TEST-003 — New non-live suites can silently miss npm test

- **Severity:** Medium. **Category:** Test discovery / script composition.
- **Path:line:** `package.json:22`.
- **Scenario/consequence:** Adding a new non-live `.test.mjs` file without editing this command leaves it unexecuted by both npm test and verify.
- **Evidence:** The command enumerates 45 exact paths. Mechanical set comparison found zero current omissions or stale entries. Adding a synthetic candidate to the comparison, without creating or executing a file, produces an omitted member. `tests/live-cmux.test.mjs:13` directly creates a real workspace; therefore replacing the list with `tests/*.test.mjs` is unsafe. Installed/Tailscale live files have another suffix and their own scripts (`package.json:23`).
- **Action:** Move live suites behind an explicit directory or manifest boundary, then discover deterministic suites and assert membership parity. Until then, retain the allow-list and add a non-mutating inventory check that fails on an unclassified test. Preserve separate Vitest and local-only Cypress commands.

### TEST-004 — Cleanup is registered after operations and assertions

- **Severity:** Medium. **Category:** Cleanup reliability.
- **Path:line:** `tests/prompt-queue.test.mjs:25`, `tests/prompt-queue.test.mjs:51`, `tests/repo-catalog.test.mjs:28`.
- **Scenario/consequence:** A setup failure or failed assertion before the final `t.after` leaves temporary directories; an event test failure before detach also leaves attached resources for the remainder of the process. In RepoCatalog, a Git setup failure happens before removal registration.
- **Evidence:** Allocation precedes those hooks; queue detach is an ordinary success-path call (`tests/prompt-queue.test.mjs:45`). Push event tests repeat this shape (`tests/push-service.test.mjs:97`, `tests/push-service.test.mjs:109`).
- **Action:** Register directory removal immediately after mkdtemp and detach immediately after attach; separately close each acquired resource even if an earlier cleanup fails. Use fs.rm rather than an external `rm` command for temporary directories. Failure-inject setup and the first assertion to verify cleanup.

### TEST-005 — Live cmux cleanup can lose its known workspace ID

- **Severity:** Medium. **Category:** Live-test resource ownership.
- **Path:line:** `tests/live-cmux.test.mjs:26`, `tests/live-cmux.test.mjs:90`.
- **Scenario/consequence:** If subsequent workspace listings never return the created title, `workspaceId` becomes undefined; finally no longer closes the known created workspace. If close throws, temporary queue removal is skipped. Failures before entering try also bypass directory cleanup.
- **Evidence:** Creation returns and stores an ID at `tests/live-cmux.test.mjs:17`, but every lookup overwrites it with an optional result. The installed-companion suite already preserves a fallback reference (`tests/installed-companion.live.mjs:194`), although several other cleanup errors there are swallowed.
- **Action:** Keep the created ID immutable as the ownership token and register cleanup as soon as each resource exists. Aggregate cleanup errors without preventing independent cleanup. Test missing listings, close rejection and partial creation with a fake client; do not reproduce this by leaking real sessions.

### TEST-006 — Live Cypress can pass despite reported cleanup failures

- **Severity:** Medium. **Category:** Live-test safety feedback.
- **Path:line:** `cypress/live/real-goal.cy.ts:95`, `cypress.live.config.ts:122`.
- **Scenario/consequence:** A completed goal can leave workspaces or Git artifacts after cleanup returns error arrays, while the after hook still succeeds. An abort HTTP error is recorded as a status but not rejected.
- **Evidence:** Cleanup collects per-workspace and Git errors and returns them alongside abortStatus/abortError; the hook awaits the task but asserts none of those fields. Actual thrown task failures do fail Cypress; the defect concerns structured failures. Failed-run branch retention is documented in README and is not itself a defect.
- **Action:** Assert expected abort status and empty error collections, report all leftovers, and attempt independent cleanup stages even if workspace inventory fails. Preserve the exact repository and run-marker checks. Unit-test task handlers with failing cmux/Git/HTTP adapters before opting into live validation.

### TEST-007 — Local runner readiness and shutdown lack full bounds

- **Severity:** Medium. **Category:** Process lifecycle.
- **Path:line:** `scripts/run-local-cypress.mjs:26`, `scripts/run-local-cypress.mjs:37`.
- **Scenario/consequence:** A frontend that accepts but stalls an HTTP request can hold readiness beyond the intended 120 × 500 ms polling budget. Shutdown signals only the npm wrapper and neither awaits exit nor verifies the spawned dev process released port 3221; orphaning is a risk, not a reproduced incident.
- **Evidence:** fetch has no abort signal; stopFrontend calls kill on one child. SIGINT/SIGTERM handlers exit immediately (`scripts/run-local-cypress.mjs:48`). The frontend spawn lacks an error listener, unlike the Cypress spawn (`scripts/run-local-cypress.mjs:16`, `scripts/run-local-cypress.mjs:57`).
- **Action:** Bound each readiness request and the overall deadline, handle spawn errors, and own/await the process tree with bounded escalation. Validate missing npm, a hanging HTTP server, frontend early exit, Cypress failure, occupied port, and both termination signals with disposable subprocesses.

### TEST-008 — Process timing tests have narrow host-load margins

- **Severity:** Medium. **Category:** Timing / concurrency reliability.
- **Path:line:** `tests/worktree-planner.test.mjs:692`, `tests/prompt-queue.test.mjs:38`.
- **Scenario/consequence:** A correct child delayed by process startup or scheduling can hit a 200 ms idle limit before producing expected 50 ms ticks. Queue tests assert after fixed 650 ms sleeps rather than observing completion. These encode timing sensitivity; no repeated-run flake rate was measured.
- **Evidence:** The child test expects all eight lines, while the process harness measures real time. Background settling also uses an iteration budget of 500 setImmediate turns (`tests/planner-background.test.mjs:58`), whose elapsed duration varies by machine.
- **Action:** Prefer gated promises and injected clocks for logic tests; retain a small real-process integration layer with startup synchronization and generous explicit deadlines. Poll outcomes rather than sleep to guess completion, and always tear down in hooks. Preserve tests for idle versus total ceilings and slot release on rejection.

### TEST-009 — Repeated fixtures and large mixed suites amplify drift

- **Severity:** Low. **Category:** Maintainability / fixture design.
- **Path:line:** `tests/planner-background.test.mjs:30`, `tests/worktree-planner.test.mjs:196`, `tests/goal-recovery.test.mjs:31`, `cypress/e2e/goal-spec-options.cy.ts:118`.
- **Scenario/consequence:** Common repository, usage, planner and API shapes must be updated across many local builders. Oversized files mix unrelated responsibilities and make focused ownership and setup review harder.
- **Evidence:** The recovery fixture explicitly identifies its duplicated launchDeps shape. Source line counts are 2,595 for UI features, 2,293 for planner, 1,692 for API, 1,466 for dashboard, 1,329 for plan store, and 1,035 for integrator. All 12 Cypress specs repeat base API registration. Size alone does not establish a correctness defect or require arbitrary line limits.
- **Action:** Extract small factories returning fresh mutable state and explicit dependency overrides, including the isolated app builder in TEST-002. Split by behavior (contracts, lifecycle, transport), keep scenario-specific responses beside assertions, and run focused and aggregate suites after each move. Do not turn fixtures into a second production implementation.

### TEST-010 — Typecheck does not establish server JavaScript correctness

- **Severity:** Low. **Category:** Static-analysis coverage.
- **Path:line:** `tsconfig.json:21`, `tsconfig.json:5`, `eslint.config.mjs:26`.
- **Scenario/consequence:** A passing typecheck is easy to overinterpret as server/script type validation. Include patterns select TypeScript, while checkJs is not enabled. ESLint combines browser, Node and service-worker globals for every file, so an accidental browser global in a server module may evade no-undef.
- **Evidence:** allowJs permits imported JavaScript; it does not turn on JavaScript checking. ESLint's ignore list covers build outputs and next-env, but lacks explicit ignores for `.wrangler`, `.vinext`, Cypress screenshots/videos, `coverage`, `outputs`, and `work`, although those are gitignored. Actual scanning depends on file extensions/default hidden-path behavior; no lint failure from generated output is asserted. Vitest only discovers `tests/ui-*.test.tsx` (`vitest.config.ts:9`).
- **Action:** Document the typecheck boundary; introduce separate environment-aware ESLint overrides, intentional generated-output ignores, and incremental checkJs/JSDoc only where worthwhile. Verify effective config with print-config and tsc file inventory. Add a discovery check if UI naming conventions broaden.

### TEST-011 — Layout source assertions do not verify rendered layout

- **Severity:** Low. **Category:** Assertion strength / portability.
- **Path:line:** `tests/responsive-layout.test.mjs:7`, `tests/preview-capture.test.mjs:7`, `tests/preview-capture.test.mjs:17`.
- **Scenario/consequence:** Regexes can fail on equivalent CSS formatting yet pass when other rules override the layout. The real capture test silently skips unless Chrome exists at one macOS path; a green suite elsewhere does not prove capture works.
- **Evidence:** The layout suite matches CSS text, not dimensions. Capture explicitly skips on existsSync(CHROME); browser capability is not provisioned by the test. Existing Cypress width checks are narrower board-column coverage (`cypress/e2e/board-collapsed-columns.cy.ts:153`), not proof of every responsive shell rule.
- **Action:** Keep intentional static invariants, but add local browser geometry/overflow checks for the shell, navigation and sheets at representative widths. Make capture executable configuration explicit and report skips prominently; maintain a designated local browser validation path.

## Test gaps

### Dedicated-suite gap only

The following sorted bare module basenames are mechanically derived from tracked `server/*.mjs` minus tracked same-basename `tests/*.test.mjs`. The marker block is deliberately plain text so it can be compared directly with the requested comm output. It does not include speculative absence of branch coverage.

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

| Module | Indirect coverage / differently named suite evidence |
| --- | --- |
| `app` | Direct import under differently named suite: `tests/api.test.mjs:6`. Behavior scope is recorded in the per-file ledger; import alone is not exhaustive coverage. |
| `deployment-health` | Direct import under differently named suite: `tests/api.test.mjs:8`. Behavior scope is recorded in the per-file ledger; import alone is not exhaustive coverage. |
| `event-hub` | Imported by `server/app.mjs:11`, in turn imported by `tests/api.test.mjs:6`; no focused reconnect/backpressure assertion identified (import/construction relationship only). |
| `github-issue-board` | Direct import under differently named suite: `tests/github-issue-sync.test.mjs:8`. Behavior scope is recorded in the per-file ledger; import alone is not exhaustive coverage. |
| `github-issue-store` | Direct import under differently named suite: `tests/github-issue-sync.test.mjs:6`. Behavior scope is recorded in the per-file ledger; import alone is not exhaustive coverage. |
| `goal-merge-watch` | Direct import under differently named suite: `tests/goal-session-collector.test.mjs:5`, `tests/worktree-dashboard.test.mjs:11`. Behavior scope is recorded in the per-file ledger; import alone is not exhaustive coverage. |
| `goal-worktree-proof` | Exercised through inventory by `tests/worktree-cleanup.test.mjs:189` and `tests/worktree-cleanup.test.mjs:197`; import boundary `server/worktree-inventory.mjs:1`. |
| `index` | No direct suite import or startup execution identified; API builder testing is not entrypoint validation. |
| `launch-runs` | Direct import under differently named suite: `tests/worktree-planner.test.mjs:9`. Behavior scope is recorded in the per-file ledger; import alone is not exhaustive coverage. |
| `planner-runs` | Background running/settled behavior in `tests/planner-background.test.mjs:75`, through `server/worktree-planner.mjs:17`. |
| `release-retention` | Imported by `server/app.mjs:1` through API suite; browser retention payload at `cypress/e2e/goal-board-accuracy.cy.ts:139` is stubbed, not execution of retention logic. No focused backend retention assertion identified. |
| `repository-archive` | Direct import under differently named suite: `tests/worktree-dashboard.test.mjs:7`. Behavior scope is recorded in the per-file ledger; import alone is not exhaustive coverage. |
| `repository-favorites` | Direct import under differently named suite: `tests/worktree-dashboard.test.mjs:8`. Behavior scope is recorded in the per-file ledger; import alone is not exhaustive coverage. |
| `restored-goal-sessions` | Direct import under differently named suite: `tests/goal-session-reaper.test.mjs:336`, `tests/goal-session-reaper.test.mjs:377`. Behavior scope is recorded in the per-file ledger; import alone is not exhaustive coverage. |
| `supervisor` | No direct suite import or process-supervision test identified; installed-live service use is not a supervisor restart regression. |
| `task-branch` | Direct import under differently named suite: `tests/worktree-planner.test.mjs:7`. Behavior scope is recorded in the per-file ledger; import alone is not exhaustive coverage. |
| `worktree-errors` | Direct import under differently named suite: `tests/api.test.mjs:9`, `tests/goal-integrator.test.mjs:9`, `tests/goal-recovery.test.mjs:11`, `tests/worktree-dashboard.test.mjs:10`, `tests/worktree-plan-store.test.mjs:8`, `tests/worktree-planner.test.mjs:8`. Behavior scope is recorded in the per-file ledger; import alone is not exhaustive coverage. |
| `worktree-inventory` | Direct import under differently named suite: `tests/worktree-cleanup.test.mjs:6`. Behavior scope is recorded in the per-file ledger; import alone is not exhaustive coverage. |
| `worktree-planner-options` | Direct import under differently named suite: `tests/spec-options.test.mjs:4`. Behavior scope is recorded in the per-file ledger; import alone is not exhaustive coverage. |

Prioritize behavioral gaps over renaming files: process startup/supervision and release-retention failure paths; event-stream reconnect/backpressure; script failure/cleanup behavior; and remaining malformed-input parser policy beyond T6’s tested Git `-z` boundary. Direct imports alone establish a test relationship, not exhaustive coverage. Import-only relationships are explicitly marked below. There is no instrumented statement/branch coverage report in this investigation, so no coverage percentage is claimed.

### Rejected or unverified claims

| Claim | Disposition and evidence |
| --- | --- |
| npm test currently omits an existing non-live Node suite | Rejected: exact comparison is 45 expected versus 45 listed, with empty differences. Future omission is TEST-003. |
| Every module in the gap block is untested | Rejected: the table identifies direct imports and exercised paths under other suite names. |
| A broad Node test glob is a safe simplification | Rejected: live-cmux has the same `.test.mjs` suffix and creates real resources. |
| Deterministic Cypress has no API fallback | Rejected: all 12 specs contain the fallback. Endpoint completeness is still not proven because handled 501s need not fail assertions. |
| verify should automatically include Cypress/CI | Rejected: package composition intentionally follows README and AGENTS local-only policy. |
| All TypeScript/config files are ignored by lint | Rejected: the flat config is broad; TEST-010 describes the actual limits. No effective-config run was performed without installed dependencies. |
| Lockfile drift or a vulnerable dependency has been proven | Rejected/unverified: root maps and integrity metadata agree; no advisory audit, clean install, or exploit validation was run. |
| Tight timeouts prove frequent flakes; runner leaks on every run | Unverified: code establishes sensitive timing and lifecycle gaps, not observed frequencies. |
| Vite/vinext plus Next config is necessarily broken | Unverified: Vite loads vinext, Sites and Cloudflare; Next config is empty and imports a Next type. A missing direct Next dependency does not alone prove failure because dependency/type resolution needs installation evidence. |
| Full project validation passed in this review | Rejected: only the specifically recorded targeted tests and mechanical checks ran. |

## Recommended test-infrastructure changes

1. **Protect local state first:** implement TEST-002's isolated app factory and TEST-001's permission regression tests. Never validate these by touching a real operator database or credentials.
2. **Make cleanup a checked contract:** address TEST-004 through TEST-007 with disposable resources, immediate hook registration, preserved ownership IDs, aggregate errors, and bounded process lifecycle tests. Keep destructive live execution opt-in and local-only.
3. **Prevent silent validation loss:** add membership parity for deterministic Node tests and UI naming, preserving the live exclusions. Keep `verify` as Node → Vitest → lint → typecheck → build (`package.json:32`), and run deterministic Cypress separately for user-visible changes. A shared Cypress API fallback should also record unexpected requests and assert none occurred, while allowing explicitly modeled failures.
4. **T6 refactor review task — resolved:** See PLAT-007 in [server-platform.md](server-platform.md). Canonical parsing and low-level execution, direct edge-case tests, backend integration and local Cypress coverage are delivered. Task association still has a separate policy wrapper (GOAL-009); no claim is made that every Git invocation was migrated. NUL framing tests preserve LF/CRLF inside values; they do not establish support for line-delimited porcelain.

5. **Reduce maintenance cost incrementally:** extract fresh-state fixtures and split oversized suites around responsibilities, then replace fragile waits/source-format assertions with observable outcomes. Check each touched test still fails for its intended behavioral regression. Scope static-analysis environments and document browser/platform prerequisites rather than implying universal portability.

### Tooling composition and drift assessment

`package.json:10` uses POSIX environment assignments for vinext commands; install/status tooling explicitly targets macOS. Updater commands depend on a sibling repository, while uninstall/status also know the installed updater location. That is an external prerequisite, not evidence that the companion owns the updater implementation. `scripts/e2e-live-audit.mjs:13` issues reads without a fetch deadline and compares non-atomic API/cmux snapshots; live state changes can yield a transient mismatch. Treat its output as an observation requiring correlation, not a deterministic regression verdict.

Vite's API proxy defaults to the installed backend and enables WebSockets (`vite.config.ts:51`); Cypress's fallback boundary is therefore important. Local base URL and runner agree on localhost:3221, and the live runner and config agree on the opt-in variable and spec. README's live side effects match those commands. Vitest deliberately uses its own React/jsdom configuration rather than starting the Cloudflare worker. PostCSS selects the Tailwind v4 plugin. The empty Next config does not conflict with an explicit option in Vite; runtime compatibility remains unverified without dependencies. ESLint's build ignores partly overlap the package lint flags; aligning generated paths is maintenance work, not grounds to claim lint is currently broken.

### Verification and completion limitations

- Inventory, coverage-block equality, dedicated-suite gap equality, current npm membership, synthetic future-member omission, lockfile root/integrity structure, and citation path/line bounds were mechanically checked. Findings' cited source was checked for semantic relevance as well as bounds.
- Executed on Node v22.23.1: `node --test tests/context-links.test.mjs tests/slash-shortcuts.test.mjs tests/terminal-follow.test.mjs tests/terminal-grid.test.mjs tests/agent-capacity.test.mjs tests/spec-options.test.mjs tests/review-options.test.mjs tests/delivery-contract.test.mjs tests/goal-board.test.mjs tests/goal-followup-actions.test.mjs tests/session-name.test.mjs`: **113 passed, zero failures/skips**. Disposable permission probe: existing 0644 remained 0644 after a 0600-mode rewrite. `zsh -n scripts/install-macos.sh scripts/uninstall-macos.sh scripts/status.sh` passed.
- Full npm test, Vitest, lint, typecheck, build and Cypress were not run: node_modules is absent, this is a documentation-only investigation, and the identified API default-persistence path should be isolated before a broad local run. No user-visible behavior changed, so AGENTS' feature Cypress requirement does not apply. No real cmux, agent, GitHub merge, Tailscale, installer or credential-mutating operation was executed.
- T5's AC-1 contribution is the required report structure and complete owned coverage; global five-report/three-server-union checks require assembled delivery and are not claimed passed. AC-2's inventory, membership and dedicated-gap requirements are verified here. No adjacent repository files were changed. Unit/E2E additions, named parser/runner edge-case tests, and implementation/refactor cleanup belong to T6 and cannot be performed within T5's explicit no-source/test/config-change restriction.
