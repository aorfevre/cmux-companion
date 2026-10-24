const MIN_INTERVAL_MS = 60_000;
const FIRST_BACKOFF_MS = 2 * MIN_INTERVAL_MS;
const MAX_BACKOFF_MS = 30 * MIN_INTERVAL_MS;
// Longer than every provider request timeout. A load that outlives it is
// orphaned: without this bound one promise that never settles blocks its key,
// and every account snapshot that waits on it, until the service restarts.
export const LOAD_DEADLINE_MS = 20_000;

export function withDeadline(promise, ms, fallback) {
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve(fallback()), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Shared by every client of one AccountUsage instance. Snapshot invalidation
// must never discard these budgets or start a second request already in flight.
export class AccountPollCache {
  constructor({ now = () => Date.now(), deadlineMs = LOAD_DEADLINE_MS } = {}) {
    this.now = now;
    this.deadlineMs = deadlineMs;
    this.entries = new Map();
  }

  async read(key, load, { identity = null, cacheMs = MIN_INTERVAL_MS } = {}) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { nextAt: 0, cacheUntil: 0, backoff: 0, identity, value: null, pending: null };
      this.entries.set(key, entry);
    }
    if (entry.pending) return entry.pending;
    const now = this.now();
    if (now < entry.nextAt || entry.identity === identity && now < entry.cacheUntil) return entry.value;
    entry.nextAt = now + MIN_INTERVAL_MS;
    entry.identity = identity;
    const loaded = Promise.resolve().then(load).catch(() => ({ success: false, windows: [] }));
    const pending = withDeadline(loaded, this.deadlineMs, () => ({ success: false, windows: [], failureReason: 'timeout' }))
      .then(value => {
        const finishedAt = this.now();
        entry.nextAt = Math.max(entry.nextAt, finishedAt + MIN_INTERVAL_MS);
        if (value.failureReason === 'rate-limited') {
          entry.backoff = Math.min(entry.backoff ? entry.backoff * 2 : FIRST_BACKOFF_MS, MAX_BACKOFF_MS);
          entry.nextAt = Math.max(entry.nextAt, finishedAt + entry.backoff, value.retryAfterAt ?? 0);
          value = { ...value, retryAt: new Date(entry.nextAt).toISOString() };
        } else if (value.success) entry.backoff = 0;
        entry.cacheUntil = Math.max(entry.nextAt, finishedAt + (value.success ? cacheMs : MIN_INTERVAL_MS));
        entry.value = value;
        return value;
      });
    entry.pending = pending;
    try { return await pending; }
    finally { if (entry.pending === pending) entry.pending = null; }
  }
}

export function retryAfterAt(header, now = Date.now()) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const value = header.trim();
  const deadline = /^\d+(?:\.\d+)?$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(deadline) && deadline > now && deadline <= 8.64e15 ? deadline : null;
}
