# Server platform code review

## Summary

Review version: 1.1, 2026-09-06 (T6 resolution update). Source baseline: `444adaa059496acd27f24e75208e90bddf5cce38`. Scope: T3, 23 complete server modules (6,269 lines). The original T3 investigation changed no source or tests. Findings describe that baseline; PLAT-007 below records the delivered T6 refactor. Citations in touched modules have been refreshed.

The highest-value work is to make manual worktree deletion fail closed on unavailable status and session evidence (PLAT-001 and PLAT-006). Automatic cleanup already demonstrates substantially stronger safeguards. Next, serialize preview allocation and fix the queue and reconnect lifecycle contracts. T6 has resolved the confirmed porcelain parser and low-level Git invocation duplication (PLAT-007), retaining the adapters, concurrency limits, dependency injection, and errors.

Severity: **High** means a verified path can destroy user work or bypass a destructive-operation guard; **Medium** means a reproducible functional failure or consequential maintenance risk; **Low** means limited failure scope or structural friction. Ordering below is by identifier; delivery priority is 001/006, then 002/003/004, then 005/008; 007 is resolved. No unauthenticated command-execution or credential-exfiltration exploit was established.

## Coverage

Every path in this block was read in full and checked against tracked files. Files without a verified finding remain covered; absence of a finding is not a claim of exhaustive correctness.

<!-- COVERAGE:START -->
```json
[
  "server/app.mjs",
  "server/security.mjs",
  "server/cmux-client.mjs",
  "server/cmux-groups.mjs",
  "server/repo-catalog.mjs",
  "server/worktree-dashboard.mjs",
  "server/worktree-inventory.mjs",
  "server/worktree-operations.mjs",
  "server/worktree-cleanup.mjs",
  "server/worktree-errors.mjs",
  "server/repository-archive.mjs",
  "server/repository-favorites.mjs",
  "server/repo-identity-store.mjs",
  "server/release-retention.mjs",
  "server/deployment-health.mjs",
  "server/preview-manager.mjs",
  "server/preview-capture.mjs",
  "server/push-service.mjs",
  "server/prompt-queue.mjs",
  "server/account-usage.mjs",
  "server/ccs-reconnect.mjs",
  "server/image-attachments.mjs",
  "server/github-review-token.mjs"
]
```
<!-- COVERAGE:END -->

Relevant tests were located by imports and by behavior, then the assertions supporting the claims below were read. Test-module entry points:

| Assigned modules | Relevant test evidence |
| --- | --- |
| app, security, deployment-health | `tests/api.test.mjs:73`, `tests/api.test.mjs:86`, `tests/security.test.mjs:16` |
| cmux-client, cmux-groups | `tests/cmux-client.test.mjs:10`, `tests/cmux-groups.test.mjs:19` |
| repo-catalog, repo-identity-store | `tests/repo-catalog.test.mjs:32`, `tests/repo-identity-store.test.mjs:15` |
| worktree-dashboard, worktree-errors, repository-archive, repository-favorites | `tests/worktree-dashboard.test.mjs:15`, `tests/worktree-dashboard.test.mjs:27`, `tests/worktree-dashboard.test.mjs:39`, `tests/worktree-dashboard.test.mjs:853` |
| worktree-inventory, worktree-operations, worktree-cleanup | `tests/worktree-cleanup.test.mjs:40`, `tests/worktree-cleanup.test.mjs:141`, `tests/worktree-cleanup.test.mjs:160` |
| preview-manager, preview-capture | `tests/preview-manager.test.mjs:8`, `tests/preview-capture.test.mjs:9` |
| push-service, prompt-queue | `tests/push-service.test.mjs:23`, `tests/prompt-queue.test.mjs:12` |
| account-usage, ccs-reconnect | `tests/account-usage.test.mjs:33`, `tests/ccs-reconnect.test.mjs:26` |
| image-attachments, github-review-token | `tests/image-attachments.test.mjs:10`, `tests/github-review-token.test.mjs:31` |
| release-retention | No direct importing test found; HTTP forwarding at `server/app.mjs:377` and argv wrapper at `server/release-retention.mjs:8` inspected. Deployed updater behavior is outside T3. |

