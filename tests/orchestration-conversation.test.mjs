import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { BridgeAuthority } from '../server/orchestration/bridge-auth.mjs';
import { readyWork } from '../server/orchestration/domain/scheduling.mjs';
import { goalView } from '../server/orchestration/domain/state-view.mjs';
import { contract, BASE } from './helpers/orchestration/domain-fixture.mjs';

function fixture(t, path = ':memory:', experienceVersion = 2) {
  const store = new OrchestrationStore({ path });
  t.after(() => store.close());
  const user = { kind: 'user' }, system = { kind: 'system' };
  let next = 0;
  const make = (type, payload = {}) => ({ id: `c${++next}`, goalId: 'g', expectedVersion: store.get('g')?.version ?? 0, type, payload });
  const command = (type, payload = {}, authority = user) => store.apply(make(type, payload), authority);
  command('create_goal', { repositoryId: 'repo', title: 'Fix the modules', baseSha: BASE, ...(experienceVersion ? { experienceVersion } : {}) });
  command('request_attempt', { attemptId: 'supervisor', operationId: 'launch', role: 'planner', conversationId: 'native-conversation' }, system);
  command('record_dispatch', { attemptId: 'supervisor', identity: 'owned-supervisor', worktree: '/tmp/supervisor', branch: 'goal/planning' }, system);
  const authority = { kind: 'agent', goalId: 'g', attemptId: 'supervisor', role: 'planner', generation: 1, revision: 0 };
  const auth = new BridgeAuthority(store), token = auth.issue('g', 'supervisor');
  return { store, user, system, command, make, authority, auth, token, get goal() { return store.get('g'); } };
}

test('questions, delivery and replies preserve the same native supervisor and generation', t => {
  const f = fixture(t), initial = f.goal;
  const question = f.command('supervisor_question', { message: 'Which behavior should change?', replyTo: 1 }, f.authority);
  assert.deepEqual(question.goal.attempts, initial.attempts);
  assert.equal(question.goal.generation, initial.generation);
  assert.equal(f.store.operations().filter(op => op.kind === 'terminate').length, 0);
  const answer = f.make('send_goal_message', { message: 'Only the first module.' });
  f.store.apply(answer, f.user);
  f.command('supervisor_ack', { through: 3 }, f.authority);
  assert.equal(f.goal.conversation.messages[2].delivery, 'delivered');
  f.command('supervisor_reply', { message: 'I will keep the other modules unchanged.', replyTo: 3 }, f.authority);
  assert.equal(f.goal.conversation.messages[2].delivery, 'answered');
  f.store.apply(answer, f.user);
  assert.equal(f.goal.conversation.messages.length, 4, 'lost response replay cannot send another message');
  assert.deepEqual(readyWork(f.goal), [], 'the question does not enqueue a replacement planner');
  assert.deepEqual(f.auth.authenticate(f.token), f.authority);
});

test('supervisor survives proposal and approval but cannot approve or execute through legacy commands', t => {
  const f = fixture(t);
  f.command('set_plan_review_policy', { enabled: false }, f.system);
  f.command('supervisor_propose', { contract: contract() }, f.authority);
  assert.equal(f.goal.revision, 1);
  assert.equal(f.goal.conversation.supervisorAttemptId, 'supervisor');
  assert.equal(f.store.operations().filter(op => op.kind === 'terminate').length, 0);
  assert.deepEqual(f.auth.authenticate(f.token), f.authority, 'scoped conversation identity survives revision');
  assert.deepEqual(f.auth.ready(f.token), f.authority, 'native readiness survives revision');
  for (const type of ['approve', 'publish_contract', 'request_attempt', 'request_clarification']) {
    assert.throws(() => f.command(type, { revision: 1, contract: contract() }, f.authority), { code: 'FORBIDDEN' });
  }
  f.command('approve', { revision: 1 });
  assert.deepEqual(readyWork(f.goal), [], 'approval alone does not impersonate supervisor dispatch');
  f.command('supervisor_dispatch', {}, f.authority);
  assert.deepEqual(readyWork(f.goal).map(work => work.taskId), ['A', 'B']);
  f.command('supervisor_revise', { message: 'The requested scope changed.' }, f.authority);
  assert.equal(f.goal.approvedRevision, null);
  assert.equal(f.goal.conversation.dispatchApproved, false);
  assert.equal(f.goal.attempts[0].workerState, 'running');
  assert.throws(() => f.command('supervisor_dispatch', {}, f.authority), { code: 'NOT_READY' });
});

