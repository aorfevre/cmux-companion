# Review fix publisher forwarding

## Outcome
Address review comments reaches GitHub in the installed Companion, and a goal
that cannot run a review round states the real reason instead of blaming the
network.

## User journey
An owner presses Address review comments on a delivered goal. Companion reads
the unresolved threads, runs the fixer, pushes the verified fix and answers the
threads. When a round cannot start because the composition does not supply the
review-round capability, the goal reports a configuration fault and says that a
retry will not help. When GitHub is genuinely unreachable, the goal keeps its
existing offline message and stays retryable. Existing held goals retry
normally after the capability is present.

## Non-goals
Do not change the review round state machine, the fixer prompt, the sent-marker
protocol or the human publication gate. Do not add a GitHub capability that the
adapter does not already implement. Do not relax the fail-closed reads, retry a
write whose outcome is unknown, or expose command output, tokens or paths.

## Acceptance criteria
| Criterion | Verification |
| --- | --- |
| The settings composition forwards reviewThreads, pushFix and replyAndResolve to the goal publication adapter. | Settings runtime port test. |
| A round started with a composition missing the capability reports a configuration fault, not an offline Mac. | Coordinator capability test. |
| A failed GitHub read still reports the existing retryable offline message. | Coordinator transport failure test. |
| Every forwarded method addresses the adapter bound to that goal. | Per-goal forwarding test. |

## Boundaries
The feature owner owns the settings publisher composition and the coordinator's
failure classification. The GitHub adapter, the domain transitions and the
scheduler are unchanged. No database migration, background worker or new
external API is needed.

## Success measure
A delivered goal in the installed Companion completes one review round against
its pull request, with no capability error in its activity log.