Additional behavior references include `tests/goal-recovery.test.mjs:11` and `tests/worktree-planner.test.mjs:8` for shared worktree errors. Cypress dashboard overload and retry flows exist at `cypress/e2e/dashboard-overload.cy.ts:60` and `cypress/e2e/task-branch-retry.cy.ts:18`; these use intercepted dashboard responses and do not establish raw Git parser correctness.

The sibling reports from T1, T2, T4 and T5 were absent on this task branch at review time. Thus the five-report existence check and union of three server coverage blocks against all tracked server modules cannot be completed here. This block completes T3's contribution to AC-1, not the combined goal's coverage audit.

## What is good

- **Authorization is centralized.** The API hook applies pairing and mutation-origin checks before handlers (`server/app.mjs:204`). Bearer and derived session values use timing-safe comparison; Tailscale identity headers alone grant no authorization (`server/security.mjs:40`, `server/security.mjs:46`). Cookies are HttpOnly, SameSite=Strict, and Secure on HTTPS (`server/security.mjs:80`). Assertions cover token file mode, cookie flags, bearer/session acceptance, rejection of identity-header-only access, foreign origins and many mutation routes (`tests/security.test.mjs:16`, `tests/security.test.mjs:26`, `tests/security.test.mjs:36`, `tests/api.test.mjs:610`). The route test is a manually enumerated matrix, not proof of every current route.
- **Command boundaries are mostly deliberate.** Cmux uses argv and JSON RPC, validates UUID targets, allowlists keys/agents, quotes prompts when constructing intentional shell commands, and checks cwd existence (`server/cmux-client.mjs:48`, `server/cmux-client.mjs:249`, `server/cmux-client.mjs:504`, `server/cmux-client.mjs:563`). Tests assert adversarial prompt quoting, invalid targets and oversized input (`tests/cmux-client.test.mjs:138`, `tests/cmux-client.test.mjs:169`). Release retention allowlists four operations and sends options as one JSON argv value (`server/release-retention.mjs:8`); no direct wrapper test was found.
- **Repository reads defend their filesystem boundary.** Markdown/assets canonicalize both repository and candidate, enforce containment, regular-file status, size and extension; image content signatures are checked (`server/repo-catalog.mjs:255`, `server/repo-catalog.mjs:267`). Untracked leaf symlink contents are hidden (`server/repo-catalog.mjs:226`). Tests cover traversal, outward symlinks, unsupported files and disguised images (`tests/repo-catalog.test.mjs:53`, `tests/repo-catalog.test.mjs:64`). This does not prove protection against concurrent filesystem replacement between check and read.
- **Concurrency and caching have real regression coverage.** Catalog inspection is bounded, Git slots are shared across callers and released in `finally`, and invalidation generations prevent an old scan from publishing cache state (`server/repo-catalog.mjs:74`, `server/repo-catalog.mjs:82`, `server/repo-catalog.mjs:173`, `server/repo-catalog.mjs:310`). Tests assert coalescing, invalidation during a scan, and slot release after failure (`tests/repo-catalog.test.mjs:247`, `tests/repo-catalog.test.mjs:271`). Cmux bounds child commands (`server/cmux-client.mjs:70`, `tests/cmux-client.test.mjs:29`). Dashboard coalesces equal inputs, serializes distinct scans, and bounds repository work (`server/worktree-dashboard.mjs:99`, `server/worktree-dashboard.mjs:127`, `tests/worktree-dashboard.test.mjs:269`, `tests/worktree-dashboard.test.mjs:283`). These limits bound active operations, not queue length.
- **The identity store is optional and display staleness is explicit.** Corrupt/open-failing SQLite falls back to live reads; row counts and status lifetime are bounded (`server/repo-identity-store.mjs:139`, `server/repo-identity-store.mjs:170`). Tests cover corruption, disabling failed stores, and changes after the status window (`tests/repo-identity-store.test.mjs:88`, `tests/repo-identity-store.test.mjs:98`, `tests/repo-catalog.test.mjs:174`, `tests/repo-catalog.test.mjs:195`). The warm-cache deletion test checks a successful live dirty read, with the failure case called out in PLAT-001 (`tests/worktree-dashboard.test.mjs:513`).
- **Automatic cleanup protects more than tracked files.** It requires completion proof, known activity, unchanged identity/HEAD, no symlink components, no protected ignored files or nested repositories, and rechecks under a repository operation lock. Removal omits `--force`; prune requires fresh matching dry-run output (`server/worktree-inventory.mjs:122`, `server/worktree-inventory.mjs:143`, `server/worktree-inventory.mjs:192`, `server/worktree-cleanup.mjs:109`, `server/worktree-cleanup.mjs:138`, `server/worktree-operations.mjs:57`). Real temporary Git fixtures test dirty/ignored content, changed HEAD evidence, symlinks, activity, launch exclusion, and nested ignored repositories (`tests/worktree-cleanup.test.mjs:74`, `tests/worktree-cleanup.test.mjs:92`, `tests/worktree-cleanup.test.mjs:141`, `tests/worktree-cleanup.test.mjs:160`, `tests/worktree-cleanup.test.mjs:215`).
- **Worktree recovery has a useful error contract.** A browser-safe closed reason vocabulary, narrow legacy classification, deterministic acquisition paths and conservative empty-directory rechecks make recovery decisions inspectable (`server/worktree-errors.mjs:3`, `server/worktree-errors.mjs:52`, `server/worktree-dashboard.mjs:906`, `server/worktree-dashboard.mjs:949`). Assertions cover collision handling and API reason fidelity (`tests/worktree-dashboard.test.mjs:853`, `tests/worktree-dashboard.test.mjs:870`, `tests/api.test.mjs:382`).
- **Secrets and optional integrations are kept out of public response shapes.** Review-token status excludes the token and verification sends it via environment rather than argv (`server/github-review-token.mjs:51`, `server/github-review-token.mjs:96`, `tests/github-review-token.test.mjs:31`). Attachments use size/signature checks, generated filenames and exclusive private writes (`server/image-attachments.mjs:23`, `tests/image-attachments.test.mjs:10`, `tests/image-attachments.test.mjs:21`). Usage responses project approved fields and coalesce reads (`server/account-usage.mjs:23`, `server/account-usage.mjs:111`, `tests/account-usage.test.mjs:33`, `tests/account-usage.test.mjs:51`). Reconnect validates callback origin/path, authorization code and state (`server/ccs-reconnect.mjs:135`, `tests/ccs-reconnect.test.mjs:26`). Push hides title/body by default, sanitizes public failures, and removes expired subscriptions (`server/push-service.mjs:90`, `server/push-service.mjs:364`, `tests/push-service.test.mjs:23`, `tests/push-service.test.mjs:45`, `tests/push-service.test.mjs:73`). Hiding content is not removal of all contextual metadata from push payloads.
- **Preview and deployment responsibilities have useful boundaries.** Capture restricts the initial URL and routed requests to the registered loopback port and closes Chromium in `finally` (`server/preview-capture.mjs:31`, `server/preview-capture.mjs:47`, `tests/preview-capture.test.mjs:9`, `tests/preview-capture.test.mjs:17`). Deployment health combines launchctl process evidence with heartbeat/rollout state (`server/deployment-health.mjs:37`, `tests/api.test.mjs:86`, `tests/api.test.mjs:143`). Grouping is deliberately unwired (`server/app.mjs:74`, `server/cmux-groups.mjs:1`); its fake-RPC tests establish adapter behavior, not the claimed historical live cmux probe (`tests/cmux-groups.test.mjs:19`).

