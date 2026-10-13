import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { DecisionBar } from '../app/orchestration/decision-bar';
import { goalView } from '../server/orchestration/domain/state-view.mjs';
import { transition, planTarget } from '../server/orchestration/domain/transitions.mjs';
import { fixture, contract } from './helpers/orchestration/domain-fixture.mjs';
import type { Goal } from '../app/orchestration/goal-board';

afterEach(cleanup);
const base = (): Goal => goalView(fixture().goal);
const decision = (over: Partial<Goal['decision']>): Goal['decision'] => ({ state: 'Work continues automatically. No action needed.', reason: null, detail: null, primary: null, next: null, rank: 1, stage: 'In progress', ...over });

test('the bar shows stage, state, the primary action and secondary actions behind More', () => {
  const goal: Goal = { ...base(), title: 'Session in mobile', status: 'awaiting_approval', planReviewPending: false,
    decision: decision({ state: 'Your plan is ready to approve.', primary: { type: 'approve', label: 'Approve revision 3', payload: { revision: 3 } }, rank: 0, stage: 'Needs approval' }),
    actions: [{ type: 'approve', label: 'Approve revision 3', payload: { revision: 3 } }, { type: 'pause_goal', label: 'Pause goal', payload: {} }, { type: 'send_goal_message', label: 'Send message', payload: {} }, { type: 'rename_goal', label: 'Edit title', payload: { title: 'Session in mobile' } }, { type: 'abort', label: 'Abort goal', payload: {} }] };
  const act = vi.fn().mockResolvedValue(true);
  render(<DecisionBar goal={goal} disabled={false} act={act} openNext={vi.fn()} />);
  expect(screen.getByRole('region', { name: 'Goal decision' }).textContent).toContain('Needs approval');
  expect(screen.getByRole('heading', { name: 'Session in mobile' })).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('Your plan is ready to approve.');
  expect(screen.queryByRole('button', { name: 'Pause goal' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Approve revision 3' }));
  expect(act).toHaveBeenCalledWith(goal, goal.actions[0]);
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  expect(within(screen.getByLabelText('More actions')).queryByRole('button', { name: 'Send message' })).toBeNull();
  expect(within(screen.getByLabelText('More actions')).queryByRole('button', { name: 'Approve revision 3' })).toBeNull();
  fireEvent.click(within(screen.getByLabelText('More actions')).getByRole('button', { name: 'Abort goal' }));
  expect(act).toHaveBeenCalledWith(goal, goal.actions[4]);
  expect(screen.queryByLabelText('More actions')).toBeNull();
});

test('a refused action renders as the reason with no primary button, and the menu closes on an outside click', () => {
  const goal: Goal = { ...base(), hold: { id: 'hold', reasons: [{ kind: 'attempt', target: 'planner', message: 'planner did not finish successfully.' }] },
    decision: decision({ state: 'The goal is on hold.', reason: 'Let active workers finish and reconcile uncertain ownership before recovery', rank: 1, stage: 'On hold' }), actions: [{ type: 'abort', label: 'Abort goal', payload: {} }] };
  render(<DecisionBar goal={goal} disabled={false} act={vi.fn()} openNext={vi.fn()} />);
  expect(screen.getByRole('status').textContent).toBe('The goal is on hold.');
  expect(screen.getByText('Let active workers finish and reconcile uncertain ownership before recovery')).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Goal decision' }).querySelector('.decision-primary')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  expect(screen.getByLabelText('More actions')).toBeTruthy();
  fireEvent.mouseDown(document.body);
  expect(screen.queryByLabelText('More actions')).toBeNull();
});

test('an open More panel closes and its items disable when controls become unavailable', () => {
  const goal: Goal = { ...base(), decision: decision({}), actions: [{ type: 'abort', label: 'Abort goal', payload: {} }] };
  const act = vi.fn();
  const view = render(<DecisionBar goal={goal} disabled={false} act={act} openNext={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  expect(screen.getByLabelText('More actions')).toBeTruthy();
  view.rerender(<DecisionBar goal={goal} disabled={true} act={act} openNext={vi.fn()} />);
  expect(screen.queryByLabelText('More actions')).toBeNull();
  expect((screen.getByRole('button', { name: 'More' }) as HTMLButtonElement).disabled).toBe(true);
  expect(act).not.toHaveBeenCalled();
});

test('Edit title opens the inline form and saves through the rename action', async () => {
  const goal: Goal = { ...base(), title: 'Short title', decision: decision({}),
    actions: [{ type: 'rename_goal', label: 'Edit title', payload: { title: 'Short title' } }] };
  const act = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<DecisionBar goal={goal} disabled={false} act={act} openNext={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  fireEvent.click(within(screen.getByLabelText('More actions')).getByRole('button', { name: 'Edit title' }));
  fireEvent.change(screen.getByLabelText('Goal title'), { target: { value: 'Better title' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save title' }));
  expect(act).toHaveBeenCalledWith(goal, expect.objectContaining({ type: 'rename_goal', payload: { title: 'Better title' } }));
  await vi.waitFor(() => expect(act).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText('Goal title')).toHaveProperty('value', 'Better title');
  fireEvent.click(screen.getByRole('button', { name: 'Save title' }));
  await vi.waitFor(() => expect(screen.queryByLabelText('Goal title')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  fireEvent.click(within(screen.getByLabelText('More actions')).getByRole('button', { name: 'Edit title' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByLabelText('Goal title')).toBeNull();
});

test('every case the list ranks as a decision has a primary, a next step or a hold', () => {
  const held = fixture(); held.request('planner', 'planner'); held.dispatch('planner');
  held.command('record_failure', { attemptId: 'planner', uncertain: true, error: 'Lost connection' });
  const created = transition(null, { id: 'create', goalId: 'goal', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'Fix', baseBranch: 'main' } }, { kind: 'user' }).goal;
  const failed = transition(created, { id: 'fail', goalId: 'goal', expectedVersion: created.version, type: 'fail_startup', payload: { error: 'Repository is owned by another service.' } }, { kind: 'system' }).goal;
  const asked = fixture(); asked.goal.clarification = { question: 'Which module?' };
  const planned = fixture(); planned.command('publish_contract', { contract: contract() }, planned.user);
  planned.request('plan_review', 'reviewer'); planned.dispatch('plan_review'); planned.review('plan_review', planTarget(planned.goal));
  for (const goal of [held.goal, failed, asked.goal, planned.goal].map(goal => goalView(goal))) {
    expect(goal.decision.rank === 0 || Boolean(goal.hold), goal.decision.state).toBe(true);
    expect(Boolean(goal.decision.primary) || Boolean(goal.decision.next) || Boolean(goal.hold), goal.decision.state).toBe(true);
  }
});


test('a next step renders as the primary button and opens the composer instead of sending a command', () => {
  const next = { type: 'request_revision' as const, label: 'Request revision', context: 'high: Wrong value. Return two' };
  const goal: Goal = { ...base(), decision: decision({ state: 'The goal is on hold.', reason: 'A plan revision is required before recovery.', next, rank: 0, stage: 'On hold' }), actions: [{ type: 'request_revision', label: 'Request revision', payload: {} }] };
  const act = vi.fn(), openNext = vi.fn();
  render(<DecisionBar goal={goal} disabled={false} act={act} openNext={openNext} />);
  fireEvent.click(screen.getByRole('button', { name: 'Request revision' }));
  expect(openNext).toHaveBeenCalledWith(next);
  expect(act).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
});
