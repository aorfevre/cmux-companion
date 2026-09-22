# Account connection deletion and installed update inspection

## Delivered change

Account usage now offers Delete connection with an inline provider/account
confirmation, cancel, busy state and retryable errors. Successful deletion removes
the card immediately and refreshes usage/default metadata. An authenticated,
same-origin DELETE resolves the opaque account identity against CCS metadata and
calls CCS removeAccount. Per-account coordination prevents deletion racing with
reconnect; cancelled reconnect completion cannot register the account again.
Generation-based invalidation prevents an older read repopulating the cache.

CCS owns local registry/token removal and default replacement. Companion adds no
storage schema, background worker or provider-side subscription/account operation.
No live connection was removed. Existing unrelated workspace files were preserved.

## Verification

Passed:

- Targeted account usage, reconnect and API tests (64 initially; 40 account usage
  and reconnect tests after adding two further adapter/race cases).
- UI coverage: 170 tests, 20 files; 95.51% lines.
- Account usage Cypress: 10/10, including deletion at 390px and 1440px.
- ESLint, both TypeScript projects, production build, git diff whitespace check.

Interventions and gaps:

- Cypress's default port 3221 was occupied. Used disposable port 3237 without
  stopping its existing owner; the harness stopped its own frontend on completion.
- Full npm run verify exited 1: 968 backend tests passed, two were cancelled
  after 60-second timeouts (orchestration-delivery no-conflict and
  orchestration-dev disposable composition), and one was skipped by the suite.
  Backend line coverage was 97.31%. Both timed-out tests and orchestration code
  are unchanged from main. Inspection found bounded, Git-heavy scheduler journeys;
  the output identifies no failed assertion or precise stalled operation, so the
  timeout cause remains unresolved. No thresholds were lowered, additional tests
  skipped, or unchanged failing test rerun. Remaining verify stages were run
  separately and passed.
- Real installed CCS token deletion is intentionally unverified; tests use
  disposable fake CCS modules. Installed source was inspected to confirm the
  removeAccount(provider, accountId) contract includes token deletion and default
  replacement.
- No merge, deployment or installed service restart was performed.

## Installed updater finding (2026-09-22, approximately 11:19–11:23 UTC)

PR #170 merged at 10:01:22 UTC as de796aaa2fe19fd4db154b850a8a734098af81a7.
The loopback health endpoint still reported running commit
9f8d2cfdb399bfff45f02128e9bf720df954cf1f. Automatic updates were enabled;
the automatic request for de796aa had been queued since 10:07:49 UTC.
An authenticated read of updater status reported only:
“A Companion change request is still in progress”.

This means the service's in-memory HTTP mutation count is nonzero, not that a
GitHub PR needs approval. update-maintenance increments on incoming mutating
requests and decrements only onResponse. A disposable Fastify reproduction
started a POST handler, disconnected the HTTP client, then allowed the handler to
finish: the busy blocker remained. This demonstrates a stale-counter bug that can
prevent updates indefinitely. It is a plausible explanation for the installed
blocker, not proof of which original request caused it: the counter retains no
request identities. Inspection found no unmatched mutating request for the latest
service PID in the available JSON request log.

The installed service was not changed. The update guard needs a separate fix that
tracks completion even after disconnection while continuing to block genuinely
running effects; simply clearing on socket close could restart during a mutation.
