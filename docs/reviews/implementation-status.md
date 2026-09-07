# Technical review implementation — 2026-09-07

All findings from the [original review](2026-09-07-technical-review.md) have a
concrete implementation or an executed, evidence-based architectural decision.
React, Fastify, Node 22 and SQLite remain the production stack. The SPA experiment
is retained for comparison; a deployment migration was not selected.

## Requirement-by-requirement evidence

| Requirement | Resolution | Evidence |
| --- | --- | --- |
| Terminal, queue and overview response ownership | `useOwnedRead` separates resource owners, coalesces reads only within that owner, invalidates stale callbacks and hides another owner's value/error immediately. Terminal, queue and health reads use it. | `ui-owned-read.test.tsx`: delayed success/error, A → B → A, clear and unmount; `terminal-response-ownership.cy.ts`: actual Home switching terminals with delayed replay and queue responses. |
| Event-hub recovery and child ownership | `close` finalizes failed spawns and exits; obsolete/stopped children cannot disconnect or restart replacements. Connection is reported after `spawn`; stderr is drained. | `event-hub.test.mjs`: fake event ordering, stop/retry cancellation, late old-child events and repeated real ENOENT failures. No real cmux executable was run. |
| Supervisor deadlines and shutdown | `frontend-supervisor.mjs` owns bounded HTTP readiness, the frontend and bridge lifetime, clean/unexpected exit handling, idempotent stop and kill escalation. The CLI owns process signals from startup. | `frontend-supervisor.test.mjs`: real disposable subprocesses with a hung HTTP listener, unexpected exit 0/SIGTERM, explicit shutdown and failed bridge startup. |
| Request headers and JSON | All `HeadersInit` forms normalize through `Headers`; invalid successful JSON throws explicitly; empty 204/HEAD and malformed error responses retain their HTTP semantics. | `ui-api-request.test.tsx`: header object/Headers/tuple forms, JSON failure/retry, empty success and non-JSON error status. |
| High-risk writes and typed transitions | Schemas reject malformed terminal input/keys, queue writes, respawn and goal creation/edit controls without coercion or silently removing fields. Domain checks still enforce identity/ownership. Strict checked-JSDoc modules own planner phases and normalized task launch results. | `api.test.mjs`: malformed controls make no cmux calls; schema rejection closes the progress trace. `task-launch-result.test.mjs`: invalid task evidence rolls back, invalid phases reject and snapshots cannot mutate the registry. `tsconfig.backend.json` runs in `verify`. |
| Module ownership | Process transport, model reply parsing, planner HTTP routes, SQLite schema/migrations, UI read lifecycle and follow-up form state now have separate modules. | Existing planner/store/API/UI regressions pass after extraction. Planner: 2,152 → 1,891 lines; store: 1,302 → 1,132; API: 1,229 → 1,112. Sizes are context, not quality scores. |
| Deterministic test discovery | `run-backend-tests.mjs` selects top-level deterministic tests, excluding both current and legacy live naming. cmux live tests now use `cmux.live.mjs`. | `test-discovery.test.mjs` proves newly added tests are included, discovery does not execute fixtures, and every live npm entrypoint is excluded. CI still runs the same `verify` command. |
| PWA cache lifecycle and updates | Build digests replace the manual cache counter; all built JS/CSS is precached with the shell. HTTP errors never replace cached success, event lifetime includes writes, quota failure preserves valid responses, development bypasses caching and activation preserves unrelated caches. | `service-worker.test.mjs` plus real Chrome `service-worker-browser.test.mjs`: install, offline entrypoint execution, update, and a new page opening offline on the new version. |
| Shared image uploads | Sessions and goal sheets use one validator/uploader. Capacity is reserved before async work; generation/owner changes invalidate results; all previews use data URLs without leaking object URLs. | `ui-image-ownership.test.tsx`: simultaneous uploads, four-image cap, removal, owner switch and clearing in-flight uploads; existing image UI scenarios pass. |
| Unused exports/declarations | Reviewed and demoted 73 unused export/type declarations, removed the remaining compatibility alias, obsolete group-name helper chain and three dead frontend result types. Live functions used within their module remain intact. | Scoped Knip is clean; lint and TypeScript unused-local/parameter checks pass. The diagnostic configuration includes framework, script, test and experiment entries. |
| Runtime and isolated checks | Package engines now declare the supported Node 22 range starting at 22.23.1; README, `.nvmrc` and CI agree. Lint/types ignore nested agent checkouts and generated outputs. | Clean `npm ci` under Node 22.23.1, unchanged CI command, source checks pass without inspecting unrelated worktrees. |
| Persistence recovery and latency | Six JSON registries use a shared reader that preserves invalid bytes privately before default recovery and propagates non-ENOENT IO errors. Single-writer ownership and manual recovery are documented. SQLite remains synchronous based on the isolated benchmark below. | `private-json-state.test.mjs` plus queue/push/preview/issue tests; a 34.5 MB, 200-goal synthetic SQLite benchmark executes real store reads/writes. |
| Preview egress | Routes are installed at browser-context scope before pages open; service workers are blocked and WebSockets have their own registered-port restriction. | Real Chrome preview test executes page JS: registered-port HTTP succeeds; cross-port HTTP, WS upgrade, popup requests and SW registration do not reach their fixture servers. |
| Frontend-stack reassessment | Built the same app as a plain Vite SPA, measured build/startup/artifacts, and ran the same Cypress suite against it. Retain the production vinext integration; keep the experiment separate. | `experiments/local-spa`, `compare-frontend-stacks.mjs`, and the comparison below. No installer/updater migration or publishing was performed. |

