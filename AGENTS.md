# Working on cmux companion

A private, mobile-first PWA for monitoring and controlling cmux on a Mac over
Tailscale. Project goals become saved plans, isolated agent worktrees and
reviewable GitHub pull requests. Claude and Codex use the same delivery flow.

## Code map

- `app/`: React/vinext UI; `page.tsx` owns sessions,
  `worktree-dashboard.tsx` the project/goal board, `worktree-planner.tsx` planning.
- `server/app.mjs`: Fastify API and service wiring; `security.mjs` authentication.
- `server/worktree-planner.mjs`, `worktree-operations.mjs`: planning and launch;
  `worktree-plan-store.mjs`: SQLite history; `goal-integrator.mjs` and
  `goal-watchdog.mjs`: delivery and recovery; `cmux-client.mjs`: cmux boundary.
- `tests/`: Node backend and Vitest UI tests; `cypress/e2e/`: local UI scenarios.
- `scripts/`: development, local tests and macOS installation.

## Boundaries and completion

Preserve pairing, same-origin checks, repository allow-lists and argv-based
process calls. Never touch unrelated sessions, worktrees, credentials or user
changes. Do not merge, deploy or run live integrations without authorization.
Keep one owner accountable for the observable outcome and integration; delegate
only bounded independent work, without recursive delegation. Match checks to
risk and report passed, failed and unverified paths separately.

Use the human-facing [reply format](server/agent-reply-format.mjs) for concise
results, checks and blockers. Its word target never overrides required evidence.

## Verify

Use the runtime in `.nvmrc`, then `npm ci`. `npm run verify` runs backend tests,
UI tests, lint, types and build; CI uses that same command.
For new features or user-visible changes, add/update relevant Cypress coverage
and run `npm run test:e2e:local`. Cypress stays local-only, outside CI and
`verify`. If Cypress cannot exercise the change, explain why and run the closest
local validation. Live-agent tests require the README safety opt-in.

See [development setup and completion](docs/development.md),
[product and security](README.md), and [local Cypress and live-test safety](README.md#local-end-to-end-checks).
There are no repository skills today. Read task-relevant guidance when needed;
keep reusable guidance authoritative and link it from any future skill.
