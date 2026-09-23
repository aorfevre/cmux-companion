import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { MergeCoordinator, MERGE_POLL_MS } from '../server/orchestration/merge-coordinator.mjs';
import { GitHubCli } from '../server/orchestration/adapters/github-cli.mjs';
import { fixture } from './helpers/orchestration/domain-fixture.mjs';

function seed(store, id, status = 'delivered') {
  const base = fixture().goal;
  const goal = { ...base, id, status, pr: { number: id === 'a' ? 1 : 2, url: `https://github.com/owner/repo/pull/${id === 'a' ? 1 : 2}`, headSha: base.baseSha }, publication: { plan: { repositoryId: 'repo' } } };
  store.apply({ id: randomUUID(), goalId: id, expectedVersion: 0, type: 'create_goal', payload: {} }, { kind: 'user' }, () => ({ goal, events: [], intents: [] }));
}
function service(store) { return { store, repositoryIds: new Set(['repo']), execute: (command, authority) => store.apply(command, authority) }; }
async function settle(coordinator) { await Promise.all(coordinator.active.values()); }

test('waiting PR checks persist across restart, respect cadence and stop after confirmed merge', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'companion-merge-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'goals.sqlite'); let store = new OrchestrationStore({ path }); t.after(() => store.close());
  seed(store, 'a'); seed(store, 'b', 'merged');
  let now = 1000, state = 'open', calls = 0;
  const options = { ownership: { assertOwned() {} }, now: () => now, publisher: { async observeMerge(plan, pr) { calls++; return { ...pr, state }; } } };
  let coordinator = new MergeCoordinator({ ...options, service: service(store) });
  coordinator.run(); coordinator.run(); await settle(coordinator);
  assert.equal(calls, 1); assert.equal(store.get('a').mergeSync.checkedAt, now); assert.equal(store.get('a').status, 'delivered');
  await coordinator.stop(); store.close(); store = new OrchestrationStore({ path });
  coordinator = new MergeCoordinator({ ...options, service: service(store) });
  now += MERGE_POLL_MS - 1; coordinator.run(); await settle(coordinator); assert.equal(calls, 1);
  now++; state = 'merged'; coordinator.run(); await settle(coordinator);
  assert.equal(store.get('a').status, 'merged'); assert.equal(calls, 2);
  now += MERGE_POLL_MS; coordinator.run(); await settle(coordinator); assert.equal(calls, 2);
  await coordinator.stop();
});

test('slow or failed observations do not block other goals; closed PRs remain incomplete', async t => {
  const store = new OrchestrationStore({ path: ':memory:' }); t.after(() => store.close()); seed(store, 'a'); seed(store, 'b');
  let rejectA; let now = 1000;
  const coordinator = new MergeCoordinator({ service: service(store), ownership: { assertOwned() {} }, now: () => now, publisher: {
    observeMerge(plan, pr) { return pr.number === 1 ? new Promise((resolve, reject) => { rejectA = reject; }) : Promise.resolve({ ...pr, state: 'closed' }); },
  } });
  coordinator.run(); await coordinator.active.get('b');
  assert.equal(store.get('b').mergeSync.state, 'closed'); assert.equal(store.get('b').status, 'delivered');
  rejectA(new Error('private CLI output')); await settle(coordinator);
  assert.equal(store.get('a').mergeSync.state, 'unknown'); assert.doesNotMatch(JSON.stringify(store.get('a')), /private CLI/);
  coordinator.run(); assert.equal(coordinator.active.size, 0);
  now += MERGE_POLL_MS; coordinator.publisher.observeMerge = async (plan, pr) => ({ ...pr, number: 99, state: 'merged' });
  coordinator.run(); await settle(coordinator); assert.equal(store.get('a').status, 'delivered');
  await coordinator.stop(); coordinator.run(); assert.equal(coordinator.active.size, 0);
});

