# Visible Fable capacity and redeemable resets

## Outcome

Account usage now shows Fable weekly remaining/used capacity beside overall Weekly
and 5 hours in every Claude account, with an explicit missing-data state. A short
provider note explains that all reported limits apply when allocating Fable work.
Fable is no longer hidden in Details. Other additional limits retain their existing
Details presentation, and the overall weekly reset queue retains its meaning.

Every account has a visible Redeemable resets row: saved count, next reported
expiry with local date/time and countdown, and a provider usage-page link.
Unknown inventory never becomes zero; partial expiry details and temporarily
unusable saved grants are labelled. Known expired grants disappear as time moves
forward, including while refresh is pending. Failed/stale readings stop claiming
available resets. This screen does not redeem or automatically spend a reset.

## Investigation and live evidence

Read-only investigation on 12 October 2026 used the existing exact-account CCS
credentials for one default Claude account and one default Codex account. No
credentials, redemption handles or raw account responses were written into the
repository; no reset was redeemed and no installed service was restarted.

- Claude's current usage payload reports Fable through `limits[]`, with
  `kind: weekly_scoped`, `percent`, `resets_at`, and
  `scope.model.display_name: Fable`. The old parser only understood
  `seven_day_fable`. The observed account had **31% Fable remaining**, alongside
  **52% overall weekly remaining**. The scoped reading now supersedes a duplicate
  legacy named-model window without replacing the all-model weekly window.
- `GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1`, with the existing
  OAuth beta header and Claude CLI compatibility User-Agent, returned an eligible
  `cedar_ember` inventory with **one saved reset**, expiring
  **2026-10-22T16:00:00Z** (22 October, 18:00 in Europe/Paris).
- A generic HTTP client identity returned a different inventory result. Repeating
  the read with `claude-cli/2.1.296 (external, cli)`, matching the installed Claude
  version, restored the saved grant. The adapter uses this tested compatibility
  identity, and treats ineligible/absent blocks as unknown. This is an observed
  internal API contract, not a promised public Anthropic API.
- The default Codex account's `/backend-api/wham/usage` response reported **two
  saved resets**. Its authenticated read-only
  `/backend-api/wham/rate-limit-reset-credits` response provided expiries
  **2026-10-29T18:50:05.631Z** and **2026-11-06T23:22:08.961Z**. Both were read by
  the implementation, not inferred from ordinary quota-reset timestamps.

Provider/source references inspected:

