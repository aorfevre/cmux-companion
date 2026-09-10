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
   submission, repository issue picker and **Continue discovery** all use this
   path. The headless planner and topic planner have been retired.
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
5. Companion sends one approval prompt to the recorded conversation; the agent
   calls get_status and implements the approved revision there. Per-tool
   approval checks permit implementation, subject to native permission prompts.
   The owner becomes one launched task for existing health and PR tracking.
   A closed conversation, a missing workspace or an on-screen native prompt
   leaves the approval pending with its reason and a **Send approval again**
   action; a transport failure is uncertain and is never resent automatically.
6. Open the saved goal's **Open conversation** action to return to its recorded
   workspace. The conversation stays available during PR review and accepts
   corrections within approved scope. Merge remains a separate decision.

New coding goals enable **Add reviewer pass**, **Code review**, unit tests,
end-to-end tests, edge cases and refactor review. Screen wireframes and flowcharts
remain off. The form, direct creation APIs and issue quick-start share creation
defaults; explicit opt-outs and historical saved choices are preserved. Resetting
the form restores new-goal defaults. Bulk issue planning and historical multi-task
delivery retain their existing flow.

### Independent review and planner assessment

Planner review is queued for each published proposal revision, using the saved
spec-reviewer model for the opposite provider. When it completes, Companion
queues one planner assessment atomically and runs it in the background: a
read-only fork of the planner's saved conversation, with the goal's configured
model, reads the full critique and accepts, adapts or rejects every finding
with a reason. The assessment publishes the final revision linked to the
reviewed revision and review attempt; that publication does not enqueue another
review. Approval becomes available only for that exact assessed revision.
A failed review or assessment is not a pass: it stays visible with its error and
an explicit retry; an uncertain dispatch needs reconciliation first. Neither the
reviewer nor the assessing planner can approve for the user, modify code, or
start another goal. User change requests begin a fresh proposal, review and
assessment cycle.

Code review starts after the existing observer sees the goal's matching open PR.
It reviews a Git archive pinned to the PR head and its base-to-head diff, saves
findings in Companion, then posts an advisory GitHub comment using the backend's
`gh` identity. It does not submit an approval verdict or automatically fix findings.
A changed head marks old completed findings stale; **Review current PR commit**
requests another review explicitly. Both passes add provider usage and latency;
users can disable them before creation. The form explains the GitHub posting.

Reviews have durable attempts and process ownership. Runs are capped at 15 minutes,
with a three-minute idle limit, bounded output, and SIGTERM/SIGKILL termination.
Failed runs expose explicit retry. Uncertain posting exposes reconciliation of the
saved exact comment, not an automatic second execution. Concurrent posting claims
are serialized in SQLite. Unknown dispatch ownership fails closed; when a crashed
owner has no recorded posting PID, an existing exact comment can resolve delivery,
but absence alone does not authorize another post. Missing locally pinned Git
objects or an oversized diff fail visibly rather than silently reviewing less code.

### Analysis outcomes

Choose **Analysis** for repository-grounded investigation rather than code delivery.
Planner review and edge cases still apply; tests, refactor work and post-PR code
review are shown as not applicable. Switching back to Coding retains form choices.
Historical goals and issue quick-start remain coding unless explicitly created as
analysis; an existing goal is not converted in place.

Approve the exact analysis scope and tell the analyst to continue. Its CLI remains
read-only even after approval: no Bash, Edit or Write. The bound `publish_analysis`
MCP tool accepts a title and Markdown with populated Evidence, Assumptions,
Limitations and Recommendations sections. The server appends the two next steps,
validates identity/revision/expected version and the 96 KiB total size, and saves an
immutable report atomically. A valid saved report produces **Analysis ready** without
a coding task, commit, push or PR. Publishing a broader proposal requires fresh
approval while earlier reports remain available.

Companion displays version history and safe Markdown, with attachment-style
**Download Markdown**. Raw HTML and remote images are not executed or fetched.
Reports stay in Companion's SQLite database, not in repository files.

