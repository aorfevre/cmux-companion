import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readFileSync, writeFileSync, chmodSync, existsSync, renameSync } from 'node:fs';
import test from 'node:test';
import { legacyInventory, assertCutover, assertRollback, acquireRepositoryOwnership } from '../server/orchestration/cutover.mjs';
import { loadProductionConfig, createProductionRuntime } from '../server/orchestration/production.mjs';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { SchedulerOwnership } from '../server/orchestration/storage/ownership.mjs';
import { createRepositoryFixture } from './helpers/orchestration/fixture.mjs';
import { FakeAgents } from './helpers/orchestration/fake-agents.mjs';
import { buildApp } from '../server/app.mjs';
const token = 'disposable-cutover-test-token-at-least-32';
async function fixture(t) {
  const repo = await createRepositoryFixture(); t.after(() => repo.close());
  const legacy = join(repo.directory, 'legacy.sqlite'), db = new DatabaseSync(legacy);
  db.exec("CREATE TABLE plans(plan_id TEXT PRIMARY KEY,status TEXT,goal TEXT,goal_session_workspace_id TEXT); CREATE TABLE tasks(id TEXT,workspace_id TEXT,pid INTEGER); INSERT INTO plans VALUES('old','aborted','private legacy prompt','old_session'); INSERT INTO tasks VALUES('task','old_task',NULL)"); db.close();
  const cutover = { legacyDatabases: [legacy], legacyOwnerPids: [], legacySessionIds: [], inventoryDigest: legacyInventory([legacy]).digest };
  return { repo, legacy, cutover };
}
test('read-only legacy inventory includes task resources and hides prompts; changed or active goals block startup', async t => {
  const f = await fixture(t), bytes = readFileSync(f.legacy);
  const inventory = await assertCutover(f.cutover, { sessions: async () => [] });
  assert.deepEqual(readFileSync(f.legacy), bytes); assert.ok(!JSON.stringify(inventory).includes('private legacy prompt'));
  assert.ok(inventory.databases[0].resources.some(row => row.value === 'old_task'));
  await assert.rejects(assertCutover(f.cutover, { sessions: async () => ['old_task'] }), { code: 'OWNERSHIP_UNCERTAIN' });
  await assert.rejects(assertCutover(f.cutover), { code: 'CUTOVER_REQUIRED' });
  const db = new DatabaseSync(f.legacy); db.exec("UPDATE plans SET status='executing'"); db.close();
  await assert.rejects(assertCutover(f.cutover), { code: 'CUTOVER_REQUIRED' });
  await assert.rejects(assertCutover({ ...f.cutover, inventoryDigest: legacyInventory([f.legacy]).digest }), { code: 'CUTOVER_REQUIRED' });
});
test('legacy process uncertainty is never converted into permission to start', async t => {
  const f = await fixture(t);
  for (const state of ['alive', 'unknown']) await assert.rejects(assertCutover({ ...f.cutover, legacyOwnerPids: [123] }, { sessions: async () => [], liveness: () => state }), { code: 'OWNERSHIP_UNCERTAIN' });
  await assertCutover({ ...f.cutover, legacyOwnerPids: [123] }, { sessions: async () => [], liveness: () => 'dead' });
});
test('repository ownership fences another database and rollback refuses active or uncertain replacement workers', async t => {
  const f = await fixture(t), database = join(f.repo.directory, 'new.sqlite'), store = new OrchestrationStore({ path: database }); t.after(() => store.close());
  const scheduler = new SchedulerOwnership({ store }); scheduler.acquire();
  assert.throws(() => assertRollback(database), { code: 'OWNERSHIP_UNCERTAIN' }); scheduler.release();
  const roots = new Map([['repo', f.repo.repository]]), first = await acquireRepositoryOwnership(roots, database);
  await assert.rejects(acquireRepositoryOwnership(roots, join(f.repo.directory, 'other.sqlite')), { code: 'OWNERSHIP_UNCERTAIN' });
  first.close();
  store.apply({ id: 'create', goalId: 'new', expectedVersion: 0, type: 'create_goal', payload: { title: 'Replacement only', repositoryId: 'repo', baseSha: f.repo.baseSha } }, { kind: 'user' });
  store.apply({ id: 'attempt', goalId: 'new', expectedVersion: 1, type: 'request_attempt', payload: { attemptId: 'a', operationId: 'op', role: 'planner', conversationId: 'c' } }, { kind: 'system' });
  assert.throws(() => assertRollback(database), { code: 'OWNERSHIP_UNCERTAIN' });
  await assert.rejects(acquireRepositoryOwnership(roots, join(f.repo.directory, 'other.sqlite')), { code: 'OWNERSHIP_UNCERTAIN' });
  // The same database may restart to reconcile its own durable ownership.
  const resume = await acquireRepositoryOwnership(roots, database); resume.close();
});
test('unprepared and public configuration is rejected before adapter construction', async t => {
  const f = await fixture(t), path = join(f.repo.directory, 'production.json');
  assert.throws(() => loadProductionConfig(undefined), { code: 'CUTOVER_REQUIRED' });
  writeFileSync(path, '{}', { mode: 0o644 }); chmodSync(path, 0o644);
  assert.throws(() => loadProductionConfig(path), { code: 'CUTOVER_REQUIRED' });
  chmodSync(path, 0o600); assert.throws(() => loadProductionConfig(path), { code: 'CUTOVER_REQUIRED' });
});
test('disposable production composition exposes one core plus inert monitoring and rehearses stopped rollback', async t => {
  const f = await fixture(t), storage = { database: join(f.repo.directory, 'new.sqlite'), artifacts: join(f.repo.directory, 'artifacts'), resources: join(f.repo.directory, 'resources') };
  const config = { schemaVersion: 1, storage, cutover: f.cutover, native: { directory: join(f.repo.directory, 'native'), ccsBin: process.execPath, claudeBin: process.execPath, engine: { provider: 'claude', model: 'default' }, env: {}, cmux: { bin: process.execPath, env: {} } }, repositories: [{ id: 'repo', path: f.repo.repository, github: 'fixture/repo', remote: { url: 'ssh://git@github.com/fixture/repo.git', protocol: 'ssh', env: {} }, checks: [{ id: 'unit', argv: ['node', '--test'], bin: process.execPath, env: {}, environmentId: 'fixture-node' }] }], policy: { ceilingMs: 10000, idleMs: 2000, maxOutputBytes: 8192, killGraceMs: 100 } };
  const path = join(f.repo.directory, 'production.json'); writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  let terminalCalls = 0;
  const agents = new FakeAgents(); agents.close = async () => {};
  const runtime = await createProductionRuntime({ config: loadProductionConfig(path), token, sessions: async () => [], probe: async () => ({}), agents: () => agents, publisher: () => ({ publish: async () => { throw new Error('No publication expected'); } }), monitor: async app => buildApp({ app, token, eventHub: { stop() {} }, accountUsage: { snapshot: async () => ({ accounts: [] }) }, ccsReconnect: {}, cmux: { workspaceListDetailed: async () => ({ workspaces: [] }), sendText: async () => { terminalCalls++; }, sendPrompt: async () => { terminalCalls++; } }, modelSettings: {}, repoCatalog: {} }) });
  t.after(() => runtime.close());
  await runtime.listen();
  assert.equal(runtime.store.list().length, 0); assert.equal(agents.launches.length, 0);
  const headers = { authorization: `Bearer ${token}` };
  assert.equal((await runtime.app.inject({ url: '/api/auth/status' })).statusCode, 200);
  assert.equal((await runtime.app.inject({ url: '/api/orchestration/configuration', headers })).statusCode, 200);
  for (const url of ['/api/goal-sessions', '/api/worktree-plans', '/api/burst-plans', '/api/worktree-dashboard']) assert.equal((await runtime.app.inject({ url, headers })).statusCode, 404);
  assert.equal((await runtime.app.inject({ url: '/api/account-usage', headers })).statusCode, 200);
  for (const payload of [{ text: 42 }, { text: 'hello', shell: true }]) assert.equal((await runtime.app.inject({ method: 'POST', url: '/api/terminals/surface:1/input', headers, payload })).statusCode, 400);
  assert.equal(terminalCalls, 0);
  assert.throws(() => assertRollback(storage.database), { code: 'OWNERSHIP_UNCERTAIN' });
  await runtime.close(); assert.deepEqual(assertRollback(storage.database), { safe: true, goals: 0 });
  assert.ok(existsSync(f.legacy)); assert.equal(legacyInventory([f.legacy]).digest, f.cutover.inventoryDigest);
});

