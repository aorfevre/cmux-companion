# Reset queue and unused capacity overview

## Result

Time until reset now leads the tracker. A cross-provider queue appears above All
accounts, ordered by each overall usage window’s reset time. Countdowns, unused
percentages and bars, account identity, limit and localized calendar date/time
are visible together. Desktop content is capped at 920 pixels; mobile rows wrap.

Two summaries distinguish the earliest future **Next refresh**, including fully
used or paused windows, from **Capacity to use before reset**, the earliest reset
with unused capacity on an unpaused account with no exhausted, invalid or elapsed
reported overall limit. The Usable now filter keeps chronological ordering.
Suggestions are based on reported limits and do not change routing or guarantee
model-specific availability. Paused/exhausted limitations remain explicit.

The five-account fixture contains seven queue entries, including a monthly limit.
Its paused personal account resets in 47 minutes with 5% unused; the active work
account has 82% unused before its session reset in 1h35m. These are independent
fixture readings, not claims about current live quota or subscription renewal.

Compact All accounts rows below the queue retain 5-hour/weekly used and remaining
percentages. Details contains reading time, additional/model limits, messages and
confirmed deletion; reconnect remains directly accessible. Queue links focus the
matching account without replacing Setup’s category hash.

## Selection and boundaries

- Only successful fresh snapshot/provider/account readings qualify, using the
  existing 15-minute limit. Percentages must be finite and between 0 and 100;
  reset timestamps must be valid and in the future.
- Missing, stale, failed, reconnect-required and elapsed readings are excluded.
  Named model/code-review windows remain separate in Details.
- Ties choose more unused quota, then stable source order. Fully used windows
  remain in Next reset but cannot become usable-capacity suggestions.
- Refresh, failure, time passage and deletion recompute queue and summaries.
  Empty states explicitly explain missing trustworthy or usable readings.

The implementing agent owns UI, selection, checks and cleanup. No API, storage,
background worker, provider request or credential behavior changes. Existing
pairing, refresh, reconnect and deletion boundaries remain. The unrelated
untracked burst-scan plan is untouched. The delivery contract was amended in its
own commit before implementation; no implementation plan was introduced.

## Verification

- Backend: 1,028 passed, one existing macOS invalid-UTF-8 filename skip;
  line coverage 97.38%.
- UI coverage: 185 passed, 95.20% line coverage. Both 90% thresholds retained.
- Lint, typecheck and production build passed. The full `npm run verify` run
  initially stopped at two test typing errors; these were fixed, then typecheck,
  build and 27 focused UI tests passed. Backend checks were not needlessly rerun
  for those test-only type corrections; CI runs the complete command again.
- Account usage Cypress: 14 passed, including desktop viewport bounds and mobile
  no-overflow checks. Desktop/mobile screenshots were visually inspected.

Final CI and delivery evidence are recorded in the PR. Local focused UI
checks cover cross-provider order, ties, stale/invalid readings, model separation,
fully used resets, paused/exhausted constraints, elapsed resets, failed refresh,
confirmed deletion, filter behavior and localized calendar dates. Cypress covers
390/1280/1440-pixel home views, seven-entry desktop fit, filtering, Details,
Setup hash/focus, pairing, refresh failure, reconnect and confirmed deletion.

Interventions: the first queue Cypress run passed 12/14; the seventh desktop row
extended below 900 pixels. Row line height/spacing and summary timestamp spacing
were corrected before rerunning. A page-wide quota assertion became ambiguous
when the queue repeated the percentage; it now targets the intended account’s
core window. CodeRabbit’s earlier findings about that assertion and missing
calendar dates are addressed. Typechecking also caught an unsupported Cypress role-query option and a generic DOM Element type; the role selector now uses an exact regular expression and the core-window element has its HTMLElement type. Coverage thresholds remain unchanged.

Live quota parity beyond the user-supplied screenshot and other browser/device
sizes remain unverified. Generated screenshots are not committed. A browser tab
reload is needed to replace an already-open older frontend; in-page Refresh only
refreshes quota data.
