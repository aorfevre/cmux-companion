import assert from "node:assert/strict";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, test, vi } from "vitest";
import { BurstBanner, BurstPlanSheet } from "../app/burst-plan";
import type { AgentCapacity } from "../app/agent-capacity";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const REPO = "repoAAAAAAAAAAAAAA";
const burst = { burstId: "burst-1", status: "ready", createdAt: "2026-09-08T10:00:00Z", updatedAt: "2026-09-08T10:05:00Z", capacitySnapshot: null,
  candidates: [
    { repositoryId: REPO, repositoryName: "trust-layer", goal: "Cover the plan store", rationale: "35 modules have no test", evidence: ["server/burst-store.mjs"], sizeEstimate: "medium", status: "proposed", reason: null, planId: null, updatedAt: "2026-09-08T10:05:00Z" },
    { repositoryId: "repoBBBBBBBBBBBBBB", repositoryName: "ledger", goal: null, rationale: null, evidence: [], sizeEstimate: null, status: "failed", reason: "The scan needs the ccs CLI", planId: null, updatedAt: "2026-09-08T10:05:00Z" },
  ] };

function stubFetch(handlers: Record<string, (init?: RequestInit) => unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, "");
    calls.push({ url, init });
    const key = `${(init?.method || "GET").toUpperCase()} ${url}`;
    const handler = handlers[key];
    if (!handler) return new Response(JSON.stringify({ error: `no handler for ${key}` }), { status: 501 });
    return new Response(JSON.stringify(handler(init)), { status: 200 });
  }));
  return calls;
}

test("lists candidates with rationale, evidence and a stated failure", async () => {
  stubFetch({ "GET /api/bursts": () => ({ bursts: [burst] }), "GET /api/bursts/burst-1": () => burst });
  render(<BurstPlanSheet readOnly={false} onClose={() => {}} onOpenGoal={() => {}} />);
  assert.ok(await screen.findByText("Cover the plan store"));
  assert.ok(screen.getByText("35 modules have no test"));
  assert.ok(screen.getByText("server/burst-store.mjs"));
  assert.ok(screen.getByText("The scan needs the ccs CLI"));
  assert.ok(screen.getByRole("button", { name: "Approve trust-layer" }));
  assert.ok(screen.getByRole("button", { name: "Rescan ledger" }));
});

test("approve sends the edited goal and shows the created goal link", async () => {
  const calls = stubFetch({
    "GET /api/bursts": () => ({ bursts: [burst] }),
    "GET /api/bursts/burst-1": () => burst,
    [`POST /api/bursts/burst-1/candidates/${REPO}/approve`]: () => ({ ...burst.candidates[0], status: "approved", planId: "plan-9", goal: "Cover the plan store fully" }),
  });
  const open = vi.fn();
  render(<BurstPlanSheet readOnly={false} onClose={() => {}} onOpenGoal={open} />);
  const goal = await screen.findByLabelText("Goal for trust-layer");
  await userEvent.clear(goal);
  await userEvent.type(goal, "Cover the plan store fully");
  await userEvent.click(screen.getByRole("button", { name: "Approve trust-layer" }));
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Open goal for trust-layer" })));
  const post = calls.find((c) => c.init?.method === "POST");
  assert.deepEqual(JSON.parse(String(post?.init?.body)), { goal: "Cover the plan store fully" });
  await userEvent.click(screen.getByRole("button", { name: "Open goal for trust-layer" }));
  assert.deepEqual(open.mock.calls[0], [REPO, "plan-9"]);
});

test("read-only disables approve, decline and rescan", async () => {
  stubFetch({ "GET /api/bursts": () => ({ bursts: [burst] }), "GET /api/bursts/burst-1": () => burst });
  render(<BurstPlanSheet readOnly onClose={() => {}} onOpenGoal={() => {}} />);
  assert.ok((await screen.findByRole("button", { name: "Approve trust-layer" })).hasAttribute("disabled"));
  assert.ok(screen.getByRole("button", { name: "Decline trust-layer" }).hasAttribute("disabled"));
  assert.ok(screen.getByRole("button", { name: "Rescan ledger" }).hasAttribute("disabled"));
  assert.ok(screen.getByText(/Enable input in Settings/));
});

