import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GoalConversation } from '../app/orchestration/goal-conversation';
import { transition } from '../server/orchestration/domain/transitions.mjs';
import { goalView } from '../server/orchestration/domain/state-view.mjs';
import { contract } from './helpers/orchestration/domain-fixture.mjs';

afterEach(cleanup);
function goal() {
  const initial = transition(null, { id: 'create', goalId: 'goal', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'Fix the modules', baseSha: 'a'.repeat(40), experienceVersion: 2 } }, { kind: 'user' }).goal;
  const planned = transition(initial, { id: 'proposal', goalId: 'goal', expectedVersion: 1, type: 'publish_contract', payload: { contract: contract() } }, { kind: 'user' }).goal;
  planned.planReviewEnabled = false;
  return { ...goalView(planned), contracts: planned.contracts };
}
test('conversation shows saved delivery and exact proposal approval while steering stays in one composer', async () => {
  const value = goal(), act = vi.fn().mockResolvedValue(true);
  render(<GoalConversation goal={value} disabled={false} act={act} />);
  expect(screen.getByRole('log', { name: 'Conversation messages' })).toBeTruthy();
  expect(screen.getByText('Queued for supervisor')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Proposal 1' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Approve revision 1' }));
  expect(act).toHaveBeenCalledWith(value, expect.objectContaining({ type: 'approve', payload: { revision: 1 } }));
  fireEvent.change(screen.getByLabelText('Message your supervisor'), { target: { value: 'Please narrow the scope.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  expect(act).toHaveBeenCalledWith(value, expect.objectContaining({ type: 'send_goal_message', payload: { message: 'Please narrow the scope.' } }));
  await waitFor(() => expect((screen.getByLabelText('Message your supervisor') as HTMLTextAreaElement).value).toBe(''));
});

test('failed sends retain the draft; pause queues messages and read-only disables mutations', async () => {
  const value = goal(), act = vi.fn().mockResolvedValue(false);
  value.conversation!.paused = true;
  value.conversation!.messages[0].delivery = 'answered';
  const view = render(<GoalConversation goal={value} disabled={false} act={act} />);
  expect(screen.getByText('Answered')).toBeTruthy();
  expect(screen.getByText('Messages remain saved while the goal is paused.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Message your supervisor'), { target: { value: 'Saved steering' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(act).toHaveBeenCalledTimes(1));
  expect((screen.getByLabelText('Message your supervisor') as HTMLTextAreaElement).value).toBe('Saved steering');
  view.rerender(<GoalConversation goal={value} disabled={true} act={act} />);
  expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Approve revision 1' }) as HTMLButtonElement).disabled).toBe(true);
});

test('result evidence and publication approval stay pinned to the integrated commit', () => {
  const value = goal(), act = vi.fn();
  value.status = 'ready_to_publish';
  value.verification = { headSha: value.integrationHead, checks: [{ id: 'unit', passed: true, artifactId: 'b'.repeat(64) }] };
  value.reviews = [{ id: 'review', kind: 'integration', taskId: null, target: value.integrationHead, disposition: 'accept', findings: [] }];
  value.actions = [{ type: 'approve_publication', label: 'Approve & publish PR', payload: { operationId: 'publish', headSha: value.integrationHead } }];
  render(<GoalConversation goal={value} disabled={false} act={act} />);
  expect(screen.getByText('Independent review: accept')).toBeTruthy();
  expect(screen.getByText('unit: Passed')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Approve & publish PR' }));
  expect(act).toHaveBeenCalledWith(value, value.actions[0]);
  expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true);
});

test('a queued supervisor wake reports capacity waiting instead of working or needing approval', () => {
  const value = goal(); value.status = 'discovering';
  value.conversation!.capacityReleased = true; value.conversation!.waiting = false;
  render(<GoalConversation goal={value} disabled={false} act={vi.fn()} />);
  expect(screen.getByRole('status').textContent).toBe('Supervisor waiting for execution capacity · no action needed');
});
