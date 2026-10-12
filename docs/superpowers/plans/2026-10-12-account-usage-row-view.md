# Account Usage Row / Card View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Row / Card selector to Account usage. Row view is the default. It shows every account in one dense table that replaces the Weekly reset queue and the provider card groups.

**Architecture:** The pure data logic (types, freshness, queue eligibility, core readings, redeemable reset summary, sorted rows) moves from `app/account-usage.tsx` into `app/account-usage-model.ts`. The card and the new table both render from that one model. `app/account-usage-account.tsx` holds the card and the shared detail panel. `app/account-usage-table.tsx` holds the table. `app/account-usage.tsx` keeps the page, the highlight summaries, the selector and the reconnect sheet.

**Tech Stack:** React 19, TypeScript, Vitest with Testing Library (`tests/ui-*.test.tsx`), Cypress (`cypress/e2e/*.cy.ts`), plain CSS in `app/account-usage.css`.

**Spec:** `docs/superpowers/specs/2026-10-07-account-usage-home.md`, sections "Row and Card views" and "Row view regression coverage".

---

## File structure

| File | Responsibility |
| --- | --- |
| `app/account-usage-model.ts` (create) | Types, `freshReading`, `resetText`, queue eligibility, queue state, core readings per account, redeemable summary, sorted account rows, view persistence helpers, label helpers. No React. |
| `app/account-usage-account.tsx` (create) | `AccountCard`, `AccountDetailContent` (reading time, messages, extra limits, confirmed delete), `RedeemableResets`, `CoreWindow`, `ExtraWindow`, `ResetTime`, `AccountStatusNotes`. Moved from `account-usage.tsx`. |
| `app/account-usage-table.tsx` (create) | `AccountTable`: sorted rows, gauge cells, queue state cell, redeemable cell, expand-in-place panel. |
| `app/account-usage.tsx` (modify) | `AccountUsageView`, `ResetOverview`, `ReconnectSheet`, the view selector, the narrow-viewport hook. Re-exports the model helpers the tests import. |
| `app/account-usage.css` (modify) | Selector, table and row-view width rules. |
| `tests/ui-account-usage-model.test.tsx` (create) | Unit tests for `redeemableSummary`, `accountRows`, `coreReadings`, `readUsageView`. |
| `tests/ui-account-usage.test.tsx` (modify) | Card tests select Card view in setup. New Row view tests. |
| `cypress/e2e/account-usage.cy.ts` (modify) | Card journeys select Card view. New Row view journeys. |

Rules that apply to every task: run `npm run typecheck` and `npm run lint` before each commit. Never commit `docs/superpowers/plans/2026-09-08-burst-scan.md`; it is an unrelated untracked file.

---

## Phase 1: Model extraction

### Task 1: Create the model module and move the pure helpers

**Files:**
- Create: `app/account-usage-model.ts`
- Modify: `app/account-usage.tsx` (lines 1-20 types, 98-136 helpers, 178-185 labels, 360-391 helpers)
- Test: `tests/ui-account-usage-model.test.tsx`

- [ ] **Step 1: Write the failing model tests**

Create `tests/ui-account-usage-model.test.tsx`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ui-account-usage-model.test.tsx`
Expected: FAIL. The module `../app/account-usage-model` does not exist.

- [ ] **Step 3: Create `app/account-usage-model.ts`**

Move the types and helpers out of `app/account-usage.tsx`. The file content:

```ts
// Pure account-usage logic shared by the card view, the table view and tests.
// No React in this module.

export type Cadence = "5h" | "daily" | "weekly" | "monthly" | "other";
export type UsageWindow = { id: string; cadence: Cadence; label: string; model?: string | null; category: "usage" | "additional" | "code-review"; remainingPercent: number; resetAt: string | null; reported: true };
export type ResetInventory = { availableCount: number; updatedAt: string; grants: Array<{ count: number; expiresAt: string | null; usableNow: boolean | null }> | null };
export type UsageAccount = { id: string; label: string; email: string | null; plan: string | null; isDefault: boolean; paused: boolean; status: "ready" | "low" | "exhausted" | "reconnect" | "unavailable"; message: string | null; updatedAt: string | null; retryAt?: string | null; windows: UsageWindow[]; redeemableResets?: ResetInventory | null };
export type UsageProvider = { id: "claude" | "codex"; label: string; available: boolean; accounts: UsageAccount[] };
export type UsageResponse = { generatedAt: string; source: "CCS"; available: boolean; summary: Record<UsageAccount["status"], number>; providers: UsageProvider[] };

export type UsageView = 'row' | 'card';
export const USAGE_VIEW_KEY = 'cmux-companion-usage-view';
export function readUsageView(): UsageView {
  try { return localStorage.getItem(USAGE_VIEW_KEY) === 'card' ? 'card' : 'row'; } catch { return 'row'; }
}
export function storeUsageView(view: UsageView) {
  try { localStorage.setItem(USAGE_VIEW_KEY, view); } catch { /* Private mode: the choice lasts for this page only. */ }
}

export function freshReading(value: string | null, now: number) { const stamp = Date.parse(value ?? ''); return Number.isFinite(stamp) && stamp <= now && now - stamp <= 15 * 60_000; }

