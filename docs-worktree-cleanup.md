# Automatic worktree cleanup

Companion inventories both `/Users/aorfevre/Developers/karven` and
`/Users/aorfevre/Developers/rekord` (or `CMUX_COMPANION_REPO_ROOTS`). It discovers
nested repositories, including hidden agent directories, and deduplicates by
canonical Git common directory. Every registered worktree is included, even
outside those roots. External development paths are inventory-only. Managed
release paths are always reserved for the updater.

Discovery skips dependency/build/cache directories (`node_modules`, `.next`,
`dist`, `build`, `coverage`, `.cache`, `.turbo`, `.venv`, `venv`, `vendor`) and Git
object directories. Before deleting an otherwise eligible checkout, a separate
bounded walk also checks its ignored build directories for nested repositories.
Symlink directories are never traversed. Discovery errors remain in the report.
Bare repositories and unreadable Git metadata are protected.

## Goal lifecycle and defaults

- A goal PR being created retires its recorded cmux task and merge sessions
  once their agents are no longer running or waiting for input. Follow-up sessions
  are separate. `CMUX_COMPANION_AUTO_CLOSE_SESSIONS=0` disables automatic session
  retirement; the existing manual session-cleanup action stays available.
- A **merged goal PR** makes the associated worktrees eligible immediately,
  without a seven-day wait, only when their exact HEADs match the delivered work.
  The watcher requests a cleanup pass after observing a merge. Its normal GitHub
  supervision interval is five minutes; explicit Refresh GitHub also observes
  merges. Cleanup requests remain inert while automatic deletion is disabled.
- Other worktrees require independently verified merged commits and a default
  **seven-day grace** from the first eligible observation of that HEAD and
  filesystem identity. A new HEAD, new directory identity, or an ineligible
  observation resets this clock. The grace is configurable from 0 to 365 days.
- Automatic development deletion is **disabled by default**. Its configurable
  schedule defaults to 24 hours. When enabled, the first due check occurs within
  a minute of startup, with future due checks evaluated each minute.
- Git stale-registration pruning is independently **disabled by default** and
  uses a default **30-day** expiration according to Git's metadata semantics.
- Release deletion is independently **disabled by default** in the updater,
  with a 24-hour default interval. Enabling development cleanup does not enable
  release cleanup or pruning.

The **Settings → Worktree cleanup** panel (also available in the Worktrees dashboard) offers policy controls, **Preview
cleanup**, explicit candidate selection, and **Run cleanup**. Manual deletion
requires a current reviewed preview but does not enable scheduled deletion.
Changing the policy invalidates the previous preview. Previews expire after
30 minutes and cannot be reused after a run. Protected rows cannot be selected.
The separate release panel forwards operations to the deployed updater.

## Proof and preservation

A clean status alone is never enough. For a goal, the persisted plan must identify
the exact path and branch, GitHub must confirm its final goal PR is **MERGED**
into the planned base, and the worktree HEAD must match the PR head. For combined
goals, a task's exact pinned HEAD must also have its `Cmux-Goal-Task` integration
trailer in the merged goal PR's history. A task PR does not finish a combined goal.
An open goal PR protects its worktrees. New commits after the merged PR protect
them too. Git branches are preserved, including when remote PR branches were
deleted after merge.

For worktrees outside that durable goal mapping, the local origin default-branch
reference must match `git ls-remote`. Ordinary ancestor containment qualifies.
Squash merges qualify via an identical tree in default-branch history or a merged
GitHub PR whose exact head and merge commit can be verified in that history.
No fetching, rebasing, resetting or patch application is performed by cleanup.
Missing GitHub authentication, stale remote refs, changed PR heads, unreadable
history, and ambiguous matches preserve the checkout. Fetch the repository and
preview again when refs are stale. An unknown/removed goal record can therefore
fall back only to the conservative generic merge proof and grace period.

Every removal also requires:

- No tracked modifications, staged changes, or untracked files, including
  submodule changes. Any submodule or nested repository protects the worktree.
- No open cmux session using the path and no current-user process with its
  working directory inside it. Fresh cmux and `lsof` data are required; failures
  and sessions without known directories protect worktrees.
- No Git worktree lock. Primary checkouts, bare repositories, managed releases,
  symlink paths, changed filesystem identities, and broken Git references are
  protected regardless of apparent cleanliness.
- No ignored files outside the known disposable build directories:
  `node_modules`, `.next`, `dist`, `build`, `coverage`, `.turbo`.
  Wrangler deployment metadata (`.wrangler/deploy/config.json`) and logs
  (`.wrangler/wrangler.log`, `.wrangler/logs/`) are also disposable; other
  Wrangler contents, including local state databases, are protected.
  For example, ignored `.env`, `.claude`, or Wrangler state files are preserved and
  named in the preview, even if a human considers them disposable.

