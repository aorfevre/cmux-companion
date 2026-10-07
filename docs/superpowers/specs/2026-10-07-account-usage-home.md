# Account usage home and faithful quota display

## Outcome
Account usage is the default landing page and a primary navigation destination.
The owner can compare each account's subscription limits with the provider's usage
screen without confusing remaining capacity, model limits or reset durations.

## User journey
Opening `/` shows the tracker in the main shell, with pairing when required.
Claude and Codex accounts appear in compact provider groups. Every percentage
explicitly identifies remaining capacity and also shows used capacity. Claude's
overall weekly limit stays separate from its named model limits. Each account
shows its reading time; visible pages refresh every minute and on returning to
the tab. Reset durations use explicit day/hour/minute units. Existing Setup usage
and session/goal deep links continue to work.

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

## Success measure
The deterministic comparison fixture displays the provider's overall and named
limits under their original meanings with zero missing reported windows.

## Ownership and boundaries
The implementing agent owns routing, tracker UI, quota adapter corrections,
regression checks and cleanup. The existing authenticated API/cache remains the
boundary; there is no storage migration or background service. External quota
requests continue through the existing provider integration and are mocked in
tests. No plan is introduced; any future implementation plan requires a person's
review of this committed spec first.
