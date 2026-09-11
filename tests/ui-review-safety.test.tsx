import assert from "node:assert/strict";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, test, vi } from "vitest";
import Home from "../app/page";
import { AccountUsageView } from "../app/account-usage";

const workspace = { id: "workspace-1", title: "Safety session", current_directory: "/repo", terminals: [{ id: "terminal-1", title: "shell", is_focused: true }] };
const queued = { id: "queue-1", workspaceId: workspace.id, surfaceId: "terminal-1", text: "Old instruction", createdAt: "2026-09-06", updatedAt: "2026-09-06", attempts: 0 };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function installHome(handler: (url: string, init?: RequestInit) => Promise<Response> | Response | undefined = () => undefined) {
  window.history.replaceState(null, "", "/?mode=sessions&workspace=workspace-1&surface=terminal-1");
  window.localStorage.clear();
  window.localStorage.setItem("cmux-companion-read-only", "false");
  vi.stubGlobal("WebSocket", class { close() {} });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const result = handler(url, init);
    if (result) return result;
    if (url === "/api/auth/status") return response({ paired: true });
    if (url === "/api/bootstrap") return response({ connected: true, host: {}, workspaces: [workspace], refreshedAt: "2026-09-06" });
    if (url.startsWith("/api/goal-sessions/workspace/")) return response({ plan: null });
    if (url === "/api/inbox") return response({ items: [], actionableCount: 0, unreadCount: 0 });
    if (url === "/api/repos") return response({ repos: [] });
    if (url.startsWith("/api/prompt-queue?")) return response({ items: [queued] });
    if (url.includes("/replay?")) return response({ mode: "text", text: "Terminal ready" });
    if (url.includes("/viewport")) return response({});
    if (url === "/api/health") return response({ version: { builtAt: null } });
    return response({ error: `Unmocked request: ${url}` }, 501);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test("failed queue save preserves edits, displays detail feedback and sends nothing until a successful retry", async () => {
  let fail = true;
  let savedText = queued.text;
  const sent: string[] = [];
  const fetch = installHome((url, init) => {
    if (url === "/api/prompt-queue/queue-1" && init?.method === "PATCH") {
      if (fail) return response({ error: "Save unavailable" }, 503);
      savedText = JSON.parse(String(init.body)).text;
      return response({});
    }
    if (url === "/api/prompt-queue/queue-1/send") { sent.push(savedText); return response({}); }
    if (url.startsWith("/api/prompt-queue?")) return response({ items: [{ ...queued, text: savedText }] });
  });
  render(<Home />);
  await userEvent.click(await screen.findByRole("button", { name: "Prompt queue, 1 waiting" }, { timeout: 5000 }));
  const input = screen.getByRole("textbox", { name: "Queued prompt 1" });
  await userEvent.clear(input);
  await userEvent.type(input, "The reviewed instruction");
  await userEvent.click(within(screen.getByRole("dialog", { name: "Prompt queue" })).getByRole("button", { name: "Send now" }));
  await screen.findByRole("alert");
  assert.match(screen.getByRole("status").textContent || "", /Save unavailable/);
  assert.equal((input as HTMLTextAreaElement).value, "The reviewed instruction");
  assert.deepEqual(sent, []);
  assert.equal(fetch.mock.calls.filter(([url, init]) => url === "/api/prompt-queue/queue-1" && init?.method === "PATCH").length, 1);
  fail = false;
  await userEvent.click(within(screen.getByRole("dialog", { name: "Prompt queue" })).getByRole("button", { name: "Send now" }));
  await waitFor(() => assert.deepEqual(sent, ["The reviewed instruction"]));
  assert.equal(screen.queryByRole("alert"), null);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const oldResult of ["success", "failure"]) {
  test(`A-to-B-to-A selection rejects obsolete replay ${oldResult} and queue data`, async () => {
    const replay = deferred<Response>();
    const queue = deferred<Response>();
    let aReads = 0;
    let aQueues = 0;
    installHome((url) => {
      if (url === "/api/bootstrap") return response({ connected: true, host: {}, workspaces: [{ ...workspace, terminals: [...workspace.terminals, { id: "terminal-2", title: "other" }] }], refreshedAt: "2026-09-06" });
      if (url.includes("/terminal-1/replay")) return ++aReads === 1 ? replay.promise : response({ mode: "text", text: "Current A" });
      if (url.includes("/terminal-2/replay")) return response({ mode: "text", text: "Current B" });
      if (url.startsWith("/api/prompt-queue?")) {
        if (url.includes("terminal-1")) return ++aQueues === 1 ? queue.promise : response({ items: [{ ...queued, text: "Current queue A" }] });
        return response({ items: [] });
      }
    });
    render(<Home />);
    await waitFor(() => { assert.equal(aReads, 1); assert.equal(aQueues, 1); });
    await userEvent.click(screen.getByRole("button", { name: "Session menu" }));
    await userEvent.click(screen.getByRole("button", { name: "2. other" }));
    await screen.findByText("Current B");
    await userEvent.click(screen.getByRole("button", { name: "Session menu" }));
    await userEvent.click(screen.getByRole("button", { name: "1. shell" }));
    await screen.findByText("Current A");
    await userEvent.click(await screen.findByRole("button", { name: "Prompt queue, 1 waiting" }, { timeout: 5000 }));
    assert.equal((screen.getByRole("textbox", { name: "Queued prompt 1" }) as HTMLTextAreaElement).value, "Current queue A");
    // The fake transport deliberately ignores AbortSignal, proving that the
    // ownership guard also works when a response cannot be cancelled.
    await act(async () => {
      if (oldResult === "failure") replay.reject(new Error("Obsolete terminal error"));
      else replay.resolve(response({ mode: "text", text: "Obsolete terminal A" }));
      queue.resolve(response({ items: [{ ...queued, id: "obsolete-queue", text: "Obsolete queue A" }] }));
    });
    assert.ok(screen.getByText("Current A"));
    assert.equal(screen.queryByText(/Obsolete terminal/), null);
    assert.equal((screen.getByRole("textbox", { name: "Queued prompt 1" }) as HTMLTextAreaElement).value, "Current queue A");
  });
}

const account = { id: "expired-account", label: "Codex", email: null, plan: null, isDefault: true, paused: false, status: "reconnect", message: "Reconnect required", updatedAt: null, windows: [] };
const usage = { generatedAt: "2026-09-06", available: true, summary: { ready: 0, low: 0, exhausted: 0, reconnect: 1, unavailable: 0 }, providers: [{ id: "codex", label: "Codex", available: true, accounts: [account] }] };
const waiting = { sessionId: "reconnect-1", provider: "codex", status: "waiting", message: "Waiting for login", authUrl: "https://auth.example.test/login", expiresAt: "2026-09-07" };
const success = { ...waiting, status: "success", authUrl: null, message: "Account reconnected" };

function installReconnect(handler: (url: string, init?: RequestInit) => Promise<Response> | Response | undefined) {
  let refreshes = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const custom = handler(url, init);
    if (custom) return custom;
    if (url.includes("?refresh=1")) refreshes++;
    if (url === "/api/account-usage/expired-account/reconnect") return response(waiting, 201);
    if (url.includes("/callback")) return response(success);
    if (url.includes("reconnect-1")) return response(waiting);
    return response(usage);
  }));
  return () => refreshes;
}

