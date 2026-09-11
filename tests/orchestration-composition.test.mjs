import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createRuntime } from '../server/orchestration/create-runtime.mjs';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { FakeAgents, barrier } from './helpers/orchestration/fake-agents.mjs';
import { TOKEN, create } from './helpers/orchestration/api-fixture.mjs';

async function setup(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'orchestration-composition-'));
  const agents = new FakeAgents(); let closes = 0;
  agents.close = async () => { closes++; };
  const options = {
    storage: { database: join(directory, 'state.sqlite'), artifacts: join(directory, 'artifacts'), resources: join(directory, 'resources') },
    repositories: new Map(), token: TOKEN, createAgents: () => agents,
    resolveCheck: () => { throw new Error('No checks configured'); },
    createPublisher: () => ({ publish: async () => { throw new Error('No publication configured'); } }),
    ...overrides,
  };
  const runtime = await createRuntime(options);
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  return { runtime, agents, options, closes: () => closes };
}

test('composition constructors are inert and concurrent starts acquire one scheduler', async (t) => {
  const { runtime, agents, closes } = await setup(t);
  assert.equal(runtime.scheduler.timer, null); assert.equal(runtime.stream.timer, null);
  assert.equal(agents.launches.length, 0);
  let starts = 0; const start = runtime.scheduler.start.bind(runtime.scheduler);
  runtime.scheduler.start = async () => { starts++; await start(); };
  await Promise.all([runtime.start(), runtime.start()]);
  assert.equal(starts, 1); assert.ok(runtime.scheduler.timer); assert.ok(runtime.stream.timer);
  await Promise.all([runtime.close(), runtime.close()]); assert.equal(closes(), 1);
  assert.equal(runtime.scheduler.timer, null); assert.equal(runtime.stream.timer, null);
  assert.throws(() => runtime.start(), { code: 'NOT_READY' });
});

test('occupied loopback port fails before scheduling and preserves its owner', async (t) => {
  const owner = createServer((req, res) => res.end('owner'));
  owner.listen(0, '127.0.0.1'); await once(owner, 'listening');
  t.after(() => new Promise((resolve) => owner.close(resolve)));
  const { runtime, agents, closes } = await setup(t);
  let starts = 0; runtime.scheduler.start = async () => { starts++; };
  const port = owner.address().port;
  await assert.rejects(runtime.listen({ port }), { code: 'EADDRINUSE' });
  assert.equal(starts, 0); assert.equal(agents.launches.length, 0); assert.equal(closes(), 1);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'owner');
});

test('read-only HTTP composition enforces auth and streams only public snapshots', async (t) => {
  const { runtime } = await setup(t, { readOnly: true });
  runtime.store.apply(create, { kind: 'user' });
  const address = await runtime.listen();
  assert.match(address, /^http:\/\/127\.0\.0\.1:/);
  assert.equal((await fetch(`${address}/api/orchestration/snapshot`)).status, 401);
  const headers = { authorization: `Bearer ${TOKEN}` };
  const snapshot = await (await fetch(`${address}/api/orchestration/snapshot`, { headers })).json();
  assert.equal(snapshot.readOnly, true); assert.equal(snapshot.journalId, runtime.store.journalId);
  const mutation = await fetch(`${address}/api/orchestration/commands`, { method: 'POST', headers: { ...headers, origin: address, 'content-type': 'application/json' }, body: JSON.stringify(create) });
  assert.equal(mutation.status, 403);
  const frame = await new Promise((resolve, reject) => {
    const req = request(`${address}/api/orchestration/stream`, { headers }, (res) => {
      assert.equal(res.statusCode, 200); assert.match(res.headers['content-type'], /text\/event-stream/);
      res.once('data', (data) => { resolve(data.toString()); req.destroy(); });
    }); req.on('error', reject); req.end();
  });
  assert.match(frame, /event: snapshot/); assert.ok(!frame.includes('commandId'));
  const invalid = await fetch(`${address}/api/orchestration/stream`, { headers: { ...headers, 'last-event-id': 'invalid' } });
  assert.equal(invalid.status, 400);
});

test('close joins consumer delivery and adapter cleanup before closing storage', async (t) => {
  const entered = barrier(), release = barrier(), adapterEntered = barrier(), adapterRelease = barrier();
  const { runtime, agents } = await setup(t, { consumers: [{ id: 'sink', handle: async () => { entered.release(); await release.promise; } }] });
  runtime.store.apply(create, { kind: 'user' });
  agents.close = async () => { adapterEntered.release(); await adapterRelease.promise; assert.equal(runtime.store.get('goal').id, 'goal'); };
  await runtime.start(); await entered.promise;
  let closed = false; const closing = runtime.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); assert.equal(runtime.store.get('goal').id, 'goal');
  release.release(); await adapterEntered.promise; assert.equal(closed, false);
  adapterRelease.release(); await closing; assert.equal(closed, true);
  assert.throws(() => runtime.store.get('goal'));
});

