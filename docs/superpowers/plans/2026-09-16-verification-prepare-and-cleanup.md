# Verification dependency preparation and worktree cleanup — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verification worktrees install their dependencies through a per-project prepare command that Companion detects, records as a named check, and cleans up, so JavaScript checks stop failing with "command not found".

**Architecture:** Detection is a pure table in `server/dev-repositories.mjs` keyed by lockfile name. The setting lives on each project in local settings. The verification runner runs prepare as a leading check with a shared npm cache, then the coordinator removes the worktree once the run records a stopped result. The hold message names dependencies when prepare failed.

**Tech Stack:** Node 22 ESM, node:test, node:sqlite, Fastify, React 19 with Vitest and Testing Library, Cypress.

**Spec:** `docs/superpowers/specs/2026-09-16-verification-prepare-and-cleanup-design.md`. The plan may not deviate from it.

**Branch:** `feat/verification-prepare-and-gc`. Commit after every task. Run `node --test tests/<file>` for the task's file, then the phase verification at each phase end.

---

## File map

| File | Responsibility |
| --- | --- |
| `server/dev-repositories.mjs` | Add `detectPrepare(path)`: lockfile name → command, no execution. |
| `server/local-settings.mjs` | Validate `project.prepare`; default `{ source: 'none' }`; fill it on inspect and on update; keep `custom`/`disabled` across detection. |
| `server/dev-repo-tracking.mjs` | New projects from a scan get the detected prepare. |
| `server/prepare-command.mjs` (new) | `resolvePrepare(project, env, policy)` → `{ bin, argv, env, environmentId, policy }` or `null`, using the same executable resolution as checks. |
| `server/orchestration/adapters/npm-cache.mjs` (new) | `NpmCache` with `path`, `environment()` and `prune(capBytes)`. |
| `server/orchestration/adapters/verification.mjs` | Accept an optional `resolvePrepare(repositoryId, goalId)`; run prepare first as check `prepare`; mark remaining checks `PREPARE_FAILED` when it fails; call cache prune after the run. |
| `server/orchestration/adapters/git.mjs` | Add `removeVerificationWorktree(operationId)` with identity checks then `git worktree remove --force`. |
| `server/orchestration/verification-coordinator.mjs` | After a stopped result is recorded, remove the worktree; on `run()` startup, sweep stopped runs whose worktree still exists. |
| `server/orchestration/domain/recovery.mjs` | Hold message names dependencies when the `prepare` check failed. |
| `server/orchestration/types.d.ts` | `RepositoryPort.removeVerificationWorktree`, `VerificationPort` unchanged. |
| `server/orchestration/create-runtime.mjs`, `server/settings-runtime.mjs`, `server/orchestration/production.mjs` | Wire `resolvePrepare` and the cache directory. |
| `app/settings/settings-panel.tsx`, `app/settings/dev-repositories.tsx` | `Prepare` type and the Prepare row with Edit and Disable. |
| `README.md`, `docs/settings-onboarding.md` | One paragraph each. |
| Tests | `tests/dev-repositories.test.mjs`, `tests/local-settings.test.mjs`, `tests/dev-repo-tracking.test.mjs`, `tests/prepare-command.test.mjs` (new), `tests/npm-cache.test.mjs` (new), `tests/orchestration-verification.test.mjs`, `tests/orchestration-verification-cleanup.test.mjs` (new), `tests/orchestration-domain.test.mjs`, `tests/settings-runtime.test.mjs`, `tests/ui-local-settings.test.tsx`, `cypress/e2e/settings.cy.ts`, `cypress/e2e/orchestration-core.cy.ts`. |

The detection table, in order:

| Lockfile | executable | args |
| --- | --- | --- |
| `package-lock.json` | `npm` | `['ci']` |
| `pnpm-lock.yaml` | `pnpm` | `['install', '--frozen-lockfile']` |
| `yarn.lock` | `yarn` | `['install', '--immutable']` |
| `bun.lockb`, then `bun.lock` | `bun` | `['install', '--frozen-lockfile']` |

The setting shape: `prepare: { source: 'detected' | 'custom' | 'disabled' | 'none'; executable?: string; args?: string[] }`. `executable` and `args` are required for `detected` and `custom`, and forbidden for `disabled` and `none`.

---

## Phase 1 — Detection and settings (backend)

### Task 1: Lockfile detection

**Files:**
- Modify: `server/dev-repositories.mjs` (append after `suggestedChecks`)
- Test: `tests/dev-repositories.test.mjs`

- [ ] **Step 1: Write the failing test.** Append to `tests/dev-repositories.test.mjs`:

```js
import { detectPrepare } from '../server/dev-repositories.mjs';

test('prepare detection follows the lockfile table in order and never executes anything', async t => {
  const { directory } = fixture(t);
  const project = join(directory, 'detect'); mkdirSync(project);
  assert.deepEqual(await detectPrepare(project), { source: 'none' });
  writeFileSync(join(project, 'bun.lock'), '');
  assert.deepEqual(await detectPrepare(project), { source: 'detected', executable: 'bun', args: ['install', '--frozen-lockfile'] });
  writeFileSync(join(project, 'yarn.lock'), '');
  assert.deepEqual(await detectPrepare(project), { source: 'detected', executable: 'yarn', args: ['install', '--immutable'] });
  writeFileSync(join(project, 'pnpm-lock.yaml'), '');
  assert.deepEqual(await detectPrepare(project), { source: 'detected', executable: 'pnpm', args: ['install', '--frozen-lockfile'] });
  writeFileSync(join(project, 'package-lock.json'), '{}');
  assert.deepEqual(await detectPrepare(project), { source: 'detected', executable: 'npm', args: ['ci'] });
  mkdirSync(join(project, 'symlinked')); symlinkSync(join(project, 'package-lock.json'), join(project, 'symlinked', 'package-lock.json'));
  assert.deepEqual(await detectPrepare(join(project, 'symlinked')), { source: 'none' });
});
```

- [ ] **Step 2: Run it.** `node --test tests/dev-repositories.test.mjs`. Expected: FAIL, `detectPrepare` is not exported.

- [ ] **Step 3: Implement.** Append to `server/dev-repositories.mjs`:

```js
/** Prepare detection reads lockfile names only. The command table is owned by
 * Companion; repository content never selects an executable or argument. */
const PREPARE_TABLE = [
  ['package-lock.json', { executable: 'npm', args: ['ci'] }],
  ['pnpm-lock.yaml', { executable: 'pnpm', args: ['install', '--frozen-lockfile'] }],
  ['yarn.lock', { executable: 'yarn', args: ['install', '--immutable'] }],
  ['bun.lockb', { executable: 'bun', args: ['install', '--frozen-lockfile'] }],
  ['bun.lock', { executable: 'bun', args: ['install', '--frozen-lockfile'] }],
];
export async function detectPrepare(path) {
  for (const [name, command] of PREPARE_TABLE) {
    try {
      const info = await lstat(join(path, name));
      if (info.isFile() && !info.isSymbolicLink()) return { source: 'detected', executable: command.executable, args: [...command.args] };
    } catch { /* Try the next lockfile. */ }
  }
  return { source: 'none' };
}
```

- [ ] **Step 4: Run it.** `node --test tests/dev-repositories.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/dev-repositories.mjs tests/dev-repositories.test.mjs
git commit -m "feat: detect the verification prepare command from the lockfile"
```

### Task 2: Validate and default the prepare setting

**Files:**
- Modify: `server/local-settings.mjs` (`validateSettings` project loop, `inspectProject`, `update`)
- Test: `tests/local-settings.test.mjs`

- [ ] **Step 1: Write the failing tests.** Append to `tests/local-settings.test.mjs`:

