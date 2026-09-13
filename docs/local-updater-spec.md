# Local Updater Specification

Status: Historical unattended-update design; notification and installation policy
is superseded by [the bundled manual-update contract](superpowers/specs/2026-09-13-manual-self-update-design.md)
approved and delivered in PR #117. This document is retained only as historical
recovery/migration context; use [the current operator guide](updates.md) for setup.
Target platform: macOS  
Repository: `aorfevre/cmux-companion`  
Default channel: `origin/main`

## 1. Purpose

CMUX Companion should detect, validate, install, and activate new commits from its configured Git branch without requiring a person to pull, rebuild, or restart it. The updater must also update its own implementation and bootstrap safely.

The expected steady-state detection latency is 30 seconds or less while the Mac is awake and online. The system must not expose a public webhook endpoint.

## 2. Goals

The updater must:

- poll the configured Git remote without materially affecting CPU usage;
- deploy a new `main` commit without modifying or blocking unrelated developer worktrees;
- build and validate a candidate before stopping the running service;
- switch releases atomically;
- restart Companion and verify its health;
- roll back automatically when the new release does not become healthy;
- resume safely after sleep, network loss, process termination, or power loss;
- update both its versioned update engine and its stable bootstrap;
- retain enough state and logs to explain every decision;
- preserve the Companion pairing token, push configuration, Tailscale configuration, and cmux sessions;
- require no inbound connection from GitHub.

## 3. Non-goals

The first version will not:

- accept GitHub webhooks or enable Tailscale Funnel;
- deploy arbitrary branches selected remotely;
- update macOS, Node.js, cmux, Tailscale, or CCS;
- merge non-fast-forward histories or recover from a force-pushed update channel automatically;
- overwrite a dirty primary checkout;
- delete developer-created Git worktrees;
- guarantee uninterrupted browser connectivity during the short service restart;
- provide fleet management for multiple Macs.

## 4. User experience

Once installed, updates require no routine interaction.

1. A commit is merged into `main`.
2. The Mac detects it within approximately 15 seconds on average.
3. The candidate is prepared while the existing Companion remains available.
4. Companion restarts after the candidate passes validation.
5. The PWA reconnects automatically. cmux workspaces and terminals continue running.
6. A macOS notification reports a successful update or an actionable failure.

When the Mac is asleep or offline, the update starts on the next eligible polling cycle after wake or reconnection.

## 5. Architecture

The updater consists of four layers:

```text
macOS LaunchAgent (every 30 seconds)
        │
        ▼
stable updater bootstrap
~/.local/libexec/cmux-companion-updater
        │ chooses current or candidate engine
        ▼
versioned update engine
<release>/scripts/local-updater.mjs
        │ stages, verifies, activates, rolls back
        ▼
versioned Companion releases
~/.local/share/cmux-companion/releases/<git-sha>/
        │
        └── current -> releases/<deployed-sha>
```

The running Companion service must execute from the `current` release link rather than directly from the developer checkout. The developer checkout remains the trusted Git object source and an optional human-readable checkout of `main`.

### 5.1 Stable bootstrap

The bootstrap is a minimal executable installed outside the Git checkout. It owns:

- the global update lock;
- transaction discovery;
- selection of the current or pending update engine;
- bounded self-update handoffs;
- atomic replacement of its own executable;
- final exit-code reporting to launchd.

The bootstrap must contain no Git, npm, build, or service-management policy. Those behaviors belong to the versioned engine.

### 5.2 Versioned update engine

Each release contains its own update engine. The engine owns:

- remote commit discovery;
- candidate creation and validation;
- release activation;
- Companion restart and health checks;
- rollback;
- state transitions, notifications, and cleanup;
- preparing a newer bootstrap when its bundled bootstrap differs.

### 5.3 Release store

Every candidate is prepared in a unique release directory keyed by its full Git commit SHA. A release is immutable after it reaches the `ready` state.

Activation changes only the `current` symbolic link and restarts the service. It must not copy files over the active release.

### 5.4 LaunchAgents