test("an older reconnect poll cannot replace callback success or refresh twice", async () => {
  const poll = deferred<Response>();
  let polling = false;
  const refreshes = installReconnect((url, init) => {
    if (url.endsWith("/reconnect-1") && !init?.method) { polling = true; return poll.promise; }
  });
  render(<AccountUsageView onBack={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "Reconnect account" }));
  await screen.findByText("Waiting for login");
  // Observe the real polling boundary; the response is held deterministically.
  await waitFor(() => assert.equal(polling, true), { timeout: 2500 });
  await userEvent.type(screen.getByRole("textbox", { name: "Localhost callback URL" }), "http://localhost/callback?code=safe");
  await userEvent.click(screen.getByRole("button", { name: "Finish reconnect" }));
  await screen.findByText("Account reconnected");
  await act(async () => poll.resolve(response(waiting)));
  assert.ok(screen.getByText("Account reconnected"));
  assert.equal(refreshes(), 1);
});

for (const source of ["start", "callback", "poll"]) {
  test(`closing reconnect rejects a late ${source} success without adopting or refreshing`, async () => {
    const held = deferred<Response>();
    let requested = false;
    const refreshes = installReconnect((url, init) => {
      const hold = source === "start" ? url.endsWith("/expired-account/reconnect") : source === "callback" ? url.endsWith("/callback") : url.endsWith("/reconnect-1") && !init?.method;
      if (hold) { requested = true; return held.promise; }
    });
    render(<AccountUsageView onBack={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Reconnect account" }));
    const dialog = await screen.findByRole("dialog", { name: "Reconnect Codex" });
    if (source === "callback") {
      await userEvent.type(await screen.findByRole("textbox", { name: "Localhost callback URL" }), "http://localhost/callback?code=safe");
      await userEvent.click(screen.getByRole("button", { name: "Finish reconnect" }));
    }
    await waitFor(() => assert.equal(requested, true), { timeout: 2500 });
    await userEvent.click(within(dialog).getByRole("button", { name: "Close reconnect" }));
    await act(async () => held.resolve(response(success)));
    assert.equal(screen.queryByRole("dialog"), null);
    assert.equal(refreshes(), 0);
  });
}
