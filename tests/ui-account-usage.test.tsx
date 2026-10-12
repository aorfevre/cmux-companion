import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { AccountUsageView, nextUnusedReset, resetText, upcomingResets, usableBeforeReset } from '../app/account-usage';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });
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
async function setup(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async () => new Response(JSON.stringify(fixture())), view: 'card' | 'row' = 'card') {
  vi.useFakeTimers(); vi.setSystemTime(new Date(instant));
  localStorage.setItem('cmux-companion-usage-view', view);
  const fetch = vi.fn(handler); vi.stubGlobal('fetch', fetch);
  render(<AccountUsageView />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return fetch;
}

test('compares Claude used quota with remaining capacity and keeps Fable separate', async () => {
  await setup();
  expect(screen.getByText('95% used')).toBeTruthy();
  expect(screen.getByText('0% used')).toBeTruthy();
  expect(screen.getByText('96% used')).toBeTruthy();
  expect(screen.getByText('Fable weekly').closest('.core-window')?.textContent).toContain('4% remaining');
  expect(screen.getByText('Fable weekly')).toBeTruthy();
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

test.each([false, true])('next reset and account highlight skip saturated weekly quota (all saturated: %s)', async allSaturated => {
  await setup(async () => {
    const usage = fixture();
    const saturated = usage.providers[0].accounts[0];
    saturated.status = 'exhausted'; saturated.windows[1].remainingPercent = 0;
    const later = { ...structuredClone(saturated), id: 'later', email: 'later@example.test', paused: false };
    later.windows[1].remainingPercent = allSaturated ? 0 : 30;
    later.windows[1].resetAt = '2026-10-07T09:00:00Z';
    // Session saturation must not hide unused weekly quota from the first summary.
    later.windows[0].remainingPercent = 0;
    usage.providers[0].accounts.push(later);
    return new Response(JSON.stringify(usage));
  });
  const summary = screen.getByRole('complementary', { name: 'Next weekly reset' });
  expect(summary.textContent).not.toContain('sample@example.test');
  expect(within(screen.getByRole('list', { name: 'Weekly reset queue' })).getAllByRole('listitem')).toHaveLength(2);
  if (allSaturated) {
    expect(summary.textContent).toContain('No upcoming weekly reset with unused quota');
    expect(document.querySelector('.next-reset-account')).toBeNull();
  } else {
    expect(summary.textContent).toContain('later@example.test');
    expect(summary.textContent).toContain('30% unused');
    expect(document.querySelector('.next-reset-account')?.id).toBe('usage-account-later');
  }
  expect(screen.getByRole('complementary', { name: 'Weekly capacity to use before reset' }).textContent).toContain('No usable capacity');
});

test.each([
  ['team', 'Plan: Team'], ['max_20x', 'Plan: Max 20×'], ['max_5x', 'Plan: Max 5×'],
  ['prolite', 'Plan: Pro Lite'], [null, 'Plan not reported'], ['unknown', 'Plan not reported'],
])('keeps plan %s and the usage failure visible outside Details', async (plan, label) => {
  await setup(async () => {
    const usage = fixture();
    Object.assign(usage.providers[0].accounts[0], { plan, status: 'unavailable', updatedAt: null, windows: [], message: 'Usage temporarily rate-limited by the provider. Try again later.' });
    return new Response(JSON.stringify(usage));
  });
  const row = document.querySelector('.usage-account')!;
  expect(row.querySelector('header')?.textContent).toContain(label);
  expect(row.querySelector('header')?.textContent).toContain('Usage temporarily rate-limited');
  expect(row.querySelector('details')?.open).toBe(false);
  expect(screen.queryByRole('list', { name: 'Weekly reset queue' })).toBeNull();
  expect(screen.getByText(/Only fresh, reported weekly reset times/)).toBeTruthy();
});

test('shows provider cooldown through refresh and countdown expiry without claiming quota', async () => {
  const fetch = await setup(async () => {
    const usage = fixture();
    Object.assign(usage.providers[0].accounts[0], { status: 'unavailable', windows: [], updatedAt: null,
      retryAt: '2026-10-07T07:57:00Z', message: 'Usage temporarily rate-limited by the provider. Try again later.' });
    return new Response(JSON.stringify(usage));
  });
  expect(screen.getByText('Retry in 2m')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh account usage' })); });
  expect(screen.getByText('Retry in 2m')).toBeTruthy();
  expect(fetch).toHaveBeenLastCalledWith('/api/account-usage?refresh=1');
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(screen.getByText('Retry in 1m')).toBeTruthy();
  expect(fetch).toHaveBeenLastCalledWith('/api/account-usage');
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(screen.getByText('Ready to retry usage')).toBeTruthy();
  expect(screen.getByText('Unknown')).toBeTruthy();
});

test('Fable is visible outside Details and is never inferred from overall weekly quota', async () => {
  await setup();
  const gauge = screen.getByText('Fable weekly').closest('.core-window')!;
  expect(gauge.closest('details')).toBeNull();
  expect(gauge.textContent).toContain('4% remaining');
  expect(screen.getByText('Allocating Fable work? Check Weekly, Fable weekly and 5 hours together: all reported limits apply.')).toBeTruthy();
  cleanup();
  await setup(async () => {
    const usage = fixture(); usage.providers[0].accounts[0].windows.pop();
    return new Response(JSON.stringify(usage));
  });
  expect(screen.getByText('Fable weekly').closest('.core-window')?.textContent).toContain('Not reported');
});

test('saved resets stay visible outside Details with provider link, partial expiry and usage restrictions', async () => {
  await setup(async () => {
    const usage = fixture();
    usage.providers[0].accounts[0].redeemableResets = { availableCount: 3, updatedAt: instant, grants: [{ count: 1, expiresAt: '2026-10-07T08:00:00Z', usableNow: false }] };
    return new Response(JSON.stringify(usage));
  });
  const row = screen.getByText('Redeemable resets').closest('.redeemable-resets')!;
  expect(row.closest('details')).toBeNull();
  expect(row.textContent).toContain('3 saved resets');
  expect(row.textContent).toContain('Next reported expiry');
  expect(row.textContent).toContain('in 5m');
  expect(row.textContent).toContain('Some expiry details not reported');
  expect(row.textContent).toContain('Some resets cannot be used yet');
  expect(within(row as HTMLElement).getByRole('link').getAttribute('href')).toBe('https://claude.ai/settings/usage');
  expect(row.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-07T08:00:00Z');
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
  expect(row.textContent).toContain('2 saved resets');
  expect(row.textContent).toContain('Expiry not reported');
  expect(row.querySelector('time')).toBeNull();
});

test('expired saved grants disappear locally even while refresh is pending', async () => {
  let calls = 0;
  await setup(async () => {
    if (++calls > 1) return new Promise<Response>(() => {});
    const usage = fixture();
    usage.providers[0].accounts[0].redeemableResets = { availableCount: 1, updatedAt: instant, grants: [{ count: 1, expiresAt: '2026-10-07T07:56:00Z', usableNow: true }] };
    return new Response(JSON.stringify(usage));
  });
  expect(screen.getByText('1 saved reset')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(screen.queryByText('1 saved reset')).toBeNull();
  expect(screen.getByText('None reported')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60000); });
  expect(screen.getByText('Awaiting refresh')).toBeTruthy();
  expect(screen.queryByText('None reported')).toBeNull();
});

test.each(['unknown', 'count-only', 'no-expiry', 'empty', 'stale', 'provider-failed', 'failed-refresh'] as const)('saved-reset %s readings do not invent counts or expiry', async kind => {
  let calls = 0;
  await setup(async () => {
    if (++calls > 1 && kind === 'failed-refresh') return new Response('{}', { status: 503 });
    const usage = fixture();
    const provider = usage.providers[0]; provider.id = 'codex'; provider.label = 'OpenAI Codex';
    if (kind === 'provider-failed') provider.available = false;
    if (kind !== 'unknown') provider.accounts[0].redeemableResets = {
      availableCount: kind === 'empty' ? 0 : 2,
      updatedAt: kind === 'stale' ? '2026-10-07T07:00:00Z' : instant,
      grants: kind === 'no-expiry' ? [{ count: 2, expiresAt: null, usableNow: null }] : kind === 'empty' ? [] : null,
    };
    return new Response(JSON.stringify(usage));
  });
  if (kind === 'failed-refresh') await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  const row = screen.getByText('Redeemable resets').closest('.redeemable-resets')!;
  const expected = kind === 'unknown' ? 'Not reported' : kind === 'empty' ? 'None reported' : ['stale', 'provider-failed', 'failed-refresh'].includes(kind) ? 'Awaiting refresh' : '2 saved resets';
  expect(row.textContent).toContain(expected);
  if (expected === '2 saved resets') expect(row.textContent).toContain('Expiry not reported');
  expect(within(row as HTMLElement).getByRole('link').getAttribute('href')).toBe('https://chatgpt.com/codex/settings/usage');
  expect(row.querySelector('time')).toBeNull();
  expect(screen.queryByText('Fable weekly')).toBeNull();
});

test('fresh saved resets remain visible when quota windows are missing without claiming available capacity', async () => {
  await setup(async () => {
    const usage = fixture();
    const account = usage.providers[0].accounts[0];
    account.status = 'unavailable'; account.windows = []; account.message = 'Provider did not report usage limits.';
    account.redeemableResets = { availableCount: 1, updatedAt: instant, grants: [{ count: 1, expiresAt: '2026-10-07T08:00:00Z', usableNow: true }] };
    return new Response(JSON.stringify(usage));
  });
  expect(screen.getByText('Unknown')).toBeTruthy();
  expect(screen.getByText('1 saved reset')).toBeTruthy();
  expect(screen.getByText('Fable weekly').closest('.core-window')?.textContent).toContain('Not reported');
  expect(screen.queryByText('Available')).toBeNull();
  expect(document.querySelector('.reset-queue-row')).toBeNull();
});

test('defaults to Row view, remembers Card view and lifts the width cap only in Row view', async () => {
  localStorage.clear();
  vi.useFakeTimers(); vi.setSystemTime(new Date(instant));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(fixture()))));
  render(<AccountUsageView />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const selector = screen.getByRole('group', { name: 'Account layout' });
  expect(within(selector).getByRole('button', { name: 'Row' }).getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('.account-usage-page')?.classList.contains('row-view')).toBe(true);
  expect(screen.queryByRole('list', { name: 'Weekly reset queue' })).toBeNull();
  expect(screen.getByRole('table', { name: 'All accounts' })).toBeTruthy();
  fireEvent.click(within(selector).getByRole('button', { name: 'Card' }));
  expect(localStorage.getItem('cmux-companion-usage-view')).toBe('card');
  expect(document.querySelector('.account-usage-page')?.classList.contains('row-view')).toBe(false);
  expect(screen.getByRole('list', { name: 'Weekly reset queue' })).toBeTruthy();
  expect(screen.queryByRole('table', { name: 'All accounts' })).toBeNull();
  expect(screen.getByText('Fable weekly')).toBeTruthy();
});

test('forces Card view on a narrow viewport without changing the stored choice', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 760px)', addEventListener: () => {}, removeEventListener: () => {} }));
  await setup(undefined, 'row');
  expect(screen.queryByRole('group', { name: 'Account layout' })).toBeNull();
  expect(screen.queryByRole('table', { name: 'All accounts' })).toBeNull();
  expect(screen.getByText('Fable weekly')).toBeTruthy();
  expect(localStorage.getItem('cmux-companion-usage-view')).toBe('row');
});

