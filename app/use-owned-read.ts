import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { request } from "./api-request";

// Each mounted resource identity owns its responses. A → B → A creates a new
// owner, so the first A cannot overwrite the second A (or clear its errors).
export function useOwnedRead<T>(path: string | null, initial: T, equal: (left: T, right: T) => boolean = Object.is, identity: string | null = path) {
  const owner = useMemo(() => ({ path, identity, active: false, sequence: 0, pending: null as Promise<T> | null }), [path, identity]);
  const [snapshot, setSnapshot] = useState<{ owner: typeof owner; value: T; error: string } | null>(null);
  useLayoutEffect(() => {
    owner.active = true;
    return () => { owner.active = false; owner.sequence++; };
  }, [owner]);

  const refresh = useCallback(async (force = false) => {
    if (!path || !owner.active) return;
    if (force) owner.pending = null;
    const sequence = ++owner.sequence;
    // Share polls only within this owner, never with an earlier A in A → B → A.
    const pending = owner.pending ??= request<T>(path, { method: "GET" });
    try {
      const value = await pending;
      if (!owner.active || sequence !== owner.sequence) return;
      setSnapshot(current => current?.owner === owner && !current.error && equal(current.value, value)
        ? current : { owner, value, error: "" });
    } catch (cause) {
      if (!owner.active || sequence !== owner.sequence) return;
      setSnapshot(current => ({ owner, value: current?.owner === owner ? current.value : initial, error: cause instanceof Error ? cause.message : "Request failed" }));
    } finally {
      if (owner.pending === pending) owner.pending = null;
    }
  }, [path, owner, equal, initial]);
  const clear = useCallback(() => {
    owner.sequence++;
    owner.pending = null;
    setSnapshot({ owner, value: initial, error: "" });
  }, [initial, owner]);
  return { value: snapshot?.owner === owner ? snapshot.value : initial, error: snapshot?.owner === owner ? snapshot.error : "", refresh, clear };
}
