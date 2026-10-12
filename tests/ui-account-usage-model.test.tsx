import { afterEach, expect, test } from 'vitest';
import { accountRows, coreReadings, readUsageView, redeemableSummary, storeUsageView, type UsageAccount, type UsageResponse } from '../app/account-usage-model';

afterEach(() => { localStorage.clear(); });
const now = Date.parse('2026-10-07T07:55:00Z');
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
function account(overrides: Partial<UsageAccount> = {}): UsageAccount {
  return { id: 'a', label: 'a', email: 'a@example.test', plan: null, isDefault: false, paused: false, status: 'ready', message: null, updatedAt: at(-1), windows: [
    { id: 's', cadence: '5h', category: 'usage', label: 'Session limit', remainingPercent: 90, resetAt: at(60), reported: true },
    { id: 'w', cadence: 'weekly', category: 'usage', label: 'Weekly limit', remainingPercent: 40, resetAt: at(3 * 1_440), reported: true },
    { id: 'f', cadence: 'weekly', category: 'additional', label: 'Fable weekly limit', model: 'Fable', remainingPercent: 70, resetAt: at(3 * 1_440), reported: true },
    { id: 'o', cadence: 'weekly', category: 'additional', label: 'Opus weekly limit', remainingPercent: 10, resetAt: at(3 * 1_440), reported: true },
  ], ...overrides };
}
function usage(accounts: { claude?: UsageAccount[]; codex?: UsageAccount[] }): UsageResponse {
  return { generatedAt: at(0), source: 'CCS', available: true, summary: { ready: 0, low: 0, exhausted: 0, reconnect: 0, unavailable: 0 }, providers: [
    { id: 'claude', label: 'Claude Code', available: true, accounts: accounts.claude ?? [] },
    { id: 'codex', label: 'OpenAI Codex', available: true, accounts: accounts.codex ?? [] },
  ] };
}

test('coreReadings separates weekly, fable, session and extras for Claude', () => {
  const readings = coreReadings(account(), 'claude', now, true);
  expect(readings.capacityKnown).toBe(true);
  expect(readings.weekly?.id).toBe('w');
  expect(readings.fable?.id).toBe('f');
  expect(readings.session?.id).toBe('s');
  expect(readings.extras.map(window => window.id)).toEqual(['o']);
  expect(readings.displayStatus).toBe('ready');
});

test('coreReadings reports unknown capacity for stale readings and no fable for Codex', () => {
  const stale = coreReadings(account({ updatedAt: at(-20) }), 'claude', now, true);
  expect(stale.capacityKnown).toBe(false);
  expect(stale.weekly).toBeUndefined();
  expect(stale.displayStatus).toBe('unavailable');
  const codex = coreReadings(account({ windows: [{ id: 'w', cadence: 'weekly', category: 'usage', label: 'Weekly limit', remainingPercent: 40, resetAt: at(60), reported: true }] }), 'codex', now, true);
  expect(codex.fable).toBeUndefined();
  expect(codex.session).toBeUndefined();
});

test('redeemableSummary counts live grants and reports the nearest expiry', () => {
  const summary = redeemableSummary({ availableCount: 3, updatedAt: at(-1), grants: [
    { count: 1, expiresAt: at(-5), usableNow: true },
    { count: 1, expiresAt: at(2 * 1_440), usableNow: true },
    { count: 1, expiresAt: at(1_440), usableNow: false },
  ] }, true, now);
  expect(summary.count).toBe(2);
  expect(summary.label).toBe('2 saved resets');
  expect(summary.expiry).toBe(at(1_440));
  expect(summary.partial).toBe(false);
  expect(summary.blocked).toBe(true);
});

test('redeemableSummary never guesses when inventory is missing, stale or empty', () => {
  expect(redeemableSummary(null, true, now)).toMatchObject({ count: null, label: 'Not reported' });
  expect(redeemableSummary(undefined, true, now)).toMatchObject({ count: null, label: 'Not reported' });
  expect(redeemableSummary({ availableCount: 2, updatedAt: at(-20), grants: null }, true, now)).toMatchObject({ count: null, label: 'Awaiting refresh' });
  expect(redeemableSummary({ availableCount: 2, updatedAt: at(-1), grants: null }, false, now)).toMatchObject({ count: null, label: 'Awaiting refresh' });
  expect(redeemableSummary({ availableCount: 0, updatedAt: at(-1), grants: [] }, true, now)).toMatchObject({ count: 0, label: 'None reported' });
  expect(redeemableSummary({ availableCount: 2, updatedAt: at(-1), grants: null }, true, now)).toMatchObject({ count: 2, label: '2 saved resets', partial: true, expiry: undefined });
});

test('accountRows sorts queue members first by reset, then the rest in source order', () => {
  const soon = account({ id: 'soon', windows: [{ id: 'w', cadence: 'weekly', category: 'usage', label: 'Weekly limit', remainingPercent: 5, resetAt: at(60), reported: true }] });
  const later = account({ id: 'later', windows: [{ id: 'w', cadence: 'weekly', category: 'usage', label: 'Weekly limit', remainingPercent: 50, resetAt: at(1_440), reported: true }] });
  const none = account({ id: 'none', status: 'unavailable', windows: [] });
  const full = account({ id: 'full', status: 'exhausted', windows: [{ id: 'w', cadence: 'weekly', category: 'usage', label: 'Weekly limit', remainingPercent: 0, resetAt: at(30), reported: true }] });
  const rows = accountRows(usage({ claude: [none, later], codex: [full, soon] }), now);
  expect(rows.map(row => row.account.id)).toEqual(['full', 'soon', 'later', 'none']);
  expect(rows.map(row => row.state)).toEqual(['Check account', 'Use before reset', 'Upcoming', 'Not in queue']);
  expect(rows.map(row => row.usable)).toEqual([false, true, true, false]);
  expect(rows[3].reset).toBeNull();
});

test('readUsageView defaults to row and remembers card', () => {
  expect(readUsageView()).toBe('row');
  localStorage.setItem('cmux-companion-usage-view', 'nonsense');
  expect(readUsageView()).toBe('row');
  storeUsageView('card');
  expect(readUsageView()).toBe('card');
  expect(localStorage.getItem('cmux-companion-usage-view')).toBe('card');
});
