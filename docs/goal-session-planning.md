# A visible session for each goal

Implementation branch: `feature/goal-session-planning`, in the dedicated
`cmux-companion-feature-goal-session-planning` worktree. Main through `a28167c`
has been integrated. The original checkout and its user changes were not modified.

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
3. The visible runner investigates with read-only tools. Questions are durable,
   appear beside the conversation and enter the action inbox. An attention
   button exposes pending inbox actions from Home.
4. Review intended behavior, scope, exclusions, assumptions, acceptance criteria
   and verification. **Request changes** continues planning; **Approve and
   implement** applies to the displayed proposal revision and session generation.
5. The same provider conversation resumes with implementation tools. Its owner
   becomes exactly one launched task for existing health and PR tracking.
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

`server/goal-session-runner.mjs` is a managed, line-oriented terminal program.
Both provider selections use CCS with `--target claude`, explicit tool controls
and a saved provider conversation ID. Provider processes restart between turns;
this is not native Codex/Claude TUI continuity or a durable transcript platform.

Planning supplies only Read, Grep and Glob, disables other tool sources and
cannot obtain writable tools through a textual approval. The authenticated,
same-origin-checked proposal endpoint records approval before the runner claims
one writable transition. Writable turns use a bounded tool configuration without
a permission-bypass mode. Process duration, idle time and retained output are
bounded. Error envelopes, denied permissions and changed conversation IDs are
rejected even when the provider process exits successfully.

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

**Recover failed turn** can queue a failed planning input on the live owner.
Restart requires proven ownership and no live recorded runner. A durable dispatch
claim prevents concurrent restart requests from injecting another command. A
failed writable transition or correction remains uncertain and is not replayed.
Missing workspace identity or an ambiguous dispatch can require manual
reconciliation; the recovery endpoint does not guess a replacement workspace.
Terminal closure does not erase saved decisions or delete the checkout. Terminal
input is line-oriented: use one line per terminal turn, or the saved goal
sheet’s answer/request-change text area for multiline feedback.

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

Validation: 994 backend tests, 110 UI tests and lint passed; the full local
Cypress suite passed all 77 tests. Typecheck passed during focused validation;
final build confirmation is recorded in the PR. During integration, the full suite exposed an in-memory legacy planner regression and
older UI fixtures missing the new workspace-goal lookup. These were fixed while
retaining their original assertions. Live CCS/cmux/GitHub behavior, installation,
merge and deployment remain unverified and were not performed.
