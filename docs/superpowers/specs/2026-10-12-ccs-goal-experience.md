# CCS-based conversational Goals

Date: 2026-10-12
Status: Approved for implementation by the user's “implement the goal. I approve
it”, after presentation of spec commit `aa8b19c4` and its human-review request.
Owner: the implementing agent, accountable for the complete journey and cleanup.

## Outcome

Deliver a new Goals experience that the user can run locally and test from their
browser: discuss an outcome, review a useful proposal, dispatch agents, follow
their work, correct direction, inspect verified changes and approve publication.
The user's CCS setup and xclaude/xcodex launchers are the execution foundation for
every agent role. A direct SDK or provider CLI must not silently replace them.

A goal has one durable conversation and one supervisor responsible for explaining
and advancing it. Companion retains deterministic authority over permissions,
worktree ownership, dispatch, checks, integration and publication. Agent prose,
terminal exit and a supervisor's claim of completion are not delivery evidence.

## Relationship to existing contracts

Once reviewed, this contract supersedes the Mission Control redesign's mandatory
upfront wave planning, separate planner-question lifecycle and manual recovery
for routine recoverable failures for goals created in the new experience. It
also supersedes the settings/onboarding contract's alias-only launcher limitation
for explicitly configured, validated xclaude/xcodex launch adapters.

Existing orchestration security, exact-commit review, worktree isolation,
idempotent commands, private pairing and human publication approval remain in
force. Existing goals retain their execution contract; no active goal is silently
migrated and no two engines own the same goal. The updater is unchanged.

The new experience is opt-in during evaluation and uses an explicit persisted
experience version. Its disposable development entry point must exercise the
same service and UI paths as production composition, with external adapters
substituted. It must not be a disconnected mockup or a chat overlay on an
unchanged stop-and-replace planning flow.

## User journey

1. Select a project and a configured supervisor launch profile. Existing team
   defaults supply worker/reviewer profiles. See actionable launcher readiness
   before starting; account capacity that cannot be measured remains unknown.
2. Describe the outcome and attach references in a goal composer. Starting opens
   the goal conversation immediately and shows repository preparation or its
   specific failure. A failure retains the request and offers an appropriate retry.
3. Discuss scope with the supervisor in the same conversation. Read progress and
   answer questions there. A question pauses the turn for input; it does not
   revoke the goal generation, kill the supervisor or require worker reconciliation.
4. Review a proposal card showing outcome, scope, exclusions, acceptance criteria,
   checks and recommended assignments. Request changes conversationally or approve
   that exact revision. Independent plan review remains governed by the existing
   setting; findings are addressed before approval when it is enabled.
5. After approval, the supervisor advances implementation through service-owned
   dispatch. Start with one implementer by default. Add independent workers when
   justified, with explicit task scope and dependency checks. See who is working,
   what changed, the latest meaningful progress and any outstanding decision.
6. Send messages during execution. Messages are durably queued or delivered with
   a visible acknowledgement. Scope-changing requests produce a revised proposal
   and invalidate affected approval; ordinary clarification stays in the thread.
7. Agents edit, run approved checks inside their worktrees and fix failures within
   a bounded repair budget. Expected coding failures are handled by the system.
   Authentication problems, new authority requests, exhausted budgets or uncertain
   ownership explain the blocker and present one relevant next action.
8. Review a result card with changed files/diff, independent review, check results
   and remaining limitations for the exact integrated commit. Request changes in
   the same conversation or explicitly approve publishing that commit as a PR.
9. Reload or restart the disposable service and retain conversation, plan, queued
   messages, decisions, native conversation identity and worker ownership. A
   disconnected browser cannot duplicate an agent or a publication.
10. Observe the PR after publication. Only a confirmed external merge completes
    the goal. Companion does not merge or deploy.

## Execution and launcher contract

CCS owns provider/account routing. The selected xclaude/xcodex launcher owns its
documented startup behavior. Companion records the selected profile and actual
resolved invocation, while keeping credentials out of browser data and logs.

Before implementation chooses a transport, inspect the user's actual launcher
definitions and distinguish simple aliases, shell functions and executable
wrappers. Do not infer their contents from their names or test fixtures. Record
sanitized compatibility evidence for both launchers, including CCS routing,
working directory, supported argument forwarding and native session continuity.

