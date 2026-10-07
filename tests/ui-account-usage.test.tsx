import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { AccountUsageView, nextUnusedReset, resetText } from '../app/account-usage';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const instant = '2026-10-07T07:55:00Z';
type Snapshot = NonNullable<Parameters<typeof nextUnusedReset>[0]>;
function fixture(): Snapshot {
  return { generatedAt: new Date().toISOString(), available: true, source: 'CCS', summary: { ready: 0, low: 1, exhausted: 0, reconnect: 0, unavailable: 0 }, providers: [{ id: 'claude', label: 'Claude Code', available: true, accounts: [{
    id: 'sample', email: 'sample@example.test', label: 'sample', plan: 'max', paused: true, isDefault: false, message: null, status: 'low', updatedAt: instant,
    windows: [
      { id: 'session', cadence: '5h', category: 'usage', label: 'Session limit', remainingPercent: 100, resetAt: null, reported: true },
      { id: 'week', cadence: 'weekly', category: 'usage', label: 'Weekly limit', remainingPercent: 5, resetAt: '2026-10-07T08:00:00Z', reported: true },
      { id: 'fable', cadence: 'weekly', category: 'additional', label: 'Fable weekly limit', remainingPercent: 4, resetAt: '2026-10-07T08:00:00Z', reported: true },
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
  expect(screen.getAllByText('Resets in 5m')).toHaveLength(3);
  expect(screen.getByRole('complementary', { name: 'Next reset with unused quota' }).textContent).toContain('5% unused');
  expect(screen.getByText('Weekly limit · Paused in CCS')).toBeTruthy();
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
  expect(screen.getByText('No upcoming reset with unused quota is reported in fresh readings.')).toBeTruthy();
  failed = false;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
  expect(screen.getByText('95% used')).toBeTruthy();
});

test('chooses the earliest overall reset across accounts/providers, then the most unused on ties', () => {
  const now = Date.parse(instant);
  const usage = fixture();
  usage.generatedAt = instant;
  const source = usage.providers[0].accounts[0];
  const other = { ...structuredClone(source), id: 'other', email: 'other@example.test', paused: false };
  other.windows[1].resetAt = '2026-10-07T07:58:00Z';
  other.windows[1].remainingPercent = 70;
  usage.providers.push({ id: 'codex', label: 'OpenAI Codex', available: true, accounts: [other] });
  expect(nextUnusedReset(usage, now)?.account.id).toBe('other');
  other.windows[1].resetAt = source.windows[1].resetAt;
  expect(nextUnusedReset(usage, now)?.account.id).toBe('other');
  other.windows[1].remainingPercent = 5;
  expect(nextUnusedReset(usage, now)?.account.id).toBe('sample');
  source.windows[2].resetAt = '2026-10-07T07:56:00Z';
  expect(nextUnusedReset(usage, now)?.window.id).toBe('week');
  expect(nextUnusedReset(usage, Date.parse('2026-10-07T08:00:00Z'))).toBeNull();
});

test('excludes stale, failed, empty, invalid and fully used readings from the next reset', () => {
  const changes: Array<(usage: Snapshot) => void> = [
    usage => { usage.available = false; },
    usage => { usage.generatedAt = '2026-10-07T07:30:00Z'; },
    usage => { usage.providers[0].available = false; },
    usage => { usage.providers[0].accounts[0].updatedAt = null; },
    usage => { usage.providers[0].accounts[0].updatedAt = '2026-10-07T07:30:00Z'; },
    usage => { usage.providers[0].accounts[0].status = 'reconnect'; },
    usage => { usage.providers[0].accounts[0].status = 'unavailable'; },
    usage => { usage.providers[0].accounts[0].windows[1].remainingPercent = 0; },
    usage => { usage.providers[0].accounts[0].windows[1].remainingPercent = Number.NaN; },
    usage => { usage.providers[0].accounts[0].windows[1].remainingPercent = 101; },
    usage => { usage.providers[0].accounts[0].windows[1].resetAt = null; },
    usage => { usage.providers[0].accounts[0].windows[1].resetAt = 'invalid'; },
    usage => { usage.providers[0].accounts[0].windows[1].resetAt = instant; },
    usage => { usage.providers[0].accounts[0].windows = []; },
  ];
  expect(nextUnusedReset(null, Date.parse(instant))).toBeNull();
  for (const change of changes) {
    const usage = fixture(); usage.generatedAt = instant; change(usage);
    expect(nextUnusedReset(usage, Date.parse(instant))).toBeNull();
  }
});

test('labels exhaustion elsewhere without implying an account is usable, and removes elapsed resets', async () => {
  await setup(async () => {
    const usage = fixture(); usage.providers[0].accounts[0].status = 'exhausted';
    usage.providers[0].accounts[0].windows[0].remainingPercent = 0;
    return new Response(JSON.stringify(usage));
  });
  expect(screen.getByText(/Another usage limit is exhausted/)).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
  expect(screen.getByText('No upcoming reset with unused quota is reported in fresh readings.')).toBeTruthy();
});

test('deleting the highlighted account clears its next-reset summary after confirmation', async () => {
  let deleted = false;
  await setup(async () => {
    const usage = fixture();
    if (deleted) usage.providers[0].accounts = [];
    return new Response(JSON.stringify(usage));
  });
  fireEvent.click(screen.getByText('Details'));
  fireEvent.click(screen.getByRole('button', { name: 'Delete connection' }));
  deleted = true;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' })); });
  expect(screen.queryByRole('link', { name: /sample@example.test/ })).toBeNull();
  expect(screen.getByText('No upcoming reset with unused quota is reported in fresh readings.')).toBeTruthy();
});