test('closing a coordinator cannot record an observation after ownership is released', async t => {
  const store = new OrchestrationStore({ path: ':memory:' }); t.after(() => store.close()); seed(store, 'a');
  let complete;
  const coordinator = new MergeCoordinator({ service: service(store), ownership: { assertOwned() {} }, publisher: { observeMerge(plan, pr) { return new Promise(resolve => { complete = () => resolve({ ...pr, state: 'merged' }); }); } } });
  coordinator.run(); await Promise.resolve(); const stopped = coordinator.stop(); complete(); await stopped;
  assert.equal(store.get('a').status, 'delivered'); assert.equal(store.get('a').mergeSync, undefined);
});

test('direct GitHub PR observation validates repository/number and requires explicit merged truth', async () => {
  const calls = []; let response = { number: 7, html_url: 'https://github.com/owner/repo/pull/7', base: { repo: { full_name: 'owner/repo' } }, state: 'closed', merged: false };
  const cli = new GitHubCli({ repositories: new Map([['repo', 'owner/repo']]), cwd: tmpdir(), env: {}, execute: async argv => { calls.push(argv); return JSON.stringify(response); } });
  assert.equal((await cli.readPull('repo', 7)).state, 'closed');
  response.merged = true; assert.equal((await cli.readPull('repo', 7)).state, 'merged');
  assert.deepEqual(calls[0], ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/owner/repo/pulls/7']);
  response.number = 8; await assert.rejects(cli.readPull('repo', 7), { code: 'OWNERSHIP_UNCERTAIN' });
  response.number = 7; delete response.merged; await assert.rejects(cli.readPull('repo', 7), { code: 'OWNERSHIP_UNCERTAIN' });
  await assert.rejects(cli.readPull('unknown', 7), { code: 'UNSUPPORTED_CAPABILITY' });
});

test('the pull request read reports a bounded mergeable verdict', async () => {
  let response = { number: 7, html_url: 'https://github.com/owner/repo/pull/7', base: { repo: { full_name: 'owner/repo' }, sha: 'a'.repeat(40) }, state: 'open', merged: false, mergeable: true };
  const cli = new GitHubCli({ repositories: new Map([['repo', 'owner/repo']]), cwd: tmpdir(), env: {}, execute: async () => JSON.stringify(response) });
  assert.equal((await cli.readPull('repo', 7)).mergeable, 'mergeable');
  response = { ...response, mergeable: false };
  assert.equal((await cli.readPull('repo', 7)).mergeable, 'conflicting');
  response = { ...response, mergeable: null };
  assert.equal((await cli.readPull('repo', 7)).mergeable, 'unknown');
  response = { ...response, mergeable: 'yes' };
  assert.equal((await cli.readPull('repo', 7)).mergeable, 'unknown', 'an unexpected value never reads as mergeable');
  delete response.mergeable;
  assert.equal((await cli.readPull('repo', 7)).mergeable, 'unknown');
});

test('an observed conflict starts one automatic review round', async t => {
  const store = new OrchestrationStore({ path: ':memory:' }); t.after(() => store.close()); seed(store, 'a');
  let now = 1000, mergeable = 'conflicting';
  const coordinator = new MergeCoordinator({ service: service(store), ownership: { assertOwned() {} }, now: () => now, id: () => `auto${now}`,
    publisher: { async observeMerge(plan, pr) { return { ...pr, state: 'open', mergeable }; } } });
  coordinator.run(); await settle(coordinator);
  assert.equal(store.get('a').status, 'addressing_review');
  assert.equal(store.get('a').reviewRound.trigger, 'conflict');
});

test('a mergeable observation starts no round', async t => {
  const store = new OrchestrationStore({ path: ':memory:' }); t.after(() => store.close()); seed(store, 'a');
  const coordinator = new MergeCoordinator({ service: service(store), ownership: { assertOwned() {} }, now: () => 1000, id: () => 'auto',
    publisher: { async observeMerge(plan, pr) { return { ...pr, state: 'open', mergeable: 'mergeable' }; } } });
  coordinator.run(); await settle(coordinator);
  assert.equal(store.get('a').status, 'delivered');
  assert.equal(store.get('a').reviewRound ?? null, null);
});
