import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushService, contextUrl } from '../server/push-service.mjs';
import { goalAttention, attachGoalAttention } from '../server/orchestration/goal-attention.mjs';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { fixture, contract, BASE } from './helpers/orchestration/domain-fixture.mjs';
import { planTarget } from '../server/orchestration/domain/transitions.mjs';

function pushFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'goal-attention-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'push.json'), sent = [];
  const sender = { generateVAPIDKeys: () => ({ publicKey: 'public', privateKey: 'private' }), setVapidDetails() {},
    async sendNotification(_target, raw) { sent.push(JSON.parse(raw)); } };
  const service = new PushService({ path, sender });
  return { directory, path, sender, service, sent };
}
const subscription = { endpoint: 'https://push.example.test/device', keys: { p256dh: 'public', auth: 'auth' } };
const notice = { journalId: 'journal', goalId: 'goal', attentionId: 'question:0', title: 'Private goal', body: 'Private question' };

test('attention is current, actionable, and approval waits for independent review', () => {
  const f = fixture();
  assert.equal(goalAttention(null), null);
  assert.equal(goalAttention(f.goal), null);
  const question = { ...f.goal, clarification: { question: 'Which audience?' } };
  assert.match(goalAttention(question).body, /Which audience/);
  assert.doesNotMatch(goalAttention(question).id, /Which audience/);
  assert.equal(goalAttention({ ...question, clarification: { ...question.clarification, answer: 'Beginners' } }), null);
  assert.equal(goalAttention({ ...question, status: 'aborted' }), null);
  f.command('publish_contract', { contract: contract() }, f.user);
  assert.equal(goalAttention(f.goal), null);
  f.request('review', 'reviewer'); f.dispatch('review'); f.review('review', planTarget(f.goal));
  assert.match(goalAttention(f.goal).id, /^approval:/);
  f.command('approve', { revision: f.goal.revision }, f.user);
  assert.equal(goalAttention(f.goal), null);
});

test('goal alerts preserve opt-in/privacy and use a goal deep link', async t => {
  const { service, sent } = pushFixture(t);
  await service.goalAttention(notice); assert.equal(sent.length, 0);
  service.subscribe(subscription, { hideContent: true });
  await service.goalAttention({ ...notice, attentionId: 'question:1' });
  assert.equal(sent.length, 1); assert.equal(sent[0].title, 'cmux companion');
  assert.doesNotMatch(sent[0].body, /Private/);
  assert.equal(sent[0].url, '/orchestration?goal=goal');
  assert.equal(contextUrl({ goalId: 'a&b' }), '/orchestration?goal=a%26b');
  service.updateSettings(subscription.endpoint, { attention: false });
  await service.goalAttention({ ...notice, attentionId: 'question:2' }); assert.equal(sent.length, 1);
  service.updateSettings(subscription.endpoint, { attention: true, quietEnabled: true, quietStart: '00:00', quietEnd: '23:59' });
  service.now = () => new Date(2026, 8, 14, 12, 0);
  await service.goalAttention({ ...notice, attentionId: 'question:3' }); assert.equal(sent.length, 1);
});

test('push claim survives restart and suppresses acknowledgement-loss replay', async t => {
  const { path, sender, service, sent } = pushFixture(t);
  service.subscribe(subscription, { hideContent: false });
  await service.goalAttention(notice);
  const reopened = new PushService({ path, sender });
  assert.deepEqual(await reopened.goalAttention(notice), { duplicate: true });
  assert.equal(sent.length, 1);
  await reopened.goalAttention({ ...notice, attentionId: 'approval:1' });
  assert.equal(sent.length, 2);
});

test('journal replay re-reads current goals and uses persistent push claims', async t => {
  const { directory, path, sender, service, sent } = pushFixture(t);
  service.subscribe(subscription, { hideContent: false });
  const database = join(directory, 'core.sqlite');
  let store = new OrchestrationStore({ path: database });
  store.apply({ id: 'create', goalId: 'goal', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'Goal', baseSha: BASE } }, { kind: 'user' });
  // Isolate delivery crash behavior from the independently tested domain flow.
  const originalGet = store.get.bind(store);
  store.get = id => ({ ...originalGet(id), clarification: { question: 'Which audience?' } });
  let runtime = { store, subscribers: [] };
  let consumer = attachGoalAttention(runtime, service);
  assert.equal(runtime.subscribers[0], consumer);
  store.acknowledge = () => { throw new Error('process lost after delivery'); };
  await consumer.start(); await consumer.stop(); assert.equal(sent.length, 1); store.close();
  store = new OrchestrationStore({ path: database });
  const reopenedGet = store.get.bind(store);
  store.get = id => ({ ...reopenedGet(id), clarification: { question: 'Which audience?' } });
  runtime = { store, subscribers: [] };
  consumer = attachGoalAttention(runtime, new PushService({ path, sender }));
  await consumer.start(); await consumer.stop();
  assert.equal(consumer.cursor, 1); assert.equal(sent.length, 1);
  store.close();
});


test('answered or obsolete attention does not alert during catch-up', async t => {
  const { service, sent } = pushFixture(t);
  service.subscribe(subscription, { hideContent: false });
  const store = new OrchestrationStore({ path: ':memory:' });
  store.apply({ id: 'create', goalId: 'goal', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'Goal', baseSha: BASE } }, { kind: 'user' });
  store.apply({ id: 'abort', goalId: 'goal', expectedVersion: 1, type: 'abort', payload: {} }, { kind: 'user' });
  const consumer = attachGoalAttention({ store, subscribers: [] }, service);
  await consumer.start(); await consumer.stop();
  assert.equal(consumer.cursor, 2); assert.equal(sent.length, 0);
  store.close();
});
