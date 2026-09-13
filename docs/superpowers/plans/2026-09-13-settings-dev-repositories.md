# Settings and Dev repos implementation

Contract: ../specs/2026-09-13-settings-dev-repositories-design.md, approved after 89b1073.
Owner: primary implementing agent; no delegated work.

1. Add schema-v2 Dev repo persistence and bounded read-only discovery, project
   membership and script suggestions. Preserve migrated projects and goal snapshots.
2. Extend paired settings APIs with revision-safe scoped edits and discovery;
   project admission continues to use explicit enabled selections and ownership.
3. Replace the settings form with categories, Dev repo selection and focused
   repository/provider editors, draft-safe conflict handling and guided onboarding.
4. Consolidate legacy settings controls and navigation; unify visual tokens and
   states across monitoring, goals, settings and ancillary flows without changing
   terminal or workflow semantics. Update grouped searchable repository pickers.
5. Extend backend/UI/Cypress scenarios for discovery/security/migration, navigation,
   editing, updates and onboarding; validate the visual/accessibility matrix.
6. Run verify, coverage and local Cypress. Record passed/failed/unverified paths,
   including human usability and native/live paths. Update PR #119 for review.

No installation, merge, remote account changes or live agent tasks are included.
