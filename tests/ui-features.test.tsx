import assert from "node:assert/strict";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, test, vi } from "vitest";
import { AppsView } from "../app/apps-view";
import { MarkdownViewer } from "../app/markdown-viewer";
import { InboxView } from "../app/page";
import { TerminalGrid } from "../app/terminal-grid.tsx";

afterEach(() => vi.unstubAllGlobals());

describe("contextual mobile features", () => {
  test("terminal Markdown and localhost references are interactive", async () => {
    const markdown = vi.fn(); const local = vi.fn();
    render(<TerminalGrid view={{ mode: "text", text: "Read docs/plan.md then http://localhost:3000" }} onMarkdownLink={markdown} onLocalUrl={local} />);
    await userEvent.click(screen.getByRole("button", { name: "docs/plan.md" }));
    await userEvent.click(screen.getByRole("button", { name: "http://localhost:3000" }));
    assert.deepEqual(markdown.mock.calls, [["docs/plan.md"]]);
    assert.deepEqual(local.mock.calls, [["http://localhost:3000"]]);
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
      if (init?.method === "POST") { active = true; return new Response(JSON.stringify({ preview: {} }), { status: 200 }); }
      return new Response(JSON.stringify({ tailnetOnly: true, previews: [{ id: "preview-1", workspaceId: "workspace-1", name: "Web", targetPort: 3000, sourceUrl: "http://localhost:3000", status: active ? "active" : "detected", url: active ? "https://mac.tail.test:8500" : null, updatedAt: "2026-01-01" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppsView focusedId="preview-1" onOpenWorkspace={() => {}} onNotice={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Make private link" }));
    assert.ok(await screen.findByRole("link", { name: "Open" }));
    assert.equal(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/api/previews/preview-1/enable") && init?.method === "POST"), true);
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
