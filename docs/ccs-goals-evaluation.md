# CCS Goals implementation and evaluation evidence

Status: delivery contract approved; implementation in progress.

Contract: [CCS-based conversational Goals](superpowers/specs/2026-10-12-ccs-goal-experience.md).
Spec commit: `aa8b19c4`.
Branch: `feat/ccs-goal-experience`, based on `origin/main` at `02a433a3`.

## Launcher discovery — 2026-10-12

Read-only terminal metadata lookup established that both `xclaude` and `xcodex`
are aliases in the current Mac environment. The repository's existing
`resolveProviderCommand` was then called for each, with model `default`.
Neither call launched CCS, a model or a cmux workspace.

| Launcher | Current resolver result | Permission flags discarded by existing resolver |
| --- | --- | --- |
| `xclaude` | `ccs claude` | `--dangerously-skip-permissions` |
| `xcodex` | `ccsxp` | `--yolo` |

This proves the current aliases can be resolved by the existing code. It does
not prove their native startup, account selection, resume/input transport or
termination behavior. Their actual provider/account credentials were not read
or printed. The implementation must make its managed-policy differences explicit
and preserve CCS routing rather than treating alias resolution as runtime parity.

## Checks

- Passed: fresh remote main fetched and an isolated worktree created.
- Passed: spec commit whitespace check (`git show --check HEAD`).
- Passed: read-only alias lookup and existing resolver for both launchers.
- Passed: `npm ci --no-audit --no-fund` on Node 22.23.1 in the isolated
  worktree (856 packages installed; checked-in lockfile unchanged).
- Passed: existing adapter baseline, 18 tests, zero failures/skips:
  `node --test --test-concurrency=4 tests/provider-command.test.mjs tests/orchestration-ccs-managed-launcher.test.mjs tests/codex-native.test.mjs`.
  These tests cover alias resolution, fixed CCS invocation/routing, native
  session binding, resume arguments, process/PTY identity and restricted tools
  with disposable fake providers. They do not establish live launcher parity or
  the proposed continuous Goals conversation.
- Not run: new-experience implementation tests, full coverage, lint, typecheck,
  build or Cypress.
- Not run: native provider/cmux trials, GitHub publication, installation or update.

No product implementation or acceptance criterion is claimed complete. A1–A16
and the five-goal native success measure remain pending. The user approved the
committed contract with “implement the goal. I approve it”; the human-review
gate is satisfied before the implementation plan commit.

The original checkout and its untracked burst-scan plan remain unchanged.
