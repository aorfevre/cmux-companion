# A visible session for each goal

Status: implementation authorized; validation in progress.
Branch: `feature/goal-session-planning`, in its own isolated worktree.
Main through `a28167c` has been integrated.

## Outcome

Starting a goal opens a visible cmux agent session in an isolated worktree.
The user and agent refine the idea in that conversation, approve a small
implementation increment, experience the result, and iterate in the same
conversation. Companion retains the goal, decisions, worktree and delivery
evidence when the terminal or bridge restarts.

Success means quicker correction of misunderstandings and a shorter path to a
useful preview. More plans, tasks or PRs are not success measures.

## First user journey

1. Choose a repository, agent and goal; select **Start goal session**.
2. Companion saves the goal, creates one isolated worktree and opens one visible
   cmux workspace. The goal opens its session view, with the conversation as the
   primary content and a compact goal summary alongside it.
3. The agent investigates in planning mode. The user can send steering messages
   throughout investigation; delivery, queued input and interruption must be
   distinguished honestly using the existing terminal controls. Questions appear
   in the conversation and the existing attention inbox.
4. The agent proposes one small increment: intended behavior, scope exclusions,
   consequential assumptions, and how the user will try and verify it. A proposal
   card offers **Approve and implement** and **Request changes**, with free text.
5. Requesting changes continues the conversation and produces a revised proposal.
   Asking a question can lead to a follow-up question or revision; there is no
   separate explanation-only discussion mode for this workflow.
6. Approval authorizes the displayed revision. Implementation continues in the
   same worktree and, where supported, the same provider conversation and cmux
   workspace. The agent does not launch another task agent by default.
7. The agent supplies a preview or concrete manual check, changes and verification
   results, and a reviewable PR through the existing single-task delivery flow.
   The user can request corrections in this session. Material scope expansion
   requires another proposal; ordinary corrections within scope do not.
8. Merge stays a separate user decision. Closing the session does not delete the
   goal, its worktree, its approvals or its review evidence.

The same provider conversation handles planning, implementation and review.
The visible terminal runs a managed line-oriented CCS runner, not a native
Codex or Claude TUI. Both provider selections use CCS with `--target claude`;
provider processes restart between turns and resume the saved conversation ID.
A failed continuity check stops the transition instead of substituting another
executor. Installed CLI help was inspected; live provider behavior remains
unverified.

## Boundaries for the first version

- One goal, one owning agent, one worktree; preserve Claude and Codex selection.
- Reuse the terminal view, input, question inbox, private preview links and PR UI.
- Keep old saved plans and already launched workflows working as they are. Give
  new session-based goals an explicit workflow discriminator; do not reinterpret
  historical records or automatically launch them.
- Leave bulk issue planning and existing parallel delivery on their current path
  until this single-goal experience proves useful.
- No new multi-agent orchestration, automatic reviewer, transcript platform,
  model migration, automatic merging or deployment.
- Creating the goal may allocate a worktree and agent runtime metadata. It does
  not authorize implementation edits, dependency installation or execution of
  arbitrary repository scripts during planning.

## Approval and conversation contract

Approval must be tied to an immutable proposal revision, not terminal text or an
agent saying that the user approved. Persist the proposal and its revision before
showing the approval control. Record the user's decision, time and exact revision
through an authenticated, same-origin-checked Companion action. Keep repository
allow-lists and existing read-only phone protections.

Reject a stale approval after revision, an approval for another goal, and an
approval from a retired session generation. Duplicate submissions must not start
implementation twice. Separate durable approval from delivery to the agent: a
bridge crash between these operations must leave a recoverable pending transition,
not another implementation launch. Reconcile the agent's state before resending
an uncertain transition.

The current `contractVersion` is a schema discriminator (1/2), not a proposal
revision counter. Add a separate monotonic revision identity. The current
`sessionId` is a headless planner conversation id; store cmux workspace/surface
ids and provider conversation identity separately.

Do not equate product-scope approval with blanket tool-permission approval. The
existing `exitPlan` reply accepts modes including permission bypass; the new goal
action must deliberately map to the provider's appropriate transition without
quietly granting bypass permissions.

Planning restrictions must be enforced by supported provider controls, not only
by a prompt asking the agent to wait. The current interactive launcher invokes
`xcodex`/`xclaude`; it does not establish that either starts in enforced planning
mode or that both expose the same approval event. This is the first technical
uncertainty to resolve. A server-side approval record alone cannot prevent a
write-capable terminal agent from editing.

## Lifecycle and recovery

Use explicit workflow state: starting, planning, awaiting approval, implementing,
ready for review, merged or aborted. Track waiting for a user answer, unavailable
session and errors as attention/health information rather than treating agent
silence as completion. Map these states into the existing board without deriving
them from free-form terminal output.

Persist goal identity, branch/base SHA, worktree path, workspace/surface identity,
provider conversation identity when available, session generation, proposal
revisions, approval and transition status. Use the existing SQLite store and event
history rather than a second source of truth. Define structured, validated agent
events for proposal publication and state changes; the exact transport is chosen
after provider capability inspection. Agents may publish proposals, never approve
their own proposals. Do not parse terminal prose to grant authorization.

