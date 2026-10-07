import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { AccountUsageView, nextUnusedReset, resetText, upcomingResets, usableBeforeReset } from '../app/account-usage';

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
  expect(screen.getAllByText('Resets in 5m')).toHaveLength(2);
  expect(screen.getByRole('complementary', { name: 'Next weekly reset' }).textContent).toContain('5% unused');
  expect(screen.getByRole('complementary', { name: 'Next weekly reset' }).textContent).toContain('Paused in CCS');
  expect(screen.getByRole('complementary', { name: 'Next weekly reset' }).textContent).toContain(new Date('2026-10-07T08:00:00Z').toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
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
  expect(screen.getAllByText('No upcoming weekly reset is reported in fresh readings.')[0]).toBeTruthy();
  failed = false;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
  expect(screen.getByText('95% used')).toBeTruthy();
});

test('chooses the earliest weekly reset across accounts/providers, then the most unused on ties', () => {
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
  expect(screen.getAllByText(/Usage limit exhausted/)[0]).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
  expect(screen.getAllByText('No upcoming weekly reset is reported in fresh readings.')[0]).toBeTruthy();
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
  expect(screen.getAllByText('No upcoming weekly reset is reported in fresh readings.')[0]).toBeTruthy();
});


test('keeps fully used resets in chronological order but suggests only unpaused usable accounts', () => {
  const usage = fixture(); usage.generatedAt = instant;
  const paused = usage.providers[0].accounts[0];
  const active = { ...structuredClone(paused), id: 'active', paused: false };
  active.windows[0].remainingPercent = 85; active.windows[0].resetAt = '2026-10-07T09:00:00Z';
  active.windows[1].remainingPercent = 60; active.windows[1].resetAt = '2026-10-12T09:00:00Z';
  const exhausted = { ...structuredClone(active), id: 'empty', status: 'exhausted' as const };
  exhausted.windows = [{ ...active.windows[1], remainingPercent: 0, resetAt: '2026-10-07T07:56:00Z' }];
  usage.providers[0].accounts.push(active, exhausted);
  const resets = upcomingResets(usage, Date.parse(instant));
  expect(resets.map(item => item.account.id)).toEqual(['empty', 'sample', 'active']);
  expect(resets.filter(item => usableBeforeReset(item, Date.parse(instant))).map(item => item.window.id)).toEqual(['week']);
  // An elapsed, invalid or exhausted companion limit cannot become a usage suggestion.
  for (const resetAt of [instant, 'invalid']) {
    active.windows[0].resetAt = resetAt;
    expect(usableBeforeReset(resets[2], Date.parse(instant))).toBe(false);
  }
  active.windows[0].resetAt = null;
  for (const remainingPercent of [0, Number.NaN, 101]) {
    active.windows[0].remainingPercent = remainingPercent;
    expect(usableBeforeReset(resets[2], Date.parse(instant))).toBe(false);
  }
});

test('filters usable capacity without changing reset order or hiding paused accounts from the default queue', async () => {
  await setup(async () => {
    const usage = fixture();
    const active = { ...structuredClone(usage.providers[0].accounts[0]), id: 'active', email: 'active@example.test', paused: false };
    active.windows[1].resetAt = '2026-10-07T09:00:00Z'; active.windows[1].remainingPercent = 85;
    usage.providers[0].accounts.push(active);
    return new Response(JSON.stringify(usage));
  });
  const queue = screen.getByRole('list', { name: 'Weekly reset queue' });
  expect(within(queue).getAllByRole('listitem')).toHaveLength(2);
  expect(within(queue).getAllByRole('link')[0].textContent).toContain('sample@example.test');
  expect(screen.getByRole('complementary', { name: 'Weekly capacity to use before reset' }).textContent).toContain('active@example.test');
  fireEvent.click(screen.getByRole('button', { name: 'Usable now' }));
  expect(within(queue).getAllByRole('listitem')).toHaveLength(1);
  expect(within(queue).getByRole('link').textContent).toContain('active@example.test');
  fireEvent.click(screen.getByRole('button', { name: 'Next reset' }));
  expect(within(queue).getAllByRole('listitem')).toHaveLength(2);
});