function rowFixture(): Snapshot {
  const base = fixture();
  const sample = base.providers[0].accounts[0];
  const soon = { ...sample, id: 'soon', email: 'soon@example.test', paused: false, status: 'ready' as const, redeemableResets: { availableCount: 2, updatedAt: instant, grants: [{ count: 2, expiresAt: '2026-10-17T18:00:00Z', usableNow: true }] },
    windows: [{ id: 'week', cadence: 'weekly' as const, category: 'usage' as const, label: 'Weekly limit', remainingPercent: 60, resetAt: '2026-10-07T09:00:00Z', reported: true as const }, { id: 'session', cadence: '5h' as const, category: 'usage' as const, label: 'Session limit', remainingPercent: 30, resetAt: '2026-10-07T10:00:00Z', reported: true as const }] };
  const unknown = { ...sample, id: 'unknown', email: 'unknown@example.test', status: 'unavailable' as const, message: 'Usage temporarily rate-limited by the provider.', retryAt: '2026-10-07T08:05:00Z', windows: [], redeemableResets: null };
  base.providers[0].accounts = [unknown, sample, soon];
  base.providers.push({ id: 'codex', label: 'OpenAI Codex', available: true, accounts: [{ ...sample, id: 'codex-a', email: 'codex@example.test', paused: false, status: 'ready', redeemableResets: null,
    windows: [{ id: 'week', cadence: 'weekly', category: 'usage', label: 'Weekly limit', remainingPercent: 80, resetAt: '2026-10-08T08:00:00Z', reported: true }] }] });
  return base;
}

