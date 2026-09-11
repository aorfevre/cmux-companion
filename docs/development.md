# Development and completion

Use Node from `.nvmrc` and `npm ci` with the checked-in lockfile. No private
account is needed for routine backend/UI tests, build or disposable Cypress.

Use [the disposable orchestration entry](orchestration-development.md) for the
complete goal journey. It runs real SQLite, Git and checks with fixed fake agents
and publication. Monitoring browser tests separately stub API responses.
Production startup requires the private configuration and ownership checks in
[the cutover procedure](orchestration-retirement.md). Do not install or deploy to
test a source change; `.openai/hosting.json` is build scaffolding, not permission
to publish the Mac service.

## Work one outcome through the system

Before editing, inspect the touched flow and its existing checks. Define what a
user can do afterward and trace applicable UI, API, storage, background work and
external-service boundaries. A library or documentation change may have no UI;
state the equivalent outcome and why a layer is not applicable.

Keep one owner responsible for implementation, integration and completion.
Delegate only independent bounded work that reduces effort. When a check fails,
inspect its cause and compare against the base if claiming it was pre-existing;
do not remove coverage or repeatedly retry without new evidence. Separate
blocking defects from optional follow-ups. Finish with changed behavior, checks
and their results, manual interventions, and unverified dependencies. Merging
and deployment need explicit authorization.

## Delivery checks

Run `npm run verify`, both coverage commands and the local Cypress commands in
[README](../README.md#local-end-to-end-checks). Backend/UI line coverage must stay
at least 90%. Keep external credentials and installed state out of fixtures.
Record passed, failed and unverified paths, interventions and remaining gaps in
the PR. Independent code review should examine authority, persistence, worker
ownership, Git integration and exact-head publication, not only style.

The design specification owns product decisions. Implement its approved revision;
if it is wrong, amend the spec in its own commit before changing the plan, and
preserve the required human review between spec and plan commits. Review through
a PR targeting `main`; merge, installed cutover and release remain separate.
