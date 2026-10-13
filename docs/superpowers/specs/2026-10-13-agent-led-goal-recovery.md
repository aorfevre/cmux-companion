# Agent-led goal recovery and execution decisions

Date: 2026-10-13
Status: Approved by the user's “approved” after review request for commit `782785a7`.
Owner: the implementing agent, responsible for domain, service, adapters, UI,
verification and disposable-resource cleanup.

## Outcome

The user approves the intended work, then agents own ordinary execution decisions,
diagnosis, retries and repairs until a verified result is ready for publication.
An agent stopping, a review requesting a code fix, or a check failing must not
normally require the user to press Recover. A human is needed when authority or
essential information is missing, or when bounded autonomous work cannot progress.

This extends the approved CCS Goals contract's routine recovery requirement and
supersedes its narrower retry rules, the Mission Control manual-failure policy,
and the Goals decision bar's unconditional recovery presentation for goals using
this policy. Other product contracts remain authoritative. The policy does not
authorize its own plan, publication, merge, deployment or external account changes.

## Evidence and current gap

- `domain/recovery.mjs` creates a goal-wide hold for failed, cancelled or uncertain
  attempts. Recovery is a user command, apart from separate review/check paths.
- `domain/launch-recovery.mjs` automatically replaces a stopped launch only for
  four pre-process resource errors, once. Normal stopped agents do not qualify.
- `domain/review-repairs.mjs` rejects mixed holds and limits automatic plan
  revision to two rounds; the scheduler cannot diagnose an exhausted review loop.
- `reconciler.mjs` already drains durable results before treating a worker as
  stopped. This ownership/result boundary must be preserved.
- `domain/decision-view.mjs` collapses attempt causes into “stopped before it
  finished.” It does not explain the underlying failure or an autonomous strategy.

The screenshot establishes which roles stopped, not why. No installed goal
journal or live provider was inspected to infer a specific runtime cause.

## User journey

1. Start a conversational goal and approve the proposed outcome, constraints,
   acceptance criteria, checks and initial team through the existing proposal flow.
2. The supervisor selects implementation tactics, task ordering and repair
   strategies inside those approved bounds. Ordinary technical choices are
   recorded as decisions rather than turned into questions to the user.
3. If an agent stops or work fails, see “Diagnosing failure,” “Retrying reviewer,”
   or “Repairing failed checks,” with the cause and attempt budget in details.
   The goal remains Active while it can act autonomously.
4. The service settles results and proves worker ownership before any replacement.
   The supervisor receives saved failure evidence and can retry, repair, or revise
   execution tactics using scoped service commands. A stopped supervisor itself
   is recoverable by service policy without needing that supervisor to act first.
5. Review feedback and approved check failures return to agents automatically.
   When a simple retry fails, agents diagnose and change strategy within the
   remaining budget instead of asking the user to click the same button again.
6. A real blocker appears in Needs you with the exact cause, what agents tried,
   and one specific decision or action. The user can pause or abort at any time.
7. Existing goals keep their policy snapshot. Their detail view offers one explicit
   adoption action for this recovery policy, including held goals. Adoption retains
   evidence, current approval and budgets already spent; it neither clears a hold
   blindly nor expands approved scope. Unconfigured legacy goals explain the
   supervisor setup needed before adoption.
8. A verified result still waits for human publication approval. Reloads and service
   restarts retain decisions, delays, budgets, queued steering and ownership.

## Recovery policy and agent authority

Persist a versioned recovery policy on new conversational goals and on explicit
adoption. Existing absent-policy goals retain existing behavior. The policy is
service-owned; agent output proposes actions and cannot mutate policy or budgets.

Classify failures from structured adapter/service evidence, never by matching
arbitrary provider prose. Preserve a bounded sanitized cause and evidence reference.

| Evidence | Autonomous response |
| --- | --- |
| Proven stopped transient launch/process failure | Bounded delayed replacement using the same authorized profile. |
| Proven stopped worker without an accepted result | Drain pending submissions, retain worktree evidence, then bounded diagnosis and replacement; do not treat exit as successful delivery. |
| Invalid result or supervisor protocol failure | Give the next attempt the validation error and durable context; consume the same recovery budget. |
| Supervisor turn timeout | Reconcile the process tree first; only a confirmed stop permits a new turn or replacement. |
| Review findings or approved check failures | Assign repair with findings/output, then repeat independent review and exact-commit checks. |
| Integration conflict with known owned Git state | Assign scoped conflict repair and reverify the combined result. |
| Unknown worker or external effect | Reconcile the existing operation; no duplicate launch, push or publication. |
| Authentication, permissions, missing executable or unavailable required service | Present the concrete setup action; do not spend retries or alter credentials/configuration. |
| Essential unanswered requirement or change to authorized outcome/checks/permissions | Ask a focused question or present a revised proposal for approval. |

Mixed holds are evaluated as a whole: settled repairable reasons can form one
recovery episode; any unresolved ownership, pending result or authority blocker
prevents replacement dispatch. Already-running siblings may finish and their
accepted results are retained. A transient observation failure stays in
reconciliation; elapsed time alone never proves a process stopped.

A recovery episode is keyed to the logical failing work, its approved revision
and its input evidence, not to a fresh attempt ID. It survives worker replacement,
service restart and supervisor restart. Defaults are at most three autonomous
recovery actions per episode and twelve per goal. Existing automatic retries and
repair rounds count toward these limits rather than creating independent budgets.
For adopted goals, derive prior spending from durable attempt/recovery/review
evidence; ambiguous history requires an explicit budget decision, not zero spend.

