# Licence usage and provider launchers

## Outcome

Manual sessions in approved repositories and worktrees now support Claude, Codex
and Kimi. Server environment settings select each executable; the defaults remain
`xclaude`, `xcodex`, and `kimi`. The launch sheets and licence page read the actual
configuration through an authenticated, read-only endpoint. A failed configuration
read explicitly identifies the displayed names as defaults.

The usage page refreshes every minute while visible and when returning to the
page. It shares requests already in progress, uses the existing server cache,
retains the last browser snapshot on refresh failure, shows all reported limits,
and gives reset countdowns explicit day/hour/minute units. Missing, null and
malformed percentages cannot become zero or full capacity.

Kimi Code subscriptions can report quota through an optional Mac-side
`CMUX_COMPANION_KIMI_API_KEY`. The adapter uses the fixed upstream `/coding/v1/usages`
endpoint with a 12-second timeout and rejects redirects. Kimi remains independently
available if CCS fails. Without a key, the UI explains setup and still offers
manual Kimi sessions. No percentage is fabricated when a window is absent.

## Configuration and boundaries

- `CMUX_COMPANION_CLAUDE_COMMAND=xclaude`
- `CMUX_COMPANION_CODEX_COMMAND=xcodex`
- `CMUX_COMPANION_KIMI_COMMAND=kimi`
- Optional `CMUX_COMPANION_KIMI_API_KEY`: Kimi Code subscription key, not a Moonshot
  API billing key. Supply privately in the companion environment, never in Git.

Restart the companion after changing its environment. Values for commands accept
one executable name or absolute path; local wrapper scripts can supply fixed
arguments. Simple names stay unquoted to preserve interactive zsh alias expansion;
paths and prompts are shell-quoted. Kimi receives tasks via its `--prompt` option.
Launch request bodies cannot select an executable or supply command configuration.

UI: repository launch, existing-worktree launch, new-worktree launch, and licence
usage all expose the provider consistently. Kimi is recognized in session labels.

API: pairing, same-origin mutation checks and repository allow-lists remain in
place. The launcher configuration endpoint is read-only and requires pairing.
Quota responses contain sanitized account/window data, never credentials.

Storage: no database/schema changes; configuration is owned by the Mac's server
environment. Existing model settings remain authoritative for Claude/Codex.

Background: browser quota polling pauses while hidden and stops on unmount;
concurrent requests share the existing server snapshot. No new daemon is created.

External: Kimi quota uses the upstream CLI's documented source contract. Kimi CLI
login and account switching remain in that CLI. Automated planning, reviews,
capacity scheduling and CCS reconnect remain Claude/Codex capabilities. There is
one optional Kimi subscription key, not automatic discovery of multiple Kimi
accounts. Worker hosting and release paths are inapplicable to this change.

See the configuration section at the end of [README](../../README.md) for setup
and links to the upstream Kimi CLI options, usage parser and platform definitions.

## Verification

Runtime: Node 22.23.1 and `npm ci` with the checked-in lockfile. Rebased onto main
`ed04c33`, preserving its technical-review cleanup and resolving one dashboard
import conflict by retaining both the new upstream imports and launcher selector.
The final dependency install reported zero vulnerabilities.

Passed:

- `npm run verify`: 1,031 backend tests and 125 UI tests; lint; frontend and bounded
  backend type checks; production build.
- Targeted tests cover executable overrides, retained aliases, quoted Kimi prompts,
  rejection of shell syntax in executable configuration, authenticated launcher
  metadata, Kimi worktree API launch and ignoring a request-supplied command.
- Kimi fixtures cover duration-based windows, explicit zero remaining, missing
  limits, subscription-key redaction, absent keys, failed fetches and CCS failure.
- UI tests cover visible/hidden polling, returning to the page, requests already
  in progress, failed refreshes retaining data, unmount cleanup and reset units.
- API and quota test fixtures explicitly disable real Kimi access even when the
  operator exports a subscription key; a backend rerun with a dummy key verifies
  that the test setup stays independent of installed provider configuration.
- `git diff --check`.

- `CMUX_COMPANION_CYPRESS_BROWSER=chrome npm run test:e2e:local`: all 90 tests
  passed across 20 specs after integration with current main. Includes repository
  and new-worktree Kimi launch, configured command labels, minute polling, manual
  refresh, missing windows, additional limits and retained data on refresh error
  at 390px and 1440px.
- Inspected separate 390px and 1440px browser screenshots with all three providers
  and the expanded command reference. No horizontal overflow; one navigation
  element per page. Viewport captures avoid full-page stitching of fixed navigation.
- Browser test processes and disposable frontends were stopped after checks.

Interventions and resolved failures:

- An initial broad label replacement caused an unrelated goal label to reference
  an out-of-scope variable. Type checking caught it; it was corrected. The first
  UI worker was stopped after its failing run consumed excessive memory, and the
  corrected feature suite and subsequent full suites passed.
- The first Cypress run passed 86/88 tests. Two new quota tests froze the initial
  `setTimeout` before React mounted by faking every clock API. Restricting the fake
  clock to Date and interval APIs allows the real initial request while testing
  periodic refresh deterministically. Coverage and assertions were retained.
- That initial browser run also logged a browser connection timeout; Cypress
  recovered automatically. No installed companion processes were stopped.

Unverified:

- Real cmux launches, installed `xclaude`/`xcodex` aliases, Kimi CLI login and live
  subscription quotas. Tests use fake cmux calls, synthetic provider payloads and
  intercepted browser APIs; no provider credentials or installed sessions were
  exercised.
- Kimi endpoint compatibility beyond the inspected upstream implementation and
  fixtures. An incompatible/error response displays unavailable or unreported
  usage, never an inferred quota.
- Merge, installation, deployment and release were not performed.
