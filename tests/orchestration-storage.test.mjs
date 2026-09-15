import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { ArtifactStore } from '../server/orchestration/storage/artifacts.mjs';
import { OrchestrationService } from '../server/orchestration/service.mjs';
import { BASE } from './helpers/orchestration/domain-fixture.mjs';

const USER = { kind: 'user' }, SYSTEM = { kind: 'system' };
const create = { id: 'create', goalId: 'goal', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'Build safely', baseSha: BASE } };
const launch = { id: 'launch', goalId: 'goal', expectedVersion: 1, type: 'request_attempt', payload: { attemptId: 'planner', operationId: 'launch_planner', role: 'planner', conversationId: 'conversation' } };
const abort = (version) => ({ id: 'abort', goalId: 'goal', expectedVersion: version, type: 'abort', payload: {} });
function temp(t) {
  const directory = mkdtempSync(join(tmpdir(), 'orchestration-storage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function store(t, options = {}) { const result = new OrchestrationStore({ path: ':memory:', ...options }); t.after(() => result.close()); return result; }

test('commands persist across reopen with stable receipts and queryable operation intent', (t) => {
  const path = join(temp(t), 'state.sqlite');
  const first = new OrchestrationStore({ path }); first.apply(create, USER);
  const expected = first.apply(launch, SYSTEM); first.close();
  const reopened = store(t, { path });
  assert.deepEqual(reopened.apply(launch, SYSTEM), expected);
  assert.equal(reopened.get('goal').attempts.length, 1);
  assert.equal(reopened.operations().length, 1);
  assert.equal(reopened.events().length, 2);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(reopened.get('missing'), null);
});

test('receipt conflicts reject changed input and changed authority, even before version checks', (t) => {
  const db = store(t); db.apply(create, USER); db.apply(launch, SYSTEM);
  assert.throws(() => db.apply({ ...launch, payload: { ...launch.payload, conversationId: 'other' } }, SYSTEM), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => db.apply(launch, USER), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(db.get('goal').version, 2);
});

for (const point of ['before_write', 'after_state', 'after_events', 'before_commit']) {
  test(`fault at ${point} rolls back state, indexed attempts, events, receipts and dispatch intent`, (t) => {
    let fail = false, notifications = 0;
    const db = store(t, { failpoint: (at) => { if (fail && at === point) throw new Error(point); }, onCommit: () => notifications++ });
    db.apply(create, USER); fail = true;
    assert.throws(() => db.apply(launch, SYSTEM), new RegExp(point));
    assert.equal(db.get('goal').version, 1); assert.deepEqual(db.get('goal').attempts, []);
    assert.equal(db.db.prepare('SELECT count(*) AS n FROM attempts').get().n, 0);
    assert.equal(db.events().length, 1); assert.deepEqual(db.operations(), []); assert.equal(notifications, 1);
    fail = false; db.apply(launch, SYSTEM); assert.equal(db.operations().length, 1);
  });
}

test('lost response after commit replays the receipt without another mutation', (t) => {
  let crash = false;
  const db = store(t, { failpoint: (point) => { if (crash && point === 'after_commit') throw new Error('response lost'); } });
  db.apply(create, USER); crash = true;
  assert.throws(() => db.apply(launch, SYSTEM), /response lost/);
  const replay = db.apply(launch, SYSTEM);
  assert.equal(replay.goal.version, 2); assert.equal(db.operations().length, 1); assert.equal(db.cursor(), 2);
});

test('notification failure cannot report a committed command as rolled back', (t) => {
  let errors = 0;
  const db = store(t, { onCommit: () => { throw new Error('subscriber'); }, onNotificationError: () => { errors++; throw new Error('logger'); } });
  assert.equal(db.apply(create, USER).goal.version, 1); assert.equal(errors, 1);
});

test('unsupported adapter modes fail inside the decision boundary before any intent or state write', (t) => {
  const db = store(t), service = new OrchestrationService({ store: db, repositoryIds: new Set(['repo']), agents: { capabilities: [] } });
  service.execute(create, USER);
  assert.throws(() => service.execute(launch, SYSTEM), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.equal(db.cursor(), 1); assert.deepEqual(db.operations(), []);
  const supported = new OrchestrationService({ store: db, repositoryIds: new Set(['repo']), agents: { capabilities: [{ role: 'planner', mode: 'interactive' }] } });
  supported.execute(launch, SYSTEM); assert.equal(db.operations().length, 1);
});

test('replay validates current agent authority before disclosing a prior receipt', (t) => {
  const db = store(t); db.apply(create, USER); db.apply(launch, SYSTEM);
  db.apply({ id: 'dispatch', goalId: 'goal', expectedVersion: 2, type: 'record_dispatch', payload: { attemptId: 'planner', identity: 'process', worktree: '/tmp/private', branch: 'goal' } }, SYSTEM);
  const agent = { kind: 'agent', goalId: 'goal', generation: 1, revision: 0, attemptId: 'planner', role: 'planner' };
  // Unknown commands are still subject to authority before receipt/version lookup.
  db.apply(abort(3), USER);
  assert.throws(() => db.apply({ ...launch, expectedVersion: 999 }, agent), { code: 'FORBIDDEN' });
});

test('snapshot cursor and journal pagination expose no event twice', (t) => {
  const db = store(t); db.apply(create, USER); const snapshot = db.snapshot(); db.apply(launch, SYSTEM);
  assert.equal(snapshot.goals[0].version, 1); assert.equal(snapshot.cursor, 1);
  const later = db.events({ since: snapshot.cursor }); assert.equal(later.length, 1); assert.equal(later[0].kind, 'attempt_queued');
  assert.equal(db.events({ since: later[0].id }).length, 0);
  assert.equal(db.events({ goalId: 'other' }).length, 0);
  assert.throws(() => db.events({ since: -1 })); assert.throws(() => db.events({ limit: 501 }));
});

test('consumer cursors survive reopen and retention protects active goals and lagging consumers', (t) => {
  const db = store(t); db.registerConsumer('push'); db.apply(create, USER);
  assert.equal(db.pruneEvents(999), 0);
  db.acknowledge('push', db.cursor()); assert.equal(db.pruneEvents(999), 0, 'active goal evidence is retained');
  db.apply(abort(1), USER); assert.equal(db.pruneEvents(999), 1, 'only acknowledged terminal prefix is removed');
  assert.throws(() => db.events({ since: 0 }), { code: 'CURSOR_EXPIRED' });
  assert.throws(() => db.registerConsumer('new', 0), { code: 'CURSOR_EXPIRED' });
  const snapshot = db.snapshot(); assert.equal(snapshot.cursor, 2); db.registerConsumer('new', snapshot.cursor);
  db.acknowledge('push', 2); assert.equal(db.pruneEvents(999), 1);
  assert.deepEqual(db.events({ since: 2 }), []);
  assert.throws(() => db.acknowledge('push', 1)); assert.throws(() => db.acknowledge('push', 3));
});

test('unknown database versions and implicit data paths fail closed', (t) => {
  assert.throws(() => new OrchestrationStore({ path: '' }));
  const path = join(temp(t), 'future.sqlite'); const raw = new DatabaseSync(path); raw.exec('PRAGMA user_version = 42'); raw.close();
  assert.throws(() => new OrchestrationStore({ path }), /Unsupported/);
  assert.throws(() => store(t).apply(launch, SYSTEM), { code: 'FORBIDDEN' });
});

test('artifact bytes are immutable by digest, private, size-bounded and retained by references', (t) => {
  const directory = temp(t), artifacts = new ArtifactStore({ directory, maxBytes: 64 });
  const result = artifacts.put('verified output');
  assert.equal(artifacts.put('verified output').id, result.id);
  assert.equal(artifacts.get(result.id).toString(), 'verified output');
  assert.equal(statSync(artifacts.path(result.id)).mode & 0o777, 0o600);
  assert.throws(() => artifacts.put('x'.repeat(65))); assert.throws(() => artifacts.get('../secret'));
  assert.deepEqual(artifacts.pruneUnreferenced(new Set([result.id]), Date.now() + 1000), []);
  assert.deepEqual(artifacts.pruneUnreferenced(new Set(), 0), []);
  writeFileSync(artifacts.path(result.id), 'corrupted');
  assert.throws(() => artifacts.get(result.id), /integrity/);
  assert.equal(readFileSync(artifacts.path(result.id), 'utf8'), 'corrupted');
  assert.deepEqual(artifacts.pruneUnreferenced(new Set(), Date.now() + 1000), [result.id]);
});

test('successful agent result replays for its owner but new mutations and revoked generations remain forbidden', (t) => {
  const db = store(t); db.apply(create, USER);
  const c = { schemaVersion: 1, outcome: 'Test', scope: ['test'], exclusions: [], criteria: [{ id: 'c', text: 'Works', verification: 'unit' }], verification: [{ id: 'unit', argv: ['node', '--test'] }], tasks: [{ id: 'a', title: 'Task', prompt: 'Implement', dependsOn: [], ownedAreas: ['src'], criterionIds: ['c'] }] };
  db.apply({ id: 'contract', goalId: 'goal', expectedVersion: 1, type: 'publish_contract', payload: { contract: c } }, USER);
  db.apply({ ...launch, expectedVersion: 2, payload: { ...launch.payload, role: 'reviewer' } }, SYSTEM);
  db.apply({ id: 'dispatch', goalId: 'goal', expectedVersion: 3, type: 'record_dispatch', payload: { attemptId: 'planner', identity: 'review', worktree: '/tmp/review', branch: 'review' } }, SYSTEM);
  const authority = { kind: 'agent', goalId: 'goal', generation: 2, revision: 1, attemptId: 'planner', role: 'reviewer' };
  const command = { id: 'result', goalId: 'goal', expectedVersion: 4, type: 'record_review', payload: { attemptId: 'planner', reviewId: 'review', review: { schemaVersion: 1, target: 'contract:2:1', disposition: 'accept', findings: [] } } };
  const saved = db.apply(command, authority); assert.deepEqual(db.apply(command, authority), saved);
  assert.throws(() => db.apply({ ...command, id: 'second', expectedVersion: 5 }, authority), { code: 'FORBIDDEN' });
  db.apply(abort(5), USER);
  assert.throws(() => db.apply(command, authority), { code: 'FORBIDDEN' });
});

test('existing consumer restarts from its durable cursor after history is pruned', (t) => {
  const path = join(temp(t), 'consumer.sqlite'); let db = new OrchestrationStore({ path });
  db.registerConsumer('push'); db.apply(create, USER); db.apply(abort(1), USER);
  db.acknowledge('push', 2); db.pruneEvents(2); db.close();
  db = store(t, { path }); assert.equal(db.registerConsumer('push'), 2);
});

test('SQLite database and sidecars are private before state is written', (t) => {
  const path = join(temp(t), 'permissions.sqlite'); const db = store(t, { path });
  db.apply(create, USER);
  for (const suffix of ['', '-wal', '-shm']) assert.equal(statSync(`${path}${suffix}`).mode & 0o777, 0o600, suffix || 'database');
});

test('withdrawing a repository prevents new work while preserving abort and reconciliation', (t) => {
  const db = store(t); db.apply(create, USER);
  const agents = { capabilities: [{ role: 'planner', mode: 'interactive' }] };
  const denied = new OrchestrationService({ store: db, agents, repositoryIds: new Set() });
  assert.throws(() => denied.execute(launch, SYSTEM), { code: 'FORBIDDEN' });
  assert.deepEqual(db.operations(), []); assert.equal(db.get('goal').version, 1);
  const allowed = new OrchestrationService({ store: db, agents, repositoryIds: new Set(['repo']) });
  allowed.execute(launch, SYSTEM);
  allowed.execute({ id: 'dispatch', goalId: 'goal', expectedVersion: 2, type: 'record_dispatch', payload: { attemptId: 'planner', identity: 'process', worktree: '/tmp/owned', branch: 'branch' } }, SYSTEM);
  const stopped = denied.execute(abort(3), USER);
  assert.equal(stopped.goal.status, 'aborted');
  assert.equal(db.operations().find((operation) => operation.id === 'abort_planner')?.kind, 'terminate');
});

test('activity metadata survives restart and reports retention without inventing missing history', t => {
  const path = join(temp(t), 'activity.sqlite');
  const first = new OrchestrationStore({ path, now: () => '2026-09-15T12:00:00Z' });
  first.apply(create, USER); const expected = first.activity('goal'); first.close();
  const reopened = store(t, { path }); assert.deepEqual(reopened.activity('goal'), expected);
  assert.equal(expected.events[0].createdAt, '2026-09-15T12:00:00Z'); assert.equal(expected.historyPruned, false);
  assert.throws(() => reopened.activity('goal', { limit: 101 }));
  reopened.db.exec('DELETE FROM events; UPDATE journal_meta SET floor=1');
  assert.deepEqual(reopened.activity('goal'), { events: [], nextBefore: null, historyPruned: true });
});
