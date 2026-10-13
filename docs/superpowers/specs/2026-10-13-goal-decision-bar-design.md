# Goal decision bar

Date: 2026-10-13
Status: Draft for human review.
Owner: the implementing agent, accountable for the complete journey and cleanup.

## Outcome

A person who opens a goal page sees one state, one reason and one primary action
at the top of the page, without a scroll. Approval, recovery, retry and
publication decisions are one click from the top on both goal pages. The
proposal card shows a summary first. Old revisions and long messages collapse.
A restarted supervisor no longer leaves a stale hold that blocks approval.

Observed problem on goal `6cdb5464` (2026-10-12): the status line said "planner
did not finish successfully", a line far below said "Goal is on hold; use manual
recovery", the Working agents card said "Claude · running", and no approve or
recover control sat near either line. The hold reason was a cancelled planner
attempt superseded by the restart. The page measured about 7,600 pixels; the
open proposal alone measured about 3,800 pixels. Approval needed two clicks
("Recover goal", then "Approve revision 3") that the page did not place together.

## Relationship to existing contracts

This contract refines journey steps 4 and 8 of the CCS-based conversational
Goals spec (2026-10-12): review and approval of a proposal, and approval of
publication. It refines the Mission Control redesign's goal workspace header. It
does not change the Needs You list, the goal fleet, the action authority, the
command set, pairing, worktree isolation or publication approval. Independent
plan review and the human publication gate remain in force.

## User journey

1. Open a goal page, conversational or legacy. The decision bar is fixed at the
   top of the goal area. It shows the goal title, the stage badge, one state
   sentence, one reason line when the reason adds information, one primary
   button and a "More" menu with the secondary actions.
2. Read the state and the reason. Example: state "Your plan is ready to approve",
   reason absent. Example: state "The goal is on hold", reason "planner did not
   finish successfully."
3. Click the primary button. The command runs through the existing action path.
   The bar refreshes with the next state. A version conflict shows the existing
   refresh message in the bar.
4. Scroll the thread when a decision needs the content. The current proposal
   card shows the outcome in one line and a row of counts. Each section opens on
   click. Old proposals show one line each. Long supervisor messages show their
   first eight lines and a "Show more" control.
5. Request changes in the message box. The proposal card has no buttons; it
   ends with "Request changes in the message box below."
6. On a phone at 390 pixels wide, the bar shows the state, the primary button
   and the "More" menu. The reason sits below the primary button.

## Decision view

A pure function `decisionView(goal)` in `server/orchestration/domain/` sits
next to the action projection. The state view includes its result as
`goal.decision`. The browser renders it and keeps no decision logic of its own.

Shape:

- `stage`: the badge text. The fleet's client stage helper moves to the server
  and the client reads this field.
- `state`: one sentence.
- `reason`: one line, or null.
- `primary`: one action from the projected action list, or null.
- `secondary`: the remaining user actions, in a fixed order: pause or resume,
  request revision, retry actions, recover actions, edit title, abort.

Priority ladder, most urgent first. The first matching step wins.

1. Startup failed. State: the startup error. Primary: Retry startup.
2. Hold, and the recover action is offered. State: "The goal is on hold."
   Reason: the hold messages joined. Primary: Recover goal.
3. Hold, and the recover action is refused. State: "The goal is on hold."
   Reason: the refusal message, for example the running worker. Primary: none.
4. An open supervisor question or clarification. State: the question. Primary:
   none; the message box or the answer form is the answer path.
5. Status awaiting approval, review done, approval offered. State: "Your plan
   is ready to approve." Primary: Approve revision N.
6. Status awaiting approval, approval refused for another reason. State: "Your
   plan waits on a blocker." Reason: the refusal message. Primary: none.
7. Status ready to publish, not yet approved. State: "The verified result waits
   for your publication approval." Primary: Approve & publish PR.
8. A failed task or a failed current attempt with a retry offered. State: the
   attempt error or "A task needs a retry." Primary: that retry action.
