# Mission Control product redesign

Date: 2026-09-15
Status: Approved for implementation by the user's “do it” after review of commit
`7c7e9b5`. The representative run and success target remain deferred by the user.

## Outcome

Make Companion a desktop-first, responsive control center for goals, agent teams,
parallel waves and delivery decisions. Replace the confusing goal navigation,
setup and execution supervision with the supplied Mission Control prototype's
visual direction and information hierarchy.

The updater, cmux engine and standalone sessions remain product foundations.
This is a product experience redesign, not a requirement to replace the durable
orchestration core. Reuse its ownership fencing, isolated worktrees, journal,
review evidence, safe publication and restart recovery.

Reference: user-supplied `cmux-companion-demo.html`, reviewed on 2026-09-15.
Its colors, typography, desktop layout and goal detail organization guide the
design. Its synthetic tasks, timings, spend, browser folder access and in-memory
execution are illustrative, not production behavior or performance evidence.

## Authority and relationship to existing specs

This contract records the user's redesign decisions from the September 15
conversation. Once reviewed, it supersedes earlier decisions only for primary
navigation/device priority, role composition, wave scheduling, human gates,
failure recovery, routing suggestions and retired product surfaces below.
The orchestration core design remains authoritative for execution safety and
exact-target evidence. Existing updater contracts remain in force.

Recommendations made concrete here (including 15-minute merge polling, the
navigation details and initial gates) remain subject to this draft's human review.
An implementation plan must follow that review and implement the reviewed spec.
Any subsequent spec correction must be committed before changing the plan.

## User journey

1. Set up development folders and favorite repositories on the Mac, then configure
   working CCS, Codex and Claude launch profiles. See validated readiness and
   available account usage without editing internal orchestration configuration.
2. Open Mission Control to see all goals, their current stage/wave, active workers,
   last meaningful activity and decisions needing attention. Filter and open a
   goal without losing the fleet context.
3. Create a goal with a title, detailed brief, links and optional files/images.
   Choose a repository; saved team defaults avoid mandatory per-role setup.
4. One visible cmux planner performs planning, architecture and design. Essential
   questions appear inside the goal. It proposes a versioned plan, acceptance
   criteria, checks, waves and model assignments with reasons.
5. Review and approve the combined design/plan and proposed team in one gate.
   Override suggested assignments before approval. Independent plan review is
   machine work, not a separate human approval step.
6. Watch independent tasks run concurrently inside the current wave. Inspect
   each task's visible cmux session, ownership, evidence and blockers. Later waves
   remain queued until earlier output has been accepted, integrated and verified.
7. On failure, new dispatches for that goal stop. Already running attempts may
   finish and retain their results; unrelated goals continue. Inspect the failure
   and explicitly launch an available recovery action.
8. Review the integrated outcome and evidence, then approve PR publication.
   Companion publishes one PR for the reviewed and verified commit.
9. Merge on GitHub. Companion passively observes waiting PRs and moves their goals
   to Complete after GitHub confirms merge. There is no Companion merge action.

## Information architecture and interaction

Primary destinations are Mission Control, Needs You, Sessions and Setup.
Goal detail exposes Overview, Waves & sessions, Team & models, Run report and
Activity, with next action and current state always easy to find. Execution limits
and approved policy are available within the goal without dominating its overview.
Workspace model defaults and capacity belong in Setup; goal-specific allocation
belongs in the goal. Do not reproduce the prototype's misleading workspace links
that silently operate on the last selected goal.

Desktop is primary. Responsive layouts must still support creating a goal,
reviewing a plan, inspecting wave status and recovering failures on a phone.
Choose reusable UI libraries where they improve consistency and accessibility;
no specific library is a product requirement. Do not require horizontal scrolling
to discover the next action or primary goal status on narrow screens.

Mission Control distinguishes Planning, Needs approval, In progress, Review,
Verification, Ready to publish, Waiting for merge and Complete. Failures/holds and
paused state are visible without erasing the stage where execution stopped.
Stage counts are not estimates of percentage effort or time remaining.

