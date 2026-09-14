# Bundled updater with update notifications

Date: 2026-09-13
Status: Original contract approved by the user on 2026-09-13 after spec commit 392144c.
The user approved the 2026-09-14 native-planner handoff amendment after reviewing
standalone spec commit cc88275, with “Approve this handoff design”, before the
implementation-plan commit.
Review feedback: On 2026-09-13 the user requested an opt-in automatic-installation
toggle, disabled by default; incorporated below.
Owner: The implementing agent owns packaging, UI, API, durable requests,
admission coordination, updater recovery, verification and cleanup.

## Outcome

One Companion checkout contains the application and its updater. A paired user
is notified in the app when a newer eligible main commit exists and explicitly
chooses whether to install it. Automatic installation is disabled by default and
can be explicitly enabled with a persistent Settings toggle. Discovery alone never
authorizes installation: each transaction requires either exact-commit manual
approval or a currently enabled automatic-installation policy.
The updater remains a separate process that can recover a failed application.
Companion runs above cmux: unrelated sessions never delay its updates. A supported,
positively identified Companion planning terminal can also remain open and working
through an update, using the handoff contract below. Active in-process effects and
unresolved ownership still delay activation; this does not detach every agent type.

This contract supersedes unattended installation and independent updater-repository
tracking in `docs/local-updater-spec.md`. Existing recovery and retention safeguards
remain applicable. Implementing this feature does not install, restart or migrate
the operator's live services, publish a release, or change repository visibility.

## User journey

1. A fresh installation from this repository includes the updater without a sibling
   checkout. Existing installations use an explicit documented migration; importing
   old enabled state never grants automatic installation permission.
2. While online, the updater checks the configured trusted GitHub repository's main
   branch periodically (default five minutes). Settings also offers Check for updates.
   Checks inspect eligibility; a separate authorized transaction handles building
   and activation. With automatic installation off, checking never installs.
3. A nonblocking in-app Update available notice leads to Settings. Show installed
   and candidate commit identifiers, a changes link, last check and any check error.
   Only a successful Verify workflow run for the exact main commit qualifies.
   Pending, missing, failed or inaccessible CI evidence cannot authorize an update.
   Select the newest eligible main descendant; never downgrade or accept divergent
   history. Explain when a newer main commit is still awaiting successful checks.
4. Update now opens a confirmation naming the exact candidate and explaining the
   brief reconnect. Later dismisses that candidate's notice on this device without
   disabling future checks. The update remains available in Settings.
5. Confirmation creates one durable, idempotent request for that exact commit.
   A newer commit cannot inherit its permission. Duplicate clicks and service
   restarts cannot create duplicate transactions.
6. If a non-transferable effect is active, offer Update when ready. Queueing requires
   explicit confirmation; name the actual blocking effect and offer Cancel queued
   update. A supported interactive planner or unrelated cmux session does not count
   as busy solely because it is running. Unknown ownership remains blocking.
7. Fence new workflow admission and establish the supported terminal handoff before
   activation. Recheck effect quiescence, service identity and handoff evidence before
   switching. Never kill cmux sessions or interrupt their interactive work. If safety
   cannot be established, explain the precise blocker instead of inferring idleness
   from a missing process. The app briefly reconnects while preserved planners keep
   their existing terminal, conversation and worktree.
8. Show preparing, verifying, restarting, success or failure. The PWA reconnects and
   reports the observed running commit. Failed startup triggers verified recovery
   of the previous compatible release; recovery failure remains visible and stops
   further activation until explicitly resolved.
9. Settings offers an Automatic installation toggle, off on fresh installation and
   legacy migration. Explain beside it: install eligible updates when Companion can
   restart safely, keeping supported planning terminals open, with a brief reconnect. Turning it on is explicit ongoing authorization;
   no per-update confirmation is required while it remains on. Each eligible
   candidate receives its own durable request and uses the same CI, handoff, fencing,
   validation and recovery rules as manual updates. Show automatically queued work.
