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

for (const headers of [{ "X-Fixture": "object" }, new Headers({ "X-Fixture": "headers" }), [["X-Fixture", "tuple"]] as [string, string][]]) test("normalizes all RequestInit header forms and preserves explicit content types", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetcher);
  await request("/fixture/headers", { method: "POST", body: "{}", headers });
  const actual = fetcher.mock.calls[0][1].headers as Headers;
  expect(actual.get("X-Fixture")).toBe(new Headers(headers).get("X-Fixture"));
  expect(actual.get("Content-Type")).toBe("application/json");
});

test("invalid successful JSON fails explicitly and a subsequent read can recover", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("<html>proxy error</html>")).mockResolvedValueOnce(new Response("{}")));
  await expect(request("/fixture/invalid-json")).rejects.toThrow("invalid JSON");
  expect(await request("/fixture/invalid-json")).toEqual({});
});

test("supports empty success and malformed error responses without hiding the status", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response("bad gateway", { status: 502 })));
  expect(await request("/fixture/empty", { method: "DELETE" })).toBeUndefined();
  await expect(request("/fixture/proxy-failure")).rejects.toThrow("502");
});
