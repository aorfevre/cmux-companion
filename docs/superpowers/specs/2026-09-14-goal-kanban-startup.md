# Goal Kanban and automatic planning

## Outcome
Creating a goal is submit-and-move-on: a persisted Planning card appears immediately, then Companion fetches the configured repository's latest main, provisions an isolated worktree and starts its planner. The user approved this journey and implementation in the conversation, including planner names `<Project Code> Planning <XYZ>` where XYZ is a short goal title.

## User journey
Select a project, write the request and click Start goal once. Keep the complete request and links as the description; show a short editable title on the card. Project code defaults to an uppercase readable project identifier/name without requiring setup. A named planner appears on the card, in agent activity and in its native session. Main is fetched and pinned before planning, without switching/pulling the user's checkout. Advanced offers another explicit base branch. Failed fetches and missing branches become actionable blockers, never silent stale fallbacks. Planning discovers checks using the already delivered goal-verification contract.

Goals opens as Planning / Needs approval / In progress / Review / Done Kanban, with mobile selectable columns and counts. The service's real state determines columns; cards cannot bypass workflow gates. Questions, failures and blocked work show Needs attention. Goal details contain the full description, plan and agent information; empty review/verification sections are hidden. Tasks appear as To do / Running / Review / Done after planning, with dependencies and blockers; the graph remains optional. Clarification and exact-plan approval stay inside the goal workflow, with notifications through existing supported notification channels. Sessions are secondary. No terminal must be opened to initiate planning.

## Non-goals
No automatic plan approval, changing an existing goal's base, merging user project PRs, rewriting dirty checkouts, silent remote fallback, unconditional notification permission or new external messaging integration. No schema change that invalidates historical goals or rollback readers. No unrelated user sessions/worktrees are stopped or cleaned.

## Acceptance criteria
- Dirty feature checkout remains unchanged while a new goal plans from fetched main: disposable Git integration test.
- Goal submission is persisted once and startup failures/retries remain recoverable: command/admission and scheduler test.
- Planner names follow project code + Planning + short title consistently: backend/native and UI regression.
- Kanban columns reflect actual states, offer mobile column navigation, and expose attention details: UI/browser scenario.
- Full request remains available and title is editable without replacing the request: persistence/UI regression.
- Task board displays dependencies, blockers and optional graph: UI/browser scenario.
- Questions/approval notifications and restart deduplication reuse durable existing boundaries: notification/recovery regression.
- Historical goals retain their base and remain readable: compatibility test.

## Success measure
From a project checked out on a dirty feature branch, one submission produces a Planning card and one named planner on the latest fetched main; the user can follow progress and respond from the goal without opening a terminal or configuring repository checks.