// The one countdown in the app. The goals board reuses it so a quota reset
// never reads two different ways on two screens.
export function resetText(value: string | null, now: number) {
  if (!value) return "Reset unknown";
  const reset = new Date(value);
  const milliseconds = reset.getTime() - now;
  if (!Number.isFinite(milliseconds)) return "Reset unknown";
  if (milliseconds <= 0) return "Reset due";
  const minutes = Math.ceil(milliseconds / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  return `Resets in ${days ? `${days}d ` : ''}${hours ? `${hours}h ` : ''}${minutes % 60}m`;
}

export type UpcomingReset = { provider: UsageProvider; account: UsageAccount; window: UsageWindow; reset: number };
export function upcomingResets(usage: UsageResponse | null, now: number): UpcomingReset[] {
  if (!usage?.available || !freshReading(usage.generatedAt, now)) return [];
  const resets: UpcomingReset[] = [];
  for (const provider of usage.providers) {
    if (!provider.available) continue;
    for (const account of provider.accounts) {
      if (!freshReading(account.updatedAt, now) || !['ready', 'low', 'exhausted'].includes(account.status)) continue;
      const window = account.windows.find(window => window.category === 'usage' && window.cadence === 'weekly');
      if (!window) continue;
      const reset = Date.parse(window.resetAt ?? '');
      if (!Number.isFinite(window.remainingPercent) || window.remainingPercent < 0 || window.remainingPercent > 100 || !Number.isFinite(reset) || reset <= now) continue;
      resets.push({ provider, account, window, reset });
    }
  }
  return resets.sort((a, b) => a.reset - b.reset || b.window.remainingPercent - a.window.remainingPercent);
}
export function nextUnusedReset(usage: UsageResponse | null, now: number): UpcomingReset | null {
  return upcomingResets(usage, now).find(reset => reset.window.remainingPercent > 0) ?? null;
}
export function usableBeforeReset({ account, window }: UpcomingReset, now: number) {
  return !account.paused && account.status !== 'exhausted' && window.remainingPercent > 0
    && account.windows.filter(item => item.category === 'usage').every(item =>
      Number.isFinite(item.remainingPercent) && item.remainingPercent > 0 && item.remainingPercent <= 100
      && (item.resetAt === null || Number.isFinite(Date.parse(item.resetAt)) && Date.parse(item.resetAt) > now));
}
export function resetConstraint({ account }: UpcomingReset) {
  return [account.paused ? 'Paused in CCS' : '', account.status === 'exhausted' || account.windows.some(item => item.category === 'usage' && item.remainingPercent === 0) ? 'Usage limit exhausted' : ''].filter(Boolean).join(' · ');
}

export type QueueState = 'Use before reset' | 'Upcoming' | 'Check account' | 'Fully used';
export function queueState(reset: UpcomingReset, useNext: UpcomingReset | null): QueueState {
  if (resetConstraint(reset)) return 'Check account';
  if (reset === useNext) return 'Use before reset';
  return reset.window.remainingPercent === 0 ? 'Fully used' : 'Upcoming';
}

export type AccountRow = { provider: UsageProvider; account: UsageAccount; reset: UpcomingReset | null; state: QueueState | 'Not in queue'; usable: boolean };
// Every account once: queue members in queue order, then the rest in source order.
export function accountRows(usage: UsageResponse | null, now: number): AccountRow[] {
  if (!usage) return [];
  const resets = upcomingResets(usage, now);
  const useNext = resets.find(reset => usableBeforeReset(reset, now)) ?? null;
  const queued = resets.map(reset => ({ provider: reset.provider, account: reset.account, reset, state: queueState(reset, useNext), usable: usableBeforeReset(reset, now) }));
  const seen = new Set(queued.map(row => row.account.id));
  const rest: AccountRow[] = [];
  for (const provider of usage.providers) for (const account of provider.accounts) {
    if (!seen.has(account.id)) rest.push({ provider, account, reset: null, state: 'Not in queue', usable: false });
  }
  return [...queued, ...rest];
}

export const CORE_WINDOWS: Array<{ cadence: Exclude<Cadence, "other">; label: string }> = [
  { cadence: "weekly", label: "Weekly" },
  { cadence: "5h", label: "5 hours" },
];
export type CoreReadings = { capacityKnown: boolean; displayStatus: UsageAccount['status']; weekly?: UsageWindow; fable?: UsageWindow; session?: UsageWindow; extras: UsageWindow[] };
export function coreReadings(account: UsageAccount, providerId: UsageProvider['id'], now: number, snapshotFresh: boolean): CoreReadings {
  const capacityKnown = snapshotFresh && freshReading(account.updatedAt, now) && ['ready', 'low', 'exhausted'].includes(account.status);
  const windows = capacityKnown ? account.windows.filter(window => Number.isFinite(window.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100) : [];
  const weekly = windows.find(window => window.category === 'usage' && window.cadence === 'weekly');
  const session = providerId === 'claude' ? windows.find(window => window.category === 'usage' && window.cadence === '5h') : undefined;
  const fable = providerId === 'claude' ? windows.find(window => window.cadence === 'weekly' && window.category === 'additional' && (window.model?.toLowerCase() === 'fable' || window.label.toLowerCase() === 'fable weekly limit')) : undefined;
  const core = [weekly, session, fable].filter(Boolean);
  const extras = windows.filter(window => !core.includes(window));
  const displayStatus = !capacityKnown && account.status !== 'reconnect' ? 'unavailable' : account.status;
  return { capacityKnown, displayStatus, weekly, fable, session, extras };
}

export type RedeemableSummary = { count: number | null; label: string; expiry: string | undefined; partial: boolean; blocked: boolean };
export function redeemableSummary(inventory: ResetInventory | null | undefined, fresh: boolean, now: number): RedeemableSummary {
  const known = Boolean(fresh && inventory && freshReading(inventory.updatedAt, now));
  const grants = known ? inventory!.grants ?? [] : [];
  const expired = grants.filter(grant => grant.expiresAt !== null && Date.parse(grant.expiresAt) <= now).reduce((sum, grant) => sum + grant.count, 0);
  const count = known ? Math.max(0, inventory!.availableCount - expired) : null;
  const live = grants.filter(grant => grant.count > 0 && (grant.expiresAt === null || Date.parse(grant.expiresAt) > now));
  const expiry = live.map(grant => grant.expiresAt).filter((value): value is string => value !== null).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const partial = known && (inventory!.grants === null || grants.reduce((sum, grant) => sum + grant.count, 0) < inventory!.availableCount);
  const label = count === null ? inventory ? 'Awaiting refresh' : 'Not reported' : count === 0 ? 'None reported' : `${count} saved reset${count === 1 ? '' : 's'}`;
  return { count, label, expiry, partial, blocked: live.some(grant => grant.usableNow === false) };
}

export function percentTone(percent: number) { return percent <= 0 ? "exhausted" : percent <= 20 ? "low" : "ready"; }
export function statusLabel(status: UsageAccount["status"], windowCount = 1) { return status === "ready" && windowCount === 0 ? "Connected" : ({ ready: "Available", low: "Low", exhausted: "Exhausted", reconnect: "Reconnect", unavailable: "Unavailable" })[status]; }
export function displayLabel(label: string) { return label.replaceAll("-", " ").replace(/\bGpt\b/i, "GPT"); }
export function limitLabel(window: UsageWindow) { return ({ '5h': '5-hour limit', weekly: 'Weekly limit', daily: 'Daily limit', monthly: 'Monthly limit', other: window.label })[window.cadence]; }
export function planLabel(plan: string | null) {
  if (!plan || plan.toLowerCase() === 'unknown') return 'Plan not reported';
  const known: Record<string, string> = { max_5x: 'Max 5×', max_20x: 'Max 20×', pro_lite: 'Pro Lite', prolite: 'Pro Lite' };
  return `Plan: ${known[plan.toLowerCase()] || plan.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase())}`;
}
export function relativeUpdated(value: string, now: number) { const seconds = Math.round((now - new Date(value).getTime()) / 1000); if (!Number.isFinite(seconds) || seconds < 0) return 'Reading time unavailable'; return seconds < 15 ? "Updated now" : seconds < 60 ? `Updated ${seconds}s ago` : `Updated ${Math.floor(seconds / 60)}m ago`; }
export function shortDate(value: string) { return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
```

Note: `redeemableSummary` keeps the exact behaviour of the current `RedeemableResets` component. The spec requires that known, zero-grant counts say None reported and that unknown inventory never shows zero.

- [ ] **Step 4: Rewire `app/account-usage.tsx` to the model**

In `app/account-usage.tsx`:

1. Delete the type lines 8-14 (`Cadence` to `UsageResponse`), `CORE_WINDOWS` (lines 16-19), `freshReading` (line 98), `upcomingResets`, `nextUnusedReset`, `usableBeforeReset`, `resetConstraint`, `limitLabel`, `planLabel`, `percentTone`, `statusLabel`, `displayLabel`, `relativeUpdated` and `resetText`.
2. Replace the deleted definitions with one import and one re-export at the top of the file, under the existing imports:

```ts
import { CORE_WINDOWS, accountRows, coreReadings, displayLabel, freshReading, limitLabel, nextUnusedReset, percentTone, planLabel, redeemableSummary, relativeUpdated, resetConstraint, resetText, shortDate, statusLabel, upcomingResets, usableBeforeReset, type ResetInventory, type UpcomingReset, type UsageAccount, type UsageProvider, type UsageResponse, type UsageWindow } from './account-usage-model';
export { nextUnusedReset, resetText, upcomingResets, usableBeforeReset } from './account-usage-model';
```

`ReconnectSession` stays defined locally in `account-usage.tsx` because only the sheet uses it. Remove any name from the import that the file no longer references after this task; `npm run lint` reports unused imports.

3. Replace the body of `RedeemableResets` so that it uses the summary:

```tsx
function RedeemableResets({ inventory, fresh, providerId, now }: { inventory?: ResetInventory | null; fresh: boolean; providerId: UsageProvider['id']; now: number }) {
  const { count, label, expiry, partial, blocked } = redeemableSummary(inventory, fresh, now);
  return <div className={`redeemable-resets${count && count > 0 ? ' has-resets' : ''}`}>
    <div><strong>Redeemable resets</strong><span>{label}</span></div>
    {count !== null && count > 0 && <p>{expiry ? <><time dateTime={expiry} title={new Date(expiry).toLocaleString()}>{partial ? 'Next reported expiry' : 'Next expiry'}: {shortDate(expiry)} · {resetText(expiry, now).replace('Resets in ', 'in ')}</time>{partial && ' · Some expiry details not reported'}</> : 'Expiry not reported'}{blocked && ' · Some resets cannot be used yet'}</p>}
    <a href={providerId === 'claude' ? 'https://claude.ai/settings/usage' : 'https://chatgpt.com/codex/settings/usage'} target="_blank" rel="noreferrer">Check {providerId === 'claude' ? 'Claude' : 'ChatGPT'} resets ↗</a>
  </div>;
}
```

4. In `AccountCard`, replace the five lines from `const capacityKnown = ...` to `const displayStatus = ...` with:

```tsx
  const { capacityKnown, displayStatus, weekly, fable, session, extras } = coreReadings(account, providerId, now, snapshotFresh);
```

and replace the core window grid with:

```tsx
    <div className={`core-window-grid${providerId === 'codex' ? ' weekly-only' : ' with-fable'}`}>
      <CoreWindow label="Weekly" window={weekly} now={now} />
      {providerId === 'claude' && <><CoreWindow label="Fable weekly" window={fable} now={now} /><CoreWindow label="5 hours" window={session} now={now} /></>}
    </div>
```

`coreWindows` and `core` are no longer used; delete them.

- [ ] **Step 5: Run the tests and checks**

Run: `npx vitest run tests/ui-account-usage-model.test.tsx tests/ui-account-usage.test.tsx && npm run typecheck && npm run lint`
Expected: all pass. The existing card tests must not change in this task.

- [ ] **Step 6: Commit**

```bash
git add app/account-usage-model.ts app/account-usage.tsx tests/ui-account-usage-model.test.ts
git commit -m "refactor: move account usage logic into a shared model module

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Move the card components into `app/account-usage-account.tsx`

**Files:**
- Create: `app/account-usage-account.tsx`
- Modify: `app/account-usage.tsx`

- [ ] **Step 1: Create `app/account-usage-account.tsx`**

Move `AccountCard`, `RedeemableResets`, `CoreWindow`, `ExtraWindow` and `ResetTime` out of `account-usage.tsx` unchanged, then split `AccountCard` so the detail panel and the status notes are reusable by the table:

```tsx
"use client";
import { useRef, useState } from "react";
import { coreReadings, displayLabel, freshReading, percentTone, planLabel, redeemableSummary, relativeUpdated, resetText, shortDate, statusLabel, type ResetInventory, type UsageAccount, type UsageProvider, type UsageWindow } from './account-usage-model';

export function AccountStatusNotes({ account, snapshotFresh, now }: { account: UsageAccount; snapshotFresh: boolean; now: number }) {
  return <>
    {snapshotFresh && account.status === 'unavailable' && account.message && <p className="account-unavailable-reason">{account.message}</p>}
    {snapshotFresh && account.status === 'unavailable' && account.retryAt && Number.isFinite(Date.parse(account.retryAt)) && <p className="account-retry"><time dateTime={account.retryAt} title={new Date(account.retryAt).toLocaleString()}>{Date.parse(account.retryAt) <= now ? 'Ready to retry usage' : resetText(account.retryAt, now).replace('Resets in ', 'Retry in ')}</time></p>}
  </>;
}

export type AccountDetailProps = { providerLabel: string; account: UsageAccount; now: number; capacityKnown: boolean; extras: UsageWindow[]; onDeleted: () => Promise<void>; onReconnect?: () => void };
// Reading time, messages, extra limits and confirmed deletion. The card shows
// it under Details; the table shows it in the expanded row.
export function AccountDetailContent({ providerLabel, account, now, capacityKnown, extras, onDeleted, onReconnect }: AccountDetailProps) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const removing = useRef(false);
  const remove = async () => {
    if (removing.current) return;
    removing.current = true;
    setDeleting(true); setDeleteError("");
    try {
      const response = await fetch(`/api/account-usage/${encodeURIComponent(account.id)}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not delete connection");
      await onDeleted();
      setConfirming(false);
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : "Could not delete connection");
    } finally { removing.current = false; setDeleting(false); }
  };
  return <div className="account-detail-content">
    <p className="account-reading">{account.updatedAt ? relativeUpdated(account.updatedAt, now) : 'Reading time unavailable'}</p>
    {!capacityKnown && <p className="account-message">Capacity unknown: the reading is unavailable, failed or older than 15 minutes.</p>}
    {account.message && <p className={`account-message ${account.status}`}>{account.message}</p>}
    {onReconnect && !confirming && account.status === "reconnect" && <button className="account-reconnect" onClick={onReconnect}>Reconnect account</button>}
    {extras.length > 0 && <div className="extra-windows"><p>Additional limits</p>{extras.map((window) => <ExtraWindow window={window} now={now} key={window.id} />)}</div>}
    {confirming ? <div className="connection-confirmation" role="group" aria-label="Delete connection confirmation">
      <p>Delete the {providerLabel} connection for <strong>{account.email || account.label}</strong>?</p>
      <p>This removes its saved login from CCS on this Mac. You’ll need to sign in again to use it. Your provider account and subscription remain active.</p>
      {account.isDefault && <p>CCS will choose another default account if one remains.</p>}
      {deleteError && <p role="alert">{deleteError}</p>}
      <div><button disabled={deleting} onClick={() => { setConfirming(false); setDeleteError(""); }}>Cancel</button><button className="connection-delete" disabled={deleting} onClick={() => void remove()}>{deleting ? "Deleting…" : "Confirm delete"}</button></div>
    </div> : <button className="connection-delete" onClick={() => setConfirming(true)}>Delete connection</button>}
  </div>;
}

