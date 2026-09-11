# Multi-agent orchestration core redesign

Updated: 2026-09-11
Status: Revised design for human review; implementation plan follows that review.
Context: Review of commit 10be65e and the user's decision to support multiple
implementers from day one. The earlier spec's ecosystem survey is not present
in this checkout; this contract does not depend on its claims.

## Outcome

Reshape Companion around a production orchestration core that coordinates
multiple implementation agents from its first supported release. One approved
goal becomes a dependency graph of bounded tasks, isolated worktrees, independent
reviews, a serialized integration branch and one verified pull request.

The core must be understandable and testable by future open-source contributors
without personal accounts or a running Mac integration. Existing APIs, database
schemas, features and behavior are not compatibility requirements. Reuse existing
code where it satisfies this contract; remove redundant orchestration paths.

The user explicitly selected multiple implementers from day one. Other product
choices below are proposed defaults for the human review of this design.

## Problem and architectural decision

The current implementation mixes workflow decisions, direct SQL writes, process
ownership, terminal operations and board presentation across services. Splitting
WorktreePlanStore into stage files would leave competing lifecycle writers in
GoalOutcomeStore, PlannerAssessments and agent bridge processes. Existing burst
and ordinary review paths also attach different meanings to review output.

The replacement has one deterministic orchestration service. Agents investigate,
plan, implement, review and resolve integration conflicts; they do not own the
workflow database or grant themselves authority. The service validates commands,
checks approval and ownership, records state, and schedules external operations.
An agent's recommendation or successful exit is not proof of delivery.

## User journey

1. The user selects an allowed repository and describes a goal. A planning agent
   investigates in an interactive conversation and publishes a versioned contract.
2. The contract identifies outcome, scope, exclusions, acceptance criteria,
   verification, task dependencies, owned areas and integration responsibility.
   Independent plan review supplies findings; the planner publishes revisions.
3. The user approves one immutable contract revision. The UI shows the approved
   graph, agent assignments, concurrency limit and outstanding review findings.
4. The service starts independent ready tasks concurrently in separate worktrees.
   Each implementer receives the approved scope and an exact recorded base commit.
   A dependent task starts only after its dependencies have been integrated.
5. Implementers submit candidate commits and evidence. Independent reviewers
   assess those exact commits. Blocking findings return work to its owner;
   missing or invalid review output never counts as acceptance.
6. One integration worker incorporates accepted results serially on the goal
   branch. Conflicts are resolved there, followed by verification and independent
   review of the combined result. Agents never merge the PR into the target branch.
7. Companion creates or updates one PR only for the verified integration commit.
   The user sees the evidence, review findings and any remaining gaps. GitHub
   observation reports a later merge; merge and deployment remain separate choices.
8. A stopped, failed or uncertain operation is visible with a reason and an
   explicit recovery action. Abort prevents new work and reconciles owned workers;
   it does not delete branches, worktrees or unrelated sessions.

## Scope and non-goals

The first replacement includes planning, plan approval, multiple implementers,
independent plan/task/integration review, dependency scheduling, integration,
verification, PR publication, cancellation and restart recovery. The mobile goal
view exposes these states and commands. Pairing, same-origin enforcement,
repository allow-lists, loopback binding and argv-based execution remain required.

The first replacement does not promise legacy workflow execution or automatic
migration of active goals. Burst scanning, quota balancing, analysis-only goals,
issue-topic planning and alternative legacy delivery pipelines are outside this
core contract. They may return as separate clients of its commands; they must not
be silently wired into the replacement scheduler. General terminal monitoring can
remain a separate application feature.

No general plugin framework, distributed scheduler, full event sourcing, hosted
cloud service, native-shell rewrite, automatic target-branch merge or deployment
is included. Open-source readiness does not require an immediate public release
or removing the Mac requirements from the production cmux adapter.

## Core boundaries

| Boundary | Owns | Must not own |
| --- | --- | --- |
| Domain | Valid states, command validation, dependency and approval rules | SQL, HTTP, agent CLI or cmux calls |
| Application service | Transaction orchestration, scheduling policy, reconciliation | Provider-specific prompts or CLI flags |
| Persistence | SQLite state, immutable contracts, attempts, evidence and event journal | Launching processes or deciding workflow policy |
| Agent adapters | Role prompts, capabilities, terminal/background execution and typed results | Approving work or writing workflow tables |
| Repository/PR adapters | Worktrees, Git evidence, verification and GitHub operations | Inferring approval from agent prose |
| API and agent bridge | Authenticated, validated commands and read queries | Direct workflow SQL or arbitrary command passthrough |
| Read model and UI | Public state, graph, evidence, decisions and recovery actions | Independent lifecycle decisions |

One application composition root wires these boundaries. The core imports adapter
interfaces, not production implementations. Browser-shared state derivation stays
pure and does not import SQLite or Node APIs. Provider support is capability-based;
an unsupported execution mode fails explicitly before launch. CCS is an adapter
choice, not a domain dependency; account usage is not an agent execution role.

## Durable model and command authority

