# Automatic continuation after approval

Updated: 2026-09-10

## Outcome

Approving a proposal in Companion starts implementation. The user does not
open cmux and does not type "continue". Companion delivers one approval turn to
the goal's recorded conversation, the same agent that wrote the proposal, and
that agent implements the approved revision there. Approval stays the only
human action between the reviewed plan and running code.

## Problem

Today approval records the decision, unlocks write tools for the conversation
and inserts the single `goal-session` task. Nothing reaches the agent. The
conversation ends on "tell me to continue", the board shows the goal under
Building with "Agents are working on the launched tasks", and no agent works
until the user types in cmux. The card is wrong and the step is pointless.

## User journey

1. The reviewed final plan is presented. The user taps **Approve and implement**.
2. Companion records the approval, then claims one approval delivery for that
   generation and revision and sends one prompt to the recorded workspace:
   "Proposal revision N is approved in Companion. Call get_status, then
   implement exactly its approved proposal in this conversation."
3. The agent's next turn calls get_status, sees the approved revision, and runs
   its first write tool. The existing hook records the transition as delivered.
4. The board card reads "Approval sent; the agent is starting" until the first
   write tool runs, then the existing "Agents are working" text.
5. If the conversation is not in a state that can accept a prompt, Companion
   does not send. The card and the goal sheet say why and offer **Send approval
   again** once the blocker is gone. Approval itself is never lost.
6. A correction after implementation started uses the same delivery, replacing
   the manual "type it in cmux" advice for **Request changes** on an approved goal.

## Non-goals

- Launching waves, task worktrees or a merge agent from a goal session. The
  approved contract is implemented by one accountable conversation.
- Auto-approving native permission prompts or tools. Native prompts stay.
- Retrying delivery automatically. One send per claim; uncertainty is disclosed.
- Delivering into a workspace that Companion did not start for this goal.
- Analysis goals: their approval already flips to `analyzing` inside the same
  runner without a turn; unchanged.

## Delivery boundaries

### Storage and orchestration

Reuse the transition record. `pending` means approved and not yet sent.
Add `sending` between `pending` and `dispatching`, claimed atomically with
generation, revision and a dispatch id, so a crash or a duplicate approve
request cannot send twice. `sendWorkspacePrompt` delivers; success moves the
record to `sent` with the time; a transport error moves it to `uncertain` with
the error. The hook's first write tool moves `sent` or `pending` to
`delivered` exactly as today.

Preconditions, all checked at claim time and re-checked after the inventory read:
the goal is unaborted, generation and revision match the approval, the runner
pid recorded for this generation is alive, the recorded workspace exists in the
live cmux inventory, and the goal health for that session is not `needs_you`
(a native permission or question prompt is on screen). Any failed precondition
leaves the record `pending` with a stored reason and does not send.

Restart: the existing goal-reviews sweep also picks up `pending` transitions
older than a few seconds whose approval came from before startup, so an
approval given while the companion was down is delivered once after restart.

A second approval, a request for changes, an abort or a generation change
invalidates a `pending` or `sending` delivery; a prompt is never sent for a
revision that is no longer approved.

### Prompt content

The prompt names the revision and the generation, tells the agent to call
get_status and to implement only that proposal, and says that Companion sent
it. It contains no user text and no repository content. The goal hook already
appends the goal state to every user turn, so the agent sees the approval in
context even if the prompt text is truncated by the terminal.

### API and UI

`POST /api/goal-sessions/:planId/approve` returns the plan with the delivery
state. `POST /api/goal-sessions/:planId/resend-approval` re-runs the claim for a
`pending` record whose reason is now clear; it refuses `sending`, `sent`,
`delivered` and `uncertain`. The uncertain state keeps the existing
**Reconcile** journey: the user confirms in cmux, then the hook or a manual
reconcile action moves it forward.

Board evidence and the goal sheet render four texts for Building goals:
approval sent and agent starting; agent working (first write tool ran);
approval waiting with the stored reason and a resend action; delivery
uncertain with reconcile guidance. The read-only guard covers resend.

Security: pairing, same origin and the repository allow-list apply to approve
and resend. The prompt goes only to the workspace id recorded at goal start
for the current generation. No other workspace and no arbitrary text.

## Acceptance criteria

| Criterion | One verification |
| --- | --- |
| Approval sends exactly one prompt to the recorded workspace and the agent's first write tool marks delivery. | Backend test approves a goal with a fake cmux, asserts one `sendWorkspacePrompt` call with the workspace id and revision, then runs the hook and asserts `delivered`. |
| A duplicate approve, a crash between claim and send, and a restart never send twice. | Recovery test claims, drops the process before send, restarts the sweep and asserts one send total. |
| Dead runner, missing workspace, on-screen native prompt and aborted goal leave the approval pending with a reason and no send. | Precondition tests assert `pending`, the stored reason and zero cmux calls. |
| Request changes, abort or a newer generation before send cancels delivery. | Race test changes state between claim and send and asserts no prompt and a stale record. |
| Transport failure is uncertain, not retried, and blocks resend until reconciled. | Failure test throws from cmux and asserts `uncertain`, one call, and a refused resend. |
| Resend works only for a pending record and only when preconditions pass. | API test covers pending, sent and uncertain records. |
| Card and sheet show the four delivery states and the resend action respects read-only. | UI test renders each state; Cypress runs approve at 390px and verifies the sent text without opening cmux. |
| Security restrictions hold for approve and resend. | API tests reject unpaired, wrong-origin and disallowed-repository requests. |

## Success measure

For an approved coding goal with a live conversation, the number of human
actions between **Approve and implement** and the agent's first write tool is
zero. The deterministic Cypress flow verifies this.
