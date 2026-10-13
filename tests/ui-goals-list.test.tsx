import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GoalsList } from '../app/orchestration/goals-list';
import { goalView } from '../server/orchestration/domain/state-view.mjs';
import { fixture } from './helpers/orchestration/domain-fixture.mjs';
import type { Goal } from '../app/orchestration/goal-board';

afterEach(cleanup);
const base = (): Goal => goalView(fixture().goal);
const decision = (over: Partial<Goal['decision']>): Goal['decision'] => ({ state: 'Work continues automatically. No action needed.', reason: null, detail: null, primary: null, next: null, rank: 1, stage: 'In progress', ...over });
const recover = { type: 'recover_goal', label: 'Recover goal', payload: { holdId: 'h' } };
function goals(): Goal[] {
  return [
    { ...base(), id: 'active', title: 'Active goal', lastActivity: { kind: 'attempt_dispatched', createdAt: '2026-10-13T10:00:00Z' }, decision: decision({}) },
    { ...base(), id: 'held', title: 'Held goal', hold: { id: 'h', reasons: [] }, actions: [recover, { type: 'abort', label: 'Abort goal', payload: {} }], lastActivity: { kind: 'goal_dispatch_held', createdAt: '2026-10-13T09:00:00Z' }, decision: decision({ state: 'The goal is on hold.', reason: 'The planner stopped before it finished. Recover to run it again.', primary: recover, rank: 0, stage: 'On hold' }) },
    { ...base(), id: 'merged', title: 'Merged goal', status: 'merged', decision: decision({ state: 'Merged on GitHub.', rank: 3, stage: 'Complete' }) },
    { ...base(), id: 'aborted', title: 'Aborted goal', status: 'aborted', decision: decision({ state: 'Aborted. Evidence is retained.', rank: 4, stage: 'Aborted' }) },
    { ...base(), id: 'revise', title: 'Needs revision', actions: [{ type: 'request_revision', label: 'Request revision', payload: {} }], lastActivity: { kind: 'review_recorded', createdAt: '2026-10-13T11:00:00Z' }, decision: decision({ state: 'The goal is on hold.', reason: 'A plan revision is required before recovery.', next: { type: 'request_revision', label: 'Request revision', context: 'high: Wrong. Fix it' }, rank: 0, stage: 'On hold' }) },
  ];
}
const props = { chip: 'All' as const, onChip: vi.fn(), disabled: false, act: vi.fn().mockResolvedValue(true), select: vi.fn(), openNext: vi.fn(), projectName: () => 'Example' };

test('rows sort decisions first by newest activity, show one state, one reason and one button, and act without opening', () => {
  const act = vi.fn().mockResolvedValue(true), select = vi.fn(), openNext = vi.fn();
  render(<GoalsList {...props} goals={goals()} act={act} select={select} openNext={openNext} />);
  expect(screen.getAllByRole('article').map(row => row.getAttribute('aria-label'))).toEqual(['Needs revision', 'Held goal', 'Active goal', 'Merged goal', 'Aborted goal']);
  const held = screen.getByRole('article', { name: 'Held goal' });
  expect(within(held).getByText('The goal is on hold.')).toBeTruthy();
  expect(within(held).getByText('The planner stopped before it finished. Recover to run it again.')).toBeTruthy();
  expect(within(held).getByText('On hold')).toBeTruthy();
  fireEvent.click(within(held).getByRole('button', { name: 'Recover goal' }));
  expect(act).toHaveBeenCalledWith(expect.objectContaining({ id: 'held' }), recover);
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole('article', { name: 'Needs revision' })).getByRole('button', { name: 'Request revision' }));
  expect(openNext).toHaveBeenCalledWith('revise', expect.objectContaining({ type: 'request_revision' }));
  fireEvent.click(within(held).getByRole('button', { name: 'More' }));
  expect(within(held).getByLabelText('More actions')).toBeTruthy();
  fireEvent.click(within(held).getByRole('button', { name: 'Open Held goal' }));
  expect(select).toHaveBeenCalledWith('held');
});

test('chips filter by rank and empty states name the chip', () => {
  const onChip = vi.fn();
  const view = render(<GoalsList {...props} goals={goals()} chip="Needs you" onChip={onChip} />);
  expect(screen.getAllByRole('article').map(row => row.getAttribute('aria-label'))).toEqual(['Needs revision', 'Held goal']);
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(onChip).toHaveBeenCalledWith('Done');
  view.rerender(<GoalsList {...props} goals={goals()} chip="Done" onChip={onChip} />);
  expect(screen.getAllByRole('article').map(row => row.getAttribute('aria-label'))).toEqual(['Merged goal', 'Aborted goal']);
  view.rerender(<GoalsList {...props} goals={goals()} chip="Active" onChip={onChip} />);
  expect(screen.getAllByRole('article').map(row => row.getAttribute('aria-label'))).toEqual(['Active goal']);
  view.rerender(<GoalsList {...props} goals={[goals()[0]]} chip="Needs you" onChip={onChip} />);
  expect(screen.getByText('Nothing needs you')).toBeTruthy();
  view.rerender(<GoalsList {...props} goals={goals()} chip="All" onChip={onChip} />);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
  expect(screen.getByText('No matching goals')).toBeTruthy();
  view.rerender(<GoalsList {...props} goals={[]} chip="All" onChip={onChip} />);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
  expect(screen.getByText('Your first goal starts here')).toBeTruthy();
});

test('read-only disables every row button', () => {
  render(<GoalsList {...props} goals={goals()} disabled />);
  const buttons = screen.getAllByRole('button', { name: /Recover goal|Request revision|More/ });
  expect(buttons.length).toBeGreaterThan(2);
  expect(buttons.every(button => (button as HTMLButtonElement).disabled)).toBe(true);
});
