# Unified discovery and duplication due diligence

Baseline: main `e7002a4`. Reviewed 2026-09-08. Owner: this change's implementing agent.
This is a current workflow/duplication audit, not a certification that every line is
defect-free. The [earlier full review](README.md) remains a historical snapshot;
its 48 findings are not represented here as newly reproduced findings.

## Observable outcome and boundaries

| Entry | Canonical owner | Result |
| --- | --- | --- |
| New goal / project development review | GoalSessionService.start | One visible native conversation |
| POST goal-sessions / compatibility POST worktree-plans | Same handler and schema | Same model, images, spec options and ownership rules |
| GitHub board / issue picker | Shared startIssueGoal callback and GitHubIssueSync.start | Same interactive goal; existing ownership deduplicated |
| Continue discovery / compatibility run | GoalSessionService.continueDiscovery | Stops old unlaunched discovery, creates one deterministic successor |
| Native active goal | Its recorded workspace/session | Returns the existing conversation |
| Old round answers, feedback, discussion, topic analysis and launch | HTTP 410 | Cannot spawn another planner |
| Already launched historical delivery | Existing task recovery/integration | Preserves work and saved evidence; does not restart discovery |

Discovery, questions, proposal publication and implementation now belong to the
same native conversation. Companion remains the approval authority. An exit or
missing prose is not a discovery blocker or proof of delivery.

Migration resolves repository authorization before stopping, refuses launched
task/worktree evidence, checks failed session closures and persists a historical
context snapshot in the plan creation transaction. Deterministic successor IDs
prevent a lost response from producing another worktree. Original records remain
readable. Saved history is explicitly not an approved implementation instruction.
GitHub issue ownership transfers using the existing store methods; a failed start
can leave issues available for explicit retry, never silently implemented.

The public form removes unsupported automated reviewer controls. Four non-diagram
spec requests remain enabled and all six remain editable. Hidden model roles stay
in stored settings for historical compatibility.

## Duplication investigation

Reviewed application, server and script sources with repository-wide call-site
searches, deletion/caller checks, and TypeScript AST function extraction.
A candidate detector normalized identifier names and compared six-token shingles
using Jaccard similarity, minimum 60 tokens, minimum relative size 0.65 and score
above 0.65. The initial broad scan contained 116 files and 1,125 functions.
The scan after the first consolidations contained 120 files and 1,075 functions.
Manual inspection classified candidates before extraction; token similarity alone
does not establish equivalent behavior. These scans omit small fragments,
configuration, styles and generated code. The initial scans excluded same-file
pairs; a subsequent pass included them while excluding nested-function overlap. Tests and documentation
were traced for the changed behavior, not subjected to a fresh exhaustive security
review. Counts are observations of those intermediate snapshots. The final reproducible
scan covers 122 source files and 1,072 eligible functions, returning 17 candidate
pairs across and within files. Run `node scripts/audit-duplication.mjs`; the
[captured candidates](unified-discovery-candidates.json) record the final review
locations. This deliberately reports candidates instead of failing CI on a
similarity score.

Confirmed duplication removed:

| Responsibility | Single implementation |
| --- | --- |
| Interactive goal creation | GoalSessionService + shared creation handler |
| GitHub planning | GitHubIssueSync; picker only selects issue data |
| Tolerant stored spec defaults | spec-options.safeSpecOptions |
| Goal health counters and worst-task reason | goal-health-summary |
| Repository favorites/archive membership | RepositorySet, with default-path wrappers |
| Private synchronous atomic JSON writes | private-json-state.writePrivateJson |
| Aged image/brief cleanup | temporary-file-cleanup.cleanupOldFiles |
| Session status interpretation | session-state |
| Relative timestamps | app/relative-time; ISO input adapter |
| Brief/watchdog text truncation | text-summary.oneLine |
| Immutable commit timestamp reads/cache | commit-time.readCommitTime |
| Editable image attachment strip and terminal paste | AttachmentStrip and one paste handler |
| Archive/favorite UI and server mutations | Shared repository-flag operations |

The headless discovery methods and the GitHub topic planner are physically removed,
not hidden behind a feature flag. Historical delivery still needs the legacy
controller, saved task prompt/parser utilities, retry and integration contracts.
Renaming or removing those compatibility records would risk unfinished deliveries.

## Similarities deliberately retained

- Image prompt framing shares attachment paths but serves different contracts:
  terminal user messages versus historical task briefs. Their surrounding
  instructions and optionality differ.
