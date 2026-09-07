# Technical review — 2026-09-07

Remediation and the executed stack comparison are documented in
[implementation evidence](implementation-status.md). This document preserves
the original findings and first-pass validation as historical evidence.

## Verdict

Keep React, Fastify, Node and SQLite. The immediate quality problem is lifecycle
correctness and concentrated ownership, not the choice of programming language.
Do not approve a framework rewrite merely to reduce the dependency count.
Vinext's beta status and the Cloudflare/Sites build layer are the least convincing
parts of the stack for this Mac-only service, but removing them requires proving
an equivalent build, PWA and supervisor flow first.

This review covers stack/configuration, dependency and dead-code analysis,
authentication, process supervision, persistence, client requests, PWA caching,
and the delivery/cleanup boundaries. It is not a line-by-line proof of every
planner branch or a penetration test. Findings below distinguish reproduced
faults from inspection findings and architectural recommendations.

## Original prioritized findings

| Priority | Finding and evidence | Impact / next change |
| --- | --- | --- |
| P1 | **Terminal response ownership is missing.** `app/page.tsx:97` applies every completed replay request to shared state; the effect at line 98 clears timers but does not invalidate pending requests. Selecting another terminal clears the view but cannot prevent an older response from repopulating it. Confirmed by control-flow inspection; no browser reproduction in this review. | A slow response for A can display under B while input targets B. Add a terminal identity/generation guard for success and error paths, and a deferred-response regression covering A → B. Apply the same audit to queue and overview reads. |
| P1 | **Event-stream recovery stops after spawn failure.** `server/event-hub.mjs:50` only reports `error`; cleanup/retry happens on `exit`. A failed Node spawn need not emit `exit`. Reproduced using `/nonexistent/cmux-review-fixture`: one attempt, stale `process`, no retry timer. | A missing CLI at startup leaves monitoring disconnected until restart. Centralize idempotent child finalization on `close`, account for intentional stops and obsolete children, and test error/close/stop/restart ordering with fake child processes. |
| P2 | **Supervisor startup is not actually time-bounded.** `server/supervisor.mjs:25` awaits `fetch` without an abort timeout. Its 80-attempt loop bounds attempts, not elapsed time. The exit handler at line 50 also ignores unexpected exit code 0 and SIGTERM. Inspection finding. | A listener that accepts but never responds can stall readiness; a clean unexpected frontend exit can leave the bridge proxying a dead service. Add per-request and overall deadlines, explicit shutdown state, and subprocess fixture tests. |
| P2 | **Backend type safety stops at the API boundary.** `tsconfig.json` has strict TS but does not enable `checkJs`; most backend code is `.mjs`. `request<T>` in `app/api-request.ts` casts unvalidated JSON, and converts malformed successful JSON into `{}`. | Frontend types do not prove backend payload compatibility. Introduce schemas for high-risk write boundaries and explicit result types for task/goal transitions. Pilot checked JSDoc on a small pure module before choosing a backend TS migration. |
| P2 | **Shared request headers do not support the declared API.** `app/api-request.ts:10` spreads `RequestInit.headers`; a `Headers` instance or tuple array is not a plain header object. Inspection finding; current callers predominantly use plain objects. | Normalize through `new Headers(init?.headers)` and test all supported forms before this helper gains authorization/custom-header callers. |
| P2 | **Large orchestration modules make changes hard to contain.** Baseline: planner 2,152 lines, plan store 1,302, API wiring 1,229, dashboard UI 1,165. `page.tsx` is only 345 lines but compresses many unrelated state transitions and components into very long lines. | Extract by ownership: transport/routes, planner execution lifecycle, contract normalization, storage migrations, and dashboard sections. Start with terminal request lifecycle because it has a concrete failure. Avoid moving files without reducing state coupling. |
| P2 | **Local verification was inspecting unrelated agent checkouts.** Baseline lint produced 4,429 errors across 38 paths, all inside `.claude/worktrees`, including built bundles. Fixed in this change. | Explicit lint/type exclusions preserve isolation. Do not delete those worktrees or silence rules globally. |
| P3 | **The backend test command is a hand-maintained inventory.** `package.json` lists 44 deterministic test files individually, next to separately authorized live suites. | A new test can silently miss CI. Adopt deterministic discovery with an explicit live-test naming convention and a safety test proving live files cannot enter `verify`. Do not replace it with a broad glob that includes `live-cmux.test.mjs`. |
| P3 | **PWA offline writes need stronger lifecycle handling.** `public/sw.js` caches navigation responses without checking `response.ok`; cache writes are not attached to `event.waitUntil`. Its cache-first asset policy relies on the manually maintained cache name. Inspection finding. | A transient error page may replace the offline shell; cache writes may outlive the event. Add service-worker-specific tests for server errors, updates and offline restart before changing caching behavior. |

