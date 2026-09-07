import { useCallback, useLayoutEffect, useRef } from "react";

type Pending = { controller: AbortController; promise: Promise<void> };

// Share reads only within one committed selection. A -> B -> A creates a new
// owner, so the second A cannot adopt a response requested for the first A.
export function useOwnedReads(identity: string) {
  const scope = useRef<{ identity: string; active: boolean; pending: Map<string, Pending> } | null>(null);
  useLayoutEffect(() => {
    const owner = { identity, active: true, pending: new Map<string, Pending>() };
    scope.current = owner;
    return () => {
      owner.active = false;
      for (const request of owner.pending.values()) request.controller.abort();
      owner.pending.clear();
    };
  }, [identity]);
  return useCallback(<T,>(channel: string, load: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void, failed: (cause: unknown) => void, force = false): Promise<void> => {
    const owner = scope.current;
    if (!owner?.active || owner.identity !== identity) return Promise.resolve();
    const previous = owner.pending.get(channel);
    if (previous && !force) return previous.promise;
    previous?.controller.abort();
    const request: Pending = { controller: new AbortController(), promise: Promise.resolve() };
    owner.pending.set(channel, request);
    const current = () => owner.active && owner.pending.get(channel) === request;
    request.promise = (async () => {
      try { const value = await load(request.controller.signal); if (current()) apply(value); }
      catch (cause) { if (current()) failed(cause); }
      finally { if (current()) owner.pending.delete(channel); }
    })();
    return request.promise;
  }, [identity]);
}
