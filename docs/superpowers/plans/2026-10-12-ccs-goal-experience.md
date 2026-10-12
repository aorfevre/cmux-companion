# CCS Goals implementation plan

Approved contract: [CCS-based conversational Goals](../specs/2026-10-12-ccs-goal-experience.md).
Human review: user approved spec `aa8b19c4` with “implement the goal. I approve
it”; approval recorded in `8697875c` before this plan commit.

One owner implements and verifies the whole journey in `feat/ccs-goal-experience`.
Keep existing goals on their original execution contract. New experience state
is additive and explicitly versioned. Do not create a second journal owner or
replace the existing Git/publication safety boundaries.

## 1. Conversation and command authority

- Add persisted, versioned conversation messages, questions, decisions, delivery
  receipts and supervisor state to new-experience goals.
- Add idempotent user message/pause/resume commands and scoped supervisor tools.
- Preserve native/logical conversation when asking questions; normal questions
  must not use the legacy terminate-and-replace planner path.
- Keep revision approval, scope changes and publication authority server-owned.
- Validate with domain, bridge and restart tests (A3–A5, A10–A13, A15).

## 2. CCS supervisor and launch continuity

- Build on the inspected `xclaude -> ccs claude` and `xcodex -> ccsxp` paths.
- Expose launcher normalization and managed-policy differences honestly in setup.
- Integrate structured progress, queued input, persisted conversation identity,
  resume and observed termination through the existing native supervisors.
- Keep cmux workspaces visible; give waiting supervisors a non-starving capacity
  policy and event-triggered wakeups, without token-consuming idle turns.
- Verify with disposable native transport fixtures; record native compatibility
  separately for each actual launcher (A2–A4, A8, A10–A12).

## 3. Execution, checks and bounded repair

- Offer a simple single-implementer proposal by default, retaining graph
  validation and explicit ownership for genuinely independent parallel work.
- Add a scoped approved-check tool for the active worker checkout, dependency
  preparation, bounded output and persisted receipts.
- Feed failures back for bounded edit–test–fix and routine recovery. Retain holds
  for unresolved ownership, changed permissions and exhausted budgets.
- Preserve independent review, checked integration and exact-head publication.
- Verify real-Git execution, capacity, repair and publication tests (A5–A9, A12).

## 4. User-facing goal workspace

- Add explicit opt-in to the new experience and a conversation-first workspace.
- Keep one composer through planning, questions, execution and result review.
- Render useful proposal/result cards, worker progress and context-specific
  decisions; leave technical records in secondary detail views.
- Persist and project message acknowledgements; recover uncertain submissions
  with the same command ID and retain read-only behavior.
- Verify UI tests plus real-service Cypress and screenshot inspection at desktop
  and phone widths (A1, A4, A14–A16).

## 5. Evaluation and delivery

- Extend the disposable development fixtures to exercise the same service paths
  without native accounts or installed state; document startup and cleanup.
- Run targeted tests per change, then `npm run verify` and relevant
  `npm run test:e2e:local` journeys with Chrome if Electron fails.
- Keep `docs/ccs-goals-evaluation.md` as the acceptance/evidence ledger, separating
  fixture, native, failed and unverified cases and recording interventions.
- Prepare a draft PR against main; do not merge, deploy or alter installed state.
- Perform the authorized native trials only within their explicit scope; require
  real evidence for both launchers and the five representative goal journeys
  before claiming the complete native usability target.

Implementation discoveries that change product behavior require a separate spec
amendment commit before changing this plan. No deviation belongs in this plan.
