# Multi-agent orchestration core: implementation plan

Date: 2026-09-11
Status: Ready for implementation; no implementation has been performed by this plan.
Contract: [Multi-agent orchestration core redesign](../specs/2026-09-11-orchestration-core-refactor-design.md), commit `3f3102f`.
Review checkpoint: After receiving the revised spec and its review requirement,
the user instructed “Create me the implementation plan now.” This instruction is
the authorization to proceed with planning; it is not authorization for cutover,
live integrations, merge, deployment or public release.

## Delivery outcome and owner

Deliver one complete workflow: interactive planning → independently reviewed and
user-approved immutable task graph → concurrent implementers in isolated
worktrees → task review and bounded repair → serialized integration → verification
and independent final review → one observed PR at the verified commit.

One delivery owner is accountable for the domain contract, integration of all
changes, end-to-end evidence, removal of obsolete paths and operator documentation.
Individual tasks below are bounded commit/review units, not independent product
owners. Execute dependencies in order. This plan does not require parallel coding
agents or recursive delegation; product-level parallel implementers are mandatory.

The spec is authoritative. If implementation exposes a product-policy gap or a
contradiction, amend the spec in its own commit and obtain the required review
before updating this plan. Do not silently retain a legacy behavior or write a
product deviation into this document.

## Execution rules and checkpoints

- Use Node from `.nvmrc` and npm with the checked-in lockfile. Use `.mjs` with
  checked JSDoc/contracts for backend work, matching the existing runtime.
- Start with `git status --short`, inspect applicable instructions, and keep
  unrelated user changes intact. In particular, the pre-existing untracked
  `docs/superpowers/plans/2026-09-08-burst-scan.md` is outside this delivery.
- New code lives behind a separate development composition and disposable state
  until the replacement journey passes. Never construct the legacy application
  just to obtain a helper: its constructor wiring starts background services.
- Do not point tests at `~/.config/cmux-companion`. A separate plans DB alone does
  not isolate the existing GitHub issue cache; the new fake composition must not
  instantiate the issue synchronizer, credential loaders or installed services.
- Existing behavior may be removed when its replacement/exclusion is reflected
  in the spec and retirement inventory. Remove obsolete assertions with their
  feature; do not weaken safety assertions or coverage thresholds to get green.
- Each task ends with its targeted tests and lint/type checks for touched code.
  Run `npm run verify` at the milestone gates below. Run relevant local Cypress
  for user-visible changes and the full local suite before completion.
- Review implementation through bounded PRs targeting `main`; merge/release and
  operation of the installed product remain separate authorizations.

## Proposed code layout

Paths below are implementation targets, not claims that these files already exist.
Keep modules cohesive; do not turn each table or command into a separate framework.

| Area | Target files |
| --- | --- |
| Pure domain | `server/orchestration/domain/{contracts,commands,graph,transitions,review,state-view}.mjs` |
| Application and ports | `server/orchestration/{service,scheduler,reconciler,ports}.mjs`, `server/orchestration/types.d.ts` |
| Persistence | `server/orchestration/storage/{schema,store,events,artifacts,ownership}.mjs` |
| Agent execution | `server/orchestration/adapters/{agent-runtime,ccs,cmux,role-prompts}.mjs` |
| Git and PR operations | `server/orchestration/adapters/{git,verification,github}.mjs` |
| Command transport | `server/orchestration/{routes,bridge,bridge-auth,event-consumers}.mjs` |
| Composition | `server/orchestration/{create-runtime,dev-server}.mjs` |
| Goal UI | `app/orchestration/{goal-board,goal-detail,task-graph,review-panel}.tsx` |
| Disposable harness | `tests/helpers/orchestration/{fixture,fake-agents,fake-github,fake-clock,faults}.mjs` |
| Tests | Top-level `tests/orchestration-*.test.mjs`, `tests/ui-orchestration-*.test.tsx` |

Inspect `delivery-contract.mjs`, `planner-process.mjs`, `cmux-client.mjs`,
`goal-worktree-proof.mjs`, `goal-verification.mjs` and repository utilities for
reusable mechanisms. Reuse tested primitives only after removing dependencies on
legacy workflow state. `WorktreePlanStore`, `GoalIntegrator` and the existing
planner/review services are references for failure cases, not interfaces to retain.

## Dependency and review sequence