test('only the recorded supervisor can use conversation tools; abort revokes it', t => {
  const f = fixture(t);
  assert.throws(() => f.command('supervisor_reply', { message: 'Spoofed' }), { code: 'FORBIDDEN' });
  assert.throws(() => f.command('supervisor_question', { message: 'Spoofed' }, { ...f.authority, generation: 2 }), { code: 'FORBIDDEN' });
  assert.throws(() => f.command('send_goal_message', { message: 'Spoofed user' }, f.authority), { code: 'FORBIDDEN' });
  assert.throws(() => f.command('supervisor_reply', { message: 'Answer', replyTo: 99 }, f.authority));
  f.command('abort');
  assert.equal(f.store.operations().filter(op => op.kind === 'terminate').length, 1);
  assert.throws(() => f.auth.authenticate(f.token), { code: 'FORBIDDEN' });
});

test('waiting is event-driven, acknowledgements do not generate wakes, and pause stops admission', t => {
  const f = fixture(t), wake = f.goal.conversation.wake;
  f.command('supervisor_ack', { through: 1 }, f.authority);
  f.command('supervisor_wait', { throughWake: wake }, f.authority);
  assert.equal(f.goal.conversation.wake, wake);
  assert.equal(f.goal.conversation.waiting, true);
  f.command('send_goal_message', { message: 'Additional context' });
  assert.equal(f.goal.conversation.waiting, false);
  assert.equal(f.goal.conversation.wake, wake + 1);
  assert.throws(() => f.command('supervisor_wait', { throughWake: wake + 2 }, f.authority), { code: 'STALE_TARGET' });
  f.command('pause_goal');
  assert.equal(goalView(f.goal).conversation.paused, true);
  assert.deepEqual(readyWork(f.goal), []);
  assert.throws(() => f.command('supervisor_propose', { contract: contract() }, f.authority), { code: 'NOT_READY' });
  f.command('send_goal_message', { message: 'Retain this while paused.' });
  f.command('resume_goal');
  assert.equal(f.goal.conversation.paused, false);
  assert.equal(f.goal.conversation.messages.at(-2).delivery, 'queued');
});

