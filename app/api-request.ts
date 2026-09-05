const reads = new Map<string, Promise<unknown>>();

// Polls and event refreshes share an unfinished read. Mutations invalidate the
// map so the following refresh cannot reuse a read started before the write.
export function request<T>(path: string, init?: RequestInit): Promise<T> {
  const share = init === undefined;
  if (share && reads.has(path)) return reads.get(path) as Promise<T>;
  if (init && !["GET", "HEAD"].includes((init.method || "GET").toUpperCase())) reads.clear();
  const pending = (async () => {
    const response = await fetch(path, { ...init, headers: { ...(init?.body != null ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body as T;
  })();
  if (!share) return pending;
  reads.set(path, pending);
  void pending.finally(() => { if (reads.get(path) === pending) reads.delete(path); }).catch(() => {});
  return pending;
}
