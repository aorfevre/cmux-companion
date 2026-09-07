import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, test, vi } from "vitest";
import { ManagedGoalControls } from "../app/page";

const proposal = (id: string) => ({ planId: id, goal: id, questions: [], goalSessionGeneration: 1, goalSessionState: "awaiting_approval", proposalRevision: 2, proposal: { intendedBehavior: `Deliver ${id}` } });
const response = (plan: unknown) => new Response(JSON.stringify({ plan }), { status: 200 });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test("a late workspace response cannot expose another goal's approval", async () => {
  let release!: (value: Response) => void;
  const fetchMock = vi.fn((input: RequestInfo | URL) => String(input).endsWith("/a")
    ? new Promise<Response>((resolve) => { release = resolve; })
    : Promise.resolve(response(proposal("b"))));
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<ManagedGoalControls workspaceId="a" />);
  await waitFor(() => assert.equal(fetchMock.mock.calls.length, 1));
  view.rerender(<ManagedGoalControls workspaceId="b" />);
  await screen.findByText("Deliver b");
  await act(async () => { release(response(proposal("a"))); });
  assert.equal(screen.queryByText("Deliver a"), null);
  assert.ok(screen.getByText("Deliver b"));
});

test("read-only protection prevents approval and feedback", async () => {
  const fetchMock = vi.fn(async () => response(proposal("a")));
  vi.stubGlobal("fetch", fetchMock);
  render(<ManagedGoalControls workspaceId="a" readOnly />);
  const approve = await screen.findByRole("button", { name: "Approve and implement" });
  assert.equal((approve as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByRole("textbox") as HTMLTextAreaElement).disabled, true);
  fireEvent.click(approve);
  assert.equal(fetchMock.mock.calls.length, 1);
});

test("polling does not erase a rejected approval", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
    ? new Response(JSON.stringify({ error: "Proposal changed; review the latest revision" }), { status: 409 })
    : response(proposal("a"))));
  render(<ManagedGoalControls workspaceId="a" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Approve and implement" })); });
  assert.match(screen.getByRole("alert").textContent || "", /Proposal changed/);
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  assert.match(screen.getByRole("alert").textContent || "", /Proposal changed/);
});

test("an aborted goal cannot expose a stale proposal approval", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({ ...proposal("a"), boardStatus: "aborted" })));
  render(<ManagedGoalControls workspaceId="a" />);
  assert.ok(await screen.findByText("Goal aborted"));
  assert.equal(screen.queryByRole("button", { name: "Approve and implement" }), null);
});
