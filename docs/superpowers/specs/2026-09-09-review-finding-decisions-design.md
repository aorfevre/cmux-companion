# Review finding decisions design

Date: 2026-09-09

## Outcome

After the independent planner review finishes, the user decides on each
finding one by one and sends the accepted findings to the planner as one change
request. The planner revises the proposal from those decisions. The user no
longer copies review text by hand into the conversation.

## User journey

1. A goal session publishes proposal revision N. The independent planner review
   runs and completes.
2. The proposal screen shows a **Planner review** section. Each finding is one
   card with its severity, title, evidence and suggestion.
3. On each card the user picks **Agree** or **Disagree**, and can type a short
   comment. Each pick saves at once.
4. When every finding has a decision, the user presses **Send decisions to
   planner**. Companion builds one change request from the agreed findings and
   the comments, and hands it to the planner conversation as it does today for
   **Request changes**.
5. The planner revises. It publishes revision N+1. A new review runs when the
   reviewer flag is on. The old review and its decisions stay visible as a
   historical target.
6. If the user agrees with nothing, **Send decisions to planner** is disabled.
   The user can approve the revision with **Approve and implement**; the
   disagreements stay on record.

## Non-goals

- Code reviews and analysis critiques do not change.
- The reviewer's text is never edited by the user.
- No automatic re-review after the revision beyond the existing reviewer flag.
- No planner reply per finding. The planner answers through the next revision.
- No decision on a historical review target; only the current revision's review
  accepts decisions.

## Architecture

### Reviewer output

`reviewCommand()` in `server/goal-reviews.mjs` asks the reviewer for a fenced
`json` block before its free Markdown. The block shape is:

```json
{ "findings": [ { "id": "F1", "severity": "high", "title": "…", "evidence": "…", "suggestion": "…" } ] }
```

`severity` is one of `high`, `medium`, `low`, `note`. `id` matches
`/^[A-Za-z0-9_-]{1,16}$/`. Every string is trimmed and capped at 2,000 bytes.
At most 40 findings are kept.

A new pure module `server/review-findings.mjs` exports
`parseReviewFindings(markdown)`. It returns `{ findings, markdown }`. When no
valid block exists, it returns one finding `{ id: "review", severity: "note",
title: "Review findings", evidence: markdown, suggestion: "" }`. The full
result Markdown is always kept so nothing the reviewer wrote is lost.

### Data

`goal_reviews` gains one column `findings` (JSON text, null until completion).
`GoalReviews.run()` stores parsed findings when it records a completed planner
review. Code and analysis reviews leave the column null.

New table `goal_review_decisions`:

| column | type | note |
| --- | --- | --- |
| `review_id` | text | foreign key to `goal_reviews.id` |
| `finding_id` | text | matches a finding `id` of that review |
| `verdict` | text | `agree` or `disagree` |
| `comment` | text | trimmed, at most 1,000 bytes, may be empty |
| `updated_at` | text | ISO stamp |

Primary key is (`review_id`, `finding_id`). `goal_reviews` gains
`decisions_sent_at` (ISO stamp, null until sent).

`GoalOutcomeStore` gains `decide(reviewId, findingId, { verdict, comment })`
and `markDecisionsSent(reviewId)`. `reviewRow()` returns `findings`,
`decisions` (list) and `decisionsSentAt`, so the planner sheet reads them from
the existing plan payload.

### API

Both routes live next to the existing review actions in `server/app.mjs` and
use `WRITE_SCHEMAS` entries.

- `PUT /api/goal-sessions/:planId/reviews/:reviewId/decisions/:findingId` with
  body `{ verdict, comment }`. Refuses a review that is not `completed`, not of
  kind `planner`, not the current proposal revision, or already sent. Returns
  the plan.
- `POST /api/goal-sessions/:planId/reviews/:reviewId/send-decisions` with body
  `{ generation, revision }`. Refuses unless every finding has a decision and at
  least one is `agree`. Builds the feedback text with
  `reviewDecisionFeedback(review)` from `server/review-findings.mjs`, calls
  `planStore.requestProposalChanges(planId, { generation, revision, feedback })`,
  then `markDecisionsSent(reviewId)` in the same transaction. Returns the plan.

Both routes honour the existing read-only guard on the board.

### Feedback text

`reviewDecisionFeedback(review)` renders a fixed template:

```
Independent review decisions for proposal revision N.

Apply these findings:
## [high] Title
Evidence: …
Suggestion: …
Comment: …

Do not apply these findings:
- Title — reason: …
```

Sections with no entries are omitted. The text is capped at 4,000 bytes to
match `requestProposalChanges`; when the cap is hit, evidence is truncated first
and a final line says how many findings were shortened.

### UI

`app/goal-outcomes.tsx` renders the review card. For a completed planner
review on the current revision it shows one `article` per finding with:

- a severity badge and the title,
- evidence and suggestion as Markdown,
- a radio group **Agree** / **Disagree** named by the finding title,
- a comment `textarea` with placeholder "Optional comment for the planner",
- a saved / saving status line.

Below the cards: **Send decisions to planner**, disabled until every finding has
a verdict and at least one is `agree`, and a count line "3 of 5 decided". After
sending, the section shows "Decisions sent on <time>" and the controls become
read-only. The free Markdown stays available under a "Full review text"
disclosure.

The **Approve and implement** button keeps its current rule: a completed or
acknowledged review unlocks it. Decisions do not gate approval.

## Acceptance criteria

| criterion | verification |
| --- | --- |
| A review result with a valid findings block yields one card per finding, in order. | `tests/review-findings.test.mjs`: parse fixture with three findings. |
| A review result without a block yields one "Review findings" card with the full text. | Same test file: fallback case. |
| Invalid ids, unknown severities and over-long strings are dropped or capped without failing the review. | Same test file: hostile fixture. |
| A decision saves and reloads with its comment. | `tests/goal-outcomes.test.mjs`: `decide` then `review()`. |
| Sending requires every finding decided and one agreement; otherwise the route returns 400 with the reason. | `tests/api-routes.test.mjs`: three inject cases. |
| Sending creates exactly one proposal change request with the template text and stamps `decisionsSentAt`. | `tests/api-routes.test.mjs`: assert the stored `goal_session_pending_input` and the event. |
| A historical review target refuses decisions. | `tests/api-routes.test.mjs`: publish revision 2, decide on revision 1's review, expect 409. |
| The UI shows cards, saves on each pick, counts decisions and enables Send only when allowed. | `tests/ui-goal-outcomes.test.tsx`: render with three findings, click, assert requests and button state. |
| The end-to-end flow works in a browser. | `cypress/e2e/review-decisions.cy.ts`: agree, disagree, comment, send, then the next revision appears. |
| Read-only protection blocks both routes and disables the controls. | Existing read-only Vitest and Cypress patterns extended to the new controls. |

## Success measure

A completed planner review with findings reaches the planner as one change
request with zero manual copying of review text. Measured in the Cypress spec by
asserting the request-changes body equals the rendered template.
