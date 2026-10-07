# Account usage home and faithful quota display

## Outcome
Account usage is the default landing page and a primary navigation destination.
The owner can compare each account's subscription limits with the provider's usage
screen without confusing remaining capacity, model limits or reset durations.

## User journey
Opening `/` shows the tracker in the main shell, with pairing when required.
Time until the overall weekly reset is the primary dimension for every provider.
A Weekly reset queue appears before All accounts, with one overall weekly window
per account, ordered by its future reset. Each row shows a prominent weekly
countdown, provider/account, weekly unused percentage, capacity bar and local reset
time. Anthropic/OpenAI logos precede provider names; text remains the accessible
link label. Equal reset times prefer more unused weekly quota, then source order.
Daily, monthly, 5-hour and named model/code-review windows never compete for queue
position or either summary. Missing overall weekly data never falls back to a
shorter window or a model-specific weekly limit.

Next weekly reset identifies the earliest reported future weekly reset, even when
fully used or paused. Weekly capacity to use before reset identifies the earliest
weekly reset with positive capacity on an unpaused account with no exhausted or
elapsed reported overall limit. Usable now applies the same safety rule without
changing weekly ordering. Paused/exhausted limitations remain explicit; secondary
limits can prevent immediate use but cannot change the primary weekly countdown.
Suggestions use reported limits, never promise model-specific availability and do
not change account routing.

Claude Code’s 5-hour remaining percentage and reset are secondary text in its
weekly row and summary cards. Missing/invalid session data says Not reported;
elapsed/invalid session reset times say Awaiting refresh. OpenAI gets no 5-hour
placeholder or secondary session display. Any additional limits actually reported
by the provider remain accessible in Details without inventing a provider policy.

Only successful fresh snapshot/provider/account readings (at most 15 minutes old),
valid percentages from 0 to 100 and future reset timestamps qualify for the queue.
Missing, stale, failed, reconnect-required and elapsed readings never qualify.
Empty states explain when no reliable reset or usable capacity is reported.
Queue and summaries recompute after refresh, failure, time passage and deletion.
Links focus the matching account without changing Setup's category hash.

All accounts remains below the queue with weekly remaining and used capacity
first, a smaller secondary 5-hour reading for Claude only, reconnect and Details
for additional limits, reading times and
confirmed deletion. Every percentage identifies remaining/unused or used quota.
Visible pages refresh every minute and on returning to the tab. Durations use
explicit day/hour/minute units. Desktop content is capped at 920 pixels and mobile
wraps without horizontal overflow. Existing Setup and session/goal links work.

## Non-goals
Billing credits, monetary balances, provider subscription changes, authentication
redesign, installed-service changes and orchestration admission changes are out of
scope. Live parity requires a same-account provider reading supplied by the owner;
fixture verification must not be represented as a live account reconciliation.

## Acceptance criteria
| Criterion | Verification |
| --- | --- |
| Home opens account usage; existing explicit destinations remain reachable. | Navigation UI test. |
| A new device pairs before seeing protected usage. | Cypress home pairing journey. |
| Anthropic/OpenAI logos precede provider names in queue links and both summary cards; decorative icons retain the provider/account text as the accessible link label. | Account usage Cypress home journey checks provider-specific visible icons and existing named-link navigation. |
| Weekly reset ordering and both summaries ignore earlier 5-hour/daily/monthly resets; missing weekly data never substitutes another window. | Deterministic weekly selection UI tests. |
| Claude 5-hour quota/reset appears only as secondary context, with Not reported/Awaiting refresh fallback states; OpenAI has no session placeholder. | Parameterized session-context UI tests plus provider-specific account rendering test. |
| Claude overall weekly usage is never replaced by a model-specific limit. | Backend payload regression test. |
| Missing/malformed percentages are unknown, and token lookup cannot select a different named account. | Backend normalization and token-selection tests. |
| Remaining/used labels, all reported cadences, reading age and reset units are visible. | Account usage UI test. |
| Visible pages refresh once a minute/on return; stale or failed readings do not claim available capacity. | Fake-clock UI tests. |
| Compact desktop and mobile layouts retain reconnect and confirmed deletion. | Account usage Cypress at 390 and 1440 pixels. |
| The five-account fixture’s five weekly reset entries fit at 1280×900 without horizontal overflow; account Details retains secondary information and connection actions. | Reset-queue viewport Cypress journey. |
| The queue sorts resets across providers and distinguishes fresh quota from usable unused capacity; paused/exhausted states and invalid, stale or elapsed readings cannot become usage suggestions. | Deterministic account usage UI selection tests. |

## Success measure
In the five-account fixture, all five weekly reset entries are visible at 1280×900,
and the owner can distinguish the paused 5%-remaining imminent weekly reset from
the active account with 55% weekly capacity and secondary 82% session capacity; Details retains
every reported window under its original meaning.

## Ownership and boundaries
The implementing agent owns routing, tracker UI, quota adapter corrections,
regression checks and cleanup. The existing authenticated API/cache remains the
boundary; there is no storage migration or background service. External quota
requests continue through the existing provider integration and are mocked in
tests. No plan is introduced; any future implementation plan requires a person's
review of this committed spec first.
