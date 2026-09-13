# cmux companion

A private, mobile-first companion for [cmux](https://cmux.com). It runs on your Mac, stays on automatically, and lets your phone monitor or interact with cmux over your existing Tailscale network.

No cloud application server is involved. Terminal output and input travel directly between your phone and Mac.

## What it does

- Monitors cmux sessions, terminal replay, repository changes and process health from a paired phone.
- Provides an Inbox for native agent questions and permissions, manual repository launches, prompt queues and private local-app previews.
- Opens `/orchestration` for a goal workflow with a reviewed plan and explicit approval, parallel implementers in isolated worktrees, independent code review, serialized integration and one verified pull request.
- Shows task dependencies, workers, review findings, verification and publication evidence, with revision, retry, abort and reconciliation actions derived by the service.
- Keeps account quota and manual-session model settings available without using quota as scheduler policy.

The home screen opens Sessions. Session tools reach Inbox, Local apps and
Orchestration goals. Legacy burst scheduling, issue-topic planning, old goal boards
and automatic session collection have been retired; see the
[retirement inventory and cutover procedure](docs/orchestration-retirement.md).

## Goal workflow

Create a goal for an explicitly configured repository and base commit. The planner
publishes a versioned contract with task ownership, dependencies and verification.
An independent review checks the contract before the user approves that revision.
Requesting changes invalidates the proposal's approval authority.

Eligible independent tasks run concurrently from day one. Each attempt owns an
isolated worktree; dependents start from the integrated commits of their prerequisites.
An independent reviewer checks the exact submitted task commit. Blocking findings
require bounded repair and a fresh review. Integration serializes changes and
preserves conflicts for scoped repair. Final review and configured checks must
agree on the exact goal-branch commit before publication opens one PR.

A stopped process is not proof of a successful task. Uncertain ownership blocks
replacement work until reconciliation proves the old worker stopped. Aborting
revokes authority and stops admission while retaining evidence and tracking worker
termination. Retrying a request after a lost response uses its original command ID.

## Architecture

See the [core boundary and configuration map](docs/orchestration-architecture.md)
for commands, task graphs, review gates, journal retention and native adapters.

```text
iPhone PWA
    │ private HTTPS + WebSocket
    ▼
Tailscale Serve :8443
    │ loopback proxy
    ▼
cmux companion :3210
    │ allow-listed argv calls
    ▼
cmux CLI → replay grid / safe input RPCs → cmux Unix socket → cmux.app
```

The service binds only to `127.0.0.1`. Tailscale Serve is the only network-facing listener. The documented transport defaults to HTTPS port 8443 to preserve an existing Tailscale Serve handler on port 443; the bundled installer leaves transport configuration to the operator.

Local app previews use separate HTTPS ports from 8500 through 8599. This preserves application root paths, redirects, assets, and WebSockets better than path-prefix proxying. A detected app is not exposed until you tap **Create private link**; links remain tailnet-only and Companion never enables Tailscale Funnel.

By default, the phone reflows the full Mac-width replay grid locally, keeping the Mac terminal unchanged while preserving enough history to scroll. The **Fit** control switches between this readable phone layout and the exact terminal grid. Older cmux versions automatically fall back to the authenticated plain-text screen endpoint.

The explicit `configure-cmux-automation.mjs` setup step enables cmux’s supported password-protected automation mode. It creates a separate socket credential at `~/.config/cmux-companion/cmux-socket-password` and makes a timestamped `cmux.json.*.bak` before changing cmux configuration.

## Requirements

- macOS with cmux installed in `/Applications/cmux.app`
- Node.js 22.23.1 (the supported Node 22 runtime is pinned in `.nvmrc`)
- Tailscale connected on both the Mac and phone

## Install

The updater is bundled in this repository. Fresh installations use `npm run
install:mac` from a reviewed committed checkout, then explicit cmux automation and
private Tailscale setup. Existing installations require a guarded migration after
stopping their identified owners. See [installation, updates and recovery](docs/updates.md).

Settings offers an update notice, **Update now**, **Update when idle**, and an
**Automatic installation** toggle that defaults **off**. Only exact main commits
with successful CI qualify. Installation waits for safely idle agents and retains
verified recovery of the previous compatible version. Checking alone never
installs. Source review, merge and local tests do not change installed services.

## Daily use

Open a session to inspect terminal output, tasks and Git changes. Enable terminal
input explicitly before sending text or safe keys. The session menu contains
terminal selection, display controls, shortcuts and local apps. Inbox decisions
remain scoped to their native request. Model defaults in Settings apply only to
new manual coding sessions; orchestration models are operator-configured.

Use `/orchestration` for saved goals. Read-only configuration disables workflow
mutations in both the UI and service. Existing installations must complete the
[guarded cutover procedure](docs/orchestration-retirement.md) before starting this
version; source review or a successful build does not perform cutover.

## Local end-to-end checks

Regular Cypress uses deterministic monitoring API fixtures. The orchestration
run uses the real backend, SQLite, temporary Git repositories and bare remote,
with scripted agents and fake GitHub. No private account is required.

```sh
npm run test:e2e:local
npm run test:e2e:local -- --orchestration --spec cypress/e2e/orchestration-core.cy.ts
npm run test:e2e:local -- --orchestration --read-only --spec cypress/e2e/orchestration-core.cy.ts
```

Use `CMUX_COMPANION_CYPRESS_PORT` if port 3221 is occupied. If Electron fails,
set `CMUX_COMPANION_CYPRESS_BROWSER=chrome`. Never kill a port's existing owner.
Cypress is separate from `npm test`, `npm run verify` and CI. The fixture journey
verifies overlapping implementers, dependent integration, review/check repair,
abort/reconciliation, reload and one PR at the verified Git commit. See
[disposable development](docs/orchestration-development.md) for retained evidence.

Live cmux, Tailscale, native-provider and GitHub checks require separate explicit
authorization. `test:live` and `test:preview-live` exercise live services; they are
not routine verification. Native adapter live prerequisites and opt-ins are in
[the adapter guide](docs/orchestration-native-adapters.md).

## Security model

- The HTTP service listens on loopback only.
- Tailscale Serve provides private HTTPS transport and tailnet identity headers.
- Tailscale membership alone is not enough: every browser must also pair.
- The browser receives an HttpOnly, SameSite=Strict session cookie.
- State-changing requests enforce same-origin checks.
- cmux identifiers must be full UUIDs.
- Terminal input, keys, and text length are explicitly validated.
- No route accepts a shell command, arbitrary cmux arguments, or arbitrary RPC.
- Repository launch is restricted to immediate Git repositories in configured roots; package scripts must come from that repository's `package.json`.
- Session identity is exported with a strict variable-name pattern and shell-quoted values, so neither a goal nor a task title can become a command.
- Git diff requests are restricted to files currently reported as changed, and untracked symlink content is hidden.
- The CLI is spawned with argv arrays and never through a shell.
- Read-only protection is enabled by default on each phone.
- Push subscriptions and VAPID keys stay in a mode-`0600` file on the Mac; notification content is hidden by default.
- Alert categories, quiet hours, persistent deduplication, and lock-screen privacy are configurable per phone.
- Markdown reads are restricted to regular `.md`/`.markdown` files inside allow-listed repositories; canonical paths block traversal and out-of-repo symlinks, rendered HTML is not executed, and local images are type and size restricted.
- Preview targets must be localhost TCP ports. Tailscale HTTPS ports are allocated from a bounded range, can be stopped from the Apps screen, and are never exposed with Funnel.
- Preview capture runs in headless Chrome with every non-loopback request blocked; annotated screenshots use the same private attachment validation and retention policy.
- Queued prompts are stored in a mode-`0600` file and can target only validated cmux workspace and terminal identifiers.
- Pasted images are magic-byte validated, limited to 8 MB, stored with mode `0600`, and removed automatically after seven days.

Treat a paired phone as privileged: unlocking terminal input gives it control of interactive processes running in cmux.

## Development

Use Node 22.23.1 from `.nvmrc` (`nvm install && nvm use`), then `npm ci`.
Keep the checked-in npm lockfile. The account-free contributor path is:

```sh
npm run orchestration:dev -- --port 3211
```

The command prints private manifest/token file paths, never the token. In a second
terminal set `CMUX_COMPANION_API` to the printed loopback address and run
`npm run dev`. Open `http://localhost:3000/orchestration` and pair using the private
disposable token. Ctrl-C stops owned fixture resources; a failed shutdown keeps
them for inspection. See [the development guide](docs/orchestration-development.md).
Production `companion:dev` uses local settings/onboarding and is not the disposable
contributor entry point; existing legacy configuration still requires cutover.

```sh
npm run verify
npm run test:coverage
npm run test:ui:coverage
```

`verify` runs backend tests, UI tests, lint, TypeScript checks and build. Both
backend and UI line coverage must remain at least 90%. Run Cypress separately
as above. These checks require no cmux, CCS accounts, Tailscale or GitHub login.
Do not run installer, updater, live tests, merge or deployment as part of local
verification. Settings → Deployments reports installed release health; source
changes do not update that installation.

## Configuration

New installations need no environment configuration: pair and open `/onboarding`
to add named Dev repos (folders containing Git repositories), choose repositories,
and configure Claude/Codex and local preferences. `/settings`
keeps them in a private SQLite registry. See [settings and migration](docs/settings-onboarding.md).
Existing installations can import their private orchestration/model JSON once;
repository ownership and [cutover](docs/orchestration-retirement.md) safeguards
still apply. The legacy JSON startup path is retained only until a settings
database exists.
Git on the service's `PATH` must support `merge-tree --write-tree`,
`--no-messages` and `--merge-base` (upstream Git 2.40 or newer). Production probes
these options before reserving repository ownership or constructing agents;
an unsupported installation fails with `UNSUPPORTED_CAPABILITY`. Install a
supported Git and restart with its directory on the service's `PATH`.
Capacity defaults are `global: 4`, `perGoal: 4`, `planners: 2`, each a positive
integer. Background `ceilingMs`, `idleMs`, `maxOutputBytes` and `killGraceMs` are
mandatory positive integers no larger than 2147483647. Interactive planner
sessions do not inherit background execution timers. Native adapters further limit captured output to 2 MiB and terminal termination
grace to 30000 ms. Journal/evidence retention
and recovery are documented in [recovery](docs/orchestration-recovery.md).
`.env.example` is a reference, not automatically loaded by the Node entry point.


| Variable | Default | Purpose |
| --- | --- | --- |
| `CMUX_BIN` | `/Applications/cmux.app/Contents/Resources/bin/cmux` | cmux CLI location |
| `CMUX_COMPANION_HOST` | `127.0.0.1` | Local bind address |
| `CMUX_COMPANION_PORT` | `3210` | Companion HTTP port |
| `CMUX_COMPANION_FRONTEND_PORT` | `3211` | Internal PWA server port |
| `CMUX_COMPANION_TAILSCALE_PORT` | `8443` | Private HTTPS port |
| `CMUX_COMPANION_TAILSCALE_BIN` | Tailscale macOS app CLI, then `tailscale` | CLI used to manage private preview links |
| `CMUX_COMPANION_TOKEN_FILE` | `~/.config/cmux-companion/token` | Pairing token path |
| `CMUX_COMPANION_DATA_DIR` | `~/.config/cmux-companion` | Local settings, workflow and artifact directory |
| `CMUX_COMPANION_SETTINGS_DB` | `<data directory>/settings.sqlite` | Optional settings database location |
| `CMUX_COMPANION_REPO_ROOTS` | Empty | Legacy catalog override; database-backed production uses explicit projects |
| `CMUX_COMPANION_PUSH_FILE` | `~/.config/cmux-companion/push.json` | Private push keys and device subscriptions |
| `CMUX_COMPANION_VAPID_SUBJECT` | Installed private Tailscale HTTPS URL | Web Push sender identity advertised to Apple and other push services |
| `CMUX_COMPANION_PREVIEWS_FILE` | `~/.config/cmux-companion/previews.json` | Managed private preview registry |
| `CMUX_COMPANION_QUEUE_FILE` | `~/.config/cmux-companion/prompt-queue.json` | Persistent follow-up prompt queue |
| `CMUX_COMPANION_REPO_DB` | `~/.config/cmux-companion/repo-identity.db` | Rebuildable SQLite repository/worktree cache |
| `CMUX_COMPANION_CHROME_BIN` | Google Chrome, Chromium, or Edge in `/Applications` | Browser executable used for private preview capture |
| `CCS_BIN` | First `ccs` executable in `PATH`, then installed NVM versions | Optional explicit CCS executable used to discover structured account quota support |
| `CMUX_COMPANION_PREVIEW_PORT_START` | `8500` | First Tailscale HTTPS preview port |
| `CMUX_COMPANION_PREVIEW_PORT_END` | `8599` | Last Tailscale HTTPS preview port |

## Troubleshooting

- **Phone cannot connect:** confirm Tailscale is connected on both devices and run `npm run status`.
- **Waiting for cmux:** open cmux on the Mac. The companion will reconnect without a restart.
- **Mac is sleeping:** Tailscale and the companion cannot respond while macOS is asleep.
- **Logs:** inspect `~/Library/Logs/cmux-companion.log` and `~/Library/Logs/cmux-companion.error.log`.
- **Installed upgrade:** complete the bundled migration and cutover prerequisites above before restarting with this source.

## License

MIT
