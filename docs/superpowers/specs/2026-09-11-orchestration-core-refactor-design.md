# Orchestration core refactor

Updated: 2026-09-11
Context: ../../research/2026-09-11-cmux-ecosystem-survey.md

## Outcome

The companion's goal pipeline (discovery, review and assessment, approval and
delivery, waves and merge, pull request observation) becomes five stage
modules with one shape, driven by one event log and one agent runner. Adding
the next stage, or reacting to a cmux event instead of a timer, becomes a
bounded change in one module. Behaviour visible to the user does not change.

## Problem

`server/worktree-plan-store.mjs` (1,783 lines, about 90 public methods) owns
every stage's tables, claims and records. `server/app.mjs` (1,274 lines)
wires 61 constructors by hand. Five modules build their own `ccs` command and
parse their own reply; ten modules parse verdicts in their own shape. Board
state is derived in six places. Four timers poll SQLite and cmux. Each new
feature (this week: planner assessment, approval delivery) had to touch the
store, the service, the bridge, the board, the summary mapping and the UI.

## Non-goals

- Changing any user journey, API route, database file or CLI contract.
- A new language or runtime. Server modules ship to the browser as is.
- A native shell. That is a later, separate decision.
- Replacing the timers with cmux events. This refactor makes that possible;
  it does not do it, because the cmux event channel (#3944) is not released.
- Rewriting tests. Existing tests keep passing at every phase; new tests
  cover the new seams only.

## User journey

Unchanged. The acceptance criteria measure that.

## Design

### Phase 1: stage modules with one shape

Split the plan store into one module per stage under `server/stages/`:

| Module | Owns today |
| --- | --- |
| `discovery.mjs` | goal session reserve/start, runner dispatch and claim, questions, answers, steering, planning failures |
| `proposal.mjs` | publish, request changes, provider session, review queue hook |
| `approval.mjs` | approve, approval delivery (claim, defer, record, pending), transition claim and record, corrections |
| `delivery.mjs` | rounds, edits, launches, waves, task ready/pending/relaunch/skip, integration, merge, followups, cleanup, session retirement |
| `outcome.mjs` | final PR, merged, aborted, issues returned, board pull request |

Each module exports functions that take `(db, stamp, insertEvent)` bound by
the store and follow one vocabulary: `claim*` moves to an owned in-progress
state atomically and returns the row or null; `record*` finishes an owned
claim and never demotes a later state; `cancel*` invalidates pending work on
generation, revision or abort change; `pending*` lists work a sweep may pick
up. `WorktreePlanStore` keeps its public method names as thin delegates, so
every caller and test is untouched. The row mapping (`get`, `list`) moves to
`server/stages/read-model.mjs`.

### Phase 2: the event log as the source of truth

`plan_events` already records every transition. Make it authoritative:

- Every `claim*`, `record*` and `cancel*` writes its event inside the same
  transaction, with generation, revision and dispatch id where they exist.
- A `server/plan-events.mjs` bus emits each committed event in process.
  Subscribers: the websocket hub (replaces per-route `bootstrapSnapshot = null`
  invalidation), the push service, and the sweeps, which keep their timers but
  also wake on a relevant event so a state change is acted on within one tick.
- Board state derivation (`goal-board.mjs`) reads only from the read model.
  The five other derivation sites delegate to it. `plannerReviewPhase` and
  `approvalDeliveryMessage` stay in `goal-options.mjs` as the shared UI
  vocabulary.
- One `events(planId, { since })` query with a cursor, so a future cmux event
  channel and a flotilla-style work item view are queries, not new tables.

### Phase 3: one agent runner and one verdict shape

- `server/agent-run.mjs`: builds the `ccs` command from `{ provider, model,
  effort, tools, hooks, resume, fork, prompt }`, applies the shared limits
  (ceiling, idle, buffer, process group, abort signal), records the pid
  through a callback, and turns every failure into the one readable message
  (`describeProcessFailure`). Planner rounds, interactive discovery, reviews,
  assessments, burst scans and account usage call it.
- `server/verdict.mjs`: one parser for `### Overall: PASS|FAIL` plus the
  fenced `findings` block, returning `{ verdict, findings, markdown }`.
  Planner review, burst review and code review use it. Prompts ask for that
  exact shape. Existing saved results still parse, because the findings block
  is unchanged and a missing verdict line maps to the current fallback.
- The task hook gains one rule from the survey: deny `git commit --no-verify`
  and `--no-gpg-sign` for task agents, with a test.

## Acceptance criteria

| Criterion | One verification |
| --- | --- |
| The public store API and every API route are unchanged. | `npm run verify` passes with no test edits other than new files; the route list snapshot test is byte-identical. |
| Each stage module exposes only claim, record, cancel, pending and read helpers, and no module imports another stage. | A structure test lists exports per stage module and asserts the import graph. |
| Every state transition writes its event in the same transaction. | A store test wraps each `record*` in a failing follow-up statement and asserts no row and no event. |
| The websocket hub and push service react to events, not to route side effects. | A test emits one event and asserts one hub broadcast and one push inspection with no route call. |
| A sweep acts on a change within one tick after its event. | A fake-timer test emits `proposal_approved` and asserts delivery ran before the next interval. |
| One runner builds every `ccs` invocation. | A grep-style test asserts `"ccs"` appears only in `agent-run.mjs`; existing command-shape tests pass through the runner. |
| One verdict parser serves planner, burst and code review, and old results still parse. | Fixture tests feed saved results from all three and assert identical findings. |
| Task agents cannot bypass hooks. | Hook test denies `--no-verify` and allows a normal commit. |
| Mobile journeys are unchanged. | The full local Cypress suite passes with no spec edits. |

## Success measure

Adding the next stage feature touches one stage module, one event kind and
one UI message, measured on the first feature after the refactor.