10. Turning the toggle off persists immediately, revokes automatically authorized
    requests that have not started staging, and preserves discovery, notifications
    and independently confirmed manual requests. Serialize disable versus transaction
    start so no new automatic transaction can begin after disable succeeds. An
    already-started transaction completes or recovers safely; show this explicitly.
    Cancelling an automatic queued request suppresses that candidate until a manual
    request or an explicit off/on opt-in; periodic checks do not silently recreate it.

## Boundaries and invariants

- Packaging: bring the existing updater source and meaningful tests into `updater/`,
  preserving its MIT notice and recording the source commit. Use the root npm
  lockfile and Node policy. Update application wrappers and retention integration.
  Both components derive from one approved Companion commit. Preserve a minimal
  stable bootstrap and recovery-capable process outside the application lifetime.
- UI/API: retain pairing, same-origin validation and loopback binding. Expose only
  fixed check, confirm, queue, cancellation and automatic-installation preference
  operations with strict schemas and revision-checked preference writes.
  No browser-supplied remote, branch, executable, script or filesystem path. Apply
  the UI's mutation protection to update actions. Status returns no credentials,
  private paths, terminal content or raw external command errors.
- Discovery: use a trusted configured repository identity, exact commit and workflow
  identity; PR checks, unrelated workflows and another repository cannot qualify.
  Revalidate eligibility before staging. Use bounded calls, backoff and rate-limit
  handling. Private repositories may use existing authenticated gh; credentials
  remain outside request/state payloads. Unavailable checks preserve the running app.
- Persistence: request identity, candidate, approval, cancellation and transaction
  outcome are durable and atomically written with private permissions. Discovery
  and approval are distinct state. Cancellation before staging revokes permission;
  after transaction start, recovery owns completion and the UI explains that state.
  Persist automatic installation as an installation-wide boolean defaulting to
  false, with its policy revision and each request's manual/automatic authorization
  source. Restart and reinstall preserve an explicit choice; missing, malformed or
  legacy enabled values never imply opt-in. Recheck the automatic policy atomically
  at transaction start; discovery cannot manufacture approval. Quarantined failures
  retain existing explicit retry requirements even while automatic installation is on.
- Background: admission fencing must coordinate with the authoritative orchestration
  service and relevant monitoring launches/queued prompts, not just a UI count.
  Revalidate service identity and fence after crashes; unavailable evidence blocks
  activation. A cancelled or failed pre-activation request releases its fence safely.
- Installation: stage an isolated exact-commit release, run required validation,
  switch atomically, verify exact-SHA application/frontend health, retain rollback
  material and resume interrupted transactions. Do not reset developer checkouts,
  delete unknown resources, replace pairing secrets or reconfigure unrelated Tailscale
  handlers. Launch configuration uses selected settings and tool locations.
- Data recovery: before activation, establish schema compatibility and a consistent
  backup of affected durable application state under the maintenance fence. Do not
  resume workflow writes until health acceptance. Never claim binary rollback fixes
  an incompatible schema; refuse an update without a verified restoration strategy.
  Restore only transaction-owned affected state, retaining evidence and credentials.
- Migration: conversion from the two-repository installation must be explicit and
  recoverable, with no simultaneous old/new updater owners. Preserve configured
  paths, token, state, rollback target and disabled choices. Detect unsupported or
  active legacy transactions and refuse migration with useful guidance.

## Native planning terminal handoff amendment (2026-09-14)

This section replaces the blanket managed-agent idle requirement. Its scope is
Companion's native **interactive planner** supervisor, which cmux owns independently
of the Companion process. Existing background workers, verification, publication,
Git integration, startup fetches, prompt delivery and unresolved external operations
retain their effect-specific fences. An idle goal status alone is not a blocker;
a worker count alone is not evidence that restart is safe.

### Admission and shutdown

- Acquire the durable update fence, stop new admission, and drain already-entered
  mutations before recording a handoff. No launch, resume, termination or other
  in-process effect may be in flight at the snapshot boundary.
