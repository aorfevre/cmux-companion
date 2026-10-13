import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GoalsList } from '../app/orchestration/goals-list';
import { DecisionBar } from '../app/orchestration/decision-bar';
import { goalView } from '../server/orchestration/domain/state-view.mjs';
import { fixture } from './helpers/orchestration/domain-fixture.mjs';
import { newRecoveryPolicy } from '../server/orchestration/domain/agent-recovery.mjs';

afterEach(cleanup);
const props = { onChip: vi.fn(), disabled: false, act: vi.fn().mockResolvedValue(true), select: vi.fn(), openNext: vi.fn(), projectName: () => 'Example' };
function recovering() {
  const f = fixture(); f.approve();
  f.goal.experienceVersion = 2;
  f.goal.conversation = { messages: [], supervisorAttemptId: null, wake: 1, seenWake: 0, waiting: false, paused: false, dispatchApproved: true };
  f.goal.recoveryPolicy = newRecoveryPolicy();
  f.request('worker', 'implementer', 'A'); f.dispatch('worker'); f.command('record_stopped', { attemptId: 'worker' });
  return f;
}
test('automatic recovery belongs in Active, with no recover click in the row or its menu', () => {
  const goal = goalView(recovering().goal);
  const { rerender } = render(<GoalsList {...props} goals={[goal]} chip="Active" />);
  expect(screen.getByRole('article', { name: goal.title })).toBeTruthy();
  expect(screen.getByText('Recovering')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  expect(screen.queryByRole('button', { name: 'Recover goal' })).toBeNull();
  rerender(<GoalsList {...props} goals={[goal]} chip="Needs you" />);
  expect(screen.queryByRole('article', { name: goal.title })).toBeNull();
});
test('an exhausted goal explains the blocker and offers an explicit budget decision', () => {
  const f = recovering(); f.goal.recoveryPolicy!.priorSpent = 12;
  const goal = goalView(f.goal), act = vi.fn().mockResolvedValue(true);
  render(<DecisionBar {...props} goal={goal} act={act} />);
  expect(screen.getByText(/The recovery budget is exhausted/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Authorize more recovery work' }));
  expect(act).toHaveBeenCalledWith(goal, expect.objectContaining({ type: 'extend_recovery_budget', payload: { limit: 12 } }));
});
