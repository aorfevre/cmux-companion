# Unified settings, named Dev repos, and interface consistency

Date: 2026-09-13
Status: Proposed; awaiting human review before implementation planning.
Owner: The implementing agent owns integration and verification across all layers.

## Outcome

A user registers named **Dev repos** such as `karven` and `rekord`: directories
on the connected Mac containing Git repositories. Companion discovers their
repositories for selection without requiring users to configure each path by hand.
One coherent Settings destination replaces the current two settings experiences.
Sessions, Goals, repository selection and Settings share navigation, terminology,
controls and feedback.

This contract supersedes the project-entry journey and settings presentation in
`2026-09-12-settings-onboarding-design.md`. Its security, persistence, ownership
and admitted-goal invariants remain applicable. The manual-update contract retains
authority over installation eligibility, confirmation, recovery and opt-in defaults.

## Review findings

Source review of merged main `92bb3f2`, cross-checked against the current audit
branch. This is a code and interaction-contract review, not a rendered-browser
or user-tested visual audit; responsive appearance remains to be verified.

| Finding and evidence | User impact | Required change |
| --- | --- | --- |
| `app/page.tsx` renders SettingsView at `/?view=settings`; `app/settings/settings-panel.tsx` renders a second Settings page. Both mount update controls. | Users must guess which Settings contains a preference. | One canonical settings destination with backward-compatible links. |
| `server/local-settings.mjs` accepts individual Git roots only; `server/index.mjs` passes an empty discovery-roots list when local settings are active. | A parent directory such as karven cannot represent a collection. | Persist named parent directories separately from repository identities. |
| LocalSettingsPanel exposes provider argv, tools, bytes, milliseconds and all project checks in one numbered form; onboarding reuses it. | Basic setup requires understanding internal configuration. | Guided setup, categorized settings, focused editors and Advanced disclosures. |
| LocalSettingsPanel has a whole-document Save, no dirty-state guard or Discard; Reload replaces the draft. Updates and push preferences save independently. | It is unclear what has saved; navigation or conflict recovery can lose edits. | Explicit save boundaries and draft preservation, with immediate controls visibly acknowledged. |
| `BottomNav` labels a worktrees placeholder Goals, while the actual board is `/orchestration`. | A main navigation destination needs another click and has a different shell. | Goals opens the real board directly; preserve existing deep links. |
| `globals.css` has dense 8–12px secondary labels and lime accents; settings and orchestration hardcode separate green palettes and typography. | Screens feel unrelated and secondary content is hard to read. | Shared tokens, readable text, common control states and responsive layouts. |
| UpdateSettings uses the monitoring read-only preference on one screen and its own unlock on another. | The same action has different protection behavior depending on entry point. | One consistently explained update protection flow, preserving confirmation. |
| Model defaults use a conditional legacy panel, separate from local provider/model configuration. | Configuration ownership and available model choices are hard to understand. | One Agents category; show the effective configuration and preserve legacy compatibility. |

## Information architecture and interaction design

Use familiar Claude/ChatGPT-style settings patterns: category navigation, calm
neutral surfaces, labeled preference rows, short descriptions and focused detail
editors. These are design references, not a claim to have inspected their current
signed-in interfaces or an instruction to copy branding.

Application navigation: **Sessions · Goals · Inbox · Settings**. Usage and local
apps remain reachable from relevant contextual links and Settings. On desktop use
a persistent rail; on mobile use the same destinations in a bottom navigation bar.
Terminal detail may use a focused shell with an explicit Back action. Browser Back
restores the originating screen, selection and scroll without losing a draft.

Settings uses a category sidebar on desktop and a category list leading to a
full-width detail screen on mobile. Direct links identify the selected category;
`/?view=settings` and `/settings#updates` resolve to the canonical destination.

| Category | Contents and ownership visible to the user |
| --- | --- |
| General | Connected Mac, this-device terminal input protection, install-to-home-screen action. |
| Dev repos | Named directories, discovery, repository enablement and repository details. Shared on this Mac. |
| Agents | Claude/Codex readiness, default provider and model, connection method: direct CLI or CCS profile; usage link. Shared on this Mac. |
| Notifications | Permission, subscriptions, alert types, quiet hours and discreet content. Label the existing subscription/device scope accurately. |
| Updates | Version, last check, changes, manual update and automatic installation toggle, initially off. Retention/recovery details under Advanced. |
| Advanced | Tool paths, concurrency, time limits in human units, preview port range, diagnostics and local apps link. Shared on this Mac. |