Use a fixed validated executable and argv for launches. A simple alias can resolve
to a validated invocation. A function or wrapper requires a reviewed explicit
adapter for its actual behavior; never evaluate browser-supplied shell text.
Configuration declares supported launch, input, resume, progress and termination
capabilities. Unsupported capabilities produce a precise readiness failure.

Profile/model selection must reach CCS and the intended native CLI. Do not
silently discard wrapper behavior, substitute a provider or fall back to a
different account path. Any managed permission/configuration differences must
be visible in setup, recorded in the launch snapshot and validated against the
approved role policy. A launcher that cannot preserve required boundaries must
be reported incompatible until its explicit adapter is supported.

Freeze the executable identity, validated arguments and relevant non-secret
configuration for an attempt. Editing aliases or profiles cannot retarget active
work. Revalidate changed executable identities before a new launch. Actual
account identity is reported only when supported evidence establishes it; quota
readings and a requested CCS profile are not proof of the selected account.

Agents remain visible in owned cmux workspaces. Use structured native output or
the existing scoped bridge for authoritative messages/results; terminal titles,
screen scraping and inferred prompt text are not completion authority. Keep
native conversation identity across turns through the selected launch adapter.
If a runtime cannot resume a saved session, surface recovery explicitly and
reconstruct from durable context only after confirming the former worker stopped.

## Supervisor and workflow responsibilities

The supervisor is a CCS-launched agent with a persistent logical conversation,
not a permanently busy process. It wakes on user input, actionable worker events
and required decisions. Waiting on workers or user input must not consume model
tokens through repeated idle prompts. Workers and the supervisor share capacity
accounting; a waiting supervisor must not starve its workers.

The supervisor can propose a plan, request service-validated task dispatch,
request approved checks, summarize evidence and ask focused questions. It cannot
approve its own plan or work, change workflow storage directly, grant itself
additional authority, bypass independent review or publish without user approval.
Raw tool output cannot become a new user instruction or permission grant.

Approve outcome, scope, acceptance criteria, check definitions and initial team.
The supervisor may refine execution within those bounds. New scope, changed
acceptance criteria, new executable checks or expanded permissions require a
new proposal. Persist task ownership and dependencies before each dispatch.
Parallel tasks use isolated worktrees and only start with checked dependency
output; integration remains serialized and verifies the combined result.

A single task must not require a ceremonial multi-wave plan. Preserve the
existing graph/wave safety machinery where useful, without requiring users or
agents to manufacture a full fleet before starting ordinary work.

Provide scoped service tools for agents to run approved checks in their owned
worktrees before submitting a candidate. Checks use recorded argv, working
directory, environment policy, time/output limits and durable receipts; they
cannot accept arbitrary command strings. Dependency preparation is included.
Return bounded actionable output to the agent and retain evidence for the user.
Worker checks do not replace independent final verification of the integrated
commit or independent review of the submitted commit.

Repair and retry budgets are persisted and visible. Routine failed checks can
return to the same implementer with their evidence. Definitively stopped failed
launches may retry within budget. Unknown ownership, uncertain external effects
and permission failures must reconcile or ask for a decision instead of blindly
retrying. Repeated unchanged failures exhaust the budget rather than looping.

## UI, API and persistence

The main goal surface is a readable conversation with inline proposal, question,
decision, worker summary and result cards. Show a concise current status and next
action. Technical attempts, generations, waves, receipts and full logs remain
available in secondary details. A permanent composer replaces scattered forms
as the normal channel for feedback throughout the goal lifecycle.

The server projects valid actions. Message creation uses stable command IDs,
ordered sequence numbers and delivery receipts. Reload and uncertain HTTP
responses reconcile the same command instead of submitting another message.
Distinguish queued, delivered, answered and failed messages; never claim a message
reached an agent merely because the browser request succeeded.

SQLite remains the authority for goal conversation, revision/approval references,
dispatch intents, worker identities and result evidence. Native history is
associated with the goal but does not replace service receipts. Restart rebuilds
projections and reconciles pending effects before admitting replacements.

Pause stops new admission and uses the adapter's supported interruption boundary;
it does not claim workers stopped until observed. Abort revokes authority and
tracks termination. Both retain conversation and evidence. Browser/API controls
retain pairing, same-origin validation, repository allow-lists and read-only mode.

