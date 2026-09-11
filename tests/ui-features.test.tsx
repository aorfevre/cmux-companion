import assert from "node:assert/strict";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, test, vi } from "vitest";
import { AccountUsageView } from "../app/account-usage";
import { AppsView } from "../app/apps-view";
import { MarkdownViewer } from "../app/markdown-viewer";
import { BottomNav, InboxView, LastUpdateStamp, PullRequestBanner, TerminalPanel } from "../app/page";
import { TerminalGrid } from "../app/terminal-grid.tsx";
import { DeploymentHealth } from "../app/deployment-health";


afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("contextual mobile features", () => {
  test("keeps permanent navigation focused on frequent mobile destinations", async () => {
    const navigate = vi.fn();
    render(<BottomNav view="usage" onView={navigate} />);
    assert.ok(screen.getByRole("button", { name: "Licence Usage" }).classList.contains("active"));
    assert.equal(screen.queryByRole("button", { name: "Apps" }), null);
    assert.ok(screen.getByRole("button", { name: "Sessions" }));
    assert.equal(screen.queryByRole("button", { name: "Inbox" }), null);
    assert.equal(screen.queryByRole("button", { name: "Launch" }), null);
    await userEvent.click(screen.getByRole("button", { name: "Goals" }));
    assert.deepEqual(navigate.mock.calls[0], ["worktrees"]);
  });

  test("shows CCS quota by account while treating absent windows as unreported", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-01T10:00:00.000Z"));
    const weeklyReset = new Date(Date.now() + ((3 * 24 + 2) * 60 + 7) * 60_000);
    const usage = { generatedAt: new Date().toISOString(), source: "CCS", available: true, summary: { ready: 1, low: 0, exhausted: 0, reconnect: 1, unavailable: 0 }, providers: [
      { id: "claude", label: "Claude Code", available: true, accounts: [{ id: "one", label: "one", email: "one@example.test", plan: null, isDefault: true, paused: false, status: "ready", message: null, updatedAt: new Date().toISOString(), windows: [
        { id: "usage-5h-0", cadence: "5h", label: "Session limit", category: "usage", remainingPercent: 82, resetAt: new Date(Date.now() + 3_600_000).toISOString(), reported: true },
        { id: "usage-weekly-1", cadence: "weekly", label: "Weekly limit", category: "usage", remainingPercent: 55, resetAt: weeklyReset.toISOString(), reported: true },
        { id: "usage-monthly-2", cadence: "monthly", label: "Monthly provider limit", category: "usage", remainingPercent: 44, resetAt: weeklyReset.toISOString(), reported: true },
        { id: "review-other-3", cadence: "other", label: "Review tokens", category: "code-review", remainingPercent: 90, resetAt: null, reported: true },
      ] }] },
      { id: "codex", label: "OpenAI Codex", available: true, accounts: [{ id: "two", label: "two", email: "two@example.test", plan: "pro", isDefault: false, paused: false, status: "reconnect", message: "Reconnect this account in CCS", updatedAt: null, windows: [] }] },
    ] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => { void input; return new Response(JSON.stringify(usage), { status: 200, headers: { "content-type": "application/json" } }); });
    vi.stubGlobal("fetch", fetchMock);
    const back = vi.fn();
    render(<AccountUsageView onBack={back} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    assert.ok(await screen.findByText("one@example.test"));
    assert.ok(screen.getByText("82%"));
    assert.ok(screen.getByText("55%"));
    const reportedAccount = screen.getByText("one@example.test").closest("article");
    const emptyAccount = screen.getByText("two@example.test").closest("article");
    assert.ok(reportedAccount);
    assert.ok(emptyAccount);
    assert.equal(within(reportedAccount).queryByText("Not reported"), null);
    assert.equal(within(emptyAccount).getAllByText("Not reported").length, 2);
    assert.equal(screen.getAllByText("5 hours").length, 2);
    assert.equal(screen.getAllByText("Weekly").length, 2);
    assert.equal(screen.queryByText("Daily"), null);
    assert.equal(screen.queryByText("Monthly"), null);
    assert.equal(screen.queryByText("Monthly provider limit"), null);
    assert.equal(screen.queryByText("44%"), null);
    assert.ok(within(reportedAccount).getByText("Additional limits"));
    assert.ok(within(reportedAccount).getByText("Review tokens"));
    const countdown = within(reportedAccount).getByText("Resets in 03:02:07");
    assert.equal(countdown.tagName, "TIME");
    assert.equal(countdown.getAttribute("datetime"), weeklyReset.toISOString());
    const fetchesBeforeTick = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    assert.ok(within(reportedAccount).getByText("Resets in 03:02:06"));
    assert.equal(fetchMock.mock.calls.length, fetchesBeforeTick);
    assert.ok(screen.getByText("Reconnect this account in CCS"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh account usage" })); });
    assert.equal(fetchMock.mock.calls.some(([url]) => String(url).endsWith("?refresh=1")), true);
    fireEvent.click(screen.getByRole("button", { name: "‹ Settings" }));
    assert.equal(back.mock.calls.length, 1);
  });

  test("offers a compact phone-safe reconnect flow only for expired accounts", async () => {
    const usage = { generatedAt: new Date().toISOString(), source: "CCS", available: true, summary: { ready: 1, low: 0, exhausted: 0, reconnect: 1, unavailable: 0 }, providers: [
      { id: "claude", label: "Claude Code", available: true, accounts: [{ id: "connected", label: "claude", email: "claude@example.test", plan: null, isDefault: true, paused: false, status: "ready", message: "Connected. Provider reported no active usage window.", updatedAt: null, windows: [] }] },
      { id: "codex", label: "OpenAI Codex", available: true, accounts: [{ id: "0123456789abcdefabcd", label: "codex", email: "codex@example.test", plan: "pro", isDefault: false, paused: false, status: "reconnect", message: "Reconnect this account in CCS", updatedAt: null, windows: [] }] },
    ] };
    const waiting = { sessionId: "session-1", provider: "codex", status: "waiting", message: "Complete the provider login", authUrl: "https://auth.openai.test/authorize?state=safe", expiresAt: "2026-09-01T00:00:00.000Z" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/0123456789abcdefabcd/reconnect") && init?.method === "POST") return new Response(JSON.stringify(waiting), { status: 201 });
      if (url.endsWith("/session-1/callback") && init?.method === "POST") return new Response(JSON.stringify({ ...waiting, status: "success", message: "Account reconnected", authUrl: null }), { status: 200 });
      if (url.endsWith("/session-1")) return new Response(JSON.stringify(waiting), { status: 200 });
      return new Response(JSON.stringify(usage), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountUsageView onBack={() => {}} />);
    assert.ok(await screen.findByText("Connected. Provider reported no active usage window."));
    assert.equal(screen.getAllByRole("button", { name: "Reconnect account" }).length, 1);
    await userEvent.click(screen.getByRole("button", { name: "Reconnect account" }));
    assert.ok(await screen.findByRole("dialog", { name: "Reconnect OpenAI Codex" }));
    assert.equal((await screen.findByRole("link", { name: /Open OpenAI login/ })).getAttribute("href"), waiting.authUrl);
    fireEvent.change(screen.getByRole("textbox", { name: "Localhost callback URL" }), { target: { value: "http://localhost:1455/auth/callback?code=safe&state=safe" } });
    await userEvent.click(screen.getByRole("button", { name: "Finish reconnect" }));
    assert.ok(await screen.findByText("Account reconnected"));
    assert.equal(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/session-1/callback") && init?.method === "POST"), true);
    assert.equal(fetchMock.mock.calls.some(([url]) => String(url).endsWith("?refresh=1")), true);
  });

  test("terminal Markdown and localhost references are interactive", async () => {
    const markdown = vi.fn(); const local = vi.fn();
    render(<TerminalGrid view={{ mode: "text", text: "Read docs/plan.md then http://localhost:3000" }} onMarkdownLink={markdown} onLocalUrl={local} />);
    await userEvent.click(screen.getByRole("button", { name: "docs/plan.md" }));
    await userEvent.click(screen.getByRole("button", { name: "http://localhost:3000" }));
    assert.deepEqual(markdown.mock.calls, [["docs/plan.md"]]);
    assert.deepEqual(local.mock.calls, [["http://localhost:3000"]]);
  });

  test("mobile terminal keeps one composer, hides the native prompt, expands writing, and accepts pasted images", async () => {
    const image = new File(["image"], "paste.png", { type: "image/png" });
    const onImage = vi.fn();
    render(<TerminalPanel
      workspace={{ id: "workspace-1", title: "Sample", terminals: [{ id: "terminal-1", title: "shell" }] }}
      terminal={{ id: "terminal-1", title: "shell" }}
      terminalView={{ mode: "text", text: "result\n\n› Ask Codex to do anything\n\n  gpt-5.6-sol high · ~/repo" }}
      screenError="" draft="/" attachments={[]} queueItems={[]} sending={false} readOnly={false} fontSize={14} fitToPhone shortcutsOpen={false}
      onTerminal={() => {}} onDraft={() => {}} onImage={onImage} onRemoveImage={() => {}} onSubmit={() => {}} onKey={() => {}}
      onQueue={() => {}} onQueueUpdate={async () => {}} onQueueMove={async () => {}} onQueueSend={async () => {}} onQueueRemove={async () => {}}
      onReadOnly={() => {}} onRefresh={() => {}} onShortcuts={() => {}} onMarkdown={() => {}} onLocalUrl={() => {}}
    />);
    assert.equal(screen.getAllByRole("textbox").length, 1);
    assert.equal(screen.queryByText(/Ask Codex to do anything/), null);
    assert.ok(screen.getByRole("button", { name: /^\/help/ }));
    const composer = screen.getByRole("textbox", { name: "Terminal input" });
    fireEvent.paste(composer, { clipboardData: { items: [{ type: "image/png", getAsFile: () => image }] } });
    assert.equal(onImage.mock.calls[0][0], image);
    await userEvent.click(screen.getByRole("button", { name: "Open large writing area" }));
    assert.equal((screen.getByRole("textbox", { name: "Expanded terminal input" }) as HTMLTextAreaElement).value, "/");
  });

  test("queued prompts stay behind a compact composer control and remain editable", async () => {
    const update = vi.fn(async () => {}); const send = vi.fn(async () => {});
    render(<TerminalPanel
      workspace={{ id: "workspace-1", title: "Sample", terminals: [{ id: "terminal-1", title: "shell" }] }}
      terminal={{ id: "terminal-1", title: "shell" }} terminalView={{ mode: "text", text: "working" }} screenError="" draft="" attachments={[]}
      queueItems={[{ id: "11111111-2222-4333-8444-555555555555", workspaceId: "workspace-1", surfaceId: "terminal-1", text: "Run the tests next", createdAt: "2026-01-01", updatedAt: "2026-01-01", attempts: 0 }]}
      sending={false} readOnly={false} fontSize={14} fitToPhone shortcutsOpen={false} onTerminal={() => {}} onDraft={() => {}} onImage={() => {}} onRemoveImage={() => {}} onSubmit={() => {}} onQueue={() => {}} onQueueUpdate={update} onQueueMove={async () => {}} onQueueSend={send} onQueueRemove={async () => {}} onKey={() => {}} onReadOnly={() => {}} onRefresh={() => {}} onShortcuts={() => {}} onMarkdown={() => {}} onLocalUrl={() => {}}
    />);
    await userEvent.click(screen.getByRole("button", { name: "Prompt queue, 1 waiting" }));
    const queued = screen.getByRole("textbox", { name: "Queued prompt 1" });
    await userEvent.clear(queued); await userEvent.type(queued, "Run every test next"); fireEvent.blur(queued);
    assert.deepEqual(update.mock.calls[0], ["11111111-2222-4333-8444-555555555555", "Run every test next"]);
    await userEvent.click(screen.getAllByRole("button", { name: "Send now" }).at(-1)!);
    assert.deepEqual(send.mock.calls[0], ["11111111-2222-4333-8444-555555555555"]);
  });

  test("an open pull request appears as a direct project link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ pullRequest: {
      number: 12, title: "Mobile companion", url: "https://github.com/example/repo/pull/12", state: "OPEN", isDraft: false,
      reviewDecision: "APPROVED", mergeState: "CLEAN", headBranch: "feature", baseBranch: "main",
      checks: { passed: 3, failed: 0, pending: 0, total: 3 },
    } }), { status: 200 })));
    render(<PullRequestBanner repo={{ id: "repo-12345678", name: "sample", root: "root", path: "/repo", branch: "feature", ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 0, scripts: [] }} />);
    const link = await screen.findByRole("link", { name: /#12 Mobile companion/ });
    assert.equal(link.getAttribute("href"), "https://github.com/example/repo/pull/12");
  });

  test("Markdown reader renders rich content and follows safe relative links", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); requests.push(url);
      const guide = url.includes("docs%2Fguide.md");
      return new Response(JSON.stringify({ repo: { id: "repo-12345678", name: "sample", path: "/repo" }, path: guide ? "docs/guide.md" : "README.md", name: guide ? "guide.md" : "README.md", content: guide ? "# Guide\n\nDone." : "# Home\n\n[Guide](docs/guide.md)\n\n```js\nconst ok = true;\n```" }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const ask = vi.fn();
    render(<MarkdownViewer repoId="repo-12345678" path="README.md" onClose={() => {}} onAsk={ask} onOpenWorkspace={() => {}} />);
    assert.ok(await screen.findByRole("heading", { name: "Home" }));
    assert.ok(document.querySelector(".hljs-keyword"), "code is syntax highlighted");
    await userEvent.click(screen.getByRole("button", { name: "Guide" }));
    assert.ok(await screen.findByRole("heading", { name: "Guide" }));
    assert.equal(requests.some((url) => url.includes("docs%2Fguide.md")), true);
    await userEvent.click(screen.getByRole("button", { name: "Ask agent" }));
    assert.equal(ask.mock.calls[0][0].path, "docs/guide.md");
  });

  test("Apps screen explicitly enables and opens a detected private preview", async () => {
    let active = false;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (String(_input).endsWith("/capture")) return new Response(JSON.stringify({ dataUrl: "data:image/png;base64,iVBORw0KGgo=", viewport: { width: 390, height: 844 }, sourceUrl: "http://localhost:3000/" }), { status: 201 });
      if (init?.method === "POST") { active = true; return new Response(JSON.stringify({ preview: {} }), { status: 200 }); }
      return new Response(JSON.stringify({ tailnetOnly: true, previews: [{ id: "preview-1", workspaceId: "workspace-1", name: "Web", targetPort: 3000, sourceUrl: "http://localhost:3000", status: active ? "active" : "detected", url: active ? "https://mac.tail.test:8500" : null, updatedAt: "2026-01-01" }, { id: "preview-old", workspaceId: "workspace-old", name: "Old app", targetPort: 4000, sourceUrl: "http://localhost:4000", status: "stopped", url: null, updatedAt: "2025-01-01" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppsView focusedId="preview-1" onOpenWorkspace={() => {}} onNotice={() => {}} onFix={async () => {}} />);
    assert.equal(screen.queryByText("Old app"), null);
    assert.ok(await screen.findByText("Running · setup needed"));
    await userEvent.click(await screen.findByRole("button", { name: "Create private link" }));
    assert.ok(await screen.findByRole("link", { name: /Open app/ }));
    assert.equal(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/api/previews/preview-1/enable") && init?.method === "POST"), true);
    await userEvent.click(screen.getByRole("button", { name: "◎ Fix this" }));
    assert.ok(await screen.findByRole("dialog", { name: "Annotate preview" }));
    assert.ok(screen.getByRole("img", { name: "Web mobile preview" }));
    await userEvent.click(screen.getByRole("tab", { name: /History/ }));
    const oldCard = (await screen.findByText("Old app")).closest("article");
    assert.ok(oldCard);
    assert.ok(within(oldCard).getByText("Offline"));
    assert.equal(within(oldCard).queryByRole("button", { name: "Create private link" }), null);
    assert.equal(within(oldCard).queryByRole("button", { name: "◎ Fix this" }), null);
  });

  test("notification deep link presents only the exact pending decision", async () => {
    const close = vi.fn(); const reload = vi.fn(async () => {});
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<InboxView inbox={{ actionableCount: 2, unreadCount: 0, items: [
      { id: "req-1", requestId: "req-1", type: "request", kind: "permissionRequest", title: "Run tests", workspaceId: "workspace-1", toolName: "exec", toolInput: { command: "npm test" } },
      { id: "req-2", requestId: "req-2", type: "request", kind: "question", title: "Hidden question" },
    ] }} workspaces={[{ id: "workspace-1", title: "Sample", current_directory: "/repo", terminals: [] }]} repos={[{ id: "repo-12345678", name: "sample", root: "root", path: "/repo", branch: "main", ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 0, scripts: [] }]} focusedId="req-1" onCloseFocus={close} onDocument={() => {}} onReload={reload} onOpen={() => {}} onNotice={() => {}} />);
    assert.ok(screen.getByRole("heading", { name: "Run tests" }));
    assert.equal(screen.queryByText("Hidden question"), null);
    await userEvent.click(screen.getByRole("button", { name: "Approve once" }));
    await waitFor(() => assert.equal(close.mock.calls.length, 1));
    assert.equal(fetchMock.mock.calls[0][0], "/api/inbox/req-1/reply");
  });
});

describe("last update stamp", () => {
  const jsonRoutes = (routes: Record<string, unknown>) => vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    const match = Object.keys(routes).find((key) => path.endsWith(key));
    if (!match) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[match]), { status: 200, headers: { "content-type": "application/json" } });
  });

  test("prefers the last successful update time", async () => {
    const iso = new Date(Date.now() - 4 * 3_600_000).toISOString();
    vi.stubGlobal("fetch", jsonRoutes({ "/api/updater/status": { available: true, lastSuccessAt: iso }, "/api/health": { version: { builtAt: new Date().toISOString() } } }));
    render(<LastUpdateStamp />);
    const stamp = await screen.findByText("Updated 4h ago");
    assert.equal(stamp.tagName, "TIME");
    assert.equal(stamp.getAttribute("datetime"), iso);
    assert.equal(stamp.getAttribute("title"), iso);
  });

  test("falls back to the build time when the updater reports nothing", async () => {
    const iso = new Date(Date.now() - 3 * 86_400_000).toISOString();
    vi.stubGlobal("fetch", jsonRoutes({ "/api/updater/status": { available: false }, "/api/health": { version: { builtAt: iso } } }));
    render(<LastUpdateStamp />);
    assert.ok(await screen.findByText("Updated 3d ago"));
  });

  test("renders nothing when neither timestamp exists", async () => {
    vi.stubGlobal("fetch", jsonRoutes({ "/api/updater/status": { available: false }, "/api/health": { version: { builtAt: null } } }));
    const { container } = render(<LastUpdateStamp />);
    await waitFor(() => assert.equal(container.querySelector("time"), null));
    assert.equal(screen.queryByText(/Updated/), null);
  });
});

