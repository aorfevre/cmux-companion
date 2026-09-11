# PR 115: additional xclaude Fable review

The user requested this additional review after the original local delivery and
independent architecture gates passed. The focused native reviewer completed
with read/search-only tools, no shell, edits, live integration or delegated work.
Its final report is preserved below; its stated tool-call count is the reviewer's
own accounting, not a test result.

## Remediation status

Three low-severity findings were confirmed and fixed:

- Validate every repository owner/binding before updating any binding, so a later
  ownership refusal preserves earlier history.
- Classify a missing previously bound journal as `OWNERSHIP_UNCERTAIN`.
- Move readiness backfill from store construction into owned scheduler startup,
  checking the owner within the backfill transaction.

The targeted cutover/scheduler/storage suites pass 71/71, including new refusal
and missing-journal regressions and the ownership-gated backfill regression.
Full verification passed 615 backend tests with one platform skip and all 114
UI tests, lint, types and build. A further competing-owner regression passes
and directly audits that reopening/refused startup performs no readiness writes.
The real-service Cypress writable journey passes 2/2; its read-only case runs in
a separate mode. Updated backend coverage and a native Fable post-fix review
remain pending. The separate full PR
review is still running; it started at `5de0b86`, and any findings will be checked
against the final source because focused fixes began before that report returned.

Questions remain explicitly separate from defects: empty legacy inventory is an
operator declaration for fresh installations; failed shutdown retains ownership
until stopped proof; the listener is deliberately IPv4 loopback, although the
entry point's accepted host aliases deserve clearer validation; duplicate configured check IDs may provide alternative allowed argv, while
`domain/graph.mjs` requires unique IDs in an accepted contract and production
resolves the full ID/argv pair. No live behavior is inferred from this review.

## Focused reviewer report

Review complete. I used 12 of the 15 allowed tool calls and read all six named files plus the scheduler start/stop, store constructor, native background close path, and the ownership schema.

## Verdict

No confirmed high-severity defect. Startup cannot launch two owners, cannot rebind an active journal, and does not leak workers it launched on a failed start, given the code as read. Three low-severity defects and four open questions follow.

## Confirmed defects (low severity)

1. **Partial binding rewrite on a failed multi-repository acquisition.** `server/orchestration/cutover.mjs:93` writes the new binding for each Git common directory before the loop has finished acquiring the remaining directories. Trigger: repository A's common dir is bound to an old, fully stopped database, and repository B's common dir is bound to a database whose owner is alive. B fails with OWNERSHIP_UNCERTAIN, but A's binding has already been rewritten to point at the new database, and the catch at line 98 only releases owners. Consequence: the record that A was previously bound to the old database is lost. The rollback check on the old database already passed, so this cannot rebind an active journal, but the failed startup is not side-effect free. Fix direction: collect all bindings first and write them only after every common dir has been acquired and checked, or write the binding inside the same transaction as the owner row and defer commit.

2. **Missing previous database is refused with a generic error, not an ownership code.** `server/orchestration/cutover.mjs:103` calls realpathSync on the recorded previous path. Trigger: the operator moved or deleted the previously bound database. Consequence: startup refuses correctly, but with an ENOENT Error rather than OWNERSHIP_UNCERTAIN, so callers or operators keying on the code get a misleading signal. Fix direction: catch ENOENT and rethrow as OWNERSHIP_UNCERTAIN with a message naming the retained path.

3. **Workflow database is written before scheduler ownership is proven.** `server/orchestration/storage/store.mjs:48` runs a BEGIN IMMEDIATE transaction that rewrites ready_work in the constructor. In production this executes at `server/orchestration/create-runtime.mjs:38`, after per-repository ownership but before `scheduler.start` acquires the workflow scheduler_owner row. Trigger: a second process configured with a disjoint repository set but the same database path. Consequence: that process writes derived ready_work rows for goals it will never own, then is refused at `server/orchestration/scheduler.mjs:28`. The data is derived and idempotent, so no journal corruption, but it is a write without ownership. Fix direction: make the ready backfill a scheduler start step rather than a constructor side effect, or skip it when the store is opened for ownership probing.

## Confirmed safe behaviours

- **Two owners.** Per common dir owner rows plus the workflow scheduler_owner row are both nonce fenced and refuse any live or unknown PID. Different database, same repo: refused by `assertRollback` at `cutover.mjs:92`. Same database, same repo: refused at `cutover.mjs:88`. Same database, disjoint repos: refused at `scheduler.mjs:28`.
- **Rebinding.** Identity mismatch on the same path is refused at `cutover.mjs:91`, and the test at `tests/orchestration-cutover.test.mjs:88` covers the replaced-file case.
- **Failed startup cleanup.** The catch at `production.mjs:68` closes the runtime and releases repository owners. The listen catch at `create-runtime.mjs:103` calls the wrapped close, so repository ownership is released even on a bind failure. `native-background.mjs:196` terminates every worker this process launched or adopted and waits for stopped proof before releasing.
- **Cutover assertion is rerun** after ownership at `production.mjs:44`, closing the window between inventory and acquisition.

## Questions, not defects

- **Empty legacy list bypasses inventory.** `cutover.mjs:43` accepts an empty legacyDatabases array. With the digest of an empty list, no legacy database, PID, or session is ever checked. Is there any guard that the configured list covers the installed default legacy database? Nothing in the reviewed files enforces it.
- **Shutdown failure keeps ownership.** If `create-runtime.mjs:117` throws during close, the scheduler owner row and repository owner rows are never released in that process. Index falls through to an unhandled rejection at `server/index.mjs:51`. Rows remain with a dead PID, so the next start reclaims them. Is that intended over releasing after a best-effort stop?
- **Host is silently ignored.** `server/index.mjs:22` accepts localhost and ::1, but `create-runtime.mjs:99` always binds 127.0.0.1. Is that mismatch deliberate?
- **Duplicate repository check ids.** `production.mjs:28` does not require unique check ids per repository. `resolveCheck` matches on id plus argv, so this is probably harmless, but was it intended?

## Scope and limits

I did not read the reconciler's adoption path, the native worker supervisor, or `app.mjs` beyond its hooks. Claims about adopting orphaned workers from a previous crash rest on the `managed.add` call at `native-background.mjs:166` and were not traced further. Installed updater compatibility was excluded as instructed.