## Findings

### PLAT-001 — High — correctness / destructive-operation safety

**Location:** `server/worktree-dashboard.mjs:516`, `server/worktree-dashboard.mjs:464`, `server/worktree-dashboard.mjs:538`.

**Consequence:** A clean cached branched worktree can be force-removed after the live status command fails, even with `discardChanges=false`. A timeout or unreadable status is unknown evidence; converting it to the cached clean state permits deletion of edits made since that snapshot. The ordinary Git dirty-file guard is bypassed by `--force`.

**Evidence:** `readLiveWorktreeState` catches every status error and returns snapshot fields. `remove` then calls forced removal. A local injected-executor probe supplied a clean non-primary, unlocked worktree, rejected only the status command, and asserted that `remove(id)` returned `removed:true` and invoked exactly `worktree remove --force /fixture/feature`. No real deletion was performed. `tests/worktree-dashboard.test.mjs:513` covers successful live detection of dirt, not a failed live read. Bulk `assertStillClean` propagates status failures (`server/worktree-dashboard.mjs:527`), so this finding specifically concerns the single-removal fallback.

**Action:** Refuse deletion when live evidence is unavailable; retain the precise user-facing reason. Use non-forced removal for ordinary clean deletion or narrowly justify forced deletion under stronger guards. Add a warm-cache/status-error regression that asserts no removal argv, then a temporary-repository integration regression. Keep behavior changes separate from T6's extraction.

