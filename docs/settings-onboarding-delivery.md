# Settings and onboarding delivery evidence

Date: 2026-09-12. Branch: `feat/settings-onboarding`.
Contract: [approved design](superpowers/specs/2026-09-12-settings-onboarding-design.md).
Operator guide: [setup and migration](settings-onboarding.md).

## Delivered behavior

A fresh installation starts with empty projects and paired onboarding. The private
SQLite registry owns project identities, provider commands/models, tool paths,
execution limits, preview ports and setup progress. Claude and Codex default to
`ccs claude` and `ccs codex`; direct commands and CCS profiles are editable without
accepting arbitrary provider flags. Settings edits feed monitoring and new goals.
Admitted goals keep immutable provider, destination, verification and policy
snapshots across edits, disabling and restart.

Missing recorded project directories suspend orchestration at startup while
preserving history and Settings access. The UI explains how to restore execution.
Ownership conflicts remain refusals; no existing execution is silently adopted.

Environment variables now serve optional bootstrap and development/transport
wiring. Existing JSON installations retain a documented explicit import path.
Import publishes an absent destination only after successful validation and commit.
Personal runtime roots and launcher aliases are removed; legacy service labels
remain detection aliases, with a documented operator migration.

## Acceptance evidence

| Contract outcome | Evidence |
| --- | --- |
| Fresh startup without JSON/native tools | `tests/settings-startup.test.mjs` starts the actual loopback entry point with a disposable data directory and unavailable cmux; anonymous access fails and paired setup succeeds. |
| Persisted, selectable project | `cypress/e2e/settings-onboarding.cy.ts` pairs at 390 px, adds a real Git project, completes setup, reloads, selects it and creates a goal. SQLite restart/cache independence is covered in `tests/local-settings.test.mjs`; runtime restart in `tests/settings-runtime.test.mjs`. |
| Claude/Codex commands and models | Native inputs/capabilities suites cover CCS/direct argv. `tests/codex-native.test.mjs` exercises all roles, output binding, a supervised fake process and the real scoped MCP stdio transport. The native terminal suite verifies real PTY input, pause, recorded Codex session resume, idempotence and stop. |
| No generic shell/provider execution | Provider validation rejects shell constructs and permission override arguments; executable fingerprints are rechecked by supervisors. Role/file tests refuse shell tools, extra MCP servers, traversal, metadata, symlinks and unauthorized writes. |
| Pairing, origin and revision boundaries | `tests/settings-routes.test.mjs` exercises unauthorized reads, foreign-origin writes, stale revisions, malformed fields, unavailable providers and setup readiness. |
| Durable, private, atomic settings/import | Local settings/import suites cover canonical paths, immutable IDs/paths, cache independence, concurrent writes, private files, failed import rollback, exclusive destination publication and unrelated database rejection. |
| Saved work cannot be retargeted | Settings runtime suite admits with Claude, edits to Codex/new limits, disables the project and restarts the scheduler: original configuration and goal history remain. Missing-directory recovery starts no effects. |
| Tool/execution/preview preferences | Settings API/UI persist preferences; startup wires tool paths and preview range to monitoring adapters, goal adapters receive snapshot tools/policy, and scheduler recovery asserts retained limits. Actual installed cmux/Tailscale/Chrome operations are not exercised. |
| Generic open-source defaults | Source audit of `server`, `app`, `scripts`, `.env.example`, README and live Cypress configuration found only legacy service-label aliases and the legitimate upstream updater URL. Live fixture paths/destinations are explicit. |
| Existing-installation migration | Disposable import tests and the operator guide cover validation, source preservation and no workflow adoption. Installer/status shell syntax passes; installed services were not changed. |

The disposable UI scenario reaches a persisted project and ready fake provider
without editing `.env` or JSON. Browser refresh plus separate SQLite/runtime
restart checks supply the persistence evidence; Cypress itself does not restart
the backend process.

## Passed checks

- `npm run verify`: 699 backend tests, 698 passed, one existing skip; 119 UI tests
  passed; lint, both TypeScript projects and production build passed.
- `npm run test:coverage`: backend line coverage **97.54%**.
- `npm run test:ui:coverage`: UI line coverage **95.06%**.
- Additional final native terminal suite: **6/6**, including the new Codex PTY
  resume regression added after the full run. Codex/MCP suite: **7/7**.
- Settings Cypress: **1/1**, real disposable settings service/Git, mobile screenshot
  visually inspected. Orchestration Cypress: **2 passed, one intentional pending**.
- Monitoring Cypress initially had **75 passed, three failed, four intentional
  pending**. All three failures were in legacy model configuration; the corrected
  specification rerun passed **3/3**. The remaining monitoring specs were unchanged.
- Final lint, `git diff --check` and zsh syntax for install/uninstall/status/updater
  location scripts passed. The npm lockfile was preserved.

Local raw logs are under `/tmp/companion-settings-delivery-*`, with the terminal
regression in `/tmp/companion-settings-codex-terminal.log`. These are disposable
local evidence, not files needed to use or build the repository.

## Failures resolved and interventions

1. Used free Cypress frontend port 3225 because 3221 was occupied; no unrelated
   owner was stopped.
2. Canonicalized disposable macOS `/private/var` fixture paths and corrected test
   Host/Origin pairing.
3. Fixed numeric inputs that changed clearing-and-typing `3` into `30`; preserved
   multiline argument editing and hid screen-reader-only legends correctly.
4. Restored the legacy model panel for pre-import installations after monitoring
   Cypress exposed the compatibility regression.
5. Closed native fixtures before deleting their files; strengthened import atomicity
   and database/ID validation after reviewing failure boundaries.
6. Corrected NOT_READY goal errors that were masked as version conflicts.
7. Added safe missing-directory startup suspension after recovery review.

## Unverified boundaries and cleanup

No paid/account-backed Claude or Codex run, actual native permission enforcement,
installed cmux continuity, live GitHub publication, Tailscale change, Chrome
capture, service-label migration, updater installation or release was exercised.
Compatibility is deliberately pinned to Claude 2.1.268, Codex 0.154.0 and CCS 8.9.0;
other versions explain that their capability contract is unsupported. Fake-native
and PTY tests are not a claim of live-provider certification.

Test runners own and clean their disposable services, worktrees and private data.
No installed state, credentials or unrelated sessions were changed. The existing
untracked `docs/superpowers/plans/2026-09-08-burst-scan.md` is excluded from delivery.
Review is through a PR targeting `main`; merge and deployment remain separate.
