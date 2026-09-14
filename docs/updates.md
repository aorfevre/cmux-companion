# Updates and bundled installation

Companion includes its updater. No sibling checkout or second GitHub repository
is required. The application and updater come from one Companion commit, but the
updater runs in a separate process with a stable recovery bootstrap.

## Phone controls

Settings → Companion updates shows the installed version, last check, available
commit and changes link. A notice also appears in the app. **Later** dismisses that
candidate on this device; future candidates can notify again.

**Automatic installation is off by default.** Checking remains enabled every five
minutes while the Mac is awake and online. Check for updates requests an earlier
check. The separate updater processes requests within its five-second loop.

Unlock update controls on the settings page (or turn off the Sessions page's
read-only protection), choose **Update now** or **Update when idle**, and confirm
the displayed commit. Approval never moves to a newer commit. Update now refuses
busy work; Update when idle waits. Cancel queued update revokes the queued request.

The Automatic installation toggle explicitly authorizes future eligible commits.
It is shared by the installation and persists across restart and reinstall.
Disabling it cancels automatic requests that have not started, while preserving
manual approvals, checks and notifications. A started transaction must finish or
recover safely. Cancelling an automatic candidate suppresses its requeue until a
manual request or explicit off/on opt-in. Failed candidates require explicit Retry
update; automatic mode cannot repeatedly retry a quarantined failure.

Only a main descendant with a successful **push** run of the repository's
`.github/workflows/verify.yml` is eligible. The newest run/attempt must succeed;
PR runs and other workflows do not qualify. `gh` must be installed and authenticated with read access to the
configured GitHub repository and Actions runs. Network, CI and authentication
failures preserve the running installation. Discovery inspects a bounded window
of 100 main commits; no eligible candidate in that window means no update offered.
GitHub Enterprise and alternate channels are not supported in this version.

## Fresh installation

Select Node from `.nvmrc`, run `npm ci`, and use an authenticated `gh` where the
repository requires it. The source checkout's `origin` must identify the trusted
GitHub Companion repository (including your fork). The installer resolves the
stable primary checkout automatically; it never resets developer worktrees.

From an explicitly selected committed checkout:

```sh
npm run install:mac
```

The installer stages and verifies that exact source commit. This explicit first
installation is distinct from background eligibility checks. It creates one release
store at `~/.local/share/cmux-companion/releases/<sha>` and generic LaunchAgents
`org.cmux-companion.service` and `org.cmux-companion.updater`. The updater's stable
bootstrap and Companion launcher live in `~/.local/libexec`.

Configure cmux's supported password-protected automation explicitly:

```sh
node scripts/configure-cmux-automation.mjs
```

Then pair through localhost and configure projects/tools at `/onboarding`. The
pairing token is at `~/.config/cmux-companion/token`; read it locally without
including it in logs or screenshots. Configure Tailscale Serve for the chosen
Companion loopback port through your existing operator procedure. The bundled
installer does not replace Tailscale handlers or change cmux configuration as a
side effect of installing an application release.

Optional exported bootstrap overrides before installation:
`CMUX_COMPANION_PORT`, `CMUX_COMPANION_FRONTEND_PORT`, `CMUX_COMPANION_DATA_DIR`,
`CMUX_COMPANION_SETTINGS_DB` and `CMUX_COMPANION_TOKEN_FILE`. Service ports must be
distinct and above 1023. The actual launch environment persists these selections.
Ordinary projects, tools and provider preferences remain in Settings.

## Existing installations

Migration is a separate operator operation, not part of source review or merge.
Do not run the old and bundled updater simultaneously.

1. Identify the old services and owned work. Finish or explicitly retire active
   goals using their existing service; preserve all private data and evidence.
2. Stop/unload only the identified old Companion and updater LaunchAgents. Merely
   disabling automatic updates does not unload a registered owner. Finish or recover
   any existing updater transaction before proceeding.
3. Take a consistent private backup and record the actual persisted data directory,
   settings path and pairing-token path. Complete settings/orchestration cutover
   first if the old release predates those supported contracts.
4. Export those explicit paths and run `npm run install:mac -- --migrate` from the
   reviewed committed source. Legacy migration requires explicit data-directory
   and token-file values; it does not infer them from an old shell session.