```js
test('prepare settings validate their source, default to none and follow detection only when detected or none', async t => {
  const { store, project, directory } = fixture(t);
  const settings = store.read().settings;
  settings.projects.push(project);
  await store.update(0, settings);
  assert.deepEqual(store.read().settings.projects[0].prepare, { source: 'none' });
  writeFileSync(join(project.path, 'package-lock.json'), '{}');
  const detected = store.read().settings;
  detected.projects[0].enabled = false; await store.update(1, detected);
  const reenabled = store.read().settings; reenabled.projects[0].enabled = true; await store.update(2, reenabled);
  assert.deepEqual(store.read().settings.projects[0].prepare, { source: 'detected', executable: 'npm', args: ['ci'] });
  const custom = store.read().settings; custom.projects[0].prepare = { source: 'custom', executable: 'npm', args: ['install'] };
  await store.update(3, custom);
  const again = store.read().settings; again.projects[0].enabled = false; await store.update(4, again);
  const back = store.read().settings; back.projects[0].enabled = true; await store.update(5, back);
  assert.deepEqual(store.read().settings.projects[0].prepare, { source: 'custom', executable: 'npm', args: ['install'] });
  const disabled = store.read().settings; disabled.projects[0].prepare = { source: 'disabled' }; await store.update(6, disabled);
  assert.deepEqual(store.read().settings.projects[0].prepare, { source: 'disabled' });
  for (const bad of [{ source: 'detected' }, { source: 'none', executable: 'npm', args: [] }, { source: 'custom', executable: 'sh', args: ['-c', 'x'] }, { source: 'other' }]) {
    const invalid = store.read().settings; invalid.projects[0].prepare = bad;
    await assert.rejects(store.update(7, invalid), TypeError);
  }
  const inspected = await inspectProject(project.path);
  assert.deepEqual(inspected.prepare, { source: 'detected', executable: 'npm', args: ['ci'] });
});
```

- [ ] **Step 2: Run it.** `node --test tests/local-settings.test.mjs`. Expected: FAIL on the first `deepEqual` (prepare is undefined).

- [ ] **Step 3: Implement.** In `server/local-settings.mjs`:

Import `detectPrepare`:

```js
import { assertDevChild, contains, inspectDevRepo, macPath, suggestedChecks, detectPrepare } from './dev-repositories.mjs';
```

Add a validator after `validateExecutable`:

```js
export function validatePrepare(value) {
  if (value === undefined) return { source: 'none' };
  keys(value, ['source', 'executable', 'args'], 'prepare');
  if (!['detected', 'custom', 'disabled', 'none'].includes(value.source)) invalid('Invalid prepare source');
  const commanded = ['detected', 'custom'].includes(value.source);
  if (!commanded) { if (value.executable !== undefined || value.args !== undefined) invalid('Disabled or undetected prepare has no command'); return { source: value.source }; }
  validateExecutable(value.executable);
  if (['sh', 'bash', 'zsh', 'fish', 'csh', 'dash', 'env'].includes(basename(value.executable))) invalid('Configure the prepare executable directly');
  if (!Array.isArray(value.args) || value.args.length > 100) invalid('Invalid prepare arguments');
  for (const arg of value.args) string(arg, 'prepare argument');
  return { source: value.source, executable: value.executable, args: [...value.args] };
}
```

In `validateSettings`, change the project `keys` call to include `prepare` and validate it:

```js
    keys(project, ['id', 'name', 'path', 'enabled', 'github', 'remote', 'checks', 'devRepoId', 'prepare'], 'project');
    project.prepare = validatePrepare(project.prepare);
```

In `inspectProject`, add `prepare` to the return:

```js
  return { path: canonical, name: basename(canonical), github: match?.[1] ?? null, remote: match ? remote : null, suggestedChecks: await suggestedChecks(canonical), prepare: await detectPrepare(canonical) };
```

In `update`, inside the loop that calls `inspect`, keep the inspected prepare when the saved source allows it:

```js
    for (const project of next.projects) {
      const existing = before.settings.projects.find(entry => entry.id === project.id);
      if (existing && existing.path !== project.path) invalid('Project paths cannot be changed; add another project');
      if (!existing || !existing.enabled && project.enabled) {
        const inspected = await inspect(project.path);
        project.path = inspected.path;
        if (['detected', 'none'].includes(project.prepare.source) && inspected.prepare) project.prepare = inspected.prepare;
      }
    }
```

- [ ] **Step 4: Run it.** `node --test tests/local-settings.test.mjs`. Expected: PASS. Also run `node --test tests/settings-runtime.test.mjs tests/dev-repo-tracking.test.mjs tests/dev-repositories.test.mjs`; fix any test fixture that now needs `prepare` in an exact `deepEqual` by adding `prepare: { source: 'none' }` to its expected project.

- [ ] **Step 5: Commit.**

```bash
git add server/local-settings.mjs tests/local-settings.test.mjs tests/settings-runtime.test.mjs tests/dev-repo-tracking.test.mjs tests/dev-repositories.test.mjs
git commit -m "feat: validate and default the per-project prepare setting"
```

### Task 3: Scanned projects carry the detected prepare

**Files:**
- Modify: `server/dev-repo-tracking.mjs:17`
- Test: `tests/dev-repo-tracking.test.mjs`

- [ ] **Step 1: Write the failing test.** Append:

```js
test('discovered repositories keep the prepare command detected during the scan', async t => {
  const { settings, root, entry, options } = await fixture(t);
  const tracking = createDevRepoTracking({ ...options, scan: async () => ({ repositories: [{ ...entry, prepare: { source: 'detected', executable: 'npm', args: ['ci'] } }], partial: false, reason: null }) });
  await tracking.one(root.id);
  assert.deepEqual(settings.read().settings.projects[0].prepare, { source: 'detected', executable: 'npm', args: ['ci'] });
});
```

- [ ] **Step 2: Run it.** `node --test tests/dev-repo-tracking.test.mjs`. Expected: FAIL, prepare is `{ source: 'none' }`.

- [ ] **Step 3: Implement.** In `server/dev-repo-tracking.mjs` change the push:

```js
        projects.push({ id: randomUUID(), name: entry.name, path: entry.path, github: entry.github, remote: entry.remote, enabled: true, checks: [], devRepoId: root.id, prepare: entry.prepare ?? { source: 'none' } });
```

- [ ] **Step 4: Run it.** Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/dev-repo-tracking.mjs tests/dev-repo-tracking.test.mjs
git commit -m "feat: record detected prepare for repositories found by a scan"
```

### Task 4: Resolve the prepare command for a run

**Files:**
- Create: `server/prepare-command.mjs`
- Test: `tests/prepare-command.test.mjs`

- [ ] **Step 1: Write the failing test.** Create `tests/prepare-command.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePrepare } from '../server/prepare-command.mjs';

const policy = { ceilingMs: 1000, idleMs: 1000, maxOutputBytes: 8192, killGraceMs: 100 };
test('prepare resolves only commanded sources through PATH and returns null otherwise', () => {
  const env = { PATH: process.env.PATH };
  assert.equal(resolvePrepare({ prepare: { source: 'none' } }, { env, environmentId: 'settings-1', policy }), null);
  assert.equal(resolvePrepare({ prepare: { source: 'disabled' } }, { env, environmentId: 'settings-1', policy }), null);
  assert.equal(resolvePrepare({}, { env, environmentId: 'settings-1', policy }), null);
  const resolved = resolvePrepare({ prepare: { source: 'detected', executable: 'node', args: ['-e', '0'] } }, { env, environmentId: 'settings-1', policy });
  assert.equal(resolved.bin, process.execPath); assert.deepEqual(resolved.argv, ['-e', '0']);
  assert.equal(resolved.environmentId, 'settings-1-prepare'); assert.deepEqual(resolved.env, env); assert.equal(resolved.policy, policy);
  assert.throws(() => resolvePrepare({ prepare: { source: 'custom', executable: 'definitely-missing-binary', args: [] } }, { env, environmentId: 'settings-1', policy }), { code: 'UNSUPPORTED_CAPABILITY' });
});
```

- [ ] **Step 2: Run it.** `node --test tests/prepare-command.test.mjs`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** Create `server/prepare-command.mjs`:

```js
import { basename } from 'node:path';
import { requireValue } from './orchestration/domain/contracts.mjs';
import { resolveExecutable } from './local-settings.mjs';

