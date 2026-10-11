# Account usage availability and subscription labels

## Result

Next weekly reset and its All accounts highlight now select the earliest future
overall weekly reset with positive remaining weekly quota. A fully used account
stays visible in the chronological queue. Paused accounts or accounts with an
exhausted secondary window can still have unused weekly quota; their constraints
remain visible, and the separate usable-capacity summary still excludes them.

All accounts explicitly shows the subscription plan, including Claude Team,
Enterprise, Pro, Max, Max 5× and Max 20× when reported. Unknown metadata says
Plan not reported. Existing Codex plans receive readable labels. Usage failures
retain account rows and explain missing credentials, missing provider limits or
provider rate limiting. The queue explains why missing weekly readings cannot
appear there.

## Diagnosis

The screenshot's Claude Gmail account was already listed under All accounts but
had no available quota. A targeted, read-only diagnostic on 11 October 2026 found
its exact CCS credential and observed HTTP 429 (`rate_limit_error`) from
Anthropic's usage endpoint. The same account's profile endpoint returned HTTP 200
with `claude_max` and `default_claude_max_20x`. This identifies a temporary usage
API rate limit and a Max 20× plan; it does not establish subscription exhaustion.
No successful live weekly reading was available for that account.

## Boundaries and ownership

The implementing agent owns the UI, adapter, tests and cleanup. The existing
authenticated account-usage API response already has plan and message fields;
no API route, pairing or same-origin change is required. Claude profile reads use
the same exactly matched account credential as quota reads, against a fixed
Anthropic endpoint, with a 12-second timeout. Only a normalized plan leaves the
adapter. Profile failure cannot discard successful usage.

An instance-local cache keeps successful plans for 15 minutes and failed profile
lookups for one minute; credential changes invalidate the matching cached plan.
No profile data or credentials are persisted, and no storage migration or
background worker is involved. Provider routing, login state and installed
services are unchanged. The separate spec commit precedes implementation; no
implementation plan was introduced. The unrelated untracked burst-scan plan is
untouched.

## Verification

- `node --test tests/account-usage.test.mjs`: 29 passed, covering exact-account
  lookup, subscription payloads, rate-limit messages, cache expiry/credential
  rotation, profile failure and raw-profile sanitization.
- Focused account-usage UI suite: 27 passed, including an earlier saturated
  account, all-saturated empty state, secondary-limit constraints, plan labels
  and visible failure reasons.
- `npm run verify`: passed. Backend: 1,031 passed, one existing macOS skip for
  invalid UTF-8 filenames; line coverage 97.39%. UI: 201 passed across 21 files,
  line coverage 95.25%. Both 90% thresholds remain unchanged. Lint, frontend and
  backend typechecks, and production build passed.
- `npm run test:e2e:local -- --spec cypress/e2e/account-usage.cy.ts`: 16/16 passed
  after the assertion correction below. Includes 390/1280/1440-pixel home checks,
  new plan/rate-limit journeys at 390 and 1440, Setup, pairing, refresh recovery,
  reconnect and confirmed deletion. Desktop/mobile screenshots were inspected;
  generated screenshots are not committed.
- `git diff --check`: passed. The local Cypress harness stopped its owned
  frontend/browser processes. No installed service or live suite was started.

## Interventions and remaining gaps

The first account-usage Cypress run passed 14/16. Two existing tests expected the
old combined lowercase plan/default string. They now assert the explicit plan
label and separate Default/Paused state. The new regression journeys exercise
the primary home page at 390 and 1440 pixels; existing journeys retain Setup
coverage.

Live quota recovery, every live account's plan, and installed-service rollout
remain unverified. The rate-limited provider response is external and cannot be
repaired by inventing a weekly limit or reset time. Merge and deployment remain
separate decisions.
