# Working on cmux companion

## Purpose
A private, mobile-first PWA for monitoring and controlling cmux on a Mac over
Tailscale, turning goals into saved plans, isolated agent worktrees and PRs.
This is the single shared coding-agent guide; Claude and Codex follow it.
See [product behavior](README.md#what-it-does) and [architecture](README.md#architecture).

## Important code
- `app/page.tsx`: React 19/vinext sessions UI and pairing.
- `app/worktree-dashboard.tsx`: project, worktree and goal board UI.
- `app/api-request.ts`: shared fetch helper, deduplicated reads and mutation invalidation.
- `server/index.mjs`: starts the loopback companion and wires persistent services.
- `server/app.mjs`: Fastify API, authentication hooks and service wiring.
- `server/goal-board.mjs`: shared pure derivation of goal board columns/state.
- `server/worktree-plan-store.mjs`: node:sqlite saved plans and delivery history.
- `server/repo-identity-store.mjs`: rebuildable SQLite repository/worktree cache.
- `worker/index.ts`: vinext Worker entry and image handling; build scaffolding, not the Mac bridge.
- `tests/`: explicit Node backend tests and automatically selected Vitest UI tests.
- `cypress/`: local browser configuration, fixtures and deterministic UI specs.
- `scripts/`: development, verification and macOS installation/operator tooling.

## Prerequisites and configuration
Use Node.js >=22.13, preferably the version in `.nvmrc`, and npm with the checked-in
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
In terminal one, use a disposable pairing token of at least 32 characters:
```sh
export CMUX_COMPANION_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
npm run companion:dev
```
Keep that token private and enter it in browser pairing. In terminal two run
`npm run dev`, open `http://localhost:3000`, and pair. The frontend proxies `/api`
to the loopback Fastify backend on port 3210. Missing cmux should show
**Waiting for cmux**; installing cmux is not necessary for this setup check.
If a port is occupied, do not kill its owner: use `CMUX_COMPANION_PORT` for the
backend, `npm run dev -- --port <port>` for the frontend and set
`CMUX_COMPANION_API=http://127.0.0.1:<backend-port>` for that frontend.
For isolated checks, point the documented data paths and repository roots at
disposable locations so existing goals, queues and worktrees are not exercised.
These overrides do not isolate the GitHub issue cache: its startup sync can rewrite
`~/.config/cmux-companion/github-issues.json`. Use a separate OS account for a
fully isolated run alongside an existing installation.
Stop both processes with Ctrl-C and remove temporary configuration afterward.

## Fast verification
Run `npm test`, `npm run test:ui`, `npm run lint` and `npm run typecheck`.
For a bounded backend edit, first run `node --test tests/<name>.test.mjs`.

## Full verification
Run `npm run verify` (backend, UI, lint, types and build); CI uses the same command.
For new features or user-visible behavior, add/update relevant Cypress coverage
and run `npm run test:e2e:local`. If Cypress cannot exercise the change, explain
why and run the closest local validation. See [local end-to-end checks](README.md#local-end-to-end-checks).
If Electron fails, use `CMUX_COMPANION_CYPRESS_BROWSER=chrome npm run test:e2e:local`.

## Test conventions
Server tests are top-level `tests/*.test.mjs` files, explicitly listed in the
`package.json` test script; the first test guards this list. Only
`tests/live-cmux.test.mjs` is excluded because it needs real cmux.
Vitest automatically selects `tests/ui-*.test.tsx`. Deterministic Cypress specs
in `cypress/e2e` stub APIs and stay excluded from `npm test`, `npm run verify`
and CI. Live suites require separate authorization and the README safety opt-in.

## Security, live and release boundaries
Preserve pairing, same-origin checks, repository allow-lists and argv-based
process calls; see the [security model](README.md#security-model).
Never add arbitrary shell/cmux RPC passthrough or bind services outside loopback.
Do not touch unrelated sessions, worktrees, credentials or user changes.
Do not routinely run `npm run install:mac`, `npm run uninstall:mac`,
`npm run update:check`, `npm run update:retry`, `npm run update:disable`,
`npm run update:enable`, `npm run status -- --show-token`, `npm run test:live`,
`npm run test:installed`, `npm run test:preview-live`, `npm run test:e2e:live-audit`
or `npm run test:e2e:live-agent`: these expose credentials or exercise installed,
live or release services and require explicit task authorization.
Agents must not merge, deploy, expose secrets or alter external accounts/services
without explicit task authorization. Worker/build scaffolding is not permission to publish.

## Delivery
Inspect the touched flow and checks, then make one bounded change with one owner
accountable for its observable outcome, integration and cleanup. Delegate only
independent bounded work, without recursive delegation. Trace applicable UI,
API, storage, background and external boundaries; explain inapplicable layers.
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