export function AccountCard({ providerId, account, now, onReconnect, onDeleted, providerLabel, snapshotFresh, nextWindowId }: { providerId: UsageProvider["id"]; nextWindowId?: string; onDeleted: () => Promise<void>; providerLabel: string; account: UsageAccount; now: number; snapshotFresh: boolean; onReconnect: () => void }) {
  const { capacityKnown, displayStatus, weekly, fable, session, extras } = coreReadings(account, providerId, now, snapshotFresh);
  return <article id={`usage-account-${account.id}`} tabIndex={-1} className={`usage-account ${displayStatus}${nextWindowId ? ' next-reset-account' : ''}`}><header><div><strong>{account.email || account.label}</strong><span className="account-plan">{planLabel(account.plan)}</span><span>{[account.isDefault ? "Default" : null, account.paused ? "Paused" : null].filter(Boolean).join(" · ")}</span></div><span className={`usage-status ${displayStatus}`}>{!capacityKnown && account.status !== 'reconnect' ? 'Unknown' : statusLabel(account.status, account.windows.length)}</span>{nextWindowId && <span className="next-reset-tag">Next reset</span>}
    <AccountStatusNotes account={account} snapshotFresh={snapshotFresh} now={now} />
    {account.status === "reconnect" && <button className="account-reconnect" onClick={onReconnect}>Reconnect account</button>}</header>
    <div className={`core-window-grid${providerId === 'codex' ? ' weekly-only' : ' with-fable'}`}>
      <CoreWindow label="Weekly" window={weekly} now={now} />
      {providerId === 'claude' && <><CoreWindow label="Fable weekly" window={fable} now={now} /><CoreWindow label="5 hours" window={session} now={now} /></>}
    </div>
    <details className="usage-account-details"><summary>Details{extras.length > 0 && <span className="sr-only"> · {extras.length} additional limits</span>}</summary>
      <AccountDetailContent providerLabel={providerLabel} account={account} now={now} capacityKnown={capacityKnown} extras={extras} onDeleted={onDeleted} />
    </details>
    <RedeemableResets inventory={account.redeemableResets} fresh={snapshotFresh && account.status !== 'reconnect' && freshReading(account.updatedAt, now)} providerId={providerId} now={now} />
  </article>;
}