Two user LaunchAgents are required:

- `com.aorfevre.cmux-companion`: runs the Companion service from `current` and retains the existing automatic-start behavior.
- `com.aorfevre.cmux-companion-updater`: runs the stable bootstrap at login and every 30 seconds.

The updater job is one-shot and must not use `KeepAlive`. launchd provides scheduling; the bootstrap exits after each check or transaction.

## 6. Filesystem layout

```text
~/.config/cmux-companion/
├── token
├── updater.json
└── updater/
    ├── state.json
    ├── transaction.json
    ├── lock/
    ├── bootstrap.next
    └── notifications.json

~/.local/libexec/
├── cmux-companion-updater
└── cmux-companion-launch

~/.local/share/cmux-companion/
├── current -> releases/<sha>
├── previous -> releases/<sha>
└── releases/
    └── <sha>/

~/Library/LaunchAgents/
├── com.aorfevre.cmux-companion.plist
└── com.aorfevre.cmux-companion-updater.plist

~/Library/Logs/
├── cmux-companion.log
├── cmux-companion.error.log
├── cmux-companion-updater.log
└── cmux-companion-updater.error.log
```

Configuration and state directories must use mode `0700`. State, handoff, and credential-bearing files must use mode `0600`.

## 7. Configuration

`~/.config/cmux-companion/updater.json` contains:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "repositoryPath": "/Users/example/Projects/cmux-companion",
  "expectedRemote": "https://github.com/aorfevre/cmux-companion.git",
  "remote": "origin",
  "branch": "main",
  "pollSeconds": 30,
  "healthUrl": "http://127.0.0.1:3210/api/health",
  "healthTimeoutSeconds": 30,
  "retainGoodReleases": 2,
  "notifyOnSuccess": true,
  "notifyOnFailure": true
}
```

The installer must resolve and store absolute canonical paths. Runtime environment variables may override configuration for development and tests, but the production LaunchAgent should use the file.

## 8. Persistent state

`state.json` must be written through a temporary file followed by an atomic rename. Its minimum schema is:

```json
{
  "schemaVersion": 1,
  "deployedSha": null,
  "previousSha": null,
  "observedRemoteSha": null,
  "pendingSha": null,
  "quarantinedSha": null,
  "phase": "idle",
  "lastCheckAt": null,
  "lastSuccessAt": null,
  "lastFailureAt": null,
  "lastError": null,
  "consecutiveFailures": 0,
  "nextEligibleCheckAt": null,
  "engineVersion": null,
  "bootstrapVersion": null
}
```

`phase` is one of:

- `idle`
- `discovering`
- `fetching`
- `staging`
- `installing`
- `building`
- `verifying`
- `handoff`
- `activating`
- `restarting`
- `health-checking`
- `rolling-back`
- `failed`

The state file is diagnostic data, not sole proof of the active release. The updater must reconcile it with the `current` link and running health endpoint on every invocation.

## 9. Polling and discovery

The default poll interval is 30 seconds. The lightweight discovery operation is:

```bash
git ls-remote --exit-code origin refs/heads/main
```

All subprocesses must be invoked with argument arrays, never through a shell. Discovery must have a 10-second timeout.

If the discovered SHA equals `deployedSha` and no incomplete transaction exists, the updater records `lastCheckAt` and exits without fetching, installing dependencies, building, or restarting.

The updater must use exponential retry eligibility after network failures: 30 seconds, 60 seconds, 2 minutes, then 5 minutes maximum. launchd may continue invoking it every 30 seconds; invocations before `nextEligibleCheckAt` exit locally without network access.

## 10. Update transaction

For a new remote SHA, the engine performs the following ordered transaction.

### 10.1 Preflight

The updater must verify:

- the configured repository and `.git` common directory exist;
- the configured remote URL matches `expectedRemote` after normalization;
- the target ref resolves to a full 40-character commit SHA;
- no other updater owns the lock;
- there is enough free disk space for one additional release;
- the candidate is not currently quarantined;
- the candidate is a descendant of `deployedSha`, when a deployed SHA exists.

A non-fast-forward channel change must stop with a visible error. The updater must never use `reset --hard`, force checkout, force push, or automatic conflict resolution.

### 10.2 Fetch

Fetch the exact configured branch and verify that the fetched ref still matches the discovered SHA. If the branch changes during the transaction, finish or discard the current candidate deterministically and process the newer SHA in a later cycle.

### 10.3 Stage candidate

Create `<sha>` at its final path as a detached Git worktree at the fetched commit. A missing ready manifest identifies it as an unfinished candidate. The updater must only create and remove worktrees inside its configured release root.

The release directory must not be renamed after `git worktree add`: Git records the linked worktree's administrative path. Finalization is represented by an atomic manifest write, not a directory rename.

The developer checkout may be dirty or on another branch; it must not block deployment. Existing developer worktrees must remain untouched.

### 10.4 Install and build

Within the staging release:

1. verify `package.json` and the lockfile are regular files from the candidate commit;
2. run `npm ci` with a bounded timeout;
3. run `npm run build` with a bounded timeout;
4. run the updater-specific smoke tests;
5. verify the expected production entry points and build artifacts exist.

The active service remains running throughout staging and build.

### 10.5 Candidate manifest

After a successful build, write `release-manifest.json` containing:

- schema version;
- full Git SHA;
- build timestamp;
- Node and npm versions;
- update engine version and SHA-256 digest;
- bootstrap version and SHA-256 digest;
- service launcher digest;
- expected production entry points;
- verification commands completed.

Write the manifest through a temporary file and atomically rename it to `release-manifest.json`. The manifest's presence marks the release ready. No file inside the finalized release may be modified afterward.

### 10.6 Self-update handoff

Before activation, compare the candidate engine and bootstrap versions with the currently running versions.

If the update engine changed:

1. write `transaction.json` with the transaction ID, candidate SHA, candidate path, expected engine digest, current phase, and handoff count;
2. exit with code `75`;
3. the stable bootstrap validates the transaction path and digest;
4. the bootstrap invokes the candidate engine with `--resume <transaction-id>`;
5. the candidate engine resumes at the first incomplete idempotent phase.

If the stable bootstrap changed:

1. the candidate engine writes the new bootstrap to `bootstrap.next` with mode `0700`;
2. it records the expected digest and requests bootstrap replacement with exit code `76`;
3. the running bootstrap validates the file and atomically renames it over its installed path;
4. the new bootstrap re-executes the candidate engine with the same transaction ID.

The bootstrap must permit no more than two handoffs per transaction. Exceeding the limit fails safely without activating the candidate.

Backward compatibility requirement: every candidate bootstrap must understand the previous production transaction schema, and every candidate engine must support resuming a transaction created by the previous production engine. A schema migration must be atomic and retain a backup until activation succeeds.

### 10.7 Activate

Activation must:

1. create a temporary symbolic link pointing to the candidate release;
2. atomically rename it to `current`;
3. retain the prior target as `previous`;
4. kickstart `com.aorfevre.cmux-companion`;
5. poll the health endpoint until the configured timeout.

The health response must identify the running Git SHA. A generic HTTP 200 from an old process is insufficient.

### 10.8 Commit success

After the candidate reports healthy:

- set `deployedSha` to the candidate SHA;
- clear `pendingSha`, transaction state, failure state, and quarantine for older SHAs;
- record updater and bootstrap versions;
- notify success;
- clean old releases according to retention policy;
- optionally fast-forward the primary checkout only when it is clean, on the configured branch, and can fast-forward.

Failure to fast-forward the developer checkout must not mark deployment as failed.

## 11. Rollback

If the new service exits early or fails health verification:

1. atomically repoint `current` to `previous`;
2. kickstart the Companion service again;
3. verify the previous release health;
4. mark the candidate SHA as quarantined;
5. retain its logs and manifest;
6. notify failure with the candidate SHA and log path.

A quarantined SHA must not be retried automatically unless:

- the remote branch advances to another SHA;
- the operator explicitly requests a retry; or
- configuration changes invalidate the prior failure reason.

If rollback also fails, the updater must stop retrying service mutations, preserve all releases, emit a high-priority notification, and leave complete recovery instructions in state and logs.

## 12. Crash and interruption recovery

Every phase must be idempotent. On startup, the bootstrap and engine inspect the lock, transaction, state, unfinalized release directories, release manifests, and symlinks.

Recovery rules:

- a lock is stale only when its recorded PID is absent and its age exceeds 15 minutes;
- an unfinalized release directory may be resumed only when its transaction and Git SHA match;
- a finalized release with a valid manifest must never be rebuilt in place;
- an activation interrupted before restart resumes restart and health verification;
- an activation interrupted after link switching but before state persistence reconciles from `current` and the health-reported SHA;
- an orphaned unfinalized release directory older than 24 hours may be removed only after proving it is under the release root and not referenced by a transaction;
- unknown files and developer worktrees are never deleted.

## 13. Service changes

The Companion health endpoint must add:

```json
{
  "ok": true,
  "version": {
    "gitSha": "<40-character-sha>",
    "builtAt": "<ISO-8601 timestamp>"
  }
}
```

The server should expose a paired, read-only updater status endpoint backed by `state.json`:

```text
GET /api/updater/status
```

It may return deployed SHA, observed SHA, phase, timestamps, failure summary, and whether a restart is expected. It must not expose filesystem paths, remote credentials, command output, environment variables, or Git authentication details.

No remote endpoint may directly supply a Git ref, repository path, command, or release path.

## 14. Installer and uninstaller changes

`npm run install:mac` becomes responsible for:

- installing or atomically upgrading the stable launch and updater bootstraps;
- creating the release and state directories with correct permissions;
- seeding the first versioned release from the current verified checkout;
- installing both LaunchAgents;
- switching the Companion LaunchAgent to the stable release launcher;
- enabling and starting both jobs;
- verifying Companion health and updater status.

Re-running the installer must be idempotent.

`npm run uninstall:mac` must stop and remove both LaunchAgents. By default it preserves pairing credentials, updater state, logs, and the latest two good releases. A separately confirmed purge option may remove updater-managed releases and state, but never the developer checkout.

The following local operator commands are required:

| Command | Behavior |
| --- | --- |
| `npm run status` | Include running SHA, deployed SHA, observed remote SHA, updater phase, last successful check, and last safe error. |
| `npm run update:check` | Request one immediate discovery cycle and wait for its result. |
| `npm run update:retry` | Clear quarantine for the currently observed SHA and request one immediate cycle. |
| `npm run update:disable` | Atomically set `enabled` to false; do not uninstall or stop Companion. |
| `npm run update:enable` | Atomically enable polling and request an immediate cycle. |

These commands communicate through updater state and launchctl. They must not duplicate update logic or bypass locking, validation, staging, health checks, or rollback.

## 15. Resource limits

- Normal unchanged poll: target under 2 seconds wall time and negligible sustained CPU.
- Network discovery timeout: 10 seconds.
- One update transaction at a time.
- Default retained releases: current plus two prior successful releases.
- Failed candidate retention: latest failed candidate only, unless needed for rollback diagnostics.
- Log rotation: 5 MB per file, three retained generations.
- Build and install subprocess output: streamed to updater logs with secrets redacted.

## 16. Notifications and observability

The updater must emit structured log records containing timestamp, transaction ID, phase, candidate SHA, duration, result, and a safe error summary.

macOS notifications:

- success: once per deployed SHA;
- transient network failure: silent until the failure persists for at least 15 minutes;
- build or verification failure: immediate;
- rollback: immediate;
- updater disabled because of unsafe Git history or invalid configuration: immediate.

Repeated notifications for the same SHA and failure fingerprint must be deduplicated.

## 17. Security requirements

- No public HTTP listener or Tailscale Funnel.
- No GitHub API token is required for a public repository.
- Private repository credentials, if needed later, remain in the macOS user credential store and are never written to updater state or logs.
- Remote URL, branch, repository path, and release root are installer-controlled configuration.
- Git, npm, launchctl, and filesystem operations use explicit argument arrays and validated absolute paths.
- Candidate and handoff paths must resolve beneath the configured release root.
- Symlinks encountered during cleanup must not be followed.
- Remote history must fast-forward from the deployed SHA.
- Release activation requires a manifest whose SHA and file digests match the candidate.
- The updater never executes code from an unverified path supplied through state alone.
- Merged code and locked dependencies remain trusted execution inputs; automatic updates have the same code-execution trust boundary as manually installing `main`.

## 18. Test plan

### 18.1 Unit tests

- parse and validate remote refs;
- compare deployed, observed, pending, and quarantined SHAs;
- enforce fast-forward ancestry;
- validate canonical paths and reject traversal and symlink escapes;
- acquire, reject, and recover locks;
- persist state and transactions atomically;
- calculate retry backoff;
- enforce release retention without touching unknown worktrees;
- validate manifests and handoff digests;
- cap handoff loops;
- redact errors and command output.

### 18.2 Integration tests

Use temporary local bare Git remotes and repositories to verify:

- no-op polling;
- new commit discovery;
- candidate staging and build;
- existing dirty developer checkout isolation;
- update-engine handoff;
- bootstrap replacement and re-exec;
- restart and SHA-aware health verification;
- build failure with no service interruption;
- health failure and rollback;
- non-fast-forward remote rejection;
- crash recovery in every persisted phase;
- sleep/offline-style missed polling followed by recovery;
- cleanup of updater-owned releases only.

### 18.3 Installed-system tests

- install both LaunchAgents in a disposable user fixture;
- deploy two sequential releases;
- confirm cmux workspaces survive Companion restart;
- confirm the PWA reconnects;
- confirm status output reports running and deployed SHAs;
- uninstall without deleting credentials or the developer checkout.

## 19. Acceptance criteria

The updater is ready when all of the following hold:

- an update to `origin/main` is detected and healthy within 60 seconds while the Mac is awake and online;
- unchanged polls do not run npm, build, or restart commands;
- a dirty or non-`main` developer checkout does not prevent release deployment and is never modified;
- a broken candidate causes no interruption to the active release;
- a candidate that starts but fails health verification is rolled back automatically;
- an updater-engine change takes control of the same in-progress transaction before activation;
- a bootstrap change is installed atomically and resumes the same transaction;
- interruption at every persisted phase converges to a healthy current or previous release;
- no update path requires a public endpoint, GitHub webhook, or routine user action;
- all updater-owned files, state, logs, and processes are discoverable through status tooling;
- the complete automated and installed-system test suites pass.

## 20. Delivery plan

### Phase 1: Release foundation

- introduce release directories, manifests, `current`/`previous` links, and stable service launcher;
- migrate the existing installer without enabling automatic polling;
- add SHA-aware health reporting and rollback-capable restart tests.

### Phase 2: Automatic updater

- add the polling LaunchAgent, stable bootstrap, versioned engine, state machine, locking, staging, activation, notifications, and cleanup;
- enable the updater by default for new installs;
- provide an explicit opt-in migration for existing installs until installed-system tests are proven.

### Phase 3: Self-update hardening

- enable candidate-engine handoff and bootstrap replacement;
- add transaction-schema compatibility tests and crash injection across every handoff boundary;
- make automatic migration the default.

### Phase 4: Companion UI

- display deployed version, update phase, last successful check, and actionable failures;
- add paired local controls for retry and disable/enable only;
- keep branch, path, and command selection unavailable to remote clients.

## 21. Future extension: event-driven hint

A future GitHub Action may join the private tailnet and send a signed “check now” hint to Companion after a merge. The hint must not identify a ref or trigger arbitrary commands; it only advances the next local discovery time.

Polling remains mandatory as the recovery mechanism because a laptop may be asleep or offline when the GitHub event occurs.