5. The installer refuses active transactions, registered old/new owners or unsupported
   data contracts. It retains configuration/plist backups and the old release stores.
   On success it removes the backed-up legacy plist files so login cannot revive
   the old updater. Existing legacy `enabled: true` is not automatic opt-in.
6. Rehearse installed startup, cmux continuity and recovery separately before
   trusting unattended operation. Unsupported migration/data contracts require
   an explicit migration design; bypassing the refusal is not supported.

## Activation and recovery

Before staging, the service proves agents/effects are idle and installs a durable
admission fence. Unknown Companion-owned worker state and in-flight Companion
commands block activation. HTTP mutations, orchestration scheduling and queued
prompts respect the fence. Unrelated cmux sessions do not block an update and
remain open; Companion-managed work must finish before activation.

The updater stages an isolated release and validates it locally. Build commands
have an independent watchdog and durable process receipts; restart cannot launch
a duplicate build over uncertain prior ownership. The release manifest binds
`server/data-contract.json`, which declares settings and orchestration format
versions. Matching supported contracts allow compatible implementation changes;
recognized legacy releases have explicitly tested compatibility. Unknown or
incompatible contracts are refused rather than treated as a safe binary rollback.
It takes private SQLite backups before activation and checks the fence again.

After atomically switching `current`, the new service must report the exact SHA,
serve the frontend and load its referenced assets. The maintenance fence remains
active during startup. On failure, the updater stops the service, verifies it has
stopped, restores only the backed-up application databases, restores the previous
release and verifies its health. Credentials, artifacts and unrelated resources
are not overwritten by database restoration. If recovery cannot be verified,
maintenance stays active and further installation is refused.

Inspect local updater logs and private state before intervention. For an activation
recovery with verified backup evidence, the fixed operator command can explicitly
retry that retained recovery transaction:

```sh
node updater/scripts/operator.mjs recover <request-id>
```

It does not bypass ownership or database checks. For a preparation failure, the
same command reconciles every recorded build watchdog outcome and releases
maintenance only when each worker is proven stopped (including verified prior-boot
evidence). Running, missing or uncertain evidence refuses recovery. Do not delete
the control database, fence or transaction to force progress.

Operator `check`, `enable`, `disable`, `retry`, `install <sha> [--when-idle]` and
`cancel <request-id>` all use the same durable control protocol. `enable` is an
explicit opt-in to automatic installation. Retention remains separately opt-in
and preserves the running release, rollback target and uncertain evidence.

## Troubleshooting an update

Follow the update through four stages:

1. **Eligibility:** the exact main commit needs a successful main-push Verify run.
   A merge or passing PR check alone does not make it installable.
2. **Discovery:** inspect the last check and available commit in Settings →
   Companion updates. Use Check for updates after CI finishes. Automatic
   installation must be enabled for unattended installation.
3. **Preparation:** the updater waits for Companion-managed work, stages the
   candidate and verifies it. An open unrelated cmux session is not a reason to
   close terminals. A failed candidate is quarantined; inspect the failure before
   explicitly choosing Retry update.
4. **Activation:** success requires the running service to report the target SHA
   and pass frontend health checks. A successful discovery check is not evidence
   that the application updated. To verify automatic installation, confirm a
   succeeded request with source `automatic` and a matching running SHA through
   the authenticated updater and health APIs.

“This update requires a supported data migration. The running version was
preserved.” identifies a compatibility refusal. Do not edit contract versions or
remove safety state to force acceptance. Older updater engines can report the
less specific “The update could not be prepared safely” for the same problem.
If an old engine cannot install its own repair, an operator may need one backed-up
installation of the reviewed, verified repair release using the bundled installer,
after checking owned work and transaction recovery. This is a manual repair;
verify a later automatic version transition before claiming self-update works.
Never include pairing tokens or private database contents in troubleshooting logs.

## Validation boundary

Local unit, UI and Cypress checks use temporary repositories/databases and fake
GitHub/launchd/activation effects. They do not prove real launchd migration, live
GitHub eligibility, installed native cmux continuity or operator recovery. These
remain separately authorized acceptance paths. See the delivery report for the
specific checks run on this change.
