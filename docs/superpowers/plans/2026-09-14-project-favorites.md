# Favorites-first picker implementation

Spec: ../specs/2026-09-14-project-favorites-design.md
Human review: user approved with “perfect. Do it” after spec commit c5d919c.

1. Add a project-ID keyed preference table within the settings database and scoped revision-checked
   read/write settings routes; retain discovery and execution boundaries.
2. Replace Goals native select with an accessible bounded picker; persist stars,
   preserve selection and goal draft, support explicit reveal/search and errors.
3. Cover storage/security, picker edge cases and disposable Cypress journey.
4. Run verify, backend/UI coverage and local browser checks, inspect screenshots,
   then publish a main-targeting PR with passed/failed/unverified evidence.
