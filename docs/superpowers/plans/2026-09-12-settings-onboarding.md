# Settings and onboarding implementation

Contract: [approved design](../specs/2026-09-12-settings-onboarding-design.md).
Human review: user approved on 2026-09-12 after spec commit a3b0a9d
(“What is the problem ? I approve the goal”).

One implementation owner integrates the following sequential work.

1. Add a private, versioned SQLite settings registry, generic defaults, validation,
   concurrency revisions and transactional legacy import. Test restart, invalid
   writes, canonical projects, cache independence and credential exclusion.
2. Expose paired same-origin settings/setup APIs. Build mobile settings and
   resumable onboarding for projects, providers, tools and execution/preview
   preferences. Test API boundaries and UI error/retry behavior.
3. Start with empty settings without requiring production JSON or native tools.
   Integrate the registry with monitoring and orchestration admission, repository
   ownership and immutable configuration for existing goals. Test lifecycle and
   restart boundaries with disposable repositories and adapters.
4. Integrate validated Claude/Codex and CCS/direct launch configurations with
   provider-specific native contracts and manual sessions. Test fake executable
   transport, permission boundaries, cancellation and recovery.
5. Remove personal runtime/fixture assumptions, centralize service identities,
   document bootstrap environment overrides, settings migration and updater
   installation. Preserve attribution and unrelated files.
6. Exercise real-service Cypress onboarding and settings; run verify, backend/UI
   coverage and local Cypress. Inspect failures and record passed/failed/unverified
   evidence. Submit a PR to main; do not merge, deploy or touch installed state.

The contract's acceptance table is the completion checklist. No step may silently
weaken native permissions or present configuration-only support as a working
provider. Amend the contract in its own commit first if implementation exposes a
design error requiring a product decision.
