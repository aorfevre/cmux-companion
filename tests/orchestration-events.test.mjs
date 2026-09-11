import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { JournalConsumer } from '../server/orchestration/event-consumers.mjs';
import { EventStream } from '../server/orchestration/event-stream.mjs';
import { barrier } from './helpers/orchestration/fake-agents.mjs';

const create = (store, id) => store.apply({ id: `create_${id}`, goalId: id, expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: id, baseSha: 'a'.repeat(40) } }, { kind: 'user' });
const abort = (store, id) => store.apply({ id: `abort_${id}`, goalId: id, expectedVersion: store.get(id).version, type: 'abort', payload: {} }, { kind: 'user' });
const flush = () => new Promise((resolve) => setImmediate(resolve));
class Response extends EventEmitter {
  constructor(write = () => true) { super(); this.frames = []; this.writer = write; this.destroyed = false; }
  write(frame) { this.frames.push(frame); return this.writer(frame); }
  destroy() { this.destroyed = true; this.emit('close'); }
}

test('consumer reopens after lost wakeup and deduplicates delivery before acknowledgement loss', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'orchestration-events-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite'); let store = new OrchestrationStore({ path });
  store.failpoint = (point) => { if (point === 'before_notify') throw new Error('lost wakeup'); };
  create(store, 'g'); const journalId = store.journalId; store.close();
  store = new OrchestrationStore({ path });
  const effects = new Set(), attempts = [], errors = [];
  const handle = async (event, { idempotencyKey }) => {
    assert.equal(event.goalId, 'g'); attempts.push(idempotencyKey);
    if (!effects.has(idempotencyKey)) { effects.add(idempotencyKey); throw new Error('delivered before process loss'); }
  };
  const first = new JournalConsumer({ store, id: 'notifications', handle, onError: (error) => errors.push(error) });
  await first.start(); assert.equal(first.cursor, 0); await first.stop(); store.close();
  store = new OrchestrationStore({ path });
  const second = new JournalConsumer({ store, id: 'notifications', handle });
  await second.start(); await second.stop();
  assert.equal(store.journalId, journalId); assert.equal(second.cursor, 1);
  assert.equal(effects.size, 1); assert.equal(attempts.length, 2); assert.equal(errors.length, 1);
  const other = new OrchestrationStore({ path: ':memory:' }); assert.notEqual(other.journalId, journalId); other.close(); store.close();
});

test('consumer wakeups during a sweep are retained and stop joins in-flight delivery', async () => {
  const store = new OrchestrationStore({ path: ':memory:' }), entered = barrier(), release = barrier(), delivered = [];
  create(store, 'first');
  const consumer = new JournalConsumer({ store, id: 'sink', batchSize: 1, handle: async (event) => {
    if (event.goalId === 'first') { entered.release(); await release.promise; }
    delivered.push(event.goalId);
  } });
  store.onCommit = () => consumer.wake();
  const started = consumer.start(); await entered.promise; create(store, 'second');
  release.release(); await started;
  assert.deepEqual(delivered, ['first', 'second']); assert.equal(consumer.cursor, 2);
  await consumer.stop(); store.close();

  const next = new OrchestrationStore({ path: ':memory:' }), active = barrier(), finish = barrier();
  create(next, 'first'); create(next, 'second');
  const joined = new JournalConsumer({ store: next, id: 'sink', handle: async () => { active.release(); await finish.promise; } });
  const starting = joined.start(); await active.promise;
  let stopped = false; const stopping = joined.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  finish.release(); await Promise.all([starting, stopping]);
  assert.equal(joined.cursor, 1); next.close();
});

test('consumer retention preserves unread events and handlers receive no private payload', async () => {
  const store = new OrchestrationStore({ path: ':memory:' }); create(store, 'g'); abort(store, 'g');
  store.db.prepare('UPDATE events SET payload=?,command_id=? WHERE id=1').run(JSON.stringify({ token: 'private-context' }), 'private-context');
  const seen = [], errors = [];
  let fail = true;
  const consumer = new JournalConsumer({ store, id: 'sink', handle: async (event) => { seen.push(event); if (fail) throw new Error('offline'); }, onError: (error) => { errors.push(error); throw new Error('telemetry also fails'); } });
  await consumer.start();
  assert.equal(store.pruneEvents(2), 0); assert.equal(consumer.cursor, 0);
  fail = false; await consumer.tick(); assert.equal(consumer.cursor, 2);
  assert.equal(store.pruneEvents(2), 2);
  assert.ok(!JSON.stringify(seen).includes('private-context')); assert.equal(errors.length, 1);
  await consumer.stop(); store.close();
});