- [Claude's limit reset behavior](https://support.claude.com/en/articles/17007452-what-is-a-limit-reset)
  documents the saved-reset offer and expiry in Settings > Usage.
- [Codex app-server rate-limit documentation](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)
  describes the available count, optional detail rows and expiry semantics.
- [OpenAI's backend reset client](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs)
  and [response types](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/types.rs)
  establish the direct read endpoint and wire fields used here.
- [CodexBar's Claude integration notes](https://github.com/steipete/CodexBar/blob/main/docs/claude.md)
  and [reset parser](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Claude/ClaudeRateLimitResetCredits.swift)
  identified the optional query and grant fields, then confirmed against the live
  read above. Installed Claude 2.1.296 also contains the same reset field names.

## Contract and boundaries

The existing authenticated `GET /api/account-usage` response adds a nullable
`redeemableResets` object per account, with `availableCount`, `updatedAt` and
optional `grants` containing only `count`, `expiresAt` and `usableNow`. It also
preserves a reported model name on named quota windows. Neither raw provider
objects nor grant IDs cross this boundary. These are observation-time values;
the UI applies freshness and expiry as time passes.

Claude inventory shares its existing usage request, budget, retry/backoff and
exact-account credential selection. Codex makes a detail request only when usage
reports a positive saved count; this endpoint has its own shared one-minute
request budget and Retry-After/429 cooldown. Failed details preserve the fresh
usage count with unknown expiry and do not erase ordinary quota. Capped detail
rows cannot replace the provider's authoritative count. A detail count mismatch
falls back to the usage count, since another client may have redeemed a reset.

One implementing agent owns the UI, provider adapters, integration, tests and
cleanup. Existing pairing, same-origin protections, refresh effects and deletion
remain intact. There is no new storage, polling timer, orchestration admission
behavior, external mutation or redemption API. The delivery spec was amended in
separate commits before implementation; no implementation plan was introduced.

## Verification

- Focused backend: **40 passed** (account usage and reset inventory).
- Focused account UI: **38 passed**.
- Backend coverage stage: **1,059 passed, 1 platform skip, 0 failures**;
  **97.43% lines**. The existing macOS-invalid-filename skip remains.
- Full UI coverage after the assertion correction: **212 passed**;
  **95.28% lines**. The 90% backend/UI thresholds remain unchanged.
- Account usage Cypress: **19 passed**, including Fable/reset rows with Details
  closed at 390, 1280 and 1440 pixels; pairing, weekly queue, reconnect,
  unavailable states and confirmed deletion remain covered. The owned local
  frontend and browser processes were stopped by the harness.
- Main-screen desktop (1280) and mobile (390) screenshots were inspected visually.
  Screenshots are generated under `cypress/screenshots/account-usage.cy.ts/`.
- Lint: **passed**, with two pre-existing internal-navigation warnings in
  `device-settings.tsx` and `settings-panel.tsx` (zero errors).
- Typecheck and production build: **passed**.
- `git diff --check`: **passed**.

Interventions: the first focused backend run failed because a URL assertion
expected the old queryless Claude endpoint; it now checks the optional inventory
query. The first `npm run verify` completed backend coverage but stopped at one
old UI assertion assuming only one Not reported label. That assertion was scoped
to the correct quota windows while explicitly checking missing Fable. Full UI
coverage, lint, typecheck and build were then run successfully; the unchanged,
already-passed backend coverage stage was not repeated. Browser checks were
expanded from the initial 18-pass run to the final 19-pass main-screen run with
explicit row bounds and desktop/mobile screenshots. No coverage was reduced.

The first attempt to restrict the live adapter probe to default accounts tried to
replace a getter-only export and stopped before making requests. A process-local
module wrapper then restricted the probe to the intended accounts; it did not
edit installed CCS code or settings. Claude probes were spaced more than a minute
apart. After the generic-client reading differed, the final compatibility-header
read confirmed the same saved grant originally observed.

## Remaining limits

Claude's optional query and compatibility identity are internal and can change;
only the default Max account was live-confirmed, not every Team/Enterprise
account. Codex detail failures or unavailable expiry data remain explicit unknowns.
Counts are snapshots, so a reset redeemed elsewhere can remain visible until the
next successful refresh. A provider-page link opens the browser's signed-in
account, which may differ from the CCS account; the provider retains redemption
and its own account/eligibility confirmation.

CI, CodeRabbit review, the separate macOS gate and broad opt-in native live suites
were not run as part of local verification. No merge, deployment, updater run,
installed-service change or reset redemption occurred. Dependency installation
retained the lockfile and reported the existing 16 audit findings (2 moderate,
14 high); dependency remediation is outside this change.

## SonarCloud follow-up

PR #188's initial automatic SonarCloud analysis rejected the new-code reliability
rating because the Codex detail parser accessed `details.credits` after an
optional-chain equality test. Replaced that test with an explicit `details &&`
null guard; no suppression, quality-gate change or behavior change was added.
Existing malformed/missing-detail regressions cover the fallback path.

The follow-up `npm run verify` completed successfully: 1,059 backend tests passed
with the same one platform skip (97.42% line coverage), 212 UI tests passed
(95.28% line coverage), lint passed with the same two existing warnings, and
both typecheck and build passed. Focused account/reset backend tests: 40 passed.
The previous 19 browser checks still cover the unchanged UI; they were not
repeated for this null-guard-only change. Remote reanalysis and review are recorded
on the PR, and are separate from these local results.

## Review corrections before merge

CodeRabbit identified two valid issues: the acceptance table delimiter was below
its new rows, and reset-only provider responses could imply available quota.
The spec table is repaired and explicitly separates quota status from inventory.
Accounts with no usage windows now remain unavailable, while fresh saved-reset
counts and expiries stay visible. Backend, UI and desktop/mobile Cypress tests
cover this independent availability behavior.

Final local checks: full verification passed (1,059 backend passes, one existing
platform skip; 213 UI passes; lint, types and build passed), and account Cypress
passed all 19 checks. A formatting edit made while backend coverage was running
invalidated that run's source mapping, so backend coverage was rerun on unchanged
files and passed at 97.43%; UI coverage remains 95.28%. Existing lint warnings
remain unchanged. SonarCloud passed the explicit-null-guard commit; the latest
review corrections require their own remote checks and approval before merge.
