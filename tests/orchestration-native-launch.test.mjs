import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime } from '../server/orchestration/create-runtime.mjs';
import { NativeInputs } from '../server/orchestration/adapters/native-inputs.mjs';
import { NativeBackground } from '../server/orchestration/adapters/native-background.mjs';
import { createRepositoryFixture } from './helpers/orchestration/fixture.mjs';
import { barrier } from './helpers/orchestration/fake-agents.mjs';
import { apiFixture, create, TOKEN } from './helpers/orchestration/api-fixture.mjs';

const capabilities = { restricted: true, manualPermissions: true, hooks: true, strictMcp: true, streamJson: true, permissionPromptsNone: true, terminal: true };
const policy = { ceilingMs: 10000, idleMs: 8000, maxOutputBytes: 2 * 1024 * 1024, killGraceMs: 100 };

test('queued dispatch credentials deny all agent access until identity commits, then revoke with the attempt', async (t) => {
  const { app, store, service, bridgeAuth } = await apiFixture(t);
  service.execute(create, { kind: 'user' });
  service.execute({ id: 'queue', goalId: 'goal', expectedVersion: 1, type: 'request_attempt', payload: { attemptId: 'planner', operationId: 'operation', role: 'planner', conversationId: 'conversation' } }, { kind: 'system' });
  assert.throws(() => bridgeAuth.issueForDispatch('goal', 'planner', 'operation'), { code: 'FORBIDDEN' });
  service.execute({ id: 'provision', goalId: 'goal', expectedVersion: 2, type: 'record_provision', payload: { attemptId: 'planner', worktree: '/tmp/owned', branch: 'owned', baseSha: create.payload.baseSha } }, { kind: 'system' });
  assert.throws(() => bridgeAuth.issueForDispatch('goal', 'planner', 'operation'), { code: 'FORBIDDEN' });
  store.advanceOperation('operation', 'pending', 'dispatching');
  const credential = bridgeAuth.issueForDispatch('goal', 'planner', 'operation');
  const headers = { authorization: `Bearer ${credential}` };
  assert.equal((await app.inject({ url: '/api/orchestration/agent/ready', headers })).statusCode, 409);
  assert.equal((await app.inject({ url: '/api/orchestration/agent/status', headers })).statusCode, 403);
  assert.throws(() => bridgeAuth.authenticate(credential), { code: 'FORBIDDEN' });
  service.execute({ id: 'dispatch', goalId: 'goal', expectedVersion: 3, type: 'record_dispatch', payload: { attemptId: 'planner', worktree: '/tmp/owned', branch: 'owned', identity: 'owned-process' } }, { kind: 'system' });
  assert.equal((await app.inject({ url: '/api/orchestration/agent/ready', headers })).statusCode, 409, 'missing scheduler ownership blocks activation');
  let owned = true;
  service.ownership = { assertOwned: () => { assert.ok(owned, 'ownership lost'); } };
  assert.equal((await app.inject({ url: '/api/orchestration/agent/ready', headers })).statusCode, 204);
  service.repositoryIds.delete('repo');
  assert.equal((await app.inject({ url: '/api/orchestration/agent/ready', headers })).statusCode, 403);
  service.repositoryIds.add('repo'); owned = false;
  assert.equal((await app.inject({ url: '/api/orchestration/agent/ready', headers })).statusCode, 500);
  owned = true;
  service.execute({ id: 'abort', goalId: 'goal', expectedVersion: 4, type: 'abort', payload: {} }, { kind: 'user' });
  assert.equal((await app.inject({ url: '/api/orchestration/agent/ready', headers })).statusCode, 403);
  assert.throws(() => bridgeAuth.issueForDispatch('goal', 'planner', 'operation'), { code: 'FORBIDDEN' });
});

