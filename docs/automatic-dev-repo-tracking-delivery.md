# Automatic Dev repo tracking — delivery evidence

## Result

Adding a named development folder now tracks its eligible immediate Git children
and makes them visible in Goals without checkboxes or an “Add selected
repositories” step. Opening Dev repos or Goals and explicit Refresh discover later
additions, including folders saved before this change. Linked worktrees are
silently excluded. Ordinary non-Git directories and nested Git repositories are
not recursively indexed.

Disabled and unconfigured repositories remain visible with their readiness reason
and a Settings link. Existing repository IDs, names, disabled choices, checks and
admitted-goal snapshots are preserved. Discovery neither approves verification
commands nor starts agents.

The user approved spec commit `6ccf292` before the implementation plan commit
`f9c0946`. Implementation and verification have one owner: the implementing agent.

## Boundary review

- UI: removed repository selection controls; retained folder browsing, search,
  repository editors and immediate refresh. Late discovery does not overwrite a
  dirty draft; the existing conflict review exposes the saved version. Loading,
  partial, failed and empty discovery are distinct.
- API: paired, same-origin settings mutations reconcile validated saved roots.
  Concurrent scans of a root share one promise. Settings revisions are rechecked
  before persistence, with bounded conflict retries and no resurrection of removed
  roots. Failed roots do not prevent other roots from being scanned.
- Storage: existing SQLite settings API and schema; no migration or data-contract
  change. New repositories have stable IDs and no approved checks. Partial scans
  never remove saved entries; the existing 500-project capacity is reported.
- Runtime: settings notifications update repository admission/catalogs. All
  repositories remain visible, while existing enabled/provider/check/path gates
  still reject unready goal creation. Existing goals keep their saved configuration.
- Background: page-open and explicit refresh only; no filesystem watcher or timer.
  Existing entry budgets, Git timeouts, canonical containment and worktree/symlink
  exclusions remain enforced.
- External: tests use disposable Git and fake agents. No paid agents, repository
  scripts, live sessions, installed services, GitHub accounts or Tailscale settings
  were changed by this implementation. PR publication is the only remote write.

## Validation

- `npm run verify`: 768 backend passes, one platform skip; 140 UI passes;
  lint, both TypeScript checks and production build passed.
- Additional capacity-boundary test: five focused reconciliation tests passed.
- Final backend coverage run: 769 passes, one platform skip, zero failures;
  97.44% line coverage (new reconciliation module: 100%).
- Standard Chrome Cypress: 85 passes, five mode-specific pending scenarios.
- Dedicated Settings Cypress: automatic two-folder onboarding, saved settings,
  disabled visibility with blocked admission, later discovery on Goals opening,
  and exclusion of a real linked worktree passed.
- Dedicated orchestration Cypress: two normal-mode passes; separate read-only
  fixture: one pass.
- Dedicated updater Cypress on a fresh fixture: one pass.
- UI line coverage: 95.85%.
- `git diff --check`: passed.

### Interventions

The initial backend run retained an old assertion that disabled repositories
should disappear. It was changed to assert visible disabled status and rejected
admission; the focused and full reruns passed. Lint found a hook setter referenced
before its declaration; declarations were reordered and full lint passed.

The first coverage run timed out reopening the offline shell while several
independent native-browser suites were running. The unchanged offline test passed
in isolation and in the full verify run. Coverage was rerun without competing
native-browser suites; no test or coverage scope was removed and no timeout or
threshold was relaxed.

## Limits

[Phone screenshot](images/automatic-dev-repos/settings-390.png)

The responsive Cypress journey checked document overflow at 360, 390 and 1440 CSS
pixels. The 390px Settings screenshot was visually inspected: repository rows,
wrapping paths and bottom navigation are usable without selection controls.
The desktop image was clipped by the headless runner, so a complete desktop
visual review remains unverified. Physical-phone testing, VoiceOver, native
200% zoom and the spec's timed human
usability walkthrough remain unverified. Automated completion is not evidence of
the human success measure.

This PR does not merge or install the change. Separate operational cleanup removed
81 inactive worktree registrations with intact private recovery snapshots; four
worktrees still in use by processes were preserved. No further worktree cleanup
was performed during implementation.
