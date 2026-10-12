import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'conversation-restart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = phase => {
    const child = spawnSync(process.execPath, ['tests/helpers/orchestration/conversation-restart-child.mjs', directory, phase], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.error, undefined);
    if (phase === 'seed') { assert.equal(child.signal, 'SIGKILL', child.stderr); return; }
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  run('seed');
  const checkpoint = JSON.parse(readFileSync(join(directory, 'checkpoint.json'), 'utf8'));
  const trace = () => readFileSync(join(directory, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { run, checkpoint, trace };
}

test('service process restart retains conversation, exact receipts, approval and pending dispatch before resuming', t => {
  const f = fixture(t), saved = f.checkpoint.goal;
  for (let restart = 0; restart < 2; restart++) {
    const state = f.run('inspect');
    assert.equal(state.journalId, f.checkpoint.journalId);
    assert.deepEqual(state.goal, saved, 'paused restart and exact message replay cannot change the conversation or approval');
    assert.deepEqual(state.operations, f.checkpoint.operations);
    assert.equal(state.capacity.total, 1);
    assert.equal(f.trace().filter(event => event.kind === 'launch').length, 1);
  }
  const resumed = f.run('resume');
  assert.equal(resumed.goal.conversation.supervisorAttemptId, saved.conversation.supervisorAttemptId);
  assert.deepEqual(resumed.goal.attempts[0], saved.attempts[0]);
  assert.deepEqual(resumed.goal.contracts, saved.contracts);
  assert.equal(resumed.goal.approvedRevision, 1);
  const messages = resumed.goal.conversation.messages.filter(message => message.id === 'queued-steering');
  assert.equal(messages.length, 1); assert.equal(messages[0].delivery, 'answered');
  assert.equal(resumed.goal.attempts.find(attempt => attempt.id === 'worker').workerState, 'running');
  const events = f.trace(), launches = events.filter(event => event.kind === 'launch');
  assert.deepEqual(launches.map(event => event.role), ['planner', 'implementer']);
  const workerIndex = events.findIndex(event => event.kind === 'launch' && event.role === 'implementer');
  assert.ok(events.slice(1, workerIndex).some(event => event.phase === 'resume' && event.kind === 'observe' && event.operationId === launches[0].operationId), 'supervisor ownership is reconciled before pending worker admission');
  const restarted = f.run('inspect');
  assert.deepEqual(restarted.goal.conversation, resumed.goal.conversation);
  assert.equal(f.trace().filter(event => event.kind === 'launch').length, 2, 'another restart cannot duplicate either worker');
});

test('unknown supervisor on service restart retains queued input and holds pending work without a replacement launch', t => {
  const f = fixture(t), state = f.run('unknown');
  assert.equal(state.goal.conversation.supervisorAttemptId, f.checkpoint.goal.conversation.supervisorAttemptId);
  assert.deepEqual(state.goal.conversation.messages, f.checkpoint.goal.conversation.messages);
  assert.equal(state.goal.attempts[0].workerState, 'unknown');
  assert.ok(state.goal.hold);
  assert.equal(state.goal.attempts.find(attempt => attempt.id === 'worker').workerState, 'pending');
  assert.equal(f.trace().filter(event => event.kind === 'launch').length, 1);
});