async function nativeRuntime(t, { abort = false } = {}) {
  const f = await createRepositoryFixture(), bin = join(f.directory, 'native-fixture');
  await writeFile(bin, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const prompt = readFileSync(arg('--append-system-prompt-file'), 'utf8');
const context = JSON.parse(prompt.split('Pinned context (JSON data):\\n')[1].split('\\n\\n')[0]);
writeFileSync(process.env.FIXTURE_STARTED, 'provider started');
const { goalId, attemptId, operationId, generation, revision, role, target } = context;
const result = { schemaVersion: 1, goalId, attemptId, operationId, generation, revision, role, target, output: { schemaVersion: 1, target, disposition: 'accept', findings: [] } };
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: arg('--session-id'), result: JSON.stringify(result) }) + '\\n');
`, { mode: 0o700 });
  const entered = barrier(), release = barrier(); let driver, description, request, runtime;
  const started = join(f.directory, 'provider-started');
  try {
    runtime = await createRuntime({
      storage: { database: join(f.directory, 'state.sqlite'), artifacts: join(f.directory, 'artifacts'), resources: join(f.directory, 'resources') },
      repositories: new Map([['repo', f.repository]]), token: TOKEN,
      createAgents: ({ describe, onResult }) => {
        const inputs = new NativeInputs({ engine: { provider: 'default', model: 'fixture' }, capabilities, env: { PATH: process.env.PATH, FIXTURE_STARTED: started }, describe: (value) => { description = describe(value); return description; } });
        driver = new NativeBackground({ directory: join(f.directory, 'native'), bin, inputs, policy, onResult });
        const launch = driver.launch.bind(driver);
        driver.launch = async (value) => { request = value; const result = await launch(value); entered.release(); await release.promise; return result; };
        return driver;
      },
      resolveCheck: () => { throw new Error('No verification expected before approval'); },
      createPublisher: () => ({ publish: async () => { throw new Error('No publication expected before approval'); } }),
    });
    runtime.service.execute({ ...create, payload: { ...create.payload, baseSha: f.baseSha } }, { kind: 'user' });
    runtime.service.execute({ id: 'contract', goalId: 'goal', expectedVersion: 1, type: 'publish_contract', payload: { contract: f.contract } }, { kind: 'user' });
    const listening = runtime.listen();
    await entered.promise;
    assert.ok(description.activation.credential.length >= 32);
    assert.equal(description.bridge, undefined, 'reviewer gets no scoped MCP tool credential');
    const headers = { authorization: `Bearer ${description.activation.credential}` };
    assert.equal((await fetch(`${description.activation.endpoint}/api/orchestration/agent/ready`, { headers })).status, 409);
    assert.equal((await fetch(`${description.activation.endpoint}/api/orchestration/agent/status`, { headers })).status, 403);
    await assert.rejects(access(started), { code: 'ENOENT' });
    const operationDirectory = join(f.directory, 'native', request.operationId);
    await assert.rejects(access(join(operationDirectory, 'provider-sent.json')), { code: 'ENOENT' });
    if (abort) runtime.service.execute({ id: 'abort', goalId: 'goal', expectedVersion: runtime.store.get('goal').version, type: 'abort', payload: {} }, { kind: 'user' });
    release.release(); await listening;
    await Promise.all([...driver.active.values()].map((entry) => entry.job));
    await runtime.scheduler.tick();
    const goal = runtime.store.get('goal');
    if (abort) {
      await assert.rejects(access(started), { code: 'ENOENT' });
      await assert.rejects(access(join(operationDirectory, 'provider-sent.json')), { code: 'ENOENT' });
      assert.equal(goal.status, 'aborted'); assert.equal(goal.reviews.length, 0);
    } else {
      await access(started); assert.equal(goal.reviews.length, 1);
      assert.equal(goal.reviews[0].disposition, 'accept'); assert.equal(goal.approvedRevision, null);
      assert.ok(goal.attempts.every((attempt) => attempt.workerState === 'stopped'));
    }
    const outcome = JSON.parse(await readFile(join(operationDirectory, 'outcome.json'), 'utf8'));
    assert.equal(outcome.outcome.workerState, 'stopped');
    assert.ok(!JSON.stringify(runtime.store.snapshot()).includes(description.activation.credential));
  } finally { release.release(); if (runtime) await runtime.close(); await f.close(); }
}

test('real scheduler records dispatch before native provider starts and accepts pinned independent review', { timeout: 20000 }, async (t) => nativeRuntime(t));
test('abort during native handshake prevents provider spawn and retains stopped evidence', { timeout: 20000 }, async (t) => nativeRuntime(t, { abort: true }));

test('readiness cannot be used as authority after a proposal replaces the planner generation', async (t) => {
  const { app, planner, bridgeAuth, service, store } = await apiFixture(t);
  const credential = planner();
  service.ownership = { assertOwned() {} };
  const headers = { authorization: `Bearer ${credential}` };
  assert.equal((await app.inject({ url: '/api/orchestration/agent/ready', headers })).statusCode, 204);
  service.execute({ id: 'replace', goalId: 'goal', expectedVersion: store.get('goal').version, type: 'request_revision', payload: { message: 'Replace planning scope' } }, { kind: 'user' });
  assert.equal((await app.inject({ url: '/api/orchestration/agent/ready', headers })).statusCode, 403);
  bridgeAuth.revoke('goal', 'planner');
  assert.equal((await app.inject({ url: '/api/orchestration/agent/ready', headers })).statusCode, 401);
});
