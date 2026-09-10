# Planner assessment of independent review

Updated: 2026-09-10

## Outcome

The planner automatically receives and assesses the independent review, revises
its proposal where warranted, and presents one reviewed final plan. The user
approves or requests changes to that plan; they do not adjudicate reviewer
findings or forward feedback. This replaces the previous per-finding human
Agree/Disagree workflow in this same specification.

## User journey

1. The planner publishes a proposal. When planner review is enabled, Companion
   shows “Reviewing your plan” and withholds the final approval action.
2. The independent reviewer critiques the immutable proposal and repository base.
3. Companion durably hands the complete critique to the goal's configured planner
   model automatically, without a user message or a manual Continue action.
   The planner assesses every finding, accepting, adapting or rejecting it with
   a reason, and updates the proposal where appropriate.
4. The planner publishes the final proposal and its assessment, linked to the
   exact reviewed revision and review attempt. The UI shows “Reviewed plan ready”
   with the final outcome, scope and acceptance criteria first. A concise
   “What changed after review” summary is visible; findings, individual rationales
   and technical evidence are expandable under “Review details”.
5. The user's actions are “Approve and implement” and “Request changes”. Approval
   applies only to the exact final revision; neither model may approve it.
6. User-requested changes start a new proposal/review/assessment cycle. Review
   or assessment failures show an honest status and a retry action, preserving
   the proposal and evidence. Failed or incomplete reviews cannot be presented
   as a reviewed plan or silently unlock approval.

## Non-goals

- Changes to code review, analysis critique or review-disabled goals.
- Automatic implementation, approval, merge or deployment.
- A reviewer/planner debate loop: one independent critique and one planner
  assessment per cycle. Publishing the assessed final revision does not itself
  enqueue another review. “Reviewed” means the planner assessed an independent
  critique; it does not claim that a second reviewer certified the final edits.
- Automatic resolution of missing user requirements: a real product question
  may still be asked, without making the user decide technical review findings.
- Deleting historical human decisions or altering already-approved live goals.

## Delivery boundaries

### Storage and background orchestration

Persist the assessment lifecycle (pending, running, completed, failed or uncertain),
review identity and attempt, goal generation, source revision, final revision,
planner model identity, dispatch ownership, assessment and summary. Record each
finding's disposition and rationale, including a valid empty-findings result.
Preserve full raw review text; malformed structured findings fall back to full
text assessment, never an automatic pass. Oversized input produces an explicit
failure rather than silently dropping evidence.

Review completion queues assessment atomically and idempotently. Background
execution consumes the queue automatically through the owning planner
conversation or an explicitly resumed session with that planner's saved context
and configured model. Merely saving pending input for the next human turn does
not satisfy automatic delivery. Never inject a competing process into an occupied
terminal. Unknown dispatch ownership remains uncertain until reconciled;
restart/retry does not duplicate a planner turn or publish an extra revision.

Abort, generation changes, newer user feedback or a replaced proposal invalidate
pending work. Stale results remain historical and cannot overwrite the current
plan or unlock its approval. Source-to-final revision linkage distinguishes
assessment publication from a fresh proposal that requires a new review cycle.

### API and agent boundary

Expose assessment status and final-plan provenance through the existing plan
read payload. Validate assessment publication against the current goal,
review attempt, source revision and dispatch identity. Enforce final-plan
readiness in server-side approval checks, not only disabled UI buttons.

Treat reviewer text as untrusted evidence. The planner must assess it against the
user's intent and repository facts, preserve scope and explain rejected findings.
Review feedback never grants implementation or external-action permission.
Preserve pairing, same-origin checks, repository allow-lists and native permissions.

### UI and compatibility

Remove human Agree/Disagree controls, per-finding comment inputs and “Send
decisions to planner” from the active planner-review journey. Retire their write
routes so stale clients cannot trigger the old transition; historical data stays
readable under details. A currently unapproved completed review without an
assessment enters the automatic assessment flow once, including after upgrade.
Already approved, aborted or historical targets do not restart.

Show review and assessment progress as work in progress; only the final assessed
proposal asks for approval. Keep the final decision controls beside the plan,
with readable suggestions, expandable technical content and mobile touch targets
of at least 44px. No manual copy/paste, review forwarding or terminal Continue is
required between initial proposal publication and final-plan presentation.

## Acceptance criteria

| Criterion | One verification |
| --- | --- |
| Completed review automatically reaches the configured planner with full critique and source identity. | Backend orchestration test completes a review and observes one assessment dispatch without human input. |
| Planner assessment records all finding dispositions and publishes a linked final revision without a review loop. | Backend lifecycle test validates dispositions, provenance and exactly one review per cycle. |
| Final approval is impossible before assessment completion and remains an explicit human action afterward. | API test rejects direct premature approval and accepts only the exact completed final revision. |
| User change requests begin a fresh review cycle. | Backend lifecycle test submits feedback on the final revision and verifies a new review identity. |
| Retries, restart and duplicate completion do not create competing turns or duplicate final revisions. | Recovery test simulates crashes before and after dispatch with durable ownership assertions. |
| Stale or aborted work cannot replace a newer plan or unlock approval. | Race test changes generation, revision, feedback and abort state before result publication. |
| Failed review/assessment, uncertain dispatch, malformed findings and oversized inputs are disclosed without a false pass. | Failure-path tests assert saved status, preserved evidence and blocked approval. |
| The user sees one final plan and its summary; technical details expand and no finding decision controls remain. | UI test checks pending, ready, historical and failed states and the expandable details. |
| Mobile users reach final approval without sending review feedback or using the terminal. | Deterministic Cypress test simulates automatic progression at 390px width and verifies final actions and 44px targets. |
| Upgrade preserves old decisions and assesses only eligible current unapproved reviews once. | Migration/recovery test covers completed, approved, aborted and historical reviews. |
| Existing security restrictions hold for assessment publication and retries. | API/bridge tests reject unpaired, wrong-origin, stale-owner and out-of-scope requests. |

## Success measure

For a successful review-enabled cycle, the number of human actions between
initial proposal publication and presentation of the assessed final plan is zero.
The deterministic Cypress flow verifies this while requiring explicit final
approval before implementation.