- Transfer only a fully dispatched planner with current attempt/generation/revision,
  operation and conversation bindings, matching request/workspace/runner receipts,
  verified runner PID stamp, stable loopback endpoint and durable scoped credential.
  A missing process or ambiguous receipt never qualifies. Record an explicit
  supported handoff-protocol version; observing a PID alone does not grant support.
- The update-specific close path detaches these verified terminal supervisors without
  signalling runner/provider groups or closing their cmux workspaces. Normal abort,
  cancellation and non-update teardown retain their existing ownership rules. New
  code must not turn every close call into silent abandonment of owned processes.
- The replacement service adopts the same terminal/attempt identity without launch,
  credential replacement, native conversation restart or worktree recreation. Verify
  its ability to observe the handed-off runner before accepting application health.
  A runner that exits naturally during reconnect is reconciled from durable receipts;
  this must not trigger a duplicate launch or be mistaken for permission to retry.

### Results and reconnect

- Supported planner clients durably record submitted results outside the application's
  SQLite rollback set before acknowledging local receipt. The outbox binds the exact
  result id, bytes and attempt identity, with private permissions and bounded storage.
  It survives maintenance responses, unavailable loopback service, client reconnect
  and application rollback. Accepted server receipts retire entries; unknown delivery
  retries exactly the same id and bytes and cannot manufacture approval.
- Distinguish transient maintenance/offline failures from revoked authority. Retry
  transient failures without exposing tokens or result contents; deny stale, aborted,
  answered or explicitly revoked submissions under the existing authority rules.
  Update interruption must not silently discard a completed plan or cause a planner
  to issue an independently identified duplicate submission.
- Initial activation and resume must understand the supported handoff protocol and
  reconnect window. Preserve explicit cancellation and finite failure reporting;
  do not replace authentication errors with unlimited retries.

### Data recovery and release lifetime

- Keep the fence across replacement startup and exact-SHA health acceptance. Candidate
  startup may inspect/reconcile handoff evidence but must not dispatch new work, mint
  replacement agent credentials, accept outbox mutations or advance goal lifecycle
  before acceptance. Existing credentials and attempt identities are in the consistent
  pre-activation SQLite backup.
- Failed activation restores the transaction's original SQLite state while keeping
  handed-off runners and their outboxes intact. The restored service adopts those
  runners, validates their original credentials, then drains results after recovery
  releases the fence. Restoration must not duplicate an acknowledged result, lose an
  unacknowledged result, or accept a result under a different generation.
- Pin every originating Companion release needed by a live/paused supervisor, MCP
  process, hook or resume command until stopped evidence and outbox settlement allow
  release. Retention must consult durable handoff dependencies; current/previous
  symlinks and process cwd/executable inventory alone are insufficient. Never delete
  a release merely because several newer updates have completed.

### Rollout and user-visible limitations

Already-running terminals retain their original client/runner code; upgrading the
Companion service does not retrofit an outbox or handoff support into them. A legacy
terminal without verified protocol support must wait until it finishes, or use a
separately authorized operator recovery with explicit consequences. Show this as
“Existing planning agent needs update-compatible recovery” with the affected goal;
do not claim that cmux itself blocks updates. Do not silently stop/relaunch a legacy
planner, rewrite its private files, or promise uninterrupted work from a PID check.

The first rollout can therefore require a one-time compatibility transition. Normal
updates afterward must complete while supported planning terminals remain open.
No change to the default-off automatic-installation preference or update authorization
rules is implied. Other agent types require their own reviewed continuity contract.

## Non-goals

Stable-release channels, arbitrary refs, public webhooks,
OS/tool updates, fleet management, remote shell access, automatically merging main,
and push/OS update notifications are excluded. Initial notifications are in-app.
Do not remove legacy compatibility until its installation migration is verified.
No live installation, migration, GitHub mutation or deployment is part of routine
implementation validation; those remain separately authorized operator actions.

## Acceptance criteria

