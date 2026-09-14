# Goal verification discovery

## Outcome
Users can create goals for tracked GitHub projects without configuring checks per repository. The planner inspects repository guidance, scripts, CI and the requested outcome and proposes goal-specific verification. This implements the user-approved journey in the conversation of September 14, 2026.

## User journey
Select a project and describe a goal. The planner discovers appropriate commands and records exact argv in the proposed plan, mapping acceptance criteria to verification. Existing repository checks are optional starting points. When no checks exist, propose tasks that add meaningful validation and explicitly describe the current gap; never invent passing evidence or use a no-op to satisfy the contract. Independent review and user approval of that exact plan authorize its verification commands. Changed plans require fresh approval.

## Non-goals
No automatic approval, shell/RPC passthrough, global arbitrary command endpoint, weakening of final verification, or automatic changes to repository settings. Existing goal snapshots and storage formats remain valid.

## Acceptance criteria
- A project with no configured checks can create a goal: disposable settings-runtime API test.
- The planner is instructed to discover checks and report gaps: role prompt regression.
- Only exact commands in the current approved plan execute for that goal/repository, including after restart; mismatches, missing approval and shell wrappers fail: resolver/runtime regression.
- Settings describe checks as optional defaults; goal creation needs no check setup round trip: UI and Cypress onboarding scenario.
- Verification remains mandatory for delivery and approval remains revision-specific: existing domain and verification suite.

## Success measure
A disposable goal is created with zero project checks and resolves a newly planned command after approval without editing repository settings.
