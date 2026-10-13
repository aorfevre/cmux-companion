# Goals list and one goal page

Date: 2026-10-13
Status: Draft for human review. Design sections confirmed in conversation.
Owner: the implementing agent, accountable for the complete journey and cleanup.

## Outcome

A person opens Goals and sees every pending decision first, each with one state,
one plain reason and one button, without opening a goal. Every goal page, old
or new, uses one layout: the decision bar, a collapsed proposal, the thread or
request, working agents, the result, one composer and one technical disclosure.
A refused action is never a dead end; the next step is always a button. New
goals use the supervisor flow by default when a supervisor is configured.

Observed on the live Mac (2026-10-13), after the decision bar shipped:

- Mission Control and Needs You rows show an activity label, a stage badge, a
  wave count, a session count and raw hold text. None of them is a button.
- The stage badge contradicts the row: "In progress" next to "On hold".
- Hold text is agent jargon: "reviewer did not finish successfully."
- Four KPI tiles and six chips sit above the first goal; on a phone the first
  goal is below the fold.
- Legacy goal pages still measure about 3,900 pixels under the bar, with five
  tabs and the full contract open.
- "Model on Start a Goal" shows "Request a plan revision to address the
  blocking review" with no button; the seven findings sit behind a disclosure.
- The composer hides the conversational flow behind an evaluation checkbox, so
  most goals land in the legacy page.

## Relationship to existing contracts

This contract supersedes, for the Goals surface, the Mission Control redesign's
two destinations (Mission Control and Needs You), its stage counts, its KPI
tiles and its five goal detail tabs. It supersedes the CCS-based conversational
Goals spec's "opt-in during evaluation" sentence; that spec is amended in its
own commit before the plan. It extends the goal decision bar spec (2026-10-13)
with translated reasons, next steps and ranks. Authority, commands, transition
rules, pairing, worktree isolation, review gates and publication approval are
unchanged. Existing goals keep their experience version; nothing migrates.

## User journey

1. Open Goals. One list shows every goal, decisions first. Each row shows the
   title and project, one state sentence, one reason line, one button and
   "More", with the stage badge and last activity in a grey footer.
2. Click the row's button. The command runs; the row refreshes in place. A
   version conflict shows the existing conflict message in place of the reason.
3. Click the row body to open the goal. The page opens with the decision bar,
   then the collapsed proposal, the thread (or the request for a legacy goal),
   working agents, the result card, the composer and "Technical details".
4. When no action is offered but a person can still act, the bar and the row
   show the next step as the button: "Request revision" opens the composer with
   the review findings as prefilled context; "Answer question" focuses the
   answer form; "Message supervisor" focuses the composer.
5. Start a goal. When a supervisor profile is configured the composer uses the
   supervisor flow with the first ready profile preselected. When none is
   configured, the composer uses the planner flow and shows "Add a supervisor
   in Setup for conversational goals." with a link.
6. On a phone at 390 pixels, the first row's button is visible without a
   scroll, and the page never scrolls horizontally.

## Goals list

- Route `/orchestration`. `?view=needs` redirects to `/orchestration` with the
  "Needs you" chip selected. Navigation shows one "Goals" link; "Mission
  Control" and "Needs You" links are removed.
- Heading "Goals", the "Start a goal" button, a search box and three chips:
  "Needs you" (rank 0), "Active" (rank 1), "Done" (ranks 2 to 4). No KPI tiles
  and no execution capacity disclosure; capacity stays in Setup.
- Rows sort by `decision.rank`, then by last activity, newest first.
- Each row: title, project, `decision.state`, `decision.reason`, the primary or
  next-step button, "More" with the secondary actions, and a footer with
  `decision.stage` and the last activity time. The row body opens the goal;
  the buttons act without navigation. Aborted goals show a grey stage badge.
- Empty states per chip: "Nothing needs you", "No active goals", "No finished
  goals", and "No matching goals" with a search.

## Decision view

`decisionView(goal)` gains four fields. The browser reads them and derives
nothing; the client helpers `attention()` and `goalStage()` are deleted.

- `reason`: a translated sentence with a hint. `detail`: the raw domain text,
  shown only in Technical details. Translations by hold kind:
  - attempt: "The {role} stopped before it finished. Recover to run it again."
    The role word is planner, plan reviewer, implementer, reviewer, integrator
    or review fixer; a supervisor attempt reads "supervisor".
  - review (plan): "The plan review asked for changes. Request a revision with
    your guidance."
  - review (task or integration): "An independent review asked for changes.
    Recover to repair them."
  - integration: "Combining the work hit a conflict. Recover to repair it." or
    "Combining the work failed. Recover to retry it."
  - verification: "Checks failed on the integrated commit. Recover to repair
    them." Prepare failure: "Dependencies did not install on the integrated
    commit. Inspect the check output, then recover."
  - publication: "The pull request outcome is uncertain. Recover after you
    confirm it on GitHub."
  - review_fix: "Addressing review comments failed. Recover to try again." or
    "The fix push outcome is uncertain. Companion is confirming the branch."
  When recovery is refused, the reason is the refusal translated: "Workers are
  still running. Recovery opens when they stop." for ownership, "A plan
  revision is required before recovery." for a blocking plan review, and the
  raw refusal otherwise. Non-hold reasons keep their current wording.
