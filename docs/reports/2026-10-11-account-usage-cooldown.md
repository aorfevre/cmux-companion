# Account usage request limits and provider cooldowns

## Result

All clients of the running Companion service now share a server-side usage
request budget for each provider/account. Every attempt consumes at least one
minute, including failures. Concurrent reads share the pending request. Manual
Refresh, tab focus, snapshot invalidation and credential rotation cannot force
another usage request during that interval. Cached quota keeps its original
observation timestamp. Automatic page reads also use the ordinary snapshot cache.

An HTTP 429 waits 2, 4, 8, 16 and then 30 minutes between attempts until success
resets the backoff. Valid Retry-After seconds or HTTP dates extend that wait when
longer, even beyond the 30-minute exponential cap. Invalid, missing or past values
cannot shorten the wait. Healthy accounts continue independently; there is no
timer or queued retry storm. The next eligible client request may retry.

Account rows display a retry countdown, then Ready to retry usage when eligible.
The provider failure stays unknown rather than becoming fabricated capacity.
Claude profile metadata uses a separate endpoint budget with the same minimum
interval and its existing 15-minute successful cache. Credential rotation may
invalidate that longer cache but cannot bypass its minimum interval or cooldown.
Codex errors no longer fall back to a second CCS quota request within the same
attempt; expired credentials show the existing reconnect state.

## Ownership and boundaries

The implementing agent owns the provider adapters, shared polling cache, UI and
regression checks. The existing authenticated API adds a sanitized retryAt field;
pairing, same-origin checks and exact-account credential lookup are unchanged.
The cache stores normalized results and deadlines in the service's memory, is
separate from snapshot invalidation, and is shared by every tab and client through
the existing AccountUsage instance. It introduces no disk state, migration,
background worker or additional provider call.

These limits govern this running Companion service. They reset on service
restart and cannot control requests from CCS, Claude Code, another application
or another service process. The separate profile endpoint is not a usage poll.
No live quota requests were needed for this implementation. The spec was amended
in its own commit before code changes; no plan was introduced, and the unrelated
untracked burst-scan plan was left untouched.

## Verification

Passed on Node.js 22.23.1:

- `node --test tests/account-poll-cache.test.mjs tests/account-usage.test.mjs`:
  37 passed after the assertion correction described below.
- Focused account-usage Vitest suite: 28 passed.
- `npm run verify`: 1,039 backend tests passed, zero failed and one platform
  skip; 202 UI tests across 21 files passed; lint, typecheck and production build
  passed. Backend line coverage was 97.40% and UI line coverage was 95.25%, both
  above the unchanged 90% thresholds. The new polling cache had 100% line,
  branch and function coverage.
- `npm run test:e2e:local -- --spec cypress/e2e/account-usage.cy.ts`:
  all 16 account-usage journeys passed on the first run. The disposable harness
  stopped its owned services afterward.
- `git diff --check` passed. Mobile and desktop availability screenshots were
  inspected: the rate-limit explanation and retry countdown remain readable.

The backend skip is the existing non-UTF-8 filename case: macOS rejects those
filenames before Git can observe them. Electron's desktop full-page screenshot
is clipped at the physical display's right edge; the 1440-pixel viewport and
no-horizontal-overflow assertions passed. No check failures remain.

The focused backend checks count outgoing requests through the real CCS loader
with disposable credentials and mocked providers. They exercise force refresh,
concurrent reads, invalidation, credential rotation, retained timestamps,
independent healthy accounts, both provider 429 paths, profile cooldown and Codex
fallback exclusion. Cache tests cover the exact minute boundary, slow pending
requests, ordinary errors, the exponential cap, Retry-After parsing and recovery.

Cypress stubs the authenticated account-usage response, so it verifies the visible
countdown and Refresh behavior; upstream request counts are verified by the
backend tests rather than inferred from browser requests.

## Interventions and remaining gaps

The first focused backend run passed 36/37. One new assertion expected Low for a
Codex fixture reporting 20% used (80% remaining); the correct expectation is Ready.
That assertion was corrected and the focused suite passed. No production behavior
or coverage threshold was weakened.

Live provider recovery and the separate native/macOS integration suite were not
run; this change does not touch native adapters. This change prevents Companion from
retrying too frequently; it does not guarantee Anthropic will accept the next
request. The polling fix has not been installed in the running service. Review,
merge and installed rollout remain separate from local fixture verification.
