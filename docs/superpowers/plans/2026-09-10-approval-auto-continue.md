# Implement automatic continuation after approval

Spec: ../specs/2026-09-10-approval-auto-continue-design.md
Human review: user approved the committed spec ee025e2 with "approve".

1. Store: add the `sending`/`sent` transition states with a dispatch id, reason
   and sent time; atomic claim, record, cancel-on-change and pending backfill.
2. Service: deliver one approval prompt after approve, with the runner-alive,
   workspace-present and no-native-prompt preconditions; resend and sweep.
3. API: return delivery state from approve, add `resend-approval`, keep pairing,
   origin and allow-list checks; hook keeps `sent`→`delivered`.
4. UI: board evidence and goal sheet show the four delivery states and the
   resend action under the read-only guard; docs.
5. Tests: backend lifecycle, recovery, races, preconditions, security; UI states;
   deterministic Cypress at 390px; run verification and open a PR against main.