9. Paused conversation. State: "Paused." Primary: Resume goal.
10. Merged or aborted. State: the stage. Primary: none. Secondary: Edit title only.
11. Everything else. State: a progress sentence from the stage and the running
    workers, for example "Claude implements task 2. No action needed." Primary:
    none.

A refused action never renders as a disabled primary button. The refusal text
becomes the reason and the primary is absent.

## Stale hold rule

In the domain transition for `retry_attempt` on a supervisor attempt: when
every hold reason has kind `attempt` and targets an attempt of that supervisor
that the restart supersedes, the transition clears the hold. The cleared hold
goes into the recoveries list with the restart command id, as a manual recovery
does today. A hold with any reason of another kind, or that targets another
attempt, stays in place.

## Proposal card and thread

Conversational page only. The legacy contract card already shows the outcome
and is unchanged.

- The current proposal card opens with `contract.outcome` in one line, then one
  row of counts: scope items, acceptance criteria, checks, tasks.
- Scope, Excluded, Acceptance, Checks and Assignments each open on click. The
  open state persists in session storage, keyed by goal and section.
- A superseded proposal renders one line: "Proposal 1 · Superseded by 3", with
  a click to open the same summary and sections.
- The card has no buttons. It ends with "Request changes in the message box
  below." An approved revision shows "Approved."
- A supervisor message longer than eight lines shows its first eight lines and
  a "Show more" control. The first line stays visible.

## Pages

- `GoalDetail` renders one shared decision bar component for both experience
  versions, above the page body.
- Conversational page: the bar replaces the header card (title, status line,
  pause and abort buttons). The thread, the Working agents card, the result
  card and the composer stay. The result card loses its approve button.
- Legacy page: the bar replaces the top card's title, attention banner and
  generic action button row. The rename form moves behind "More · Edit title".
  The tabs and their content stay.
- The fleet and the Needs You list keep the client `attention()` helper and
  are unchanged.

## Non-goals

- No change to the Needs You list, fleet rows or decision count.
- No new commands, no change to action authority or the transition rules other
  than the stale hold rule.
- No change to legacy tab content, review rounds or evidence rendering.
- No parsing of supervisor prose into structured decisions.
- No change to the settings, onboarding or updater.

## Acceptance criteria

1. `decisionView` returns the ladder step for each listed step, with fixtures
   for each. Verification: node test `tests/orchestration-decision-view.test.mjs`.
2. For every goal fixture where the client `attention()` helper returns text,
   `decisionView` returns a primary action or a question state. Verification:
   node test in the same file over the shared UI fixtures.
3. A replay of the observed scenario (planner cancelled, supervisor restarted
   by `retry_attempt`, reviewer succeeded on revision 3) ends with no hold,
   the restart command id in recoveries, and primary "Approve revision 3".
   Verification: node test `tests/orchestration-recovery.test.mjs`.
4. A hold with a review reason stays after a supervisor restart. Verification:
   the same node test file.
5. Both goal pages render the bar with title, stage, state, primary and "More".
   A refused action renders as a reason and no primary button. Verification:
   Vitest `tests/ui-orchestration.test.tsx`.
6. At 390 pixels wide the bar shows the state, the primary button and "More",
   with the reason below the primary button. Verification: Vitest viewport test.
7. The current proposal card shows the outcome and counts first, with sections
   closed; superseded proposals render one line; a message over eight lines
   shows "Show more". Verification: Vitest `tests/ui-orchestration.test.tsx`.
8. Approving a plan through the bar against the disposable backend advances
   the goal, and the Needs You count before and after matches the current
   behaviour. Verification: Cypress orchestration spec, `npm run test:e2e:local`.
9. `npm run verify` passes with coverage at or above 90%. Verification: CI.

## Success measure

On goal `6cdb5464` as observed, approval takes one click from the top of the
page with no scroll, and the page measures under 2,000 pixels before any
section is opened.
