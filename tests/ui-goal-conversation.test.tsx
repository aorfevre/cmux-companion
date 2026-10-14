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
  render(<GoalConversation goal={value} disabled={false} act={act} next={null} onNextConsumed={vi.fn()} />);
  expect(screen.getByRole('log', { name: 'Conversation messages' })).toBeTruthy();
  expect(screen.getByText('Queued for supervisor')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Plan 1 · For your approval' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve plan & start work' })).toBeNull();
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
  const view = render(<GoalConversation goal={value} disabled={false} act={act} next={null} onNextConsumed={vi.fn()} />);
  expect(screen.getByText('Answered')).toBeTruthy();
  expect(screen.getByText('Messages remain saved while the goal is paused.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Message your supervisor'), { target: { value: 'Saved steering' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(act).toHaveBeenCalledTimes(1));
  expect((screen.getByLabelText('Message your supervisor') as HTMLTextAreaElement).value).toBe('Saved steering');
  view.rerender(<GoalConversation goal={value} disabled={true} act={act} next={null} onNextConsumed={vi.fn()} />);
  expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true);
});

test('result evidence and publication approval stay pinned to the integrated commit', () => {
  const value = goal(), act = vi.fn();
  value.status = 'ready_to_publish';
  value.verification = { headSha: value.integrationHead, checks: [{ id: 'unit', passed: true, artifactId: 'b'.repeat(64) }] };
  value.reviews = [{ id: 'review', kind: 'integration', taskId: null, target: value.integrationHead, disposition: 'accept', findings: [] }];
  value.actions = [{ type: 'approve_publication', label: 'Create pull request', payload: { operationId: 'publish', headSha: value.integrationHead } }];
  render(<GoalConversation goal={value} disabled={false} act={act} next={null} onNextConsumed={vi.fn()} />);
  expect(screen.getByText('Independent review: accept')).toBeTruthy();
  expect(screen.getByText('unit: Passed')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Create pull request' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true);
});

test('the conversation keeps no status of its own; the decision bar owns it', () => {
  const value = goal(); value.status = 'discovering';
  value.conversation!.capacityReleased = true; value.conversation!.waiting = false;
  render(<GoalConversation goal={value} disabled={false} act={vi.fn()} next={null} onNextConsumed={vi.fn()} />);
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
  render(<GoalConversation goal={revised} disabled={false} act={vi.fn()} next={null} onNextConsumed={vi.fn()} />);
  expect(screen.getByText('Proposal 1 · Superseded by 2')).toBeTruthy();
  expect(screen.queryByText('Revised proposal')).toBeNull();
  expect(screen.getByRole('heading', { name: 'Plan 2 · For your approval' })).toBeTruthy();
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

test('a long thread opens with the current plan and keeps earlier messages in closed history', () => {
  const value = goal();
  value.conversation!.messages.push(...Array.from({ length: 31 }, (_, i) => ({ id: `history-${i}`, sequence: i + 10, author: 'supervisor' as const, kind: 'progress' as const, text: `Progress update ${i}`, revision: 1, delivery: 'delivered' as const })));
  render(<GoalConversation goal={value} disabled={false} act={vi.fn()} next={null} onNextConsumed={vi.fn()} />);
  const article = screen.getByRole('article', { name: 'Goal conversation' });
  expect(article.firstElementChild).toBe(screen.getByRole('region', { name: 'Proposal revision 1' }));
  const history = screen.getByLabelText('Conversation history') as HTMLDetailsElement;
  expect(history.open).toBe(false);
  expect(within(history).getByText('Progress update 0')).toBeTruthy();
  expect(within(history).queryByText('Progress update 30')).toBeNull();
  expect(within(screen.getByRole('log')).getByText('Progress update 30')).toBeTruthy();
  expect(history.querySelector('[aria-label="Proposal revision 1"]')).toBeNull();
});

test('publication opens with result evidence and keeps the approved plan collapsed', () => {
  const value = goal(); value.status = 'ready_to_publish'; value.approvedRevision = value.revision;
  render(<GoalConversation goal={value} disabled={false} act={vi.fn()} next={null} onNextConsumed={vi.fn()} />);
  expect(screen.getByRole('article', { name: 'Goal conversation' }).firstElementChild).toBe(screen.getByRole('region', { name: 'Goal result' }));
  expect(screen.getByText('Approved plan 1').closest('details')?.open).toBe(false);
});

test('a retained revision draft cannot become a supervisor message when refresh removes revision authority', async () => {
  const value = goal(), act = vi.fn().mockResolvedValue(true), onNextConsumed = vi.fn();
  const next = { type: 'request_revision' as const, label: 'Fix verification plan', context: 'Correct the unavailable spec check.' };
  const view = render(<GoalConversation goal={value} disabled={false} act={act} next={next} onNextConsumed={onNextConsumed} />);
  fireEvent.change(screen.getByLabelText('Request a revision'), { target: { value: 'Keep this revision guidance.' } });
  const refreshed = { ...value, version: value.version + 1, actions: value.actions.filter(action => action.type !== 'request_revision') };
  expect(refreshed.actions.some(action => action.type === 'send_goal_message')).toBe(true);
  view.rerender(<GoalConversation goal={refreshed} disabled={false} act={act} next={null} onNextConsumed={onNextConsumed} />);
  const draft = screen.getByLabelText('Request a revision') as HTMLTextAreaElement;
  expect(draft.value).toBe('Keep this revision guidance.');
  expect(draft.disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Send revision request' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull();
  fireEvent.submit(draft.closest('form')!);
  expect(act).not.toHaveBeenCalled();
  view.rerender(<GoalConversation goal={value} disabled={false} act={act} next={null} onNextConsumed={onNextConsumed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Send revision request' }));
  expect(act).toHaveBeenCalledWith(value, expect.objectContaining({ type: 'request_revision', payload: { message: 'Keep this revision guidance.' } }));
  await waitFor(() => expect(screen.getByLabelText('Message your supervisor')).toHaveProperty('value', ''));
});