test('consumer sweep work is bounded and remaining journal work stays retryable', async () => {
  const store = new OrchestrationStore({ path: ':memory:' });
  for (let index = 0; index < 501; index++) create(store, `g${index}`);
  let count = 0;
  const consumer = new JournalConsumer({ store, id: 'sink', handle: () => { count++; } });
  await consumer.start(); assert.equal(count, 500);
  await consumer.tick(); assert.equal(count, 501); assert.equal(consumer.cursor, 501);
  await consumer.stop(); store.close();
});

test('stream snapshot and cursor replay have no wakeup gap and expose only public invalidations', async () => {
  const store = new OrchestrationStore({ path: ':memory:' }); create(store, 'first');
  const stream = new EventStream({ store }); stream.start(); store.onCommit = () => stream.wake();
  let changed = false;
  const response = new Response((frame) => { if (!changed && frame.includes('event: snapshot')) { changed = true; create(store, 'second'); } return true; });
  stream.attach(response, stream.prepare()); await flush();
  assert.match(response.frames[0], /event: snapshot/);
  assert.match(response.frames[0], /"cursor":1/); assert.ok(!response.frames[0].includes('"id":"second"'));
  assert.match(response.frames[1], /event: events/); assert.match(response.frames[1], /"goalId":"second"/);
  response.destroy();
  const resumed = new Response(); stream.attach(resumed, stream.prepare(`${store.journalId}:1`)); await flush();
  assert.match(resumed.frames.join(''), /"goalId":"second"/);
  assert.ok(!resumed.frames.join('').includes('payload'));
  assert.ok(!resumed.frames.join('').includes('commandId'));
  stream.close(); assert.equal(stream.clients.size, 0); assert.equal(resumed.destroyed, true); store.close();
});

test('expired or foreign stream cursors explicitly resync and slow clients cannot pin retention', async () => {
  const store = new OrchestrationStore({ path: ':memory:' }); create(store, 'g'); abort(store, 'g');
  store.registerConsumer('sink'); store.acknowledge('sink', 2); store.pruneEvents(2);
  const stream = new EventStream({ store, maxClients: 1 }); stream.start();
  assert.equal(stream.prepare(`${store.journalId}:0`).kind, 'resync');
  assert.equal(stream.prepare('old-journal:2').kind, 'resync');
  assert.throws(() => stream.prepare(`${store.journalId}:3`));
  assert.throws(() => stream.prepare('invalid'));
  const slow = new Response(() => false); stream.attach(slow, stream.prepare());
  assert.equal(slow.destroyed, false); assert.equal(stream.clients.size, 1);
  assert.throws(() => stream.prepare(), { code: 'CAPACITY_FULL' });
  slow.emit('drain'); slow.destroy(); assert.equal(stream.clients.size, 0);
  const live = new Response(); stream.attach(live, stream.prepare());
  assert.throws(() => stream.prepare(), { code: 'CAPACITY_FULL' });
  stream.close(); assert.equal(live.destroyed, true);
  assert.equal(stream.timer, null); assert.equal(stream.heartbeat, null);
  assert.throws(() => stream.prepare(), { code: 'NOT_READY' });
  store.close();
});

test('stream pauses accepted frames until drain and bounds stalled clients without replay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new OrchestrationStore({ path: ':memory:' }); create(store, 'first');
  const stream = new EventStream({ store, drainMs: 10 }); stream.start(); store.onCommit = () => stream.wake();
  const slow = new Response(() => false); stream.attach(slow, stream.prepare());
  create(store, 'second'); await flush(); assert.equal(slow.frames.length, 1);
  slow.writer = () => true; slow.emit('drain'); await flush();
  assert.equal(slow.frames.length, 2); assert.match(slow.frames[1], /"goalId":"second"/);
  assert.ok(!slow.frames[1].includes('"goalId":"first"'));
  t.mock.timers.tick(10); assert.equal(slow.destroyed, false);
  const stalled = new Response(() => false); stream.attach(stalled, stream.prepare());
  t.mock.timers.tick(10); assert.equal(stalled.destroyed, true); assert.equal(stalled.listenerCount('drain'), 0);
  stream.close(); store.close();
});

test('stream contains throwing writers and telemetry, and rejects oversized frames', () => {
  const store = new OrchestrationStore({ path: ':memory:' }); create(store, 'first');
  const errors = []; const stream = new EventStream({ store, onError: (error) => { errors.push(error); throw new Error('telemetry failed'); } }); stream.start();
  const broken = new Response(() => { throw new Error('socket failed'); }); stream.attach(broken, stream.prepare());
  assert.equal(broken.destroyed, true); assert.equal(errors.length, 1); assert.equal(stream.clients.size, 0);
  stream.close();
  const small = new EventStream({ store, maxFrameBytes: 20 }); small.start();
  const response = new Response(); small.attach(response, small.prepare());
  assert.equal(response.destroyed, true); assert.equal(response.frames.length, 0);
  small.close(); store.close();
});
