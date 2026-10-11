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

Next weekly reset identifies the earliest reported future weekly reset with
positive remaining weekly quota. Fully used weekly limits remain in the queue but
cannot receive this summary or its matching account highlight. Paused accounts
and accounts blocked by a secondary limit still qualify when weekly quota remains,
with their constraints displayed. Weekly capacity to use before reset identifies the earliest
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
confirmed deletion. Account rows explicitly label their subscription plan (including
Claude Team, Pro, Max and Max multipliers when reported); missing metadata says
Plan not reported. Plan metadata is independent of quota availability. Claude
plans come from the exact account's OAuth profile, cached for 15 minutes after a
successful reading; failed profile requests are bounded and briefly cached, never
erase usage, and never expose raw profile data. Codex retains its reported plan.
Unavailable accounts stay visible with a concise reason, including provider rate
limiting, missing credentials, rejected credentials and missing usage windows.
Accounts without a reliable future weekly reset stay outside the reset queue;
the queue explains this requirement. Every percentage identifies remaining/unused or used quota.
Visible pages refresh every minute and on returning to the tab. Within the running
service, all tabs and clients share one usage request budget per provider/account:
at least 60 seconds between attempts, including failed requests. Manual Refresh,
snapshot invalidation, reconnect and credential rotation cannot bypass the budget;
concurrent requests share the same pending read. Cached readings retain their
original observation time. Claude profile reads have a separate request budget
with the same minimum interval and the existing 15-minute successful cache.

HTTP 429 pauses that account's affected endpoint for 2, 4, 8, 16, then at most
30 minutes until a successful read resets the backoff. A valid Retry-After delay
or HTTP date extends this pause when longer, including beyond 30 minutes; invalid
or past values cannot shorten it. Other accounts continue normally. Refresh
cannot bypass a cooldown and does not queue additional retries. An unavailable
account shows its earliest retry time; no failed reading becomes usable quota.
Codex uses its exact usage endpoint once per admitted attempt and cannot fall
back to a second quota request after rejection or network failure. No new timer
or background provider polling is introduced; the next requested refresh after
the deadline may retry. These process-local budgets do not control other apps.

Durations use
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
| Next weekly reset and its account highlight skip zero weekly quota, including when every weekly limit is fully used. | UI regression with an earlier saturated account and later positive weekly quota. |
| Claude plans are read with the same exact-account credential as usage, cached, normalized and retained when usage fails; profile failure cannot erase usage or leak raw profile data. | Backend profile fixtures for plan types, cache expiry, failure and credential isolation. |
| Visible account rows show readable plan labels and specific unavailable reasons; the queue explains missing weekly readings. | Account usage Cypress journey at desktop and mobile widths. |
| Claude 5-hour quota/reset appears only as secondary context, with Not reported/Awaiting refresh fallback states; OpenAI has no session placeholder. | Parameterized session-context UI tests plus provider-specific account rendering test. |
| Claude overall weekly usage is never replaced by a model-specific limit. | Backend payload regression test. |
| Missing/malformed percentages are unknown, and token lookup cannot select a different named account. | Backend normalization and token-selection tests. |
| Remaining/used labels, all reported cadences, reading age and reset units are visible. | Account usage UI test. |
| Visible pages refresh once a minute/on return; stale or failed readings do not claim available capacity. | Fake-clock UI tests. |
| All clients share at most one usage attempt per provider/account per minute, including after refresh, invalidation and credential rotation; pending reads coalesce and cached timestamps stay unchanged. | Fake-clock adapter tests counting outgoing requests. |
| Both providers honor 429 cooldowns and Retry-After, reset backoff after success, and leave other accounts available; Codex failures never issue a fallback usage request. | Backend request-count and recovery regressions. |
| A rate-limited account displays its retry countdown and Refresh preserves its cooldown. | Account usage Cypress journey with a cooldown response. |
| Compact desktop and mobile layouts retain reconnect and confirmed deletion. | Account usage Cypress at 390 and 1440 pixels. |
| The five-account fixture’s five weekly reset entries fit at 1280×900 without horizontal overflow; account Details retains secondary information and connection actions. | Reset-queue viewport Cypress journey. |
| The queue sorts resets across providers and distinguishes fresh quota from usable unused capacity; paused/exhausted states and invalid, stale or elapsed readings cannot become usage suggestions. | Deterministic account usage UI selection tests. |

## Success measure
In the rate-limit fixture, repeated requests from multiple clients produce one
usage call per account during the first minute and zero additional calls during
its cooldown, while a healthy account remains refreshable and the owner can see
when the unavailable account may retry.

## Ownership and boundaries
The implementing agent owns routing, tracker UI, quota adapter corrections,
regression checks and cleanup. The existing authenticated API/cache remains the
boundary; there is no storage migration or background service. External quota
requests continue through the existing provider integration, adding a read-only
Claude OAuth profile request, and are mocked in tests. No plan is introduced; any future implementation plan requires a person's
review of this committed spec first.
