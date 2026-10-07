# Account usage landing page and accuracy review

## Result

The root URL now opens Account usage in the main navigation shell. The page uses
the full content width, with Claude and Codex columns and side-by-side primary
limits where space permits. Mobile stacks the same information. Setup's existing
usage page and explicit session, repository-file and goal links remain supported.

The supplied screenshots agree on the account's overall quota:

| Limit | Claude screenshot | Original tracker | Interpretation |
| --- | --- | --- | --- |
| Current session | 0% used; starts with the first message | 100% | 100% remaining; no reset timestamp reported. |
| This week | 95% used; resets at 10:00 AM | 5% | 5% remaining. The old `00:01:27` meant 1 hour 27 minutes. |
| Fable this week | 96% used; resets at 10:00 AM | Absent | Separate model limit, equivalent to 4% remaining. |

This was primarily an unclear used-versus-remaining comparison for the two
displayed numbers, alongside a genuinely missing named model limit. The screenshots
were taken at different times; they are not a synchronized API capture.

## Corrections

- Every gauge explicitly says **remaining** and also displays **used**.
- Claude's `seven_day` remains the overall weekly limit. The adapter no longer
  promotes the lowest named model limit into that slot. Fable and other reported
  `seven_day_*` windows retain their separate labels.
- Daily/monthly usage windows, previously discarded by the UI, appear with the
  other additional limits.
- Reset countdowns say `1h 27m` or `3d 2h 7m`. Their time elements retain the exact
  provider reset timestamp and localized date/time tooltip.
- Each account displays the age of its own reading. A newly generated response
  no longer carries a blanket “Fresh snapshot” claim. Failed/stale readings keep
  the existing 15-minute unknown-capacity behavior and use neutral status styling.
- The visible page refreshes each minute and on returning to the tab, without
  overlapping its automatic reads; hidden/unmounted pages stop that polling.
- Missing, boolean, blank and out-of-range percentages are rejected, rather than
  being coerced into zero or full capacity.
- Claude credential selection requires matching account metadata or an exact
  recognized filename. Conflicting email metadata and partial filenames cannot
  select another account. The installed CCS fallback also used substring matches,
  so Claude now reports unknown on direct-read failures instead of invoking that
  ambiguous lookup. Expired credentials and HTTP 401 retain the reconnect action.

## Boundaries and limitations

One implementing agent owns the UI, adapter, integration and cleanup. The existing
authenticated usage endpoint, same-origin mutation protection, connection deletion
confirmation and server-only credentials remain in place. No API route or storage
schema was added; refresh is a browser effect, not a new background service.
Orchestration admission and external account settings were not changed.

The supplied Claude screenshot was reviewed, and installed CCS *code* was inspected.
No live credentials were displayed or provider account accessed. Fable rendering
is tested with a provider-shaped fixture; it can appear only when the provider
returns that named limit. No balances, monetary credits or unreported limits are
inferred. A transient Claude request failure now shows unknown until a later
successful read, instead of an alternate normalized fallback.

No installed service was restarted, updated or deployed. The pre-existing untracked
burst-scan plan was left untouched. The delivery spec is a separate earlier commit;
no implementation plan was introduced.

## Verification

- Final `npm run verify`: **passed** (backend/UI coverage, lint, typecheck and build).
  Backend: **1,028 passed, 1 platform skip, 0 failed**, **97.37% line coverage**.
  The existing skip is the invalid-UTF-8 filename case that macOS cannot create.
  UI: **178 passed** across 21 files, **95.31% line coverage**. Both 90% coverage
  thresholds remain enforced.
- Account usage Cypress: **14 passed**, including landing at 390/1280/1440 pixels,
  pairing, existing Setup access, all cadences, unavailable states, reconnect and
  confirmed deletion/retry. Ran through the disposable local frontend with mocked
  APIs, without installed state.
- Targeted UI regression suite: **22 passed** across account usage, features and
  navigation. Full UI coverage is also included in `verify`.
- Desktop (1280) and mobile (390) screenshots were visually reviewed; the test
  asserts heading contrast and content bounds. Screenshots are under
  `cypress/screenshots/account-usage.cy.ts/` (generated, not committed).
- Opt-in native/live-provider suites, installed-service behavior and CI/CodeRabbit are
  not verified by these local checks.

Interventions: the first focused UI run exposed an ambiguous test query after the
previously hidden monthly window became visible; it was scoped to the expected
countdown. Visual review caught inherited light text on the light landing page;
the page and reconnect colors were corrected and browser checks repeated. The
first full verification passed backend/UI coverage but stopped at the new home
brand link's Next lint rule; the existing intentional full-document navigation
convention was documented, and full verification was restarted on the final code.
Coverage thresholds were not reduced and unchanged failures were not retried.