| Milestone | Tasks | Observable gate |
| --- | --- | --- |
| M1: durable decisions | T01–T03 | Invalid, stale or unapproved commands cannot create dispatch intents; atomic state/journal tests pass. |
| M2: real orchestration with fake agents | T04–T06 | A and B run concurrently, independent reviews gate them, C waits for integrated dependencies. |
| M3: evidence to PR | T07–T09 | Temporary Git repositories produce one verified PR through a fake GitHub adapter, including conflict recovery. |
| M4: usable replacement | T10–T12 | Browser journey uses the real new service; production adapters pass offline contracts and live gaps are explicit. |
| M5: retirement and release evidence | T13–T15 | Fault matrix, disposable cutover rehearsal, removal inventory, full verification and coverage pass. |

T01 → T02 → T03 → T04 → T05 → T06 → T07 → T08 → T09 is the initial critical
path. T10 depends on T03 and T06; T11 depends on T04, T05 and T10; T12 depends on
T09–T11. T13 depends on T09–T12; T14 depends on T13; T15 depends on T14.
Cross-cutting crash/abort tests start with the relevant task, not only at T13.

## Test repository and test layers

T05 introduces a checked-in fixture under `tests/fixtures/orchestration-repo/`:
a small dependency-free Node project with a `package.json`, source modules and
`node --test` checks. A fixture builder creates a fresh Git repository, initial
commit and local bare remote in a temporary directory for each scenario. Never
commit a nested `.git` directory or use the Companion checkout as the task repo.

Task A implements one module, B implements another, and C depends on both and
composes their behavior. Tests in the fixture verify the combined result. Include
variants for an intentional conflicting edit, a failing repository check and a
repair that changes the candidate SHA. Scripted fake agents make real edits and
commits in their assigned worktrees through the agent adapter; they do not mark
tasks accepted or insert integration records directly into SQLite.

| Layer | Real components | Controlled external boundaries |
| --- | --- | --- |
| Unit | Domain transitions, graph validation, review policy, UI helpers | Clock and identity sources where needed |
| Backend integration | Service, SQLite, bridge subprocesses, scheduler, Git/worktrees, fixture verification commands | Scripted agent responses and stateful fake GitHub |
| Browser E2E | Mobile UI, HTTP/API, auth, event stream, service, SQLite, fixture Git repository and local remote | Agent/provider and GitHub adapters only |
| Opt-in live adapter tests | Actual supported provider CLI, cmux and authorized GitHub integration | Only boundaries explicitly identified by the test |

T07 uses this fixture for worktree/candidate tests; T08–T09 exercise its real
integration commits and verification command. T12 uses the same builder in the
browser journey, proving two worker attempts overlap, C starts from their combined
head, an intentional failing check prevents PR publication, and repair plus renewed
review/verification permits exactly one PR. Assert repository contents, commit SHAs
and operation counts as well as visible cards. Capture fixture diffs, sanitized
logs and Cypress failure artifacts before cleaning only the fixture's resources.

The first three layers are deterministic and account-free. They do not establish
real model quality or production CLI permission enforcement; T11 reports those
live checks separately. No test listed here exists merely because it is planned.

## Implementation code-quality review gate

This gate reviews the Companion implementation itself. It is separate from the
planner/task/integration reviews that the finished product will orchestrate.

Before closing each milestone, obtain an independent review of the implementation
diff against the spec, tests and affected callers. The reviewer must be a person
or a separate agent conversation from the author. The delivery owner resolves
findings and remains accountable; an author's self-review is useful but does not
replace this gate. No recursive delegation is required.

The review checks:

- Clear domain/application/adapter boundaries, one lifecycle authority, readable
  interfaces and no retained duplicate scheduling or review policy.
- Transaction boundaries, races, stale identity handling, resource cleanup and
  retry behavior across external side effects.
- Input validation, approval enforcement, restricted agent capabilities and
  credential/private-data handling at the actual integration boundary.
- Tests that exercise observable failure cases and real integration boundaries,
  rather than mirroring implementation or stubbing the behavior being verified.
- Maintainable error handling, bounded queues/output, lifecycle disposal and
  documentation/configuration that a new contributor can follow.
- Completion of the retirement inventory, without removing still-required safety
  tests or broadening production capability as a shortcut.

Record the reviewed commit SHA, reviewer, findings with severity/file references,
fix commit and final disposition in the PR. Resolve blocking findings and have
the fixes reviewed before closing the milestone; track nonblocking items explicitly
with rationale. Changed code after review receives an incremental review. At T15,
review the combined architecture and end-to-end flow after legacy removal, not
only the individual task diffs. Lint, typecheck, coverage and passing tests support
this review but do not substitute for it.

## T01 — Establish the domain and capability contracts

**Owner:** Delivery owner. **Dependencies:** None.
**Files:** Domain modules, `ports.mjs`, `types.d.ts`, `tsconfig.backend.json`;
`tests/orchestration-domain.test.mjs`, `tests/orchestration-boundaries.test.mjs`.

