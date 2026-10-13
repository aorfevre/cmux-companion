# Recovery diagnostics and stalled-goal fixes

Date: 2026-10-13. Implements the existing approved
[agent-led recovery contract](superpowers/specs/2026-10-13-agent-led-goal-recovery.md).

## Findings and changes

Read-only inspection confirmed the running service included PR #194 and both
reported goals had adopted recovery. Their stopped supervisor receipts contained
`NATIVE_TERMINAL_FAILED`; one implementer had hit `OUTPUT_LIMIT`. The original
terminal receipts did not retain their exceptions, so the exact historical wrapper
exceptions remain unknown. Both provider session receipts recorded exit code zero
before the wrappers stopped.

The bridge and supervisor command loops treated numeric DOMException error codes
as fatal application codes. A real HTTP request timeout reproduces that problem.
They now retry transport timeouts within the same wait or command receipt, without
starting a provider or losing command idempotency. String application errors still
retain their authority semantics. Terminal wrappers retain their structured error
code instead of reducing ordinary bridge errors such as FORBIDDEN to a generic
failure. Abort and stopped-process proof remain separate from error classification.

The implementation adds bounded recovery for confirmed stopped terminal-wrapper
and output-limit failures. It retains setup/authentication, pending-result,
uncertain-process and external-effect guards. The existing strategy-change and
budget requirements still prevent indefinite identical retries.

The failed implementer's saved output contained 5,648 thinking-counter frames,
roughly 1.09 MB of its 2 MiB output allowance. Claude stream-json execution now
discards only complete, small, schema-recognized thinking-counter telemetry before
charging the substantive output limit. Tool messages, results, unknown frames,
oversized frames and partial output remain bounded. Streaming buffering is capped
at 4 KiB per pending candidate frame; execution and idle limits remain active.

Adoption previously charged the entire historical goal spend against every work
episode. Per-episode attribution now follows recorded revision/role and repair
evidence, retaining the total goal spend. A system-only, journaled transition
attributes older policy snapshots with no post-adoption decisions. Incomplete
history or already-mixed old/new spending stays conservative and requires an
explicit budget decision when exhausted. No spending is erased or allowance
extended by the migration.

## Logs and boundaries

Native receipts and structured stderr events retain operation identity, execution
phase, exception type, error/cause codes and output accounting. They omit exception
messages, stacks, command arguments, credentials and provider text. Background
receipts include received/retained byte counts, output limit and discarded
telemetry counts. See the [operator guide](orchestration-recovery.md#native-recovery-diagnostics).

Domain/service/storage changes persist attribution and recovery reservations;
native adapters handle process output and diagnostic receipts; the existing API
and UI consume the same recovery projections. No new user/agent authority or
external publication path was added. The browser journey uses real disposable
service/Git with fake providers. Native boundary tests use owned disposable
processes and PTYs, not installed provider accounts.

## Evidence

- Real HTTP timeout regression: a supervisor wait survives the timeout and returns
  the next saved wake; a command timeout retries the exact original receipt.
- Real terminal fixture: a bridge rejection persists FORBIDDEN and `turn_start`,
  logs a structured outcome and excludes the private response/credential.
- Process output regression: telemetry exceeding the raw byte allowance completes
  with its result intact; substantive output still fails at the original limit.
- Historical-state regressions: unrelated revisions do not exhaust current work;
  missing history cannot create fresh allowance; system attribution persists once
  and restart retains one scheduled recovery.
- Mixed rejected-plan/stopped-supervisor regression retains human plan approval.
- Read-only replay of copies of both reported goals: recovery becomes eligible
  while retaining their historical goal spending (four and one actions). This is
  eligibility evidence, not proof of a successful live provider run.
- Chrome real-service conversation Cypress passed with both
  `NATIVE_TERMINAL_FAILED` and `OUTPUT_LIMIT` injected and no manual recovery click.
- Mac boundary suite: 106 passed.
- Final targeted domain/scheduler migration suite: 110 passed.
- Full verification: first run passed (1,205 backend passes, one pre-existing
  skip; 257 UI passes; backend/UI line coverage 97.68%/95.56%; lint/types/build).
  The final backend coverage run passed 1,208 tests with one pre-existing skip,
  but failed one unchanged updater contention test (see below); line coverage was
  97.73%. The remaining UI/lint/types/build commands passed separately (257 UI
  tests, 95.56% UI line coverage).

One initial targeted assertion compared the entire process outcome to the old
shape and failed on the new output counters. Its expected outcome now verifies
the counters; the corrected targeted run passed 72 tests. A later full run caught
a historical-budget fixture claiming four replacements but recording only three.
The missing-history guard correctly refused fresh allowance; the fixture now
records all four replacements and the separate missing-history regression retains
the refusal. Coverage thresholds and runtime output/deadline limits were not reduced.

The final full run also exposed an intermittent failure in
`acquireLock lets exactly one of many concurrent claimants replace a stale reclaim
marker`: two claimants won. `updater/src/lock.mjs`, the standalone bootstrap and
that test are unchanged by this branch. Inspection found that the stat/rename
sequence can rename a replacement marker after observing the previous stale one,
allowing two reclaimers into the critical section. This is distinct from the
earlier immediately-exiting fixture problem fixed in PR #194. It remains a
separate updater defect; no unchanged local full-suite retry was used to hide it.

## Deployment boundary

No installed service was updated, live goal mutated, provider launched, PR merged
or release deployed. The old failure receipts cannot be retroactively enriched.
The two live goals will only use the fix after a separately authorized deployment;
their eventual provider outcomes remain unverified.
