# Updater lock recovery

## Outcome
The bundled updater cannot stay silently locked. A lock directory that no live
process owns is reclaimed after the stale window, a failed lock claim never leaves
a directory behind, and an operator can see from the updater log why a cycle was
skipped.

## Context
The updater bootstrap (`~/.local/libexec/cmux-companion-updater`) and
`updater/src/lock.mjs` share one lock directory,
`~/.config/cmux-companion/updater/lock`. Both readers today treat a lock whose
`owner.json` is missing, empty or has no `pid` as held forever. The bootstrap
creates the directory and then writes `owner.json`; when that write fails (for
example `ENOSPC`, seen in the installed error log on 2026-09-05 and 2026-09-16),
the directory survives without an owner. Every later 5-second cycle then exits
with code 0 and no message. The only visible symptom is "heartbeat stale" on
the Setup page. The 2026-09-16 fix (commit 927d9d41) covered a claim with a dead
`pid` but kept the no-`pid` shape protected, and no spec recorded the lock rule.

## Lock rule (decision)
1. A lock is held while its owner `pid` or `enginePid` is alive.
2. A lock whose owner is dead, or whose `owner.json` cannot be read or has no
   positive integer `pid`, is an orphan once the directory is older than
   15 minutes. Orphans are reclaimed.
3. A lock younger than 15 minutes is protected in every case, so a claim that is
   still being recorded is never stolen.
4. The claimant that fails to record its owner must remove the directory it
   created before it exits.
5. A cycle that skips because the lock is held reports that fact once per state
   change in the updater log, not once per cycle.

Legacy "unknown launch claims" (a lock with no readable owner) no longer exist:
the retired two-repository updater is not installed alongside the bundled one
(see `docs/updates.md`, Existing installations).

## User journey
An owner notices Setup shows the updater heartbeat as stale. The updater error
log shows one line naming the held lock, its owner pid and the claim time. After
the stale window the next cycle reclaims the lock and the heartbeat recovers
without operator action. If the Mac ran out of disk, the bootstrap refuses to
claim the lock and logs one line until space returns.

## Non-goals
- Changing when the maintenance fence is held relative to the release build.
- Enabling release retention by default or changing the disk-space floor policy.
- Silencing the `node:sqlite` experimental warning in the LaunchAgent.
- Recovering an installed machine that is already orphaned: the fixed bootstrap
  reaches `~/.local/libexec` only after one successful update, so an already
  orphaned installation needs one manual removal of the stale lock directory.
- Restarting the updater LaunchAgent. The launcher process
  (`launch-updater.mjs`) is bound to the release it imported at start and is not
  restarted by an update. The once-per-state-change log line appears only after
  the LaunchAgent restarts (login, reboot or an explicit `launchctl kickstart -k`),
  which is an operator step outside this change.

## Design notes
- The bootstrap refuses to claim the lock below a 64 MB free-space guard. This
  guard protects the lock claim and owner write only. It is distinct from the
  512 MB release floor that `ensureDiskSpace` applies before a build, which is
  unchanged.
- The bootstrap reads an optional `CMUX_COMPANION_UPDATER_FAILPOINT` environment
  value so a test can inject an owner-write failure. Whoever controls the
  LaunchAgent environment already controls the program path, so this adds no
  attack surface, but it is a deliberate test seam in a security-sensitive script.
- The bootstrap maps an engine exit code of 3 or 4 to 1 so the launcher never
  mistakes an engine failure for "lock held" or "low disk".

## Acceptance criteria
| Criterion | Verification |
| --- | --- |
| `acquireLock` reclaims a stale lock with a missing, empty or pid-less owner and protects a fresh one. | `updater/tests/unit.test.mjs` lock cases. |
| The bootstrap reclaims the same shapes and still protects fresh claims and live engines. | `tests/updater-native.test.mjs` bootstrap claim test. |
| A bootstrap whose owner write fails removes the lock directory before exiting non-zero. | Bootstrap test with an unwritable owner path. |
| A held lock produces exactly one log line per state change in the launcher. | Launcher unit test with a fake bootstrap exit code. |
| Insufficient free space refuses the claim without creating the lock directory. | Bootstrap test with an injected free-space value. |

## Success measure
No installed updater cycle exits silently while the lock is held, and an orphaned
lock recovers within 15 minutes plus one cycle.
