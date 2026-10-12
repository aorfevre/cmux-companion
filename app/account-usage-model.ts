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