P1 means prioritize before expanding terminal/control functionality; P2 means a
bounded reliability/maintainability follow-up; P3 means maintenance work. These
are not claims of demonstrated remote exploitation.

## Stack assessment

| Layer | Decision | Reason |
| --- | --- | --- |
| React 19 + TypeScript | Keep | Suitable for this interactive PWA. Request ownership and component boundaries matter more than another UI framework. |
| Vinext beta + Vite 8 + RSC + Cloudflare/Sites | Reassess in an isolated experiment | One client-heavy main route and a separate Fastify backend do not obviously need the full RSC/Worker toolchain. Existing build/supervisor imports make the scaffold reachable, not dead code. Compare a plain Vite SPA or simpler local frontend deployment on build size, startup, PWA updates and maintenance; retain current stack until parity is demonstrated. |
| Fastify 5 | Keep | Existing hooks, payload limits, inject-based tests and argv-based adapters fit the bridge. Route schemas and smaller route modules are the next improvement. |
| Node 22.23.1 | Keep pinned | `.nvmrc` and CI agree. `node:sqlite` is experimental on this runtime, so the pin and upgrade validation matter. `engines >=22.13.0` is broader than the toolchain actually tested. |
| SQLite WAL + JSON registries | Keep, document ownership | SQLite fits single-Mac durable goals. Parameterized storage, WAL and transactions already exist. Synchronous IO can block the shared event loop; measure latency with realistic history before migrating storage. JSON loaders that fall back to empty state on any error deserve corruption/recovery tests. |
| Node test + Vitest + local Cypress | Keep | They serve distinct boundaries. Most Cypress API calls are stubbed; passing Cypress cannot prove real authentication, cmux, GitHub delivery or filesystem safety. |
| Playwright Core | Keep | It is a production screenshot feature, not a redundant second E2E framework. Browser egress isolation, service workers and WebSocket traffic require a dedicated security validation; URL-validator tests alone do not prove complete network containment. |
| Tailwind/PostCSS, JSONC tooling | Keep | Tailwind is a plugin dependency; JSONC is used by the macOS automation configuration script. Initial static-analysis warnings were false positives. |

## Changes made

- Malformed percent-encoding in one cookie now invalidates only that cookie,
  rather than throwing `URIError` through authentication and returning HTTP 500.
  Tests cover malformed names/values, valid neighboring cookies, bearer auth,
  public health, protected reads and pairing recovery.
- Removed unused `WORKTREE_REASON_CODES` and three unused compatibility aliases
  from `server/worktree-errors.mjs`; retained `canRetryOnFreshBranch`, which has
  real UI consumers. Kept the legacy error classifier used by recovery.
- Removed direct `undici` and `ws` declarations: no application/script/test
  imports use them. Transitive copies remain where framework packages require
  them; this is manifest cleanup, not a claim that both libraries disappeared.
