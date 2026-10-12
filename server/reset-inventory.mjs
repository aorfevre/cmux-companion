// Display-only inventory. Redemption handles and raw provider metadata never
// cross the authenticated account-usage boundary.
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 10_000;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : null;
const bound = value => value == null || date(value) !== null;

export function claudeResetInventory(payload, now = Date.now()) {
  const block = payload?.cedar_ember;
  if (!block || block.eligible !== true || !Array.isArray(block.grants) || block.grants.length > 200) return null;
  const grants = [];
  for (const grant of block.grants) {
    if (!grant || !count(grant.resets_left) || typeof grant.paused !== 'boolean'
      || grant.resets_total != null && (!count(grant.resets_total) || grant.resets_left > grant.resets_total)
      || !bound(grant.starts_at) || !bound(grant.ends_at)) return null;
    if (grant.paused || grant.resets_left === 0
      || grant.starts_at && Date.parse(grant.starts_at) > now
      || grant.ends_at && Date.parse(grant.ends_at) <= now) continue;
    grants.push({ count: grant.resets_left, expiresAt: date(grant.ends_at), usableNow: typeof grant.usable_now === 'boolean' ? grant.usable_now : null });
  }
  return normalizeResetInventory({ availableCount: grants.reduce((sum, grant) => sum + grant.count, 0), grants, updatedAt: new Date(now).toISOString() });
}

export function codexResetInventory(summary, details = null, now = Date.now()) {
  if (!summary || !count(summary.available_count)) return null;
  let grants = summary.available_count === 0 ? [] : null;
  // A detail response can be capped, or race with redemption in another client.
  // Preserve the current usage count when details cannot describe that reading.
  if (details && details.available_count === summary.available_count && Array.isArray(details.credits) && details.credits.length <= 200) {
    const available = details.credits.filter(credit => credit?.status === 'available');
    if (available.every(credit => bound(credit.expires_at)) && available.length <= summary.available_count) {
      grants = available.map(credit => ({ count: 1, expiresAt: date(credit.expires_at), usableNow: null }));
    }
  }
  return normalizeResetInventory({ availableCount: summary.available_count, grants, updatedAt: new Date(now).toISOString() });
}

export function normalizeResetInventory(value) {
  if (!value || !count(value.availableCount) || !date(value.updatedAt)) return null;
  let grants = null;
  if (Array.isArray(value.grants) && value.grants.length <= 200) {
    if (!value.grants.every(grant => grant && count(grant.count) && bound(grant.expiresAt))) return null;
    grants = value.grants.map(grant => ({ count: grant.count, expiresAt: date(grant.expiresAt), usableNow: typeof grant.usableNow === 'boolean' ? grant.usableNow : null }));
    if (grants.reduce((sum, grant) => sum + grant.count, 0) > value.availableCount) return null;
  }
  return { availableCount: value.availableCount, grants, updatedAt: date(value.updatedAt) };
}