test('failed adapter close retains readable state and permits explicit retry', async (t) => {
  const { runtime, agents } = await setup(t); let closes = 0;
  agents.close = async () => { if (++closes === 1) throw new Error('still stopping'); };
  await runtime.start(); await assert.rejects(runtime.close(), /still stopping/);
  assert.equal(runtime.store.cursor(), 0);
  assert.throws(() => runtime.start(), { code: 'NOT_READY' });
  await assert.rejects(runtime.listen(), { code: 'ALREADY_RUNNING' });
  await runtime.close(); assert.equal(closes, 2); assert.throws(() => runtime.store.cursor());
});

test('closing while application readiness is pending refuses startup and cleans once', async (t) => {
  const { runtime, closes } = await setup(t); const entered = barrier(), release = barrier();
  runtime.app.ready = async () => { entered.release(); await release.promise; };
  const starting = runtime.start(); await entered.promise;
  const closing = runtime.close(); release.release();
  await assert.rejects(starting, { code: 'NOT_READY' }); await closing;
  assert.equal(closes(), 1); assert.equal(runtime.scheduler.timer, null);
});

test('failed construction disposes adapters and releases its database', async (t) => {
  const { options } = await setup(t); const agents = new FakeAgents(); let closed = false;
  agents.close = async () => { closed = true; };
  const storage = { ...options.storage, database: join(options.storage.resources, 'failed.sqlite') };
  await assert.rejects(createRuntime({ ...options, storage, createAgents: () => agents, createPublisher: () => { throw new Error('publisher unavailable'); } }), /publisher unavailable/);
  assert.equal(closed, true);
  const reopened = new OrchestrationStore({ path: storage.database }); assert.equal(reopened.cursor(), 0); reopened.close();
});

test('start cannot bypass a pending occupied-port bind and listen cannot bypass startup', async (t) => {
  const { runtime } = await setup(t); const entered = barrier(), release = barrier();
  runtime.app.listen = async () => { entered.release(); await release.promise; throw Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }); };
  let starts = 0; runtime.scheduler.start = async () => { starts++; };
  const listening = runtime.listen(); await entered.promise;
  assert.throws(() => runtime.start(), { code: 'ALREADY_RUNNING' });
  release.release(); await assert.rejects(listening, { code: 'EADDRINUSE' }); assert.equal(starts, 0);
  const second = await setup(t), ready = barrier(), proceed = barrier();
  second.runtime.app.ready = async () => { ready.release(); await proceed.promise; };
  const starting = second.runtime.start(); await ready.promise;
  await assert.rejects(second.runtime.listen(), { code: 'ALREADY_RUNNING' });
  proceed.release(); await starting;
});

test('shutdown retains exclusive ownership through adapter cleanup and failed cleanup retry', async (t) => {
  const { runtime, agents } = await setup(t); const entered = barrier(), release = barrier(); let attempts = 0;
  agents.close = async () => { entered.release(); await release.promise; if (++attempts === 1) throw new Error('cleanup failed'); };
  await runtime.start(); const closing = runtime.close(); await entered.promise;
  runtime.scheduler.ownership.assertOwned();
  release.release(); await assert.rejects(closing, /cleanup failed/);
  runtime.scheduler.ownership.assertOwned(); await runtime.close();
  assert.equal(runtime.scheduler.ownership.acquired, false);
});

test('real HTTP streaming delivers a snapshot above the socket high-water mark', async (t) => {
  const { runtime } = await setup(t);
  for (let i = 0; i < 160; i++) runtime.store.apply({ ...create, id: `create_${i}`, goalId: `goal_${i}`, payload: { ...create.payload, title: 'x'.repeat(300) } }, { kind: 'user' });
  const address = await runtime.listen();
  const snapshot = await new Promise((resolve, reject) => {
    const req = request(`${address}/api/orchestration/stream`, { headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk.toString(); if (data.includes('\n\n')) { resolve(data); req.destroy(); } });
      res.on('error', reject);
    }); req.on('error', reject); req.end();
  });
  assert.ok(Buffer.byteLength(snapshot) > 65536); assert.match(snapshot, /event: snapshot/);
  assert.equal(JSON.parse(snapshot.split('data: ')[1].split('\n\n')[0]).goals.length, 160);
});

test('close during listener binding prevents any scheduler startup', async (t) => {
  const { runtime, closes } = await setup(t); const entered = barrier(), release = barrier();
  runtime.app.listen = async () => { entered.release(); await release.promise; return 'http://127.0.0.1:12345'; };
  let starts = 0; runtime.scheduler.start = async () => { starts++; };
  const listening = runtime.listen(); await entered.promise;
  const closing = runtime.close(); release.release();
  await assert.rejects(listening, { code: 'NOT_READY' }); await closing;
  assert.equal(starts, 0); assert.equal(closes(), 1);
});