1. Define versioned command/result envelopes and stable identifiers for goal,
   generation, contract revision, task, attempt, operation, review target and
   integration checkpoint. Specify expected-version conflict responses.
2. Define explicit goal, task, attempt, review and external-operation states.
   Distinguish queued, dispatched/running, uncertain, failed, cancelled and
   successful evidence; keep goal outcome separate from worker liveness.
3. Implement pure graph validation: unique ids, known dependencies, acyclicity,
   criterion ownership and declared-write overlap policy. Canonicalize declared
   paths; reject traversal and ambiguous unsupported ownership expressions.
4. Implement transitions for proposal publication, review, approval, dispatch,
   candidate submission, repair, integration, final evidence, abort and outcome.
   Model contract replacement so it fences old work before new approval is usable.
5. Define ports for clock/identity, agents, repository work, verification and PR
   observation. Agents advertise role/mode capabilities; unsupported combinations
   fail before an intent becomes dispatchable.
6. Add structural tests for pure-domain/browser imports and application-to-adapter
   dependency direction. Include new backend files in checked-JS type coverage;
   the current backend tsconfig only includes a few legacy modules.

**Verification:** `node --test tests/orchestration-domain.test.mjs tests/orchestration-boundaries.test.mjs`.
**Done:** Rules can be evaluated without SQLite, cmux, filesystem mutation or accounts.

## T02 — Persist authoritative state, idempotency and event journal

**Dependencies:** T01.
**Files:** Storage modules, `service.mjs`; `tests/orchestration-storage.test.mjs`.

1. Create a distinct versioned database schema and explicit constructor path.
   Store immutable contracts, graph snapshots, attempts, review lineages/findings,
   integration checkpoints, operation intents, command receipts and consumer cursors.
   Add foreign keys and uniqueness constraints for active ownership where practical.
2. Implement one service command transaction: authenticate authority supplied by
   transport, load current version, validate domain transition, update state,
   append event, persist operation intent and record the command result.
3. Hash canonical command input for the idempotency receipt. Exact replay returns
   its saved result; reuse of the key with different input conflicts. Validate
   current credential authority before replaying any potentially sensitive result.
4. Keep external I/O outside the transaction. Add injectable failpoints before
   commit, after commit and before notification. Stage post-commit wakeups and
   discard them on rollback; a notification failure must not turn a committed
   command into an apparent rollback.
5. Persist large artifacts by immutable identity, validate size/digest and return
   bounded references in events. Write artifact bytes before committing references;
   clean unreferenced artifacts later without deleting active evidence.
6. Provide a consistent snapshot-plus-cursor query in one read transaction,
   paginated `since` events, explicit expired-cursor response and retention constrained
   by active goals and durable consumer positions. Keep private context out of public
   projections and journal payloads.

**Verification:** `node --test tests/orchestration-storage.test.mjs` exercises real
temporary SQLite files, rollback, reopen, duplicate commands, stale versions,
artifact failure and snapshot/event consistency.
**Done:** Crash-safe state exists without any live side effects. Run `npm run verify`
after T03 to close M1.

## T03 — Implement user commands and scoped bridge authority

**Dependencies:** T02.
**Files:** `routes.mjs`, `bridge.mjs`, `bridge-auth.mjs`, domain commands;
`tests/orchestration-api.test.mjs`, `tests/orchestration-bridge.test.mjs`.

1. Expose explicit goal creation/query, proposal, review, approval, abort, retry,
   reconciliation and evidence commands under an isolated orchestration API prefix.
   Document request/response/error schemas; no generic shell or SQL route exists.
2. Reuse pairing and same-origin enforcement for user mutations. Keep the agent
   command surface separate: a scoped agent credential cannot invoke approval,
   change concurrency, expand scope or impersonate another role/attempt.
3. Issue per-attempt revocable credentials with random secrets stored as hashes.
   Deliver secrets through private runtime channels/files, never CLI arguments,
   browser payloads, journal events or logs. Bind credentials to generation/revision
   and attempt capabilities; compare ownership on every mutation.
4. Replace direct bridge SQL with service requests. Network failure leaves a
   command retryable with its original operation id; offline agents cannot invent
   local authority or advance state. Preserve structured stale/revoked responses.
5. Spawn a separate bridge fixture process and test request boundaries, revocation,
   request limits, cross-goal submissions and token redaction. Prove absence of
   database imports in the bridge, without claiming this is an OS sandbox.

