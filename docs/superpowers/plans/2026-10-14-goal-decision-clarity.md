# Goal decision clarity and check setup repairs

Contract: the 2026-10-14 correction in
`../specs/2026-10-13-goal-decision-bar-design.md`, committed as `da9bfc3f`.
Human review: user replied "Reviewed — proceed with this design" after that
commit and before this plan. Owner: implementing agent; no delegation.

1. Project explicit action consequences and check-setup next steps from the
   domain without changing approval authority, command payloads or budgets.
2. Show the current proposal/result first, then the latest message and composer;
   collapse all earlier conversation entries. Render failed check evidence
   beside the decision and keep the full technical history accessible.
3. Preserve actual CI environment instead of forcing CI locally. Retain
   resolver diagnostics in immutable evidence and expose bounded messages to
   the user and agent through existing authenticated evidence routes. Do not
   replace approved executable paths or mutate the live goals.
4. Cover approval, moved-target publication, failed setup, history, revision
   draft routing, real runner environments and local browser layouts. Run
   focused tests, `npm run verify`, `npm run test:mac`, and
   `npm run test:e2e:local`; inspect screenshots at desktop/mobile widths.
5. Review the diff, publish a draft PR targeting main with passed/failed/unverified
   evidence and cleanup notes. Merge, install and live goal recovery are separate.

Boundaries: UI reads the API projection; commands retain existing version and
authority checks. Evidence artifacts gain a backward-compatible optional error
message; SQLite schema and historical approvals are unchanged. Background checks
keep argv execution, exact-commit validation and process ownership fencing.
GitHub publication, external accounts and installed services are unchanged.
