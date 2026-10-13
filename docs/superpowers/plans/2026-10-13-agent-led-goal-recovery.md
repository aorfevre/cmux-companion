# Agent-led recovery implementation

Implements the [approved contract](../specs/2026-10-13-agent-led-goal-recovery.md).
Human approval followed spec commit `782785a7` before this plan commit.

1. Add persisted policy, classified failure evidence, episodes, decisions, budgets
   and due times. Add pure admission/diagnosis projections and authority tests.
   Keep absent-policy goals compatible; migrate only by explicit adoption.
2. Connect structured native outcomes and result settlement to recovery evidence.
   Wire scheduler reconciliation, delayed admission and atomic budget reservation.
   Unify review/check/launch repairs under the persisted policy for adopting goals.
3. Expose scoped supervisor diagnosis/strategy commands and evidence in its inputs.
   Bootstrap stopped supervisors through service policy. Enforce unchanged-failure
   and total limits, ownership, scope and human-only authority boundaries.
4. Add paired user adoption and budget-decision actions; project progress, precise
   blockers and remaining budget into goal detail/list/conversation. Retain policy
   and evidence across reconnect, restart, pause and abort.
5. Add service, real-Git, fake-clock, restart/fault and UI/Cypress scenarios mapped
   to A1–A10. Run required verification and inspect responsive screenshots. Record
   A11 separately as unverified until an explicitly authorized native trial.
6. Prepare a draft PR to main and delivery report listing every acceptance result,
   failures, interventions and outstanding native evidence. Do not merge or deploy.

One implementing owner handles all layers and owned-resource cleanup. Each step
must preserve idempotence and the service's existing publication approval gate.
