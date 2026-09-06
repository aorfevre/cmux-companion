# PR #74 integration validation

Updated 2026-09-06 against main `708398551e6a82d74faf04d8c1022c0e0605cdb2`. This update merges main into the existing PR branch; it does not merge the PR or deploy the application.

## Conflict resolution

The only conflict was `package.json`'s explicit backend test command. The resolution retains main's test-list guard and model-settings suite plus this PR's worktree-operations suite: 47 non-live Node suites, each named exactly once. No runtime refactor conflict occurred; the canonical parser, caller adapters and Git execution policies remain intact.

## Review snapshot and current applicability

The six reports describe the source reviewed at `f4052f1a8dc63761b50f874d452f7d551790d57a`. Their 854 path:line citations, coverage inventories, counts and dispositions remain historical evidence. Read cited source at that commit, not at moving main line numbers. The checker now validates those inventories/citations against the explicit snapshot and independently validates current test membership. It requires that commit in local Git history; a shallow clone may need additional history.

This update does not claim that newly merged model settings, goal URLs, developer guidance or other main changes received a second complete review. Reproduce each finding against current main before implementing it. TEST-003's missing-suite guard is now addressed by main's `tests/test-script-list.test.mjs`; this integration additionally checks missing, extra and duplicate membership. The original ledger is retained as an audit trail, not a claim that TEST-003 remains unfixed today. API fixture default-store isolation (TEST-002) remains follow-up work: the validation environment below avoids operator stores without fixing the fixtures.

## Follow-up issues

All 12 high-severity source findings are tracked below. Related medium findings share a package where the same boundary is involved. Each issue requires an implementation owner to claim it, fresh reproduction, focused fix PRs, observable acceptance tests and linked closure evidence. Other medium/low findings remain in the ranked backlog and ledger.

| Finding IDs | Tracking issue |
| --- | --- |
| PLAT-001, PLAT-006 | [Require fresh safety evidence before manual worktree deletion](https://github.com/aorfevre/cmux-companion/issues/78) |
| CLIENT-002, CLIENT-003 | [Stop Send now when saving the edited prompt fails](https://github.com/aorfevre/cmux-companion/issues/79) |
| CLIENT-001, CLIENT-009 | [Reject obsolete terminal and reconnect responses](https://github.com/aorfevre/cmux-companion/issues/80) |
| TEST-001 | [Protect existing automation config and backup permissions](https://github.com/aorfevre/cmux-companion/issues/81) |
| TEST-002 | [Isolate API test fixtures from operator persistence](https://github.com/aorfevre/cmux-companion/issues/82) |
| PLN-001, PLN-002 | [Claim planner launches and require confirmed closure before replacement](https://github.com/aorfevre/cmux-companion/issues/83) |
| PLN-003, GOAL-003 | [Atomically claim issue planning and concurrent goal follow-ups](https://github.com/aorfevre/cmux-companion/issues/84) |
| GOAL-001, GOAL-002 | [Revalidate cancellation and session status before creating or closing workspaces](https://github.com/aorfevre/cmux-companion/issues/85) |

Recommended order: test isolation, deletion safety and failed-save handling, then the independent session-ownership packages. Configuration permissions and stale client response fixes can proceed independently.

## Current validation

- Node 22.23.1 from `.nvmrc`; `npm ci` passed with the lockfile unchanged.
- `npm run verify` passed: 928 backend tests, 96 UI tests, lint, typecheck and production build. Default persistence was redirected to a disposable directory using a temporary Node preload overriding `os.homedir` (with `syncBuiltinESMExports`) and explicit `CMUX_COMPANION_HOME`, `CMUX_COMPANION_PLANS_DB` and `CMUX_COMPANION_REPO_DB`; shell HOME was unchanged.
- `node docs/code-review/check-review.mjs` passed: snapshot partition 15/18/23, client 26, tooling 88, 48 finding IDs, 854 citations; current non-live test membership 47.
- The audit utility's standalone ESLint initially found an unused loop index after the snapshot change; the index was removed and the check passed.
- Local Cypress: pending completion.

Dependency installation reports one moderate advisory in the unchanged lockfile; build emits large-chunk and vinext route-classification advisories. No live-agent, installed-companion, real-device PWA, merge or deployment checks were run. Hosted CI status is recorded in the PR after pushing.
