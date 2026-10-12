# Updater Lock Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bundled updater lock self-healing and observable, as decided in `docs/superpowers/specs/2026-10-12-updater-lock-recovery.md`.

**Architecture:** Two lock readers share one directory lock: `updater/src/lock.mjs` (engine, installer, retention) and `updater/scripts/bootstrap.mjs` (a deliberately standalone copy that runs from `~/.local/libexec` and must not import `updater/src`). Both get the same orphan rule: only a live `pid` or `enginePid` holds the lock; every other shape is reclaimed once the directory is older than 15 minutes. The bootstrap exits with distinct codes for "lock held" (3) and "low disk" (4); the long-running launcher `updater/scripts/launch-updater.mjs` turns those codes into one log line per state change through a new pure module `updater/src/cycle-report.mjs`.

**Tech Stack:** Node 22 ESM, `node:test`, `node:fs/promises`. Deterministic tests live in `tests/*.test.mjs` (discovered by `npm test`); `updater/tests/unit.test.mjs` runs with `node --test updater/tests/unit.test.mjs` only.

**Evidence this plan rests on (2026-10-12 investigation of the installed Mac):**
- `~/Library/Logs/cmux-companion-updater.error.log` holds 12 `ENOSPC` failures on `mkdir .../updater/lock` and on the owner write (2026-09-05 and 2026-09-16).
- A probe of `acquireLock` showed a lock with a missing, empty or pid-less `owner.json` is never reclaimed, even at 2 hours stale.
- `bootstrap.mjs:68` calls `acquire()` outside `try/finally`; `acquire()` does `mkdir` then `writeFile`, so a failed write leaves an ownerless directory.
- The launcher logged `Updater cycle exited with 1` 145 times (once per 5-second cycle) and nothing at all for a held lock.
- The installed updater is **not** locked at the time of writing: deployed SHA equals `origin/main`, the lock directory is absent, the fence is clear.

**Out of scope (separate decisions, see "Follow-up decisions" at the end):** fence timing during the release build, retention defaults, the disk-space floor policy, the `node:sqlite` warning noise.

---

## Phase 1: `acquireLock` orphan rule

### Task 1: Reclaim pid-less and unreadable owners in `lock.mjs`

**Files:**
- Modify: `updater/src/lock.mjs`
- Test: `tests/updater-native.test.mjs` (append after the existing `acquireLock treats a dead, stale spawn claim...` test)
- Test: `updater/tests/unit.test.mjs:118-128` (update one assertion)

- [ ] **Step 1: Write the failing test in `tests/updater-native.test.mjs`**

Append at the end of the file:

```js
test('acquireLock reclaims a stale lock whose owner file is missing, empty or pid-less, and protects a fresh one', async t => {
  const root = await mkdtemp(join(tmpdir(), 'updater-lock-orphan-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, 'lock'), owner = join(lock, 'owner.json');
  const shapes = [
    ['missing', null],
    ['empty', ''],
    ['pid-less', JSON.stringify({ createdAt: '2026-09-16T09:23:42.601Z', spawnClaim: true })],
    ['zero pid', JSON.stringify({ pid: 0, createdAt: '2026-09-16T09:23:42.601Z' })],
  ];
  for (const [label, contents] of shapes) {
    await rm(lock, { recursive: true, force: true }); await mkdir(lock, { mode: 0o700 });
    if (contents !== null) await writeFile(owner, contents);
    assert.equal(await acquireLock(lock, { now: Date.now() }), null, `${label}: a fresh lock stays protected`);
    const release = await acquireLock(lock, { now: Date.now() + 16 * 60_000 });
    assert.equal(typeof release, 'function', `${label}: a stale ownerless lock is an orphan`);
    assert.equal((await readJson(owner)).pid, process.pid, `${label}: the reclaimer records itself`);
    await release();
  }
});

test('acquireLock removes the directory it created when the owner write fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'updater-lock-write-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, 'lock');
  await assert.rejects(acquireLock(lock, { write: async () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } }), { code: 'ENOSPC' });
  await assert.rejects(readFile(join(lock, 'owner.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(lock), { code: 'ENOENT' });
  const release = await acquireLock(lock); assert.equal(typeof release, 'function', 'the next claimant is not blocked'); await release();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/updater-native.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: the two new tests fail; "missing: a stale ownerless lock is an orphan" reports `null` instead of a function, and the write test fails with "acquireLock does not accept write" style behaviour (owner file exists).

- [ ] **Step 3: Replace `updater/src/lock.mjs`**

```js
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";

