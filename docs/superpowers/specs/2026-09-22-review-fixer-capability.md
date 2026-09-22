# Review fixer capability

## Outcome
A review round started from the installed Companion dispatches its fixer agent
and opens a session, and a round that cannot dispatch says so instead of waiting
in silence.

## User journey
An owner presses Address review comments. Companion reads the threads, then
starts one background fixer session in a fresh worktree, exactly as it starts an
implementer. When a composition cannot supply the fixer role, the goal reports
that the round cannot start in this configuration and states that waiting will
not help. Existing rounds already stopped in the fixing state recover through
the existing Recover goal action.

## Non-goals
Do not add a configurable team role for the fixer; it keeps reusing the
integrator profile. Do not change the round state machine, the agent tool set,
the verification gate or the human publication gate. Do not relax the capability
check, dispatch a role the composition does not declare, or expose command
output, tokens or paths.

## Acceptance criteria
| Criterion | Verification |
| --- | --- |
| The saved-settings composition declares every background role the domain accepts. | Runtime capability test over the canonical role list. |
| A requested fixer attempt reaches a launch in the saved-settings composition. | Runtime dispatch test. |
| A round whose role cannot be dispatched reports a configuration fault instead of waiting. | Scheduler dispatch test. |
| Adding a role to the domain fails the build until every composition declares it. | Shared role list, asserted in the capability test. |

## Boundaries
The feature owner owns the settings capability declaration, the canonical role
list and the dispatch failure report. The domain transitions, the agent adapters
and the publication path are unchanged. No database migration, background worker
or external API is needed.

## Success measure
The held goal in the installed Companion completes one review round, with a
fixer session visible in its workspace.
