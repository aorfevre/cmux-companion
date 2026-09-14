# Local settings and setup

New installations start with no project directories and no personal account
assumptions. Start the loopback service, pair your browser, and open `/onboarding`.
Add a named Dev repo (a folder containing Git repositories), choose the repositories
to use, then choose Claude or Codex and approve the checks for your first goal.
Setup progress survives restarts. `/settings` remains available for later edits.
Missing native tools do not prevent pairing or configuring projects.

## Find your preferences

Settings has one destination, with categories on desktop and a category list on
phones. Existing `/?view=settings` links redirect to `/settings`; update links
open `/settings#updates`. Main navigation opens Goals, Inbox and Settings.
Home and the installed app open Goals. **Browse sessions** under Goals opens
optional standalone sessions; existing session and notification links still work.

- **General**: connected Mac, this-browser terminal input protection and pairing.
- **Dev repos**: named development folders and individually added repositories.
- **Agents**: default provider/model, direct CLI or CCS profile, readiness and usage.
- **Notifications**: permission and preferences for this browser's subscription.
- **Updates**: manual installation and the automatic installation opt-in, off by default.
- **Advanced**: capacity, time limits in human units, tool paths, previews and diagnostics.

Multi-field edits show Save and Discard. Leaving an edited category asks whether
to discard; failed saves retain the draft. Concurrent changes to the same edited
fields show saved and draft values for review. Changes in other categories are
preserved. Immediate toggles acknowledge saving and restore their prior value
on failure. Terminal input protection is device-local; update changes use their
own clearly labeled protection control on the single Updates screen.

## Add Dev repos

1. Open **Dev repos → Add Dev repo → Choose folder**. Browse folders on the
   connected Mac, even when using your phone. Open the desired folder and select
   **Use this folder**; its name fills automatically. No typing or native Finder
   dialog is required. Cancel leaves the editor unchanged.
2. Review the selected folder and suggested name, then **Save Dev repo and
   discover**. A Git checkout offers the individual-repository flow instead.
   Optional **Enter a path (advanced)** supports `~/` and absolute Mac paths for
   locations outside the explorer's Home and saved-root boundaries.
3. All eligible Git repositories directly inside the folder are tracked and
   appear in Goals automatically. Adding a folder, opening Dev repos or Goals,
   and **Open / Refresh** discover new repositories. Existing disabled choices
   and checks stay unchanged; discovery never executes package scripts or starts
   agents. Search by folder name, repository name or GitHub owner. Disabled and
   unconfigured repositories stay visible, with a link to configure them.
4. Open an added repository to confirm its GitHub destination and remote and
   choose approved npm scripts, or define executable/argument checks in Advanced
   verification. Repository configuration and provider readiness are both required
   before creating a goal. Monitoring does not require delivery checks.

Scanning examines immediate child directories only, with bounded entry count,
concurrency and time. Partial results are identified. Hidden folders, symlinks,
linked worktrees, generated worktree folders and nested repositories are excluded.
Add repositories outside collections through **Add individual repository**.
Dev repo names must be unique; collection paths cannot overlap. Rename a group
without changing repository IDs. Removing a group moves its tracked repositories
to **Individual repositories** and does not remove files or goal history.

Settings are private local SQLite data in `~/.config/cmux-companion/settings.sqlite`.
The registry is authoritative for Dev repo names and paths, project identities, provider commands/models,
tool paths, execution limits and preview ports. `repo-identity.db` remains a
rebuildable cache; deleting it cannot remove configured projects. Back up the
settings database along with the workflow database and artifacts while stopped.
The service does not automatically read an `.env` file.

Claude and Codex start with `ccs claude` and `ccs codex`. Set an absolute path when
the service's PATH differs from your terminal. Direct `claude` and `codex` commands
are supported with an empty argument list. For CCS, the single argument may be
your configured account/profile name; Companion pins the selected provider target. Permission and protocol flags are
managed by the adapters; shell expressions and arbitrary wrappers are rejected.
Validation checks native installation compatibility without starting a paid task.
Authentication stays in existing CLI credential sources; it is never stored in
settings. Native compatibility is currently pinned to Claude Code 2.1.268,
Codex CLI 0.154.0 and CCS 8.9.0. Other versions report unready until their contracts
are verified. Offline fixture tests do not prove account-backed native behavior.