test('explains an empty usable queue without presenting paused capacity as a suggestion', async () => {
  await setup();
  fireEvent.click(screen.getByRole('button', { name: 'Usable now' }));
  expect(screen.queryByRole('list', { name: 'Weekly reset queue' })).toBeNull();
  expect(screen.getAllByText('No usable capacity with an upcoming weekly reset is reported.')).toHaveLength(2);
});


test.each([
  ['valid', '60% remaining · Resets in 2m'], ['missing reset', '60% remaining · Not reported'], ['missing', 'Not reported'], ['invalid', 'Not reported'], ['elapsed', 'Awaiting refresh'], ['bad reset', 'Awaiting refresh'],
])('shows Claude session context beside the primary weekly reset: %s', async (kind, expected) => {
  await setup(async () => {
    const usage = fixture();
    const account = usage.providers[0].accounts[0]; account.paused = false;
    account.windows[0].remainingPercent = kind === 'invalid' ? 101 : 60;
    account.windows[0].resetAt = '2026-10-07T07:57:00Z';
    if (kind === 'missing') account.windows.splice(0, 1);
    else if (kind === 'elapsed') account.windows[0].resetAt = instant;
    else if (kind === 'bad reset') account.windows[0].resetAt = 'invalid';
    else if (kind === 'missing reset') account.windows[0].resetAt = null;
    return new Response(JSON.stringify(usage));
  });
  const queue = screen.getByRole('list', { name: 'Weekly reset queue' });
  expect(within(queue).getAllByRole('listitem')).toHaveLength(1);
  expect(within(queue).getByRole('listitem').textContent).toContain(`5h: ${expected}`);
  expect(within(queue).getByRole('listitem').textContent).toContain('5% unused');
  expect(screen.getByRole('complementary', { name: 'Next weekly reset' }).textContent).toContain(`5h: ${expected}`);
  if (kind === 'valid' || kind === 'missing reset') expect(screen.getByRole('complementary', { name: 'Weekly capacity to use before reset' }).textContent).toContain('5h: 60% remaining');
});

test('weekly queue ignores earlier session and monthly resets and never substitutes a missing weekly limit', () => {
  const usage = fixture(); usage.generatedAt = instant;
  const account = usage.providers[0].accounts[0];
  account.windows[0].resetAt = '2026-10-07T07:56:00Z';
  account.windows.push({ ...account.windows[0], id: 'month', cadence: 'monthly' });
  expect(upcomingResets(usage, Date.parse(instant)).map(item => item.window.id)).toEqual(['week']);
  account.windows.splice(1, 1);
  expect(upcomingResets(usage, Date.parse(instant))).toEqual([]);
});

test('OpenAI shows weekly quota without a session placeholder or primary 5-hour display', async () => {
  await setup(async () => {
    const usage = fixture();
    usage.providers[0].id = 'codex'; usage.providers[0].label = 'OpenAI Codex';
    usage.providers[0].accounts[0].paused = false;
    usage.providers[0].accounts[0].windows[0].resetAt = '2026-10-07T07:56:00Z';
    return new Response(JSON.stringify(usage));
  });
  const queue = screen.getByRole('list', { name: 'Weekly reset queue' });
  expect(within(queue).getAllByRole('listitem')).toHaveLength(1);
  expect(queue.textContent).not.toContain('5h:');
  expect(screen.queryByText('5 hours')).toBeNull();
  expect(document.querySelectorAll('.core-window')).toHaveLength(1);
  expect(screen.getByRole('complementary', { name: 'Next weekly reset' }).textContent).toContain('5% unused');
  expect(screen.getByRole('complementary', { name: 'Next weekly reset' }).textContent).not.toContain('5h:');
});
