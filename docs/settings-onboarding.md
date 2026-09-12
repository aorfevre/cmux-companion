# Local settings and setup

New installations start with no project directories and no personal account
assumptions. Start the loopback service, pair your browser, and open `/onboarding`.
Add a Git root on the Mac, choose Claude or Codex, configure local tools and save.
Setup progress survives restarts. `/settings` remains available for later edits.
Missing native tools do not prevent pairing or configuring projects.

Settings are private local SQLite data in `~/.config/cmux-companion/settings.sqlite`.
The registry is authoritative for project identities, provider commands/models,
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

The optional updater is a separate project. Set
`CMUX_COMPANION_UPDATER_REPOSITORY` to its checkout/bundle, or install its standard
bundle. Operator commands prefer that explicit path, then the installed bundle,
then a sibling checkout for contributors. Installing, checking updates and
changing update policy are operator actions, not routine verification.

Live Cypress runs require both `CMUX_COMPANION_E2E_FIXTURE_ROOT` (absolute path)
and `CMUX_COMPANION_E2E_GITHUB_REPOSITORY` (`owner/repository`) in addition to the
existing safety opt-in. There is no personal default repository to merge into.

## Contributor verification

`npm run test:e2e:local -- --settings` exercises pairing, persisted setup, project
selection and disabling against a real disposable service and Git repository,
with fake provider capabilities. Standard monitoring and orchestration Cypress
suites retain their separate entry points. These checks do not touch installed
configuration, accounts, Tailscale or live agent sessions.
