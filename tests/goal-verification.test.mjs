import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, contract } from './helpers/orchestration/domain-fixture.mjs';
import { resolveGoalCheck } from '../server/goal-verification.mjs';
import { rolePrompt } from '../server/orchestration/adapters/role-prompts.mjs';
const resolve = (goal, check = contract().verification[0], repositoryId = 'repo') => resolveGoalCheck({ goal, check, repositoryId, env: {}, environmentId: 'test', policy: {} });
test('planned checks need current approval and exact repository, id and argv', () => {
  const f = fixture();
  assert.throws(() => resolve(f.goal), { code: 'NOT_READY' });
  f.approve();
  const result = resolve(f.goal);
  assert.match(result.bin, /node$/); assert.deepEqual(result.argv, ['--test']);
  assert.match(result.environmentId, /goal-goal-revision-1$/);
  assert.throws(() => resolve(f.goal, { id: 'unit', argv: ['node', '--version'] }), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.throws(() => resolve(f.goal, { id: 'other', argv: ['node', '--test'] }), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.throws(() => resolve(f.goal, undefined, 'other'), { code: 'FORBIDDEN' });
  assert.throws(() => resolve(null), { code: 'FORBIDDEN' });
  assert.deepEqual(resolve(JSON.parse(JSON.stringify(f.goal))), result);
  f.command('publish_contract', { contract: contract() }, f.user);
  assert.throws(() => resolve(f.goal), { code: 'NOT_READY' });
});
test('plan approval does not enable shell wrappers, RPC or missing executables', () => {
  for (const executable of ['sh', '/bin/bash', 'env', 'cmux', 'cmux-nonexistent-verification-command', 'node;echo', './script']) {
    const f = fixture(), plan = contract(); plan.verification[0].argv = [executable, '--version']; f.approve(plan);
    assert.throws(() => resolve(f.goal, plan.verification[0]));
  }
});
test('planner discovers goal checks and reports gaps instead of requiring repository configuration', () => {
  const f = fixture(); f.request('planner', 'planner');
  const prompt = rolePrompt(f.goal, f.goal.attempts.at(-1));
  assert.match(prompt, /Inspect repository instructions, scripts and CI/);
  assert.match(prompt, /If no checks exist, explicitly report the gap/);
  assert.match(prompt, /Approval of this exact plan/);
});
