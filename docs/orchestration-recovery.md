# Recovery and conservative cleanup

Run `node scripts/run-orchestration-faults.mjs` for the local process-crash matrix.
The machine-readable report is `coverage/orchestration-faults.json`; an explicit
output path may be supplied as the first argument. Cases use fixed disposable
fixtures (seed 0), unique process identities, real SQLite and real temporary Git.
No provider account, installed state or live GitHub endpoint is used.

| Boundary | Evidence |
| --- | --- |
| Before transaction commit, after commit before notification | Actual SIGKILL at six SQLite boundaries; rollback or one receipt/event/version |
| Durable intent, launch before identity, settled launch receipt | SIGKILL matrix for planner, reviewer, implementer and integrator; one launch and one slot |
| Result receipt and acceptance | All four roles SIGKILL intake matrix; one acceptance or durable repair preparation; separate candidate/repair suites verify real Git proof |
| Integration/ref update and review/repair | Real Git SIGKILL matrix at reservation, proposal, ref advance and conflict/repair evidence; one delta |
| Final head changes | Domain and integration suites reject stale review/check evidence and require renewed acceptance |
| Push/PR request and successful effect before response | Actual SIGKILL with persistent fake GitHub inventory and bare remote; one PR or explicit uncertainty |
| Abort/termination | SIGKILL before/after termination; no replacement, terminal lifecycle and zero slots only after stopped observation |
| Consumer delivery before cursor acknowledgement | SIGKILL with a persistent sink deduplicating the stable delivery key; no workflow replay |
| Cleanup intent/removal before receipt | SIGKILL and repeated restart; retained Git evidence, stable workflow version and one completed cleanup |

Uncertainty is an expected result when a request was marked sent but no correlated
external observation proves its outcome. Recovery never treats a timed-out call
as permission to launch again. The live adapter permission and process-tree limits
remain as documented in `orchestration-native-adapters.md`.

## Automatic review repair

Review repair policy, budgets, approval gates and the Settings toggle are defined
in the [automatic review repair contract](superpowers/specs/2026-09-15-mission-control-redesign.md#automatic-review-repair-and-optional-plan-review--2026-09-15).

When repair stops for clarification, answer the question shown in the goal. When
the revision budget is exhausted, choose **Request revision** and provide guidance
for the remaining findings. For other holds, inspect the displayed recovery reason
and worker evidence before choosing the offered recovery action. Activity retains
the review findings and revision events for diagnosis across restarts.

## Moved publication target

If the configured remote target differs from the goal's recorded local base,
publication pauses and the goal shows the observed remote commit. Scheduler ticks
stop polling that paused publication. Choose **Publish reviewed head against moved
target** to accept that exact observation and resume the same publication operation.
This keeps the integration commit, independent final review and verification
unchanged; it does not rebase or merge target-branch changes. The resulting PR may
still need conflict resolution or further work before a separately authorized merge.

The journal records each acceptance, and the adapter persists its append-only
target chain before sending. The original operation request and base SHA remain
immutable. If the remote moves again before publication, another explicit decision
is required. A missing target branch cannot be accepted; it remains under observation
so restoring it can recover publication. Abort revokes acceptance
and fences future sends; a sent PR request can only be reconciled, never retargeted
or duplicated. Rebasing or changing the integration commit still requires renewed
review and verification.

## Cleanup API

An authenticated `GET /api/orchestration/goals/:id/cleanup` returns a preview with
`expectedVersion`, per-attempt eligibility, pinned head and refusal reasons.
`POST` to the same path accepts `{ "expectedVersion": 12, "attemptId": "..." }`.
Use the actual preview version and attempt ID. The paired cookie and same-origin
checks apply; read-only mode permits preview and rejects execution.

Only delivered/aborted goals with every worker confirmed stopped and no pending
workflow effects are eligible. Cleanup checks the exact recorded repository,
manifest, ownership ref, branch, worktree registration and head. It refuses changed,
untracked or ignored files, hidden index flags, substituted paths, uncertain
ownership and changed versions. Git removal is never forced. A failed removal is
persisted and can be explicitly retried; the same attempt's receipt prevents
workflow replay. A crash between directory and registration removal reconciles
only that exact registered worktree.

Cleanup retains branches, refs, manifests, role artifacts, native receipts and all
SQLite workflow/event evidence. It does not prune a repository, delete native cmux
sessions, erase evidence or collect arbitrary files. Resources without verifiable
attempt ownership are refused. Any additional retention policy needs its own
explicit design and ownership checks.

## Journal retention

Production has no automatic journal pruning timer. The internal
`OrchestrationStore.pruneEvents(through)` operation removes only a consumed prefix,
bounded by the slowest durable consumer, active goals, owned workers and unsettled
operations. No operator deletion command is provided. Browser cursors do not hold
retention; expired cursors receive a fresh snapshot. Preserve the journal with its
referenced artifacts when backing up or transferring ownership.