## Stack experiment and decision

One local run on macOS arm64, Node 22.23.1, using installed dependencies:

| Measurement | Current vinext build | Plain Vite SPA |
| --- | ---: | ---: |
| Build command wall time | 4,334 ms | 461 ms |
| Process start to successful HTTP page | 464 ms | 194 ms |
| Public client files | 17 | 7 |
| Total public artifact bytes | 1,174,704 | 954,115 |
| JavaScript bytes | 964,008 | 744,610 |
| Sum of gzipped JavaScript bytes | 285,657 | 219,934 |
| CSS bytes | 171,917 | 171,778 |
| Same local Cypress suite | 51/51 | 51/51 |

The SPA removes about 23% of shipped JavaScript bytes and builds substantially
faster in this run. CSS is essentially unchanged, as expected for the same app.
These are artifact totals, not measured first-load transfer or mobile latency;
build/startup figures are single-run observations, not statistical guarantees.

**Decision:** retain vinext in the installed product and retain the isolated SPA
experiment. The SPA is a viable UI simplification, but the production supervisor
and external updater currently expect the vinext release layout. Cypress proves
UI parity against fixtures, not installed update/rollback parity. Replacing that
contract without equivalent installation evidence would trade a proven local
service for an unverified deployment change. This completes the requested
reassessment; it does not silently turn an experiment into a migration.

Reproduce with `node scripts/compare-frontend-stacks.mjs`, then
`node scripts/run-local-cypress.mjs --spa-experiment`. Both commands are local;
the experiment has no API proxy to the installed bridge. Service-worker behavior
is tested separately because Cypress intentionally disables it.

## Persistence measurement and decision

`node scripts/benchmark-plan-store.mjs` creates and deletes its own temporary
SQLite database: 200 goals, eight tasks each, four saved rounds per goal,
34,488,320 bytes. One hundred samples per operation produced:

| Operation | Median | p95 | Maximum |
| --- | ---: | ---: | ---: |
| List 200 goals | 5.75 ms | 6.86 ms | 15.55 ms |
| Read one goal's detail/history | 0.19 ms | 0.20 ms | 0.82 ms |
| Persist one failure-state update | 0.27 ms | 0.33 ms | 1.55 ms |

Retain SQLite and the current writer model. The measured workload does not
justify a database migration or worker-thread rewrite. These figures measure
synchronous operation time on this Mac, not production end-to-end latency,
concurrent process contention, arbitrarily large retained histories or disk
failure. Continue using WAL and one writer; permissions/corruption must never be
interpreted as evidence that user history was empty.

## Verification and limits

Final local results on Node 22.23.1:

- `npm ci`: passed; lockfile and supported runtime agree.
- `npm run verify`: passed, including 910 backend tests, 106 UI tests, ESLint,
  frontend TypeScript, strict checked backend modules, and the stamped production
  build. No backend tests were skipped on this Mac.
- `npm run test:e2e:local`: 51/51 passed on the current frontend.
- `node scripts/run-local-cypress.mjs --spa-experiment`: the same 51/51 passed.
- `npx --yes knip@6.34.0 --config docs/reviews/knip.config.json --no-progress`:
  passed with no findings or configuration warnings.
- `npm audit`: zero advisories.
- `git diff --check`: passed.

Intermediate failures were resolved: the first upload test failed to settle its deferred response,
the first Cypress replay fixture omitted `mode: "text"`, and schema validation
initially bypassed progress termination and the established image error message.
The corrected tests retain those behavior checks; no regression coverage was
removed to obtain a passing result. Progress response headers are now flushed
immediately instead of waiting for the 15-second heartbeat.

No live agent, installed bridge, Tailscale exposure, GitHub delivery, hosted CI,
merge or deployment was exercised. Browser tests use disposable loopback
fixtures; they prove the specific HTTP/WS/service-worker behaviors described
above, not an operating-system network sandbox. Experimental SQLite and large
client-chunk build warnings remain visible. The checked-JSDoc pilot does not
claim that the entire backend is statically typed.
