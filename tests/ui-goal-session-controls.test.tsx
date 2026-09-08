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

test("exited discovery stays open and can resume without a blocker or approval", async () => {
  const plan = { ...proposal("native"), goalSessionState: "planning", proposal: null, goalSessionRunnerPid: null, goalSessionRunnerDispatchId: null, goalSessionError: null };
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
    ? new Response(JSON.stringify({ ...plan, goalSessionRunnerPid: 123 }), { status: 200 }) : response(plan));
  vi.stubGlobal("fetch", fetchMock);
  render(<ManagedGoalControls workspaceId="native" />);
  await screen.findByText("Conversation closed. Discovery and saved proposals are preserved.");
  assert.equal(screen.queryByRole("button", { name: "Recover failed turn" }), null);
  assert.equal(screen.queryByRole("button", { name: "Approve and implement" }), null);
  fireEvent.click(screen.getByRole("button", { name: "Resume conversation" }));
  await waitFor(() => assert.ok(!screen.queryByRole("button", { name: "Resume conversation" })));
  assert.ok(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/native/recover") && init?.method === "POST"));
});

test("saved proposal remains reviewable after exit and read-only input disables resume", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({ ...proposal("native"), goalSessionRunnerPid: null, goalSessionRunnerDispatchId: null })));
  render(<ManagedGoalControls workspaceId="native" readOnly />);
  await screen.findByText("Ready for review. Approve this revision, then tell the agent to continue here.");
  assert.equal((screen.getByRole("button", { name: "Resume conversation" }) as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByRole("button", { name: "Approve and implement" }) as HTMLButtonElement).disabled, true);
});