export function RedeemableResets({ inventory, fresh, providerId, now, compact = false }: { inventory?: ResetInventory | null; fresh: boolean; providerId: UsageProvider['id']; now: number; compact?: boolean }) {
  const { count, label, expiry, partial, blocked } = redeemableSummary(inventory, fresh, now);
  const expiryText = count !== null && count > 0 ? <>{expiry ? <><time dateTime={expiry} title={new Date(expiry).toLocaleString()}>{compact ? '' : `${partial ? 'Next reported expiry' : 'Next expiry'}: `}{shortDate(expiry)} · {resetText(expiry, now).replace('Resets in ', 'in ')}</time>{partial && !compact && ' · Some expiry details not reported'}</> : 'Expiry not reported'}{blocked && !compact && ' · Some resets cannot be used yet'}</> : null;
  if (compact) return <span className={`redeemable-compact${count && count > 0 ? ' has-resets' : ''}`}><strong>{label}</strong>{expiryText && <small>{expiryText}{partial && ' · partial'}{blocked && ' · not all usable'}</small>}</span>;
  return <div className={`redeemable-resets${count && count > 0 ? ' has-resets' : ''}`}>
    <div><strong>Redeemable resets</strong><span>{label}</span></div>
    {expiryText && <p>{expiryText}</p>}
    <a href={providerId === 'claude' ? 'https://claude.ai/settings/usage' : 'https://chatgpt.com/codex/settings/usage'} target="_blank" rel="noreferrer">Check {providerId === 'claude' ? 'Claude' : 'ChatGPT'} resets ↗</a>
  </div>;
}

export function CoreWindow({ label, window, now }: { label: string; window?: UsageWindow; now: number }) {
  const tone = window ? percentTone(window.remainingPercent) : "missing";
  return <div className={`core-window ${tone}${window?.cadence === '5h' || label === '5 hours' ? ' secondary-session' : ''}`}><div><span>{label}</span>{window ? <strong>{window.remainingPercent}% <em>remaining</em></strong> : <strong>—</strong>}</div>{window ? <><small className="quota-used">{100 - window.remainingPercent}% used</small><div className="quota-track"><i style={{ width: `${window.remainingPercent}%` }} /></div><ResetTime value={window.resetAt} now={now} /></> : <small>Not reported</small>}</div>;
}

export function ExtraWindow({ window, now }: { window: UsageWindow; now: number }) {
  return <div className={`extra-window ${percentTone(window.remainingPercent)}`}><div><strong>{displayLabel(window.label)}</strong><span>{window.cadence} · {100 - window.remainingPercent}% used</span></div><b>{window.remainingPercent}% remaining</b><ResetTime value={window.resetAt} now={now} /></div>;
}

export function ResetTime({ value, now }: { value: string | null; now: number }) {
  const reset = value ? new Date(value) : null;
  if (!reset || !Number.isFinite(reset.getTime())) return <small>Reset unknown</small>;
  return <small><time dateTime={reset.toISOString()} title={reset.toLocaleString()}>{resetText(value, now)}</time></small>;
}
```

Behaviour note: the card still renders the Reconnect button in its header, so the card passes no `onReconnect` to `AccountDetailContent`. The table will pass it, so Reconnect appears in the expanded panel.

- [ ] **Step 2: Remove the moved components from `app/account-usage.tsx`**

Delete `AccountCard`, `RedeemableResets`, `CoreWindow`, `ExtraWindow` and `ResetTime` from `account-usage.tsx`. Add the import:

```ts
import { AccountCard } from './account-usage-account';
```

Trim the model import line to the names still used in `account-usage.tsx` (`ProviderSection`, `ResetOverview`, `AccountResetLink`, `SessionContext`, `ResetCountdown`, `ReconnectSheet` and `AccountUsageView` use: `freshReading`, `upcomingResets`, `usableBeforeReset`, `resetConstraint`, `limitLabel`, `resetText`, `shortDate` and the types).

- [ ] **Step 3: Run the tests and checks**

Run: `npx vitest run tests/ui-account-usage.test.tsx tests/ui-account-usage-model.test.tsx && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add app/account-usage-account.tsx app/account-usage.tsx
git commit -m "refactor: split the account card and its detail panel out of the usage page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Phase 2: Selector and table