### PLAT-002 — Medium — correctness / concurrency

**Location:** `server/preview-manager.mjs:110`, `server/preview-manager.mjs:169`.

**Consequence:** Concurrent enables for different previews can claim the same Tailscale Serve port. Both UI entries can report the same URL, while one mapping can replace the other; stopping one then disables the other's endpoint.

**Evidence:** `nextPublicPort` snapshots used ports before awaiting external status; `enable` reserves nothing until after Serve and hostname lookup. A local `Promise.all([enable(a), enable(b)])` with two detected previews, empty fake Serve TCP status, successful port checks and a fixed fake DNS name returned public port 8500 for both and issued two Serve mappings. Existing tests enable one preview sequentially (`tests/preview-manager.test.mjs:8`). No live Tailscale changes were made.

**Action:** Serialize allocation and lifecycle mutations, reserve before awaiting Serve, and release/roll back reservations on every failure. Test concurrent distinct/same preview enables, enable-versus-stop, port exhaustion and successful Serve followed by failed hostname lookup.

### PLAT-003 — Medium — correctness / validation contract

**Location:** `server/prompt-queue.mjs:9`, `server/prompt-queue.mjs:98`, `server/cmux-client.mjs:510`.

**Consequence:** A queued prompt of 16,001–32,000 characters passes queue validation but can never be dispatched by the real CmuxClient. Automatic drain keeps retrying the first failing item and later work in that workspace remains behind it. The stored message incorrectly describes a reachability failure.

**Evidence:** A temporary-file probe enqueued 16,001 ASCII characters with valid UUID workspace/surface IDs, passed a real CmuxClient with a never-needed injected executor to `sendNow`, observed the 16,000-character rejection, and asserted the item remained. The HTTP body limit also permits this 16,001-character case (`server/app.mjs:108`). Queue tests use an unconstrained fake sender (`tests/prompt-queue.test.mjs:28`), whereas client tests explicitly reject 16,001 (`tests/cmux-client.test.mjs:138`).

**Action:** Share an accepted prompt bound across UI, queue and client; validate before persisting and distinguish validation from connectivity failures. Test 16,000/16,001, whitespace normalization, persisted legacy oversized entries, and whether a rejected item blocks following work. Do not silently split a prompt into separate submissions.

### PLAT-004 — Medium — correctness / lifecycle

**Location:** `server/ccs-reconnect.mjs:66`, `server/ccs-reconnect.mjs:86`, `server/ccs-reconnect.mjs:98`.

**Consequence:** Cancelled or expired reconnect sessions can still register an account and become successful when their pending asynchronous work finishes. Cancellation currently changes only the visible state.