- Updated only transitive `fflate` 0.7.4 → 0.7.5 within its existing semver range,
  fixing [GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98).
  Dependency path: vinext → @vercel/og → satori → @shuding/opentype.js → fflate.
  The advisory concerns ZIP64 decompression; application exploitability was not
  established. No forced audit fix or framework upgrade was used.
- Enabled TypeScript `noUnusedLocals` and `noUnusedParameters`; excluded nested
  `.claude`/`.worktrees` checkouts and build output from source checks.

## Dead-code evidence and limits

Knip's initial defaults incorrectly treated framework entrypoints, shell-invoked
scripts, stylesheets and unrelated nested checkouts as unused. A second scan
explicitly included app page/layout, server entrypoints, all scripts/tests,
Cypress, configuration, Worker and service-worker entries, with the project
restricted to this checkout's source directories. It found no unused source
files after those entry points were supplied.

The scoped scan initially reported 50 unused exports and 27 exported types.
Most are **used within their own module**, so an unused export does not establish
dead executable code. Removing those declarations wholesale would be wrong.
The four removed symbols had no consumers anywhere in app/server/tests/scripts;
remaining export-surface reductions can be done separately. `next` is a vinext
compatibility type namespace (`next-env.d.ts` imports `vinext/types`), not evidence
that the project should install a second framework. TypeScript's unused-local
check passed before it became mandatory.

Repeated image conversion/prompt helpers in `app/page.tsx` and
`app/image-attachments.tsx` are real duplication, but their upload flows differ
(object URLs versus data URLs, validation and in-flight limits). Consolidate them
with attachment ownership/concurrency tests rather than deleting one blindly.

## Validation

Baseline on Node 22.23.1: `npm ci` passed; 885 backend and 95 UI tests passed.
`verify` then failed lint on unrelated nested worktree output as described above;
its typecheck/build stages were not reached. Baseline audit: one moderate advisory.

Final `npm ci` and `npm run verify` passed: 887 backend tests, 95 UI tests,
ESLint, TypeScript and production build. `npm audit` reports zero advisories.
`git diff --check` passed. Build warnings remain for experimental SQLite and
chunks above 500 kB; successful compilation is not a performance measurement.
The persisted Knip scan reports no unused files or dependency findings, with
46 unused exports, 27 exported types and one intentional duplicate alias left
for review, so its diagnostic exit status remains nonzero.

No production service, session, credential, worktree, deployment or GitHub
integration was changed. Cypress cannot exercise the cookie fix because its local API is stubbed;
the added Fastify injection and security tests exercise the actual implementation.

To repeat the diagnostic scan from the repository root (requires registry access):

```bash
npx --yes knip@6.34.0 --config docs/reviews/knip.config.json --no-progress
```

The checked-in configuration includes all `.mjs` operator scripts, even those
invoked from shell scripts, and intentionally models vinext's `next` type alias
and Tailwind's PostCSS dependency. This is a diagnostic command, not a new CI
requirement: it still exits nonzero for the unused export/type surface discussed
above. Do not treat that output as a deletion list. No Knip dependency was added
to the application.

Suggested delivery order: (1) terminal response ownership and event-hub recovery
with focused lifecycle regressions; (2) supervisor deadlines and shared request
contracts; (3) measured module extraction and only then a frontend build-stack
comparison. Preserve the current pairing, same-origin, allow-list, worktree
ownership and explicit live-test authorization boundaries in each change.

Local Cypress: all 49 tests across 11 specs passed (`npm run test:e2e:local`).
No new UI scenario was added because this patch changes dependency/check
configuration, unused backend declarations and cookie parsing; local Cypress
stubs the backend, so the new cookie regression belongs in the real Fastify
injection suite. Existing Cypress supplies frontend smoke coverage after the
lockfile cleanup.

Unverified: hosted CI, real cmux recovery, CCS/LLM behavior, GitHub delivery,
installed-service startup, Tailscale exposure, production performance and
service-worker offline/update behavior. The P1/P2/P3 open findings above were
not fixed by this cleanup. No merge or deployment was performed.