Codex uses a private configuration directory per attempt, no inherited project
configuration, a read-only native sandbox and scoped MCP file tools. Hooks deny
shell, native patch, delegation and extra MCP calls. Only implementers/integrators
receive the scoped file writer; reviewers receive no mutating bridge tools.
Native session IDs are recorded separately from workflow conversation IDs so
resume and result intake remain bound to the original operation.
Official references: [CLI](https://developers.openai.com/codex/cli/reference/),
[hooks](https://learn.chatgpt.com/docs/hooks), and
[configuration](https://learn.chatgpt.com/docs/config-file/config-reference).

Projects are disabled instead of deleted. Their existing goals and files remain.
New goals use the current settings revision; existing goals retain their provider,
checks, Git destination and execution configuration. Project paths cannot be
retargeted: add a new project when its checkout moves. If a saved goal’s project
directory is missing at startup, orchestration opens in read-only mode with
history and Settings available. Restore its original directory and restart to
resume execution; ownership conflicts still require operator reconciliation. Verification commands and
GitHub destinations must be configured before creating a goal intended for delivery.

## Existing installations

The old explicit orchestration JSON remains a compatibility startup path only
when no settings database exists. Once the settings database exists, it takes
precedence; JSON/environment repository lists no longer configure that runtime.

Stop owned services using the established operator procedure and back up the
original state. To import configuration into an unconfigured database:

```sh
node scripts/import-settings.mjs \
  --database /absolute/private/new-install/settings.sqlite \
  --config /absolute/private/orchestration.json \
  --models /absolute/private/model-settings.json
```

Both sources are optional individually; at least one is required. Files must be
private regular files. Import validates all fields and Git roots before one
transaction, excludes environment credentials, preserves source files and refuses
to overwrite any previously configured database. Run the new service with
`CMUX_COMPANION_DATA_DIR=/absolute/private/new-install` and complete setup in the UI.
Import copies configuration only. It does not adopt historical workflow journals,
active goals, workers or legacy jobs. Keep the original journals for their existing
inspection/recovery path. Drain/reconcile the original orchestrator first: Git
repository ownership fencing refuses a second owner or an unsafe database switch.
See [the cutover runbook](orchestration-retirement.md) for existing-state migration.
Do not point the new runtime at an unrelated legacy database.

The preferred service identifiers for new installer bundles are `org.cmux-companion.service` and
`org.cmux-companion.updater`. Status and deployment health also recognize the
legacy labels from `server/service-identity.mjs`; updater versions still installing
those labels remain compatible. This change does not rename or
unload installed agents. An operator migrating labels must stop the old agent,
update the installer-provided plist, remove the old registration, then load the
new registration. Never run both labels against the same state. Rollback restores
the old registration only after the new service and its owned work are stopped.

The updater is bundled with Companion. Automatic installation remains off until
explicitly enabled; manual installation still requires confirmation. Settings
schema v2 migrates existing v1 data transactionally, preserving projects, disabled
states, import markers and admitted-goal snapshots. Existing projects initially
appear under Individual repositories. Adding their containing Dev repo associates
them without duplicating or reenabling them.

This release changes the settings data contract. The bundled updater's existing
compatibility guard deliberately refuses unattended schema-changing releases;
use the explicit stopped-service installation/migration procedure with a backup.
An older binary refuses a v2 database. Rollback must restore the verified v1
settings backup before starting that binary; switching code alone is insufficient.
Disposable tests verify the v1 → v2 migration and backup restoration.

Live Cypress runs require both `CMUX_COMPANION_E2E_FIXTURE_ROOT` (absolute path)
and `CMUX_COMPANION_E2E_GITHUB_REPOSITORY` (`owner/repository`) in addition to the
existing safety opt-in. There is no personal default repository to merge into.

## Contributor verification

`npm run test:e2e:local -- --settings` exercises pairing, persisted setup, project
selection and disabling against a real disposable service and Git repository,
with fake provider capabilities. Standard monitoring and orchestration Cypress
suites retain their separate entry points. These checks do not touch installed
configuration, accounts, Tailscale or live agent sessions.