**Verification:** `node --test tests/orchestration-api.test.mjs tests/orchestration-bridge.test.mjs tests/security.test.mjs`.
**Done:** A fake agent can publish evidence but cannot approve its own work.

## T04 — Add exclusive scheduling, capacity and reconciliation

**Dependencies:** T03.
**Files:** `scheduler.mjs`, `reconciler.mjs`, storage ownership;
`tests/orchestration-scheduler.test.mjs`, `tests/orchestration-ownership.test.mjs`.

1. Acquire exclusive service ownership for the canonical database identity before
   scheduling. Use an ownership adapter with verified process-instance identity
   and atomic acquisition, not a PID-only expiring lease. Test competing processes,
   path aliases and ambiguous stale owners; ambiguity blocks dispatch.
2. Select ready tasks by the spec's stable oldest-ready order, subject to global
   and per-goal capacity. Count implementer, reviewer and integration attempts;
   account separately for interactive planning capacity. Reserve a slot and create
   one intent atomically before awaiting an adapter.
3. Resolve dependency readiness only from accepted integration checkpoints.
   Failed dependencies block descendants without blocking independent siblings.
4. Build a coalescing event/timer loop with a pending-pass flag. Recover committed
   intents on startup, reconcile known workers before allocating replacement work,
   and retain capacity for workers whose termination remains uncertain.
5. Persist dispatch and observed adapter identity separately. At any crash gap,
   query by stable operation identity; if the adapter cannot establish whether a
   worker exists, show uncertain and require reconciliation rather than relaunch.
6. Fence abort and contract replacement before requesting external termination.
   Reject late completions; keep their evidence as history. Stop new dispatch
   immediately on shutdown and record outstanding ownership before exit.

**Verification:** `node --test tests/orchestration-scheduler.test.mjs tests/orchestration-ownership.test.mjs`.
**Done:** Concurrent commands cannot exceed configured capacity, duplicate a task
or revive an aborted generation, including after server restart.

## T05 — Implement execution contracts and deterministic fake agents

**Dependencies:** T04.
**Files:** `adapters/agent-runtime.mjs`, test harness modules;
`tests/orchestration-runtime.test.mjs`, `tests/orchestration-parallel.test.mjs`.

1. Implement the launch/observe/terminate/result port with injected adapter, clock
   and identity operations. Keep process policies explicit by execution mode.
2. Build deterministic fake agents that wait at named barriers, emit typed results,
   disappear, ignore termination or lose launch responses. Record each actual launch
   independently of service intents so duplicate-launch assertions are meaningful.
3. Use barriers rather than sleep timing to prove A and B are simultaneously active.
   Configure C to depend on both; prove it remains queued before their integration.
4. Add runtime contract cases for spawn failure, abort-before-spawn, identity-record
   failure, output overflow, idle/ceiling failure, interactive user wait and resume.
   Existing `planner-process.mjs` is a candidate for reusable process mechanics.
5. Expose named crash failpoints at intent commit, dispatch, identity record, result
   reception and result commit. Helpers must reopen the real database for recovery.

**Verification:** `node --test tests/orchestration-runtime.test.mjs tests/orchestration-parallel.test.mjs`.
**Done:** Product-level parallelism is demonstrated with the real scheduler and
store; fake agents do not bypass service commands or fabricate board state.

## T06 — Add planning, independent reviews and bounded repair

**Dependencies:** T05.
**Files:** Domain review, `service.mjs`, `adapters/role-prompts.mjs`;
`tests/orchestration-review.test.mjs`, `tests/orchestration-planning.test.mjs`.

1. Wire planning publication to immutable revisions and independent plan review.
   Require a current accepted target without blocking findings before user approval.
   A revised contract starts its own review and requires fresh approval.
2. Define versioned structured output schemas for planner, implementer, reviewer
   and integrator roles. Validate identity, bounded findings and evidence references.
   Reject conflicting disposition/blocking fields; no PASS regex or missing-output
   fallback is allowed to advance a task.
3. Construct independent review attempts with a different conversation identity
   and a snapshot of the exact target. Reviewers receive no write capability to
   the reviewed checkout. Verify this through production adapter contracts in T11.
4. Keep task candidate commits distinct from accepted/integrated results. A review
   pass applies only to its target and cannot accept later task-branch changes.
5. Track repair budgets against stable target lineage, including commit changes.
   Two repair attempts exhaust the default budget; expose the explicit human
   authorize-additional-attempt command and test its scope and idempotency.
6. Preserve malformed, failed and stale reviews as evidence without releasing
   blocked delivery. Allow unrelated approved work to continue.

