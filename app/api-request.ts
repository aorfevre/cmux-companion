const reads = new Map<string, Promise<unknown>>();

// Polls and event refreshes share an unfinished read. Mutations invalidate the
// map so the following refresh cannot reuse a read started before the write.
export function request<T>(path: string, init?: RequestInit): Promise<T> {
  const share = init === undefined;
  if (share && reads.has(path)) return reads.get(path) as Promise<T>;
  if (init && !["GET", "HEAD"].includes((init.method || "GET").toUpperCase())) reads.clear();
  const pending = (async () => {
    const headers = new Headers(init?.headers);
    if (init?.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(path, { ...init, headers });
    if (response.ok && (response.status === 204 || init?.method?.toUpperCase() === "HEAD")) return undefined as T;
    let body: unknown;
    try { body = await response.json(); }
    catch {
      throw new Error(response.ok ? "Companion returned invalid JSON" : `Request failed (${response.status})`);
    }
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
      throw new Error(message);
    }
    return body as T;
  })();
  if (!share) return pending;
  reads.set(path, pending);
  void pending.finally(() => { if (reads.get(path) === pending) reads.delete(path); }).catch(() => {});
  return pending;
}
