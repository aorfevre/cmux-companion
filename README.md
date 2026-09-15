# cmux companion

A private, desktop-first responsive companion for [cmux](https://cmux.com). It runs on your Mac, stays on automatically, and lets your phone monitor or interact with cmux over your existing Tailscale network.

No cloud application server is involved. Terminal output and input travel directly between your phone and Mac.

## What it does

- Opens desktop-first Mission Control with a goal fleet, Needs You decisions,
  active wave/worker status and responsive goal workspaces.
- Saves briefs, links and private source/image references for scoped agent access.
- Runs planning/design, independent review and implementation in visible cmux
  sessions, with isolated worktrees and verified integration barriers between waves.
- Approves the plan and suggested team together, holds failed goals for manual
  recovery and requires exact-commit approval before publishing a pull request.
- Passively checks waiting GitHub PRs every 15 minutes; only confirmed merges
  move goals to Complete. Companion does not merge PRs.
- Keeps standalone session inspection/input, private pairing and the bundled updater.
- Setup manages projects, supported launch profiles, team defaults, account usage,
  execution limits, device protection and updater controls.

The remaining legacy session surfaces are being retired under the
[Mission Control delivery contract](docs/superpowers/specs/2026-09-15-mission-control-redesign.md).
See the [delivery evidence](docs/mission-control-delivery-evidence.md) for completed
and outstanding redesign work.

## Goal workflow

Select a tracked project, describe the outcome and click **Start goal**. A Planning
card appears immediately. Companion fetches the configured remote's latest `main`,
pins its exact commit and starts one named planner in an isolated worktree; it does
not switch, pull or reset your current checkout. Advanced allows another explicit
base branch. A failed fetch/provider check stays on the card with Retry startup.

The planner name is `<Project Code> Planning <short goal title>`; the project code
defaults to its normalized uppercase project name. The card keeps the complete
request and links in its description. Its short title is editable; the assigned
planner/session name remains stable for that attempt's identity.

Follow Planning → Needs approval → In progress → Review → Verification → Ready
to publish → Waiting for merge → Complete. Open a fleet row for Overview,
Waves & sessions, Team & models, Run report and Activity. Needs You collects
questions, approvals and manual recovery actions.

The planner publishes a versioned contract with task ownership, dependencies and
verification. Essential questions appear inside the goal; answering resumes
planning automatically after the prior worker is confirmed stopped. The agent discovers suitable verification from the project and goal; repository checks are optional defaults, never required setup. If validation is missing, the plan must address that gap. An independent review checks the contract before the user approves that revision and its exact verification commands.
Requesting changes invalidates the proposal's approval authority.

Eligible independent tasks run concurrently from day one. Each attempt owns an
isolated worktree. Later waves start only after the previous wave is accepted,
integrated and verified; their attempts use that checked output.
An independent reviewer checks the exact submitted task commit. Blocking findings
hold new dispatch for manual recovery, bounded repair and a fresh review. Integration serializes changes and
preserves conflicts for scoped repair. Final review and approved goal checks must
agree on the exact goal-branch commit before publication approval can open one PR.

A stopped process is not proof of a successful task. Uncertain ownership blocks
replacement work until reconciliation proves the old worker stopped. Aborting
revokes authority and stops admission while retaining evidence and tracking worker
termination. Retrying a request after a lost response uses its original command ID.

## Goal teams and launch profiles

Setup → Agents & models configures Claude/Codex commands, named CCS or terminal launch
profiles, eligible roles and preferred profiles. Goal creation freezes validated
commands, models and readiness so later settings changes cannot redirect saved
work. Each attempt records its actual assignment, including across restart.

The **Team & models** tab explains the suggested planner/designer, implementation,
review and integration assignments. Fresh CCS provider-pool capacity informs the
initial suggestions; unavailable, failed or stale readings remain unknown, never
zero. Capacity is a dated allocation snapshot, not a live account balance or a
promise about which account a command selects. Slow quota services time out
without blocking goal creation. The saved launch command determines the account.

Approve the team together with its design and plan. Manual overrides select ready,
eligible profiles for future attempts; active workers retain their assignments.
Changing an assignment does not release a failure hold or authorize recovery.

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


By default, the phone reflows the full Mac-width replay grid locally, keeping the Mac terminal unchanged while preserving enough history to scroll. The **Fit** control switches between this readable phone layout and the exact terminal grid. Older cmux versions automatically fall back to the authenticated plain-text screen endpoint.

The explicit `configure-cmux-automation.mjs` setup step enables cmux’s supported password-protected automation mode. It creates a separate socket credential at `~/.config/cmux-companion/cmux-socket-password` and makes a timestamped `cmux.json.*.bak` before changing cmux configuration.

## Requirements

**Install [cmux](https://cmux.com) on the same Mac before setting up Companion.**
Companion connects to an existing cmux installation; it does not bundle or install
cmux. Open cmux to make its sessions available for monitoring and agent work.

- macOS with cmux installed (the default location is `/Applications/cmux.app`)
- Node.js 22.23.1 (the supported Node 22 runtime is pinned in `.nvmrc`)
- Tailscale connected on both the Mac and phone
- For goals: a configured and authenticated supported Claude Code or Codex CLI
- For GitHub publication and update discovery: authenticated `gh` with access to
  the selected repository and its Actions runs

| Capability | Supported contract |
| --- | --- |
| Direct Claude planning/execution | Claude Code 2.1.268 |
| Direct Codex planning/execution | Codex CLI 0.154.0 |
| CCS provider profiles | CCS 8.9.0 or 8.10.0, with the matching native CLI above |
| `ccsxp` Codex wrapper | CCS 8.10.0 |
| Monitoring/disposable development | Native provider accounts are not required |

Other native versions fail readiness checks until their contracts are reviewed.
Offline checks do not certify account-backed permission enforcement. See the
[native adapter guide](docs/orchestration-native-adapters.md).

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

### cmux detection and custom installations

Companion initially looks for the CLI at
`/Applications/cmux.app/Contents/Resources/bin/cmux`. Provider readiness checks
report a missing executable; this checks the configured path rather than searching
for every installed copy. If cmux is installed elsewhere, open **Setup → Execution
& tools → Tool paths**, set **cmux executable** to its absolute CLI path, and save.
Use the executable path, not a shell command with arguments. If the executable is
present but Companion shows **Waiting for cmux**, open the cmux app and check the
[automation setup](docs/updates.md#fresh-installation).

### Start automatically at login

`npm run install:mac` creates and loads two per-user LaunchAgents in
`~/Library/LaunchAgents/`: `org.cmux-companion.service.plist` and
`org.cmux-companion.updater.plist`. It registers them with `launchctl bootstrap`
in the current user's GUI session and checks Companion's health. Run installation
as your normal logged-in Mac user; do not use `sudo`. These agents run at login,
not before login, and do not launch the cmux app for you. There is no need to write
or load the plists manually. See [installation and recovery](docs/updates.md)
for existing installations, which must stop their identified owners first.

## Daily use

Open a session to inspect terminal output, tasks and Git changes. Enable terminal
input explicitly before sending text or safe keys. The session menu contains
terminal selection, display controls and shortcuts. Setup manages supported launch
profiles and team defaults. Goal-specific assignments are approved with the plan;
started attempts retain their recorded configuration.

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
authorization. `test:live` exercises live services; it is
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
- Markdown reads are restricted to regular `.md`/`.markdown` files inside allow-listed repositories; canonical paths block traversal and out-of-repo symlinks, rendered HTML is not executed, and local images are type and size restricted.
- Pasted images are magic-byte validated, limited to 8 MB, stored with mode `0600`, and removed automatically after seven days.

Treat a paired phone as privileged: unlocking terminal input gives it control of interactive processes running in cmux.

## Data handling

“Private” describes access over your tailnet, not exclusively local computation.
Configured model providers receive the goal context and project content supplied
to their agents. GitHub receives approved pushes/PRs; update discovery queries
GitHub Actions. Account-usage reads contact the configured provider's quota service.
Provider and GitHub retention policies apply to data sent to those services.

Pairing state, settings, goal journals, and private execution artifacts are stored
locally. API responses are not cached by the service worker. A paired device is
privileged: terminal input protection is a local browser preference, not a separate
server permission. Logout clears that browser's cookie; it does not invalidate a
copied cookie. Sessions share the installation's pairing credential and last up to
one year. To revoke all devices, stop the owned service, replace its token with a
new generated credential, restart, and pair devices again; there is no per-device
revocation interface. Never include these files or credentials in public reports.

Report vulnerabilities through [SECURITY.md](SECURITY.md). See
[CONTRIBUTING.md](CONTRIBUTING.md) for the contributor entry point.

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
backend and UI line coverage must remain at least 90%; `npm run verify` enforces
both thresholds. CI also requires `npm run test:mac` on a macOS runner. Run Cypress separately
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
| `CMUX_COMPANION_TOKEN_FILE` | `~/.config/cmux-companion/token` | Pairing token path |
| `CMUX_COMPANION_DATA_DIR` | `~/.config/cmux-companion` | Local settings, workflow and artifact directory |
| `CMUX_COMPANION_SETTINGS_DB` | `<data directory>/settings.sqlite` | Optional settings database location |
| `CMUX_COMPANION_REPO_ROOTS` | Empty | Legacy catalog override; database-backed production uses explicit projects |
| `CMUX_COMPANION_VAPID_SUBJECT` | Installed private Tailscale HTTPS URL | Web Push sender identity advertised to Apple and other push services |
| `CMUX_COMPANION_REPO_DB` | `~/.config/cmux-companion/repo-identity.db` | Rebuildable SQLite repository/worktree cache |
| `CCS_BIN` | First `ccs` executable in `PATH`, then installed NVM versions | Optional explicit CCS executable used to discover structured account quota support |

## Troubleshooting

- **Phone cannot connect:** confirm Tailscale is connected on both devices and run `npm run status`.
- **Waiting for cmux:** open cmux on the Mac. The companion will reconnect without a restart.
- **Mac is sleeping:** Tailscale and the companion cannot respond while macOS is asleep.
- **Logs:** inspect `~/Library/Logs/cmux-companion.log` and `~/Library/Logs/cmux-companion.error.log`.
- **Installed upgrade:** complete the bundled migration and cutover prerequisites above before restarting with this source.

## License

MIT

### Goal briefs and reference files

A goal has a full brief (including links) and an optional short title. When the
initial title is omitted, Companion derives it from the brief. Attach up to eight
files of at most 1 MiB each: UTF-8 text/source files, PNG, JPEG or WebP images.
PDF, Office documents, archives and other binary formats are not supported.
HTML and SVG are treated as plain text and downloaded as attachments.

References are saved privately on the Mac with the goal. Paired devices can open
references from the goal's Overview. Agents read only their own goal's references
through their scoped bridge; reviewer access remains read-only. Reference content
is source material and cannot grant permissions or expand the approved scope.

### Execution waves

The combined planner, architect and designer proposes ordered waves in contract
schema version 2. Every task belongs to one wave and declares owned paths and
shared resources. Tasks in the same wave must be independent; dependencies point
to earlier waves. Each wave names checks from the approved contract, and the last
wave runs every required check.

Companion reviews and integrates task results, then checks the combined commit
before starting the next wave from that exact output. Failed checks hold the goal
for manual recovery. Checked wave commits remain in the journal after restart;
replanning requires renewed approval. Existing version 1 journal contracts retain
their recorded dependency behavior. New planning prompts and tools use version 2.

### Notification settings

Settings → Notifications controls in-app update notices and opt-in background
Web Push for each browser/PWA. See [device setup, privacy, recovery and delivery
limits](docs/notifications.md). The Mac must stay awake and online; iPhone push
requires a supported Home Screen installation.

## Pull request review

Goal PRs are created as drafts and promoted after completed, reviewed, verified
work and human publication approval. CodeRabbit reviews ready PRs; protected
auto-merge additionally requires current CI, its approval and resolved discussions.
See [review configuration and activation](docs/code-review-workflow.md).