| Criterion | One verification |
| --- | --- |
| A single checkout supplies installer, bootstrap and updater with preserved attribution. | Disposable packaging/installer test without a sibling repository. |
| Automatic installation defaults off, including an imported legacy enabled configuration, and checks alone never install. | Updater integration test with a successful candidate and zero activation calls. |
| Explicit toggle opt-in persists and installs eligible commits only through the shared safe transaction. | Cypress toggle journey with a disposable service, restart and fake updater effects. |
| Disabling prevents new automatic transactions without disabling checks or cancelling manual approvals. | Concurrent disable/start and queued-request integration suite. |
| Cancelling an automatic candidate prevents silent requeue; failed candidates remain quarantined. | Repeated-discovery test covering cancellation, restart, opt-in renewal and failed activation. |
| Only the exact trusted main commit with successful Verify evidence is offered. | Mocked GitHub eligibility suite covering wrong workflow/repository/SHA, pending, failure, missing evidence, divergence and rate limits. |
| Notice, changes, Later, confirmation and refresh behave correctly. | Cypress journey using a real disposable service and fake update discovery. |
| Approval is durable, idempotent and cannot retarget a newer commit. | Restart/concurrent-request test against private temporary updater state. |
| Non-transferable effects and uncertain ownership delay activation; unrelated cmux sessions and verified supported planners do not. | Orchestration/updater admission test racing launches, handoff, fencing and cancellation. |
| Successful update preserves the same planner runner PID, conversation, worktree and attempt without duplicate launch. | Disposable terminal-supervisor update rehearsal with recorded identities before/after. |
| Result submission survives maintenance/offline and lost-response boundaries exactly once without automatic approval. | Durable outbox crash/replay test with stable result id/bytes and revoked-authority rejection. |
| Failed candidate health restores SQLite and reconnects the same planner and credentials without lost results. | Fault-injection handoff rollback rehearsal spanning snapshot, restart, restore and outbox drain. |
| Retention protects live planner runtime dependencies across multiple releases. | Release-cleanup test with a planner originating more than three releases earlier and pending outbox evidence. |
| Legacy terminal protocol gaps remain visible and never trigger implicit termination or recovery. | Admission/UI regression with an old client fixture and zero signal/relaunch calls. |
| Failed activation and process interruption recover without false success. | Fault-injection transaction suite with exact-SHA health and compatible data restoration. |
| Legacy migration preserves private state and refuses competing owners. | Disposable two-store migration rehearsal with active-transaction refusal. |
| Update mutations enforce pairing, origin, schema and replay rules. | Backend security-route suite with fake updater effects. |
| Fresh install and legacy instructions describe the implemented behavior. | Documentation/entry-point review in the delivery report. |

Run root `npm run verify`, backend and UI coverage (both at least 90%), and relevant
local Cypress, incorporating updater tests into regular discovery. Report passed,
failed and unverified paths separately. Installed launchd, native cmux continuity,
real GitHub eligibility and live recovery remain explicit validation gaps until
separately authorized rehearsals establish them.

## Success measure

In the disposable end-to-end update journey, one eligible commit produces one
notice and exactly one healthy activation after explicit confirmation or persisted
toggle opt-in while a supported planner continues in the same terminal and its plan
is accepted exactly once after reconnect. Require zero activation without either
authorization, or while non-transferable effects or unknown ownership remain. Repeat
with default-off and with a failed candidate: discovery alone installs nothing, and
rollback preserves the same planner and its submitted result.

## Original inspection evidence (2026-09-13)

Inspected updater source commit: `c9557aa0859f60b21c42edf04d9dc4dcf7f20190`.

The separate updater currently discovers and immediately transacts in
`src/engine.mjs`; disabling it also disables discovery. Its configuration requires
two targets and its operator check command wakes that same automatic engine.
Companion currently exposes only updater status and a deployment health panel.
Therefore a button must not delegate to the existing check/enable commands as an
installation authorization mechanism. CI eligibility, durable approval and the
application admission fence need explicit implementation.