test('a failed startup reservation permits corrected storage while a replaced bound database is refused', async t => {
  const f = await fixture(t), roots = new Map([['repo', f.repo.repository]]), firstPath = join(f.repo.directory, 'first.sqlite'), nextPath = join(f.repo.directory, 'next.sqlite');
  const first = await acquireRepositoryOwnership(roots, firstPath); first.close();
  assert.ok(existsSync(firstPath)); // Explicitly initialized, proven-empty reservation.
  const next = await acquireRepositoryOwnership(roots, nextPath); next.close();
  const state = new OrchestrationStore({ path: nextPath });
  state.apply({ id: 'create', goalId: 'g', expectedVersion: 0, type: 'create_goal', payload: { title: 'Unresolved worker', repositoryId: 'repo', baseSha: f.repo.baseSha } }, { kind: 'user' });
  state.apply({ id: 'launch', goalId: 'g', expectedVersion: 1, type: 'request_attempt', payload: { role: 'planner', attemptId: 'a', operationId: 'op', conversationId: 'c' } }, { kind: 'system' }); state.close();
  renameSync(nextPath, `${nextPath}.retained`);
  await assert.rejects(acquireRepositoryOwnership(roots, nextPath), { code: 'OWNERSHIP_UNCERTAIN' });
  assert.ok(existsSync(`${nextPath}.retained`));
});
test('production refuses replacement storage in a legacy database before any writable initialization', async t => {
  const f = await fixture(t), before = readFileSync(f.legacy);
  await assert.rejects(createProductionRuntime({ config: { cutover: f.cutover, storage: { database: f.legacy } }, token, sessions: async () => [] }), { code: 'CUTOVER_REQUIRED' });
  assert.deepEqual(readFileSync(f.legacy), before);
});
