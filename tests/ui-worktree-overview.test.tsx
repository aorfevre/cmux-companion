import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, test, vi } from "vitest";
import { WorktreeOverview } from "../app/worktree-overview";

const entry = (id: string, eligible: boolean, classification = "development") => ({ id, path: `/repos/${id}`, repository: "Fixture", branch: id, classification, eligible, reasons: [eligible ? "Exact goal PR merged" : "An open session uses this worktree"], estimatedBytes: null });
const snapshot = { previewId: "review-1", generatedAt: "2026-09-08T08:00:00Z", roots: ["/repos"], repositoryCount: 1, entries: [entry("finished", true), entry("active", false), entry("primary", false, "primary")], errors: [], summary: { candidates: 1, protected: 2, estimatedBytes: 1024 ** 3 } };
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("loads an overview without deleting and collects only reviewed eligible IDs after confirmation", async () => {
  let scans = 0;
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/preview")) return reply(++scans === 1 ? snapshot : { ...snapshot, previewId: "review-2", entries: snapshot.entries.slice(1), summary: { candidates: 0, protected: 2, estimatedBytes: 0 } });
    assert.ok(String(url).endsWith("/run"));
    assert.deepEqual(JSON.parse(String(init?.body)), { previewId: "review-1", ids: ["finished"], prune: [] });
    return reply({ results: [{ path: "/repos/finished", outcome: "removed" }] });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<WorktreeOverview />);
  await screen.findByText("3 of 3 checkouts shown");
  assert.equal(fetchMock.mock.calls.length, 1);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "active" } });
  await screen.findByText("1 of 3 checkouts shown");
  fireEvent.click(screen.getByRole("button", { name: "Run garbage collection (1)" }));
  assert.match(screen.getByText(/Search and filters do not limit collection/).textContent || "", /all 1/);
  assert.equal(fetchMock.mock.calls.length, 1);
  fireEvent.click(screen.getByRole("button", { name: "Confirm garbage collection" }));
  await screen.findByText("1 removed · 0 skipped · 0 failed");
  await waitFor(() => assert.equal(scans, 2));
  assert.equal((screen.getByRole("button", { name: "Run garbage collection (0)" }) as HTMLButtonElement).disabled, true);
});

test("failed scan shows an error without false zero counts or a runnable collection", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => reply({ error: "Inventory unavailable" }, 503)));
  render(<WorktreeOverview />);
  await screen.findByRole("alert");
  assert.equal(screen.queryByRole("button", { name: /Run garbage collection/ }), null);
  assert.equal(screen.getAllByText("—").length, 4);
});

test("failed collection invalidates its preview and cannot be replayed without a new scan", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => String(url).endsWith("/preview") ? reply(snapshot) : reply({ error: "Refresh the cleanup preview before running cleanup" }, 400)));
  render(<WorktreeOverview />);
  fireEvent.click(await screen.findByRole("button", { name: "Run garbage collection (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm garbage collection" }));
  await screen.findByRole("alert");
  assert.equal(screen.queryByRole("button", { name: /Confirm garbage collection|Run garbage collection/ }), null);
});

test("partial results and incomplete inventory remain visible", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => String(url).endsWith("/preview")
    ? reply({ ...snapshot, errors: [{ path: "/repos/broken", error: "Broken Git reference" }] })
    : reply({ results: [{ path: "/repos/finished", outcome: "skipped", reason: "Now active" }] })));
  render(<WorktreeOverview />);
  await screen.findByText("Inventory is incomplete");
  fireEvent.click(screen.getByRole("button", { name: "Run garbage collection (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm garbage collection" }));
  await screen.findByText("0 removed · 1 skipped · 0 failed");
  await screen.findByText("skipped: /repos/finished — Now active");
});
