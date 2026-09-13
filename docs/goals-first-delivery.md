# Goals-first navigation and folder picker delivery

PR #120 implements the spec amendment committed as `2645a3a`, approved by the
user (“go”) before the implementation plan `97ec8ef`.

## Delivered behavior

Home, PWA launch and direct home pairing now open Goals. Main navigation contains
Goals, Inbox and Settings. Browse sessions is secondary within Goals; standalone
sessions remain usable, and explicit session, workspace, surface, document,
notification, preview and legacy `mode=sessions` links retain their destinations.
Setup returns to Goals. The empty screen has an obvious setup action, while
configured users can create a goal without opening Sessions. Connection failures
have a retry path and do not leave an indefinite loading message.

Dev repo setup now offers an in-app explorer of folders on the connected Mac.
Selecting a folder prefills a unique editable name and shows its canonical path
before saving. Folder navigation, breadcrumbs, Up, filtering and saved locations
work from phone and desktop. Cancellation restores focus, preserves the editor,
remembers the last location and aborts pending selection validation. Late replies
cannot replace the current listing. A Git checkout offers individual-repository
setup. Failed saves retain the selection; repeated save clicks cannot submit the
same group twice. Advanced path entry remains optional.

## Boundaries reviewed

- UI: shared three-destination navigation, explicit legacy URL handling, native
  modal dialog, visible actions, loading/error/empty/partial states and controlled
  save boundaries. The picker footer stays visible while folder content scrolls.
- API/filesystem: paired, same-origin POST endpoint with an 8 KiB body limit;
  directory-only metadata within canonical Home or saved Dev repo roots. Every
  listing checks containment, path components, symlinks and excluded directories.
  Enumeration examines at most 1,000 entries with a five-second listing deadline;
  filtering narrows those bounded results, not an unrestricted recursive search.
- Storage: existing settings revision checks and root/repository validation remain
  authoritative. No schema migration, new persisted permissions or automatic
  repository enablement is introduced by browsing. The existing explicit
  selection/verification approval workflow remains in place.
- Background/external: no watcher, filesystem writes, shell passthrough, Finder
  prompt, paid provider task, tool installation or live service change is added.
  Tests use disposable Git, fake agents and a fixture-local browser Home supplied
  through dependency injection. Production uses the connected account's Home.
- Updates: policy and migration guards are unchanged; automatic installation
  remains opt-in and off by default. The data-contract source files are unchanged.

## Passed checks

| Check | Result |
| --- | --- |
| `npm run verify` | Passed: 764 backend passes, one platform skip, 138 UI passes, lint, both type checks and build. |
| Backend coverage | 764 passes, one platform skip; 97.43% lines. |
| Final UI coverage | 138 passes; 95.88% lines. |
| Final UI polish validation | UI coverage, lint, types and production build passed after the final footer/cancellation refinements. |
| Standard Chrome Cypress | 85 passes; five mode-specific cases intentionally pending in this run. |
| Settings-mode Cypress | One real-service no-typing two-folder setup journey passed, including repository selection, setup return, Goals/Sessions navigation and preserved goals. |
| Goals navigation Cypress | Three passes: direct pairing at phone/desktop widths and connection recovery; included in the standard total. |
| Orchestration Cypress | Two real-service execution cases passed in normal mode; the remaining read-only case passed separately. |
| Updates Cypress | One pass on a fresh settings fixture; exact-commit confirmation, queue behavior and opt-in defaults preserved. |
| Visual inspection | Folder picker at 360/390/1440px; Goals empty state at 390/1440px. Standard consistency tests also passed their existing viewport/enlarged-text matrix. |
| `git diff --check` | Passed. |

The final focused settings/Goals run passed four cases together. All five cases
skipped by the standard runner passed under their designated modes. CI checks the
pushed PR head separately; use the PR check status for that evidence.

## Interventions and limitations

Initial regression runs identified expectations for the removed top-level
Sessions link and the former monitoring pairing screen after logout. Tests now
verify the intended Goals navigation while retaining explicit session coverage.
A folder-picker screenshot assertion initially searched inside the dialog for the
dialog itself; it now checks the dialog subject. Visual inspection then caught
an inherited low-contrast setup link, duplicated Home controls and footer/content
overlap; these were corrected and the screenshots regenerated. A cancellation
test used an unsupported helper; it now dispatches the native cancel event.

Running the update scenario after the settings scenario on the same disposable
service left an intentional goal active, so the updater correctly did not become
idle. Running the update test on its own fresh fixture passed. The occupied
Cypress port 3221 was preserved; owned checks used free ports 3247/3248 instead.
No verification guard or coverage threshold was relaxed.

The human three-minute usability measure, VoiceOver, native browser zoom and
physical-phone keyboard interactions remain unverified. Native dialog semantics,
focus restoration, cancellation and stale replies have automated checks; these
are not a claim of a complete WCAG audit. No merge, live installation or remote
Mac operation is part of this implementation. Owned disposable services are
closed by the runners; the developer checkout and its unrelated untracked plan
remain untouched.

## Screenshots

- [Phone folder explorer, 360px](goals-first-evidence/folder-picker-360.png)
- [Phone folder explorer, 390px](goals-first-evidence/folder-picker-390.png)
- [Desktop folder explorer](goals-first-evidence/folder-picker-1440.png)
- [Phone Goals](goals-first-evidence/goals-empty-390.png)
- [Desktop Goals](goals-first-evidence/goals-empty-1440.png)
