# Implement automatic planner assessment

Spec: ../specs/2026-09-09-review-finding-decisions-design.md
Human review: user approved the committed spec 4968bad with “approve and impement”.

1. Persist one assessment per review attempt, with source identity, planner model,
   claim ownership, result provenance and recoverable failure states. Queue current
   completed reviews atomically; backfill eligible unapproved reviews on the sweep.
2. Automatically run a read-only fork of the recorded planner conversation with
   the configured model and full critique. Validate its contract and finding
   dispositions, then atomically publish the final revision without a second review.
   The fork uses its own process, no terminal injection or repository writes.
3. Enforce completed assessment at approval, retire manual finding-decision writes,
   and make stale feedback/abort/revision changes invalidate assessment publication.
4. Present reviewing/assessing progress and one reviewed final plan with visible
   change summary, expandable technical details and final human decision controls.
5. Add backend lifecycle/recovery/security tests and deterministic mobile Cypress
   coverage, run verification, document any failures and open a PR against main.