Creation and retry must reuse the recorded goal resources or show a recoverable
partial-start failure. A missing workspace offers explicit reconnect/resume;
there is no automatic replacement agent or discarded worktree. Restore provider
context where supported, otherwise explain the loss and reconstruct from saved
decisions with user awareness. Do not claim full transcript durability from the
current terminal buffer. Reapers and cleanup must protect active planning and
review sessions, including goals without a launched task yet.

## Implementation sequence

1. **Prove the session transition.** Inspect existing launcher configuration,
   provider controls and cmux events without changing user aliases. Define and
   test a narrow provider adapter for planning launch, proposal publication,
   approval transition and resume. Check both selected engines. Record precisely
   which guarantees are supported; resolve missing enforcement or continuity
   before presenting this as an approval-gated workflow. A real agent experiment
   needs the README live-test opt-in and explicit authorization.
2. **Deliver one vertical slice.** Extend the existing goal store/API with the
   session workflow, revision-bound decisions and recoverable creation; connect
   it to worktree acquisition, cmux launch and the existing conversation/inbox UI.
   Demonstrate goal → question → revision → approval → same-session edit before
   adding broader delivery behavior.
3. **Connect review and recovery.** Adapt single-task completion/PR association,
   goal health, restored sessions, cleanup and board navigation. Preserve the
   owning session for review and same-scope corrections. Validate restart and
   stale-event behavior before enabling the new path by default.

One implementation owner follows this entire path. These are sequential slices,
not instructions to create independent parallel worktrees.

## Existing integration points

| Area | Existing code | Planned responsibility |
| --- | --- | --- |
| Goal entry and view | `app/worktree-planner.tsx`, `app/worktree-dashboard.tsx` | Start/open session; compact proposal and approval controls |
| Conversation and decisions | `app/page.tsx`, `server/prompt-queue.mjs` | Reuse terminal input, queued messages and inbox; retain goal context |
| API and security | `server/app.mjs`, `server/security.mjs` | Authenticated lifecycle/decision endpoints; target and revision validation |
| Persistence | `server/worktree-plan-store.mjs` | Additive workflow/session/proposal records and durable transition history |
| Planning | `server/worktree-planner.mjs`, `server/agent-brief.mjs` | Separate legacy headless planning from interactive goal coordination |
| Worktree and session | `server/worktree-dashboard.mjs`, `server/worktree-operations.mjs`, `server/cmux-client.mjs` | Reuse acquisition and locks; explicit planning launch/transition adapter |
| Delivery and health | `server/goal-integrator.mjs`, `server/goal-watchdog.mjs`, `server/goal-board.mjs` | Single owner delivery, review state and observable recovery |
| Session retention | `server/restored-goal-sessions.mjs`, `server/goal-session-collector.mjs`, `server/goal-session-reaper.mjs`, `server/worktree-cleanup.mjs` | Associate and protect goal sessions before and after implementation |

The original checkout and its uncommitted user changes were not modified.
The implementation started from main at `6d699cb` and subsequently integrated
main through `a28167c`, preserving the concise legacy approval flow and board
worktree button. All feature edits and checks use the separate worktree.

## Acceptance and validation

- Starting/retrying one goal creates at most one owned worktree and session;
  partial failures remain visible and recoverable.
- Before approval, the user can ask, steer and answer without rejecting a plan
  through a separate form. Questions target the correct goal/session.
- An edit attempted during planning is blocked by the supported provider control;
  simply checking whether the launch endpoint was called does not prove this.
- Request changes revises the proposal without implementation. Stale, duplicate,
  wrong-goal and retired-session approvals cannot authorize unintended work.
- Approval continues the same conversation/worktree; failed delivery or restart
  preserves the decision and never duplicates execution.
- The user can open the goal from its board card or notification, try the result,
  and request an in-scope correction without starting another goal.
- Old plans still load, launch and recover normally. Active planning sessions
  cannot be collected as completed or orphaned sessions.

Use Node from `.nvmrc` and `npm ci` when implementation begins. Add meaningful
backend tests for store migrations, lifecycle/revision races, provider boundaries,
restart/retry and cleanup; UI tests for navigation and actionable proposal states.
Add local Cypress scenarios for the complete journey, request changes, questions,
stale approvals, duplicate clicks and disconnected-session recovery. Run
`npm run verify` and `npm run test:e2e:local`.

Cypress's stubbed APIs cannot prove native cmux focus, provider permission
enforcement, real conversation continuity or GitHub delivery. Report these
separately, and validate live only under the README opt-in. Measure time to first
useful preview, effort to correct a misunderstanding and acceptance after hands-on
review on a few comparable real goals before widening rollout.

## Implementation validation

Final full verification and local Cypress results will be recorded here before
PR publication. Focused regression tests cover conversation identity, enforced
read-only argv, rejected provider envelopes, durable feedback failures,
workspace-owned approval reads and phone read-only protection.

An interim full verification run exposed a legacy in-memory planner regression
introduced by the managed-workflow guard. It must be fixed with all original
coverage retained. No live cmux/provider/GitHub delivery check, installation,
merge or deployment has been performed.
