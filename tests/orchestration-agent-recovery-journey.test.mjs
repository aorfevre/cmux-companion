import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startOrchestrationDemo } from '../scripts/run-orchestration-dev.mjs';
import { goalView } from '../server/orchestration/domain/state-view.mjs';

for (const scenario of ['rejected-plan', 'review-and-check']) test(`agent-led real-Git journey: ${scenario} reaches verified publication gate without manual recovery`, { timeout: 90000 }, async t => {
  const demo = await startOrchestrationDemo({ browserHarness: true });
  t.after(() => demo.close());
  for (const stage of ['siblings', 'final', ...(scenario === 'rejected-plan' ? ['reject-plan'] : [])]) writeFileSync(join(demo.manifest.directory, `release-${stage}`), 'ready');
  const headers = { host: 'localhost', origin: 'http://localhost', authorization: `Bearer ${readFileSync(demo.manifest.tokenFile, 'utf8')}` };
  const send = async (type, payload) => {
    for (let retry = 0; retry < 20; retry++) {
    const response = await demo.runtime.app.inject({ method: 'POST', url: '/api/orchestration/commands', headers,
      payload: { id: randomUUID(), goalId: 'journey', expectedVersion: demo.runtime.store.get('journey')?.version ?? 0, type, payload } });
    if (response.statusCode === 409 && response.json().code === 'VERSION_CONFLICT') continue;
    assert.equal(response.statusCode, 200, response.body);
    return;
    }
    assert.fail('Command could not settle its expected version');
  };
  const until = async predicate => {
    for (let i = 0; i < 1500; i++) {
      const goal = demo.runtime.store.get('journey');
      if (goal && predicate(goal)) return goal;
      if (goalView(goal).recovery?.state === 'blocked') assert.fail(goalView(goal).recovery.reason);
      await delay(40);
    }
    const goal = demo.runtime.store.get('journey');
    assert.fail(`Journey did not reach its named barrier: ${JSON.stringify({ status: goal.status, revision: goal.revision, recovery: goalView(goal).recovery, attempts: goal.attempts.map(({ role, status, workerState, error }) => ({ role, status, workerState, error })), messages: goal.conversation.messages.slice(-5) })}`);
  };
  await send('create_goal', { repositoryId: 'repo', title: scenario, description: 'Build and verify the disposable modules.', experienceVersion: 2, supervisorProfileId: 'claude' });
  await until(goal => goal.conversation.messages.some(message => message.kind === 'question'));
  await send('send_goal_message', { message: 'Yes, use the disposable fixture.' });
  const proposed = await until(goal => goalView(goal).actions.some(action => action.type === 'approve'));
  if (scenario === 'rejected-plan') assert.equal(proposed.planRevisionCount, 1);
  await send('approve', { revision: proposed.revision });
  const verified = await until(goal => goal.status === 'ready_to_publish');
  assert.equal(verified.verification.headSha, verified.integrationHead);
  assert.ok(verified.verification.checks.every(check => check.passed));
  assert.ok(verified.reviews.some(review => review.kind === 'integration' && review.target === verified.integrationHead && review.disposition === 'accept'));
  assert.equal(verified.publication.approval, undefined);
  assert.equal(verified.pr, null);
  assert.ok(verified.recoveryPolicy.decisions.length > 0);
  assert.ok(verified.recoveryPolicy.decisions.length <= 12);
  assert.ok(verified.recoveries.every(entry => verified.recoveryPolicy.decisions.some(decision => decision.holdId === entry.hold.id)), 'every recovery came from a charged autonomous action');
  t.diagnostic(JSON.stringify({ scenario, recoveryClicks: 0, actions: verified.recoveryPolicy.decisions.length, verifiedHead: verified.integrationHead }));
});