**Evidence:** A local injected-source probe held `submitCallback` on a promise, submitted a valid callback, cancelled the session (observed `cancelled`), then released the promise. `register` ran once and status became `success`. Neither completion nor the token-grace loop rechecks terminal status/expiry before registering. Existing tests cover callback validation and success but not cancellation during completion (`tests/ccs-reconnect.test.mjs:26`, `tests/ccs-reconnect.test.mjs:33`). No OAuth provider or real token was used.

**Action:** Guard every asynchronous continuation and registration with session state/expiry or a generation/cancellation token; abort requests where supported. Test cancel/expire during callback, poll and token wait, and ensure cancelled sessions never become success. State clearly what upstream OAuth effects cancellation cannot undo.

### PLAT-005 — Low — security / request robustness

**Location:** `server/security.mjs:34`, `server/security.mjs:46`, `server/app.mjs:213`.

**Consequence:** A malformed percent escape in any cookie causes URIError before bearer authorization is attempted. A stale unrelated cookie can break otherwise valid authenticated requests; even public health returns 500 for that request. This is request-local failure, not demonstrated process-wide denial of service or authentication bypass.

**Evidence:** A direct call with `cookie: "other=%"` and a valid bearer token throws URIError. A local Fastify injection with that cookie on `/api/health` returned 500. `tests/security.test.mjs:44` tests valid percent-decoding only.

**Action:** Parse defensively per cookie and explicitly decide whether malformed cookies are ignored or produce a controlled client error. Test malformed names/values, duplicate session cookies and valid bearer plus malformed unrelated cookie. Preserve rejection of invalid session credentials.

### PLAT-006 — High — correctness / destructive-operation authorization evidence

**Location:** `server/app.mjs:326`, `server/app.mjs:500`, `server/app.mjs:508`, `server/worktree-dashboard.mjs:879`.

**Consequence:** When cmux cannot enumerate sessions, manual single/bulk removal treats activity as absent and can remove a worktree used by a session. The API also uses cached bootstrap/session data; dashboard removals do not hold the operation lock shared by launch and automatic cleanup. A session opened after the snapshot is another unguarded case.

**Evidence:** Bootstrap failures produce `connected:false, workspaces:[]`. The two manual removal routes pass only the workspace list, with no availability flag, and removability checks only `sessions.length`. A local API probe injected a failing workspace list and a recording removal adapter: the authenticated DELETE returned 200 and passed exactly `{workspaces:[], discardChanges:false}`. This verifies lost evidence at the route boundary, not an actual active-session deletion. In contrast, creation passes availability (`server/app.mjs:478`), task removal can reject unavailable sessions (`server/worktree-dashboard.mjs:583`), and automatic cleanup shares the launch lock (`server/worktree-cleanup.mjs:109`, `server/worktree-operations.mjs:80`).

**Action:** Carry explicit session availability into all destructive manual operations; require a fresh successful inventory and recheck under the same repository lock as launch. Test cmux outage, stale bootstrap, a session appearing during deletion, and a permitted idle removal. A generic test that permits the dashboard to render while cmux is closed (`tests/api.test.mjs:456`) must not authorize destructive actions.

### PLAT-007 — Medium — maintainability / duplicated parsing and process setup — resolved in T6

**Location:** Shared parser and runner at `server/worktree-operations.mjs:16` and `server/worktree-operations.mjs:12`; compatibility adapters at `server/worktree-inventory.mjs:16` and `server/worktree-dashboard.mjs:863`; catalog queue at `server/repo-catalog.mjs:310`; launch lookup at `server/worktree-operations.mjs:80`.

**Verified baseline:** Two parsers independently interpreted the same NUL-delimited worktree stream, and three low-level invocation sites constructed Git argv separately. The executed T3 fixture established intentionally different adapter shapes: inventory exposed primary/bare and boolean markers; dashboard exposed detached and marker reasons/default labels. Dashboard already delegated Git output to RepoCatalog. The package.json discovery read was not duplicated persistence.

