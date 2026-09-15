import assert from "node:assert/strict";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, test, vi } from "vitest";
import { MarkdownViewer } from "../app/markdown-viewer";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

type Call = { url: string; method: string; body: unknown };
function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
function stubApi(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: (init?.method || "GET").toUpperCase(), body: typeof init?.body === "string" && init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const result = handler(call);
    return result instanceof Response ? result : jsonResponse(result);
  }));
  return calls;
}

describe("MarkdownViewer", () => {
  const file = (path: string, content: string) => ({ repo: { id: "repo-12345678", name: "sample", path: "/repo" }, path, name: path.split("/").pop(), content });

  test("shows the error state and lets the reader go back", async () => {
    stubApi(() => jsonResponse({ error: "File is outside the repository" }, 403));
    const close = vi.fn();
    render(<MarkdownViewer repoId="repo-12345678" path="docs/x.md" onClose={close} onAsk={() => {}} onOpenWorkspace={() => {}} />);
    assert.ok(screen.getByText("Reading Markdown…"));
    assert.ok(screen.getByText("x.md"));
    assert.ok(await screen.findByText("File is outside the repository"));
    await userEvent.click(screen.getByRole("button", { name: "Go back" }));
    await userEvent.click(screen.getByRole("button", { name: "‹ Back" }));
    assert.equal(close.mock.calls.length, 2);
  });

  test("reports a generic message when the fetch itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw "offline"; }));
    render(<MarkdownViewer repoId="repo-12345678" path="README.md" onClose={() => {}} onAsk={() => {}} onOpenWorkspace={() => {}} />);
    assert.ok(await screen.findByText("Markdown file unavailable"));
  });

  test("renders a table of contents, images, link kinds, raw mode and toasts", async () => {
    const content = [
      "# Title ##", "## Second", "### Third", "",
      "![Diagram](assets/flow.png) ![Missing](../../out.png)",
      "[Sibling](guide.md) [Outside](../../escape.md) [Web](https://example.com) [Mail](mailto:a@b.c)",
      "| a | b |", "|---|---|", "| 1 | 2 |",
    ].join("\n");
    stubApi(() => file("docs/README.md", content));
    const openWorkspace = vi.fn();
    render(<MarkdownViewer repoId="repo-12345678" path="docs/README.md" onClose={() => {}} onAsk={() => {}} onOpenWorkspace={openWorkspace} />);
    assert.ok(await screen.findByRole("heading", { name: "Title", level: 1 }));
    assert.ok(screen.getByText("sample · docs/README.md"));
    assert.equal(screen.getByRole("heading", { name: "Title" }).id, "title");
    assert.equal(screen.getByRole("heading", { name: "Second" }).id, "second");
    assert.equal(screen.getByRole("heading", { name: "Third" }).id, "third");
    assert.ok(screen.getByText("Contents · 3 sections"));
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const toc = screen.getByText("Contents · 3 sections").closest("details") as HTMLElement;
    const third = within(toc).getByRole("button", { name: "Third" });
    assert.equal(third.style.paddingLeft, "36px");
    await userEvent.click(third);
    assert.ok(scroll.mock.contexts.includes(screen.getByRole("heading", { name: "Third" })));
    assert.equal(screen.getByRole("img", { name: "Diagram" }).getAttribute("src"), "/api/repos/repo-12345678/assets?file=docs%2Fassets%2Fflow.png");
    assert.ok(screen.getByText("Image unavailable: Missing"));
    assert.ok(screen.getByRole("button", { name: "Sibling" }));
    assert.equal(screen.getByText("Outside").tagName, "SPAN");
    assert.equal(screen.getByText("Mail").tagName, "SPAN");
    const web = screen.getByRole("link", { name: "Web" });
    assert.equal(web.getAttribute("href"), "https://example.com");
    assert.equal(web.getAttribute("rel"), "noreferrer");
    assert.ok(screen.getByRole("table"));
    await userEvent.click(screen.getByRole("button", { name: "Open session" }));
    assert.deepEqual(openWorkspace.mock.calls, [["repo-12345678"]]);
    await userEvent.click(screen.getByRole("button", { name: "Copy link" }));
    assert.ok(await screen.findByText("Document link copied"));
    assert.deepEqual(vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1), [location.href]);
    await userEvent.click(screen.getByText("Document link copied"));
    assert.equal(screen.queryByText("Document link copied"), null);
    await userEvent.click(screen.getByRole("button", { name: "Raw" }));
    assert.equal(document.querySelector(".document-raw")?.textContent, content);
    assert.equal(screen.queryByRole("table"), null);
    await userEvent.click(screen.getByRole("button", { name: "Read" }));
    assert.ok(screen.getByRole("table"));
  });

  test("follows repository links and updates the address, refusing links that escape", async () => {
    const calls = stubApi(({ url }) => url.includes("guide.md") ? file("docs/guide.md", "# Guide") : file("docs/README.md", "[Guide](guide.md) [Escape](../../escape.md)"));
    const replace = vi.spyOn(history, "replaceState");
    render(<MarkdownViewer repoId="repo-12345678" path="docs/README.md" onClose={() => {}} onAsk={() => {}} onOpenWorkspace={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Guide" }));
    assert.ok(await screen.findByRole("heading", { name: "Guide" }));
    assert.equal(calls.at(-1)?.url, "/api/repos/repo-12345678/markdown?file=docs%2Fguide.md");
    assert.deepEqual(replace.mock.calls.at(-1), [null, "", "/?repo=repo-12345678&file=docs%2Fguide.md"]);
    assert.equal(screen.queryByText("Contents · 1 sections"), null, "short documents have no table of contents");
    vi.mocked(fetch).mockImplementation(async () => jsonResponse(file("docs/README.md", "[Guide](guide.md) [Escape](../../escape.md)")));
    render(<MarkdownViewer repoId="repo-12345678" path="docs/README.md" onClose={() => {}} onAsk={() => {}} onOpenWorkspace={() => {}} />);
    const escape = await screen.findByText("Escape");
    assert.equal(escape.tagName, "SPAN");
  });
});