Needs You collects goal questions, approvals and manual recovery decisions.
Standalone sessions retain session listing, terminal inspection and deliberate
terminal input. Native CLI interactions remain possible in their cmux sessions.
The separate native-permission Inbox, prompt queues, local-app previews and
legacy notification product surfaces are retired. The notification settings and
background Web Push specified below form the new supported surface. Remove unused routes, jobs,
storage ownership and UI code, while retaining shared functionality still needed
by execution, session control, pairing or updates.

## Planning, attachments and roles

Planner and architect/designer are one agent and one approval gate. The goal saves
the chosen launch configuration and planning context across revisions; a dead
process is not required to stay alive. Replacement requires explicit recovery and
must retain the earlier attempt's history. Planning questions can be answered in
the goal without opening a terminal.

Persist the brief and attachments on the Mac, linked to the goal and available to
its authorized agents. Files/images are reference material, never executable
instructions or additional filesystem authority. Enforce documented type/size
limits, safe filenames, authenticated retrieval and safe rendering. Provide clear
errors for rejected uploads; implementation must specify and test the supported
formats and limits before release. Phone uploads must reach the Mac rather than
remain browser-only file handles.

Agent roles requiring judgment run visibly in cmux: combined planner/designer,
implementers, independent reviewers and any agent performing integration repair.
Deterministic Git operations, test processes, health probes, GitHub sync and PR
publication run in background adapters with inspectable status and logs.
Verifier and integrator responsibilities do not require idle agent terminals;
when judgment is required, launch a visible, scoped agent attempt.

## Waves, integration and recovery

The approved plan groups independent tasks into ordered waves and declares task
ownership, actual dependencies, acceptance and verification. Independence includes
shared contracts and resources, not just non-overlapping filenames. Concurrent
attempts each own isolated worktrees. Preserve exact-commit independent task review
and serialized integration. A next-wave barrier opens only after the prior wave's
required results and checks pass on its integrated output.

The planner should avoid unnecessarily broad barriers, but the first delivery
uses explicit waves rather than starting tasks across wave boundaries. Replanning
wave membership or changing approved scope requires a new approved revision.

Failures include failed execution, blocking review findings, verification failures
and integration conflicts. They place the goal on a durable dispatch hold; no
automatic execution repair/retry begins in this first delivery. Plan-review
revisions follow the bounded exception specified below. Existing active attempts
may finish, but cannot release the hold. Manual recovery identifies the failed
target and creates a new bounded attempt or explicitly resumes eligible work.
Unknown worker ownership must be reconciled before replacement. Abort revokes
authority and handles termination separately from ordinary pause/failure holds.

## Initial approval policy

Minimize human interaction while starting with these explicit boundaries:

- Approve the versioned combined design/plan, verification and suggested team.
- Reapprove material scope, contract or verification changes.
- Authorize recovery after a failure.
- Approve publication of the reviewed and verified goal commit as a PR.

Routine task dispatch, independent review, integration and checks proceed under
the approved contract. No separate architecture or routing acceptance gate exists.
Agents cannot relax checks, remove findings or expand authority to continue.
Later removal of gates is a future product decision supported by observed runs;
the prototype's toggle for bypassing revision approval is not included initially.

## Setup and routing

Support CCS, Codex and Claude launch integrations. User-friendly command/profile
configuration must resolve to validated supported adapters, not arbitrary shell
execution. Preserve pairing, same-origin checks, repository allow-lists, loopback
binding and argv-based calls. Registering a model name does not prove it works.

Use existing account-usage integrations for available capacity and display the
source/freshness. Unsupported, failed or stale readings are explicitly unknown,
not zero capacity. Do not invent dollar costs from subscription allowances.

Automatically propose role/task allocation using configured eligibility, role
suitability and available capacity. Include the reason and permit manual override.
The proposed team is approved with the plan. Workspace changes affect future
goals; started attempts retain their saved configuration. Changes to unstarted
assignments are explicit and recorded. Capacity changes may suggest alternatives
but never silently switch a running attempt or start automatic failure recovery.

## GitHub completion sync