test('Row view lists every account sorted by weekly reset with queue state, gauges and redeemable resets', async () => {
  await setup(async () => new Response(JSON.stringify(rowFixture())), 'row');
  const table = screen.getByRole('table', { name: 'All accounts' });
  const rows = within(table).getAllByRole('row').slice(1).filter(row => row.classList.contains('usage-row'));
  expect(rows.map(row => row.id)).toEqual(['usage-account-sample', 'usage-account-soon', 'usage-account-codex-a', 'usage-account-unknown']);
  expect(rows[0].textContent).toContain('Check account');
  expect(rows[0].textContent).toContain('5% remaining');
  expect(rows[0].textContent).toContain('4% remaining');
  expect(rows[1].textContent).toContain('Use before reset');
  expect(rows[1].textContent).toContain('2 saved resets');
  expect(rows[1].textContent).toContain(new Date('2026-10-17T18:00:00Z').toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
  expect(rows[1].textContent).toContain('Resets in 1h 5m');
  expect(rows[2].textContent).toContain('Upcoming');
  expect(within(rows[2]).getAllByText('—')).toHaveLength(2);
  expect(rows[3].textContent).toContain('Not in queue');
  expect(rows[3].textContent).toContain('No reset reported');
  expect(rows[3].textContent).toContain('temporarily rate-limited');
  expect(rows[3].textContent).toContain('Retry in 10m');
  expect(rows[3].textContent).toContain('Not reported');
  fireEvent.click(screen.getByRole('button', { name: 'Usable now' }));
  expect(within(table).getAllByRole('row').filter(row => row.classList.contains('usage-row')).map(row => row.id)).toEqual(['usage-account-soon', 'usage-account-codex-a']);
});

test('Row view expands a row in place with details, reconnect and delete', async () => {
  const fetch = await setup(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response(JSON.stringify({ ok: true }));
    return new Response(JSON.stringify(rowFixture()));
  }, 'row');
  const row = document.getElementById('usage-account-sample')!;
  const expand = within(row).getByRole('button', { name: 'Show details for sample@example.test' });
  expect(expand.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(expand);
  expect(expand.getAttribute('aria-expanded')).toBe('true');
  const panel = document.getElementById('usage-row-detail-sample')!;
  expect(panel.textContent).toContain('Updated now');
  expect(within(panel).getByRole('link', { name: 'Check Claude resets ↗' })).toBeTruthy();
  fireEvent.click(within(panel).getByRole('button', { name: 'Delete connection' }));
  fireEvent.click(within(panel).getByRole('button', { name: 'Confirm delete' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(fetch.mock.calls.some(([url, init]) => String(url).endsWith('/api/account-usage/sample') && (init as RequestInit)?.method === 'DELETE')).toBe(true);
});

test('highlight links focus the matching table row', async () => {
  await setup(async () => new Response(JSON.stringify(rowFixture())), 'row');
  const link = within(screen.getByRole('complementary', { name: 'Next weekly reset' })).getByRole('link');
  fireEvent.click(link);
  expect(document.activeElement?.id).toBe('usage-account-sample');
});
