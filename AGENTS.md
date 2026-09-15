# Working on cmux companion

## Purpose
A private, desktop-first responsive PWA for monitoring and controlling cmux on a Mac over
Tailscale, turning goals into saved plans, isolated agent worktrees and PRs.
This is the single shared coding-agent guide; Claude and Codex follow it.
See [product behavior](README.md#what-it-does) and [architecture](README.md#architecture).

## Important code
- `app/page.tsx`: React 19/vinext sessions UI and pairing.
- `app/orchestration/`: Mission Control fleet and service-projected workflow actions.
- `app/api-request.ts`: deduplicated reads and mutation invalidation.
- `server/index.mjs`: explicit production configuration and loopback startup.
- `server/app.mjs`: encapsulated monitoring API and authentication.
- `server/orchestration/domain/`: pure commands, state, graphs and review rules.
- `server/orchestration/service.mjs`, `scheduler.mjs`: authority, admission and effects.
- `server/orchestration/storage/`: separate SQLite journal and ownership fencing.
- `server/orchestration/adapters/`: Git, native processes, verification and publication.
- `server/orchestration/production.mjs`, `cutover.mjs`: guarded composition and rollback.
- `server/repo-identity-store.mjs`: rebuildable repository/worktree cache.
- `worker/index.ts`: vinext Worker build scaffolding, not the Mac bridge.
- `tests/`: Node backend and automatically selected Vitest UI tests.
- `tests/helpers/orchestration/`: disposable Git repositories and fake external adapters.
- `cypress/`: deterministic monitoring and real-service orchestration browser checks.
- `docs/orchestration-retirement.md`: legacy removal and operator cutover contract.

## Prerequisites and configuration
Use Node.js >=22.23.1 <23, with the version in `.nvmrc`, and npm with the checked-in
`package-lock.json` (lockfile v3); do not substitute another package manager.
The installed product and live integrations require macOS, cmux and Tailscale,
CCS where planning/accounts need it, and authenticated `gh` for GitHub features.
Routine unit/UI/lint/type/build checks do not require those services.
[Configuration](README.md#configuration) documents environment values;
`.env.example` is a reference and is not automatically loaded by
`npm run companion:dev`: export values or supply them explicitly.

## Fresh checkout
From the checkout, select `.nvmrc` (with nvm: `nvm install && nvm use`), then
run `npm ci`. Preserve the lockfile. See [development](README.md#development).

## Local run and pairing
Use the account-free disposable entry point:
```sh
npm run orchestration:dev -- --port 3211
```
It prints private manifest and token paths, never the token. Set
`CMUX_COMPANION_API` to its printed loopback address for `npm run dev`, open
`http://localhost:3000/orchestration`, and pair using the disposable token.
Use a free port rather than stopping an existing owner. Stop both owned processes
with Ctrl-C. See `docs/orchestration-development.md` for fixture evidence and cleanup.
`companion:dev` is production composition with local settings/onboarding; legacy
JSON startup remains a migration path. Do not use installed state for routine checks.

## Fast verification
Run `npm test`, `npm run test:ui`, `npm run lint` and `npm run typecheck`.
For a bounded backend edit, first run `node --test tests/<name>.test.mjs`.
`npm run test:coverage` and `npm run test:ui:coverage` write line coverage reports
under `coverage/`; both commands enforce backend/UI line coverage at or above 90%.

## Full verification
Run `npm run verify` (backend/UI coverage, lint, types and build); CI uses the same
command after `npm run test:mac` succeeds on a macOS runner.
For new features or user-visible behavior, add/update relevant Cypress coverage
and run `npm run test:e2e:local`. If Cypress cannot exercise the change, explain
why and run the closest local validation. See [local end-to-end checks](README.md#local-end-to-end-checks).
If Electron fails, use `CMUX_COMPANION_CYPRESS_BROWSER=chrome npm run test:e2e:local`.

## Test conventions
Server tests are top-level `tests/*.test.mjs` files, automatically discovered by
`scripts/run-backend-tests.mjs`; tests guard discovery and live-suite exclusion.
Live suites use `*.live.mjs` and explicit opt-in scripts; legacy live names are
also excluded.
Vitest automatically selects `tests/ui-*.test.tsx`. Monitoring Cypress specs stub APIs; the orchestration specs use a real disposable
backend and Git with fake external adapters. Both stay excluded from `npm test`, `npm run verify`
and CI. Live suites require separate authorization and the README safety opt-in.

## Security, live and release boundaries
Preserve pairing, same-origin checks, repository allow-lists and argv-based
process calls; see the [security model](README.md#security-model).
Never add arbitrary shell/cmux RPC passthrough or bind services outside loopback.
Do not touch unrelated sessions, worktrees, credentials or user changes.
Do not routinely run `npm run install:mac`, `npm run uninstall:mac`,
`npm run update:check`, `npm run update:retry`, `npm run update:disable`,
`npm run update:enable`, `npm run status -- --show-token`, `npm run test:live`,
the opt-in native adapter live suites: these expose credentials or exercise installed,
live or release services and require explicit task authorization.
Agents must not merge, deploy, expose secrets or alter external accounts/services
without explicit task authorization. Worker/build scaffolding is not permission to publish.

## Specs and plans
A design spec in `docs/superpowers/specs/` is the single place a product decision
lives. A plan in `docs/superpowers/plans/` implements a spec and may not deviate
from it. When a plan or an implementation finds a spec error, amend the spec first,
in its own commit, then change the plan. Do not record a deviation inside the plan.
Write every spec as a delivery contract: outcome, user journey, non-goals,
acceptance criteria with one verification each, and one success measure. Leave at
least one review of the spec by a person between the spec commit and the plan commit.

## Delivery
Inspect the touched flow and checks, then make one bounded change with one owner
accountable for its observable outcome, integration and cleanup. Delegate only
independent bounded work, without recursive delegation. Trace applicable UI,
API, storage, background and external boundaries; explain inapplicable layers.
Create goal PRs as drafts; mark them ready only when implementation and required
verification are complete, retaining the service's human publication approval gate.
CodeRabbit approval and protected auto-merge follow `docs/code-review-workflow.md`;
a green skipped-review status is not approval.
Review changes through a PR targeting `main`, with detailed evidence in the PR
or completion report. Separate passed, failed and unverified paths, record
interventions and remaining gaps, and investigate failures without dropping coverage
or repeatedly retrying unchanged failures. Merge and release remain separate decisions.

## Reply convention
Human-facing reply format:
Result: The direct answer or concrete outcome.
Checks: Passed, failed or not run, with the relevant check names.
Blockers: Unresolved issues or the specific decision needed.
Omit irrelevant lines. Target at most 80 words for routine replies. No preamble, repeated plan, narration or closing offer. Progress updates: one sentence only for a meaningful finding, blocker or required status update. Expand when explicitly requested or needed for correctness, security or a decision. Put detailed evidence in the PR or report and link it. Never omit failures or unverified work to meet the word target. Preserve required machine-readable output, completion reports and PR templates; this format applies to human-facing prose, not those schemas.