/** Resolve the user-approved prepare command for a project, or null when the
 * project has no commanded prepare. Never reads the goal contract.
 * @param {{ prepare?: { source: string; executable?: string; args?: string[] } } | undefined} project
 * @param {{ env: NodeJS.ProcessEnv; environmentId: string; policy: import('./orchestration/types.d.ts').BackgroundPolicy }} options
 */
export function resolvePrepare(project, { env, environmentId, policy }) {
  const prepare = project?.prepare;
  if (!prepare || !['detected', 'custom'].includes(prepare.source)) return null;
  requireValue(typeof prepare.executable === 'string' && Array.isArray(prepare.args), 'Prepare command is incomplete', 'UNSUPPORTED_CAPABILITY');
  requireValue(!['sh', 'bash', 'zsh', 'fish', 'csh', 'dash', 'env', 'cmux'].includes(basename(prepare.executable)), 'Use a direct prepare executable', 'UNSUPPORTED_CAPABILITY');
  const bin = resolveExecutable(prepare.executable, env.PATH);
  requireValue(bin, 'Prepare executable is unavailable', 'UNSUPPORTED_CAPABILITY');
  return { bin, argv: [...prepare.args], env, environmentId: `${environmentId}-prepare`, policy };
}
```

- [ ] **Step 4: Run it.** Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/prepare-command.mjs tests/prepare-command.test.mjs
git commit -m "feat: resolve the approved prepare command through PATH"
```

**Phase 1 verification:** `node --test tests/dev-repositories.test.mjs tests/local-settings.test.mjs tests/dev-repo-tracking.test.mjs tests/prepare-command.test.mjs tests/settings-runtime.test.mjs` then `npm run typecheck`. All green before Phase 2.

---

## Phase 2 — Runner, cache and cleanup (backend)

### Task 5: Shared npm cache with a size cap

**Files:**
- Create: `server/orchestration/adapters/npm-cache.mjs`
- Test: `tests/npm-cache.test.mjs`

- [ ] **Step 1: Write the failing test.** Create `tests/npm-cache.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NpmCache } from '../server/orchestration/adapters/npm-cache.mjs';

test('the shared npm cache is private, sets npm_config_cache and prunes oldest content under the cap', () => {
  const directory = mkdtempSync(join(tmpdir(), 'npm-cache-'));
  const cache = new NpmCache({ directory: join(directory, 'npm-cache') });
  assert.equal(statSync(cache.path).mode & 0o777, 0o700);
  assert.deepEqual(cache.environment(), { npm_config_cache: cache.path });
  const content = join(cache.path, '_cacache', 'content-v2', 'sha512');
  mkdirSync(content, { recursive: true });
  for (const [name, age] of [['old', 3], ['mid', 2], ['new', 1]]) {
    mkdirSync(join(content, name)); writeFileSync(join(content, name, 'blob'), 'x'.repeat(1000));
    const when = new Date(Date.now() - age * 60000); utimesSync(join(content, name), when, when);
  }
  const removed = cache.prune(2500);
  assert.deepEqual(removed, [join(content, 'old')]);
  assert.equal(existsSync(join(content, 'old')), false); assert.equal(existsSync(join(content, 'new')), true);
  assert.deepEqual(cache.prune(2500), []);
  rmSync(directory, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run it.** `node --test tests/npm-cache.test.mjs`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** Create `server/orchestration/adapters/npm-cache.mjs`:

```js
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { requireValue } from '../domain/contracts.mjs';

/** One private, content-addressed npm cache shared by every verification run.
 * npm verifies cache integrity itself, so a poisoned worktree cannot poison it.
 * Pruning removes the oldest content entries until the cache is under the cap.
 */
export class NpmCache {
  /** @param {{ directory: string }} options */
  constructor({ directory }) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = realpathSync(directory);
    requireValue(!lstatSync(this.path).isSymbolicLink(), 'npm cache directory is a symlink', 'OWNERSHIP_UNCERTAIN');
  }
  environment() { return { npm_config_cache: this.path }; }
  /** @param {string} path */
  size(path) {
    let total = 0;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) continue;
      total += entry.isDirectory() ? this.size(child) : statSync(child).size;
    }
    return total;
  }
  /** Remove the oldest content entries until the cache is under capBytes. @param {number} capBytes */
  prune(capBytes) {
    const content = join(this.path, '_cacache', 'content-v2');
    const removed = [];
    let total = this.size(this.path);
    if (total <= capBytes) return removed;
    /** @type {{ path: string; mtimeMs: number; size: number }[]} */ const entries = [];
    for (const algorithm of readdirSync(content, { withFileTypes: true })) {
      if (!algorithm.isDirectory()) continue;
      for (const bucket of readdirSync(join(content, algorithm.name), { withFileTypes: true })) {
        if (!bucket.isDirectory()) continue;
        const path = join(content, algorithm.name, bucket.name);
        entries.push({ path, mtimeMs: statSync(path).mtimeMs, size: this.size(path) });
      }
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of entries) {
      if (total <= capBytes) break;
      rmSync(entry.path, { recursive: true, force: true }); total -= entry.size; removed.push(entry.path);
    }
    return removed;
  }
}
```

Note: `prune` treats each second-level directory under `content-v2/<algorithm>/` as one unit. npm stores content as `content-v2/sha512/<2 hex>/<2 hex>/<hash>`. Removing a 2-hex bucket removes a slice of the cache; npm re-downloads any missing blob and verifies integrity, so a partial removal is safe.

- [ ] **Step 4: Run it.** Expected: PASS. If `readdirSync(content)` throws because `_cacache` does not exist, guard with `if (!existsSync(content)) return removed;` after the size check, importing `existsSync`.

- [ ] **Step 5: Commit.**

```bash
git add server/orchestration/adapters/npm-cache.mjs tests/npm-cache.test.mjs
git commit -m "feat: add a private size-capped npm cache for verification"
```

### Task 6: Run prepare as the leading check

**Files:**
- Modify: `server/orchestration/adapters/verification.mjs`
- Test: `tests/orchestration-verification.test.mjs`

- [ ] **Step 1: Write the failing tests.** Append to `tests/orchestration-verification.test.mjs`:

```js
const prepareOptions = (f, script) => ({ ...f.options, resolvePrepare: (repositoryId, goalId) => { assert.equal(repositoryId, 'repo'); assert.equal(goalId, 'g'); return { bin: process.execPath, argv: ['-e', script], env: { PATH: process.env.PATH }, environmentId: 'fixture-prepare', policy }; } });