PR publication enters Waiting for merge. The Mac service polls only goals in this
state, once every 15 minutes while awake and online. Browser tabs do not create
independent pollers. Persist the observed state and last-check time; a restart
checks overdue items without duplicating concurrent polls. Offline time introduces
delay and cannot be presented as proof that a PR is still open.

Use the saved repository/PR identity. Only a positive GitHub merged observation
moves a goal to Complete. A closed, unmerged PR is shown explicitly and never
counts as completion. Authentication/network errors preserve the prior state and
surface sync status; retry on the normal cadence without holding up other goals.
Remove completed items from the waiting poll set. Never merge or deploy as an
effect of polling. GitHub merge is exclusively an external user action.

## Notification settings and background push — approved

### Outcome and user journey

Setup gains a Notifications category at `/settings#notifications`. A paired user
can keep existing in-app update notices, enable background notifications for this
browser or installed PWA, choose event types, send a test notification, and disable
this device's subscription. Background delivery is opt-in and off by default.
In-app update banners remain enabled by default and independently controllable.

The page shows browser support, OS permission, subscription state, last delivery
attempt and sanitized errors as separate facts. Permission is requested only from
an explicit "Enable background notifications" gesture. Permission granted alone
must not be presented as a successfully registered subscription. Failed server
registration is retryable; a newly created orphan browser subscription is cleaned
up or its cleanup failure is shown. No automatic permission prompt on page load.

Enabled event choices default to: Needs your attention (questions, approval or
recovery required), Goal complete (confirmed merged goal), and Updates (eligible
update available, installation succeeded or failed). Users can disable each type.
Do not send one notification per task/token or treat a PR opened as a completed
goal. A test notification uses the real configured delivery path with harmless
fixed text and reports "Accepted by push service" rather than "Delivered" unless
receipt evidence exists. It never creates an update or workflow command.

"Hide project and goal names" defaults to on. Discreet payloads use fixed copy
such as "Companion needs your attention" without goal descriptions, filenames,
repository names, terminal output, credentials, question text or failure details.
Turning it off may include a bounded, sanitized goal title; full content remains
inside the paired app. The setting explains both lock-screen exposure and transit
through the browser's push provider. It applies to future deliveries only.

Preferences and subscriptions are scoped to this browser/PWA subscription, not a
unique human identity: pairing still uses the installation's shared trust model.
In-app preference changes persist and synchronize between same-origin tabs; failed
storage writes cannot claim success. Other subscribed devices retain their choices.
"Disable background notifications on this device" revokes server delivery and
unsubscribes the browser, cancelling pending sends. If either step fails, show the
remaining state and a retry. Logout attempts the same cleanup without preventing
logout; unsuccessful revocation must not be falsely reported as completed. Offer
an explicitly confirmed "Revoke all push subscriptions on this Mac" recovery
control because copied subscriptions and devices lost after pairing cannot be
revoked by clearing this browser's cookie alone.

### Background behavior and platform limits

Use standards-based Web Push with a service worker, not a browser-tab polling
loop. Notifications can arrive when the app page is closed, subject to browser/OS
background delivery support. The Mac service must be running, awake and online;
a sleeping/offline Mac cannot originate a push. OS settings, force-quit behavior,
Focus modes and push-service availability may delay or suppress display. Do not
promise guaranteed or instantaneous delivery.

Remote phone pairing/navigation remains private through Tailscale and HTTPS;
no public inbound server or cloud relay is introduced. Sending push requires
outbound HTTPS to the browser vendor's push service. A browser may receive the
push without tailnet access, but opening private Companion content requires
Tailscale and valid pairing. Push-service operators see endpoint, sender and
traffic metadata; Web Push encrypts the payload, while the receiving browser/OS
can display its contents. Generic payloads reduce disclosure rather than making
this an entirely tailnet-only channel.

For iPhone/iPad, explain that supported iOS/iPadOS 16.4+ requires adding Companion
to the Home Screen and enabling notifications from that installed app. Desktop
support is feature-detected and subject to OS/browser permission. Unsupported
browsers retain in-app notices with an honest explanation. OS denial links to
browser/OS instructions; repeatedly toggling cannot bypass a denied permission.

