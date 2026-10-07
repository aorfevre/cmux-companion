# Compact usage overview and next unused reset

## Result and comparison

The tracker now uses compact account rows under vertically stacked provider
headings. Each row keeps its account identity, status, 5-hour/weekly remaining and
used percentages, and countdowns visible. Additional limits, reading time,
messages and confirmed connection deletion are available through Details;
Reconnect remains directly accessible when needed.

The five-account desktop fixture fits all five rows within a 1280×900 viewport.
Mobile keeps the two primary limits side by side below the account identity,
with no horizontal overflow. The overview is capped at 1100 pixels wide.

A top summary identifies the earliest future overall usage reset with quota
remaining, across both providers. It displays the provider, account, exact limit,
unused percentage, countdown and local reset date/time. The selected row is
highlighted and a keyboard-accessible link scrolls/focuses it without modifying
Setup's category hash.

In the supplied screenshot, the paused personal Claude account's weekly limit
was next: **47 minutes until reset, 5% unused**. That is a usage-window reset,
not renewal of a paid subscription. It is historical screenshot evidence, not a
claim about the live percentage at delivery time.

## Selection rules and boundaries

- Only fresh successful snapshot/provider/account readings qualify (the existing
  15-minute freshness limit applies).
- Overall usage windows require a finite remaining percentage above zero and at
  most 100, plus a valid reset timestamp strictly in the future.
- Named model and code-review limits stay separate. Missing, stale, failed,
  reconnect-required, overdue and fully used windows cannot win.
- Ties choose the higher unused percentage, then retain provider/account order.
- Paused accounts remain visible and explicitly say **Paused in CCS**. If another
  overall limit is exhausted, the summary says so rather than implying immediate
  usability. No connection is resumed or account routing changed.
- Selection recomputes on refreshed data, time passage, failed reads and deletion.
  No eligible candidate produces an explicit no-upcoming-reset message.

The implementing agent owns the UI, selection rule, integration and checks. This
change is frontend-only: no API, storage, background worker, provider request or
credential behavior changes. Existing pairing, refresh, reconnect and deletion
boundaries are preserved. No installed service changes or deployment occurred in
this follow-up. The pre-existing untracked burst-scan plan remains untouched.

## Older UI in the screenshot

The installed service reports merged commit `82cabdda`. Its root HTML referenced
11 JavaScript assets; fetching those assets found the current tracker copy
(`Refreshes every minute while visible`) and no old `Fresh snapshot` copy.
The screenshot still shows the old copy and day/hour/minute colon notation.
The evidence indicates an older frontend is still open in that browser; it does
not establish a particular service-worker defect. Reload the browser tab to load
the deployed frontend. The in-page refresh control only refreshes quota data.

## Verification

- `npm run verify`: **passed**, including coverage, lint, types and build.
  Backend: **1,028 passed, 1 existing macOS invalid-UTF-8 filename skip, 0 failed**;
  **97.38% line coverage**. UI: **182 passed**, **95.29% line coverage**.
  Both 90% line-coverage thresholds remain enforced.
- Account usage Cypress: **14 passed**, including five-account home views at
  390/1280/1440 pixels; all five row bottoms are asserted within 900 pixels on
  desktop. Also covers Details visibility, Setup hash preservation and focused
  row navigation, pairing, refresh failures, reconnect and confirmed deletion.
- Pure/UI regressions cover cross-provider selection, ties, stale/invalid/fully
  used readings, model-limit separation, paused/exhausted notices, elapsed resets,
  failed refreshes and deleting the highlighted account.
- Desktop and mobile generated screenshots were visually inspected:
  `cypress/screenshots/account-usage.cy.ts/account-usage-home-1280.png` and
  `account-usage-home-390.png` (generated, not committed).
- Live quota accuracy beyond the supplied screenshot, other device/browser sizes,
  CI and CodeRabbit approval are not established by the fixture checks.

Interventions: focused UI checks initially failed because the new summary repeats
the selected percentage/countdown; assertions were scoped to their intended
content. Review found that a normal fragment link would replace Setup's category
hash, so the link now scrolls/focuses its row without changing that hash and the
browser journey verifies this. No coverage threshold was reduced.
