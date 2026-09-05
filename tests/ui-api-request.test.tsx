import { afterEach, expect, test, vi } from "vitest";
import { request } from "../app/api-request";
afterEach(() => vi.unstubAllGlobals());

test("overlapping reads share a request and a later read refreshes", async () => {
  let complete!: (value: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>((resolve) => { complete = resolve; }));
  vi.stubGlobal("fetch", fetcher);
  const first = request("/fixture/shared");
  const second = request("/fixture/shared");
  expect(first).toBe(second);
  expect(fetcher).toHaveBeenCalledTimes(1);
  complete(new Response(JSON.stringify({ value: 1 })));
  await first;
  const third = request("/fixture/shared");
  expect(fetcher).toHaveBeenCalledTimes(2);
  complete(new Response(JSON.stringify({ value: 2 })));
  expect(await third).toEqual({ value: 2 });
});

test("a mutation separates subsequent reads from an earlier pending read", async () => {
  let complete!: (value: Response) => void;
  const fetcher = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }))
    .mockResolvedValueOnce(new Response("{}"))
    .mockResolvedValueOnce(new Response('{"value":2}'));
  vi.stubGlobal("fetch", fetcher);
  const old = request("/fixture/mutation");
  await request("/fixture/mutation", { method: "POST", body: "{}" });
  expect(await request("/fixture/mutation")).toEqual({ value: 2 });
  complete(new Response('{"value":1}'));
  await old;
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test("a failed read can be retried", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(new Response("{}")));
  await expect(request("/fixture/failure")).rejects.toThrow("offline");
  expect(await request("/fixture/failure")).toEqual({});
});