A notification click focuses an existing same-origin app window or opens a
validated same-origin Goals/Needs You/Updates destination. Payload URLs cannot
open arbitrary origins or execute actions. If unpaired, show pairing; if offline,
show the normal offline shell. Viewing the latest authoritative projection, not
the notification's stale text, determines which actions are currently available.
No approve, retry, publish, merge, terminal-input or install action is available
from a notification button.

### Delivery, persistence and security boundaries

The Mac creates one persistent private VAPID keypair per installation, independent
of release directories. Keys never appear in logs, APIs, reports or browser
storage; only the public application-server key is exposed. Setup documents the
operator's valid VAPID contact and outbound providers without sending mail. A key
rotation is explicit and requires re-subscription; restarting or self-updating
must preserve the key and existing subscriptions.

Pairing and same-origin protections apply to subscription, preference, test and
revocation APIs. Store subscription endpoints/auth material as secrets in a
private notification store. Use unguessable per-subscription management proof;
responses for one browser do not disclose other devices' endpoints or keys.
Validate payload shape/length, HTTPS endpoints, public destination addresses,
provider host/path policy and subscription public-key/auth lengths. Do not turn
subscription registration into arbitrary outbound HTTP: use a narrow documented
set of supported vendor endpoints, no redirects, public-address validation at
connection time, bounded requests and tests for loopback, tailnet, private/link-local
addresses, malicious host suffixes and DNS rebinding. Apply request/subscription
limits and a rate limit to test notifications. Never log endpoints, key material
or raw push-provider errors.

Consume committed orchestration journal events through the existing notification
consumer boundary, and eligible updater transitions through one Mac-side observer.
Derive notification categories from authoritative workflow/updater state, without
adding notification authority to scheduler commands. Register new subscriptions
from their enrollment point; enabling notifications does not replay old history.

Write an idempotent durable outbox entry before acknowledging a journal event.
Dedupe by installation, source event/milestone and subscription; updater candidate
notifications use the exact candidate SHA and update result uses the request ID.
Replaying an event or polling the same status cannot enqueue duplicates. Only one
owned sender claims an entry at a time, with leases and bounded attempt timeouts.
Delivery cannot block command acceptance, worker admission, service startup or
shutdown. Recheck revocation/preferences and whether an attention/update notice
is still relevant immediately before sending.

Expire queued attention/update-candidate notifications after one hour, and goal
completion/update-result notices after 24 hours. Retry transient failures with
bounded backoff and attempt limits, respecting bounded Retry-After; discard stale
or resolved notices. Remove subscriptions on provider 404/410. Other permanent
errors surface sanitized delivery status without an endless retry loop. Duplicate
OS display after an ambiguous network/process failure cannot be absolutely
excluded; stable notification tags and durable state reduce duplicates, and this
limit is documented. Clearing a preference does not retract already displayed
notifications or notifications already accepted by a vendor.

Retain delivery metadata, not private payload bodies, for at most seven days and
bound the store size. Keep keys/subscriptions/outbox outside versioned release
paths. Define the notification schema and updater compatibility/backup behavior
explicitly before implementation; a rollback cannot silently reset identities,
replay stale notifications or damage core workflow state. Old versions without
push may leave the private additive store inert; downgrade safety must be tested.
Opt-in must not alter updater automatic-installation policy or mandatory in-app
errors, recovery messages and approval questions.

### Non-goals

Email/SMS, Slack/Discord integration, a hosted relay, push-driven workflow actions,
quiet hours, custom sounds, a notification inbox, guaranteed delivery and restoration
of retired native-permission/legacy notification products are outside this change.
OS Focus/notification settings control platform sound and quiet periods.
No installed user device or production push subscription is exercised by routine
tests. Real-device delivery is a separately identified validation step.

### Acceptance criteria