Retry delays are 5, 15 and 45 seconds, persisted as due times without holding a
capacity slot. Repair work is admitted normally once its prerequisite evidence
settles. Two consecutive failures with the same normalized cause, input commit,
check/review evidence and strategy stop that strategy. Before another action, a
supervisor must save a concrete changed approach within scope; descriptive prose
alone cannot reset counters or manufacture progress. Exhaustion requests a budget
or scope decision with evidence. No agent can extend its own budget.

Routine decisions include task decomposition inside approved owned areas,
implementation choices, repair assignment, and whether to retry or repair.
Outcome, owned-area, check-definition, acceptance-criteria, team authority and
permission expansion still require a revised proposal. Independent reviewers
remain independent. Rejected plans can be repaired within the unified budget
before approval; agents cannot approve the revised plan themselves.

## Boundaries and presentation

- Domain: validated recovery proposals and system-owned admission rules enforce
  evidence, budgets, current revision, pause/abort and approval invariants.
- Service/scheduler: reconcile first, persist one decision and intent atomically,
  admit due work through normal capacity/fairness, and avoid idle model polling.
- Storage: retain policy, failure classification, episode identity, decisions,
  consumed budget and due time in the existing SQLite authority. Crash replay
  cannot grant another action or reset a budget.
- Adapters: expose structured stopped/unknown evidence and sanitized diagnostics;
  resume supported native sessions or reconstruct from durable context after a
  confirmed stop. Preserve prior worktrees; no force cleanup or provider fallback.
- API: pair/same-origin/read-only and expected-version checks apply to adoption
  and user budget decisions. Agent tools cannot invoke user-only approval actions.
- UI: server projections distinguish working recovery, reconciliation and human
  blockers. Needs you contains only an actual user action. Technical details show
  cause, decision, remaining budget and retained evidence. Automatic recovery does
  not issue repeated human-attention notifications.
- External effects: existing publication and review-fix contracts remain in force;
  this policy does not replay uncertain external writes or automatically start
  GitHub review-comment rounds. Installed services are not used for routine tests.

## Non-goals

- Removing human plan/publication approval, merging or deploying automatically.
- Changing provider accounts, credentials, executable checks or granted permissions.
- Unlimited retries, concealing persistent failures, or calling agent prose proof.
- Silently migrating active goals, discarding user edits, or clearing existing holds
  without evaluating their evidence.
- Replacing the orchestration engine or rewriting unrelated monitoring/settings UI.

## Acceptance criteria

Each row has one verification artifact covering its branches.

| ID | Observable outcome | Verification |
| --- | --- | --- |
| A1 | Stopped reviewer, implementer and supervisor failures recover without a user click; accepted sibling results survive. | Real-service recovery integration matrix with disposable Git and scripted adapters. |
| A2 | Mixed execution/review/check failures are diagnosed and repaired within scope, with independent exact-head validation before publication readiness. | Real-Git mixed-failure journey test. |
| A3 | Supervisor makes routine technical decisions, revises rejected plans and changes failed strategies within budget; scope/authority changes still need approval. | Domain command authority and strategy regression matrix. |
| A4 | Late results, unknown workers, observation timeouts and uncertain external effects never launch duplicate work. | Process-crash fault-injection report covering recovery reservation and result settlement. |
| A5 | Three-per-episode/twelve-per-goal limits, identical-failure stop and persisted delay survive attempts and restarts. | Fake-clock persistent-journal budget integration test. |
| A6 | Missing authorization, setup failures and exhausted budgets show a specific cause, attempted remedies and actionable next step. | Server decision projection tests for every failure classification. |
| A7 | Active autonomous recovery is visible and does not request a recovery click; true blockers appear in Needs you at desktop and mobile widths. | Real-service Cypress recovery journey with inspected 1440px/390px screenshots. |
| A8 | New goals use the policy; existing goals retain their contract until explicit adoption, with prior spending preserved. | Mixed-version storage/API adoption regression. |
| A9 | Pause/abort, queued user steering, read-only, pairing and stale-command rejection hold throughout recovery. | API/service recovery boundary regression matrix. |
| A10 | Plan/publication approvals remain human-only and publication cannot bypass exact-head review/checks. | Publication authority regression suite. |
| A11 | Selected launcher/session continuity, stopped-process evidence and recovery work with actual native agents. | Separately authorized sanitized native trial report, distinct from scripted evidence. |

## Success measure

In a fixed five-case suite (stopped reviewer, stopped supervisor plus implementer,
rejected plan, failed check, integration conflict), require zero human recovery
clicks from the authorized starting state to a verified result or initial plan
approval. Record total agent actions and time, every human intervention and the
failure cause. Authentication, unknown-ownership and exhausted-budget companion
cases must request the correct action without duplicate work. Report scripted and
native outcomes separately; scripted success does not establish native reliability.

## Delivery and review

Commit this specification and obtain one human review before committing the
implementation plan, as required by AGENTS.md. Implement and review through a draft
PR targeting main, with traceable acceptance evidence. Run `npm run verify` and
`npm run test:e2e:local`; record failed and unverified paths without reducing
coverage. Native trials need separate explicit authorization. No merge, install,
update or deployment is implied by this work.
