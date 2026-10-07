# Account usage home and faithful quota display

## Outcome
Account usage is the default landing page and a primary navigation destination.
The owner can compare each account's subscription limits with the provider's usage
screen without confusing remaining capacity, model limits or reset durations.

## User journey
Opening `/` shows the tracker in the main shell, with pairing when required.
Time until reset is the primary dimension: a cross-provider Reset queue appears
before All accounts. Each overall usage window is a row, ordered by its future
reset, with a prominent countdown, provider/account, limit, unused percentage,
capacity bar and local reset time. Anthropic/OpenAI logos precede the provider
name in queue links and both summary cards; text remains the accessible label. Equal times prefer more unused quota and then
stable source order. Fully used windows remain visible as upcoming fresh quota;
paused accounts and accounts exhausted on another limit are explicitly labeled.
Named model/code-review limits remain separate in account Details.

Two compact summaries distinguish Next refresh (earliest reported future reset,
even if fully used) from Capacity to use before reset (earliest eligible reset
with positive remaining capacity on an unpaused account with no exhausted or
elapsed reported overall limit). A Usable now filter applies this same rule to
the queue without changing chronological ordering. The suggestion states that it
uses reported limits; it never promises model-specific availability or changes
account routing. A low percentage alone must not hide an imminent reset.

Only successful fresh snapshot/provider/account readings (at most 15 minutes old),
valid percentages from 0 to 100 and future reset timestamps qualify for the queue.
Missing, stale, failed, reconnect-required and elapsed readings never qualify.
Empty states explain when no reliable reset or usable capacity is reported.
Queue and summaries recompute after refresh, failure, time passage and deletion.
Links focus the matching account without changing Setup's category hash.

All accounts remains below the queue, with compact rows, 5-hour/weekly remaining
and used capacity, reconnect and Details for additional limits, reading times and
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
| Claude overall weekly usage is never replaced by a model-specific limit. | Backend payload regression test. |
| Missing/malformed percentages are unknown, and token lookup cannot select a different named account. | Backend normalization and token-selection tests. |
| Remaining/used labels, all reported cadences, reading age and reset units are visible. | Account usage UI test. |
| Visible pages refresh once a minute/on return; stale or failed readings do not claim available capacity. | Fake-clock UI tests. |
| Compact desktop and mobile layouts retain reconnect and confirmed deletion. | Account usage Cypress at 390 and 1440 pixels. |
| The five-account fixture’s seven reset entries fit at 1280×900 without horizontal overflow; account Details retains secondary information and connection actions. | Reset-queue viewport Cypress journey. |
| The queue sorts resets across providers and distinguishes fresh quota from usable unused capacity; paused/exhausted states and invalid, stale or elapsed readings cannot become usage suggestions. | Deterministic account usage UI selection tests. |

## Success measure
In the five-account fixture, all seven reset entries are visible at 1280×900,
and the owner can distinguish the paused 5%-remaining imminent weekly reset from
the active account with 82% remaining before its session reset; Details retains
every reported window under its original meaning.

## Ownership and boundaries
The implementing agent owns routing, tracker UI, quota adapter corrections,
regression checks and cleanup. The existing authenticated API/cache remains the
boundary; there is no storage migration or background service. External quota
requests continue through the existing provider integration and are mocked in
tests. No plan is introduced; any future implementation plan requires a person's
review of this committed spec first.