| Criterion | Primary verification |
| --- | --- |
| Notifications is discoverable in Setup on desktop/phone; in-app preferences persist with accurate save failures. | Responsive Cypress settings journey. |
| Permission is requested only on explicit opt-in; denied/unsupported/enrollment-failed states are accurate. | UI permission/subscription lifecycle regression. |
| Per-device event/privacy preferences and disable/logout/revoke-all cleanup behave as described. | Authenticated API lifecycle regression with two independent device subscriptions. |
| Push settings/test/revoke endpoints preserve auth/origin rules and prevent arbitrary/private destination requests. | Backend adversarial API/transport regression with fake DNS and transport. |
| Discreet payloads omit project/private content; optional titles are bounded and test messages harmless. | Payload allowlist regression covering workflow/error/credential-like fixture text. |
| Event classes map to current questions/approval/recovery, confirmed completion and exact updater transitions. | Real-service fixture integration with fake push adapter and authoritative projections. |
| Restart, journal replay, enrollment baseline, leases, revocation and terminal retry outcomes preserve bounded delivery. | Fake-clock outbox crash/replay regression. |
| Service-worker push displays safely and click targets are same-origin navigation only, with the page closed. | Service-worker event harness with closed-client and hostile-payload cases. |
| A subscribed device survives update/restart, and rollback preserves keys/state without replay or core-data damage. | Disposable updater compatibility/rollback integration test. |
| Offline/OS/provider limitations are accurately explained and a real push reaches an enrolled background device. | Explicitly scoped real-device smoke test, separately recorded from fake browser tests. |

Success measure: on one supported desktop browser and one iOS Home Screen PWA,
a test push and a Needs your attention event each display after the app page closes,
and tapping opens the correct paired private destination. Record actual delivery
latency and any missed/duplicate deliveries; fake tests do not satisfy this measure.

Run `npm run verify`, `npm run test:mac` and relevant local Cypress journeys before
reviewing implementation. Background OS delivery cannot be established by Cypress
mocks alone; keep the real-device success measure explicitly unverified until run.

The user selected background push and reviewed committed spec `075ed6c`, then
approved both designs on 2026-09-15 ("aboth agreed"). Implementation may proceed
under this contract; real-device delivery remains separately recorded evidence.

## Updater, data and cleanup boundaries

Keep the separately running bundled updater, exact eligible-commit controls,
idle detection, explicit installation policy and compatible rollback/recovery.
Expose its controls and version status in redesigned Setup. Waiting for GitHub
merge alone is not active agent execution; actual owned workers and unsettled
operations must still participate in update safety checks.

The user reports no active work and permits a fresh goal store: no migration of
goal history is required. This is not permission to delete arbitrary databases,
repositories, worktrees, pairing, credentials or updater state. Any actual reset
must identify the disposable goal data and prove no owned work remains first.
Routine development uses disposable fixtures, not installed state.

Inventory retired surfaces and their callers before removal. Delete unreachable
code, obsolete tests and documentation only with replacement coverage for retained
behavior. Storage changes must preserve updater compatibility checks and recovery;
a fresh goal store does not justify weakening rollback protections.

## Non-goals

Cloud hosting, multiple Mac coordination, a generic provider/plugin framework,
arbitrary shell commands, automatic merge/deploy, automatic failure repair,
cross-wave scheduling, exact subscription-to-dollar accounting and retaining
legacy goal history are outside this delivery. No installed-service reset or
release is authorized merely by accepting this spec.

## Acceptance criteria

Each criterion has one primary verification. Integration tests use disposable
repositories and fake external adapters unless separately authorized as live.