SQLite records goals, immutable contract revisions, tasks/dependencies, attempts,
review targets/findings, integration results and external-operation intents.
Every operation is bound to a goal generation, approved revision, role, task or
integration target, attempt id and unique operation id as applicable.

Only the service writes orchestration state. Interactive bridge processes submit
scoped commands through an authenticated local interface and cannot open the
workflow database. Their authority binds to a recorded attempt and role. Tokens
are revocable on replacement or abort and are excluded from logs and events.
Only user-authorized API commands can approve or expand scope. The actual CLI
permission/hook capability must be tested by the production adapter: scoped API
tokens alone do not sandbox an agent's filesystem or shell access.

Mutations compare the expected version and ownership. Stale completions remain
historical evidence and cannot advance a newer attempt. Repeating a command with
the same operation id returns its recorded result; reusing that id with different
input is rejected. State updates, event insertion and any new operation intent
commit in one transaction. Domain changes do not perform external I/O inside it.

SQLite rows are authoritative. The append-only event journal supports audit and
notifications; it is not claimed to reconstruct arbitrary legacy state. Events
have a monotonic cursor, schema version, correlation ids and bounded payloads;
large artifacts are referenced by immutable id rather than truncated into JSON.

Subscribers consume committed events with durable cursors where side effects
require them. Delivery is at least once. An in-process wakeup is only a latency
optimization; startup and periodic reconciliation recover missed wakeups. UI
clients can refresh a snapshot and resume from its cursor. Expired cursors require
an explicit resync. Event retention must not remove pending consumer work or the
evidence of an active goal. Non-goal cache invalidation remains separately owned.

## Scheduling and multi-agent integration

A contract is rejected if task ids are duplicated, dependencies are missing or
cyclic, criteria lack owners, or overlapping declared write areas have neither a
dependency ordering nor an explicit integration policy. Declared areas guide
scheduling and review; they are not presented as a filesystem security boundary.

The scheduler has configurable positive global and per-goal concurrency limits,
stable oldest-ready ordering across goals, and capacity accounting for reviewers
and integration agents as well as implementers. Interactive planning sessions use
an explicit separate capacity limit. Each ready task has one active attempt.
Concurrent dispatch requests must not exceed capacity or allocate that task twice.
There is no recursive agent-created scheduling outside the approved graph.

Each attempt records its worktree, branch and base SHA before implementation.
Dependencies are satisfied by accepted integration commits, not agent exits or
unintegrated task branches. Ready siblings can run from the same integration
checkpoint. Failed dependencies block descendants while unrelated approved work
may continue. Scope or dependency changes require a new contract revision and
fresh approval; they never mutate the approved graph in place.

One integration operation per goal owns the branch at a time. It records expected
integration head, accepted task commit and resulting head. The adapter incorporates
only the task delta against its recorded base; advancing the branch is conditional
on the expected head. A crash after Git changed but before recording success is
reconciled against the operation's saved evidence before another integration runs.
Conflict resolution is a bounded integration-agent attempt and may not silently
expand scope. Failure blocks integration with evidence preserved.

Once all required tasks are integrated, run the contract's verification against
the exact resulting commit and independently review that combined diff. Blocking
findings create a bounded repair attempt with its own review, then repeat affected
verification. Any change to the integration head invalidates earlier final review
and verification. A moving target-branch head is shown explicitly; rebasing or
updating the integration result requires renewed review and verification.

## Agent roles, review and execution

Planner, implementer, reviewer and integrator are explicit roles with bounded
inputs, tool capabilities, output schemas and termination conditions. Independent
review means a separate attempt/conversation from the author, without write access
to the reviewed checkout; a different provider is optional. Review context pins
its contract revision or commit and treats repository content as untrusted input.

Reviews return a versioned structured result with target identity, disposition
(accept or request_changes), findings and readable evidence. Findings have stable
ids, severity, blocking status, references and suggested action. Malformed or
missing output is an unsuccessful review. A changed target invalidates acceptance.
Task and integration blocking findings prevent advancement; unresolved blocking
plan findings prevent approval. The proposed default allows two repair attempts
per review target lineage, then requests a human decision. Retries do not reset
that budget merely by producing another commit. Humans may authorize another
bounded attempt or revise/abort the goal; there is no implicit pass fallback.

Interactive planning inherits terminal I/O, supports native permission prompts
and preserves conversation identity. Waiting for user input is not an idle-job
failure. Background implementation/review/integration modes declare their own
ceiling, idle, output, process-group, abort and cleanup policies. They may be
visible in cmux without sharing the interactive planner's lifecycle. Adapters
preserve structured error causes as well as readable messages.

Launch intent is persisted before dispatch; ownership includes the operation id
and adapter-verifiable process/session identity, not a PID alone. A crash in the
intent-to-identity gap is uncertain, not automatically retryable. CLI hooks and
structured result channels feed scoped commands; terminal prose and Stop events
are wakeups, not completion evidence. Repository evidence is verified separately.

## Recovery, publication and cleanup