test('restart preserves exact messages, acknowledgements and supervisor credentials', t => {
  const directory = mkdtempSync(join(tmpdir(), 'goals-conversation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'journal.sqlite'), f = fixture(t, path);
  f.command('send_goal_message', { message: 'Continue after restart.' });
  f.command('supervisor_ack', { through: 2 }, f.authority);
  const reopened = new OrchestrationStore({ path }); t.after(() => reopened.close());
  assert.deepEqual(reopened.get('g'), f.goal);
  assert.deepEqual(new BridgeAuthority(reopened).authenticate(f.token), f.authority);
  assert.deepEqual(readyWork(reopened.get('g')), [], 'restart does not replace an owned supervisor');
});

test('legacy planning retains its original revoke-and-replace contract', t => {
  const legacy = fixture(t, ':memory:', null);
  legacy.command('request_clarification', { question: 'Legacy question?' }, legacy.authority);
  assert.equal(legacy.goal.generation, 2);
  assert.equal(legacy.goal.conversation, undefined);
  assert.equal(legacy.store.operations().filter(op => op.kind === 'terminate').length, 1);
  assert.throws(() => legacy.command('send_goal_message', { message: 'Not supported' }), { code: 'NOT_READY' });
});

test('uncertain supervisor blocks recovery; confirmed stop and recovery allow exactly one replacement', t => {
  const f = fixture(t);
  f.command('supervisor_propose', { contract: contract() }, f.authority);
  f.command('record_failure', { attemptId: 'supervisor', uncertain: true, error: 'Lost identity' }, f.system);
  assert.equal(f.goal.hold.reasons[0].target, 'supervisor');
  assert.throws(() => f.command('recover_goal', { holdId: f.goal.hold.id }), { code: 'OWNERSHIP_UNCERTAIN' });
  assert.deepEqual(readyWork(f.goal), []);
  assert.throws(() => f.auth.authenticate(f.token), { code: 'FORBIDDEN' });
  f.command('record_stopped', { attemptId: 'supervisor' }, f.system);
  assert.deepEqual(readyWork(f.goal), [], 'stopped evidence alone does not authorize replacement');
  f.command('recover_goal', { holdId: f.goal.hold.id });
  assert.ok(readyWork(f.goal).some(work => work.role === 'planner'));
  f.command('request_attempt', { attemptId: 'replacement', operationId: 'replacement_launch', role: 'planner', conversationId: 'replacement_native' }, f.system);
  assert.equal(f.goal.conversation.supervisorAttemptId, 'replacement');
  assert.match(f.goal.conversation.messages.at(-1).text, /saved conversation/);
  assert.ok(!readyWork(f.goal).some(work => work.role === 'planner'));
  assert.throws(() => f.auth.authenticate(f.token), { code: 'FORBIDDEN' });
});

test('user cannot impersonate supervisor proposal and unknown supervisor cannot be ignored by approval barriers', t => {
  const f = fixture(t);
  assert.throws(() => f.command('supervisor_propose', { contract: contract() }), { code: 'FORBIDDEN' });
  f.command('set_plan_review_policy', { enabled: false }, f.system);
  f.command('supervisor_propose', { contract: contract() }, f.authority);
  f.command('record_failure', { attemptId: 'supervisor', uncertain: true, error: 'Lost identity' }, f.system);
  assert.equal(goalView(f.goal).actions.some(action => action.type === 'approve'), false);
  assert.throws(() => f.auth.ready(f.token), { code: 'FORBIDDEN' });
});

function simpleProposal() {
  const { tasks, ...proposal } = contract();
  return { ...proposal, schemaVersion: 2, implementation: { title: 'Implement the outcome', prompt: 'Build and check the modules within the approved scope.', ownedAreas: tasks.flatMap(task => task.ownedAreas) } };
}

test('ordinary proposals persist one owned implementation and all checks before exact revision approval', t => {
  const f = fixture(t);
  f.command('set_plan_review_policy', { enabled: false }, f.system);
  const command = f.make('supervisor_propose', { contract: simpleProposal() });
  const first = f.store.apply(command, f.authority);
  assert.deepEqual(f.store.apply(command, f.authority), first, 'uncertain proposal replay is identical');
  const saved = f.goal.contracts.at(-1).contract;
  assert.equal(saved.tasks.length, 1);
  assert.equal(saved.tasks[0].id, 'implementation');
  assert.deepEqual(saved.tasks[0].criterionIds, ['works']);
  assert.deepEqual(saved.tasks[0].ownedAreas, ['src/a.mjs', 'src/b.mjs', 'src/composition.mjs']);
  assert.deepEqual(saved.waves[0].taskIds, ['implementation']);
  assert.deepEqual(saved.waves[0].checkIds, ['unit']);
  assert.deepEqual(readyWork(f.goal), []);
  assert.throws(() => f.command('supervisor_dispatch', {}, f.authority), { code: 'NOT_READY' });
  f.command('approve', { revision: 1 });
  f.command('supervisor_dispatch', {}, f.authority);
  assert.deepEqual(readyWork(f.goal).map(work => [work.role, work.taskId]), [['implementer', 'implementation']]);
  f.command('supervisor_revise', { message: 'Change the requested outcome.' }, f.authority);
  assert.equal(f.goal.approvedRevision, null);
  assert.deepEqual(readyWork(f.goal), []);
});

test('simple proposals cannot hide a graph, unsafe ownership, missing checks or a legacy migration', t => {
  const f = fixture(t);
  for (const contract of [
    { ...simpleProposal(), tasks: [] },
    { ...simpleProposal(), waves: [] },
    { ...simpleProposal(), implementation: { ...simpleProposal().implementation, ownedAreas: ['../other'] } },
    { ...simpleProposal(), verification: [] },
    { ...simpleProposal(), implementation: { ...simpleProposal().implementation, dependsOn: ['hidden'] } },
    { ...simpleProposal(), schemaVersion: 1 },
  ]) assert.throws(() => f.command('supervisor_propose', { contract }, f.authority));
  assert.equal(f.goal.revision, 0);
  const legacy = fixture(t, ':memory:', 0);
  assert.throws(() => legacy.command('publish_contract', { contract: simpleProposal() }));
  assert.equal(legacy.goal.revision, 0);
});