test("start a burst when none exists", async () => {
  const calls = stubFetch({ "GET /api/bursts": () => ({ bursts: [] }), "POST /api/bursts": () => ({ ...burst, status: "scanning" }), "GET /api/bursts/burst-1": () => ({ ...burst, status: "scanning" }) });
  render(<BurstPlanSheet readOnly={false} onClose={() => {}} onOpenGoal={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "Start a burst" }));
  await waitFor(() => assert.ok(calls.some((c) => c.init?.method === "POST" && c.url === "/api/bursts")));
  assert.ok(await screen.findByText(/Scanning starred repositories/));
});

test("polling refreshes a scanning burst into its proposed state after 5 seconds", async () => {
  vi.useFakeTimers();
  const scanning = { ...burst, status: "scanning" as const };
  const ready = { ...burst, status: "ready" as const };
  let detailCalls = 0;
  stubFetch({
    "GET /api/bursts": () => ({ bursts: [scanning] }),
    "GET /api/bursts/burst-1": () => { detailCalls += 1; return detailCalls === 1 ? scanning : ready; },
  });
  render(<BurstPlanSheet readOnly={false} onClose={() => {}} onOpenGoal={() => {}} />);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
  assert.ok(screen.getByText(/Scanning starred repositories/));
  assert.equal(detailCalls, 1);
  await vi.advanceTimersByTimeAsync(5_000);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(detailCalls, 2);
  assert.ok(screen.getByText(/Review each candidate below/));
});

test("a failed approve keeps the candidate proposed with Approve enabled and shows the error", async () => {
  const handlers: Record<string, () => Response> = {
    "GET /api/bursts": () => new Response(JSON.stringify({ bursts: [burst] }), { status: 200 }),
    "GET /api/bursts/burst-1": () => new Response(JSON.stringify(burst), { status: 200 }),
    [`POST /api/bursts/burst-1/candidates/${REPO}/approve`]: () => new Response(JSON.stringify({ error: "Goal session already running" }), { status: 500 }),
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, "");
    const key = `${(init?.method || "GET").toUpperCase()} ${url}`;
    const handler = handlers[key];
    if (!handler) return new Response(JSON.stringify({ error: `no handler for ${key}` }), { status: 501 });
    return handler();
  }));
  render(<BurstPlanSheet readOnly={false} onClose={() => {}} onOpenGoal={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "Approve trust-layer" }));
  const alert = await screen.findByRole("alert");
  assert.match(alert.textContent || "", /Goal session already running/);
  const approve = screen.getByRole("button", { name: "Approve trust-layer" });
  assert.equal(approve.hasAttribute("disabled"), false);
});

test("the banner shows only for a live weekly opportunity", () => {
  const now = Date.parse("2026-09-08T12:00:00Z");
  const weekly = { cadence: "weekly", label: "Weekly", remainingPercent: 60, resetAt: "2026-09-09T06:00:00Z" };
  const capacity: AgentCapacity = { available: true, next: "claude", reason: "", nextReset: weekly.resetAt, providers: [{ id: "claude", label: "Claude", available: true, headroom: 60, bestPercent: 60, accounts: [{ id: "w", label: "Work", status: "ready", headroom: 60, windows: [weekly], opportunity: weekly }] }] };
  const start = vi.fn();
  const { rerender } = render(<BurstBanner capacity={capacity} now={now} onStart={start} />);
  assert.ok(screen.getByRole("button", { name: "Start a burst" }));
  rerender(<BurstBanner capacity={capacity} now={Date.parse(weekly.resetAt)} onStart={start} />);
  assert.equal(screen.queryByRole("button", { name: "Start a burst" }), null);
});