The service holds exclusive scheduler ownership for its database; a second server
must fail to acquire it before dispatching work. Each startup reconciles pending
operations with adapter evidence. Event and timer wakeups share a coalescing loop;
a wakeup during a sweep schedules a subsequent pass rather than disappearing.
Expired leases alone never establish that an external worker has stopped.

Abort revokes command authority and fences future publication, requests termination
of owned workers, and records uncertain termination until observed. A late external
result cannot reactivate an aborted goal. A PR request already sent when abort
arrives is reconciled and shown honestly; abort does not promise to undo it.

PR publication records repository, head branch/SHA, base branch and a stable goal
marker before calling GitHub. A lost response is reconciled by that identity before
retrying. Delivery means the observed PR points at the verified commit, not that
an agent reported a URL. Cleanup acts only on recorded resources after workers are
confirmed stopped, preserves needed evidence, and records failures for retry.
User files and unrelated sessions are never cleanup candidates.

## Replacement and contributor experience

Build the replacement against disposable state and adapter fakes first. Keep it
out of installed-service startup until cutover is separately authorized. Use a
separate versioned database for the replacement; do not reinterpret legacy rows
as new approved work. Preserve the old database and existing worktrees. Cutover
requires an inventory of active legacy operations and an explicit drain/stop
procedure so two orchestrators never control the same work. Rollback must likewise
stop/reconcile new workers before restoring the old service; it is not a binary
swap while agents continue running.

After the replacement journey passes, remove superseded routes, schedulers, UI
controls and tests together. Tests may change with intentionally changed behavior;
retain evidence for safety and recovery invariants and keep required coverage.
Publish a retained/removed behavior inventory and updated architecture/setup docs.
This spec does not authorize operating the installed service or public release.

A documented fake-adapter development mode demonstrates the complete multi-agent
journey with no personal accounts or installed external services. Production
adapters have opt-in integration tests and explicit requirements. Logs correlate
commands, attempts and operations while excluding tokens, credentials and raw
private prompts. Packaging/licensing and a publication audit are later release work.

## Acceptance criteria

| Criterion | One verification |
| --- | --- |
| Domain decisions are independent of production integrations and browser derivation is pure. | An import-boundary test rejects Node/adapter imports in shared domain code and concrete integration imports in the application core. |
| A graph supports real parallel work and dependency ordering. | A deterministic scenario runs A and B concurrently, integrates both, then starts C depending on both from the recorded combined head. |
| Invalid graphs and unapproved changes never dispatch. | A command-contract suite covers cycles, missing/overlapping ownership, stale revisions and unauthorized agent commands. |
| Concurrency limits and attempt ownership hold under competing commands. | A scheduler race test submits simultaneous dispatches and checks one attempt per task and all role capacity limits. |
| State, events and operation intent commit atomically. | Fault injection inside the production transaction asserts all three roll back and no notification escapes. |
| Missed/duplicate events and active-sweep wakeups are safe. | A restartable consumer scenario covers commit-before-wakeup failure, replay, subscriber failure and an event arriving during an active sweep. |
| Separate bridge processes cannot write or approve workflow state. | A subprocess boundary test submits valid, stale and revoked scoped commands and verifies approval remains user-only. |
| Execution modes preserve terminal and background-job semantics. | An adapter contract suite checks permission waits, resume, output limits, signals, identity transfer and structured failures. |
| Reviews bind to exact targets and block invalid advancement. | A review contract suite covers malformed output, stale commits, blocking findings and exhausted repair budgets. |
| Integration is serialized, scoped and recoverable. | A temporary-Git-repository scenario integrates divergent sibling commits, exercises a conflict and crashes after Git success before the database record. |
| Final evidence applies to the published commit. | A publication scenario changes the integration head after review and confirms no PR operation occurs until renewed review and verification pass. |
| Uncertain dispatch and abort cannot duplicate or revive work. | A fault-injection scenario crashes at each dispatch boundary and delivers late results after abort. |
| Lost PR responses do not create duplicate PRs. | A GitHub adapter test loses a successful response and reconciles the existing goal-marked PR before retry. |
| Cutover and rollback preserve legacy data and avoid competing owners. | A disposable upgrade rehearsal checks database separation, active-worker inventory and refusal to start competing schedulers. |
| A contributor can exercise the full journey without accounts. | The documented fake-adapter local Cypress journey covers approval, parallel workers, a review repair, integration and one PR result. |

## Success measure

The release gate is 100% passage of the reproducible multi-agent fault-injection
matrix: parallel task execution through one verified PR, including each specified
crash/retry/abort boundary, with zero duplicate launches or PRs and zero advancement
from unapproved or stale evidence. This is a correctness measure, not a claim about
agent output quality; live provider behavior is reported separately.

## Delivery review gate

Commit this revised spec independently. A person reviews its workflow, proposed
defaults and retirement scope before the implementation plan is committed, as
required by AGENTS.md. The plan assigns one accountable owner for integration
and removal of obsolete paths, and sequences bounded changes against this contract.
Detailed passed, failed and unverified evidence belongs in the implementation PR.