- `next`: set only when `primary` is null and the action list offers it. One of
  `{ type: 'request_revision', label: 'Request revision', context: string }`,
  `{ type: 'answer_clarification', label: 'Answer question' }` or
  `{ type: 'send_goal_message', label: 'Message supervisor' }`. The context for
  a revision is the blocking plan review's findings, one line each:
  "{severity}: {title}. {suggestion}". The composer is prefilled with the
  context above an empty line for the person's guidance.
- `rank`: 0 when `primary` or `next` is set, 1 for discovering, awaiting
  approval, building, addressing review and ready to publish, 2 for delivered,
  3 for merged, 4 for aborted.
- `stage`: the current fleet labels, computed on the server with the same
  rules, plus "On hold" when a hold exists and "Paused" when paused.

A node test asserts every hold kind and every refusal code has a translation.

## One goal page

The legacy tabbed detail is removed. Every goal renders:

1. The decision bar.
2. The thread. Conversational goals show messages. Legacy goals show one card
   with the original request, then the contract as the collapsed proposal card
   with "Approved." or "Request changes below."
3. The working agents card and the result card, as today.
4. The clarification form for a legacy planner question, above the composer.
5. The composer. Conversational: "Message your supervisor". Legacy: "Request a
   revision", which sends the revision command. A `next` of revision opens the
   composer prefilled with its context and focuses it.
6. "Technical details" as one disclosure with stacked sections: source and
   base with the reconcile control, waves and sessions with terminal controls,
   team and models, integration, review rounds, independent reviews, combined
   verification, verification runs, worker checks and activity. The content of
   today's five tabs moves there unchanged, as sections with headings.

## Composer

- The "Try conversational Goals (evaluation)" checkbox is removed.
- With at least one supervisor profile, the supervisor flow is used. The
  supervisor select shows the readiness check and preselects the first ready
  profile.
- With no supervisor profile, the planner flow is used with the note "Add a
  supervisor in Setup for conversational goals." linking to Setup.
- Title, request, references, project and base branch are unchanged.

## Non-goals

- No change to commands, transitions, authority, review gates or publication.
- No migration of existing goals between experience versions.
- No change to Sessions, Setup, Account usage or the updater.
- No change to evidence content; it only moves behind the disclosure.
- No new agent prose parsing; the supervisor's words are not the reason.

## Acceptance criteria

1. Every hold kind, refusal code and non-hold ladder step has a translated
   reason and the raw detail. Verification: node test
   `tests/orchestration-decision-view.test.mjs`.
2. `next` is set for a blocking plan review, an open clarification and a
   refused action on a conversational goal, with the revision context built
   from the findings. Verification: the same node test.
3. `rank` orders a fixture set as decisions, active, delivered, merged,
   aborted. Verification: the same node test.
4. The list sorts by rank then activity, the chips filter by rank, and a row
   button runs the command without opening the goal. Verification: Vitest
   `tests/ui-goals-list.test.tsx`.
5. A legacy goal renders the shared layout with the request card, the
   collapsed contract, the revision composer and the technical disclosure
   holding every former tab section. Verification: Vitest
   `tests/ui-goal-page.test.tsx`.
6. A `next` of revision opens the composer prefilled with the findings and
   focused, on both the row and the bar. Verification: Vitest.
7. The composer defaults to the supervisor flow with a configured profile and
   to the planner flow with the note otherwise. Verification: Vitest
   `tests/ui-orchestration.test.tsx`.
8. Navigation shows one "Goals" link and `?view=needs` lands on the list with
   "Needs you" selected. Verification: Cypress `goals-navigation.cy.ts` and
   `mission-control.cy.ts`, rewritten for the list.
9. At 390 pixels the first row's button is visible without a scroll and the
   document never scrolls horizontally. Verification: Cypress
   `goal-workspace.cy.ts`.
10. The real-backend Cypress journeys pass through the list and the shared
    page. Verification: `npm run test:e2e:local -- --orchestration`.
11. `npm run verify` passes with coverage at or above 90%. Verification: CI.

## Success measure

On the live Mac, every pending decision across all goals is visible and
actionable from the Goals list without opening a goal, and no row or bar shows
raw agent text as its reason.