export const LOCK_STALE_MS = 15 * 60_000;

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

// Only a live owner or engine holds the lock. A dead pid, or an owner file that
// is unreadable or has no positive pid (left by a claimant that crashed between
// mkdir and the owner write, for example on ENOSPC), is an orphan once the
// directory is older than the stale window. A fresh directory is always
// protected so a claim that is still being recorded is never stolen.
export function lockOwnerAlive(metadata) {
  return [metadata?.pid, metadata?.enginePid].some(pid => Number.isInteger(pid) && pid > 0 && processAlive(pid));
}

export async function acquireLock(path, { now = Date.now(), staleMs = LOCK_STALE_MS, write = writeFile } = {}) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const [metadata, info] = await Promise.all([
      readFile(`${path}/owner.json`, "utf8").then(JSON.parse).catch(() => ({})),
      stat(path),
    ]);
    if (lockOwnerAlive(metadata) || now - info.mtimeMs <= staleMs) return null;
    await rm(path, { recursive: true });
    await mkdir(path, { mode: 0o700 });
  }
  try {
    await write(`${path}/owner.json`, `${JSON.stringify({ pid: process.pid, createdAt: new Date(now).toISOString() })}\n`, { mode: 0o600 });
  } catch (error) {
    // Never leave an ownerless directory behind: it would read as held. Keep the
    // original error even when the cleanup itself fails.
    try { await rm(path, { recursive: true, force: true }); } catch { /* reported by the original error */ }
    throw error;
  }
  let released = false;
  return async () => {
    if (!released) { released = true; await rm(path, { recursive: true, force: true }); }
  };
}
```

- [ ] **Step 4: Update the stale assertion in `updater/tests/unit.test.mjs`**

The spec retires "unknown launch claims". Change line 121 from:

```js
  assert.equal(await acquireLock(lock, { now: Date.now() + 3600000 }), null);
```

to:

```js
  const orphan = await acquireLock(lock, { now: Date.now() + 3600000 });
  assert.equal(typeof orphan, 'function', 'a stale lock with no owner file is an orphan'); await orphan(); await mkdir(lock);