### Task 3: Card tests select Card view, and the selector defaults to Row

**Files:**
- Modify: `tests/ui-account-usage.test.tsx` (setup at lines 19-25)
- Modify: `app/account-usage.tsx`
- Modify: `app/account-usage.css`

- [ ] **Step 1: Make the existing card tests opt into Card view**

In `tests/ui-account-usage.test.tsx`, change the `afterEach` and `setup`:

```ts
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });
...
async function setup(handler = async () => new Response(JSON.stringify(fixture())), view: 'card' | 'row' = 'card') {
  vi.useFakeTimers(); vi.setSystemTime(new Date(instant));
  localStorage.setItem('cmux-companion-usage-view', view);
  const fetch = vi.fn(handler); vi.stubGlobal('fetch', fetch);
  render(<AccountUsageView />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return fetch;
}
```

Every existing test calls `setup(...)` with at most one argument, so they all keep Card view.

- [ ] **Step 2: Write the failing selector tests**

Append to `tests/ui-account-usage.test.tsx`:

```tsx
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/ui-account-usage.test.tsx`
Expected: the two new tests FAIL because there is no "Account layout" group and no table. The existing tests PASS.

- [ ] **Step 4: Add the selector, the narrow-viewport hook and the lifted queue filter**

In `app/account-usage.tsx`:

1. Add to the model import: `readUsageView, storeUsageView, accountRows, type UsageView`. Add `useSyncExternalStore` to the React import. Add `import { AccountTable } from './account-usage-table';` (the module is created in Task 4; until then, typecheck fails, which is expected between steps of this task and Task 4. Run the full checks at the end of Task 4.)

2. Add the hook above `AccountUsageView`:

```ts
const NARROW = '(max-width: 760px)';
const subscribeNarrow = (changed: () => void) => {
  if (typeof matchMedia !== 'function') return () => {};
  const query = matchMedia(NARROW);
  query.addEventListener('change', changed);
  return () => query.removeEventListener('change', changed);
};
function useNarrowViewport() {
  return useSyncExternalStore(subscribeNarrow, () => typeof matchMedia === 'function' && matchMedia(NARROW).matches, () => false);
}
```

3. In `AccountUsageView`, add state after `reconnecting`:

```ts
  const [storedView, setStoredView] = useState<UsageView>(() => typeof window === 'undefined' ? 'row' : readUsageView());
  const narrow = useNarrowViewport();
  const view: UsageView = narrow ? 'card' : storedView;
  const changeView = (next: UsageView) => { setStoredView(next); storeUsageView(next); };
  const [usableOnly, setUsableOnly] = useState(false);
```

4. Change the section class to `className={\`account-usage-page${view === 'row' ? ' row-view' : ''}\`}`.

5. Replace the `ResetOverview` call and everything from the "All accounts" heading to the end of `usage-providers` with:

```tsx
    {usage && <ResetOverview resets={resets} now={now} usableOnly={usableOnly} onUsableOnly={setUsableOnly} showQueue={view === 'card'} />}
    {usage && <div className="all-accounts-head"><h2 className="all-accounts-heading">All accounts</h2>{!narrow && <div className="usage-view-selector" role="group" aria-label="Account layout">
      <button aria-pressed={view === 'row'} onClick={() => changeView('row')}>Row</button><button aria-pressed={view === 'card'} onClick={() => changeView('card')}>Card</button>
    </div>}</div>}
    {usage && view === 'row' && <AccountTable rows={accountRows(usage, now).filter(row => !usableOnly || row.usable)} usableOnly={usableOnly} now={now} snapshotFresh={!error && usage.available && freshReading(usage.generatedAt, now)} nextReset={nextReset} onDeleted={connectionDeleted} onReconnect={(provider, account) => setReconnecting({ provider, account })} />}
    {view === 'card' && <div className="usage-providers">{usage?.providers.map((provider) => <ProviderSection nextReset={nextReset} snapshotFresh={!error && usage.available && freshReading(usage.generatedAt, now)} provider={provider} now={now} onDeleted={connectionDeleted} onReconnect={(account) => setReconnecting({ provider, account })} key={provider.id} />)}</div>}
```

6. Change `ResetOverview` to receive the filter from its parent and to hide the queue list in Row view:

```tsx
function ResetOverview({ resets, now, usableOnly, onUsableOnly, showQueue }: { resets: UpcomingReset[]; now: number; usableOnly: boolean; onUsableOnly: (value: boolean) => void; showQueue: boolean }) {
  const next = resets.find(reset => reset.window.remainingPercent > 0);
  const useNext = resets.find(reset => usableBeforeReset(reset, now));
  const visible = usableOnly ? resets.filter(reset => usableBeforeReset(reset, now)) : resets;
  return <section className="reset-overview" aria-label="Capacity before reset">
    <div className="reset-highlights">
      ... unchanged ...
    </div>
    <header className="reset-queue-head"><div><h2>{showQueue ? 'Weekly reset queue' : 'Account filter'}</h2><p>{showQueue ? 'Unused weekly quota · Soonest reset first' : 'Rows sort by soonest weekly reset'}</p></div><div className="reset-filter" role="group" aria-label="Reset queue filter">
      <button aria-pressed={!usableOnly} onClick={() => onUsableOnly(false)}>Next reset</button><button aria-pressed={usableOnly} onClick={() => onUsableOnly(true)}>Usable now</button>
    </div></header>
    {showQueue && (visible.length ? <ol className="reset-queue" aria-label="Weekly reset queue"> ... unchanged ... </ol> : <p className="reset-empty">...unchanged...</p>)}
    {showQueue && <p className="reset-eligibility">Only fresh, reported weekly reset times appear here. See All accounts for missing readings.</p>}
  </section>;
}
```

Remove the `const [usableOnly, setUsableOnly] = useState(false);` line from `ResetOverview`.

7. In `app/account-usage.css`, append:

```css
/* Row / Card selector. Row view lifts the page cap so nine accounts fit one screen. */
.account-usage-page .all-accounts-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin:24px 0 12px; }
.account-usage-page .all-accounts-head .all-accounts-heading { margin:0; }
.account-usage-page .usage-view-selector { display:flex; padding:3px; border:1px solid var(--line); border-radius:8px; }
.mission-control .account-usage-page .usage-view-selector button { padding:6px 10px; font-size:11px; background:transparent; color:var(--muted); border:0; border-radius:5px; }
.mission-control .account-usage-page .usage-view-selector button[aria-pressed=true] { background:var(--panel-raised); color:var(--text); }
.mission-control .account-usage-page.row-view { max-width:none; }
@media (max-width:760px) { .account-usage-page .usage-view-selector { display:none; } }
```

