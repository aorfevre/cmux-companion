# Development and completion

## Start from a checkout

Use the Node version in `.nvmrc` (with nvm: `nvm install && nvm use`), then
`npm ci`. The lockfile defines dependencies. No global LLM CLI is needed for
unit tests, UI tests, the build or deterministic Cypress tests.

Run `npm run verify` for backend tests, UI tests, lint, types and production
build. The CI workflow uses the same runtime and command. Cypress remains
local-only: `npm run test:e2e:local` starts and stops an isolated frontend at
`http://localhost:3221` with stubbed APIs. It needs no paired phone, cmux, GitHub
credentials or production data. See the [Cypress guidance](../README.md#local-end-to-end-checks)
for interactive mode, Chrome fallback and opt-in live integration checks.

To run the connected product on macOS, follow [Development](../README.md#development)
and [Requirements](../README.md#requirements). The UI proxies `/api` to the
loopback bridge; connected terminal behavior needs cmux. Goal planning needs
configured CCS; execution needs the configured `xcodex`/`xclaude` aliases;
PR delivery needs GitHub access. Keep real credentials out of tracked files.
`.env.example` describes configuration. Do not run installation or deployment
to test a source change. `worker/index.ts` and `.openai/hosting.json` are build
scaffolding, not the Mac bridge or permission to publish it.

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

## Review dev setup, one project at a time

In Worktrees, choose a project and **Review dev setup**, or choose **New goal**
for that project and use **Review dev setup** in the empty goal sheet. Edit the
goal and select a planner engine, then **Plan this goal**. Review the resulting
contract and task before launching it through the usual worktree/PR workflow.
Opening the review fills text only: it does not scan, edit files or launch an
agent. There is no bulk action, scheduled rewrite or automatic quality score.

The review adapts to the repository's language, platform and purpose. Our
TypeScript, Cypress and Astro preferences are defaults to consider, not a reason
to migrate a suitable stack. The goal is portable repository guidance and
working native commands that any human or LLM can follow. Companion currently
initiates planning/execution through Claude or Codex; this does not claim support
for launching every LLM. Provider entry files link shared guidance and retain
necessary provider-specific differences. Missing resources and scope exceptions
must be explicit; a document alone does not prove the environment works.

The editable starting brief is defined once in
[`app/dev-setup-goal.ts`](../app/dev-setup-goal.ts). No preset id, new database,
review worker or new external integration is needed: the submitted text is the
saved goal. An existing goal retains its submitted text if the preset changes.

## Reviewing a plan before launch

The planner review shows the expected outcome, scope, assumptions, risks and
success criteria before the delivery stages. “Plan checks passed” means the
saved contract passed structural validation; it is not evidence that the work
has been implemented or tested. Warnings, assumptions or risks change that
label to “Review before launch”. Structural errors remain visible and disable
the launch action; warning-only plans can still be launched after review.

Stages show execution order and which tasks can run in parallel. Numbered task
references expand to the full prerequisite titles, including dependencies that
skip stages. The launch panel explains the action and reminds the reviewer of
recorded assumptions and warnings. Reading or expanding the plan starts no
agents; the launch button uses the existing launch endpoint.

For older contracts with long outcomes, the review explicitly labels an
excerpt and retains the entire original under “Read the full expected outcome”,
with rendered Markdown and raw text available. It does not synthesize an
unverified summary or change a saved contract. New planner prompts request a
short observable outcome and put implementation detail in the relevant contract
fields. A live planner's adherence to that instruction still needs observation.

## Concise replies

The authoritative [reply convention](../server/agent-reply-format.mjs) is shared
by the development-setup goal and `AgentBriefs.write`. Every newly written task,
relaunch, integration and follow-up brief receives it, independent of the selected
provider. Structured planner output, completion reports and PR templates retain
their schemas. Existing running sessions and standalone sessions without a goal
brief are not retroactively changed; other repositories adopt it through their
individual setup reviews. This is an instruction, not an output validator or a
hard token cap. No cost or efficiency improvement has yet been measured.

## First implementation: evidence and limits

Inspection found that the original `AGENTS.md` described only Cypress, README
listed verification commands without a reproducible development runtime, and
no tracked CI workflow exercised the existing `verify` command. A fresh install
under the shell's Node 23 emitted unsupported-engine warnings for Cypress,
Vitest and jsdom. `.nvmrc` supplies a compatible installed Node 22 version;
shared instructions now identify the product, code map and boundaries, and a
small CI workflow reuses existing verification. `CLAUDE.md` remains a pointer.
No new skill framework or cross-project runtime was added.

The feature path is the project dashboard / planner sheet → existing
`POST /api/worktree-plans` → `WorktreePlanner.startBackground` → SQLite plan
store → background planner round via CCS. Users review before launch; downstream
worktree creation, agent briefs, delivery/recovery and GitHub PR handling retain
the existing path. Cypress exercises the UI with fail-closed API fixtures;
backend regression coverage exercises actual planner/store behavior with fake
external process calls. These checks cannot prove a live LLM follows the brief
or that another repository's setup works. Evaluate the first real project review
by recording setup/check results and interventions in its completion report
before deciding whether further automation is justified.

Validation of this first change (2026-09-06, macOS, Node 22.23.1):

- `npm run verify`: passed, including 882 backend tests, 95 UI tests, lint,
  typecheck and build.
- `npm run test:e2e:local`: all 48 tests passed. New scenarios cover Claude and
  Codex selection, the selected repository and edited scope in the submitted
  goal, preservation of existing text, failed-submit recovery, and opening a
  project review without launching work or contaminating the next blank goal.
- `git diff --check`: passed. No regression coverage was removed.
- `npm audit`: reports one moderate `fflate` advisory
  ([GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98))
  in the unchanged lockfile. Dependency remediation is separate from this change.

Hosted CI, real CCS/LLM behavior, live cmux/GitHub delivery, other projects and
reply-token savings were not exercised by this change. No merge or deployment
was performed. The first autonomous review still needs observation before we
can claim it reduces human interventions or makes another project ready.

### CI portability follow-up

The first hosted run exposed an installed-CCS assumption and two background
launch tests whose 500 event-loop turns expired in under 7 ms. CCS discovery
now uses a temporary executable/package/symlink fixture and verifies both
explicit-binary and PATH discovery. Launch tests use a bounded elapsed-time
wait, with a delayed brief-write regression case. Product behavior and test
assertions are preserved. This test-only correction has no UI path to exercise
in Cypress; targeted Node tests and the full local/hosted verification cover it.

## Quality checks and ownership

`npm test` discovers top-level `tests/*.test.mjs` automatically. Use `*.live.mjs`
for live integration suites and an explicit opt-in command; the runner also
excludes legacy `live-*` names. Tests are never discovered inside nested
worktrees. `npm run typecheck` checks the frontend and a strict checked-JSDoc
pilot for planner run transitions and durable task launch results. Extend that
pilot when changing another pure boundary; do not claim the entire backend is
statically checked.

Planner process transport, model reply normalization, HTTP planner routes and
SQLite schema/migrations have separate owners in `server/planner-process.mjs`,
`planner-reply.mjs`, `planner-routes.mjs` and `worktree-plan-schema.mjs`.
`useOwnedRead` owns asynchronous UI reads across terminal/workspace changes;
`useImageAttachments` owns upload capacity and image lifetime for each sheet or
terminal. Reuse these boundaries instead of copying asynchronous state logic.

JSON registries use `readPrivateJson`: a missing file initializes defaults,
invalid JSON/top-level shape is preserved in a mode-0600 `.corrupt-*` sibling
before recovery, and other IO errors propagate. Stop Companion before manually
repairing a registry. Inspect the backup locally, restore validated contents to
the original path with mode 0600, and restart through the normal authorized
operator flow. Do not blindly replay recovered queued prompts or expose previews.
Each registry and SQLite store has one service-process writer; WAL is not a
cross-process ownership lock. Never run two bridges against the same state files.

`node scripts/benchmark-plan-store.mjs` measures the store with 200 synthetic
goals in a temporary directory and removes its own data afterward. The review's
measurements and their limits are recorded in [implementation evidence](reviews/implementation-status.md).

Production builds stamp the service worker with a digest of client assets and
worker code, so cache versions change without a manual counter. Development
workers bypass caching; local Cypress disables registration and uses API
fixtures. The separate deterministic browser tests exercise worker install,
update and offline navigation using an ephemeral local HTTP fixture when Chrome
is installed. Preview capture tests also exercise HTTP/WebSocket and service
worker containment without Tailscale or external services.
