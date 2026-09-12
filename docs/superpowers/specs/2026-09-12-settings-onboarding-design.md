# Local settings and open-source onboarding

Date: 2026-09-12
Status: Proposed for human review before implementation planning.
Owner: The implementing agent owns UI, API, persistence, adapter integration,
verification and cleanup as one delivery.

## Outcome

A fresh installation starts with generic defaults and guides a paired user to
configure projects and Claude/Codex without editing environment variables or JSON.
The same durable SQLite settings drive monitoring, goal creation and agent launch.
No personal checkout paths, account names or development repositories are runtime
defaults. Configuration remains local to the installation.

This contract owns settings and onboarding product decisions. The orchestration
core design continues to own scheduling, review, publication and recovery. Its
legacy cutover safeguards remain applicable to existing installations; a fresh
installation does not need a fabricated legacy inventory. This is not authorization
to cut over or modify the operator's installed service.

## User journey

1. Start the service with its default private data directory and loopback port.
   Pair through the existing mechanism. Missing agent tools do not prevent setup.
2. On first use, see setup steps for local tools, providers and a first project.
   Save progress and resume after restart. Monitoring remains accessible; goal
   actions explain the specific missing requirements until they are ready.
3. Configure prefilled Claude and Codex providers, initially `ccs claude` and
   `ccs codex`, and select a model (default or a custom valid model ID).
   Edit each calling command as an executable and ordered arguments, with a
   readable command preview. Support direct `claude` and `codex` entry points.
   Validate installation and supported capabilities without launching a paid job.
4. Add a project by its local Mac directory. Validate and canonicalize the Git
   root; suggest its existing remote and GitHub destination for confirmation.
   Configure approved verification commands before execution requires them.
   The project immediately appears in monitoring and the goal dropdown.
5. Complete setup and start a goal using a ready project and provider. Return to
   Settings to manage Projects, Providers, Tools and Execution/Preview preferences.
   Settings persist across refresh and service restart.
6. Edit or disable a project without deleting its goals or files. Historical goals
   remain inspectable. An unavailable directory displays an actionable status.

## Configuration ownership

SQLite is authoritative for project IDs and canonical paths, enabled status,
Git destinations, approved executable/argv verification definitions, provider
commands and models, local tool paths, concurrency and execution limits, preview
preferences, setup progress and schema/import versions. This is durable data,
separate from the deletable repository identity cache. Backups must include it.

Keep optional bootstrap environment overrides for the private data/database
location, loopback service address/port, token-file location, log level and
development frontend/backend wiring. Retain any required transport bootstrap
overrides explicitly documented as such; ordinary preferences belong in Settings.
Defaults must work without an `.env` file. `.env.example` uses generic examples.

Credentials remain in authenticated tools or private credential sources. Settings
may contain references, never returned credential values or arbitrary environment
dictionaries. Do not migrate credentials into the settings database.

Existing private orchestration JSON and model settings support explicit, validated,
transactional one-time import into an empty registry. Import does not overwrite
configured settings, alter source files, adopt legacy jobs or bypass cutover.
Existing installations retain a documented migration path. Invalid imports leave
the database unchanged and report field-level errors without exposing secrets.

## Boundaries and invariants

- UI/API: paired, same-origin settings and setup endpoints, server-side validation,
  revision-checked writes and useful validation errors. Saving settings is not an
  agent launch. No unauthenticated directory browser or generic command endpoint.
- Storage: schema migrations, atomic updates, stable repository identities and
  explicit import markers. Fresh databases contain no personal projects. Deleting
  the monitoring cache cannot remove settings. Settings database is private.
- Background: acquire repository ownership before admitting work. Snapshot the
  effective provider, model, command, checks, destination and execution policy for
  admitted work; settings edits cannot retarget a running goal's effects. Changes
  govern newly created goals/manual sessions. Disabled projects reject new goals;
  existing work and history retain their original configuration and ownership.
  Active project paths cannot be changed; register a different project instead.
- Native adapters: preserve provider-specific prompts, protocol, cancellation,
  permission enforcement and recovery. Resolve executables and pass argv directly;
  never evaluate shell text, pipelines, substitutions or shell wrappers. Permit
  supported provider entry points with capability validation, not arbitrary RPC
  passthrough. Unsupported wrappers explain why they cannot be enabled.
- External effects: setup and settings tests use disposable adapters. Saving or
  validating configuration does not push, create PRs, change accounts, install
  tools or mutate Tailscale. Explicit feature actions retain their existing gates.
- Open-source packaging: remove personal discovery defaults and UI copy; make
  live fixture targets explicit. Centralize generic service identifiers with a
  documented existing-installation migration. Document/configure the updater
  dependency consistently rather than assuming a sibling checkout in each script.
  Preserve legitimate copyright, attribution and historical issue/PR references.

## Non-goals

Publishing the repository, merging/releasing this work, changing the license,
operating the installed service, cloud settings sync, multi-user administration,
Windows/Linux cmux support, arbitrary provider plugins, GitHub Enterprise support,
credential management UI, and automatic tool installation are excluded. Existing
Mac/cmux/Tailscale requirements are documented product dependencies.

## Acceptance criteria

Each criterion has one designated verification scenario; these scenarios can
contain multiple assertions.

| Observable acceptance | Verification |
| --- | --- |
| Fresh startup without orchestration JSON or agent binaries exposes paired, resumable onboarding with generic defaults. | Disposable startup/setup integration test with an empty home/data directory. |
| Adding a validated project makes it selectable in monitoring and goals and survives restart. | Real-service Cypress onboarding/project scenario. |
| Claude and Codex commands/models can be edited and persist; each produces its provider's valid launch contract. | Adapter contract suite using fake CCS and direct-provider executables for both providers. |
| Invalid executable configuration and shell constructs cannot become generic execution; unsupported providers remain visibly unready. | Provider settings boundary test with malicious/unsupported command fixtures. |
| Project/command/settings mutations preserve authentication, origin enforcement and concurrent-write detection. | Settings API security/concurrency integration scenario. |
| Settings and import are durable and atomic, independent of the monitoring cache, and exclude credentials. | SQLite migration/import/restart scenario including invalid imports and cache deletion. |
| Settings edits and project disabling cannot retarget admitted work or delete history; new work uses the current revision. | Scheduler recovery scenario spanning a settings edit, disable and service restart. |
| Tool, execution and preview preferences affect their owning flows without extra JSON editing. | Runtime configuration integration scenario using disposable adapters. |
| Runtime defaults, installation docs and live fixture configuration contain no personal machine assumptions. | Tracked-source audit with documented attribution/test-placeholder exceptions. |
| An existing installation has a documented import and service-identifier migration without silently adopting legacy execution. | Disposable legacy configuration migration scenario. |

## Success measure

In the disposable end-to-end setup scenario, a fresh user reaches a persisted,
selectable project with a ready configured provider using only the paired UI,
with zero edits to `.env` or JSON files.

## Delivery evidence

After human review, commit an implementation plan against this contract. Deliver
through a PR targeting main with passed, failed and unverified paths, interventions
and remaining gaps. Run `npm run verify`, backend/UI coverage (at least 90% lines)
and `npm run test:e2e:local`. Native account-backed live behavior stays unverified
unless separately authorized; fake-provider evidence must not be described as
live Claude/Codex validation. Keep unrelated user files untouched.