- [ ] **Step 5: Continue to Task 4 before running checks**

The import of `./account-usage-table` fails to resolve until Task 4 creates it. Do not commit yet.

### Task 4: Create the account table

**Files:**
- Create: `app/account-usage-table.tsx`
- Modify: `app/account-usage.css`
- Modify: `tests/ui-account-usage.test.tsx`

- [ ] **Step 1: Write the failing table tests**

Append to `tests/ui-account-usage.test.tsx`:

```tsx
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
  expect(rows[1].querySelector('.usage-reset')?.textContent).toContain('1h 5m');
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
```

Note on the fixture: `sample` is paused with 5% weekly left and resets at 08:00, so it is first in the queue and reads Check account. `soon` resets at 09:00 and is the first usable account, so it reads Use before reset and the highlight "Next weekly reset" points at `sample`, which has unused quota. If the "highlight links" test fails because the first link points at `sample`, assert `usage-account-sample` instead; the behaviour under test is the focus, not the pick.

- [ ] **Step 2: Create `app/account-usage-table.tsx`**

```tsx
"use client";
import { Fragment, useState } from "react";
import { ProviderLogo } from "./provider-logo";
import { AccountDetailContent, AccountStatusNotes, RedeemableResets } from "./account-usage-account";
import { coreReadings, freshReading, percentTone, planLabel, resetText, shortDate, statusLabel, type AccountRow, type UpcomingReset, type UsageAccount, type UsageProvider, type UsageWindow } from "./account-usage-model";

type Props = { rows: AccountRow[]; usableOnly: boolean; now: number; snapshotFresh: boolean; nextReset: UpcomingReset | null; onDeleted: (id: string) => Promise<void>; onReconnect: (provider: UsageProvider, account: UsageAccount) => void };
const COLUMNS = 8;

export function AccountTable({ rows, usableOnly, now, snapshotFresh, nextReset, onDeleted, onReconnect }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return <div className="usage-table-wrap"><table className="usage-table" aria-label="All accounts">
    <thead><tr><th scope="col">Account</th><th scope="col">Weekly</th><th scope="col">Fable weekly</th><th scope="col">5 hours</th><th scope="col">Resets in</th><th scope="col">Redeemable resets</th><th scope="col">Queue state</th><th scope="col"><span className="sr-only">Details</span></th></tr></thead>
    <tbody>
      {rows.map(({ provider, account, reset, state }) => {
        const fresh = snapshotFresh && provider.available;
        const readings = coreReadings(account, provider.id, now, fresh);
        const name = account.email || account.label;
        const open = expanded.has(account.id);
        const isNext = nextReset?.provider.id === provider.id && nextReset.account.id === account.id;
        return <Fragment key={account.id}>
          <tr id={`usage-account-${account.id}`} tabIndex={-1} className={`usage-row ${readings.displayStatus}${isNext ? ' next-reset-account' : ''}`}>
            <th scope="row"><div className="usage-row-account"><ProviderLogo provider={provider.id} /><strong>{name}</strong><small className="account-plan">{planLabel(account.plan)}</small>{(account.isDefault || account.paused) && <small>{[account.isDefault ? "Default" : null, account.paused ? "Paused" : null].filter(Boolean).join(" · ")}</small>}<span className={`usage-status ${readings.displayStatus}`}>{!readings.capacityKnown && account.status !== 'reconnect' ? 'Unknown' : statusLabel(account.status, account.windows.length)}</span>{isNext && <span className="next-reset-tag">Next reset</span>}<AccountStatusNotes account={account} snapshotFresh={fresh} now={now} /></div></th>
            <GaugeCell window={readings.weekly} now={now} />
            {provider.id === 'claude' ? <GaugeCell window={readings.fable} now={now} /> : <td className="usage-na">—</td>}
            {provider.id === 'claude' ? <GaugeCell window={readings.session} now={now} /> : <td className="usage-na">—</td>}
            <td className="usage-reset">{reset ? <><strong>{resetText(reset.window.resetAt, now)}</strong><small><time dateTime={reset.window.resetAt!}>{shortDate(reset.window.resetAt!)}</time></small></> : <small>No reset reported</small>}</td>
            <td className="usage-redeemable"><RedeemableResets compact inventory={account.redeemableResets} fresh={fresh && account.status !== 'reconnect' && freshReading(account.updatedAt, now)} providerId={provider.id} now={now} /></td>
            <td className="usage-queue-state"><span className={`queue-pill ${state.toLowerCase().replaceAll(' ', '-')}`}>{state}</span></td>
            <td className="usage-expand"><button type="button" aria-expanded={open} aria-controls={`usage-row-detail-${account.id}`} aria-label={`${open ? 'Hide' : 'Show'} details for ${name}`} onClick={() => toggle(account.id)}>{open ? '⌃' : '⌄'}</button></td>
          </tr>
          {open && <tr id={`usage-row-detail-${account.id}`} className="usage-row-detail"><td colSpan={COLUMNS}>
            <AccountDetailContent providerLabel={provider.label} account={account} now={now} capacityKnown={readings.capacityKnown} extras={readings.extras} onDeleted={() => onDeleted(account.id)} onReconnect={() => onReconnect(provider, account)} />
            <RedeemableResets inventory={account.redeemableResets} fresh={fresh && account.status !== 'reconnect' && freshReading(account.updatedAt, now)} providerId={provider.id} now={now} />
          </td></tr>}
        </Fragment>;
      })}
      {!rows.length && <tr><td colSpan={COLUMNS} className="usage-table-empty">{usableOnly ? 'No usable capacity with an upcoming weekly reset is reported.' : 'No accounts are connected.'}</td></tr>}
    </tbody>
  </table></div>;
}

function GaugeCell({ window, now }: { window?: UsageWindow; now: number }) {
  if (!window) return <td className="usage-gauge missing"><strong>—</strong><small>Not reported</small></td>;
  return <td className={`usage-gauge ${percentTone(window.remainingPercent)}`}><strong>{window.remainingPercent}% <em>remaining</em></strong><div className="quota-track"><i style={{ width: `${window.remainingPercent}%` }} /></div><small>{window.resetAt ? <time dateTime={window.resetAt} title={new Date(window.resetAt).toLocaleString()}>{resetText(window.resetAt, now)}</time> : 'Reset unknown'}</small></td>;
}
```

The table has 8 columns, so the expanded panel spans `COLUMNS = 8`.

- [ ] **Step 3: Add the table styles**

Append to `app/account-usage.css`:

