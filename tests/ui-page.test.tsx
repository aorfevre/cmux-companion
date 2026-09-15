import assert from "node:assert/strict";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { DeviceSettings } from "../app/settings/device-settings";
import Home, { LastUpdateStamp, updatedAgo } from "../app/page";

// One cmux workspace with two terminals inside a catalogued repository, so the
// session detail can reach the terminal, health and change panels.
const repoPath = "/Users/me/karven/companion";
const repo = { id: "repo-1", name: "companion", root: "karven", path: repoPath, branch: "main", ahead: 1, behind: 0, changedFiles: 1, dirty: true, lastActivity: 0, scripts: ["dev"] };
const terminals = [
  { id: "t-1", title: "shell", is_focused: true, current_directory: repoPath },
  { id: "t-2", title: "logs", is_focused: false, current_directory: repoPath },
];
const workspace = { id: "ws-1", title: "Companion session", current_directory: repoPath, terminals, status: { effective: "working" }, last_activity_at: Math.round(Date.now() / 1000) };
const bootstrap = { connected: true, host: { mac_display_name: "Studio Mac" }, workspaces: [workspace], error: null, refreshedAt: "2026-09-08" };
const overview = { status: { effective: "working", signals: { is_git_dirty: true } }, todos: { items: [{ id: "td-1", text: "Write tests", state: "pending" }, { id: "td-2", text: "Ship it", state: "completed" }], progress: { completed: 1, total: 2 } }, metrics: { cpuPercent: 12.34, memoryBytes: 2 * 1024 ** 3, processCount: 4 }, surfaceHealth: null };
const changes = { repo, files: [{ path: "docs/guide.md", status: "M", area: "unstaged", areas: ["unstaged"] }, { path: "src/app.ts", status: "A", area: "staged", areas: ["staged"] }], summary: { staged: "", unstaged: "" }, recentCommit: { hash: "abc1234", subject: "Initial commit" } };
const markdownFile = { repo: { id: repo.id, name: repo.name, path: repoPath }, path: "docs/guide.md", name: "guide.md", content: "# Guide\n\nHello from the guide." };

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
type Handler = (url: string, init?: RequestInit) => Response | undefined;

class FakeSocket {
  static last: FakeSocket | null = null;
  static closed = 0;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(url: string) { this.url = url; FakeSocket.last = this; }
  close() { FakeSocket.closed += 1; }
}

function installHome(search: string, handler: Handler = () => undefined, { readOnly = false, paired = true }: { readOnly?: boolean; paired?: boolean } = {}) {
  window.history.replaceState(null, "", search);
  window.localStorage.clear();
  window.localStorage.setItem("cmux-companion-read-only", String(readOnly));
  FakeSocket.last = null; FakeSocket.closed = 0;
  vi.stubGlobal("WebSocket", FakeSocket);
  // jsdom has no matchMedia; the push settings card asks it about standalone mode.
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const custom = handler(url, init);
    if (custom) return custom;
    if (url === "/api/auth/status") return response({ paired });
    if (url === "/api/bootstrap") return paired ? response(bootstrap) : response({ error: "Pair this device first" }, 401);
    if (url.startsWith("/api/goal-sessions/workspace/")) return response({ plan: null });
    if (url === "/api/repos") return response({ repos: [repo] });
    if (url.startsWith("/api/terminals/") && url.includes("/replay?")) return response({ mode: "text", text: "Terminal ready" });
    if (url === "/api/health") return response({ version: { builtAt: null } });
    if (url === "/api/updater/status") return response({ available: false });
    if (url.startsWith("/api/repos/") && url.endsWith("/pull-request")) return response({ pullRequest: null });
    if (url.startsWith("/api/workspaces/") && url.endsWith("/overview")) return response(overview);
    if (url === `/api/repos/${repo.id}/changes`) return response(changes);
    if (url.startsWith(`/api/repos/${repo.id}/diff?`)) return response({ patch: "@@ -1 +1 @@\n-old\n+new" });
    if (url.startsWith(`/api/repos/${repo.id}/markdown?`)) return response(markdownFile);
    if (url === "/api/settings/models") return response({ error: "Model settings unavailable" }, 503);
    if (url === "/api/worktree-cleanup/preview") return response({ previewId: "preview-1", generatedAt: "2026-09-08", roots: [], repositoryCount: 0, entries: [], errors: [], summary: { candidates: 0, protected: 0, estimatedBytes: 0 } });
    if (url === "/api/account-usage") return response({ error: "CCS is offline" }, 503);
    if (init?.method === "POST") return response({});
    return response({ error: `Unmocked request: ${url}` }, 501);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}


