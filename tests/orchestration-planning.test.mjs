import assert from 'node:assert/strict';
import test from 'node:test';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { OrchestrationService } from '../server/orchestration/service.mjs';
import { Scheduler } from '../server/orchestration/scheduler.mjs';
import { roleContext } from '../server/orchestration/adapters/role-prompts.mjs';
import { FakeAgents } from './helpers/orchestration/fake-agents.mjs';
import { contract, BASE } from './helpers/orchestration/domain-fixture.mjs';

function fixture(t) {
  const store = new OrchestrationStore({ path: ':memory:' }), agents = new FakeAgents();
  const service = new OrchestrationService({ store, agents, repositoryIds: new Set(['repo']) });
  const scheduler = new Scheduler({ service, repositories: { provision: async ({ operationId, branch, baseSha }) => ({ worktree: `/tmp/${operationId}`, branch, baseSha }) } });
  t.after(async () => { await scheduler.stop(); store.close(); });
  let next = 0;
  const user = { kind: 'user' };
  const command = (type, payload, authority = user) => service.execute({ id: `cmd${++next}`, goalId: 'g', expectedVersion: store.get('g')?.version ?? 0, type, payload }, authority);
  const authority = (attempt) => ({ kind: 'agent', goalId: 'g', attemptId: attempt.id, role: attempt.role, generation: attempt.generation, revision: attempt.revision });
  const latest = (role) => store.get('g').attempts.filter((attempt) => attempt.role === role).at(-1);
  const publish = () => command('publish_contract', { contract: contract() }, authority(latest('planner')));
  const review = (blocking = false) => {
    const attempt = latest('reviewer');
    command('record_review', { attemptId: attempt.id, reviewId: `review${++next}`, review: { schemaVersion: 1, target: attempt.target, disposition: blocking ? 'request_changes' : 'accept', findings: blocking ? [{ id: 'F1', severity: 'high', blocking: true, title: 'Clarify scope', evidence: 'Task A is ambiguous', suggestion: 'Specify its result' }] : [] } }, authority(attempt));
    agents.stop(attempt.operationId);
  };
  command('create_goal', { repositoryId: 'repo', title: 'Build modules', baseSha: BASE });
  return { store, agents, service, scheduler, command, authority, latest, publish, review };
}

test('scheduled planning and independent plan review require user approval before parallel implementation', async (t) => {
  const f = fixture(t); await f.scheduler.start(); const planner = f.latest('planner');
  assert.equal(planner.mode, 'interactive'); f.publish(); await f.scheduler.tick();
  const reviewer = f.latest('reviewer');
  assert.notEqual(reviewer.conversationId, planner.conversationId);
  assert.equal(f.store.get('g').status, 'awaiting_approval');
  assert.throws(() => f.command('approve', { revision: 1 }), { code: 'REVIEW_REQUIRED' });
  assert.throws(() => f.command('approve', { revision: 1 }, f.authority(reviewer)), { code: 'FORBIDDEN' });
  f.review(); await f.scheduler.tick();
  assert.equal(f.agents.launches.filter((launch) => launch.attempt.role === 'implementer').length, 0);
  f.command('approve', { revision: 1 }); await f.scheduler.tick();
  assert.deepEqual(f.agents.launches.filter((launch) => launch.attempt.role === 'implementer').map((launch) => launch.attempt.taskId).sort(), ['A', 'B']);
});

test('user revision request preserves immutable history and schedules a fresh planner with review findings', async (t) => {
  const f = fixture(t); await f.scheduler.start(); f.publish(); await f.scheduler.tick(); f.review(true); await f.scheduler.tick();
  const before = f.store.get('g');
  assert.ok(before.hold);
  assert.throws(() => f.command('approve', { revision: 1 }), { code: 'NOT_READY' });
  f.command('request_revision', { message: 'Resolve F1 and preserve the parallel task graph' }); await f.scheduler.tick();
  const planner = f.latest('planner'), context = roleContext(f.store.get('g'), planner);
  assert.equal(f.store.get('g').approvedRevision, null);
  assert.deepEqual(f.store.get('g').contracts, before.contracts);
  assert.equal(context.planningRequest.basedOnRevision, 1); assert.equal(context.reviews[0].findings[0].id, 'F1');
  f.publish(); await f.scheduler.tick();
  assert.equal(f.store.get('g').revision, 2);
  assert.throws(() => f.command('approve', { revision: 1 }), { code: 'STALE_TARGET' });
  assert.throws(() => f.command('approve', { revision: 2 }), { code: 'REVIEW_REQUIRED' });
  f.review(); await f.scheduler.tick(); f.command('approve', { revision: 2 });
  assert.equal(f.store.get('g').approvedRevision, 2);
});

test('revision during implementation fences old workers before any new approval is usable', async (t) => {
  const f = fixture(t); await f.scheduler.start(); f.publish(); await f.scheduler.tick(); f.review(); await f.scheduler.tick(); f.command('approve', { revision: 1 }); await f.scheduler.tick();
  const old = f.latest('implementer'); f.agents.ignoreTermination = true;
  f.command('request_revision', { message: 'Revise task scope' }); await f.scheduler.tick();
  assert.equal(f.store.get('g').approvedRevision, null);
  assert.throws(() => f.command('request_revision', { message: 'Agent expansion' }, f.authority(old)), { code: 'FORBIDDEN' });
  const owned = f.store.ownedCapacity('g', 'background').total; assert.equal(owned, 2);
  f.publish(); await f.scheduler.tick(); f.review(); await f.scheduler.tick();
  assert.throws(() => f.command('approve', { revision: 2 }), { code: 'OWNERSHIP_UNCERTAIN' });
  f.agents.ignoreTermination = false; await f.scheduler.tick(); f.command('approve', { revision: 2 });
});
