import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AgentCapacityChip, AgentCapacityStrip, WeeklyOpportunities, type AgentCapacity } from "../app/agent-capacity";

afterEach(cleanup);
const now = Date.parse("2026-09-07T12:00:00Z");
const weekly = { cadence: "weekly", label: "Weekly", remainingPercent: 60, resetAt: "2026-09-07T15:00:00Z" };
const capacity: AgentCapacity = { available: true, next: "claude", reason: "Claude is recommended", nextReset: weekly.resetAt,
  providers: [{ id: "claude", label: "Claude", available: true, headroom: 45, bestPercent: 45,
    accounts: [{ id: "work", label: "Work", status: "ready", headroom: 45, updatedAt: "2026-09-07T11:00:00Z", windows: [weekly], opportunity: weekly }] }] };

test("weekly opportunity is visible with account identity and stale observation", () => {
  const { rerender } = render(<WeeklyOpportunities capacity={capacity} error="" now={now} />);
  expect(screen.getByText("Claude · Work")).toBeTruthy();
  expect(screen.getByText("60% weekly remaining")).toBeTruthy();
  expect(screen.getByText(/Stale · Observed 60m ago/)).toBeTruthy();
  rerender(<WeeklyOpportunities capacity={capacity} error="" now={Date.parse(weekly.resetAt)} />);
  expect(screen.queryByRole("region")).toBeNull();
});

test("failed refresh hides opportunities and recommendations while retaining labelled observations", () => {
  render(<><WeeklyOpportunities capacity={capacity} error="Failed refresh" now={now} /><AgentCapacityStrip capacity={capacity} error="Failed refresh" now={now} onRetry={vi.fn()} /></>);
  expect(screen.queryByRole("region", { name: "Weekly reset opportunities" })).toBeNull();
  expect(screen.getByRole("region", { name: "Claude Work" })).toBeTruthy();
  expect(screen.queryByText("Recommended provider")).toBeNull();
  expect(screen.getByText(/Previous observations may be outdated/)).toBeTruthy();
});

test("unknown capacity is not labelled exhausted", () => {
  render(<AgentCapacityChip capacity={{ ...capacity, available: false, state: "unknown", next: null }} error="" now={now} open={false} onToggle={vi.fn()} />);
  expect(screen.getByRole("button", { name: /Quota unknown/ })).toBeTruthy();
  expect(screen.queryByText(/exhausted/i)).toBeNull();
});