```css
/* Row view: one dense table of every account. Gauges keep the card tones. */
.account-usage-page .usage-table-wrap { overflow-x:auto; border:1px solid var(--line); border-radius:10px; background:var(--panel); }
.account-usage-page .usage-table { width:100%; border-collapse:collapse; font-size:12px; }
.account-usage-page .usage-table th,.account-usage-page .usage-table td { padding:8px 10px; text-align:left; vertical-align:top; border-top:1px solid var(--line); }
.account-usage-page .usage-table thead th { border-top:0; font-size:10px; font-weight:500; text-transform:uppercase; letter-spacing:.5px; color:var(--muted); background:var(--panel-raised); position:sticky; top:0; }
.account-usage-page .usage-row:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.mission-control .account-usage-page .usage-row.next-reset-account th { box-shadow:inset 3px 0 0 var(--accent); }
.account-usage-page .usage-row-account { display:flex; flex-direction:column; gap:2px; min-width:160px; }
.account-usage-page .usage-row-account strong { font-size:13px; overflow-wrap:anywhere; }
.account-usage-page .usage-row-account small { color:var(--muted); font-size:11px; }
.account-usage-page .usage-row-account .usage-status { align-self:flex-start; margin-top:3px; }
.account-usage-page .usage-row-account .usage-provider-logo { margin:0 0 2px; }
.account-usage-page .usage-gauge { min-width:110px; }
.account-usage-page .usage-gauge strong { display:block; font-size:14px; }
.account-usage-page .usage-gauge em { font-size:10px; font-style:normal; font-weight:400; color:var(--muted); }
.account-usage-page .usage-gauge small,.account-usage-page .usage-reset small,.account-usage-page .usage-na { color:var(--muted); font-size:11px; }
.account-usage-page .usage-gauge.missing strong { color:var(--muted); }
.mission-control .account-usage-page .usage-gauge .quota-track { background:var(--line); height:4px; margin:4px 0; }
.mission-control .account-usage-page .usage-gauge .quota-track i { background:var(--accent); display:block; height:100%; }
.mission-control .account-usage-page .usage-gauge.low .quota-track i { background:#b97518; }
.mission-control .account-usage-page .usage-gauge.exhausted .quota-track i { background:#a23e33; }
.account-usage-page .usage-reset strong { display:block; font-size:13px; font-variant-numeric:tabular-nums; }
.account-usage-page .redeemable-compact { display:flex; flex-direction:column; gap:2px; }
.account-usage-page .redeemable-compact strong { font-weight:500; }
.account-usage-page .redeemable-compact.has-resets strong { color:var(--accent); }
.account-usage-page .redeemable-compact small { color:var(--muted); font-size:11px; }
.account-usage-page .queue-pill { display:inline-block; padding:3px 7px; border:1px solid var(--line); border-radius:20px; white-space:nowrap; }
.account-usage-page .queue-pill.use-before-reset { border-color:var(--accent); color:var(--accent); }
.account-usage-page .queue-pill.check-account { color:#8a5100; border-color:#e6c48a; }
.account-usage-page .queue-pill.not-in-queue { color:var(--muted); }
.mission-control .account-usage-page .usage-expand button { width:28px; height:28px; padding:0; background:transparent; color:var(--muted); border:1px solid var(--line); border-radius:6px; }
.account-usage-page .usage-row-detail td { background:var(--panel-raised); }
.account-usage-page .usage-row-detail .account-detail-content { border-top:0; padding:0; }
.account-usage-page .usage-row-detail .redeemable-resets { margin-top:8px; }
.account-usage-page .usage-table-empty { color:var(--muted); text-align:center; padding:18px; }
```

- [ ] **Step 4: Run the tests and checks**

Run: `npx vitest run tests/ui-account-usage.test.tsx tests/ui-account-usage-model.test.tsx && npm run typecheck && npm run lint`
Expected: all pass. If the `.redeemable-resets` card CSS in the existing stylesheet relies on a rule that is missing in the expanded panel, add a `.usage-row-detail .redeemable-resets` override rather than touching the card rule.

- [ ] **Step 5: Run the whole UI suite**

Run: `npm run test:ui`
Expected: PASS. `tests/ui-page.test.tsx` and any navigation test that renders the home page now meet Row view; if a test asserts card text, set `localStorage.setItem('cmux-companion-usage-view', 'card')` in that test's setup rather than weakening the assertion.

- [ ] **Step 6: Commit**

```bash
git add app/account-usage.tsx app/account-usage-table.tsx app/account-usage.css tests/ui-account-usage.test.tsx
git commit -m "feat: add a Row / Card selector with a dense account table as the default

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Phase 3: Browser coverage and verification

### Task 5: Cypress journeys

**Files:**
- Modify: `cypress/e2e/account-usage.cy.ts`
- Modify (only if it fails): `cypress/e2e/settings.cy.ts`, `cypress/e2e/ui-consistency.cy.ts`

- [ ] **Step 1: Make the card journeys select Card view**

In `cypress/e2e/account-usage.cy.ts`, add after `visitUsage`:

```ts
const cardView = { onBeforeLoad(win: Window) { win.localStorage.setItem('cmux-companion-usage-view', 'card'); } };
```

Change `visitUsage` to `cy.visit("/?view=usage", cardView);`. Change every other `cy.visit('/')` and `cy.visit('/?view=usage')` in the existing tests to pass `cardView` as the second argument. Search with `grep -n "cy.visit" cypress/e2e/account-usage.cy.ts` and update each one.

- [ ] **Step 2: Add the Row view journeys**

Append inside the `describe("licence usage", ...)` block:

```ts
  it('shows every account in one table by default at 1440px and keeps the choice after reload', () => {
    cy.viewport(1440, 900);
    scenario();
    const usage = fiveAccountFixture();
    usage.providers[0].accounts[0].redeemableResets = { availableCount: 1, updatedAt: iso(-5), grants: [{ count: 1, expiresAt: iso(10 * 24 * 60), usableNow: true }] };
    usage.providers[0].accounts.push({ ...usage.providers[0].accounts[0], id: 'limited', email: 'limited@example.test', status: 'unavailable', updatedAt: null, retryAt: iso(4), windows: [], redeemableResets: undefined, message: 'Usage temporarily rate-limited by the provider. Try again later.' });
    usage.providers[1].accounts.push(...[1, 2, 3].map(index => ({ ...usage.providers[1].accounts[0], id: `extra-${index}`, email: `extra-${index}@example.test` })));
    cy.intercept('GET', '**/api/account-usage*', usage).as('usage');
    cy.clock(frozenNow.getTime(), ['Date']); cy.visit('/'); cy.wait('@usage');
    cy.findByRole('group', { name: 'Account layout' }).findByRole('button', { name: 'Row' }).should('have.attr', 'aria-pressed', 'true');
    cy.get('.reset-queue').should('not.exist');
    cy.get('.usage-account').should('not.exist');
    cy.get('.usage-row').should('have.length', 9);
    cy.get('.usage-row').first().should('contain.text', 'personal@example.test').and('contain.text', 'Check account');
    cy.get('.usage-row').eq(1).should('contain.text', 'work@example.test').and('contain.text', 'Use before reset').and('contain.text', '55% remaining').and('contain.text', '82% remaining').and('contain.text', '1 saved reset');
    cy.get('.usage-row').last().should('contain.text', 'limited@example.test').and('contain.text', 'Not in queue').and('contain.text', 'No reset reported').and('contain.text', 'Retry in 4m');
    cy.get('.usage-row').each($row => expect($row[0].getBoundingClientRect().bottom).to.be.at.most(900));
    cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(1440));
    cy.findByRole('button', { name: 'Usable now' }).click();
    cy.get('.usage-row').should('have.length', 7).first().should('contain.text', 'work@example.test');
    cy.findByRole('button', { name: /^Next reset$/ }).click();
    cy.findByRole('complementary', { name: 'Next weekly reset' }).findByRole('link').click();
    cy.focused().should('have.id', 'usage-account-claude-personal');
    cy.findByRole('button', { name: 'Show details for work@example.test' }).click();
    cy.get('#usage-row-detail-claude-work').should('be.visible').and('contain.text', 'Monthly provider limit').and('contain.text', 'Delete connection').and('contain.text', 'Check Claude resets');
    cy.screenshot('account-usage-rows-1440', { capture: 'fullPage', scale: true });
    cy.findByRole('group', { name: 'Account layout' }).findByRole('button', { name: 'Card' }).click();
    cy.get('.usage-account').should('have.length', 9);
    cy.get('.reset-queue-row').should('have.length', 8);
    cy.reload(); cy.wait('@usage');
    cy.get('.usage-account').should('have.length', 9);
    cy.findByRole('group', { name: 'Account layout' }).findByRole('button', { name: 'Card' }).should('have.attr', 'aria-pressed', 'true');
  });

  it('forces the card layout at 390px and hides the selector', () => {
    cy.viewport(390, 900);
    scenario();
    cy.intercept('GET', '**/api/account-usage*', fiveAccountFixture()).as('usage');
    cy.clock(frozenNow.getTime(), ['Date']); cy.visit('/'); cy.wait('@usage');
    cy.findByRole('group', { name: 'Account layout' }).should('not.exist');
    cy.get('.usage-table').should('not.exist');
    cy.get('.usage-account').should('have.length', 5);
    cy.get('.reset-queue-row').should('have.length', 5);
    cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(390));
  });
