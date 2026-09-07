import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useImageAttachments } from "../app/image-attachments";

afterEach(() => vi.unstubAllGlobals());
const photo = (name: string) => new File(["image fixture"], name, { type: "image/png" });

test("concurrent uploads reserve capacity before sending and release it on removal", async () => {
  const responses: ((value: Response) => void)[] = [];
  const fetcher = vi.fn(() => new Promise<Response>(resolve => responses.push(resolve)));
  vi.stubGlobal("fetch", fetcher);
  const notice = vi.fn();
  const { result } = renderHook(() => useImageAttachments(notice));
  let first!: Promise<void>; let second!: Promise<void>;
  act(() => {
    first = result.current.addImages([photo("one"), photo("two"), photo("three")]);
    second = result.current.addImages([photo("four"), photo("five")]);
  });
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
  await act(async () => {
    responses.forEach((resolve, index) => resolve(new Response(JSON.stringify({ image: { path: `/image-${index}`, name: `image-${index}`, mime: "image/png", size: 10 } }))));
    await Promise.all([first, second]);
  });
  expect(result.current.attachments).toHaveLength(4);
  expect(result.current.uploading).toBe(0);
  act(() => result.current.removeImage(result.current.attachments[0].path));
  expect(result.current.attachments).toHaveLength(3);
});

test("switching owner or clearing attachments invalidates pending uploads", async () => {
  let complete!: (value: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { complete = resolve; }));
  vi.stubGlobal("fetch", fetcher);
  const notice = vi.fn();
  const { result, rerender } = renderHook(({ owner }) => useImageAttachments(notice, owner), { initialProps: { owner: "terminal-a" } });
  let pending!: Promise<void>;
  act(() => { pending = result.current.addImages([photo("old")]); });
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  rerender({ owner: "terminal-b" });
  await act(async () => { complete(new Response(JSON.stringify({ image: { path: "/old", name: "old", mime: "image/png", size: 1 } }))); await pending; });
  expect(result.current.attachments).toEqual([]);
  expect(result.current.uploading).toBe(0);
  act(() => { pending = result.current.addImages([photo("cleared")]); });
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  act(() => result.current.clearAttachments());
  await act(async () => { complete(new Response(JSON.stringify({ image: { path: "/cleared", name: "cleared", mime: "image/png", size: 1 } }))); await pending; });
  expect(result.current.attachments).toEqual([]);
});
