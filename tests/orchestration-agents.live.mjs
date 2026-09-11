// Opt-in only: this suite creates real provider requests against disposable Git.
// It is excluded from deterministic discovery and must not run without explicit
// task authorization plus both environment opt-ins documented in the runbook.
import assert from 'node:assert/strict';
import test from 'node:test';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntime } from '../server/orchestration/create-runtime.mjs';
import { probeNativeCapabilities } from '../server/orchestration/adapters/native-capabilities.mjs';
import { NativeInputs } from '../server/orchestration/adapters/native-inputs.mjs';
import { NativeBackground } from '../server/orchestration/adapters/native-background.mjs';
import { createRepositoryFixture, fixtureGit } from './helpers/orchestration/fixture.mjs';
import { randomBytes } from 'node:crypto';

const enabled = process.env.CMUX_ORCHESTRATION_LIVE === '1' && Boolean(process.env.CMUX_ORCHESTRATION_LIVE_CONFIG);
test('real native reviewer emits pinned structured evidence without repository mutation', { skip: !enabled, timeout: 240000 }, async (t) => {
  const path = process.env.CMUX_ORCHESTRATION_LIVE_CONFIG;
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.size < 65536, 'Live configuration must be a private regular file');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const installation = await probeNativeCapabilities({ ccsBin: config.ccsBin, claudeBin: config.claudeBin });
  const f = await createRepositoryFixture(); let runtime;
  t.after(async () => { if (runtime) await runtime.close(); await f.close(); });
  runtime = await createRuntime({
    storage: { database: join(f.directory, 'native.sqlite'), artifacts: join(f.directory, 'artifacts'), resources: join(f.directory, 'resources') },
    repositories: new Map([['repo', f.repository]]), token: randomBytes(32).toString('hex'),
    createAgents: ({ describe, onResult }) => new NativeBackground({ directory: join(f.directory, 'native'), bin: installation.bin,
      inputs: new NativeInputs({ installation, engine: config.engine, env: config.env, capabilities: installation.capabilities, describe }),
      policy: { ceilingMs: 180000, idleMs: 120000, maxOutputBytes: 2 * 1024 * 1024, killGraceMs: 1000 }, onResult }),
    resolveCheck: () => { throw new Error('Live reviewer does not authorize checks'); },
    createPublisher: () => ({ publish: async () => { throw new Error('Live reviewer does not authorize publication'); } }),
  });
  runtime.service.execute({ id: 'create', goalId: 'live-review', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'Review the disposable fixture contract independently', baseSha: f.baseSha } }, { kind: 'user' });
  runtime.service.execute({ id: 'contract', goalId: 'live-review', expectedVersion: 1, type: 'publish_contract', payload: { contract: f.contract } }, { kind: 'user' });
  await runtime.listen();
  const deadline = Date.now() + 190000;
  let goal;
  do {
    await delay(100); await runtime.scheduler.tick(); goal = runtime.store.get('live-review');
  } while (goal.attempts.some(attempt => attempt.workerState !== 'stopped') && Date.now() < deadline);
  assert.ok(goal.attempts.every(attempt => attempt.workerState === 'stopped'), 'Native worker termination was not confirmed');
  assert.equal(goal.reviews.length, 1, 'Native reviewer did not submit a valid pinned review');
  assert.equal(goal.approvedRevision, null);
  for (const attempt of goal.attempts) assert.equal(await fixtureGit(attempt.worktree, ['status', '--porcelain']), '', 'Reviewer mutated its snapshot');
});