## Non-goals

- Replacing CCS with direct provider SDKs or changing external accounts.
- Adopting Firstmate, LangGraph or another orchestration framework wholesale.
- Arbitrary shell/cmux RPC passthrough, unattended merge or deployment.
- A new monitoring, account-usage or updater redesign.
- Rewriting existing journals or taking ownership of existing running goals.
- Treating mocked agents as evidence that real xclaude/xcodex behavior works.

## Acceptance criteria

Each row names one required verification artifact; its cases may cover several
branches of the same requirement.

| ID | Required observable outcome | Verification |
| --- | --- | --- |
| A1 | A user can start, discuss, revise, approve, execute, review and publish a goal entirely from the browser. | Real-service Cypress journey with disposable Git and scripted external adapters. |
| A2 | Both actual xclaude and xcodex launch paths preserve CCS routing and required managed policy. | Sanitized launcher compatibility report with observed launch/argv/cwd/session/termination evidence for each path; paid native cases require explicit authorization. |
| A3 | Questions and answers preserve the logical/native conversation without terminating the supervisor to ask a question. | Adapter/service conversation-continuity regression with recorded conversation IDs and process operation counts. |
| A4 | Progress, queued steering and replies survive reconnect without duplicate delivery. | Real-service Cypress disconnect/reload and uncertain-message-receipt journey. |
| A5 | Proposal changes invalidate only the affected authorization and cannot secretly expand execution scope. | Domain authority matrix covering revisions, steering and supervisor tool requests. |
| A6 | Ordinary goals use one implementer; independent tasks can dispatch in parallel with checked dependencies. | Real-Git service dispatch test covering single-task, overlapping workers and dependent integration. |
| A7 | An implementer observes an approved failing check, repairs its code and reruns the check before candidate submission. | Real-Git worker-check integration test with retained failing and passing check receipts. |
| A8 | Routine recovery is bounded, while unknown workers and uncertain external effects never trigger duplicate work. | Fault-injection suite covering crash points, repair budgets and reconciliation. |
| A9 | Independent review, final verification and publication approval refer to the same exact commit. | Publication integration test refusing stale review, stale checks and stale approval. |
| A10 | Service restart restores the conversation and reconciles pending work before resuming. | Process-level restart test against one persistent disposable SQLite journal. |
| A11 | Pause and abort truthfully expose termination state and preserve evidence. | Process ownership/cancellation regression covering running, stopped and unknown workers. |
| A12 | Supervisor and workers stay within capacity; idle supervision does not issue repeated model turns. | Fake-clock scheduler test asserting model-turn and active-worker counts. |
| A13 | Pairing, same-origin, read-only, scope and credential boundaries remain enforced. | API/adapter security regression matrix for the new commands and projections. |
| A14 | The goal conversation works at desktop and phone widths with keyboard navigation. | Inspected Cypress screenshots and keyboard journey at 1440px and 390px. |
| A15 | Existing goals remain usable under their original contract and are not admitted by two owners. | Mixed-version storage and scheduler compatibility regression. |
| A16 | A developer can launch and stop the new experience without installed state or provider accounts. | Documented disposable startup smoke test with owned-resource cleanup evidence. |

## Success measure

Five representative goals complete the new journey without terminal intervention
or manual state repair: a small fix, a test-failing repair, a feature requiring
clarification/revision, independent parallel tasks and a dependent multi-step
change. Expected questions and the plan/publication approvals do not count as
repair interventions. Record outcomes, interventions and unavailable paths.
Scripted fixture results and real native results are reported separately; only
the latter establish the native usability target.

## Delivery and review boundaries

The implementation deliverable includes the complete opt-in experience, launch
adapters, durable service behavior, regression coverage, disposable test entry
point, user testing instructions and a draft PR targeting main. Run the required
full verification and relevant real-service Cypress suite; retain failures and
interventions in the delivery report. Do not reduce coverage to make it pass.

Human review of this committed spec precedes the implementation plan commit.
Live provider/cmux trials and GitHub publication retain their explicit task
authorization requirement. Preparing the candidate and disposable experience
does not install, update, merge or deploy it. Native acceptance still outstanding
must be stated explicitly rather than calling the full goal complete.
