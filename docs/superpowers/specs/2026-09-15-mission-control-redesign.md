# Mission Control product redesign

Date: 2026-09-15
Status: Draft delivery contract for human review. No implementation plan yet.

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
notification product surfaces are retired. Remove their unused routes, jobs,
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
automatic repair/retry begins in this first delivery. Existing active attempts
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

Human review of this committed draft must precede the implementation plan.
Review should confirm the concrete initial gates and navigation, and resolve the
success target before this contract is considered fully approved for delivery.