Do not add nonfunctional theme/account controls to imitate another product.
Preserve existing feature access while relocating it; remove superseded UI only
after every control and deep link has an equivalent destination.

Multi-field editors use Save and Cancel/Discard with a visible unsaved state.
Saving affects only that editor's fields, checked against the current revision;
do not overwrite another category's changes. On conflict retain the draft and
show saved-versus-draft differences for the edited fields before retrying.
Navigation with unsaved edits offers Stay or Discard. Independent immediate
toggles show Saving/Saved and restore the prior value on failure. Automatic
installation follows the existing updater API and remains off unless opted in.
Pending, loading, unavailable and failed states must be distinct.

## User journey: named Dev repos

1. Open Settings → Dev repos → Add Dev repo. Enter a display name and directory
   on the connected Mac. Helper: “A folder containing your Git repositories.”
   Support absolute paths and `~/` relative to that Mac's home, not the phone.
   Example names are karven and rekord; never preconfigure personal paths.
2. Validate the directory and show its canonical path before saving. Names are
   trimmed, unique ignoring case, editable and independent of directory basenames.
   Persist a stable ID; allow 1..n entries (empty is valid before setup).
3. Save the directory, then scan its immediate child directories for Git roots.
   Show progress and a result list with repository name, safe GitHub destination
   if present, and Added / Available / Needs attention status. Offer Refresh.
   A Dev repo must be a collection directory, not itself a Git root; explain the
   distinction and offer the separate Add individual repository action.
4. Select repositories to add, including a Select all available action. Discovery
   alone does not approve execution or verification commands. Persist selections
   with stable existing repository IDs and group them under the Dev repo in
   Settings and repository pickers. Search matches group, repository and owner.
5. Open a repository detail editor. Detect origin and safe GitHub destination;
   let the user confirm or edit them. Suggest npm scripts only when present in
   package.json and display exactly what would run. The user selects approved
   checks; scanning and saving never run those scripts. Keep executable/argv
   editing in Advanced and preserve existing non-npm checks.
6. Show monitoring availability separately from readiness for goals. A missing
   destination, check or provider has a precise fix link, not a generic error.
   Onboarding uses these same editors: add directory, select a repository,
   configure a provider, review readiness. Progress persists; monitoring remains
   accessible before setup completion.
7. Add rekord using the same flow. Repository selectors display, for example,
   `karven / cmux-companion`, with names and GitHub owners to disambiguate collisions.
8. Rename a Dev repo without changing repository IDs or any running goal. Removing
   it stops discovery and moves already-added repositories to **Individual
   repositories**; show that effect before confirmation. No directories, Git
   worktrees or goal history are deleted. Disable repositories to stop new work.

Conceptual layout (sample names only; counts and status come from actual data):

```text
Settings              Dev repos                     [Add Dev repo]
  General             Folders on your connected Mac
  Dev repos           karven                        [Open] [Refresh]
  Agents              ~/Developers/karven
  Notifications         cmux-companion              Ready for goals
  Updates               another-repository          Configure checks
  Advanced            rekord                        [Open] [Refresh]
                      ~/Developers/rekord
                      Individual repositories       [Add repository]
```

## Data, discovery and execution boundaries

- Storage: migrate SQLite settings transactionally to add Dev repo records
  `{id, name, path}` and optional repository-to-Dev-repo membership. Keep existing
  project IDs, paths, checks, enabled flags, model settings and goal snapshots.
  Existing projects initially appear under Individual repositories; adding a
  containing Dev repo associates matching canonical paths without duplicating
  or reenabling them. Bump schema version so incompatible old binaries fail
  explicitly; verify installer backup/restore for the version boundary.
- Discovery: paired and same-origin endpoints only. Scan only a saved, validated
  root by its ID; do not expose an unrestricted directory listing endpoint.
  Immediate children only, no symlink traversal or hidden directories, `.git`,
  node_modules or generated worktree internals. Deduplicate canonical paths;
  reject identical or overlapping Dev repo roots with an actionable explanation.
  Linked worktrees and nested repositories are not offered as new primary repos.
  Preserve manually added repositories outside these roots.
- Bound scans with a 1,000-entry budget, four concurrent Git inspections, a
  five-second timeout per Git inspection and a 30-second overall deadline.
  Return explicit partial/limit status, never “complete” when truncated. A failed
  or interrupted scan does not remove saved repositories. Refresh and opening
  a group initiate scans; no permanent recursive filesystem watcher is required.
