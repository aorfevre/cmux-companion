import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  expect(screen.queryByRole('button', { name: 'Approve revision 1' })).toBeNull();
  expect(screen.getByText('Request changes in the message box below.')).toBeTruthy();
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
  expect(screen.queryByRole('button', { name: 'Approve & publish PR' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true);
});

test('the conversation keeps no status of its own; the decision bar owns it', () => {
  const value = goal(); value.status = 'discovering';
  value.conversation!.capacityReleased = true; value.conversation!.waiting = false;
  render(<GoalConversation goal={value} disabled={false} act={vi.fn()} />);
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('log', { name: 'Conversation messages' })).toBeTruthy();
});

test('the current proposal shows a summary first, old proposals one line, and long messages clamp', () => {
  const value = goal();
  const revised = { ...value, revision: 2, contracts: [...value.contracts, { revision: 2, contract: { ...value.contracts[0].contract, outcome: 'Combine modules with care' } }] };
  revised.conversation = { ...value.conversation!, messages: [
    ...value.conversation!.messages,
    { id: 'long', sequence: 3, author: 'supervisor', kind: 'message', text: Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join('\n'), revision: 1, delivery: 'delivered' },
    { id: 'p2', sequence: 4, author: 'supervisor', kind: 'proposal', text: 'Revised proposal', revision: 2, delivery: 'delivered' },
  ] };
  sessionStorage.clear();
  // jsdom has no layout, so the clamp is driven by the measured overflow of the long paragraph only.
  const heights = { scroll: 0, client: 0 };
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.textContent?.startsWith('Line 1') ? 400 : heights.scroll; });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.textContent?.startsWith('Line 1') ? 160 : heights.client; });
  render(<GoalConversation goal={revised} disabled={false} act={vi.fn()} />);
  expect(screen.getByText('Proposal 1 · Superseded by 2')).toBeTruthy();
  expect(screen.queryByText('Revised proposal')).toBeNull();
  expect(screen.getByRole('heading', { name: 'Proposal 2' })).toBeTruthy();
  const current = within(screen.getByRole('region', { name: 'Proposal revision 2' }));
  expect(current.getByText('Combine modules with care')).toBeTruthy();
  expect(current.getByText('1 scope item · 1 acceptance criterion · 1 check · 3 tasks')).toBeTruthy();
  expect(screen.getByText('Proposal 1 · Superseded by 2').closest('details')!.open).toBe(false);
  const scope = current.getByText('Scope (1)').closest('details')!;
  expect(scope.open).toBe(false);
  scope.open = true; fireEvent(scope, new Event('toggle'));
  expect(sessionStorage.getItem('companion.proposal.goal.Scope')).toBe('open');
  const long = screen.getByText('Line 1', { exact: false });
  expect(long.classList.contains('goal-message-clamped')).toBe(true);
  expect(screen.getAllByRole('button', { name: 'Show more' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
  expect(long.classList.contains('goal-message-clamped')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
  expect(long.classList.contains('goal-message-clamped')).toBe(true);
});