test('prepare runs first in the worktree, its output is evidence, and the planned checks see its files', async (t) => {
  const f = await fixture(t);
  const runner = new VerificationRunner(prepareOptions(f, "require('node:fs').mkdirSync('node_modules'); require('node:fs').writeFileSync('node_modules/marker', process.env.npm_config_cache ?? 'no-cache'); console.log('installed')"));
  const result = await runner.run({ ...f.input, checks: [...f.input.checks, { id: 'marker', argv: ['node', '-e', "require('node:fs').accessSync('node_modules/marker')"] }] });
  assert.deepEqual(result.verification.checks.map((check) => [check.id, check.passed]), [['prepare', true], ['unit', true], ['marker', true]]);
  const evidence = JSON.parse(f.artifacts.get(result.verification.checks[0].artifactId).toString());
  assert.equal(evidence.checkId, 'prepare'); assert.match(evidence.outcome.stdout, /installed/); assert.equal(evidence.environment.id, 'fixture-prepare');
  assert.deepEqual(await new VerificationRunner(prepareOptions(f, 'throw 1')).run({ ...f.input, checks: [...f.input.checks, { id: 'marker', argv: ['node', '-e', "require('node:fs').accessSync('node_modules/marker')"] }] }), result);
});

test('a failing prepare records PREPARE_FAILED for every planned check without launching them', async (t) => {
  const f = await fixture(t);
  const result = await new VerificationRunner(prepareOptions(f, "console.error('lockfile mismatch'); process.exit(1)")).run(f.input);
  assert.deepEqual(result.verification.checks.map((check) => [check.id, check.passed]), [['prepare', false], ['unit', false]]);
  const [prepare, unit] = result.verification.checks.map((check) => JSON.parse(f.artifacts.get(check.artifactId).toString()));
  assert.equal(prepare.code, 'EXIT_FAILED'); assert.match(prepare.outcome.stderr, /lockfile mismatch/);
  assert.equal(unit.code, 'PREPARE_FAILED'); assert.equal(unit.outcome, null); assert.equal(f.resolved(), 0);
  assert.equal(result.workerState, 'stopped');
});

test('a plan may not name a check called prepare', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.runner.run({ ...f.input, checks: [{ id: 'prepare', argv: ['node', '-e', '0'] }] }), /reserved/);
});