- **Challenge the analysis** queues a separate read-only critique of the selected
  saved report and repository evidence. Findings are version-bound; the original
  is never rewritten. Failures can be retried, including for older report versions.
  Ask the original analyst for any desired revision; there is no automatic rewrite.
- **Launch coding goal** creates or opens one linked coding discovery per selected
  report version. Its context comes from the stored report, not client-supplied
  text, and is labeled untrusted. It uses new coding defaults and needs its own
  proposal approval. Duplicate clicks and startup failures retain one saved child;
  failures require recovery rather than creating another worktree.

Analysis conversations and worktrees are retained for revisions. Reports and
critiques remain readable; PR observers do not infer analysis completion or retire
its workspace. This is not web research, a general document manager, or an
alternative delivery path for legacy multi-task plans.

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

`server/goal-session-bridge.mjs` exposes `get_status` and `publish_proposal`
over local stdio MCP, plus `publish_analysis` only for bound analysis goals. Proposal validation reuses delivery-contract checks,
including requested spec options. Publishing compares the revision, provider
identity and pending feedback atomically; it cannot approve a proposal. Validation
errors go back to the agent for correction without setting a blocked state.

Explicit CLI settings install a PreToolUse hook bound to the goal, generation and
provider session. Discovery permits reading, questions and the two goal tools;
Bash, Edit and Write require a current durable approval. Unknown tools fail closed.
The hook leaves native permission decisions intact and never grants write access
itself. A UserPromptSubmit hook carries phone feedback and approval context into
the conversation and invalidates an unapproved proposal when discussion resumes.
Custom settings and MCP sources are isolated; the user-turn hook supplies the `/goal`
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


## Native live validation (2026-09-08)

Used new worktrees of the disposable `../cmux-e2e-cypress` repository, temporary
SQLite databases, and the PR checkout's fixed cmux entry point. The installed
Companion backend and goal database were not started or changed. Runtime:
CCS 8.9.0, Claude Code 2.1.263, Codex Astra through the Claude-compatible target.

The first live launch exposed a real CCS compatibility defect: its argument
filter removes standalone `--settings` but leaves the JSON value as positional
prompt text. CCS also appends its own system steering prompt. The fix passes
`--settings=<json>` as one argument and supplies discovery context through the
mandatory UserPromptSubmit hook, so the workflow survives CCS prompt injection.
Regression assertions cover both argument forms and hook-delivered goal context.

After the fix, the live native session read the fixture and asked directly for
the desired label. An explicit pre-approval Edit attempt was denied by the
Companion hook and left the checkout unchanged. The agent published revision 1
through MCP; direct feedback withdrew it and resulted in revision 2. Approval
was recorded through the same store decision used by the service, in the isolated
test database. The agent observed it in the same conversation, presented native
per-edit and shell permission prompts, changed exactly two lines in the approved
files, and ran `npm test` successfully (2 passed). No commit, push, fixture PR,
merge, deployment or remote delivery operation was requested or performed.

Exiting the native process preserved its conversation ID, approved proposal and
non-blocked state. Resume used the existing workspace and provider identity.
The live test uses service/store boundaries for approval and resume; the phone
approval UI remains covered by mocked Cypress, not an installed-backend live run.
The test does not establish every other CCS/provider version's compatibility.

Fresh-launch regression also passed with the corrected arguments: the real initial
goal appeared as the prompt, the agent read the fixture and asked for the label
without publishing or editing. The resumed approved conversation recalled the
chosen label, revision 2 and its prior 2/2 test result without tool use. Both
native test processes were stopped with targeted SIGTERM, after checking their
parentage against the recorded owner; process exit left errors null and board
states Discovering / Building rather than Stopped. Native Escape/keyboard
shutdown was not established by this run: earlier keyboard shutdown attempts did
not exit the CLI, so no claim of verified keyboard cancellation is made.

Cleanup closed only the two recorded test workspaces and removed their uniquely
named fixture worktrees, local branches and temporary databases. The original
fixture checkout remained clean. Provider conversation history was preserved in
its native session storage; no credentials or account settings were edited.
