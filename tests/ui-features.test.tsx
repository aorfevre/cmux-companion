import assert from "node:assert/strict";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, test, vi } from "vitest";
import { AccountUsageView } from "../app/account-usage";
import { AppsView } from "../app/apps-view";
import { MarkdownViewer } from "../app/markdown-viewer";
import { BottomNav, HomeModeSwitch, InboxView, PullRequestBanner, TerminalPanel } from "../app/page";
import { TerminalGrid } from "../app/terminal-grid.tsx";
import { WorktreeDashboardView } from "../app/worktree-dashboard";

afterEach(() => vi.unstubAllGlobals());

describe("contextual mobile features", () => {
  test("keeps permanent navigation focused on frequent mobile destinations", async () => {
    const navigate = vi.fn();
    render(<BottomNav view="usage" onView={navigate} />);
    assert.ok(screen.getByRole("button", { name: "Licence Usage" }).classList.contains("active"));
    assert.ok(screen.getByRole("button", { name: "Apps" }));
    assert.equal(screen.queryByRole("button", { name: "Inbox" }), null);
    assert.equal(screen.queryByRole("button", { name: "Launch" }), null);
    await userEvent.click(screen.getByRole("button", { name: "Apps" }));
    assert.deepEqual(navigate.mock.calls[0], ["apps"]);
  });

  test("shows CCS quota by account while treating absent windows as unreported", async () => {
    const usage = { generatedAt: new Date().toISOString(), source: "CCS", available: true, summary: { ready: 1, low: 0, exhausted: 0, reconnect: 1, unavailable: 0 }, providers: [
      { id: "claude", label: "Claude Code", available: true, accounts: [{ id: "one", label: "one", email: "one@example.test", plan: null, isDefault: true, paused: false, status: "ready", message: null, updatedAt: new Date().toISOString(), windows: [
        { id: "usage-5h-0", cadence: "5h", label: "Session limit", category: "usage", remainingPercent: 82, resetAt: new Date(Date.now() + 3_600_000).toISOString(), reported: true },
        { id: "usage-weekly-1", cadence: "weekly", label: "Weekly limit", category: "usage", remainingPercent: 55, resetAt: null, reported: true },
      ] }] },
      { id: "codex", label: "OpenAI Codex", available: true, accounts: [{ id: "two", label: "two", email: "two@example.test", plan: "pro", isDefault: false, paused: false, status: "reconnect", message: "Reconnect this account in CCS", updatedAt: null, windows: [] }] },
    ] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => { void input; return new Response(JSON.stringify(usage), { status: 200, headers: { "content-type": "application/json" } }); });
    vi.stubGlobal("fetch", fetchMock);
    const back = vi.fn();
    render(<AccountUsageView onBack={back} />);
    assert.ok(await screen.findByText("one@example.test"));
    assert.ok(screen.getByText("82%"));
    assert.equal(screen.getAllByText("Not reported").length, 3);
    assert.equal(screen.queryByText("Daily"), null);
    assert.equal(screen.queryByText("Weekly"), null);
    assert.ok(screen.getByText("Reconnect this account in CCS"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh account usage" }));
    await waitFor(() => assert.equal(fetchMock.mock.calls.some(([url]) => String(url).endsWith("?refresh=1")), true));
    await userEvent.click(screen.getByRole("button", { name: "‹ Settings" }));
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

  test("keeps classic sessions available while the worktree visualization is opt-in", async () => {
    const mode = vi.fn();
    render(<HomeModeSwitch mode="sessions" onMode={mode} />);
    assert.equal(screen.getByRole("button", { name: "Sessions" }).getAttribute("aria-pressed"), "true");
    await userEvent.click(screen.getByRole("button", { name: /Worktrees Beta/ }));
    assert.deepEqual(mode.mock.calls[0], ["worktrees"]);
  });

  test("groups parallel sessions by worktree and launches an isolated agent", async () => {
    const dashboard = { generatedAt: "2026-08-31", summary: { repositories: 1, worktrees: 2, sessions: 1, needsYou: 0, working: 1, dirty: 1, pullRequests: 1 }, orphanSessions: [], repositories: [{
      id: "repo-1", name: "companion", root: "karven", path: "/repo/companion", pullRequestsAvailable: true, summary: { worktrees: 2, sessions: 1, needsYou: 0, working: 1, dirty: 1 }, worktrees: [{
        id: "worktree123456789", repoId: "repo-1", path: "/repo/companion-feature", name: "companion-feature", branch: "feature/mobile", isPrimary: false, detached: false, ahead: 2, behind: 0, changedFiles: 3, dirty: true, lastActivity: Math.round(Date.now() / 1000), state: { label: "Working", tone: "working" },
        pullRequest: { number: 12, title: "Mobile dashboard", url: "https://github.test/pr/12", isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeState: "CLEAN", checks: { passed: 2, failed: 0, pending: 1, total: 3 } },
        sessions: [{ id: "workspace-1", title: "mobile agent", preview: "Editing app/page.tsx", terminalCount: 1, lastActivityAt: Math.round(Date.now() / 1000), provider: "Codex", state: { label: "Working", tone: "working" } }],
      }, {
        id: "worktree987654321", repoId: "repo-1", path: "/repo/companion-old", name: "companion-old", branch: "chore/old-work", isPrimary: false, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, state: { label: "No session", tone: "ready" }, pullRequest: null, sessions: [],
      }] }] };
    const open = vi.fn(); const launched = vi.fn(async () => {}); const notice = vi.fn();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(_input);
      if (url.endsWith("/api/attachments/images") && init?.method === "POST") return new Response(JSON.stringify({ image: { path: "/private/launch.png", name: "launch.png", mime: "image/png", size: 5 } }), { status: 201 });
      if (init?.method === "POST") return new Response(JSON.stringify({ workspace: { workspace_id: "workspace-new" } }), { status: 201 });
      return new Response(JSON.stringify(dashboard), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<WorktreeDashboardView onOpenWorkspace={open} onLaunched={launched} onNotice={notice} />);
    assert.ok(await screen.findByText("feature/mobile"));
    assert.equal(screen.getByRole("link", { name: /PR #12.*Mobile dashboard/ }).getAttribute("href"), "https://github.test/pr/12");
    await userEvent.click(screen.getByRole("button", { name: /^mobile agent/ }));
    assert.deepEqual(open.mock.calls[0], ["workspace-1"]);
    await userEvent.click(screen.getByRole("button", { name: "Close session mobile agent" }));
    assert.equal(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/api/workspaces/workspace-1/close") && init?.method === "POST"), true);
    await userEvent.click(screen.getAllByRole("button", { name: "＋ Agent" })[0]);
    assert.ok(screen.getByRole("dialog", { name: "Launch worktree agent" }));
    await userEvent.click(screen.getByRole("button", { name: "Claude (xclaude)" }));
    const initialTask = screen.getByRole("textbox", { name: "Initial task" });
    await userEvent.type(initialTask, "Review the mobile dashboard");
    const launchImage = new File(["image"], "launch.png", { type: "image/png" });
    fireEvent.paste(initialTask, { clipboardData: { items: [{ type: "image/png", getAsFile: () => launchImage }] } });
    assert.ok(await screen.findByRole("img", { name: "launch.png" }));
    await userEvent.click(screen.getByRole("button", { name: "Launch Claude" }));
    await waitFor(() => assert.deepEqual(launched.mock.calls[0], ["workspace-new"]));
    const launchCall = fetchMock.mock.calls.find(([url, init]) => String(url).includes("/worktree123456789/launch") && init?.method === "POST");
    assert.ok(launchCall);
    assert.match(String(launchCall?.[1]?.body), /Review the mobile dashboard/);
    assert.match(String(launchCall?.[1]?.body), /Attached image:\\n- \/private\/launch.png/);
    const oldWorktree = screen.getByText("chore/old-work").closest("article");
    assert.ok(oldWorktree);
    await userEvent.click(within(oldWorktree).getByRole("button", { name: "Remove" }));
    assert.ok(within(oldWorktree).getByText("Remove local worktree?"));
    await userEvent.click(within(oldWorktree).getByRole("button", { name: "Confirm remove" }));
    const removeCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/api/worktree-dashboard/worktree987654321") && init?.method === "DELETE");
    assert.ok(removeCall);
    assert.equal(new Headers(removeCall[1]?.headers).has("Content-Type"), false);
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