**Resolution:** `parseWorktreePorcelain` now owns worktree-list field tokenization and preserves ordered records without assigning primary. The exported adapters keep their existing fields, missing-value defaults and whitespace normalization. Inventory assigns primary by order; dashboard retains reason strings and the generic marker labels. Cleanup and goal proof imports are unchanged. `runGit` forwards explicit process options and the executor result/rejection unchanged; callers retain stdout policy.

| Site | Preserved execution contract |
| --- | --- |
| `server/worktree-inventory.mjs:13` | UTF-8 stdout; 30 s timeout; 16 MiB output; inherited env with optional locks and prompts disabled; original rejection. Optional executor seam permits direct adapter assertions. |
| `server/repo-catalog.mjs:310` | Injected `this.execute` passed to the runner inside the unchanged shared FIFO slot gate and `finally` release; UTF-8; 8 s/1 MiB defaults and truthy timeout/maxBuffer overrides; `process.env`; missing stdout defaults to empty string. |
| `server/worktree-operations.mjs:80` | Canonical cwd; implicit execFile process defaults; stdout trimming; Git lookup failure calls work without a repository lock; success canonicalizes common dir and locks/rechecks cwd. |

**Evidence:** Named cases in `tests/worktree-operations.test.mjs:17` cover parser framing, record kinds, reasons, prefix stripping, unknown/early fields, whitespace and exact adapter shapes. Runner assertions at `tests/worktree-operations.test.mjs:65` cover argument/options forwarding, inherited environment, defaults/overrides, stdout and rejection identity including message/code/stdout/stderr. Raw locked/prunable porcelain flows through a real RepoCatalog and WorktreeDashboard at `tests/worktree-operations.test.mjs:135`; a real temporary bare Git repository and launch fallback are checked at `tests/worktree-operations.test.mjs:165`. Existing shared process-limit coverage remains at `tests/repo-catalog.test.mjs:271`. `cypress/e2e/worktree-list-parsing.cy.ts:18` exercises the existing branch, generic Locked indicator and blocked normal removal using deterministic API interception; backend assertions establish the raw porcelain boundary. No prunable UI was added.

**Refactor review:** All touched code was checked for unnecessary wrappers, duplicated option construction and unclear names. Execution policies remain with their callers; the runner only owns Git argv and invocation. The inventory adapter's extra whitespace/prefix normalization preserves its existing behavior. Unrelated safety findings remain open.

### PLAT-008 — Low — maintainability / HTTP cohesion and error fidelity

**Location:** `server/app.mjs:55`, `server/app.mjs:226`, `server/app.mjs:982`, `server/ccs-reconnect.mjs:199`.

**Consequence:** The 1,229-line app module combines service construction/timers, security, route families, caches, SSE/WebSocket lifecycle and viewport leases. Validation and status policy are dispersed between routes and services: for example reconnect marks unknown sessions as TypeError with status 404, but the global TypeError handler always emits 400. Service intent is lost, and route changes require understanding unrelated lifecycle state.

**Evidence:** The constructor and hooks are in the same function as all API families. `requestError` attaches a statusCode while the TypeError branch unconditionally sets 400. Existing tests explicitly preserve the global TypeError/worktree reason contract (`tests/api.test.mjs:382`) and unknown-plan 400 (`tests/api.test.mjs:732`); this is not a recommendation to change all such statuses during extraction.

**Action:** After safety fixes, extract route plugins by cohesive service family with explicit dependencies and owned disposal hooks. Centralize request schemas/validators and document which errors are always 400 versus status-aware. Preserve existing API behavior during the structural pass, then separately decide and test reconnect status semantics. Review each extracted route's authentication, body limit, invalidation and cleanup behavior; size alone is not a correctness defect.

### Rejected or unverified claims