| Criterion | Primary verification |
| --- | --- |
| Desktop fleet navigation exposes goals, stage/wave, workers and next decisions; phone layout retains primary actions. | Cypress responsive fleet-to-goal journey. |
| Setup manages projects/favorites, supported launch profiles, readiness and account usage with explicit unknown readings. | Cypress setup journey with capability/usage fixtures. |
| Brief, links and supported files/images persist and reach only authorized goal attempts. | Backend attachment lifecycle/security integration test. |
| One planner/designer produces a reviewed contract and suggested team approved through one gate. | Real-service Cypress planning/approval journey. |
| Independent tasks overlap inside a wave; later waves wait for verified integrated output. | Backend wave-admission integration test with recorded launch order. |
| Judgment agents use visible cmux adapters; deterministic operations expose background logs/status. | Adapter contract integration test with fake cmux/process boundaries. |
| A failure holds new goal dispatch, retains other running results and allows only explicit recovery; unrelated goals continue. | Backend multi-goal failure/recovery integration test. |
| Routing reasons/overrides are recorded and cannot silently change started attempts. | Backend allocation snapshot integration test. |
| Exact reviewed/verified evidence and human publication approval precede one PR. | Real-service Cypress publication journey. |
| Only waiting PRs poll at the chosen cadence; confirmed merge completes them; errors/closed-unmerged PRs do not. | Fake-clock GitHub sync integration test including restart. |
| Standalone session inspection/input remains usable and retired destinations/routes are absent. | Cypress retained-session and retired-navigation regression journey. |
| Updater controls, busy-work safety and compatible recovery survive the redesign. | Existing updater regression suite extended for the new workflow states. |
| Refresh/restart preserves goals, decisions, holds and attempt identities without duplicate execution. | Backend restart/reconciliation integration test. |

Run repository-required `npm run verify` and relevant `npm run test:e2e:local`
for implementation. Preserve backend/UI line coverage requirements. Native cmux,
provider accounts and installed updater behavior remain separately authorized live
validation; fake adapters do not establish those live paths.

## Success measure and review gate

One proposed measure: human interventions per successfully merged representative
goal, reported alongside failures so unsuccessful runs are not hidden. The user
explicitly deferred selection of the representative goal and target until the
design is ready; both remain pending human review, not assumed release success.

The user reviewed the committed draft and authorized implementation. Choose the
representative run and success target with the user when the implementation is
ready for evaluation; their deferral does not block implementation or replace
the acceptance criteria above.


## Automatic review repair and optional plan review — 2026-09-15

Outcome: blocking review findings return automatically to the responsible planner
or repair agent. The user approved this behavior and clarified that Settings must
allow skipping plan review for simple goals, not disabling repair of reviews.

User journey: Settings → Agents has “Review plans before approval”, enabled by
default. Off skips new initial plan reviews; the user still explicitly approves
the exact plan and verification commands before implementation. The setting is
live for unapproved plans and never cancels an already-running review. Existing
blocking plan findings must still be repaired and re-reviewed even if the setting
is subsequently disabled. Task and final integration review remain mandatory.

Every completed rejecting review automatically initiates bounded repair after
workers and pending results settle. Plan rejection requests a fresh planner
revision with the prior contract and recorded findings, then a fresh independent
review. At most two automatic plan revisions run per manual planning cycle.
Task/final review rejection uses existing repair counters, limits and independent
re-review. Automation never increases any repair budget. Manual Request revision
resets the plan repair budget. An accepted plan waits for user approval.

Execution/check failures, unknown ownership, unrelated holds and exhausted budgets
remain on hold for human intervention. If the planner needs a scope or requirements
decision it uses the existing clarification flow and pauses. Goal abort, repository
allow-lists and service suspension remain authoritative. Existing eligible review
holds can progress under the same bounds after deployment; tests use disposable
state only, never installed goals.

Non-goals: automatic user approval, execution/check failure retry, changing scope,
publication, merge/deploy, or skipping task/final review.

Acceptance criteria and verification:
- Only current rejected reviews with solely matching review holds and settled
  workers/results auto-repair. Verify domain/scheduler rejection and stale tests.
- Two plan revisions maximum; existing task/final limits are never increased.
  Budgets survive restart and duplicate ticks. Verify persisted lifecycle tests.
- Prior plans/findings reach the repair worker; clarification pauses dispatch.
  Verify prompt-context and clarification tests.
- The plan-review toggle persists and applies live; disabling cannot bypass an
  active review's findings, task review or final review. Verify settings/API tests.
- Users see repair progress/exhaustion, and still approve the final plan. Verify
  UI tests and a disposable-service Cypress review/approval journey.

Success measure: ordinary review rejections reach a fresh review without manual
feedback copying within existing budgets, and no implementer starts without the
user approving the exact final plan.