test('without a prepare resolver the run is unchanged', async (t) => {
  const f = await fixture(t), result = await f.runner.run(f.input);
  assert.deepEqual(result.verification.checks.map((check) => check.id), ['unit']);
});
```

- [ ] **Step 2: Run it.** `node --test tests/orchestration-verification.test.mjs`. Expected: the three new tests FAIL (no `prepare` check, no reserved-name rejection).

- [ ] **Step 3: Implement.** In `server/orchestration/adapters/verification.mjs`:

Constructor: accept `resolvePrepare` and `cache`:

```js
  /** @param {{ repositories: import('./git.mjs').GitRepository; resolveCheck: (repositoryId: string, check: import('../types.d.ts').Check, goalId: string) => ResolvedCheck; resolvePrepare?: (repositoryId: string, goalId: string) => ResolvedCheck | null; cache?: import('./npm-cache.mjs').NpmCache; cacheCapBytes?: number; failpoint?: (point: string) => void; boot?: ()=>string|null }} options */
  constructor({ repositories, resolveCheck, resolvePrepare = () => null, cache = null, cacheCapBytes = 2 * 1024 * 1024 * 1024, failpoint = () => {}, boot = bootIdentity }) {
    this.boot = boot; this.repositories = repositories; this.resolveCheck = resolveCheck; this.resolvePrepare = resolvePrepare; this.cache = cache; this.cacheCapBytes = cacheCapBytes; this.failpoint = failpoint;
```

In `run`, after the existing `for (const check of checks)` validation loop, reject the reserved id:

```js
    requireValue(!checks.some((check) => check.id === 'prepare'), 'The check id "prepare" is reserved for dependency preparation');
```

Replace the check loop body so prepare runs first. The full new loop:

```js
    /** @type {import('../types.d.ts').Verification['checks']} */ const outcomes = [];
    /** @type {'stopped' | 'unknown'} */ let workerState = 'stopped';
    let prepareFailed = false;
    const prepare = this.resolvePrepare(repositoryId, goalId);
    const plan = prepare ? [{ id: 'prepare', argv: ['prepare'], resolved: prepare }, ...checks.map((check) => ({ ...check, resolved: null }))] : checks.map((check) => ({ ...check, resolved: null }));
    for (const check of plan) {
      let resolved, outcome = null, code = '', environment = null;
      if (workerState === 'unknown') code = 'PRIOR_WORKER_UNCERTAIN';
      else if (signal?.aborted) code = 'ABORTED';
      else if (prepareFailed) code = 'PREPARE_FAILED';
      else {
        try {
          resolved = check.resolved ?? this.resolveCheck(repositoryId, structuredClone({ id: check.id, argv: check.argv }), goalId);
          if (!check.resolved) requireValue(isAbsolute(resolved.bin) && resolved.environmentId.length > 0 && JSON.stringify(resolved.argv) === JSON.stringify(check.argv.slice(1)), 'Repository policy did not resolve the approved argv', 'UNSUPPORTED_CAPABILITY');
          else requireValue(isAbsolute(resolved.bin) && resolved.environmentId.length > 0, 'Prepare policy did not resolve an executable', 'UNSUPPORTED_CAPABILITY');
          backgroundPolicy(resolved.policy);
          requireValue(resolved.policy.maxOutputBytes <= 2 * 1024 * 1024, 'Verification output budget exceeds supervisor transport limit', 'UNSUPPORTED_CAPABILITY');
          const env = { ...resolved.env, ...(this.cache?.environment() ?? {}), HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: join(home, 'cache'), TMPDIR: temp, CI: 'true' };
          environment = { id: resolved.environmentId, bin: resolved.bin, argv: resolved.argv, platform: process.platform, architecture: process.arch, nodeVersion: process.version, environmentHash: createHash('sha256').update(JSON.stringify(env)).digest('hex') };
          requireValue(await this.repositories.checkCheckout(recorded, check.id !== 'prepare' && !prepare) === headSha, 'Verification target changed', 'STALE_TARGET');
          this.save(join(directory, `${check.id}.launch.json`), { checkId: check.id, headSha, environment });
          this.failpoint('before_launch');
          outcome = await runSupervisedProcess({ bin: resolved.bin, argv: resolved.argv, cwd: resource.worktree, env }, {
            directory: join(directory, 'workers', check.id), policy: resolved.policy, signal, boot: this.boot,
            onIdentity: () => { this.failpoint('identity_recorded'); },
          });
          workerState = outcome.workerState;
          code = outcome.cause?.code ?? '';
          if (workerState !== 'stopped') code ||= 'OWNERSHIP_UNCERTAIN';
          requireValue(await this.repositories.checkCheckout(recorded, !prepare) === headSha, 'Verification changed its recorded checkout', 'STALE_TARGET');
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          code = error.code;
          if (!outcome && pathExists(join(directory, `${check.id}.launch.json`))) workerState = 'unknown';
        }
      }
      const passed = !code && outcome?.status === 'succeeded' && workerState === 'stopped';
      if (check.id === 'prepare' && !passed) prepareFailed = true;
      const artifact = this.repositories.artifacts.put(JSON.stringify({ schemaVersion: 1, operationId, checkId: check.id, headSha, argv: check.argv, environment, code, outcome }));
      outcomes.push({ id: check.id, passed, artifactId: artifact.id });
      this.save(join(directory, `${check.id}.result.json`), { ...outcomes.at(-1), workerState }); this.failpoint('check_recorded');
    }
    if (this.cache) { try { this.cache.prune(this.cacheCapBytes); } catch { /* Cache pruning never changes a verification result. */ } }
```

Two rules carried by this code:

1. **Cleanliness after prepare.** `checkCheckout(resource, clean)` fails on untracked files. Installed dependencies are untracked, so once a prepare command exists the clean check is turned off for the rest of the run (`!prepare`). Tracked-file tampering by a check is still detected: change the second `checkCheckout` line to compare tracked changes only when prepare exists:

```js
          if (prepare) requireValue(!(await git(resource.worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=no'])), 'Check changed tracked files', 'DIRTY_WORKTREE');
```

   Add `import { git, pathExists } from './git.mjs';` at the top. Place this line directly before the second `checkCheckout` call.

2. **Request identity.** The recorded `request.json` keeps `checks` exactly as the plan supplied them (without `prepare`). Do not add `prepare` to `request.checks`.

Then update `receipt()` so the receipt check count allows the extra `prepare` entry:

```js
    const planned = artifact.verification.checks.filter((/** @type {{id:string}} */ entry) => entry.id !== 'prepare');
    requireValue(request.operationId === operationId && artifact.goalId === request.goalId && artifact.repositoryId === request.repositoryId && artifact.verification.headSha === request.headSha && planned.length === request.checks.length && request.checks.every((check) => planned.some((/** @type {import('../types.d.ts').Check} */ entry) => entry.id === check.id)), 'Verification request and receipt disagree', 'OWNERSHIP_UNCERTAIN');
```

and in the per-check evidence loop of `receipt()`, skip the argv comparison for `prepare`:

```js
    for (const check of result.verification.checks) {
      const evidence = JSON.parse(this.repositories.artifacts.get(check.artifactId).toString('utf8'));
      const expectedArgv = check.id === 'prepare' ? ['prepare'] : request.checks.find((entry) => entry.id === check.id)?.argv;
      requireValue(evidence.operationId === operationId && evidence.checkId === check.id && evidence.headSha === request.headSha && JSON.stringify(evidence.argv) === JSON.stringify(expectedArgv), 'Verification check evidence changed', 'OWNERSHIP_UNCERTAIN');
    }
```

Finally, in `observe()`, the loop iterates `request.checks`; prepend a synthetic prepare entry when a `prepare.result.json` or `prepare.launch.json` exists in the directory:

```js
    const observedChecks = pathExists(join(directory, 'prepare.result.json')) || pathExists(join(directory, 'prepare.launch.json')) ? [{ id: 'prepare', argv: ['prepare'] }, ...request.checks] : request.checks;
    for (const check of /** @type {import('../types.d.ts').Check[]} */ (observedChecks)) {
```

and inside that loop, where it computes `resource && await this.repositories.checkCheckout(resource) === request.headSha`, pass `clean = false` when `observedChecks[0].id === 'prepare'`:

```js
          requireValue(resource && await this.repositories.checkCheckout(resource, observedChecks[0].id !== 'prepare') === request.headSha, 'Verification checkout changed', 'STALE_TARGET');
```

- [ ] **Step 4: Run it.** `node --test tests/orchestration-verification.test.mjs`. Expected: all PASS, including the pre-existing tests.

- [ ] **Step 5: Commit.**

```bash
git add server/orchestration/adapters/verification.mjs tests/orchestration-verification.test.mjs
git commit -m "feat: run the approved prepare command as the leading verification check"
```

### Task 7: The domain accepts the extra prepare check and names it in the hold

**Files:**
- Modify: `server/orchestration/domain/transitions.mjs:555-570`
- Modify: `server/orchestration/domain/recovery.mjs:24-26`
- Test: `tests/orchestration-domain.test.mjs`

- [ ] **Step 1: Write the failing tests.** Find the existing test in `tests/orchestration-domain.test.mjs` that drives a goal to `record_verification_result` (search for `record_verification_result`). Copy its setup into a new test and append:

```js
test('verification results may carry a leading prepare check and a failed prepare names dependencies in the hold', () => {
  // Reuse the setup of the nearest record_verification_result test: a building
  // goal `goal` at revision 1 with integrationHead `head`, a pending run
  // `run` created by request_verification, and the helper `apply(goal, command)`.
  const artifact = 'a'.repeat(64);
  const withPrepare = apply(goal, { id: 'v1', goalId: goal.id, expectedVersion: goal.version, type: 'record_verification_result', payload: { operationId: run.operationId, result: { workerState: 'stopped', artifactId: artifact, verification: { headSha: head, checks: [{ id: 'prepare', passed: false, artifactId: artifact }, ...contractChecks.map(check => ({ id: check.id, passed: false, artifactId: artifact }))] } } } }, { kind: 'system' });
  assert.equal(withPrepare.goal.verification.checks[0].id, 'prepare');
  assert.deepEqual(withPrepare.goal.hold.reasons, [{ kind: 'verification', target: head, message: 'Dependencies did not install on the integrated head.' }]);
});
```

Adapt the variable names to the ones in the surrounding test; `contractChecks` is `goal.contracts[0].contract.verification`.

- [ ] **Step 2: Run it.** `node --test tests/orchestration-domain.test.mjs`. Expected: FAIL with "Verification must report every required check".

- [ ] **Step 3: Implement.** In `transitions.mjs` `record_verification_result`, count only non-prepare checks against the contract:

```js
      const planned = checks.filter((check) => check.id !== 'prepare');
      requireValue(required && planned.length === required.length && new Set(checks.map((check) => check.id)).size === checks.length && required.every((check) => planned.some((entry) => entry.id === check.id)), 'Verification must report every required check');
```

In `recovery.mjs` replace the verification reason:

```js
  if (goal.verification?.checks.some(check => !check.passed) && JSON.stringify(goal.verification) !== JSON.stringify(before.verification)) {
    const prepareFailed = goal.verification.checks.some(check => check.id === 'prepare' && !check.passed);
    reasons.push({ kind: 'verification', target: goal.verification.headSha, message: prepareFailed ? 'Dependencies did not install on the integrated head.' : 'Required verification failed on the integrated head.' });
  }
```

- [ ] **Step 4: Run it.** `node --test tests/orchestration-domain.test.mjs tests/orchestration-scheduler.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/orchestration/domain/transitions.mjs server/orchestration/domain/recovery.mjs tests/orchestration-domain.test.mjs
git commit -m "feat: accept a leading prepare check and name dependency failures in holds"
```

### Task 8: Remove a verification worktree safely

**Files:**
- Modify: `server/orchestration/adapters/git.mjs` (append a method to `GitRepository`)
- Modify: `server/orchestration/types.d.ts:118-126`
- Test: `tests/orchestration-verification-cleanup.test.mjs`

- [ ] **Step 1: Write the failing test.** Create `tests/orchestration-verification-cleanup.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitRepository } from '../server/orchestration/adapters/git.mjs';
import { ArtifactStore } from '../server/orchestration/storage/artifacts.mjs';
import { createRepositoryFixture, fixtureGit } from './helpers/orchestration/fixture.mjs';

async function fixture(t) {
  const repo = await createRepositoryFixture(); t.after(() => repo.close());
  const artifacts = new ArtifactStore({ directory: join(repo.directory, 'artifacts') });
  const repositories = new GitRepository({ repositories: new Map([['repo', repo.repository]]), directory: join(repo.directory, 'resources'), artifacts });
  const provisioned = await repositories.provision({ operationId: 'verify_a', repositoryId: 'repo', branch: 'companion/g/verify_a', baseSha: repo.baseSha });
  return { repo, repositories, provisioned };
}

test('a verification worktree with installed dependencies is removed while branch, ref and manifest remain', async (t) => {
  const { repo, repositories, provisioned } = await fixture(t);
  mkdirSync(join(provisioned.worktree, 'node_modules')); writeFileSync(join(provisioned.worktree, 'node_modules', 'blob'), 'x');
  assert.deepEqual(await repositories.removeVerificationWorktree('verify_a'), { removed: true });
  assert.equal(existsSync(provisioned.worktree), false);
  assert.equal(await fixtureGit(repo.repository, ['rev-parse', '--verify', 'refs/heads/companion/g/verify_a']), repo.baseSha);
  assert.equal(await fixtureGit(repo.repository, ['rev-parse', '--verify', 'refs/companion/resources/verify_a']), repo.baseSha);
  assert.ok(repositories.resource('verify_a'));
  assert.deepEqual(await repositories.removeVerificationWorktree('verify_a'), { removed: false });
});

test('removal refuses a worktree whose branch or registration no longer matches its manifest', async (t) => {
  const { repositories, provisioned } = await fixture(t);
  await fixtureGit(provisioned.worktree, ['checkout', '-q', '-b', 'someone-else']);
  await assert.rejects(repositories.removeVerificationWorktree('verify_a'), { code: 'STALE_TARGET' });
  assert.equal(existsSync(provisioned.worktree), true);
});

test('removal of an unknown operation is a no-op', async (t) => {
  const { repositories } = await fixture(t);
  assert.deepEqual(await repositories.removeVerificationWorktree('never_provisioned'), { removed: false });
});
```

- [ ] **Step 2: Run it.** `node --test tests/orchestration-verification-cleanup.test.mjs`. Expected: FAIL, method missing.

- [ ] **Step 3: Implement.** Append to `GitRepository` in `git.mjs`, after `provision`:

```js
  /** Remove a verification checkout after its evidence is recorded. Untracked
   * files are install output the run created, so force is acceptable here and
   * only here. Branch, ownership ref and manifest remain for the journal.
   * @param {string} operationId @returns {Promise<{ removed: boolean }>} */
  async removeVerificationWorktree(operationId) {
    const resource = this.resource(operationId);
    if (!resource || !pathExists(resource.worktree)) return { removed: false };
    await this.checkCheckout(resource, false);
    const registered = (await git(resource.repository, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0').map((record) => record.split('\0')).find((fields) => fields[0] === `worktree ${resource.worktree}`);
    requireValue(registered && registered.includes(`branch refs/heads/${resource.branch}`), 'Worktree registration changed', 'OWNERSHIP_UNCERTAIN');
    await git(resource.repository, ['worktree', 'remove', '--force', resource.worktree]);
    requireValue(!pathExists(resource.worktree), 'Worktree removal is incomplete', 'OWNERSHIP_UNCERTAIN');
    return { removed: true };
  }
```

In `types.d.ts` add to `RepositoryPort`:

```ts
  removeVerificationWorktree(operationId: string): Promise<{ removed: boolean }>;
```

Check whether any fake repository port in `tests/helpers/orchestration/` implements `RepositoryPort` and add a `removeVerificationWorktree: async () => ({ removed: false })` to it if the typecheck complains.

- [ ] **Step 4: Run it.** Expected: PASS. Run `npm run typecheck`.

- [ ] **Step 5: Commit.**

```bash
git add server/orchestration/adapters/git.mjs server/orchestration/types.d.ts tests/orchestration-verification-cleanup.test.mjs
git commit -m "feat: remove verification worktrees after their evidence is recorded"
```

### Task 9: The coordinator removes worktrees after results and on startup

**Files:**
- Modify: `server/orchestration/verification-coordinator.mjs`
- Test: `tests/orchestration-verification-cleanup.test.mjs` (extend)

- [ ] **Step 1: Write the failing test.** Append to `tests/orchestration-verification-cleanup.test.mjs`:

```js
import { VerificationCoordinator } from '../server/orchestration/verification-coordinator.mjs';

test('the coordinator removes the worktree after a stopped result and sweeps leftovers on startup', async (t) => {
  const { repositories, provisioned } = await fixture(t);
  const removed = [];
  const repositoriesPort = { removeVerificationWorktree: async (id) => { removed.push(id); return repositories.removeVerificationWorktree(id); } };
  const goal = { id: 'g', status: 'building', generation: 1, revision: 1, integrationHead: 'h'.repeat(40), repositoryId: 'repo', hold: null, verificationRuns: [{ operationId: 'verify_a', generation: 1, revision: 1, headSha: 'h'.repeat(40), status: 'complete', workerState: 'stopped', result: { verification: { headSha: 'h'.repeat(40), checks: [] }, workerState: 'stopped', artifactId: 'a'.repeat(64) } }] };
  const store = { list: () => [goal], get: () => goal, operations: () => [], advanceOperation: () => true };
  const service = { store, repositoryIds: new Set(['repo']), execute: () => ({}) };
  const coordinator = new VerificationCoordinator({ service, verifier: { run: async () => { throw new Error('unused'); }, observe: async () => null }, ownership: { assertOwned() {} }, repositories: repositoriesPort });
  await coordinator.run();
  assert.deepEqual(removed, ['verify_a']);
  assert.equal(existsSync(provisioned.worktree), false);
  await coordinator.run();
  assert.deepEqual(removed, ['verify_a', 'verify_a']);
});
```

- [ ] **Step 2: Run it.** Expected: FAIL, the constructor ignores `repositories` and nothing is removed.

- [ ] **Step 3: Implement.** In `verification-coordinator.mjs`:

Constructor: accept and store `repositories`:

```js
  /** @param {{ service: import('./service.mjs').OrchestrationService; verifier: import('./types.d.ts').VerificationPort; ownership: { assertOwned(): void }; repositories?: Pick<import('./types.d.ts').RepositoryPort, 'removeVerificationWorktree'> | null; id?: () => string; onError?: (error: unknown) => void }} options */
  constructor({ service, verifier, ownership, repositories = null, id = randomUUID, onError = () => {} }) {
    this.service = service; this.store = service.store; this.verifier = verifier; this.ownership = ownership; this.repositories = repositories; this.id = id; this.onError = onError;
```

Add a method:

```js
  /** Verification evidence is durable once recorded; the checkout adds nothing. @param {string} operationId */
  async release(operationId) {
    if (!this.repositories) return;
    try { await this.repositories.removeVerificationWorktree(operationId); }
    catch (error) { this.onError(error); }
  }
```

In `run()`, at the start of the method after `this.cancelRevoked(); this.ownership.assertOwned();`, sweep stopped runs:

```js
    for (const snapshot of this.store.list()) for (const run of snapshot.verificationRuns ?? []) {
      if (run.workerState === 'stopped' && run.result) await this.release(run.operationId);
    }
```

In the job body, after `this.record(goal.id, 'record_verification_result', { operationId: operation.id, result });`:

```js
        if (result.workerState === 'stopped') { this.store.advanceOperation(operation.id, 'dispatching', 'completed'); await this.release(operation.id); }
```

(replace the existing single-line `if (result.workerState === 'stopped') this.store.advanceOperation(...)`). Also in the `dispatching` observe branch, after `if (receipt?.workerState === 'stopped') this.store.advanceOperation(operation.id, operation.status, 'completed');` add `if (receipt?.workerState === 'stopped') await this.release(operation.id);`.

The startup sweep is bounded: `removeVerificationWorktree` returns `{ removed: false }` immediately when the manifest is absent or the directory no longer exists. It does a Git call only when a directory is still present.

In `scheduler.mjs:25` pass repositories:

```js
    this.verifications = verifier ? new VerificationCoordinator({ service, verifier, ownership, repositories, id, onError }) : null;
```

Check the `Scheduler` constructor has `repositories` in scope (it receives `repositories` per `create-runtime.mjs:68`).

- [ ] **Step 4: Run it.** `node --test tests/orchestration-verification-cleanup.test.mjs tests/orchestration-scheduler.test.mjs tests/orchestration-delivery.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/orchestration/verification-coordinator.mjs server/orchestration/scheduler.mjs tests/orchestration-verification-cleanup.test.mjs
git commit -m "feat: release verification worktrees after results and on startup"
```

**Phase 2 verification:** `npm test` then `npm run typecheck`. All green before Phase 3.

---

## Phase 3 — Wiring, UI, docs and journeys

### Task 10: Wire prepare and the cache into the runtimes

**Files:**
- Modify: `server/orchestration/create-runtime.mjs:29,43,68`
- Modify: `server/settings-runtime.mjs:153-158`
- Modify: `server/orchestration/production.mjs:70-75`
- Test: `tests/settings-runtime.test.mjs`

- [ ] **Step 1: Write the failing test.** Append to `tests/settings-runtime.test.mjs`:

```js
test('verification prepare is read from the live project setting so a held goal recovers after Setup changes', async t => {
  const resolved = [];
  const { runtime, settings, path } = await fixture(t, { resolvePrepare: (project, options) => { resolved.push(project.prepare); return null; } });
  const value = defaultSettings(); value.projects.push({ id: 'project', name: 'Project', path, enabled: true, github: 'example/project', remote: 'git@github.com:example/project.git', checks: [], prepare: { source: 'disabled' } });
  assert.equal((await runtime.app.inject({ method: 'PUT', url: '/api/settings/local', headers, payload: { expectedRevision: 0, settings: value } })).statusCode, 200);
  runtime.resolvePrepareForTest('project', 'goal-x');
  const next = settings.read(); next.settings.projects[0].prepare = { source: 'custom', executable: 'npm', args: ['ci'] };
  assert.equal((await runtime.app.inject({ method: 'PUT', url: '/api/settings/local', headers, payload: { expectedRevision: next.revision, settings: next.settings } })).statusCode, 200);
  runtime.resolvePrepareForTest('project', 'goal-x');
  assert.deepEqual(resolved, [{ source: 'disabled' }, { source: 'custom', executable: 'npm', args: ['ci'] }]);
});
```

- [ ] **Step 2: Run it.** Expected: FAIL, `resolvePrepare` option and `resolvePrepareForTest` do not exist.

- [ ] **Step 3: Implement.**

`create-runtime.mjs`: add to the options JSDoc and signature `resolvePrepare?: ConstructorParameters<typeof VerificationRunner>[0]['resolvePrepare']` and pass a cache:

```js
import { NpmCache } from './adapters/npm-cache.mjs';
...
export async function createRuntime({ storage, repositories: configured, token, readOnly = false, createAgents, resolveCheck, resolvePrepare, createPublisher, consumers = [], limits, logLevel, suspension = () => null, prepareGoal, beforeCommand, projectStatus, goalLimits, onError = () => {} }) {
...
    const cache = new NpmCache({ directory: join(storage.resources, 'npm-cache') });
    const scheduler = new Scheduler({ service, repositories, prepareGoal, integrations: new GitIntegration({ repositories }), verifier: new VerificationRunner({ repositories, resolveCheck, resolvePrepare, cache }), publisher: createPublisher({ repositories }), results, onError: report });
```

`settings-runtime.mjs`: import `resolvePrepare as resolvePrepareCommand` from `./prepare-command.mjs`, accept an override option for tests, and pass a resolver that reads the live setting:

```js
import { resolvePrepare as resolvePrepareCommand } from './prepare-command.mjs';
...
export async function createSettingsRuntime({ settings, directory, token, createAgents, probeProvider, probeGit = probeGitCapabilities, own = acquireRepositoryOwnership, publisherFactory, prepareGoal, resolveProviderCommand, resolvePrepare = resolvePrepareCommand, usageSnapshot = async () => ({ available: false }) }) {
...
  const prepareFor = (repositoryId, goalId) => {
    const config = configured(goalId);
    requireValue(config.project.id === repositoryId, 'Verification repository changed', 'FORBIDDEN');
    // Prepare is infrastructure approved in Setup, so the live project setting applies.
    const live = settings.read().settings.projects.find(entry => entry.id === repositoryId) ?? config.project;
    return resolvePrepare(live, { env: environment(), environmentId: `settings-${settings.read().revision}`, policy: config.execution });
  };
```

and in the `createRuntime({...})` call add `resolvePrepare: prepareFor,`. After `runtime` is created, expose the test hook: `runtime.resolvePrepareForTest = prepareFor;`.

In the test, the goal `goal-x` needs a goal configuration for `configured()` to succeed. Before the first `resolvePrepareForTest` call, create the goal through the API exactly as the test "saving a project immediately populates goals" does (copy its `create_goal` inject with `goalId: 'goal-x'`), or call `settings.snapshotGoal('goal-x', 'project')` directly. Use `snapshotGoal`; it is simpler and is what admission does.

`production.mjs`: production config has no prepare setting today. Pass `resolvePrepare: () => null` explicitly in its `createRuntime` call with the comment `// Production JSON configuration has no prepare command; Settings-based installs supply it.`

- [ ] **Step 4: Run it.** `node --test tests/settings-runtime.test.mjs tests/orchestration-runtime.test.mjs` and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/orchestration/create-runtime.mjs server/settings-runtime.mjs server/orchestration/production.mjs tests/settings-runtime.test.mjs
git commit -m "feat: wire the live prepare setting and npm cache into verification"
```

### Task 11: Setup shows and edits the Prepare line

**Files:**
- Modify: `app/settings/settings-panel.tsx:19-20`
- Modify: `app/settings/dev-repositories.tsx` (repository editor, after the Git remote details)
- Test: `tests/ui-local-settings.test.tsx`

- [ ] **Step 1: Write the failing test.** Append to `tests/ui-local-settings.test.tsx`, using the existing helpers `fixture`, `click`, `change`, `saved` from the file:

```tsx
test('the repository editor shows the detected prepare command and lets the user edit or disable it', async () => {
  const settings = defaults();
  settings.projects = [{ id: 'one', name: 'One', path: '/projects/one', enabled: true, github: 'example/one', remote: 'git@github.com:example/one.git', checks: [], prepare: { source: 'detected', executable: 'npm', args: ['ci'] } }];
  const state = fixture('repositories', settings);
  render(<LocalSettingsPanel />);
  click(/One.*Repository ready/);
  await screen.findByText('npm ci · detected');
  fireEvent.click(screen.getByRole('button', { name: 'Edit prepare command' }));
  change('Prepare executable', 'pnpm'); change('Prepare arguments (one per line)', 'install\n--frozen-lockfile');
  click('Save changes'); await saved();
  assert.deepEqual(state.saved.settings.projects[0].prepare, { source: 'custom', executable: 'pnpm', args: ['install', '--frozen-lockfile'] });
  fireEvent.click(screen.getByRole('button', { name: 'Disable prepare' }));
  click('Save changes'); await saved();
  assert.deepEqual(state.saved.settings.projects[0].prepare, { source: 'disabled' });
  await screen.findByText('Disabled · verification runs without installing dependencies');
});
```

Check the file's helper names before use; if `click` takes a regex or string, keep it. If the category slug for repositories differs from `'repositories'`, use the one the file already uses for the repositories tests.

- [ ] **Step 2: Run it.** `npx vitest run tests/ui-local-settings.test.tsx`. Expected: FAIL, "npm ci · detected" not found.

- [ ] **Step 3: Implement.**

`settings-panel.tsx`:

```ts
export type Prepare = { source: 'detected' | 'custom' | 'disabled' | 'none'; executable?: string; args?: string[] };
export type Project = { id: string; name: string; path: string; enabled: boolean; github: string | null; remote: string | null; checks: Check[]; devRepoId?: string; prepare?: Prepare };
```

`dev-repositories.tsx`: import `Prepare` from `./settings-panel`. Insert after the GitHub `</details>` and before the `<h4>Verification defaults (optional)</h4>`:

```tsx
      <h4>Prepare dependencies</h4><p>Runs once in each verification checkout before the checks. Detected from the lockfile; nothing runs during setup.</p>
      <PrepareRow prepare={project.prepare ?? { source: 'none' }} onChange={prepare => updateProject(project.id, { prepare })} />
```

Add the component at the end of the file:

```tsx
function PrepareRow({ prepare, onChange }: { prepare: Prepare; onChange: (prepare: Prepare) => void }) {
  const [editing, setEditing] = useState(false);
  const commanded = prepare.source === 'detected' || prepare.source === 'custom';
  const summary = commanded ? `${[prepare.executable, ...(prepare.args ?? [])].join(' ')} · ${prepare.source}`
    : prepare.source === 'disabled' ? 'Disabled · verification runs without installing dependencies' : 'No lockfile found · verification runs without installing dependencies';
  return <div className="settings-command">
    <p><code>{summary}</code></p>
    {editing && <><label>Prepare executable<input value={prepare.executable ?? ''} onChange={event => onChange({ source: 'custom', executable: event.target.value, args: prepare.args ?? [] })} autoCapitalize="none" spellCheck={false} /></label>
      <label>Prepare arguments (one per line)<textarea value={(prepare.args ?? []).join('\n')} onChange={event => onChange({ source: 'custom', executable: prepare.executable ?? '', args: event.target.value ? event.target.value.split('\n') : [] })} /></label></>}
    <button type="button" onClick={() => { if (!editing && !commanded) onChange({ source: 'custom', executable: 'npm', args: ['ci'] }); setEditing(!editing); }}>{editing ? 'Done editing' : 'Edit prepare command'}</button>
    {prepare.source !== 'disabled' && <button type="button" onClick={() => { setEditing(false); onChange({ source: 'disabled' }); }}>Disable prepare</button>}
  </div>;
}
```

Also in the scan fixture of the UI test file (`tests/ui-local-settings.test.tsx:21`), the pushed project already lacks `prepare`; leave it, the type marks `prepare` optional.

- [ ] **Step 4: Run it.** `npx vitest run tests/ui-local-settings.test.tsx`. Expected: PASS. Then `npm run lint` and `npm run typecheck`.

- [ ] **Step 5: Commit.**

```bash
git add app/settings/settings-panel.tsx app/settings/dev-repositories.tsx tests/ui-local-settings.test.tsx
git commit -m "feat: show and edit the per-project prepare command in Setup"
```

### Task 12: Docs

**Files:**
- Modify: `README.md` (under "Goal workflow", after the sentence about repository checks at line 47)
- Modify: `docs/settings-onboarding.md` (after the paragraph at line 48-50)

- [ ] **Step 1: README.** Insert after the line that ends "...the plan must address that gap.":

```markdown
Before the approved checks run, each verification checkout installs its
dependencies with the project's prepare command. Companion detects it from the
lockfile (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`
or `bun install --frozen-lockfile`) and you can edit or disable it in Setup. The
install is recorded as a `prepare` check with its own output. When it fails, the
planned checks are not run and the hold says that dependencies did not install.
Verification checkouts are removed as soon as their result is recorded; a private
npm cache under the data directory keeps repeated installs fast and is pruned
above 2 GiB.
```

- [ ] **Step 2: settings-onboarding.md.** Insert after the "Repository configuration and provider readiness..." paragraph:

```markdown
Each repository row also shows **Prepare dependencies**: the install command
detected from its lockfile. It runs once in every verification checkout before
the checks. Edit it for an unusual layout, or disable it for repositories that
need no install. Detection never executes anything during setup.
```

- [ ] **Step 3: Commit.**

```bash
git add README.md docs/settings-onboarding.md
git commit -m "docs: describe verification prepare and checkout cleanup"
```

### Task 13: Cypress journeys

**Files:**
- Modify: `cypress/e2e/settings.cy.ts`
- Modify: `cypress/e2e/orchestration-core.cy.ts`
- Modify: `scripts/run-orchestration-dev.mjs:73-76`

- [ ] **Step 1: Settings spec.** In `cypress/e2e/settings.cy.ts`, find the test that opens a repository editor (search for `Advanced verification`). After it saves checks, add:

```ts
    cy.findByRole('heading', { name: 'Prepare dependencies' }).should('be.visible');
    cy.findByRole('button', { name: 'Edit prepare command' }).click();
    cy.findByLabelText('Prepare executable').clear().type('npm');
    cy.findByLabelText('Prepare arguments (one per line)').clear().type('ci');
    cy.findByRole('button', { name: 'Save changes' }).click();
    cy.contains('code', 'npm ci · custom').should('be.visible');
```

If that spec uses stubbed settings routes, make sure the stub echoes `settings.projects[0].prepare` back on save the same way it echoes `checks`.

- [ ] **Step 2: Orchestration spec.** In `scripts/run-orchestration-dev.mjs`, next to `resolveCheck`, add a fake prepare that writes a marker the fixture check can read:

```js
        resolvePrepare: (repositoryId) => {
          if (repositoryId !== 'repo') throw new Error('Unknown fixture repository');
          return { bin: process.execPath, argv: ['-e', "require('node:fs').mkdirSync('node_modules',{recursive:true}); console.log('fixture prepare')"], env: { PATH: process.env.PATH }, environmentId: 'disposable-fixture-prepare', policy: { ceilingMs: 10000, idleMs: 2000, maxOutputBytes: 8192, killGraceMs: 100 } };
        },
```

and pass it through wherever that script calls `createRuntime` (it is an option of `createRuntime` after Task 10). In `cypress/e2e/orchestration-core.cy.ts`, in the writable journey after the "Combined verification" region assertion at line 74, add:

```ts
    cy.findByRole('region', { name: 'Combined verification' }).contains('p', 'prepare').should('contain.text', 'Passed');
    cy.findByRole('region', { name: 'Combined verification' }).findAllByRole('button', { name: 'Inspect check output' }).first().click();
    cy.findByLabelText('Check output').should('contain.text', 'fixture prepare');
```

- [ ] **Step 3: Run.** `npm run test:e2e:local`. If Electron fails, `CMUX_COMPANION_CYPRESS_BROWSER=chrome npm run test:e2e:local`. Expected: settings and orchestration-core specs PASS. Record the result in the completion report; if a spec cannot run on this Mac, say which and why.

- [ ] **Step 4: Commit.**

```bash
git add cypress/e2e/settings.cy.ts cypress/e2e/orchestration-core.cy.ts scripts/run-orchestration-dev.mjs
git commit -m "test: cover prepare in the settings and orchestration journeys"
```

**Phase 3 verification:** `npm run verify` (backend and UI coverage at 90%, lint, types, build). All green.

---

## Final: recover the held goal on this Mac

This is an operator step, not a commit. After the branch is merged and installed (the user decides both), the user:

1. Opens Setup, Dev repositories, opens `cmux-companion`, sees `npm ci · detected` (or presses Open / Refresh on the karven folder to rescan).
2. Opens the paste-image goal and presses "Retry verification & resume".
3. Confirms in the Run report that `prepare`, `ui`, `lint` and `typecheck` show real results, and that `~/.config/cmux-companion/resources/worktrees/` holds no completed verification worktree.

## Self-review against the spec

- Detection table and order: Task 1. Setting shape and sources: Task 2. Scan defaults: Task 3.
- Live setting at run time: Task 10. PATH resolution and shell wrapper refusal: Task 4.
- Prepare as leading check, `PREPARE_FAILED`, isolated HOME/TMPDIR, `npm_config_cache`: Task 6. Hold message: Task 7.
- Cache directory, mode 0700, 2 GiB prune: Tasks 5 and 6.
- Worktree removal with identity checks, force limited to verification, branch/ref/manifest kept, startup sweep, failure never changes the result: Tasks 8 and 9.
- Setup UI: Task 11. Docs: Task 12. Cypress: Task 13. Non-goals untouched: no agent or integration worktree change, no contract change, no planner control.