const posted = (calls: { url: string; init?: RequestInit }[], url: string, method = "POST") => calls.filter((call) => call.url === url && (call.init?.method || "GET").toUpperCase() === method);

async function openSessionMenu() {
  await userEvent.click(screen.getByRole("button", { name: "Session menu" }));
  return screen.getByRole("dialog", { name: "Session menu" });
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("pairing and connectivity", () => {
  test("an unreachable companion offers a reload and a paired reload restores the shell", async () => {
    let reachable = false;
    installHome("/?mode=sessions", (url) => url === "/api/auth/status" && !reachable ? response({ error: "offline" }, 503) : undefined);
    render(<Home />);
    assert.ok(screen.getByText("Opening companion…"));
    assert.ok(await screen.findByText("Your companion is offline."));
    assert.ok(screen.getByRole("button", { name: "Try again" }));
    reachable = true;
  });

  test("pairing rejects a wrong code, accepts the right one and unpairs from settings", async () => {
    let paired = false;
    const { calls } = installHome("/?mode=sessions", (url, init) => {
      if (url === "/api/auth/status") return response({ paired });
      if (url === "/api/auth/pair") {
        const token = JSON.parse(String(init?.body)).token;
        if (token !== "secret-code") return response({ error: "Invalid pairing code" }, 403);
        paired = true;
        return response({ paired: true });
      }
      if (url === "/api/auth/logout") { paired = false; return response({}); }
      return undefined;
    });
    const view = render(<Home />);
    assert.ok(await screen.findByText("Pair this device."));
    const code = screen.getByPlaceholderText("Pairing code");
    assert.equal((screen.getByRole("button", { name: "Pair securely" }) as HTMLButtonElement).disabled, true);
    await userEvent.type(code, "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Pair securely" }));
    assert.ok(await screen.findByText("Invalid pairing code"));
    await userEvent.clear(code);
    await userEvent.type(code, " secret-code ");
    await userEvent.click(screen.getByRole("button", { name: "Pair securely" }));
    assert.ok(await screen.findByRole("heading", { name: "Sessions" }));
    assert.equal(JSON.parse(String(posted(calls, "/api/auth/pair").at(-1)?.init?.body)).token, "secret-code");
    assert.ok((await screen.findAllByText("Studio Mac")).length >= 1);
    view.unmount(); render(<DeviceSettings />);
    await userEvent.click(screen.getByRole("button", { name: "Unpair this device" }));
    await waitFor(() => assert.equal(paired, false));
    assert.equal(posted(calls, "/api/auth/logout").length, 1);
  });

  test("a bootstrap that asks for pairing drops back to the pair screen", async () => {
    installHome("/?mode=sessions", (url) => url === "/api/bootstrap" ? response({ error: "Pair this device first" }, 401) : undefined);
    render(<Home />);
    assert.ok(await screen.findByText("Pair this device."));
  });

  test("live events throttle cmux refreshes and reconnect after a close", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = installHome("/?mode=sessions");
    render(<Home />);
    await act(async () => { await vi.advanceTimersByTimeAsync(5); });
    await waitFor(() => assert.ok(FakeSocket.last));
    const socket = FakeSocket.last!;
    assert.equal(socket.url, "ws://localhost:3000/api/events");
    await act(async () => { socket.onopen?.(); });
    assert.ok(screen.getByText("LIVE"));
    const bootstrapReads = () => calls.filter((call) => call.url === "/api/bootstrap").length;
    const bootstrapBefore = bootstrapReads();
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ type: "cmux:event" }) });
      socket.onmessage?.({ data: JSON.stringify({ type: "cmux:event" }) });
      socket.onmessage?.({ data: "not json" });
      await vi.advanceTimersByTimeAsync(350);
    });
    assert.equal(bootstrapReads(), bootstrapBefore + 1);
    await act(async () => { socket.onclose?.(); });
    assert.ok(screen.getByText("SYNC"));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    assert.notEqual(FakeSocket.last, socket);
    // The visible-tab poll refreshes the bootstrap on its own clock.
    const polled = bootstrapReads();
    await act(async () => { await vi.advanceTimersByTimeAsync(8_100); });
    assert.ok(bootstrapReads() > polled);
  });
});

