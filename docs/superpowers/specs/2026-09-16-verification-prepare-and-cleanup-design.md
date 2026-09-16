# Verification dependency preparation and worktree cleanup

Date: 2026-09-16
Status: Awaiting human review after this spec commit.
Owner: Implementing agent, including API integration, validation and cleanup.

## Problem

Verification runs approved checks in a fresh Git worktree under the Companion
data directory. That worktree never receives installed dependencies, so every
JavaScript check fails the same way on every retry: `eslint: command not found`,
`vitest: command not found`, or a stray home-directory `tsc` that cannot parse
the repository. The hold reason says only "Required verification failed on the
integrated head", which hides the cause. Verification and integration worktrees
are never removed, and agent worktrees are removed only by manual cleanup of
delivered or aborted goals. Six abandoned agent worktrees of one repository held
903 MB on 2026-09-16.

## Outcome

Verification worktrees receive their dependencies through a per-project prepare
command that Companion detects from the repository lockfile, saves as an
approved default, and lets the user change or disable in Setup. The prepare
outcome is a named check with its own evidence. Every verification worktree is
removed as soon as its run records a stopped result. A shared, size-capped npm
cache keeps repeated installs fast without touching the user's home cache.

## User journey

1. A user adds or rescans a repository in Setup. Inspection reads the lockfile
   name only and never executes anything. The project row shows a Prepare line,
   for example "npm ci · detected". The user may edit the executable and
   arguments, or disable prepare, with the same controls used for checks. A
   custom or disabled value survives later rescans; only rows marked detected
   or none follow detection.
2. A goal reaches verification. The runner resolves the project's prepare command
   through the same executable resolution as checks and runs it first in the
   verification worktree, supervised, with the run's isolated HOME and TMPDIR,
   and with `npm_config_cache` pointing at the shared Companion cache. The
   outcome is recorded as check `prepare` ahead of the planned checks.
3. When prepare fails, the remaining checks are recorded as not run with code
   `PREPARE_FAILED` and the goal hold reason reads "Dependencies did not install
   on the integrated head". The Run report shows the install output through the
   existing Inspect check output control. A project with prepare disabled or
   without a lockfile runs checks exactly as today.
4. As soon as a verification run records a stopped result, its worktree is
   removed. Branch, ownership ref, manifest and artifacts remain. A removal
   failure is reported and never changes the verification result. On startup,
   verification worktrees whose run already holds a stopped result are removed.
5. The stuck goal recovers without a plan change: after a rescan detects
   `npm ci`, Retry verification & resume runs prepare and the approved checks.

## Design

- Detection table, owned by Companion, keyed by lockfile name:
  `package-lock.json` → `npm ci`; `pnpm-lock.yaml` → `pnpm install
  --frozen-lockfile`; `yarn.lock` → `yarn install --immutable`; `bun.lockb` or
  `bun.lock` → `bun install --frozen-lockfile`. The first match in that order
  wins. No other source may set a detected value.
- Project setting `prepare: { source, executable?, args? }` with source
  `detected` (Companion chose it from the lockfile), `custom` (the user edited
  it), `disabled` (the user turned it off) or `none` (no lockfile was found).
  Only `detected` and `none` rows follow later detection; `custom` and
  `disabled` rows never change on their own. Validation reuses check
  validation: no shell wrappers, bounded arguments, executable name or absolute
  path.
- The prepare command is read from the current project setting at run time,
  not from the goal's configuration snapshot, because it is infrastructure the
  user approved in Setup. This is what lets an already-held goal recover after
  the user enables or corrects prepare.
- Runner: prepare resolves through the project setting, not the goal contract,
  because it is infrastructure the user approved in Setup. Prepare shares the
  execution policy of checks and is subject to the same ceiling, idle and output
  limits. Its artifact carries `checkId: "prepare"`.
- Shared cache at `<data directory>/resources/npm-cache`, created with mode
  0700. After each run, when the directory exceeds 2 GiB, Companion removes the
  oldest cache content entries until it is under the cap. No other cache
  location is read or written by verification.
- Cleanup: a repository port method removes a verification worktree only after
  it confirms the recorded path, registration and branch, then runs
  `git worktree remove --force`. Force is acceptable here because installed
  dependencies are untracked files that the run created; the checked head and
  evidence are already recorded. Agent and integration worktrees keep the
  existing manual cleanup rules.

## Non-goals

- No planner or agent control over the prepare command.
- No dependency installation for agent or integration worktrees.
- No prepare detection for languages other than the JavaScript lockfiles above.
- No change to the goal contract schema or to approved plans.
- No reuse of the user's `~/.npm` cache.

## Acceptance criteria

- Detection selects the expected command for each lockfile, and none without a
  lockfile: local-settings unit test.
- A custom or disabled prepare value survives a rescan; a detected value follows
  detection: settings-runtime test.
- Prepare success runs the planned checks with their dependencies present:
  disposable orchestration test with a fake prepare that writes `node_modules`.
- Prepare failure records `prepare` as failed, the other checks as
  `PREPARE_FAILED`, and the hold reason names dependencies: verification runner
  and recovery domain tests.
- The verification worktree is absent after a stopped result and after a
  restart with a stopped result on disk; branch, ref and artifacts remain:
  verification coordinator test with a real disposable repository.
- Cache pruning keeps the directory under the cap: cache unit test with a small
  cap.
- Setup shows and edits the Prepare line: Vitest UI test and the settings
  Cypress spec.
- The orchestration Cypress journey passes with a fake prepare command.

## Success measure

The paste-image goal on this Mac leaves its verification hold after a rescan and
one Retry verification & resume, and the worktree directory holds no completed
verification worktrees afterwards.
