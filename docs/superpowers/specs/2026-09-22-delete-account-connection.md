# Delete an account connection

## Outcome

The owner can remove a Claude Code or OpenAI Codex connection from Account usage
without opening CCS manually. The action removes the local CCS registration and
saved login through CCS's account manager. It does not delete the provider account
or cancel a subscription.

## User journey

Each account card offers **Delete connection**, including unavailable and expired
accounts. An inline confirmation names the provider and account, explains that
sign-in will be needed again, and warns about default-account replacement where
applicable. Cancel changes nothing. Confirm disables repeat submission while the
request runs. Success removes the card and refreshes counts and default metadata;
failure keeps the confirmation open with a retryable error.

## Non-goals

Provider-side revocation, subscription cancellation, deleting live accounts during
development, modifying running agents, changing CCS's default-selection policy,
and installing or deploying this feature are outside this change.

## Acceptance criteria

| Criterion | Verification |
| --- | --- |
| Confirmation identifies the connection and Cancel sends no deletion. | UI deletion test. |
| Desktop and mobile owners can confirm, recover from failure, and see updated counts. | Account usage Cypress deletion journey at 390 and 1440 pixels. |
| Only the exact server-resolved provider/account is removed. | Account usage backend test using identical account names across providers. |
| Requests require pairing and same-origin protections. | API deletion test. |
| Reconnect and deletion cannot mutate the same account concurrently. | Reconnect manager serialization test. |
| Old reads cannot restore a deleted connection to the server cache. | Pending snapshot invalidation test. |
| CCS failures do not disclose token details. | Sanitized removal failure test. |

## Boundaries and ownership

The feature owner is responsible for the card UI, authenticated DELETE route,
account-operation coordination and cache invalidation. CCS owns durable account
and token storage, including paused tokens and default replacement; Companion
calls its existing `removeAccount(provider, accountId)` API. The existing reconnect
manager blocks removal while a login operation is active. No new background worker
or Companion database migration is needed. No provider account API is called by
the deletion action.

## Success measure

A confirmed deletion removes exactly one selected connection from the next usage
snapshot while preserving another provider's connection with the same identity.