describe("sessions and launch", () => {
  test("lists sessions, opens one from its card and returns to the list", async () => {
    installHome("/?mode=sessions");
    render(<Home />);
    assert.ok(await screen.findByRole("heading", { name: "Sessions" }));
    assert.ok(await screen.findByText("~/karven/companion"));
    await userEvent.click(screen.getByRole("button", { name: /Companion session/ }));
    assert.ok(await screen.findByRole("button", { name: "Session menu" }));
    assert.equal(new URLSearchParams(location.search).get("workspace"), "ws-1");
    await userEvent.click(screen.getByRole("button", { name: /Back/ }));
    assert.ok(await screen.findByRole("heading", { name: "Sessions" }));
    assert.equal(location.search, "?view=sessions");
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  });

  test("the empty session list, session tools and bottom navigation reach retained views", async () => {
    installHome("/?mode=sessions", (url) => url === "/api/bootstrap" ? response({ ...bootstrap, connected: false, workspaces: [] }) : undefined);
    render(<Home />);
    assert.ok(await screen.findByText("No sessions yet"));
    assert.ok(screen.getByText("Waiting for cmux"));
    await userEvent.click(screen.getByRole("button", { name: "Launch a workspace" }));
    assert.ok(await screen.findByRole("heading", { name: "Start work" }));
    assert.equal(location.search, "?view=launch");
    assert.equal(screen.getByRole("link", { name: "Mission Control" }).getAttribute("href"), "/orchestration");
    assert.equal(screen.getByRole("link", { name: "Setup" }).getAttribute("href"), "/settings");
    act(() => { history.pushState(null, "", "/?view=sessions"); window.dispatchEvent(new PopStateEvent("popstate")); });
    assert.equal(location.search, "?view=sessions");
    act(() => { history.pushState(null, "", "/?view=sessions"); window.dispatchEvent(new PopStateEvent("popstate")); });
    assert.ok(await screen.findByText("No sessions yet"));
    assert.equal(location.search, "?view=sessions");
    assert.equal(screen.queryByRole("button", { name: "Local apps" }), null);
    assert.equal(screen.queryByRole("button", { name: "Inbox" }), null);
  });

  test("launches a repository workspace, filters the list and reports a refused launch", async () => {
    let refuse = true;
    const { calls } = installHome("/?view=launch", (url, init) => {
      if (url === "/api/workspaces" && init?.method === "POST") return refuse ? response({ error: "cmux is not running" }, 503) : response({ workspace: { workspace_id: "ws-1" } });
      if (url === "/api/repos") return response({ repos: [repo, { ...repo, id: "repo-2", name: "ledger", path: "/Users/me/rekord/ledger", scripts: [], dirty: false }] });
      return undefined;
    });
    render(<Home />);
    await screen.findByRole("heading", { name: "Start work" });
    assert.ok(await screen.findByText("ledger"));
    await userEvent.click(screen.getByRole("button", { name: "Rescan" }));
    await userEvent.type(screen.getByPlaceholderText("Find a repository…"), "compan");
    assert.equal(screen.queryByText("ledger"), null);
    await userEvent.click(screen.getByRole("button", { name: /companion/ }));
    assert.equal((screen.getByRole("textbox", { name: "Workspace name" }) as HTMLInputElement).value, "companion");
    await userEvent.click(screen.getByRole("button", { name: "Claude" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Initial task" }), "Fix the flaky test");
    await userEvent.selectOptions(screen.getByRole("combobox"), "dev");
    assert.equal(screen.queryByRole("textbox", { name: "Initial task" }), null);
    await userEvent.click(screen.getByRole("button", { name: "Launch script" }));
    assert.ok(await screen.findByText("cmux is not running"));
    refuse = false;
    await userEvent.click(screen.getByRole("button", { name: "Shell" }));
    assert.ok(screen.getByRole("button", { name: "Launch shell" }));
    await userEvent.click(screen.getByRole("button", { name: "‹ Choose another repo" }));
    await userEvent.click(screen.getByRole("button", { name: /companion/ }));
    await userEvent.click(screen.getByRole("button", { name: "Codex" }));
    await userEvent.click(screen.getByRole("button", { name: "Launch codex" }));
    assert.ok(await screen.findByRole("button", { name: "Session menu" }));
    const body = JSON.parse(String(posted(calls, "/api/workspaces").at(-1)?.init?.body));
    assert.equal(body.agent, "codex");
    assert.equal(body.repoId, "repo-1");
  });

  test("a launch whose workspace is not yet reported returns to the sessions view with a notice", async () => {
    installHome("/?view=launch", (url, init) => url === "/api/workspaces" && init?.method === "POST" ? response({ workspace: { workspace_id: "ws-unknown" } }) : undefined);
    render(<Home />);
    await userEvent.click(await screen.findByRole("button", { name: /companion/ }));
    await userEvent.click(screen.getByRole("button", { name: "Launch codex" }));
    assert.match((await screen.findByRole("status")).textContent || "", /Workspace launched/);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    assert.equal(screen.queryByRole("status"), null);
  });
});

describe("session detail", () => {
  test("sends deliberate input, uses shortcuts and the large writer", async () => {
    const { calls } = installHome("/?mode=sessions&workspace=ws-1&surface=t-1");
    render(<Home />);
    const input = await screen.findByRole("textbox", { name: "Terminal input" });
    await userEvent.type(input, "/rev");
    assert.ok(screen.getByText("Agent shortcuts"));
    await userEvent.click(screen.getByRole("button", { name: /\/review/ }));
    assert.equal((input as HTMLTextAreaElement).value, "/review");
    await userEvent.clear(input);
    await userEvent.type(input, "/nothing-matches");
    await userEvent.click(screen.getByRole("button", { name: "/help" }));
    assert.equal((input as HTMLTextAreaElement).value, "/help");
    await userEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => assert.equal(posted(calls, "/api/terminals/t-1/input").length, 1));
    assert.deepEqual(JSON.parse(String(posted(calls, "/api/terminals/t-1/input")[0].init?.body)), { text: "/help", enter: true });
    assert.equal((input as HTMLTextAreaElement).value, "");
    await userEvent.click(screen.getByRole("button", { name: "Open large writing area" }));
    const writer = screen.getByRole("textbox", { name: "Expanded terminal input" });
    await userEvent.type(writer, "Long message");
    assert.ok(screen.getByText("12 characters"));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => assert.equal(posted(calls, "/api/terminals/t-1/input").length, 2));
    assert.equal(screen.queryByRole("textbox", { name: "Expanded terminal input" }), null);
  });

  test("a rejected send is shown as a notice and retains its draft", async () => {
    installHome("/?mode=sessions&workspace=ws-1&surface=t-1", (url, init) => {
      if (url === "/api/terminals/t-1/input" && init?.method === "POST") return response({ error: "Terminal is busy" }, 409);
      return undefined;
    });
    render(<Home />);
    const input = await screen.findByRole("textbox", { name: "Terminal input" });
    await userEvent.type(input, "hello");
    await userEvent.click(screen.getByRole("button", { name: "Send now" }));
    assert.match((await screen.findByRole("status")).textContent || "", /Terminal is busy/);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    assert.equal((input as HTMLTextAreaElement).value, "hello");
  });

  test("the session menu switches terminals, tunes the display, sends special keys and toggles input", async () => {
    const { calls } = installHome("/?mode=sessions&workspace=ws-1&surface=t-1", (url, init) => url === "/api/terminals/t-1/key" && init?.method === "POST" ? response({ error: "Key refused" }, 500) : undefined);
    render(<Home />);
    await screen.findByRole("textbox", { name: "Terminal input" });
    let menu = await openSessionMenu();
    assert.ok(within(menu).getByText("Session controls"));
    await userEvent.click(within(menu).getByRole("button", { name: "2. logs" }));
    assert.equal(screen.queryByRole("dialog", { name: "Session menu" }), null);
    await waitFor(() => assert.ok(calls.some((call) => call.url.startsWith("/api/terminals/t-2/replay"))));
    menu = await openSessionMenu();
    await userEvent.click(within(menu).getByRole("button", { name: /Fit text/ }));
    assert.equal(localStorage.getItem("cmux-companion-fit-terminal"), "false");
    await userEvent.click(within(menu).getByRole("button", { name: "Text A＋" }));
    assert.equal(localStorage.getItem("cmux-companion-terminal-font"), "15");
    await userEvent.click(within(menu).getByRole("button", { name: "Text A−" }));
    assert.equal(localStorage.getItem("cmux-companion-terminal-font"), "14");
    await userEvent.click(within(menu).getByRole("button", { name: "Refresh" }));
    await userEvent.click(within(menu).getByRole("button", { name: "Esc" }));
    await waitFor(() => assert.equal(posted(calls, "/api/terminals/t-2/key").length, 1));
    assert.deepEqual(JSON.parse(String(posted(calls, "/api/terminals/t-2/key")[0].init?.body)), { key: "escape" });
    await userEvent.click(within(menu).getByRole("button", { name: "Input enabled" }));
    assert.equal(localStorage.getItem("cmux-companion-read-only"), "true");
    assert.equal((screen.getByRole("textbox", { name: "Terminal input" }) as HTMLTextAreaElement).disabled, true);
    assert.equal((within(menu).getByRole("button", { name: "Esc" }) as HTMLButtonElement).disabled, true);
    await userEvent.click(within(menu).getByRole("button", { name: "Enable input" }));
    await userEvent.click(within(menu).getByRole("button", { name: "／ Shortcuts" }));
    assert.ok(await screen.findByText("Agent shortcuts"));
    menu = await openSessionMenu();
    await userEvent.click(within(menu).getByRole("button", { name: "1. shell" }));
    menu = await openSessionMenu();
    await userEvent.click(within(menu).getByRole("button", { name: "Esc" }));
    assert.match((await screen.findByRole("status")).textContent || "", /Key refused/);
    menu = await openSessionMenu();
    await userEvent.click(screen.getByRole("button", { name: "Close session menu" }));
    assert.equal(screen.queryByRole("dialog", { name: "Session menu" }), null);
    menu = await openSessionMenu();
    assert.equal(within(menu).queryByRole("button", { name: /Local apps/ }), null);
  });

  test("the health panel reads the overview, toggles tasks, restarts and closes the workspace", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    let overviewFails = false;
    const { calls } = installHome("/?mode=sessions&workspace=ws-1&surface=t-1&tab=tasks", (url, init) => {
      if (url === "/api/workspaces/ws-1/overview" && overviewFails) return response({ error: "Overview unavailable" }, 503);
      if (url === "/api/workspaces/ws-1/close" && init?.method === "POST") return response({ error: "cmux refused" }, 500);
      return undefined;
    });
    render(<Home />);
    assert.ok(await screen.findByRole("heading", { name: "working" }));
    assert.ok(screen.getByText("Working tree has changes"));
    assert.ok(screen.getByText("12.3%"));
    assert.ok(screen.getByText("2.0 GB"));
    assert.ok(screen.getByText("1 of 2 complete"));
    assert.ok(screen.getByText("50%"));
    await userEvent.click(screen.getByRole("button", { name: /Write tests/ }));
    await waitFor(() => assert.equal(posted(calls, "/api/workspaces/ws-1/todos/td-1/check").length, 1));
    await userEvent.click(screen.getByRole("button", { name: /Ship it/ }));
    await waitFor(() => assert.equal(posted(calls, "/api/workspaces/ws-1/todos/td-2/uncheck").length, 1));
    await userEvent.click(screen.getByRole("button", { name: "Restart current terminal" }));
    await waitFor(() => assert.equal(posted(calls, "/api/workspaces/ws-1/respawn").length, 1));
    assert.deepEqual(JSON.parse(String(posted(calls, "/api/workspaces/ws-1/respawn")[0].init?.body)), { surfaceId: "t-1" });
    confirm.mockReturnValueOnce(false);
    await userEvent.click(screen.getByRole("button", { name: "Close workspace" }));
    assert.equal(posted(calls, "/api/workspaces/ws-1/close").length, 0);
    await userEvent.click(screen.getByRole("button", { name: "Close workspace" }));
    assert.match((await screen.findByRole("status")).textContent || "", /cmux refused/);
    overviewFails = true;
    const menu = await openSessionMenu();
    await userEvent.click(within(menu).getByRole("button", { name: "Terminal" }));
    await screen.findByRole("textbox", { name: "Terminal input" });
    await userEvent.click(within(await openSessionMenu()).getByRole("button", { name: "Health" }));
    assert.match((await screen.findByRole("alert")).textContent || "", /Overview unavailable/);
  });

  test("the changes panel lists files, opens a diff, reads markdown and reports failures", async () => {
    let changesFail = false;
    let diffFail = false;
    const { calls } = installHome("/?mode=sessions&workspace=ws-1&surface=t-1&tab=changes", (url) => {
      if (url === `/api/repos/${repo.id}/changes` && changesFail) return response({ error: "Git is unavailable" }, 503);
      if (url.startsWith(`/api/repos/${repo.id}/diff?`) && diffFail) return response({ error: "Diff too large" }, 413);
      return undefined;
    });
    render(<Home />);
    assert.ok(await screen.findByRole("heading", { name: "2 changed files" }));
    assert.ok(screen.getByText("Latest: abc1234 Initial commit"));
    await userEvent.click(screen.getByRole("button", { name: /guide\.md/ }));
    assert.ok(await screen.findByText(/\+new/));
    assert.ok(calls.some((call) => call.url === `/api/repos/${repo.id}/diff?file=docs%2Fguide.md&staged=0`));
    await userEvent.click(screen.getByRole("button", { name: "Read" }));
    assert.ok(await screen.findByText("Hello from the guide."));
    assert.equal(location.search, "?repo=repo-1&file=docs%2Fguide.md");
    await userEvent.click(screen.getByRole("button", { name: "‹ Back" }));
    assert.equal(location.search, "?workspace=ws-1");
    assert.ok(await screen.findByRole("heading", { name: "2 changed files" }));
    diffFail = true;
    await userEvent.click(screen.getByRole("button", { name: /app\.ts/ }));
    assert.ok(await screen.findByText("Diff too large"));
    assert.ok(calls.some((call) => call.url === `/api/repos/${repo.id}/diff?file=src%2Fapp.ts&staged=1`));
    await userEvent.click(screen.getByRole("button", { name: "‹ Files" }));
    changesFail = true;
    await userEvent.click(screen.getByRole("button", { name: "↻" }));
    assert.ok(await screen.findByText("Git is unavailable"));
  });

  test("a session outside every catalogued repository has no change review and no markdown target", async () => {
    installHome("/?mode=sessions&workspace=ws-1&surface=t-1&tab=changes", (url) => {
      if (url === "/api/repos") return response({ repos: [] });
      if (url.includes("/replay?")) return response({ mode: "text", text: "See README.md for details" });
      return undefined;
    });
    render(<Home />);
    assert.ok(await screen.findByText("Repository not catalogued"));
    await userEvent.click(within(await openSessionMenu()).getByRole("button", { name: "Terminal" }));
    await userEvent.click(await screen.findByRole("button", { name: "README.md" }));
    assert.match((await screen.findByRole("status")).textContent || "", /outside a catalogued repository/);
  });

  test("terminal markdown stays inspectable without automatically registering local previews", async () => {
    const { calls } = installHome("/?mode=sessions&workspace=ws-1&surface=t-1", url => url.includes('/replay?') ? response({ mode: 'text', text: 'Dev server at http://localhost:3000/ and notes in docs/guide.md' }) : undefined);
    render(<Home />);
    await userEvent.click(await screen.findByRole('button', { name: 'docs/guide.md' }));
    assert.ok(await screen.findByText('Hello from the guide.'));
    await userEvent.click(screen.getByRole('button', { name: 'Ask agent' }));
    const input = await screen.findByRole('textbox', { name: 'Terminal input' });
    assert.equal((input as HTMLTextAreaElement).value, 'Please review docs/guide.md and help me with it.');
    assert.equal(calls.some(call => call.url.startsWith('/api/previews')), false);
  });

  test("the markdown viewer opens a session for its repository and reports a missing one", async () => {
    let workspaces = [workspace];
    installHome("/?repo=repo-1&file=./docs/guide.md", (url) => url === "/api/bootstrap" ? response({ ...bootstrap, workspaces }) : undefined);
    render(<Home />);
    assert.ok(await screen.findByText("Hello from the guide."));
    await userEvent.click(screen.getByRole("button", { name: "Open session" }));
    assert.ok(await screen.findByRole("textbox", { name: "Terminal input" }));
    await userEvent.click(within(await openSessionMenu()).getByRole("button", { name: "Changes" }));
    await userEvent.click(await screen.findByRole("button", { name: /guide\.md/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Read" }));
    assert.ok(await screen.findByText("Hello from the guide."));
    workspaces = [];
    await userEvent.click(screen.getByRole("button", { name: "‹ Back" }));
    await userEvent.click(within(await openSessionMenu()).getByRole("button", { name: "Terminal" }));
    await userEvent.click(screen.getByRole("button", { name: /Back/ }));
    act(() => { history.pushState(null, "", "/?view=sessions"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => assert.ok(screen.getByText("No sessions yet")));
  });
});

describe("settings", () => {
  test("device settings retain read-only protection", async () => {
    installHome("/settings#general");
    render(<DeviceSettings />);
    assert.ok(await screen.findByText("Studio Mac"));
    const readOnly = screen.getByRole("switch", { name: /Protect terminal input/ }) as HTMLInputElement;
    assert.equal(readOnly.checked, false);
    await userEvent.click(readOnly);
    assert.equal(localStorage.getItem("cmux-companion-read-only"), "true");
  });
});

describe("header stamp", () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date("2026-09-08T12:00:00.000Z")); });

  test("prefers the updater's last success and falls back to the build stamp", async () => {
    let updater = response({ available: true, lastSuccessAt: "2026-09-08T09:00:00.000Z" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/updater/status" ? updater : response({ version: { builtAt: "2026-09-06T12:00:00.000Z" } })));
    render(<LastUpdateStamp />);
    assert.equal((await screen.findByText("Updated 3h ago")).getAttribute("datetime"), "2026-09-08T09:00:00.000Z");
    updater = response({ available: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    assert.ok(await screen.findByText("Updated 2d ago"));
  });

  test("renders nothing when neither the updater nor the build carries a time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "gone" }, 500)));
    const { container } = render(<LastUpdateStamp />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    assert.equal(container.textContent, "");
    assert.equal(updatedAgo(Date.now() - 30_000), "just now");
    assert.equal(updatedAgo(Date.now() - 5 * 60_000), "5m ago");
  });
});