- Account-usage snapshots and cmux inventory both deduplicate in-flight reads,
  but have different TTL, error/fallback and ownership semantics.
- Issue-sync and watchdog scheduling share interval mechanics, but differ in
  enablement, initial execution, busy ownership and side effects. A generic
  scheduler would conceal these policies.
- Asynchronous worktree-operation journal writes are separate from synchronous
  private state writes: their awaited lock/journal lifecycle must remain explicit.
- Agent capacity and task assignment already use capacity-policy provider scoring.
  The UI's best observed percentage and assignment's eligible headroom are
  different measurements; merging them would change decisions.
- Explicit Claude/Codex adapters, request validation versus stored-record recovery,
  and test fixtures are not interchangeable simply because their shapes match.

The same-file review additionally checked:
- Clean restart versus fresh-branch retry: the first deletes the old branch/worktree;
  the second deliberately preserves it. Their acquisition already uses
  acquireTaskWorktree, but failure cleanup and preconditions stay explicit.
- Local/mobile cmux matching: only the local lookup allows directory-only fallback.
  Combining these without preserving that difference can associate the wrong session.
- Proposal approval, feedback, answer and recovery handlers: request lifecycle
  scaffolding repeats, but revision/generation guards, mutation barriers and payloads
  differ. They all use the same API/store authority; a generalized mutation helper
  is deferred rather than obscuring those approval checks.
- Store lifecycle mutations: similar SQL has different transition predicates
  (active input versus planning state, ready versus pending, reserved versus
  acquired identity). Generic setters would weaken the state-machine contract.
- Two session-row render callbacks and two preview-notification callbacks remain
  small presentation overlaps. They are recorded candidates, not removed in this
  change: the rows expose different actions/context and notifications have distinct
  event identity/deduplication tags.

There is no claim of “zero duplicates.” Small overlaps and domain-specific
repetition can remain. Future contributions should extend the owners above
instead of creating another planner or copying their policies.

## Operational finding

The Worktrees failure was traced read-only to a persisted cleanup lock owned by
dead PID 11308, dated 2026-09-05. Lock contention now returns an actionable HTTP
409 rather than a generic 500. The lock itself was not removed: automatic cleanup
and pruning are enabled in the installed configuration, so removing it could
trigger deletion. No installed goals, worktrees or live agents were exercised.

## Verification and test ownership

Removed tests exercised retired headless rounds, reviewer rejection, topic grouping,
legacy launch HTTP behavior and old UI controls. These are replaced with native
creation-alias, retired-route refusal, migration/context, ownership/idempotence,
direct continuation and proposal approval coverage. Historical delivery tests use
an explicit saved-plan fixture instead of spawning the removed discovery engine;
single-task, multi-task, combined PR, issue-link and terminal-refusal assertions
remain. Test count decreases are expected and are not described as unchanged coverage.

A structural regression forbids headless discovery methods on the historical
delivery controller. Migration tests check old context, stop failure, existing
native ownership and prepared/started task boundaries. Browser scenarios exercise
mobile/desktop continuation and canonical request payloads.

Final source verification:
- `npm run verify`: 924 backend tests and 124 UI tests passed; lint,
  both TypeScript projects and production build passed.
- The added audit script ran successfully; lint/typecheck were rerun after its
  addition. No new runtime dependency or CI failure threshold was introduced.
- `CMUX_COMPANION_CYPRESS_BROWSER=chrome npm run test:e2e:local`: all
  109 tests across 21 specs passed.
- Inspected 390px and 1280px continuation screenshots: both navigate to the
  recorded successor workspace and show the saved-context notice. Fixtures
  deliberately have no terminal replay; this is not live CLI validation.

Interventions: first Cypress run had six obsolete notice/model/background-field
expectations. A concurrent-edit run was invalidated by hot reload and later
Electron closed unexpectedly; no coverage was dropped. Switched to the documented
Chrome fallback. Its first complete run passed 108/109; the remaining board fixture
returned a legacy response without the new workspace identity, so it was corrected
to verify the real “cmux inventory not yet available” notice and retained saved
goal. Initial lint caught an import before the client directive and an unused
fixture counter; both were corrected. Removing the duplicated image renderer
also made its lint suppression unnecessary, which was removed.

Not run: installed-product/live-agent checks, real GitHub review posting,
automatic cleanup, migration of installed goals, merge or deployment. These
require live authorization and are not implied by mocked verification.
