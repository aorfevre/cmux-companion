# Goal decision bar

Date: 2026-10-13
Status: Approved for implementation by the user's "do the specs and build it"
after presentation of the design sections. Amended before the plan: the
observed hold was not stale, see "Observed scenario".
Owner: the implementing agent, accountable for the complete journey and cleanup.

## Outcome

A person who opens a goal page sees one state, one reason and one primary action
at the top of the page, without a scroll. Approval, recovery, retry and
publication decisions are one click from the top on both goal pages. The
proposal card shows a summary first. Old revisions and long messages collapse.

Observed problem on goal `6cdb5464` (2026-10-12): the status line said "planner
did not finish successfully", a line far below said "Goal is on hold; use manual
recovery", the Working agents card said "Claude · running", and no approve or
recover control sat near either line. The page measured about 7,600 pixels; the
open proposal alone measured about 3,800 pixels. The two needed clicks
("Recover goal", then "Approve revision 3") were far apart and far from the top.

## Relationship to existing contracts

This contract refines journey steps 4 and 8 of the CCS-based conversational
Goals spec (2026-10-12): review and approval of a proposal, and approval of
publication. It refines the Mission Control redesign's goal workspace header. It
does not change the Needs You list, the goal fleet, the action authority, the
command set, the transition rules, pairing, worktree isolation or publication
approval. Independent plan review and the human publication gate remain in force.

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
The stage badge stays in the client fleet helper, which both pages already use.

Shape:

- `state`: one sentence.
- `reason`: one line, or null.
- `primary`: one action from the projected action list, or null.

The primary action is the first offered action whose type appears in this
ordered list: `retry_startup`, `recover_goal`, `approve`, `accept_moved_target`,
`approve_publication`, `request_review_fix`, `retry_task`, `retry_attempt`,
`retry_integration`, `retry_verification`, `authorize_repair`, `resume_goal`.
The first offered `recover_goal` action is the plain "Recover goal" action.

The state and reason follow this ladder. The first matching step wins.

1. Startup failed. State: the startup error. Reason: null.
2. Hold. State: "The goal is on hold." Reason: the hold messages joined by a
   space. When recovery is refused, the reason is the refusal message instead,
   for example the running worker message.
3. An open clarification question. State: the question. Reason: null.
4. Status awaiting approval and approval offered. State: "Your plan is ready
   to approve." Reason: null.
5. Status awaiting approval and approval refused. State: "Your plan waits on a
   blocker." Reason: the refusal message.
6. Status ready to publish and the target branch moved. State: "The target
   branch moved after review." Reason: "Publishing keeps the reviewed head
   unchanged; it does not rebase or merge the target." Primary: the moved
   target acceptance.
7. Status ready to publish and publication not yet approved. State: "The
   verified result waits for your publication approval." Reason: null.
8. A current attempt failed, or its ownership is unknown. State: the attempt
   error, or "An agent needs a retry.", or "Agent ownership needs
   reconciliation." Reason: null.
9. A task failed. State: "A task needs a retry." Reason: null.
10. Paused conversation. State: "Paused." Reason: "Your messages stay queued."
11. Merged. State: "Merged on GitHub." Aborted. State: "Aborted. Evidence is
    retained." Reason: null.
12. Delivered and the pull request was closed on GitHub. State: "The pull
    request was closed without merging." Reason: "Review it on GitHub."
13. Addressing review and the fix push outcome is unknown. State: "The fix
    push outcome is uncertain." Reason: "Companion is confirming the remote
    branch."
14. Delivered. State: "Pull request published. Waiting for merge." Reason: the
    merge sync error, or null.
15. Everything else. State: a progress sentence: "N agents working." when
    workers run, otherwise "Work continues automatically. No action needed."
    Reason: null.



A refused action never renders as a disabled primary button. The refusal text
becomes the reason and the primary is absent.

Secondary actions are the remaining offered actions, read by the client from
the existing action list, minus the primary type and the composer-only types
(`send_goal_message`, `request_revision`, `answer_clarification`,
`override_assignment`). The client shows them in a "More" disclosure of
native buttons, in the projected order. Every item follows the page's disabled
state, and the disclosure closes when controls become disabled. `rename_goal` renders as "Edit title" and opens the inline
title form under the bar.

## Observed scenario

On goal `6cdb5464` the hold reason targets the current supervisor attempt,
which was cancelled after a restart. The hold is correct, not stale. Recovery
marks the supervisor for relaunch and clears the hold; approval is then offered
because the reviewer accepted revision 3. The decision bar therefore shows
"Recover goal" first, then "Approve revision 3". Both clicks are at the top of
the page. No transition rule changes.

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
- A supervisor message that renders taller than eight text lines, whether by
  newlines or by wrapping, is clamped to eight visual lines with a "Show more"
  control. The first line stays visible.
- A proposal entry renders the contract summary in place of its message text,
  so the summary is the first thing in the card and a superseded proposal's
  text stays inside its collapsed disclosure.

## Pages

- `GoalDetail` renders one shared decision bar component for both experience
  versions, above the page body.
- Conversational page: the bar replaces the header card (title, status line,
  pause and abort buttons). The thread, the Working agents card, the result
  card and the composer stay. The result card loses its approve button.
- Legacy page: the bar replaces the top card's title, attention banner and
  generic action button row. The rename form moves behind "More · Edit title".
  The tabs and their content stay.
- Browser checks that click a secondary action open the "More" menu first.
- The fleet and the Needs You list keep the client `attention()` helper and
  are unchanged.

## Non-goals

- No change to the Needs You list, fleet rows or decision count.
- No new commands, no change to action authority or transition rules.
- No change to legacy tab content, review rounds or evidence rendering.
- No parsing of supervisor prose into structured decisions.
- No change to the settings, onboarding or updater.

## Acceptance criteria

1. `decisionView` returns the ladder step and primary for each listed step,
   with a fixture for each. Verification: node test
   `tests/orchestration-decision-view.test.mjs`.
2. For every goal fixture where the client `attention()` helper returns text,
   `decisionView` returns a primary action, a question state or a hold state.
   Verification: Vitest `tests/ui-decision-bar.test.tsx` over shared fixtures.
3. A replay of the observed scenario (supervisor cancelled, reviewer accepted
   revision 3) gives primary "Recover goal" with the hold reason. After the
   recovery command the primary is "Approve revision 3". Verification: node
   test `tests/orchestration-decision-view.test.mjs`.
4. A hold while a worker still runs gives no primary and the refusal reason.
   Verification: the same node test file.
5. Both goal pages render the bar with title, stage, state, primary and "More".
   A refused action renders as a reason and no primary button. Verification:
   Vitest `tests/ui-decision-bar.test.tsx`.
6. At 390 pixels wide the bar shows the state, an offered primary button and
   an operable "More" disclosure, with the reason below the primary button.
   Verification: Cypress `goal-workspace.cy.ts` at a 390 pixel viewport with a
   fixture that offers both actions.
7. The current proposal card shows the outcome and counts first, with sections
   closed; superseded proposals render one line; a message over eight lines
   shows "Show more". Verification: Vitest `tests/ui-goal-conversation.test.tsx`.
8. Approving a plan through the bar against the disposable backend advances
   the goal, and the Needs You count before and after matches the current
   behaviour. Verification: Cypress orchestration specs, `npm run test:e2e:local`.
9. `npm run verify` passes with coverage at or above 90%. Verification: CI.

## Success measure

On goal `6cdb5464` as observed, recovery and approval take two clicks from the
top of the page with no scroll, and the page measures under 2,000 pixels before
any section is opened.
