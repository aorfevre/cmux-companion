import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GoalBoard } from '../app/orchestration/goal-board';
import { ApiError, request } from '../app/api-request';
vi.mock('../app/api-request', async importOriginal => ({ ...await importOriginal<typeof import('../app/api-request')>(), request: vi.fn() }));
const api = vi.mocked(request);
const config = { readOnly: false, terminal: false, limits: { global: 4, perGoal: 2, planners: 1 }, capabilities: [{ role: 'planner', mode: 'interactive' }], repositories: [{ id: 'repo', baseBranch: 'main', baseSha: 'a'.repeat(40), error: null }] };
let readOnly = false, paired = true;
let stream: { onopen?: () => void; onerror?: () => void; close: ReturnType<typeof vi.fn>; listeners: Record<string, () => void> };
beforeEach(() => {
  readOnly = false; paired = true;
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  vi.stubGlobal('EventSource', class {
    listeners: Record<string, () => void> = {}; close = vi.fn();
    constructor() { stream = { close: this.close, listeners: this.listeners }; }
    addEventListener(type: string, fn: () => void) { this.listeners[type] = fn; }
  });
  api.mockReset().mockImplementation(async (url, options) => {
    if (url.endsWith('/favorites')) return { revision: 0, ids: [] };
    if (url.endsWith('/pair')) { paired = true; return {}; }
    if (!paired) throw new ApiError('Unauthorized', 401, 'UNAUTHORIZED');
    if (url.endsWith('/configuration')) return { ...config, readOnly };
    if (url.endsWith('/snapshot')) return { goals: [], cursor: 0, journalId: 'journal', readOnly };
    if (options?.method === 'POST') return {};
    throw new Error(`Unexpected ${url}`);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });
async function start() {
  render(<GoalBoard />);
  fireEvent.click(await screen.findByRole('button', { name: 'Start a goal' }));
  fireEvent.click(screen.getByRole('button', { name: 'Project Choose a project' }));
  fireEvent.click(await screen.findByRole('button', { name: /Show all projects/ }));
  fireEvent.click(screen.getAllByRole('button', { name: /^(repo Individual project|Example karven)$/ })[0]);
  fireEvent.change(screen.getByLabelText('What should we accomplish?'), { target: { value: 'A useful goal' } });
}
test('pairs through the service and disables all creation controls in read-only mode', async () => {
  paired = false; readOnly = true;
  render(<GoalBoard />);
  fireEvent.change(await screen.findByLabelText('Pairing code'), { target: { value: 'disposable' } });
  fireEvent.click(screen.getByRole('button', { name: 'Pair this device' }));
  await screen.findByText('Read-only mode · controls are disabled.');
  expect(screen.getByRole('button', { name: 'Start a goal' })).toHaveProperty('disabled', true);
  expect(screen.queryByRole('button', { name: 'Project Choose a project' })).toBeNull();
  expect(api).toHaveBeenCalledWith('/api/orchestration/pair', expect.objectContaining({ body: JSON.stringify({ token: 'disposable' }) }));
});
test('uncertain command retries exactly the original id, payload and expected version', async () => {
  await start();
  const original = api.getMockImplementation()!;
  const commands: string[] = [];
  api.mockImplementation(async (url, options) => {
    if (url.endsWith('/commands')) { commands.push(String(options?.body)); throw new Error('Network disconnected'); }
    return original(url, options);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start goal' }));
  const retry = await screen.findByRole('button', { name: 'Retry pending request' });
  await waitFor(() => expect(retry).toHaveProperty('disabled', false));
  expect(screen.getByRole('button', { name: 'Start goal' })).toHaveProperty('disabled', true);
  fireEvent.click(retry);
  await waitFor(() => expect(commands).toHaveLength(2));
  expect(commands[1]).toBe(commands[0]);
  expect(JSON.parse(commands[0])).toMatchObject({ expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'A useful goal' } });
});
test('a definitive stale conflict refreshes and allows a new deliberate command', async () => {
  await start(); const original = api.getMockImplementation()!;
  api.mockImplementation(async (url, options) => { if (url.endsWith('/commands')) throw new ApiError('Stale', 409, 'VERSION_CONFLICT'); return original(url, options); });
  fireEvent.click(screen.getByRole('button', { name: 'Start goal' }));
  await screen.findByText(/The goal changed/);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start goal' })).toHaveProperty('disabled', false));
  expect(screen.queryByRole('button', { name: 'Retry pending request' })).toBeNull();
});
test('provider readiness errors retain actionable settings guidance', async () => {
  await start(); const original = api.getMockImplementation()!;
  api.mockImplementation(async (url, options) => { if (url.endsWith('/commands')) throw new ApiError('Configure a supported provider in Settings', 409, 'NOT_READY'); return original(url, options); });
  fireEvent.click(screen.getByRole('button', { name: 'Start goal' }));
  await screen.findByText('Configure a supported provider in Settings');
  expect(screen.queryByText(/The goal changed/)).toBeNull();
});
test('stream resync refreshes authoritative state and unmount closes the stream', async () => {
  const view = render(<GoalBoard />);
  fireEvent.click(await screen.findByRole('button', { name: 'Start a goal' }));
  const before = api.mock.calls.length;
  stream.listeners.resync();
  await waitFor(() => expect(api.mock.calls.length).toBeGreaterThan(before));
  view.unmount(); expect(stream.close).toHaveBeenCalledOnce();
});

test('failed revision feedback remains editable until the service confirms success', async () => {
  const { GoalDetail } = await import('../app/orchestration/goal-detail');
  const { goalView } = await import('../server/orchestration/domain/state-view.mjs');
  const { fixture } = await import('./helpers/orchestration/domain-fixture.mjs');
  const f = fixture();
  const goal = { ...goalView(f.goal), contracts: [], actions: [{ type: 'request_revision', label: 'Request revision', payload: {} }] };
  const act = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<GoalDetail goal={goal} disabled={false} terminal={false} act={act} control={vi.fn()} />);
  const feedback = screen.getByLabelText('Revision feedback');
  fireEvent.change(feedback, { target: { value: 'Preserve this detailed correction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Request revision' }));
  await waitFor(() => expect(act).toHaveBeenCalledTimes(1));
  expect(feedback).toHaveProperty('value', 'Preserve this detailed correction');
  fireEvent.click(screen.getByRole('button', { name: 'Request revision' }));
  await waitFor(() => expect(feedback).toHaveProperty('value', ''));
});

test('moved publication target shows the observed commit and submits the service-projected acceptance', async () => {
  const { GoalDetail } = await import('../app/orchestration/goal-detail');
  const { goalView } = await import('../server/orchestration/domain/state-view.mjs');
  const { fixture } = await import('./helpers/orchestration/domain-fixture.mjs');
  const goal = { ...goalView(fixture().goal), contracts: [], actions: [{ type: 'accept_moved_target', label: 'Publish reviewed head against moved target', payload: { operationId: 'publish', baseHeadSha: 'b'.repeat(40) } }],
    publication: { approved: true, branch: 'companion-goals/goal', baseBranch: 'main', baseSha: 'a'.repeat(40), observation: { status: 'target_moved' as const, baseHeadSha: 'b'.repeat(40), pr: null } } };
  const act = vi.fn().mockResolvedValue(true);
  render(<GoalDetail goal={goal} disabled={false} terminal={false} act={act} control={vi.fn()} />);
  expect(screen.getByText('bbbbbbbbbbbb')).toBeTruthy();
  expect(screen.getByText(/Publishing keeps the reviewed and verified head/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Publish reviewed head against moved target' }));
  expect(act).toHaveBeenCalledWith(goal, goal.actions[0]);
});

test('finishing a command for A does not invalidate the selected B detail request', async () => {
  const { goalView } = await import('../server/orchestration/domain/state-view.mjs');
  const { fixture } = await import('./helpers/orchestration/domain-fixture.mjs');
  const base = goalView(fixture().goal);
  const a = { ...base, id: 'A', title: 'Goal A', contracts: [] }, b = { ...base, id: 'B', title: 'Goal B', contracts: [] };
  let finishCommand!: (value: unknown) => void, finishB!: (value: unknown) => void;
  const original = api.getMockImplementation()!;
  api.mockImplementation(async (url, options) => {
    if (url.endsWith('/snapshot')) return { goals: [a, b], cursor: 1, journalId: 'journal', readOnly: false };
    if (url.endsWith('/goals/A')) return a;
    if (url.endsWith('/goals/B')) return new Promise(resolve => { finishB = resolve; });
    if (url.endsWith('/commands')) return new Promise(resolve => { finishCommand = resolve; });
    return original(url, options);
  });
  render(<GoalBoard />);
  fireEvent.click(await screen.findByRole('button', { name: /Goal A/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Abort goal' }));
  fireEvent.click(screen.getByRole('button', { name: /Back to Mission Control/ }));
  fireEvent.click(screen.getByRole('button', { name: /Goal B/ }));
  await waitFor(() => expect(finishB).toBeTypeOf('function'));
  finishCommand({});
  await screen.findByText('Saved. Showing the service’s current state.');
  finishB(b);
  await screen.findByRole('heading', { name: 'Goal B' });
});

test('automatic discovery keeps disabled repositories visible and reports partial refresh without enabling work', async () => {
  const original = api.getMockImplementation()!;
  api.mockImplementation(async (url, options) => {
    if (url.endsWith('/configuration')) return { ...config, repositories: [{ ...config.repositories[0], name: 'Example', devRepoName: 'karven', enabled: false, error: 'This repository is disabled.' }] };
    if (url.endsWith('/reconcile')) return { scans: { root: { partial: true, reason: 'Scan limit reached.' } } };
    return original(url, options);
  });
  await start(); await screen.findByText(/Scan limit reached/);
  expect(screen.getByRole('button', { name: 'Project Example karven' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Start goal' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('link', { name: 'Configure repository' }).getAttribute('href')).toBe('/settings?repository=repo#dev-repos');
});

test('goal details preserve the request, edit only the title, and hide empty evidence', async () => {
  const { GoalDetail } = await import('../app/orchestration/goal-detail');
  const { goalView } = await import('../server/orchestration/domain/state-view.mjs');
  const { fixture } = await import('./helpers/orchestration/domain-fixture.mjs');
  const goal = { ...goalView(fixture().goal), title: 'Short title', description: 'Complete request\nhttps://example.com/design', contracts: [], actions: [{ type: 'rename_goal', label: 'Rename goal', payload: { title: 'Short title' } }] };
  const act = vi.fn().mockResolvedValue(true);
  render(<GoalDetail goal={goal} disabled={false} terminal={false} act={act} control={vi.fn()} />);
  expect(screen.getByText(/Complete request/).textContent).toContain('https://example.com/design');
  expect(screen.queryByText('Independent reviews')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Combined verification' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Task board' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit title' }));
  fireEvent.change(screen.getByLabelText('Goal title'), { target: { value: 'Better title' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save title' }));
  expect(act).toHaveBeenCalledWith(goal, expect.objectContaining({ type: 'rename_goal', payload: { title: 'Better title' } }));
});

test('task board exposes dependencies, failures and optional graph', async () => {
  const { TaskKanban } = await import('../app/orchestration/kanban');
  const { goalView } = await import('../server/orchestration/domain/state-view.mjs');
  const { fixture } = await import('./helpers/orchestration/domain-fixture.mjs');
  const base = goalView(fixture().goal);
  const goal = { ...base, tasks: (['integrated', 'running', 'in_review', 'failed'] as const).map((status, i) => ({ id: String(i), title: `Task ${i}`, status, dependsOn: i ? ['0'] : [], candidateSha: null, integratedSha: null, repairCount: 0, repairLimit: 2 })) };
  render(<TaskKanban goal={goal} />);
  expect(screen.getByRole('button', { name: 'Done (1)' })).toBeTruthy();
  expect(screen.getAllByText('Depends on 0')).toHaveLength(3);
  expect(screen.getByText('Needs attention · failed')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Running (1)' }));
  expect(screen.getByRole('region', { name: 'Tasks Running' }).getAttribute('data-active')).toBe('true');
  expect(screen.getByText('Dependency graph').closest('details')).toHaveProperty('open', false);
});

test('creation submits a full request from main without the current checkout SHA and stays on the board', async () => {
  const original = api.getMockImplementation()!;
  api.mockImplementation(async (url, options) => {
    if (url.endsWith('/configuration')) return { ...config, repositories: [{ ...config.repositories[0], baseSha: null, baseBranch: 'feature/local' }] };
    return original(url, options);
  });
  await start();
  expect(screen.getByText('Starts from freshly fetched main in an isolated worktree.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Start goal' }));
  await screen.findByText('Goal saved. Its planning agent will start automatically.');
  const body = JSON.parse(String(api.mock.calls.find(([url]) => url.endsWith('/commands'))?.[1]?.body));
  expect(body.payload).toEqual({ title: 'A useful goal', description: 'A useful goal', repositoryId: 'repo', baseBranch: 'main' });
  expect(screen.queryByLabelText('What should we accomplish?')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Start a goal' }));
  expect(screen.getByLabelText('What should we accomplish?')).toHaveProperty('value', '');
  expect(screen.queryByText('Loading goal…')).toBeNull();
});

test('clarification answers preserve feedback on failure and use the projected action', async () => {
  const { GoalDetail } = await import('../app/orchestration/goal-detail');
  const { goalView } = await import('../server/orchestration/domain/state-view.mjs');
  const { fixture } = await import('./helpers/orchestration/domain-fixture.mjs');
  const base = goalView(fixture().goal);
  const goal = { ...base, contracts: [], clarification: { question: 'Which audience?' }, actions: [{ type: 'answer_clarification', label: 'Answer', payload: {} }] };
  const act = vi.fn().mockResolvedValue(false);
  render(<GoalDetail goal={goal} disabled={false} terminal={false} act={act} control={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'New learners' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  await waitFor(() => expect(act).toHaveBeenCalledWith(goal, expect.objectContaining({ type: 'answer_clarification', payload: { answer: 'New learners' } })));
  expect(screen.getByLabelText('Your answer')).toHaveProperty('value', 'New learners');
});


test('terminal goals retain their result without stale attention from unanswered questions', async () => {
  const { attention } = await import('../app/orchestration/kanban');
  const { GoalFleet } = await import('../app/orchestration/goal-fleet');
  const { goalView } = await import('../server/orchestration/domain/state-view.mjs');
  const { fixture } = await import('./helpers/orchestration/domain-fixture.mjs');
  const base = goalView(fixture().goal);
  const goals = (['merged', 'aborted'] as const).map(status => ({ ...base, id: status, status, clarification: { question: 'Historical question' } }));
  for (const goal of goals) expect(attention(goal)).toBeNull();
  render(<GoalFleet goals={goals} select={vi.fn()} projectName={() => 'Example'} />);
  expect(screen.getByText('Aborted')).toBeTruthy();
  expect(screen.queryByText(/Needs attention/)).toBeNull();
});


test('Mission Control opens first and cancelling creation restores focus and retains the draft', async () => {
  render(<GoalBoard />);
  const startButton = await screen.findByRole('button', { name: 'Start a goal' });
  expect(screen.getByRole('region', { name: 'Goal fleet' })).toBeTruthy();
  expect(screen.queryByLabelText('What should we accomplish?')).toBeNull();
  fireEvent.click(startButton);
  expect(screen.getByRole('heading', { name: 'Start a goal' })).toBe(document.activeElement);
  fireEvent.change(screen.getByLabelText('What should we accomplish?'), { target: { value: 'Keep my draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(startButton).toBe(document.activeElement);
  expect(screen.queryByLabelText('What should we accomplish?')).toBeNull();
  fireEvent.click(startButton);
  expect(screen.getByLabelText('What should we accomplish?')).toHaveProperty('value', 'Keep my draft');
});

test('a lost response remains retryable inside the goal workspace with the exact original command', async () => {
  const { goalView } = await import('../server/orchestration/domain/state-view.mjs');
  const { fixture } = await import('./helpers/orchestration/domain-fixture.mjs');
  const goal = { ...goalView(fixture().goal), id: 'modal-goal', title: 'Modal goal', contracts: [] };
  const original = api.getMockImplementation()!;
  const commands: string[] = [];
  api.mockImplementation(async (url, options) => {
    if (url.endsWith('/snapshot')) return { goals: [goal], cursor: 1, journalId: 'journal', readOnly: false };
    if (url.endsWith('/goals/modal-goal')) return goal;
    if (url.endsWith('/commands')) { commands.push(String(options?.body)); if (commands.length === 1) throw new Error('Connection lost'); return {}; }
    return original(url, options);
  });
  render(<GoalBoard />);
  fireEvent.click(await screen.findByRole('button', { name: /Modal goal/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Abort goal' }));
  const retry = await screen.findByRole('button', { name: 'Retry pending request' });
  expect(retry.closest('.mission-goal-workspace')).not.toBeNull();
  await waitFor(() => expect(retry).toHaveProperty('disabled', false));
  fireEvent.click(retry);
  await waitFor(() => expect(commands).toHaveLength(2));
  expect(commands[1]).toBe(commands[0]);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry pending request' })).toBeNull());
});

test('held goal shows failure and reconciliation guidance, then submits the exact recovery action', async () => {
  const { GoalDetail } = await import('../app/orchestration/goal-detail');
  const { goalView } = await import('../server/orchestration/domain/state-view.mjs');
  const { fixture } = await import('./helpers/orchestration/domain-fixture.mjs');
  const f = fixture(); f.request('planner', 'planner'); f.dispatch('planner');
  f.command('record_failure', { attemptId: 'planner', uncertain: true, error: 'Lost connection' });
  const act = vi.fn().mockResolvedValue(true);
  const view = render(<GoalDetail goal={{ ...goalView(f.goal), contracts: [] }} disabled={false} terminal={false} act={act} control={vi.fn()} />);
  expect(screen.getByText(/On hold/)).toBeTruthy();
  expect(screen.getByText(/Let active workers finish and reconcile/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Recover goal' })).toBeNull();
  f.command('record_stopped', { attemptId: 'planner' });
  const goal = { ...goalView(f.goal), contracts: [] };
  view.rerender(<GoalDetail goal={goal} disabled={false} terminal={false} act={act} control={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Recover goal' }));
  expect(act).toHaveBeenCalledWith(goal, goal.actions.find(action => action.type === 'recover_goal'));
});
