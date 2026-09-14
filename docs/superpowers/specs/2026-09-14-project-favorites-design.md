# Favorites-first project picker

Date: 2026-09-14
Status: Awaiting human review after this spec commit.
Owner: Implementing agent, including API integration, validation and cleanup.

## Outcome

Replace the Goals form’s oversized native repository dropdown with a compact,
searchable project picker. Favorite projects appear first; other projects remain
hidden until the user explicitly chooses Show all projects. This supersedes the
always-visible Goals catalog requirement in the 2026-09-13 settings design only
for presentation: every tracked project remains available through that control.

## User journey

1. The goal form shows a Project field with the selected project’s name and Dev
   repo on separate lines. Branch and setup messages appear below the field,
   never appended to every project name. Choosing a project remains separate
   from starting a goal.
2. Opening the field reveals a bounded, inline picker with a search input,
   Favorites heading and compact project rows. Each row has a selection button
   and a separate star button with Add to favorites or Remove from favorites
   accessible text. Names are primary; karven or rekord is secondary metadata.
3. Favorites are sorted by name, with Dev repo as a tie breaker. A Show all
   projects (N) button reveals the remaining projects below Favorites, grouped
   by Dev repo and sorted by name. Hide other projects collapses them again.
   The picker defaults to favorites-only whenever reopened.
4. Search filters the currently visible sections by project name, Dev repo and
   GitHub owner. Hidden projects stay hidden during search; Show all projects
   remains available and applies the same query when expanded.
5. With no favorites, show No favorite projects yet and a prominent Show all
   projects button. Do not automatically expose hundreds of projects or choose
   an arbitrary hidden project. An existing selection remains visible in the
   closed field even when it is not a favorite.
6. Selecting a row closes the picker and retains the goal draft. Opening and
   closing it without selecting preserves the previous selection. Escape closes
   it and returns focus to the trigger. Standard buttons, labelled search and
   headings provide keyboard access without custom listbox keyboard semantics.
7. Toggling a star saves immediately and shows Saving/Saved or an actionable
   error. A failed save retains the last confirmed state. Favorites are shared
   across paired devices connected to this Companion installation and survive
   reload, restart, repository rediscovery and Dev repo rename.
8. Disabled and unconfigured projects can be favorited and selected for setup;
   their existing execution gates and contextual setup link remain intact.

## Boundaries and non-goals

- UI: Goals project selection only, using shared style tokens, visible focus,
  44px minimum touch targets, wrapped names and a vertically bounded scroll area.
  Preserve title/provider/model inputs and goal actions. Settings need not gain
  another favorite editor in this change.
- API/storage: persist favorite state against stable project IDs in local
  settings, defaulting old and newly discovered entries to false. Provide a
  scoped, validated, revision-checked mutation that cannot overwrite other
  settings. Preserve the existing draft on conflicts and offer retry after
  rereading confirmed state. Unknown repository IDs must be rejected.
- Security: preserve authentication, same-origin enforcement and existing
  read-only handling. Favoriting does not enable projects, approve checks,
  change Git destinations or admit execution.
- Background: reconciliation preserves favorites. No new timer, scheduler
  behavior or effect recovery changes. Existing goals retain their snapshots.
- External: no GitHub writes, repository modification, live-session changes,
  updater policy changes, cloud account preference sync or disk cleanup.
- Delivery: implementation PR targets main; deployment and merge follow the
  applicable user authorization separately from design review.

## Acceptance criteria

| Observable acceptance | One designated verification |
| --- | --- |
| Favorites appear first; nonfavorites are hidden until Show all projects, including when searching. | UI picker filtering and disclosure scenario. |
| No favorites, no results, long duplicate names, unavailable entries and existing nonfavorite selection have clear usable states. | UI picker edge-state scenario. |
| Stars persist across restart and rediscovery without changing other settings or execution readiness. | Backend persistence/reconciliation fixture scenario. |
| Unpaired, cross-origin, invalid-ID and stale-revision writes fail safely; failed saves show recoverable UI feedback. | Settings API and UI conflict scenario. |
| A user can reveal projects, favorite one, reload and select it to prepare a goal without losing the draft. | Real disposable service Cypress favorites journey. |
| Phone and desktop layouts have bounded scrolling, readable names, keyboard operation and no horizontal overflow at 200% zoom. | Recorded visual and keyboard matrix at 360px, 390px and 1440px. |
| Existing goal creation and settings behavior remain intact. | npm run verify plus backend/UI coverage at least 90%. |

## Success measure

After favoriting two projects in a disposable walkthrough, reopening the picker
shows only those two rows and the all-projects button; either favorite is selectable
in two activations without scrolling through the rest of the catalog.

## Review boundary

Commit this spec and obtain a person’s review before committing the implementation
plan, as required by AGENTS.md. Record passed, failed and unverified checks in the
implementation PR; do not claim a visual review from source inspection alone.
