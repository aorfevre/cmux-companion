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
  vi.stubGlobal('EventSource', class {
    listeners: Record<string, () => void> = {}; close = vi.fn();
    constructor() { stream = { close: this.close, listeners: this.listeners }; }
    addEventListener(type: string, fn: () => void) { this.listeners[type] = fn; }
  });
  api.mockReset().mockImplementation(async (url, options) => {
    if (url.endsWith('/pair')) { paired = true; return {}; }
    if (!paired) throw new ApiError('Unauthorized', 401, 'UNAUTHORIZED');
    if (url.endsWith('/configuration')) return { ...config, readOnly };
    if (url.endsWith('/snapshot')) return { goals: [], cursor: 0, journalId: 'journal', readOnly };
    if (options?.method === 'POST') return {};
    throw new Error(`Unexpected ${url}`);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function start() {
  render(<GoalBoard />);
  await screen.findByRole('heading', { name: 'Start a goal' });
  fireEvent.change(screen.getByLabelText('What should we accomplish?'), { target: { value: 'A useful goal' } });
}
test('pairs through the service and disables all creation controls in read-only mode', async () => {
  paired = false; readOnly = true;
  render(<GoalBoard />);
  fireEvent.change(await screen.findByLabelText('Pairing token'), { target: { value: 'disposable' } });
  fireEvent.click(screen.getByRole('button', { name: 'Pair device' }));
  await screen.findByText('Read-only mode · controls are disabled.');
  expect(screen.getByRole('button', { name: 'Start planning' })).toHaveProperty('disabled', true);
  expect(screen.getByLabelText('Repository')).toHaveProperty('disabled', true);
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
  fireEvent.click(screen.getByRole('button', { name: 'Start planning' }));
  const retry = await screen.findByRole('button', { name: 'Retry pending request' });
  await waitFor(() => expect(retry).toHaveProperty('disabled', false));
  expect(screen.getByRole('button', { name: 'Start planning' })).toHaveProperty('disabled', true);
  fireEvent.click(retry);
  await waitFor(() => expect(commands).toHaveLength(2));
  expect(commands[1]).toBe(commands[0]);
  expect(JSON.parse(commands[0])).toMatchObject({ expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'A useful goal' } });
});
test('a definitive stale conflict refreshes and allows a new deliberate command', async () => {
  await start(); const original = api.getMockImplementation()!;
  api.mockImplementation(async (url, options) => { if (url.endsWith('/commands')) throw new ApiError('Stale', 409, 'VERSION_CONFLICT'); return original(url, options); });
  fireEvent.click(screen.getByRole('button', { name: 'Start planning' }));
  await screen.findByText(/The goal changed/);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start planning' })).toHaveProperty('disabled', false));
  expect(screen.queryByRole('button', { name: 'Retry pending request' })).toBeNull();
});
test('stream resync refreshes authoritative state and unmount closes the stream', async () => {
  const view = render(<GoalBoard />);
  await screen.findByRole('heading', { name: 'Start a goal' });
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
  fireEvent.click(screen.getByRole('button', { name: /Goal B/ }));
  await waitFor(() => expect(finishB).toBeTypeOf('function'));
  finishCommand({});
  await screen.findByText('Saved. Showing the service’s current state.');
  finishB(b);
  await screen.findByRole('heading', { name: 'Goal B' });
});