Deletion removes the entire worktree folder, including tracked copies and the
allowed ignored build output. It does **not** remove the Git branch or the common
object database. No force flag is used for development worktrees: Git's native
refusal of dirty, untracked, locked, or submodule worktrees is the final guard.

## Concurrency, pruning and limitations

The inventory is revalidated immediately before each removal: current
registration, common directory, HEAD, inode/device, path components, complete
status, nested repositories, sessions/processes, and merge proof. A private
cross-process lock per Git common directory coordinates cleanup with all
Companion cmux launches, including launches into subdirectories. A separate
state lock prevents overlapping sweeps, previews and policy writes. Launches
that collide are refused and can be retried. Results are persisted per removal;
one failure does not stop other selected candidates.

Other tools and arbitrary shells do not honor Companion's locks. Final process
checks and Git's own guards reduce that race, but cannot make deletion atomic
against an external process that starts writing ignored output between those
checks and Git's removal. Do not enable unattended cleanup where such tools
operate without a stable working directory/session or Git worktree lock. The
process inventory covers the current macOS user; privileged/other-user activity
is not guaranteed visible. Estimates use `du -sk` without following symlinks;
APFS sharing, concurrent output, and deleted-but-open files can make actual free
space differ. Reclaimed bytes in history are explicitly estimates.

Missing directories are a separate registration-pruning operation. The preview
shows Git's `worktree prune --dry-run --verbose --expire <days>.days.ago` result.
Execution repeats the dry run under the repository lock and requires exactly the
same output before invoking Git's real prune. It never directly removes anything
under `.git/worktrees`. Pruning is repository-wide, respects Git expiration and
locks, and refuses unknown administrative registrations. Broken discovered Git
references suspend automatic pruning until repaired, including moved worktrees
whose registrations appear missing at their old paths.

State is in `~/.config/cmux-companion/worktree-cleanup/state.json`, mode 0600.
The latest preview, eligible observations, and last 30 runs are retained. History
includes removals, automatic skips, failures and estimated reclaimed bytes.
Disabling scheduling affects future runs; an operation already holding the lock
finishes its current reviewed sweep. Failed items can be selected in a fresh
preview and retried.

The dry-run CLI performs no Git mutation or worktree deletion. It records the
preview and observations in Companion metadata:

```sh
node scripts/worktree-cleanup.mjs --output /tmp/worktree-cleanup-review.json
```

## Recovery

After removal, recreate a checkout with `git worktree add /new/path branch-name`.
The branch still points at the original commits. Reinstall dependencies and build
outputs; deleted ignored artifacts cannot be restored from Git.

For a moved checkout or broken `.git` pointer, inspect `git worktree list
--porcelain` and use `git worktree repair /actual/worktree/path` from the correct
primary repository. Verify status before considering any pruning. Do not edit
or erase Git administrative directories as an automatic repair.

Operation locks intentionally have no time-based stealing. After an interrupted
process, inspect `worktree-cleanup/locks/<hash>/owner.json`, confirm the PID is
no longer alive and that no operation is running, then remove only that abandoned
lock directory. Do not clear a live process's lock. A corrupt state file fails
closed; preserve a copy for diagnosis before restoring a known-good copy.

## Validation

Backend tests create temporary repositories and cover exact-commit eligibility,
squash merges, goal PR merge boundaries, dirty/untracked/ignored files, submodules,
nested repositories, sessions, unavailable process inventories, locks, missing
paths, broken references, path changes, concurrent launches, grace periods,
pruning, retries and branch preservation. Cypress tests the preview/selection,
protected rows, enable/disable controls, manual results/history and separate
release retention UI with deterministic API fixtures. Run `npm test` and
`npm run test:e2e:local`. Cypress remains local-only; no validation deletes real
worktrees. Updater retention tests run in that repository with `npm run verify`.

### Restored cmux sessions

The session collector also reconciles live workspace UUIDs missing from stored
goal records, as can happen after a cmux restore. It requires an exact stored
checkout path and a matching Companion task/merge title identifying one unique
goal. The goal must have recorded PR delivery or the task must be integrated.
Follow-up identities and unrelated names are excluded. Immediately before
closure it reloads ownership and workspace identity, and requires fresh status
that explicitly reports no running agent, no pending input, and no dirty checkout.
Unknown activity, ambiguous ownership, and missing delivery evidence preserve
the workspace. A zero count means no sessions currently qualify; it does not
mean every open workspace is useful. Closing a workspace leaves its worktree
and Git branches intact. Restored UUIDs never overwrite stored task ownership.