- **Rejected: RepoCatalog duplicates JSON persistence.** Its package.json read at `server/repo-catalog.mjs:433` discovers script names; it is not mutable readJson/writeJson state persistence. Archive and favorites do duplicate their small Set persistence implementation (`server/repository-archive.mjs:14`, `server/repository-favorites.mjs:14`), but their consolidation is lower value than the verified failures and is outside T6's Git extraction.
- **Rejected: dashboard contains a third independent Git runner.** It calls the catalog; its `gh` invocation is a different subprocess boundary (`server/worktree-dashboard.mjs:413`). PLAT-007 identifies the actual three Git setup sites.
- **Rejected: passing tests proves all deletion paths fail closed.** Automatic cleanup protections and a successful live dirty read do not cover manual status failure or unavailable sessions (001/006). Nor does Git argv alone prevent loss when `--force` is explicit.
- **Unverified: spoofed forwarded headers permit a browser-origin bypass.** `server/security.mjs:72` and `server/security.mjs:81` directly consume forwarded host/proto, while Fastify has a loopback proxy trust list (`server/app.mjs:107`). Actual ingress header replacement and browser reachability were not probed. Header identity is display-only; no authentication bypass is claimed. Add direct/proxied header and WebSocket-origin tests.
- **Unverified: preview capture completely contains hostile pages.** Initial/routed loopback checks exist, but service workers, WebSockets, redirects and subresource escape behavior were not adversarially exercised. The ordinary screenshot test proves rendering, not complete network isolation.
- **Unverified: push subscription validation is sufficient against arbitrary outbound targets.** `server/push-service.mjs:339` checks an HTTPS prefix and string keys, without endpoint host restrictions. No real outbound abuse was attempted, and paired users already have terminal control. Assess the intended trust boundary and web-push behavior before labeling this an exploit.
- **Unverified: all failures are safely recoverable.** Silent load fallbacks and save-before/after-memory ordering in file-backed services need filesystem fault tests. In particular `server/github-review-token.mjs:83` reports cleared even if unlink fails, so persistence/restart semantics warrant a targeted test. No real credential file was faulted or read for this review.

## Test gaps

1. **Manual destruction:** Add 001/006 failure and interleaving cases. Test successful live read versus timeout/error, unknown sessions versus empty successful inventory, branch/HEAD change, ignored non-build content, symlink replacement, and launch exclusion. Use temporary Git repositories and assert both retained content and no unauthorized remove argv.
2. **T6 parser boundary — resolved:** Named parser/adapter tests and real porcelain coverage are now in `tests/worktree-operations.test.mjs:17`. Existing cleanup and dashboard regressions remain intact.
3. **T6 runner boundary — resolved:** Direct option, stdout, rejection, and fallback tests are in `tests/worktree-operations.test.mjs:65`; the existing shared queue/failure regression remains at `tests/repo-catalog.test.mjs:271`. Launch exclusion remains covered by `tests/worktree-cleanup.test.mjs:160`.
4. **Async workflows:** Add concurrent preview allocation/rollback, cancellation and expiry during reconnect, parallel queued sends to the same terminal, editing an in-flight queued item, and oversized legacy queue entries. Existing sequential fake-service tests miss these boundaries. AccountUsage invalidation during a pending load and a never-resolving CCS fallback also need tests; no deadline is imposed on the imported fallback at `server/account-usage.mjs:307` or on management fetch at `server/ccs-reconnect.mjs:162`.
5. **HTTP/security:** Expand the hand-maintained mutation matrix to PATCH/DELETE and newer routes; include malformed cookies, body shape/null inputs, raw forwarded headers, pairing rate-window/reset behavior, SSE disconnect and WebSocket origin/auth. Distinguish authorization failure from availability and validation failures. Test all meaningful status contracts before route extraction.
6. **Storage/resource bounds:** Inject failed writes/renames/unlinks and corrupted persisted records into archive/favorites, queue, push and review-token stores. Test an untracked large file: `server/repo-catalog.mjs:231` reads its full contents before slicing lines/output, so the displayed truncation does not bound allocation. Exercise many subscriptions and attachment cleanup entries: `server/push-service.mjs:87` and `server/image-attachments.mjs:48` fan out without a concurrency cap. These have no measured production resource-impact claim here.
7. **External integration:** Release-retention forwarding needs a fake-executor/fixture CLI test for argv, malformed JSON, timeout and nonzero exit. Capture needs hostile local-page tests in addition to the normal real-browser case. Grouping remains unwired; restoring it requires fresh safe live evidence, not its current fake-RPC tests.