**Verification:** `node --test tests/orchestration-review.test.mjs tests/orchestration-planning.test.mjs tests/orchestration-parallel.test.mjs`.
**Done:** Approval, task review and repair policy are enforced by the service.
M2 closes with a fake repository adapter providing accepted integration checkpoints;
real Git evidence replaces it in T07–T08. Run `npm run verify`.

## T07 — Create isolated worktrees and verify task candidates

**Dependencies:** T06.
**Files:** `adapters/git.mjs`, repository port, artifact storage;
`tests/orchestration-git.test.mjs`.

1. Reuse repository identity/allow-list and ref-validation primitives. Derive
   branches/worktree paths from recorded identity; never accept arbitrary paths
   from agent output. Check canonical paths and pre-existing worktree ownership.
2. Record provisioning intent and the selected base SHA before creating a worktree.
   Reconcile an interrupted creation against recorded identity. Persist the resulting
   resource before agent dispatch; do not adopt an unrelated pre-existing checkout.
3. Provision each attempt from its recorded integration checkpoint and prohibit
   shared writable checkouts. Review immutable commits through dedicated snapshots.
4. On candidate submission, verify the commit exists, belongs to the expected
   repository, is descended from the recorded base and matches the allowed task
   identity. Calculate changed paths/delta and preserve verification/report evidence.
   Unsupported history or unexpected scope blocks acceptance pending explicit action.
5. Use disposable repositories with local-only remotes. Cover moved branches,
   stale submissions, dirty worktrees, duplicate provisioning and path traversal.

**Verification:** `node --test tests/orchestration-git.test.mjs`.
**Done:** Candidate evidence is independently established from Git, not agent prose.

## T08 — Serialize integration and recover partial Git success

**Dependencies:** T07.
**Files:** Git adapter, service integration commands, scheduler;
`tests/orchestration-integration.test.mjs`.

1. Acquire one durable integration operation per goal with expected head, task
   base, candidate SHA and operation identity. Do not hold a SQLite transaction
   while running Git or an integration agent.
2. Apply only the task delta from its recorded base in an isolated integration
   checkout. Generate the proposed resulting commit before advancing the goal ref.
   Record an operation-specific durable Git evidence ref/manifest, then use
   `git update-ref` with the expected old SHA to advance the goal branch atomically.
3. On restart, inspect both operation evidence and actual goal head. Record an
   already completed advance once; refuse unexpected head changes. Do not apply
   the same delta twice after a Git-success/database-failure interruption.
4. On conflict, launch a bounded integration-role attempt in the recorded checkout.
   Record its identity, require a valid result and scope verification, and prevent
   concurrent operations on that checkout. Failure leaves evidence and blocks
   integration; no destructive reset of an unrelated/unknown checkout is permitted.
5. Mark dependencies satisfied only after the integration result commits to state.
   Start C from the combined accepted head after integrating A and B.
6. Exercise siblings with divergent changes, overlapping changes, conflicts, moved
   refs, duplicate callbacks and crash recovery after every durable boundary.

**Verification:** `node --test tests/orchestration-integration.test.mjs tests/orchestration-parallel.test.mjs`.
**Done:** Two accepted implementers become a single serialized branch without
reapplying already integrated history or launching dependents too early.

## T09 — Verify the combined commit and publish one PR

**Dependencies:** T08.
**Files:** `adapters/verification.mjs`, `adapters/github.mjs`, service publication;
`tests/orchestration-verification.test.mjs`, `tests/orchestration-publication.test.mjs`.

1. Resolve verification commands from the approved contract/repository policy,
   execute via validated argv in the recorded checkout with bounded process limits,
   and save per-command outcome, output artifact, target SHA and environment identity.
2. Require all contract-required checks and independent integration review on the
   same current head. An unavailable check is a gap, never a pass. Final repair
   attempts invalidate prior acceptance and rerun required checks against the new SHA.
3. Observe target-branch movement explicitly. Any branch rewrite/update restarts
   the affected final evidence gates; do not auto-merge or silently change scope.
4. Persist publication intent before push/PR operations. Verify the remote head
   matches the accepted SHA and use safe conditional ref updates. Persist enough
   identity to reconcile an uncertain push before retrying.
5. Create/update the goal-marked PR through the GitHub port. Reconcile by repository,
   branch and goal marker after lost responses; reject ambiguous matches rather
   than creating another PR. Observe PR head SHA before recording delivery.
6. Test an abort before dispatch, during a sent request and after remote success.
   Record an already-created PR honestly without reactivating the goal. Polling
   the PR state never authorizes merge or deployment.

**Verification:** `node --test tests/orchestration-verification.test.mjs tests/orchestration-publication.test.mjs`.
**Done:** M3 produces one observed fake-GitHub PR at the verified real-Git commit.
Run `npm run verify`.

