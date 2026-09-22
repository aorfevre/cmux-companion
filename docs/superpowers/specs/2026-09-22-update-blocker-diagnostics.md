# Update blocker diagnostics

## Outcome
Owners can identify the exact Companion-owned request or operation preventing a
restart from Settings → Updates and structured service logs.

## User journey
Updates continues polling its authenticated status. Each readiness blocker shows a
specific cause, how long it has been observed, and safe diagnostic identifiers.
HTTP blockers show method, registered route template, server-generated diagnostic
ID, start time and whether the client disconnected. Managed-work blockers show the
goal and operation/attempt/result identifiers where available. Expandable details
keep internal identifiers out of the primary explanation. When blockers clear,
the panel reports no active restart blockers; other update eligibility errors
remain separate. Older services retain their existing generic labels.

## Non-goals
Do not relax restart guards, stop cmux, trigger an installed update, fix the
request-lifecycle counter bug, or expose request bodies, query strings, headers,
credentials, raw URLs, prompts or filesystem paths. Disconnection alone is not
proof that a mutation finished. Diagnostics start with the new service process;
they cannot reconstruct an old counter's lost request identity.

## Acceptance criteria
| Criterion | Verification |
| --- | --- |
| Request blockers identify method, registered route, generated ID and duration. | Authenticated route test with a held mutation. |
| Disconnected clients remain distinguishable without bypassing the restart guard. | Real HTTP disconnect test. |
| Every managed blocker identifies its owning goal/operation where available. | Managed blocker projection test. |
| Logs report blocker additions, changes and clearing without private data or poll spam. | Structured logger test. |
| Updates renders details, legacy labels and cleared state on mobile and desktop. | Cypress updates journey. |
| Queries, body data and client-supplied request IDs never enter diagnostics. | Backend privacy assertion. |

## Boundaries
The feature owner owns request tracking, managed-work projection, authenticated
status output, structured logging and the Updates panel. Diagnostic request records
are process-local; workflow IDs reference existing durable state. No database
migration, new background worker or external API is needed. Existing updater
readiness and human publication gates retain their authority.

## Success measure
A held fixture mutation is identifiable from both the Updates panel and logs by
the same diagnostic ID, and disappears after its response completes.
