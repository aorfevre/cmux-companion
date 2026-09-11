# Disposable orchestration task repository

This dependency-free project is copied to a temporary Git repository with its own
local bare remote. The initial acceptance checks intentionally fail: task A must
return 2, task B must return 3, and task C must compose both into 5. A and B are
independent; C requires both integrated changes. No nested Git metadata is tracked.

The harness supplies conflicting A/B edits, a failing C candidate and a repaired C
candidate. Acceptance checks stay unchanged across all variants. Run checks in a
generated checkout with `node --test test/acceptance.test.mjs`.
