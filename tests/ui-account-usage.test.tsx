import assert from "node:assert/strict";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, test, vi } from "vitest";
import { AccountUsageView, resetText } from "../app/account-usage";
import { DEFAULT_LAUNCHERS } from "../server/provider-launchers.mjs";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("usage polling pauses when hidden, resumes on return, coalesces requests and preserves data on failure", async () => {
  vi.useFakeTimers();
  let visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility as DocumentVisibilityState);
  let fail = false;
  let release: (() => void) | null = null;
  let calls = 0;
  const payload = { generatedAt: new Date().toISOString(), available: true, summary: {}, providers: [{ id: "kimi", label: "Kimi Code", available: false, accounts: [], message: "Configure Kimi usage on the Mac" }] };
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.includes("launchers")) return Response.json({ providers: DEFAULT_LAUNCHERS });
    calls++;
    if (calls === 3) await new Promise<void>((resolve) => { release = resolve; });
    return Response.json(fail ? { error: "Quota request failed" } : payload, { status: fail ? 503 : 200 });
  });
  const view = render(<AccountUsageView onBack={() => {}} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  assert.equal(calls, 1);
  assert.ok(screen.getByText("Configure Kimi usage on the Mac"));
  visibility = "hidden";
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  assert.equal(calls, 1);
  visibility = "visible";
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  assert.equal(calls, 2);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  assert.equal(calls, 3);
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(60_000); });
  assert.equal(calls, 3);
  await act(async () => { release?.(); });
  fail = true;
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh account usage" })); });
  assert.ok(screen.getByText("Refresh failed · showing previous usage"));
  assert.ok(screen.getByText("Configure Kimi usage on the Mac"));
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  assert.equal(calls, 4);
});

test("reset labels identify units and never promise a reset has completed", () => {
  assert.equal(resetText(new Date(3_661_000).toISOString(), 0), "Resets in 1h 2m");
  assert.equal(resetText(new Date(0).toISOString(), 0), "Reset due");
  assert.equal(resetText(null, 0), "Reset unknown");
});
