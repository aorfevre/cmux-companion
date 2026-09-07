import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useOwnedRead } from "../app/use-owned-read";

afterEach(() => vi.unstubAllGlobals());
function pending() {
  let resolve!: (value: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const staleError of [false, true]) test(`a previous owner cannot replace the current value or error (${staleError ? "error" : "success"})`, async () => {
  const a = pending(); const b = pending();
  vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise));
  const { result, rerender } = renderHook(({ path }) => useOwnedRead<{ label: string } | null>(path, null), { initialProps: { path: `/fixture/owned-a-${staleError}` } });
  let first!: Promise<void>; let second!: Promise<void>;
  act(() => { first = result.current.refresh(); });
  rerender({ path: `/fixture/owned-b-${staleError}` });
  expect(result.current.value).toBeNull();
  act(() => { second = result.current.refresh(); });
  await act(async () => { b.resolve(new Response('{"label":"B"}')); await second; });
  await act(async () => { if (staleError) a.reject(new Error("A failed")); else a.resolve(new Response('{"label":"A"}')); await first; });
  expect(result.current.value).toEqual({ label: "B" });
  expect(result.current.error).toBe("");
});

test("clearing and unmounting invalidate pending responses and stale refresh callbacks", async () => {
  const a = pending();
  const fetcher = vi.fn().mockReturnValue(a.promise);
  vi.stubGlobal("fetch", fetcher);
  const { result, unmount } = renderHook(() => useOwnedRead<string | null>("/fixture/owned-clear", null));
  let first!: Promise<void>;
  act(() => { first = result.current.refresh(); result.current.clear(); });
  await act(async () => { a.resolve(new Response('"old"')); await first; });
  expect(result.current.value).toBeNull();
  const refresh = result.current.refresh;
  unmount();
  await refresh();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("A → B → A starts a new read and ignores the first A even when it resolves last", async () => {
  const firstA = pending(); const lastA = pending();
  vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(firstA.promise).mockReturnValueOnce(lastA.promise));
  const { result, rerender } = renderHook(({ path }) => useOwnedRead<string | null>(path, null), { initialProps: { path: "/fixture/return-a" } });
  let old!: Promise<void>; let current!: Promise<void>;
  act(() => { old = result.current.refresh(); });
  rerender({ path: "/fixture/return-b" });
  rerender({ path: "/fixture/return-a" });
  act(() => { current = result.current.refresh(); });
  await act(async () => { lastA.resolve(new Response('"new A"')); await current; });
  await act(async () => { firstA.resolve(new Response('"old A"')); await old; });
  expect(result.current.value).toBe("new A");
});

for (const change of ["mutation", "identity"]) test(`${change} prevents a pending read from hiding fresh state`, async () => {
  const before = pending(); const after = pending();
  vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise));
  const { result, rerender } = renderHook(({ identity }) => useOwnedRead<string | null>("/fixture/same-resource", null, Object.is, identity), { initialProps: { identity: "paired:first" } });
  let old!: Promise<void>; let current!: Promise<void>;
  act(() => { old = result.current.refresh(); });
  if (change === "identity") rerender({ identity: "paired:second" });
  act(() => { current = result.current.refresh(change === "mutation"); });
  await act(async () => { after.resolve(new Response('"fresh"')); await current; });
  await act(async () => { before.resolve(new Response('"stale"')); await old; });
  expect(result.current.value).toBe("fresh");
});
