# Verify the review fix head

## Outcome
The approved project checks run on a review round's fix head, so a round passes
or fails on real check output instead of being refused before it starts.

## User journey
An owner presses Address review comments. The fixer produces a new head, and
Companion runs the same approved checks it runs during building. A check that
fails shows its output, and the owner can read why. A round is never reported as
a failed verification when no check was executed.

## Non-goals
Do not run a command outside the goal's approved contract, widen the executable
rules, or authorize checks for any other goal status. Do not change the round
state machine, the push gate or the human publication gate. Do not verify a head
that the round did not record.

## Acceptance criteria
| Criterion | Verification |
| --- | --- |
| A check resolves for an active round at its recorded fix head. | Goal check resolver test. |
| A check is refused for a goal that is neither building nor verifying its own recorded fix head. | Resolver rejection test over each mismatch. |
| The round's verification runs the approved commands and reports their output. | Settings runtime verification test. |
| Only commands in the approved contract resolve during a round. | Resolver contract test. |

## Boundaries
The feature owner owns the goal check resolver and its round authorization. The
verification coordinator, the domain transitions and the publication path are
unchanged. No database migration, background worker or external API is needed.

## Success measure
The held goal in the installed Companion completes one review round whose checks
run and report their own output.