```

and rename the test title to `'stale locks keep live owners and engines, and reclaim dead or ownerless claims'`.

- [ ] **Step 5: Run both test files**

Run: `node --test tests/updater-native.test.mjs updater/tests/unit.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add updater/src/lock.mjs tests/updater-native.test.mjs updater/tests/unit.test.mjs
git commit -m "fix: reclaim ownerless updater locks and never leave one behind"
```

---

## Phase 2: Bootstrap orphan rule, write failure and disk floor

### Task 2: Apply the same rule in `bootstrap.mjs` with distinct exit codes

**Files:**
- Modify: `updater/scripts/bootstrap.mjs`
- Test: `tests/updater-native.test.mjs:111-135` (rewrite the bootstrap claim test) plus two new tests

- [ ] **Step 1: Rewrite the bootstrap claim test and add two tests**

Replace the test starting at line 111 (`bootstrap reclaims an orphaned spawn claim...`) with:

```js
async function bootstrapFixture(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix)); t.after(() => rm(root, { recursive: true, force: true }));
  const paths = defaultPaths(root), sha = 'a'.repeat(40), marker = join(root, 'executed');
  const scripts = join(paths.companionStore, 'releases', sha, 'updater/scripts'); await mkdir(scripts, { recursive: true });
  await writeFile(join(scripts, 'local-updater.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.CMUX_TEST_MARKER, '${sha}');\n`);
  await mkdir(paths.stateRoot, { recursive: true }); await symlink(`releases/${sha}`, join(paths.companionStore, 'current'));
  const bootstrap = new URL('../updater/scripts/bootstrap.mjs', import.meta.url).pathname;
  const env = { HOME: root, CMUX_COMPANION_HOME: root, CMUX_TEST_MARKER: marker };
  const cycle = (extraEnv = {}) => run(process.execPath, [bootstrap], { env: { ...env, ...extraEnv }, timeoutMs: 10000, allowFailure: true });
  return { paths, sha, marker, cycle };
}

test('bootstrap reclaims dead or ownerless stale locks, keeps fresh or live ones, and exits 3 when held', async t => {
  const f = await bootstrapFixture(t, 'updater-bootstrap-claim-');
  const owner = join(f.paths.lock, 'owner.json'), pid = await deadPid(), stale = new Date(Date.now() - 16 * 60_000);
  const claim = async (contents, at) => {
    await rm(f.paths.lock, { recursive: true, force: true }); await mkdir(f.paths.lock, { mode: 0o700 });
    if (contents !== null) await writeFile(owner, typeof contents === 'string' ? contents : JSON.stringify({ pid, createdAt: new Date().toISOString(), spawnClaim: true, ...contents }));
    if (at) await utimes(f.paths.lock, at, at);
  };
  const held = async label => { const result = await f.cycle(); assert.equal(result.code, 3, `${label}: exit 3 while held`); await assert.rejects(readFile(f.marker), { code: 'ENOENT' }, `${label}: engine not run`); };
  const reclaimed = async label => { const result = await f.cycle(); assert.equal(result.code, 0, `${label}: exit 0`); assert.equal(await readFile(f.marker, 'utf8'), f.sha, `${label}: engine ran`); await rm(f.marker); };
  // Fresh claims of every shape protect a spawn that is still being recorded.
  await claim({}); await held('fresh dead pid');
  await claim(null); await held('fresh missing owner');
  await claim(''); await held('fresh empty owner');
  // Stale claims without a live process are orphans.
  await claim({}, stale); await reclaimed('stale dead pid');
  await claim(null, stale); await reclaimed('stale missing owner');
  await claim('', stale); await reclaimed('stale empty owner');
  await claim({ pid: undefined, enginePid: undefined, spawnClaim: true }, stale); await reclaimed('stale pid-less owner');
  // Live processes keep their lock however old it is.
  await claim({ enginePid: process.pid }, stale); await held('stale live engine');
  await claim({ pid: process.pid }, stale); await held('stale live owner');
});

test('bootstrap reports an engine that exits 3 or 4 as a plain failure', async t => {
  const f = await bootstrapFixture(t, 'updater-bootstrap-engine-exit-');
  const engine = join(f.paths.companionStore, 'releases', f.sha, 'updater/scripts/local-updater.mjs');
  await writeFile(engine, 'process.exit(3);\n');
  assert.equal((await f.cycle()).code, 1, 'engine exit 3 is not reported as lock held');
  await writeFile(engine, 'process.exit(4);\n');
  assert.equal((await f.cycle()).code, 1, 'engine exit 4 is not reported as low disk');
});

test('bootstrap removes the lock directory when its owner write fails', async t => {
  const f = await bootstrapFixture(t, 'updater-bootstrap-write-');
  const result = await f.cycle({ CMUX_COMPANION_UPDATER_FAILPOINT: 'owner-write' });
  assert.equal(result.code, 1); assert.match(result.stderr, /ENOSPC/);
  await assert.rejects(readFile(f.paths.lock), { code: 'ENOENT' }, 'no ownerless directory survives');
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
  const next = await f.cycle(); assert.equal(next.code, 0, 'the next cycle is not blocked'); assert.equal(await readFile(f.marker, 'utf8'), f.sha);
});

test('bootstrap refuses to claim the lock below the free-space floor and exits 4', async t => {
  const f = await bootstrapFixture(t, 'updater-bootstrap-disk-');
  const result = await f.cycle({ CMUX_COMPANION_UPDATER_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER) });
  assert.equal(result.code, 4);
  await assert.rejects(readFile(f.paths.lock), { code: 'ENOENT' }, 'no lock directory was created');
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
});
```

Keep the existing `deadPid()` helper above these tests.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/updater-native.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: the four bootstrap tests fail (`fresh dead pid: exit 3 while held` gets 0, the engine-exit test gets 3, the write test sees no `ENOSPC`, the disk test gets 0).

- [ ] **Step 3: Replace the top of `updater/scripts/bootstrap.mjs` (lines 1-47 and 68)**

New file head (keep `saveOwner`, `execute` and the main `try/finally` block unchanged except the acquire line):

```js
#!/usr/bin/env node
import { mkdir, readFile, realpath, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

// This file runs from ~/.local/libexec and must stay standalone: it cannot import
// updater/src. Keep the lock rule identical to updater/src/lock.mjs.
const home = process.env.CMUX_COMPANION_HOME || process.env.HOME;
const stateRoot = join(home, ".config", "cmux-companion", "updater");
const lockPath = join(stateRoot, "lock");
const transactionPath = join(stateRoot, "transaction.json");
const currentEngine = join(home, ".local", "share", "cmux-companion", "current", "updater", "scripts", "local-updater.mjs");
// Exit codes the launcher reports once per state change (updater/src/cycle-report.mjs).
const EXIT_LOCK_HELD = 3;
const EXIT_LOW_DISK = 4;
const LOCK_STALE_MS = 15 * 60_000;
const MIN_FREE_BYTES = Number(process.env.CMUX_COMPANION_UPDATER_MIN_FREE_BYTES) || 64 * 1024 * 1024;
const failpoint = process.env.CMUX_COMPANION_UPDATER_FAILPOINT || null;
let preserveLock = false;
const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
async function readTransaction() {
  try { return JSON.parse(await readFile(transactionPath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
function ownerAlive(owner) {
  return [owner?.pid, owner?.enginePid].some(pid => Number.isInteger(pid) && pid > 0 && processAlive(pid));
}

async function acquire() {
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const [owner, info] = await Promise.all([
      readFile(join(lockPath, "owner.json"), "utf8").then(JSON.parse).catch(() => ({})),
      stat(lockPath),
    ]);
    // Only a live owner or engine holds the lock. A dead pid, or an unreadable or
    // pid-less owner left by a claimant that crashed between mkdir and the owner
    // write, is an orphan once the directory is older than the stale window. A
    // fresh directory is always protected so a claim being recorded is not stolen.
    if (ownerAlive(owner) || Date.now() - info.mtimeMs <= LOCK_STALE_MS) return false;
    await rm(lockPath, { recursive: true });
    await mkdir(lockPath, { mode: 0o700 });
  }
  try {
    if (failpoint === "owner-write") throw Object.assign(new Error("ENOSPC: injected owner write failure"), { code: "ENOSPC" });
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { mode: 0o600 });
  } catch (error) {
    // Never leave an ownerless directory behind: it would read as held. Keep the
    // original error even when the cleanup itself fails.
    try { await rm(lockPath, { recursive: true, force: true }); } catch { /* reported by the original error */ }
    throw error;
  }
  return true;
}

async function freeBytes() {
  const info = await statfs(stateRoot);
  return Number(info.bavail) * Number(info.bsize);
}
```

Then replace line 68 (`if (!await acquire()) process.exit(0);`) with:

```js
if (await freeBytes() < MIN_FREE_BYTES) process.exit(EXIT_LOW_DISK);
if (!await acquire()) process.exit(EXIT_LOCK_HELD);
```

And replace the last line (`process.exitCode = exitCode;`) with:

```js
// Exit codes 3 and 4 belong to this bootstrap; an engine that exits with them is a plain failure.
process.exitCode = [EXIT_LOCK_HELD, EXIT_LOW_DISK].includes(exitCode) ? 1 : exitCode;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/updater-native.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 5: Confirm no other test runs the real bootstrap and assumes exit 0 while held**

Run: `grep -n "bootstrap.mjs" tests/updater-recovery.test.mjs tests/updater-handoff-compatibility.test.mjs tests/updater-data-contract.test.mjs`
Expected: only fixture copies (`'// fixture\n'`, `'{}'`) and manifest path lists; no `run(process.execPath, [bootstrap]...)` call. If a call appears, read its exit assumption and update it to the new codes.

- [ ] **Step 6: Commit**

```bash
git add updater/scripts/bootstrap.mjs tests/updater-native.test.mjs
git commit -m "fix: make the updater bootstrap reclaim orphaned locks and refuse low disk"
```

---

## Phase 3: One launcher log line per state change

### Task 3: Add `updater/src/cycle-report.mjs` and use it in the launcher

Note: the installed launcher (`launch-updater.mjs`) is a persistent LaunchAgent
process bound to the release it imported at start (on this Mac, running since
2026-10-02 across six `current` switches). This task takes effect only after that
LaunchAgent restarts; the spec lists that restart as an operator step.

**Files:**
- Create: `updater/src/cycle-report.mjs`
- Modify: `updater/scripts/launch-updater.mjs:19-37`
- Test: `tests/updater-cycle-report.test.mjs` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/updater-cycle-report.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { CYCLE_EXIT, cycleMessage, createCycleReporter } from '../updater/src/cycle-report.mjs';

test('cycle messages name held locks and low disk, and stay silent on success', () => {
  assert.equal(cycleMessage(CYCLE_EXIT.ok, null, null), null);
  assert.match(cycleMessage(CYCLE_EXIT.lockHeld, null, null), /lock is held/);
  assert.match(cycleMessage(CYCLE_EXIT.lowDisk, null, null), /free disk space/);
  assert.equal(cycleMessage(1, null, null), 'Updater cycle exited with 1');
  assert.equal(cycleMessage(null, 'SIGKILL', null), 'Updater cycle terminated by SIGKILL');
  assert.equal(cycleMessage(null, null, new Error('spawn failed')), 'spawn failed');
});

test('the reporter writes once per state change and announces recovery', () => {
  const lines = []; const report = createCycleReporter(line => lines.push(line));
  report(CYCLE_EXIT.ok, null, null); report(CYCLE_EXIT.ok, null, null);
  assert.deepEqual(lines, [], 'healthy cycles are silent');
  report(CYCLE_EXIT.lockHeld, null, null); report(CYCLE_EXIT.lockHeld, null, null); report(CYCLE_EXIT.lockHeld, null, null);
  assert.equal(lines.length, 1, 'a held lock is reported once');
  report(1, null, null); assert.equal(lines.length, 2, 'a different failure is reported');
  report(1, null, null); assert.equal(lines.length, 2);
  report(CYCLE_EXIT.ok, null, null); assert.deepEqual(lines.at(-1), 'Updater cycle recovered');
  report(CYCLE_EXIT.ok, null, null); assert.equal(lines.length, 3);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/updater-cycle-report.test.mjs 2>&1 | tail -n 5`
Expected: fails with `Cannot find module .../updater/src/cycle-report.mjs`.

- [ ] **Step 3: Create `updater/src/cycle-report.mjs`**

```js
// Exit codes are duplicated in updater/scripts/bootstrap.mjs, which cannot import this file.
export const CYCLE_EXIT = Object.freeze({ ok: 0, lockHeld: 3, lowDisk: 4 });

export function cycleMessage(code, signal, error) {
  if (error) return error.message;
  if (signal) return `Updater cycle terminated by ${signal}`;
  if (code === CYCLE_EXIT.ok) return null;
  if (code === CYCLE_EXIT.lockHeld) return 'Updater cycle skipped: the updater lock is held by another process. An orphaned lock is reclaimed 15 minutes after its owner exits.';
  if (code === CYCLE_EXIT.lowDisk) return 'Updater cycle refused: free disk space is below the updater floor; free space before updates can resume.';
  return `Updater cycle exited with ${code}`;
}

// The launcher runs a cycle every 5 seconds. Log a condition when it appears,
// not on every cycle, and log once when cycles become healthy again.
export function createCycleReporter(write) {
  let previous = null;
  return (code, signal, error) => {
    const message = cycleMessage(code, signal, error);
    if (message === previous) return;
    if (message === null) write('Updater cycle recovered');
    else write(message);
    previous = message;
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/updater-cycle-report.test.mjs 2>&1 | tail -n 5`
Expected: `# pass 2`, `# fail 0`.

- [ ] **Step 5: Use the reporter in `updater/scripts/launch-updater.mjs`**

Add the import after line 3:

```js
import { createCycleReporter } from "../src/cycle-report.mjs";
```

Add after `let wake = null;`:

```js
const report = createCycleReporter((line) => console.error(line));
```

Replace the `finish` closure (lines 24-32) with:

```js
    const finish = (error = null, code = 0, signal = null) => {
      if (settled) return;
      settled = true;
      child = null;
      if (!stopping) report(code, signal, error);
      resolve();
    };
```

- [ ] **Step 6: Run the launcher once against a fake bootstrap to confirm wiring**

Run:
```bash
tmp=$(mktemp -d) && mkdir -p "$tmp/.local/libexec" && printf '#!/bin/sh\nexit 3\n' > "$tmp/.local/libexec/cmux-companion-updater" && chmod +x "$tmp/.local/libexec/cmux-companion-updater" && CMUX_COMPANION_HOME="$tmp" timeout 12 node updater/scripts/launch-updater.mjs; echo "exit=$?"; rm -rf "$tmp"
```
Expected: exactly one line `Updater cycle skipped: the updater lock is held...` on stderr during the 12 seconds (two cycles), then `exit=124` from `timeout`. If `timeout` is not installed, use `gtimeout` from coreutils.

- [ ] **Step 7: Commit**

```bash
git add updater/src/cycle-report.mjs updater/scripts/launch-updater.mjs tests/updater-cycle-report.test.mjs
git commit -m "feat: report updater cycle conditions once per state change"
```

---

## Phase 4: Documentation and full verification

### Task 4: Document the lock rule and the manual recovery step

**Files:**
- Modify: `docs/updates.md` (section "Troubleshooting an update", after the four stages list at line 194)
- Modify: `docs/updates-delivery.md:38`

- [ ] **Step 1: Add a troubleshooting paragraph to `docs/updates.md`**

Insert after the line ending `through the authenticated updater and health APIs.` (line 194):

```markdown

**Updater lock.** The bootstrap and engine share one lock directory,
`~/.config/cmux-companion/updater/lock`. A lock is held only while the process in
its `owner.json` (`pid` or `enginePid`) is alive. A lock whose owner is dead,
or whose owner file is missing or unreadable, is reclaimed automatically once the
directory is older than 15 minutes. While the lock is held the updater log
(`~/Library/Logs/cmux-companion-updater.error.log`) reports it once, and reports
recovery once; a cycle that exits 3 was skipped for the lock and a cycle that
exits 4 refused to run because free disk space is below 64 MB. Installations whose
bootstrap predates this rule do not self-heal from an ownerless lock: confirm that
no `cmux-companion-updater` or `local-updater.mjs` process is running, then remove
the lock directory by hand once; the next successful update installs the new
bootstrap. The launcher process is bound to the release it started from, so the
once-per-state-change log lines appear only after the updater LaunchAgent
restarts (login, reboot or `launchctl kickstart -k gui/$(id -u)/org.cmux-companion.updater`).
```

- [ ] **Step 2: Update the delivery table row in `docs/updates-delivery.md`**

Replace the row at line 38 with:

```markdown
| Stable bootstrap | Bootstrap tests select the previous engine after an interrupted current-link switch, reject altered engine digests and legacy transactions, keep locks whose owner or engine process is alive, reclaim stale locks whose owner is dead, missing or unreadable, remove the lock directory when the owner write fails, and refuse to claim the lock below the free-space floor. The launcher reports a held lock or low disk once per state change. |
```

- [ ] **Step 3: Commit**

```bash
git add docs/updates.md docs/updates-delivery.md
git commit -m "docs: describe updater lock reclaim, exit codes and manual recovery"
```

### Task 5: Full verification

- [ ] **Step 1: Backend, UI, lint and types**

Run: `npm test && npm run test:ui && npm run lint && npm run typecheck`
Expected: all four exit 0. Also run `node --test updater/tests/unit.test.mjs` (not discovered by `npm test`) and expect `# fail 0`.

- [ ] **Step 2: Coverage gate**

Run: `npm run test:coverage 2>&1 | tail -n 15`
Expected: line coverage at or above 90% for `updater/src/**` (the new `cycle-report.mjs` is fully covered by Task 3).

- [ ] **Step 3: Cypress**

No browser surface changes in this plan. State this in the PR under "not run" with the reason: the change is confined to updater processes and logs that `cypress/e2e/updates.cy.ts` stubs.

- [ ] **Step 4: Open a draft PR to `main`**

Follow `docs/code-review-workflow.md`. Put the evidence list from the plan header and the exact test commands in the PR body. Do not merge; do not run `npm run install:mac`, `update:check` or `update:retry`.

---

## Self-review against the spec

| Spec criterion | Task |
| --- | --- |
| `acquireLock` reclaims missing/empty/pid-less owners when stale, protects fresh | Task 1 |
| Bootstrap reclaims the same shapes, protects fresh claims and live engines | Task 2 |
| Owner write failure removes the directory before a non-zero exit | Task 1 (`write` injection) and Task 2 (failpoint) |
| Held lock logs once per state change | Task 3 |
| Low free space refuses the claim without creating the directory | Task 2 |

Exit codes 3 and 4 are defined in `cycle-report.mjs` and duplicated by value in `bootstrap.mjs`; the comment in each file names the other.

---

## Follow-up decisions (not in this plan; each needs its own spec first)

1. **Fence window during the release build.** `updateCycle` acquires the maintenance fence, then `prepare()` runs `npm ci`, `npm run build` and `npm run verify` (observed 4 minutes on 2026-10-11; ceilings 10 + 10 + 5 minutes). Every non-GET request returns `503 UPDATE_MAINTENANCE` for that window and the browser has no handling for that code. Building before fencing changes the protocol (`prepare` reads `activeId` and `fence.handoff`; `start()` requires the fence), so it is a product decision.
2. **Disk pressure upstream of the lock.** Retention is disabled; 42 releases hold 25 GB; `ensureDiskSpace` (512 MB floor) runs inside `prepare`, after the lock is taken. Exposing free space and release count in `/api/updater/updates` is implementation; enabling retention by default is a product decision.
3. **Error-log noise.** The 78 MB updater error log is mostly the `node:sqlite` `ExperimentalWarning`. Silencing it means a plist environment change that only applies on reinstall, so it is an operator step, not a code phase.