```

Counts in the first journey: the five-account fixture plus one unavailable Claude account plus three extra Codex accounts gives 9 rows. The queue in Card view has 8 members because `limited` has no weekly window. In the fixture `personal` is paused, so it reads Check account and is excluded by Usable now, and `limited` is never in the queue, leaving 7 usable rows. If a count differs when you run it, inspect the fixture rather than the assertion: the rule is "every account with a fresh, future weekly reset is in the queue".

- [ ] **Step 3: Run the account usage Cypress spec**

Run: `npm run test:e2e:local -- --spec cypress/e2e/account-usage.cy.ts`
If Electron fails: `CMUX_COMPANION_CYPRESS_BROWSER=chrome npm run test:e2e:local -- --spec cypress/e2e/account-usage.cy.ts`
Expected: all tests pass. If a width assertion fails in Row view, reduce the padding in `.usage-table th, td` to `6px 8px` and re-run.

- [ ] **Step 4: Run the related specs**

Run: `npm run test:e2e:local -- --spec "cypress/e2e/settings.cy.ts,cypress/e2e/ui-consistency.cy.ts"`
Expected: PASS. If `settings.cy.ts` asserts card content on the embedded usage panel, pass `cardView` style `onBeforeLoad` to its visit. If `ui-consistency.cy.ts` only checks colours and overflow, no change is needed.

- [ ] **Step 5: Commit**

```bash
git add cypress/e2e/account-usage.cy.ts
git commit -m "test: cover the account usage Row view and forced Card layout in Cypress

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If `settings.cy.ts` or `ui-consistency.cy.ts` changed, add them to the same commit.

### Task 6: Full verification and review

**Files:** none new.

- [ ] **Step 1: Run full verification**

Run: `npm run verify`
Expected: backend/UI coverage at or above 90%, lint, typecheck and build pass. If UI coverage drops below 90%, the uncovered lines are in `account-usage-table.tsx`; add a UI test for the empty table (`rows` empty with `usableOnly` true shows "No usable capacity with an upcoming weekly reset is reported.").

- [ ] **Step 2: Check the live page in the browser**

Start the app with `npm run companion:dev` as described in `AGENTS.md`, pair, open `/` at a desktop width, and confirm that nine accounts fit without vertical scroll, that the Fable, 5 hours and Redeemable resets cells match the card values, and that the selector switch persists after reload.

- [ ] **Step 3: Request code review**

Use the superpowers:requesting-code-review skill on the three feature commits. Resolve findings, then re-run `npm run test:ui && npm run lint && npm run typecheck`.

- [ ] **Step 4: Final commit if review changed files**

```bash
git add -A app tests cypress
git commit -m "fix: address review findings for the account usage Row view

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Do not push. Do not merge. Report the branch state to the user.

---

## Self-review

**Spec coverage.** Default Row and per-browser persistence: Task 3. Forced Card below 760 px with the choice preserved: Task 3 hook and CSS, Task 5 journey. Table replaces the queue and provider groups: Task 3 step 4 and Task 4. Width cap lifted in Row view: Task 3 CSS. Highlight links focus rows: `<tr id>` with `tabIndex` in Task 4, tested in Task 4 and Task 5. Next reset / Usable now filter on the table: lifted state in Task 3, filter in the `AccountTable` call. Sort rule and "No reset reported": `accountRows` in Task 1, cell in Task 4. Columns, dashes for OpenAI, gauge fallbacks: Task 4. Redeemable count and expiry from one helper: `redeemableSummary` in Task 1, `compact` rendering in Task 2. Queue state pill: `queueState` in Task 1. Expand-in-place with Details, Reconnect, Delete, Check resets link: Task 2 `AccountDetailContent` and Task 4. Unavailable reason and retry in the row: `AccountStatusNotes` in Task 4. Card view unchanged: card tests keep passing with Card selected. Regression coverage list: Tasks 1, 3, 4, 5.

**Type consistency.** `coreReadings` returns `{ capacityKnown, displayStatus, weekly, fable, session, extras }` and both `AccountCard` and `AccountTable` destructure those names. `redeemableSummary` returns `{ count, label, expiry, partial, blocked }` used by `RedeemableResets`. `accountRows` returns `{ provider, account, reset, state, usable }` used by `AccountTable` and the Usable now filter. `AccountDetailContent` takes `onReconnect` as optional; the card omits it, the table passes it.