## T10 — Compose the isolated service and event consumers

**Dependencies:** T03, T06; finish wiring T09 outputs before M4.
**Files:** `create-runtime.mjs`, `dev-server.mjs`, `event-consumers.mjs`, routes;
`tests/orchestration-composition.test.mjs`, `tests/orchestration-events.test.mjs`.

1. Build a composition root with explicit storage paths, adapters, limits, ownership
   and lifecycle cleanup. Production dependencies are injected once. Close consumers,
   listeners and storage predictably; no timer starts inside a data mapper.
2. Add a fake-adapter dev entry using private temporary state and no default credential
   lookup. Bind loopback, retain pairing and expose the runtime's complete command API.
   Refuse conflicts with occupied ports instead of stopping their owners.
3. Implement journal consumers with durable cursors, duplicate-safe side effects
   and a coalescing wakeup. Keep notification delivery separate from scheduling
   authority; a failed websocket/push callback cannot fail a committed command.
4. Publish a public projection rather than raw journal/private artifacts. On reconnect,
   send a consistent snapshot and replay later cursors; expired history requests resync.
5. Invalidate caches by their actual source. Workspace/repository events still own
   non-goal invalidation; a plan event is not their replacement.
6. Test crash after commit before wakeup, restart catch-up, failed subscriber retry,
   slow consumers, event retention and a state change during an active sweep.

**Verification:** `node --test tests/orchestration-composition.test.mjs tests/orchestration-events.test.mjs`.
**Done:** A service process can demonstrate orchestration without constructing
`server/index.mjs` or any live legacy integration.

## T11 — Connect production agent/cmux adapters behind capability checks

**Dependencies:** T04, T05, T10.
**Files:** CCS/cmux/role-prompt adapters, bridge executable;
`tests/orchestration-agent-adapters.test.mjs`, opt-in `tests/orchestration-agents.live.mjs`.

1. Implement role-specific CLI construction using explicit capabilities, provider,
   model, effort, tools, hooks, session identity and output protocol. Centralize
   execution mechanics without erasing interactive/background differences.
2. Preserve interactive planner terminal ownership, fresh/resume behavior and native
   permissions. Implement bounded background roles with process-group termination,
   buffer limits, on-spawn identity persistence and structured failures.
3. Bind cmux resources to operation identity before relying on their events. Probe
   recorded session/process identity during recovery; unsupported correlation leaves
   dispatch uncertain. A cmux Stop event only triggers evidence reconciliation.
4. Enforce role permissions with supported provider mechanisms. Reject unsafe modes
   or unsupported review isolation before launch. Test denial of mutation, unscoped
   agent tools and approval bypass at the actual adapter boundary; prompt text is
   not permission enforcement.
5. Keep private inputs in restrictive files, clean them only after owned processes
   stop, and test redaction of tokens, raw prompts and credential-bearing errors.
6. Define opt-in live cases for real native permission waits, resume, process death,
   hook denial and structured results. Document exact prerequisites and opt-in;
   exclude these suites from normal discovery. Do not run them without authorization.

**Verification:** `node --test tests/orchestration-agent-adapters.test.mjs tests/test-discovery.test.mjs tests/test-script-list.test.mjs`.
**Done:** Offline contracts pass for supported capabilities. Report live behaviors
as unverified until the explicitly authorized integration suite passes; fake tests
are not a claim of proven production permission enforcement.

## T12 — Build the mobile journey against the real replacement backend

**Dependencies:** T09–T11.
**Files:** Goal UI modules, `app/api-request.ts`, dashboard/navigation wiring,
UI types; `tests/ui-orchestration-goals.test.tsx`, `cypress/e2e/orchestration-core.cy.ts`,
`scripts/run-local-cypress.mjs`, `scripts/run-orchestration-dev.mjs`, `package.json`.

1. Render the shared public goal state and dependency graph. Show running agents,
   integrated dependencies, review targets/findings, failed/uncertain ownership,
   concurrency and the final PR evidence without deriving another lifecycle in UI.
2. Implement proposal review/approval, revision requests, scoped repair authorization,
   abort, retry and reconciliation actions with expected versions and idempotency ids.
   Preserve read-only UI guards and invalidate shared reads after mutations.
3. Show stale-command conflicts by refreshing authoritative state. Do not optimistically
   display approval, completion or cancellation before the service records it.
4. Expose interactive planning/open/resume actions and explicit reasons when a
   provider capability, worker identity or check is unavailable.