describe("deployment health", () => {
  const sha = (character: string) => character.repeat(40);
  const service = (overrides: Record<string, unknown> = {}) => ({
    deployedSha: sha("a"), observedRemoteSha: sha("a"), quarantinedSha: null,
    alive: true, healthy: true, status: "current", ...overrides,
  });
  const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  test("shows both current deployments and refreshes them on demand", async () => {
    const fetchMock = vi.fn(async () => response({
      available: true, summary: "healthy", phase: "idle", lastCheckAt: "2026-09-01T12:10:07.113Z", lastSuccessAt: "2026-09-01T12:08:30.471Z",
      services: { companion: service({ runningSha: sha("a") }), updater: service({ deployedSha: sha("b"), observedRemoteSha: sha("b") }) },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DeploymentHealth />);
    assert.ok(await screen.findByText("Both services healthy"));
    assert.ok(screen.getByText("cmux companion"));
    assert.ok(screen.getByText("cmux companion updater"));
    assert.equal(screen.getAllByText("Current").length, 2);
    assert.equal(screen.getByRole("region", { name: "Deployment health" }).getAttribute("aria-busy"), "false");
    assert.equal(screen.getByRole("status").textContent, "Both services healthy");
    await userEvent.click(screen.getByRole("button", { name: "Refresh deployment health" }));
    await waitFor(() => assert.equal(fetchMock.mock.calls.length, 2));
  });

  test("makes an in-progress Companion rollout explicit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      available: true, summary: "updating", phase: "fetching", lastCheckAt: new Date().toISOString(),
      services: { companion: service({ healthy: false, status: "updating", pendingSha: sha("c") }), updater: service() },
    })));
    render(<DeploymentHealth />);
    assert.ok(await screen.findByText("Update in progress"));
    assert.ok(screen.getByText("Updating"));
    assert.ok(screen.getByText("fetching"));
  });

  test("shows updater failures with the bounded recovery detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      available: true, summary: "attention", phase: "failed", lastCheckAt: new Date().toISOString(), lastError: "Unsafe non-fast-forward history for updater",
      services: { companion: service(), updater: service({ healthy: false, status: "problem", quarantinedSha: sha("c") }) },
    })));
    render(<DeploymentHealth />);
    assert.ok(await screen.findByText("Attention needed"));
    assert.ok(screen.getByText("Problem"));
    assert.ok(screen.getByText("Unsafe non-fast-forward history for updater"));
  });

  test("shows intentionally paused automatic updates without claiming health", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      available: true, enabled: false, summary: "paused", phase: "idle", lastCheckAt: new Date().toISOString(),
      services: { companion: service(), updater: service({ enabled: false, healthy: false, status: "paused" }) },
    })));
    render(<DeploymentHealth />);
    assert.ok(await screen.findByText("Automatic updates paused"));
    assert.ok(screen.getByText("Paused"));
  });
});