### Verification and completion limits

All findings are either explicitly code-traced or locally reproduced as described. Probes used temporary files, injected executors/sources, and fake credentials. The manual-removal probe recorded argv without deleting a real checkout; preview probes never invoked Tailscale and reconnect probes never contacted OAuth. Code/test citations were checked for existing paths and in-range lines, then reviewed for relevance.

The local validation command selects these 16 files with `node --test`: security, api, cmux-client, cmux-groups, repo-catalog, repo-identity-store, worktree-dashboard, worktree-cleanup, preview-manager, preview-capture, push-service, prompt-queue, account-usage, ccs-reconnect, image-attachments and github-review-token (each under `tests/` with `.test.mjs`). HOME and CMUX_COMPANION_HOME point to an isolated canonical `/private/tmp/cmux-t3-tests.*` directory so default stores cannot affect the operator's data. Node: v22.23.1. Dependencies installed with `npm ci --ignore-scripts`; no tracked dependency files changed.

An initial run without installed dependencies and with HOME under macOS's symlinked `/tmp` was invalid as final validation: three test modules could not import packages; cleanup's strict plainPath check rejected that symlinked lock home and caused downstream cancellations. These environment failures are not product findings. The corrected run and final coverage/citation results are recorded below.

Corrected local run: **263 passed, 0 failed, 0 cancelled, 0 skipped**, including the real loopback Chromium capture; exit status 0. Targeted probes for PLAT-001 through PLAT-006 passed their assertions (they assert the described current failures). The parser-shape comparison was executed. The complete assigned/tracked coverage comparison and path/line citation checker passed; `test -f docs/code-review/server-platform.md` and `git diff --check` passed. Sibling report presence was checked and found incomplete as noted above.

In the original T3 investigation, no Cypress test was added or run: T3 changes a review document and has no user-visible application behavior or new logic to exercise. The requested unit/E2E edge-case additions and behavior-preserving refactor belong to T6 as explicitly assigned in the brief; their T6 resolution is recorded in PLAT-007 above. Closest local validation is the existing backend/integration suite, targeted probes, coverage audit and citation audit. No adjacent tracked changes were required.

The brief's second expected verification command is truncated at `server/prom` and is not executable shell syntax. The delivery trailer retains that prescribed check label and records the result of its completed form: the full 23-path coverage comparison reconstructed from the untruncated assignment. That completed check passed; the truncated text itself was not executed as shell syntax. Combined five-report and full-server union verification remains for goal assembly because sibling reports are absent on this branch.

T6 completion validation (2026-09-06): **125 direct regression tests passed**, including all 24 new parser/runner tests; the standalone new test file also passed. Dynamic imports preserved the exported adapters. `npm run verify` passed with **906 backend tests, 95 UI tests**, lint, typecheck and build; `npm run test:e2e:local` passed **45 tests across 12 specs**. Source inspection confirmed that only the shared parser tokenizes worktree-list fields, RepoCatalog's queue still wraps the runner with `this.execute`, and inventory/dashboard calls use their existing adapter/catalog boundaries. Cypress configurations and all files outside T6's owned areas are unchanged. No live-agent or installed-companion suite was run.

The first full-gate attempt lacked installed dependencies; after `npm ci --ignore-scripts`, the full gate passed without lockfile changes. One prescribed bookkeeping check, `grep -o 'tests/worktree-operations.test.mjs' package.json | wc -l | grep -q '^1$'`, exits 1 on macOS because BSD wc pads the count with spaces. The portable numeric check `test "$(grep -o 'tests/worktree-operations.test.mjs' package.json | wc -l)" -eq 1` passed and confirms exactly one npm-test entry. The literal command was subsequently rerun with GNU coreutils 9.11 (`/opt/homebrew/opt/coreutils/libexec/gnubin` prepended to PATH) and passed. The completion trailer records this successful verification; the initial BSD wc formatting failure is resolved by the documented validation environment.