5. Extend the local Cypress runner with an explicit orchestration fixture mode that
   starts the real new backend plus fake external adapters. The existing runner
   starts only the frontend and existing specs stub APIs; those stubs cannot prove
   this workflow. Use disposable repos/state and stop only owned child processes.
6. Drive planning, approval, concurrent A/B execution, one blocking review/repair,
   integration, C launch and one PR through the browser. Also cover reconnect,
   read-only protection and abort/reconciliation. Do not stub workflow responses
   in this scenario; fake only external agent/PR boundaries.
7. Document commands for the fake development demo and targeted Cypress execution.
   Ensure the fixture cannot activate real adapters through inherited environment.

**Verification:** `npm run test:ui -- tests/ui-orchestration-goals.test.tsx`, then
`npm run test:e2e:local -- --orchestration --spec cypress/e2e/orchestration-core.cy.ts`
(the `--orchestration` runner option is introduced by this task).
**Done:** M4 is a usable replacement journey. Run `npm run verify` and the relevant
local Cypress suite; document remaining live-adapter gaps separately.

## T13 — Complete the fault matrix and safe cleanup

**Dependencies:** T09–T12.
**Files:** Reconciler, cleanup commands, fault harness;
`tests/orchestration-faults.test.mjs`, `tests/orchestration-cleanup.test.mjs`.

1. Parameterize the crash boundaries below across supported roles/operations. Kill
   and restart the service process for durable-boundary cases; do not merely throw
   in a mock and leave in-memory ownership intact.
2. Add resource cleanup eligibility: recorded ownership, confirmed worker termination,
   delivered/aborted lifecycle and retained evidence. Preview cleanup candidates;
   refuse unrelated, dirty or ambiguously owned resources. Persist failed cleanup
   for explicit/reconciled retry without replaying integration or publication.
3. Check exact launch/PR counts, consumed capacity, event receipts and accepted
   versions after recovery. Surface unresolved uncertainty instead of fabricating
   a successful end state to satisfy the matrix.
4. Collect a machine-readable local report containing case id, failpoint, seed,
   observed external operations, expected outcome and pass/fail/unverified status.
   Keep reports free of credentials and private prompts.

| Boundary | Required recovery invariant |
| --- | --- |
| Before state/intent commit | No event, dispatch or state transition survives. |
| After commit before wakeup | Restart discovers the work once. |
| After dispatch before identity record | Reconcile by identity or remain uncertain; never blindly relaunch. |
| After worker result before result commit | Idempotent result replay cannot accept stale ownership. |
| During review/repair | Exact target and lineage budget survive restart. |
| After Git evidence/ref update before DB result | Record existing integration once; do not apply delta twice. |
| After final review before head change | New head has no reusable final acceptance. |
| After push or PR success before response | Observe remote identity before retry; no duplicate PR. |
| During abort/termination | No fresh dispatch; uncertain survivors retain ownership; late results cannot revive work. |
| During consumer/cleanup failure | Retry the side effect without replaying workflow operations or deleting unrelated resources. |

**Verification:** `node --test tests/orchestration-faults.test.mjs tests/orchestration-cleanup.test.mjs`.
**Done:** Every specified local matrix case has reproducible evidence. Distinguish
fault-handling correctness from unmeasured model output quality.

## T14 — Rehearse cutover and retire competing orchestration paths

**Dependencies:** T13.
**Files:** `server/app.mjs`, `server/index.mjs`, legacy modules and goal UI,
associated tests, operator docs; `tests/orchestration-cutover.test.mjs`.

1. Produce `docs/orchestration-retirement.md` mapping every legacy entry point,
   constructor/timer, SQL writer, route, UI control and test to retain, replace or
   remove. Use imports and call sites, not filenames alone, to find dependencies.
2. Cover at least WorktreePlanner/plan store/schema, GoalSessionService and bridge,
   GoalIntegrator/followups, GoalReviews/PlannerAssessments/GoalOutcomeStore,
   burst scheduling/review, watchdog/merge observation and session collectors.
   Retain pure/security/Git utilities only where a current consumer remains.
3. Remove excluded feature launch paths from replacement wiring and UI. Preserve
   general terminal monitoring, pairing, repository allow-lists and unrelated
   account/settings functionality. Quota display must not become scheduler policy.
4. Write a read-only legacy inventory command and a cutover runbook identifying
   active goals, exact sessions/resources, database backups and drain/stop steps.
   Refuse startup when an existing legacy owner or new owner could control the
   same resources. Never import legacy approval into a fresh new goal automatically.
5. Rehearse new startup and rollback using disposable legacy/new databases, fake
   worker identities and temporary worktrees. Verify rollback cannot proceed while
   replacement workers remain active or uncertain.
