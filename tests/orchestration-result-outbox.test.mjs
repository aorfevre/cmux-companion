import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ResultOutbox } from '../server/orchestration/result-outbox.mjs';
import { apiFixture } from './helpers/orchestration/api-fixture.mjs';
import { pinNativeRelease } from '../server/orchestration/adapters/native-handoff.mjs';
import { plannerReleasePinned } from '../updater/src/planner-retention.mjs';

const binding = { goalId: 'goal', attemptId: 'planner', generation: 1, revision: 0, operationId: 'operation', role: 'planner', target: 'contract:1:0' };
const input = { id: 'result', raw: JSON.stringify({ schemaVersion: 1, ...binding, output: { question: 'Which audience?' } }) };
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'planner-outbox-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, outbox: new ResultOutbox({ directory: join(directory, 'outbox'), binding }) };
}
test('outbox persists exact bytes before queued receipt and retries unavailable delivery with the same identity', async t => {
  const { directory, outbox } = fixture(t);
  assert.equal(outbox.enqueue(input).status, 'queued');
  writeFileSync(join(directory, 'outbox', 'interrupted.tmp'), 'partial');
  const reopened = new ResultOutbox({ directory: join(directory, 'outbox'), binding });
  assert.deepEqual(reopened.enqueue(input), { id: 'result', status: 'queued', code: null });
  assert.throws(() => reopened.enqueue({ ...input, raw: input.raw.replace('Which audience?', 'Different?') }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => reopened.enqueue({ id: 'other', raw: input.raw.replace('"goal"', '"another"') }), { code: 'FORBIDDEN' });
  const calls = [];
  for (const code of ['UPDATE_MAINTENANCE', 'REQUEST_FAILED']) await reopened.drain({ submitResult: async value => { calls.push(value); throw Object.assign(new Error('private provider detail'), { code }); } });
  assert.equal(reopened.entries()[0].value.status, 'queued');
  await reopened.drain({ submitResult: async value => { calls.push(value); return { id: value.id, status: 'accepted' }; } });
  assert.deepEqual(calls, [input, input, input]);
  await reopened.drain({ submitResult: async () => assert.fail('settled entry was replayed') });
  assert.equal(reopened.enqueue(input).status, 'accepted');
});
test('outbox preserves pending server receipts and records permanent revocation without retry loops', async t => {
  const { outbox } = fixture(t); outbox.enqueue(input);
  await outbox.drain({ submitResult: async () => ({ id: input.id, status: 'pending' }) });
  assert.equal(outbox.entries()[0].value.status, 'queued');
  await outbox.drain({ submitResult: async () => { throw Object.assign(new Error('secret'), { code: 'FORBIDDEN' }); } });
  assert.equal(outbox.entries()[0].value.status, 'rejected');
  assert.doesNotMatch(readFileSync(outbox.entries()[0].path, 'utf8'), /secret/);
});
test('outbox rejects excessive or malformed storage and result inputs', t => {
  const { outbox } = fixture(t);
  for (let n = 0; n < 8; n++) outbox.enqueue({ ...input, id: `r${n}` });
  assert.throws(() => outbox.enqueue({ ...input, id: 'ninth' }), /capacity/);
  assert.throws(() => outbox.enqueue({ ...input, raw: 'x'.repeat(2 * 1024 * 1024 + 1) }), /limit/);
  writeFileSync(outbox.entries()[0].path, 'not json');
  assert.throws(() => outbox.entries());
});
test('real authenticated result acceptance survives lost response and outbox restart exactly once', async t => {
  const { app, planner, store, results } = await apiFixture(t, { resultIntake: true });
  const credential = planner(), attempt = store.get('goal').attempts[0];
  const bound = { goalId: 'goal', attemptId: attempt.id, operationId: attempt.operationId, generation: attempt.generation, revision: attempt.revision, role: attempt.role, target: attempt.target };
  const { directory } = fixture(t), path = join(directory, 'actual');
  const queued = { id: 'question', raw: JSON.stringify({ schemaVersion: 1, ...bound, output: { question: 'Which audience?' } }) };
  const outbox = new ResultOutbox({ directory: path, binding: bound }); outbox.enqueue(queued);
  let lose = true;
  const bridge = { submitResult: async payload => {
    const response = await app.inject({ method: 'POST', url: '/api/orchestration/agent/results', headers: { authorization: `Bearer ${credential}` }, payload });
    assert.equal(response.statusCode, 202); await results.drain();
    if (lose) { lose = false; throw new Error('connection lost after commit'); }
    return response.json();
  } };
  await outbox.drain(bridge);
  const version = store.get('goal').version;
  await new ResultOutbox({ directory: path, binding: bound }).drain(bridge);
  assert.equal(store.get('goal').version, version);
  assert.equal(store.events().filter(event => event.kind === 'clarification_requested').length, 1);
  assert.equal(outbox.entries()[0].value.status, 'accepted');
});
test('release dependency pin survives arbitrarily newer releases and unknown/outbox-pending evidence', async t => {
  const { directory, outbox } = fixture(t), root = join(directory, 'deployment'), release = join(root, 'releases', 'a'.repeat(40));
  mkdirSync(release, { recursive: true });
  assert.equal(await plannerReleasePinned(root, release), false);
  assert.equal(pinNativeRelease({ directory, identity: 'terminal:operation:owner', operationId: 'operation' }, release), release);
  assert.equal(await plannerReleasePinned(root, release), true);
  writeFileSync(join(directory, 'outcome.json'), JSON.stringify({ identity: 'terminal:operation:owner', workerState: 'stopped' }));
  outbox.enqueue(input); assert.equal(await plannerReleasePinned(root, release), true);
  await outbox.drain({ submitResult: async () => ({ id: input.id, status: 'accepted' }) });
  assert.equal(await plannerReleasePinned(root, release), false);
  writeFileSync(join(root, 'planner-pins', 'operation.json'), 'malformed');
  assert.equal(await plannerReleasePinned(root, release), true);
});

test('SQLite rollback preserves original planner credential and accepts the independent queued outbox once', async t => {
  const { OrchestrationStore } = await import('../server/orchestration/storage/store.mjs');
  const { OrchestrationService } = await import('../server/orchestration/service.mjs');
  const { BridgeAuthority } = await import('../server/orchestration/bridge-auth.mjs');
  const { ArtifactStore } = await import('../server/orchestration/storage/artifacts.mjs');
  const { AgentResults } = await import('../server/orchestration/agent-results.mjs');
  const { backupData, restoreData } = await import('../updater/src/data-recovery.mjs');
  const { directory } = fixture(t), database = join(directory, 'core.sqlite');
  let store = new OrchestrationStore({ path: database });
  let service = new OrchestrationService({ store, repositoryIds: new Set(['repo']), agents: { capabilities: [{ role: 'planner', mode: 'interactive' }] } });
  const command = (id, type, payload, kind = 'system') => service.execute({ id, goalId: 'goal', expectedVersion: store.get('goal')?.version ?? 0, type, payload }, { kind });
  command('create', 'create_goal', { repositoryId: 'repo', title: 'Goal', baseSha: 'a'.repeat(40) }, 'user');
  command('launch', 'request_attempt', { attemptId: 'planner', operationId: 'operation', role: 'planner', conversationId: 'conversation' });
  command('dispatch', 'record_dispatch', { attemptId: 'planner', identity: 'terminal:operation:owner', worktree: '/fixture/worktree', branch: 'goal/planner' });
  const auth = new BridgeAuthority(store), credential = auth.issue('goal', 'planner');
  const before = store.get('goal'), attempt = before.attempts[0];
  const bound = { ...binding, target: attempt.target, generation: attempt.generation, revision: attempt.revision };
  const outbox = new ResultOutbox({ directory: join(directory, 'rollback-outbox'), binding: bound });
  const backup = await backupData({ root: join(directory, 'backups'), id: 'update', files: [database], previousSha: 'a'.repeat(40) });
  // Native supervisor writes outside rollback set while application is fenced.
  outbox.enqueue({ id: 'during-reconnect', raw: JSON.stringify({ schemaVersion: 1, ...bound, output: { question: 'Which audience?' } }) });
  store.close(); await restoreData(backup, [database]);
  store = new OrchestrationStore({ path: database });
  try {
    assert.deepEqual(store.get('goal'), before);
    service = new OrchestrationService({ store, repositoryIds: new Set(['repo']), agents: { capabilities: [{ role: 'planner', mode: 'interactive' }] } });
    const restoredAuth = new BridgeAuthority(store), results = new AgentResults({ service, artifacts: new ArtifactStore({ directory: join(directory, 'artifacts') }) });
    const bridge = { submitResult: async value => {
      const authority = restoredAuth.authenticate(credential);
      results.receive(authority, value.id, value.raw); await results.drain();
      return results.receipt(authority, value.id, value.raw);
    } };
    await outbox.drain(bridge); await outbox.drain(bridge);
    assert.equal(store.get('goal').clarification.question, 'Which audience?');
    assert.equal(store.get('goal').attempts.length, 1);
    assert.equal(store.events().filter(event => event.kind === 'clarification_requested').length, 1);
    assert.equal(outbox.entries()[0].value.status, 'accepted');
  } finally { store.close(); }
});


test('stopped worker with unconfirmed outbox retains submission authority until transport recovers', async t => {
  const { Reconciler } = await import('../server/orchestration/reconciler.mjs');
  const f = await apiFixture(t, { resultIntake: true }); const credential = f.planner();
  const attempt = f.store.get('goal').attempts[0], authority = f.bridgeAuth.authenticate(credential);
  const value = { id: 'outage-result', raw: JSON.stringify({ schemaVersion: 1, goalId: 'goal', attemptId: attempt.id, operationId: attempt.operationId,
    generation: attempt.generation, revision: attempt.revision, role: attempt.role, target: attempt.target, output: { question: 'Which audience?' } }) };
  let online = false, pendingOutbox = true;
  f.service.agents.observe = async () => {
    if (online && pendingOutbox) { f.results.receive(authority, value.id, value.raw); }
    return { status: 'stopped', identity: attempt.identity, pendingOutbox };
  };
  const reconciler = new Reconciler({ service: f.service, ownership: { assertOwned() {} }, results: f.results });
  await reconciler.observe('goal', attempt.id);
  assert.equal(f.store.get('goal').attempts[0].status, 'running');
  assert.equal(f.bridgeAuth.authenticate(credential).attemptId, attempt.id);
  online = true; await reconciler.observe('goal', attempt.id);
  assert.equal(f.store.get('goal').clarification.question, 'Which audience?');
  pendingOutbox = false; await reconciler.observe('goal', attempt.id);
  assert.equal(f.store.get('goal').attempts[0].workerState, 'stopped');
  assert.equal(f.store.events().filter(event => event.kind === 'clarification_requested').length, 1);
});
