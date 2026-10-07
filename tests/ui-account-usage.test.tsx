import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { AccountUsageView, resetText } from '../app/account-usage';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const instant = '2026-10-07T07:55:00Z';
function fixture() {
  return { generatedAt: new Date().toISOString(), available: true, source: 'CCS', summary: { low: 1 }, providers: [{ id: 'claude', label: 'Claude Code', available: true, accounts: [{
    id: 'sample', email: 'sample@example.test', label: 'sample', plan: 'max', paused: true, status: 'low', updatedAt: instant,
    windows: [
      { id: 'session', cadence: '5h', category: 'usage', label: 'Session limit', remainingPercent: 100, resetAt: null },
      { id: 'week', cadence: 'weekly', category: 'usage', label: 'Weekly limit', remainingPercent: 5, resetAt: '2026-10-07T08:00:00Z' },
      { id: 'fable', cadence: 'weekly', category: 'additional', label: 'Fable weekly limit', remainingPercent: 4, resetAt: '2026-10-07T08:00:00Z' },
    ],
  }] }] };
}
async function setup(handler = async () => new Response(JSON.stringify(fixture()))) {
  vi.useFakeTimers(); vi.setSystemTime(new Date(instant));
  const fetch = vi.fn(handler); vi.stubGlobal('fetch', fetch);
  render(<AccountUsageView />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return fetch;
}

test('compares Claude used quota with remaining capacity and keeps Fable separate', async () => {
  await setup();
  expect(screen.getByText('95% used')).toBeTruthy();
  expect(screen.getByText('0% used')).toBeTruthy();
  expect(screen.getByText('weekly · 96% used')).toBeTruthy();
  expect(screen.getByText('4% remaining')).toBeTruthy();
  expect(screen.getByText('Fable weekly limit')).toBeTruthy();
  expect(screen.getAllByText('Resets in 5m')).toHaveLength(2);
  expect(resetText(null, Date.now())).toBe('Reset unknown');
  expect(resetText(instant, Date.now())).toBe('Reset due');
  expect(resetText('invalid', Date.now())).toBe('Reset unknown');
});

test('polls only visible pages and refreshes on return without overlapping reads', async () => {
  let finish: ((response: Response) => void) | undefined;
  let calls = 0;
  const fetch = await setup(async () => ++calls > 1 ? new Promise<Response>(resolve => { finish = resolve; }) : new Response(JSON.stringify(fixture())));
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetch).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue('visible');
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => { finish!(new Response(JSON.stringify(fixture()))); });
  cleanup();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('a new envelope cannot turn a stale account reading into available capacity', async () => {
  await setup();
  await act(async () => { await vi.advanceTimersByTimeAsync(16 * 60_000); });
  expect(screen.getByText('Unknown')).toBeTruthy();
  expect(screen.queryByText('95% used')).toBeNull();
  expect(screen.getByText('Updated 16m ago')).toBeTruthy();
  expect(screen.queryByText('Fresh snapshot')).toBeNull();
});

test('a failed refresh hides capacity until a successful retry', async () => {
  let failed = false;
  await setup(async () => failed ? new Response(JSON.stringify({ error: 'Provider unavailable' }), { status: 503 }) : new Response(JSON.stringify(fixture())));
  failed = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(screen.getByText('Provider unavailable')).toBeTruthy();
  expect(screen.getByText('Unknown')).toBeTruthy();
  expect(screen.queryByText('95% used')).toBeNull();
  failed = false;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
  expect(screen.getByText('95% used')).toBeTruthy();
});
