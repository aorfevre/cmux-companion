// Shared eligibility for dashboard recommendations and legacy task assignment.
// This selects providers, never credentials or a running session's account.
export const MIN_HEADROOM = 5;
export const FRESH_MS = 120_000;

export function usageWindows(account) {
  return (account?.windows || []).filter((window) => window?.category === "usage"
    && Number.isFinite(window.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100);
}

export function accountHeadroom(account) {
  const values = usageWindows(account).map((window) => window.remainingPercent);
  return values.length ? Math.min(...values) : null;
}

export function observationState(account, now = Date.now()) {
  const at = Date.parse(account?.updatedAt);
  if (!Number.isFinite(at) || at > now) return "unknown";
  return now - at > FRESH_MS ? "stale" : "fresh";
}

export function accountEligibility(account, providerAvailable = true) {
  if (account?.paused) return "paused";
  if (account?.status === "reconnect") return "reconnect";
  if (!providerAvailable) return "unknown";
  const headroom = accountHeadroom(account);
  if (account?.status === "exhausted" || (headroom !== null && headroom <= MIN_HEADROOM)) return "limited";
  if (!["ready", "low"].includes(account?.status) || headroom === null) return "unknown";
  return "eligible";
}

export function providerCapacity(usage, id) {
  const provider = (usage?.providers || []).find((item) => item?.id === id);
  const accounts = provider?.accounts || [];
  const eligible = accounts.filter((account) => accountEligibility(account, provider?.available !== false) === "eligible");
  const headroom = eligible.length ? Math.max(...eligible.map(accountHeadroom)) : null;
  const unknown = !accounts.length || accounts.some((account) => accountEligibility(account, provider?.available !== false) === "unknown");
  return { headroom, state: headroom !== null ? "eligible" : unknown ? "unknown" : "blocked" };
}

export function weeklyOpportunity(account, now = Date.now()) {
  const candidates = usageWindows(account).filter((window) => window.cadence === "weekly"
    && window.remainingPercent >= 20 && Date.parse(window.resetAt) > now
    && Date.parse(window.resetAt) - now <= 24 * 3_600_000);
  return candidates.sort((a, b) => Date.parse(a.resetAt) - Date.parse(b.resetAt))[0] || null;
}
