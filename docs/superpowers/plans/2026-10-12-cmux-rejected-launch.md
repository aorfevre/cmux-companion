# cmux-rejected launch releases its slot — implementation plan

Status: draft for approval. Bug fix; no product decision, so no spec change.

## Problem (observed 2026-10-12)

cmux 0.65 lost its socket password, and every `workspace.create` RPC failed with
`Error: ERROR: Invalid password` (or `auth_required`). `CmuxTerminal.rpc` throws
`CMUX_UNAVAILABLE` for every failure, so the adapter cannot tell a rejection from a
lost response. The planner terminal kept only `create-sent.json`, `observe()`
returned `unknown` with no identity forever, reconcile and abort could not release
it, and the attempt held a planner slot until an operator wrote `outcome.json`.

## Outcome

When cmux refuses a launch before it creates a workspace, Companion records a
failed, stopped attempt with a reason that names the cmux setting. The slot is
free at once. A lost or unclear response stays uncertain, as today.

## Probe evidence (cmux 0.65.0, read-only `workspace.list`)

| Condition | Exit | Output |
| --- | --- | --- |
| Wrong password | 1 | stderr `Error: ERROR: Invalid password` |
| Password mode, none in Settings | not recorded | `Error: ERROR: Password mode is enabled but no socket password is configured in Settings.` (stream not recorded) |
| No credential sent | not recorded | `Error: auth_required: Authentication required. Send auth <password> first.` (stream not recorded) |
| No socket | 1 | stderr `Error: Socket not found at <path>` |
| Unknown method | 1 | stderr `Error: method_not_found: Unknown method` |

The probes for rows 2 and 3 merged both streams and did not keep the exit code, so
the classifier reads stderr and stdout, on any exit code. A refusal in this table
proves that cmux created nothing. Every other failure
(timeout, kill, unknown text, unparseable stdout) keeps `CMUX_UNAVAILABLE`.

## Phase 1 — interactive planner (5 files)

1. `server/orchestration/adapters/cmux.mjs`: `rpc()` classifies stderr and stdout on
   a failed exit, and stdout when the exit is 0 but the output is not JSON. The
   tokens `auth_required`, `Invalid password` and `no socket password is configured`
   → `CMUX_AUTH_REJECTED`;
   `Socket not found` → `CMUX_SOCKET_MISSING`. Messages stay fixed text; raw cmux
   output never leaves the adapter. Export `CMUX_REFUSALS`.
2. `server/orchestration/domain/launch-recovery.mjs`: export one predicate
   `isLaunchFailure(code)` for `PROVIDER_SPAWN_*` plus the two cmux codes, and
   `launchFailureMessage(code)` for the operator text. cmux codes are not
   transient: no automatic retry against a refused socket.
3. `server/orchestration/adapters/native-terminal.mjs`: only around
   `terminal.create`, a refusal code writes `outcome.json`
   `{identity, workerState:'stopped', code}` and rethrows. `observe()` uses the
   shared predicate for `launchFailure`.
4. `server/orchestration/reconciler.mjs`: records `launchFailureMessage(code)`.
   `CMUX_AUTH_REJECTED` gives "cmux refused the launch (CMUX_AUTH_REJECTED). Set the
   socket password in cmux → Settings → Automation, then recover the goal."
   `CMUX_SOCKET_MISSING` gives "cmux was not reachable (CMUX_SOCKET_MISSING). Start
   cmux, then recover the goal." Provider codes keep "Provider could not start".
5. Tests: `tests/orchestration-native-terminal.test.mjs` (fake cmux bin per refusal
   row, plus the fixture create refusing → stopped observation, `close()` succeeds,
   lost response still uncertain) and `tests/orchestration-reconciler.test.mjs`
   (stopped + cmux code → failed attempt, capacity released, no auto retry, hold).

## Phase 2 — background workers (3 files)

1. `server/orchestration/adapters/native-background.mjs`: a refusal at
   `terminal.create` writes `not-sent.json` with the code and throws that code, not
   `OWNERSHIP_UNCERTAIN`. `observe()` returns `launchFailure` from `not-sent.json`
   and uses the shared predicate for `outcome.json`.
2. `tests/orchestration-native-background.test.mjs`: refusal → stopped with
   `launchFailure`; generic create error → still uncertain.
3. This plan file, if text changes during review.

## Non-goals

- The hold text "planner did not finish successfully" (product copy).
- A refusal at `surface.send_text` after a workspace exists (orphan workspace).
- Clearing a false hold after a slow `ps` check (separate fix 2).
- Passing `CMUX_SOCKET_PASSWORD` to the orchestration environment: cmux rejects an
  env password when its own store is empty, so it would not prevent this failure.

## Verification

Per phase: `node --test` on the touched suites. Final: `npm test`, `npm run test:ui`,
`npm run lint`, `npm run typecheck`, `npm run verify` (90% line coverage). No
Cypress: the change has no UI path a fake cmux can reach in the browser harness;
the reconciler test covers the visible `attempt.error` text.

## Delivery

Branch `fix/cmux-rejected-launch` from `origin/main`, one local commit per phase.
No push or PR until the owner asks.
