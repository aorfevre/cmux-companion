# A visible session for each goal

The native discovery flow replaces the original line-oriented goal runner.

## Outcome

A new goal opens a visible conversation in its own worktree. The user can answer
questions, steer the investigation and approve a concrete increment before the
agent receives writable tools. One owner keeps the same provider conversation,
checkout and cmux workspace through implementation and PR review.

The intended benefit is earlier correction of misunderstandings and a shorter
path to a useful preview. More plans, tasks or PRs are not success measures.
Neither product quality nor iteration-speed improvements have been measured yet.

## User journey

1. Choose a repository, provider and goal, then **Start goal session**, or use
   **Start a goal** on an individual card in the **GitHub Issues** board column.
   Issue cards use the saved planner model defaults, keep the issue number and
   URL on the goal, and open the recorded conversation. The form's
   default submission uses this path; **Plan this goal** remains the explicit
   legacy planner workflow.
2. Companion saves the goal, acquires an isolated checkout from the fetched
   default remote branch and records its identity before starting cmux.
3. A native interactive Claude-compatible CLI owns the cmux terminal. The user
   discusses the problem, answers questions and interrupts directly. The agent
   publishes a structured proposal through a dedicated local MCP tool when the
   discovery is ready; schema and contract validation determine review readiness.
4. Review intended behavior, scope, exclusions, assumptions, acceptance criteria
   and verification. **Request changes** saves feedback for the next native turn;
   **Approve and implement** applies to the displayed revision and generation.
   A direct discovery message before approval withdraws the old proposal.
5. After approving, tell the agent to continue in the same conversation. Per-tool
   approval checks now permit implementation, subject to native permission prompts.
   The owner becomes one launched task for existing health and PR tracking.
6. Open the saved goal's **Open conversation** action to return to its recorded
   workspace. The conversation stays available during PR review and accepts
   corrections within approved scope. Merge remains a separate decision.

Automated planner and post-delivery code reviewers remain on the legacy path.
Visible-session creation refuses these options before allocating resources rather
than silently ignoring a selected reviewer. Bulk issue planning and existing
multi-task delivery also retain their existing flow.

Existing issue goals keep their saved workflow; starting the same issue again
returns its existing goal rather than creating a second session. A failed start
retains its saved goal and any recorded worktree for inspection and recovery.
The issue title and body remain explicitly untrusted context. Planning opens
read-only, and implementation still requires approval of the displayed proposal.
After approval, the owner references linked issues in its PR and only uses
closing keywords when the approved scope fully resolves an issue.

## Implementation and boundaries

`server/goal-session-runner.mjs` is a fixed entry point for
`server/goal-session-interactive.mjs`. CCS still uses `--target claude` for either
selected provider, but without `--print`, stream-json parsing, per-turn process
restarts or terminal input interception. The native CLI inherits stdin/stdout/stderr
and resumes the recorded session ID. This is the Claude-compatible native UI;
it does not launch the native Codex CLI.

`server/goal-session-bridge.mjs` exposes only `get_status` and `publish_proposal`
over local stdio MCP. Proposal validation reuses delivery-contract checks,
including requested spec options. Publishing compares the revision, provider
identity and pending feedback atomically; it cannot approve a proposal. Validation
errors go back to the agent for correction without setting a blocked state.

Explicit CLI settings install a PreToolUse hook bound to the goal, generation and
provider session. Discovery permits reading, questions and the two goal tools;
Bash, Edit and Write require a current durable approval. Unknown tools fail closed.
The hook leaves native permission decisions intact and never grants write access
itself. A UserPromptSubmit hook carries phone feedback and approval context into
the conversation and invalidates an unapproved proposal when discussion resumes.
Custom settings and MCP sources are isolated; the prompt supplies the `/goal`
workflow without depending on an installed slash command.

The supervisor transfers its durable process ownership to the spawned CCS
process, so a supervisor exit cannot by itself authorize a duplicate launch.
Native exit releases ownership and preserves discovery/proposals. Spawn failures
are visible in the terminal and leave the goal resumable; they do not fabricate a
provider completion failure. The first approved mutation records that the native
session received authorization, not successful implementation or PR delivery.

The existing SQLite plan store owns the workflow discriminator, worktree and
base, workspace, provider ID, generation, proposal and question revisions,
approval, input queue and runner/dispatch ownership. Stale approvals and question
replies cannot authorize a later revision. The inbox routes managed answers to
the stored goal; it never forwards them as native tool-permission replies.

The existing GitHub observer associates a PR with the owner's recorded branch.
Provider prose and a successful process exit do not prove delivery or mark a goal
ready for review. Reapers retain the owning session while review is open and
protect restored workspaces associated with an active managed goal. Legacy launch,
relaunch and follow-up paths must not create a second managed-goal writer.

Pairing, same-origin checks, repository allow-lists, argv boundaries and the
phone's read-only input protection remain in place. No merge, deployment or
live-agent integration is part of this implementation task.

## Recovery and practical limits

Creation retries carry a stable request key and must match the original normalized
goal context. The saved checkout is recorded before subsequent external calls.
Partial failures retain their identity and error rather than masquerading as
successful planning. The start-error UI currently shows the error text; inspect
the saved failed goal on the board rather than opening it directly from that
error.

**Resume conversation** is available when the recorded process and dispatch
are absent. It reuses the same workspace and provider identity; a live owner or
ambiguous dispatch refuses a second launch. Native exit does not erase decisions,
block the goal, delete the checkout, or automatically restart implementation.
Old uncertain writable transitions remain uncertain and require reconciliation;
this change does not reinterpret existing saved failures. Existing legacy question
and recovery API behavior remains available for older records.

Phone proposal feedback is durable and delivered on the next user turn or status
tool call. It does not auto-type into a running native prompt. After approval,
the user tells the agent to continue. Discovery questions are native conversation
interactions, not synthetic Companion inbox records. Native CLI permission and
question prompts can also be handled through the existing terminal view.

The checked-in CLI configuration and fake-process tests establish the requested
permission surface and lifecycle behavior. They cannot establish that a live CCS
installation enforces every flag, that cmux focus/replay behaves correctly on the
user's Mac, or that a real provider completes the work and creates the right PR.
Those paths require the README live-test opt-in and explicit authorization.

## Validation

Use Node 22.23.1 from `.nvmrc` and the checked-in npm lockfile.

Focused checks cover read-only planning, provider identity, durable input failures,
question revisions, stale decisions, runner recovery, workspace-owned UI reads,
phone read-only protection and terminal-goal guards. Real SQLite plus fake GitHub
observations verifies approval → one owner task → open PR with retained session
→ merged PR with eligible cleanup.

Local Cypress covers creation into the exact workspace, questions, scope changes,
revision-bound approval, inbox answering without approval, stale approval errors
and recovery without creating another goal. Existing browser coverage is retained.

Current change evidence and interventions are recorded in the PR completion
report. Live CCS/cmux/GitHub behavior, installation, merge and deployment require
separate authorization and are not established by mocked browser tests.