6. After the replacement journey passes, remove superseded source, routes, controls
   and tests together. Port relevant regression cases to new invariant tests before
   deleting old tests. Remove obsolete docs/config/scripts and update API types.
7. Wire the replacement production composition in source only with an explicit
   readiness/cutover guard. The guard must fail before background work on an
   unprepared installed configuration. Do not run installer/updater/start commands
   against the user's installation during this task.

**Verification:** `node --test tests/orchestration-cutover.test.mjs`, `npm run verify`,
then the full `npm run test:e2e:local` including the new real-service fixture run.
**Done:** One active orchestration architecture remains in source, with explicit
retirement evidence and a rehearsed operator procedure; installed state is untouched.

## T15 — Final checks, contributor docs and completion evidence

**Dependencies:** T14.
**Files:** README, `.env.example`, AGENTS important-code map, architecture and
operator docs, implementation PR descriptions/report.

1. Document the core boundaries, state/command vocabulary, task graph rules,
   review/repair policy, adapter capability requirements and fake development path.
   Record optional production dependencies without making private accounts necessary
   for routine checks. Remove stale conflicting README journeys.
2. Document configuration defaults/validation for capacity, execution limits,
   separate state, adapters and journal retention. Verify all examples use
   disposable/private credentials and loopback networking.
3. Run the complete local verification set below once the final changes are in place.
   Investigate failures and rerun affected checks after fixes, not unchanged failures.
4. Publish traceability and the retained/removed inventory in the PR evidence.
   Separate passed, failed and unverified paths, especially real provider permission
   enforcement, cmux continuity and GitHub behavior requiring opt-in live tests.
5. Deliver code and operator instructions for review. Do not mark installed cutover,
   live acceptance, merge, deployment or open-source publication complete.

**Final commands:**

```sh
npm run verify
npm run test:coverage
npm run test:ui:coverage
npm run test:e2e:local
npm run test:e2e:local -- --orchestration --spec cypress/e2e/orchestration-core.cy.ts
```

Backend and UI line coverage remain at least 90%. If Electron fails, use the
repository-documented Chrome override and record the intervention. No live test
or operator command is implied by these local checks.

## Acceptance traceability

Rows identify the spec criteria by their existing order and text; the plan does
not introduce replacement product acceptance criteria.

| Spec criterion | Primary implementation | Decisive evidence |
| --- | --- | --- |
| 1. Independent domain and pure browser derivation | T01, T12 | Import boundary suite |
| 2. Parallel graph and dependency ordering | T04–T08 | A/B/C real-scheduler and temporary-Git scenario |
| 3. Invalid/unapproved changes never dispatch | T01, T03, T06 | Command/graph/authority suite |
| 4. Capacity and attempt ownership | T04–T05 | Competing dispatch and process ownership tests |
| 5. Atomic state/event/intent | T02 | Transaction failpoint suite |
| 6. Safe event recovery and wakeups | T04, T10 | Restartable journal consumer scenario |
| 7. Scoped bridge authority | T03, T11 | Separate bridge process and adapter denial tests |
| 8. Execution-mode contracts | T05, T11 | Runtime/adapter contracts; live gaps reported |
| 9. Exact-target review gates | T06, T09 | Review target and repair-lineage suite |
| 10. Serialized recoverable integration | T07–T08 | Temporary-Git conflict/crash scenario |
| 11. Evidence matches published commit | T09 | Changed-head publication scenario |
| 12. Uncertain/aborted work cannot duplicate or revive | T04, T13 | Dispatch and abort fault matrix |
| 13. No duplicate PR on lost response | T09, T13 | Stateful fake-GitHub reconciliation test |
| 14. Safe legacy separation and cutover | T14 | Disposable cutover/rollback rehearsal |
| 15. Account-free contributor journey | T10, T12, T15 | Real-service fake-adapter local Cypress |

## Completion report template

- Spec/plan commits and implementation PRs targeting `main`.
- Accountable delivery owner and completed task/milestone list.
- Retained/removed behavior inventory and changed public interfaces.
- Local checks: command, result, coverage and evidence artifact.
- Independent implementation reviews: milestone, reviewed commit SHA, reviewer,
  findings, fix commits and remaining nonblocking items.
- Fault matrix: case results, duplicate counts and unresolved uncertainty.
- Live paths: explicitly passed, failed or unverified, with authorization recorded
  if any live check was run.
- Interventions, remaining gaps and operator cutover/rollback prerequisites.
- Explicit status of installed cutover, merge and release: not performed unless
  separately authorized and actually verified.
