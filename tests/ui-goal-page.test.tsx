import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GoalPage } from '../app/orchestration/goal-page';
import { goalView } from '../server/orchestration/domain/state-view.mjs';
import { fixture, contract } from './helpers/orchestration/domain-fixture.mjs';

afterEach(cleanup);
const props = { disabled: false, terminal: false, act: vi.fn(async () => true), control: vi.fn(async () => {}), pendingNext: null, onNextConsumed: vi.fn() };

test('a legacy goal renders the shared layout: bar, request, collapsed contract, revision composer and technical details', () => {
  const f = fixture(); f.command('publish_contract', { contract: contract() }, f.user);
  const goal = { ...goalView(f.goal), description: 'Build the modules\nhttps://example.com/design', contracts: f.goal.contracts };
  render(<GoalPage {...props} goal={goal} />);
  expect(screen.getByRole('region', { name: 'Goal decision' })).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Your request' }).textContent).toContain('https://example.com/design');
  expect(screen.queryByLabelText('Message delivery')).toBeNull();
  const proposal = screen.getByRole('region', { name: 'Proposal revision 1' });
  expect(within(proposal).getByText('1 scope item · 1 acceptance criterion · 1 check · 3 tasks')).toBeTruthy();
  expect(screen.queryByRole('tab')).toBeNull();
  fireEvent.change(screen.getByLabelText('Request a revision'), { target: { value: 'Narrow the scope.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send revision request' }));
  expect(props.act).toHaveBeenCalledWith(goal, expect.objectContaining({ type: 'request_revision', payload: { message: 'Narrow the scope.' } }));
  const details = screen.getByRole('group', { name: 'Technical details' }) as HTMLDetailsElement;
  expect(details.open).toBe(false);
  details.open = true;
  for (const heading of ['Source', 'Waves and sessions', 'Team and models', 'Run report', 'Activity']) expect(within(details).getByRole('heading', { name: heading })).toBeTruthy();
  expect(within(details).getByRole('button', { name: 'Reconcile workers' })).toBeTruthy();
});

test('a pending next step prefills and focuses the composer, then is consumed', () => {
  const f = fixture(); f.command('publish_contract', { contract: contract() }, f.user);
  const goal = { ...goalView(f.goal), contracts: f.goal.contracts };
  const onNextConsumed = vi.fn();
  render(<GoalPage {...props} goal={goal} onNextConsumed={onNextConsumed} pendingNext={{ type: 'request_revision', label: 'Request revision', context: 'high: Wrong value. Return two' }} />);
  const box = screen.getByLabelText('Request a revision') as HTMLTextAreaElement;
  expect(box.value).toBe('high: Wrong value. Return two\n\n');
  expect(document.activeElement).toBe(box);
  expect(onNextConsumed).toHaveBeenCalled();
});

test('a next step chosen from the bar reaches the composer on the same page', () => {
  const f = fixture(); f.command('publish_contract', { contract: contract() }, f.user);
  f.request('plan_review', 'reviewer'); f.dispatch('plan_review'); f.review('plan_review', `contract:${f.goal.generation}:${f.goal.revision}`, true);
  const goal = { ...goalView(f.goal), contracts: f.goal.contracts };
  expect(goal.decision.next?.type).toBe('request_revision');
  render(<GoalPage {...props} goal={goal} />);
  fireEvent.click(within(screen.getByRole('region', { name: 'Goal decision' })).getByRole('button', { name: 'Request revision' }));
  const box = screen.getByLabelText('Request a revision') as HTMLTextAreaElement;
  expect(box.value).toContain('high: Incorrect value. Return the required value');
  expect(document.activeElement).toBe(box);
});

test('a legacy planner question renders its answer form above the composer and a question next step focuses it', () => {
  const goal = { ...goalView(fixture().goal), contracts: [], clarification: { question: 'Which module first?' }, actions: [{ type: 'answer_clarification', label: 'Send answer', payload: { answer: '' } }, { type: 'request_revision', label: 'Request revision', payload: {} }] };
  render(<GoalPage {...props} goal={goal} pendingNext={{ type: 'answer_clarification', label: 'Answer question' }} />);
  expect(screen.getByText('Which module first?')).toBeTruthy();
  const box = screen.getByLabelText('Your answer') as HTMLTextAreaElement;
  expect(document.activeElement).toBe(box);
  fireEvent.change(box, { target: { value: 'A' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  expect(props.act).toHaveBeenCalledWith(goal, expect.objectContaining({ type: 'answer_clarification', payload: { answer: 'A' } }));
});

test('a conversational goal keeps its thread and supervisor composer', () => {
  const f = fixture();
  const goal = { ...goalView({ ...f.goal, experienceVersion: 2, conversation: { messages: [{ id: 'm1', sequence: 1, author: 'user', kind: 'message', text: 'Hello', revision: 0, delivery: 'answered' }], supervisorAttemptId: null, wake: 1, seenWake: 0, waiting: false, paused: false, dispatchApproved: false } } as never), contracts: [], actions: [{ type: 'send_goal_message', label: 'Send message', payload: { message: '' } }] };
  render(<GoalPage {...props} goal={goal} />);
  expect(screen.getByLabelText('Message your supervisor')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Your request' })).toBeNull();
  expect(screen.getByText('Hello')).toBeTruthy();
});

test('fixing an unsupported check prepares a revision without approving or retrying, even for conversational goals', async () => {
  const f = fixture(); f.approve();
  f.goal.experienceVersion = 2;
  f.goal.conversation = { messages: [], supervisorAttemptId: null, wake: 1, seenWake: 0, waiting: false, paused: false, dispatchApproved: true };
  f.command('adopt_agent_recovery', {}, f.user);
  f.goal.verificationRuns = [{ operationId: 'bad-check', generation: f.goal.generation, revision: f.goal.revision, status: 'complete', workerState: 'stopped', headSha: f.goal.integrationHead, result: { verification: { headSha: f.goal.integrationHead, checks: [{ id: 'unit', passed: false, code: 'UNSUPPORTED_CAPABILITY', artifactId: 'proof' }] } } }];
  f.goal.hold = { id: 'setup', reasons: [{ kind: 'verification', target: 'bad-check', message: 'Check setup needs attention' }] };
  const goal = { ...goalView(f.goal), contracts: f.goal.contracts }, act = vi.fn(async () => true);
  render(<GoalPage {...props} goal={goal} act={act} />);
  const bar = screen.getByRole('region', { name: 'Goal decision' });
  expect(within(bar).getByText(/Retrying the unchanged plan/)).toBeTruthy();
  const evidence = screen.getByRole('region', { name: 'Blocked checks' });
  expect(within(evidence).getByText('node --test')).toBeTruthy();
  expect(within(evidence).getByText('UNSUPPORTED_CAPABILITY')).toBeTruthy();
  expect(within(evidence).getByRole('button', { name: 'Inspect check output' })).toBeTruthy();
  fireEvent.click(within(bar).getByRole('button', { name: 'Fix verification plan' }));
  expect(act).not.toHaveBeenCalled();
  const draft = screen.getByLabelText('Request a revision') as HTMLTextAreaElement;
  expect(document.activeElement).toBe(draft);
  expect(draft.value).toContain('unit: ["node","--test"]');
  fireEvent.click(screen.getByRole('button', { name: 'Send revision request' }));
  expect(act).toHaveBeenCalledWith(goal, expect.objectContaining({ type: 'request_revision', payload: { message: draft.value.trim() } }));
  await vi.waitFor(() => expect(screen.getByLabelText('Message your supervisor')).toHaveProperty('value', ''));
});