- Treat filesystem content, Git remotes and package scripts as untrusted data.
  Use argv-based Git inspection; never execute scripts to detect readiness or
  expose credential-bearing remote values. Revalidate canonical paths and group
  containment on selection/save and at applicable execution boundaries.
- UI/API: stable group IDs and selected repository IDs cross boundaries, with
  schema validation, payload limits, revision checks and field-specific errors.
  Directory inspection reads the connected Mac only. Folder selection must not
  imply that a phone's file picker can choose a server directory.
- Runtime/background: only explicitly added, enabled repositories enter existing
  monitoring/goal allow-lists. Existing ownership fencing and admitted-goal
  snapshots remain authoritative. Renames, scans, group removal and new settings
  cannot retarget ongoing effects. Unavailable roots show a recoverable status.
- External: configuration never clones, fetches, pushes, installs tools, starts
  paid agents or changes GitHub/Tailscale accounts. Existing explicit action
  gates remain in force. Updater state remains owned by its existing store.

## Full interface consistency scope

Review and align pairing/onboarding, session list, terminal detail/composer,
launch/repository picker, Goals list/detail/review actions, Inbox, local apps,
usage, Settings, updates and diagnostics. Keep specialized terminal rendering
and orchestration workflow semantics intact.

Use shared color, spacing, typography, radius and focus tokens plus common
buttons, fields, preference rows, status badges, alerts, dialogs and empty states.
Use neutral surfaces and one accent; reserve warning/error colors for meaning.
Body text is at least 14px, secondary labels at least 12px, mobile text inputs
16px, and actionable targets at least 44px. Terminal content retains its user
font controls. Ensure WCAG AA contrast, keyboard operation, accessible names,
visible focus, focus return after dialogs, reduced motion and status text beyond
color. At 360px width and 200% zoom, ordinary content must reflow; terminal/code
regions may scroll horizontally. Respect safe-area insets and soft keyboards.

## Non-goals

Remote Mac provisioning, cloud sync, automatic cloning, recursive home-directory
indexing, paid/live provider runs, tool installation, new workflow semantics,
arbitrary command execution, changing licensing, merging or installing this change.
No destructive migration of existing repositories or live data.

## Acceptance criteria

Each row has one designated verification scenario.

| Observable acceptance | Verification |
| --- | --- |
| Add karven and rekord, discover children, choose repositories and see grouped searchable pickers after restart. | Real-service disposable Cypress directory-to-goal-selection journey. |
| Duplicate names/roots, overlap, symlink escapes, nested/worktree candidates, unavailable paths and scan limits give safe actionable results. | Discovery boundary fixture suite. |
| Discovery cannot run package scripts, expose remote credentials or admit unselected repositories. | Malicious repository inspection/selection integration scenario. |
| Migration and root rename/removal preserve project identities, checks, disabled state and historical/running goals. | SQLite migration and scheduler recovery scenario. |
| Pairing, same-origin enforcement, path revalidation and stale-write rejection remain enforced. | Settings API security/concurrency scenario. |
| One Settings destination and real Goals destination work from all current entry points, including old URLs and Back. | Cypress navigation/deep-link scenario. |
| Save, Discard, immediate toggles and conflict handling preserve drafts and never overwrite unrelated edits. | Two-client settings editor scenario. |
| Fresh setup uses readable provider/profile choices and repository check suggestions without raw configuration editing. | Disposable onboarding Cypress scenario with fake providers. |
| All inventoried screens share controls and remain usable on phone, desktop, keyboard and zoom. | Recorded visual/accessibility matrix at 360px, 390px and 1440px, including 200% zoom and state screenshots. |
| Updates have one protection flow and automatic installation remains opt-in/off by default. | Existing updater Cypress scenario extended for consolidated settings and failed-toggle recovery. |
| Existing sessions, composer, review actions, previews, usage, notifications and pairing retain their behavior. | Full local regression run with the consistency-screen inventory linked to relevant test cases. |

## Success measure

In a disposable usability walkthrough, a person unfamiliar with internal config
can add two named directories, select a discovered repository and reach a ready
goal form in under three minutes when provider tools are already available,
without editing JSON, argv or individual repository paths. Record observed
results; automated completion alone is not evidence of human usability.

## Delivery and review boundary

Commit this spec, obtain a person's review, then commit its implementation plan.
Review implementation through a PR targeting main. Require `npm run verify`,
backend/UI line coverage at least 90%, `npm run test:e2e:local` and the recorded
visual/accessibility matrix. Report passed, failed and unverified paths separately.
No live installation changes are part of this review.
