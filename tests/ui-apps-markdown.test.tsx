import assert from "node:assert/strict";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, test, vi } from "vitest";
import { AppsView, type Preview } from "../app/apps-view";
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

const previewAt = (offsetMs: number) => new Date(Date.now() - offsetMs).toISOString();
const makePreview = (overrides: Partial<Preview>): Preview => ({ id: "p", workspaceId: "ws", name: "App", targetPort: 3000, sourceUrl: "http://localhost:3000", status: "detected", updatedAt: previewAt(0), url: null, ...overrides });

describe("AppsView", () => {
  test("shows the empty state, then surfaces load failures", async () => {
    let fail = false;
    stubApi(() => fail ? jsonResponse({ error: "Preview service offline" }, 503) : { previews: [] });
    render(<AppsView focusedId={null} onOpenWorkspace={() => {}} onNotice={() => {}} />);
    assert.ok(await screen.findByText("No local apps detected"));
    fail = true;
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    assert.ok(await screen.findByText("Preview service offline"));
    assert.equal(screen.queryByText("No local apps detected"), null);
  });

  test("polls while visible and reports non-Error failures generically", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { calls += 1; if (calls >= 3) throw "boom"; return jsonResponse({ previews: [] }); }));
    render(<AppsView focusedId={null} onOpenWorkspace={() => {}} onNotice={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    assert.equal(calls, 1);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    assert.equal(calls, 1, "hidden tabs do not poll");
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    assert.equal(calls, 2);
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    assert.equal(calls, 3);
    assert.ok(screen.getByText("Private previews unavailable"));
  });

  test("summarizes availability, switches tabs, and moves a stopped focused app into history", async () => {
    const previews = [
      makePreview({ id: "ready", name: "Ready app", status: "active", url: "https://mac.tail.test:8500", updatedAt: previewAt(5 * 60_000) }),
      makePreview({ id: "found", name: "Found app", status: "detected", updatedAt: previewAt(3 * 3_600_000) }),
      makePreview({ id: "gone", name: "Gone app", status: "stopped", updatedAt: previewAt(2 * 86_400_000) }),
      makePreview({ id: "bad-date", name: "Odd app", status: "stopped", updatedAt: "not a date" }),
    ];
    stubApi(() => ({ previews }));
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    render(<AppsView focusedId="gone" onOpenWorkspace={() => {}} onNotice={() => {}} />);
    assert.ok(await screen.findByText("Ready app"));
    assert.ok(screen.getByText("localhost:3000 · 5m ago"));
    assert.ok(screen.getByText("localhost:3000 · 3h ago"));
    const testable = screen.getByRole("tab", { name: /Testable/ });
    assert.equal(testable.textContent, "Testable 2");
    assert.equal(screen.getByRole("tab", { name: /History/ }).textContent, "History 2");
    assert.equal(screen.queryByRole("button", { name: "Clear history" }), null);
    await waitFor(() => assert.equal(screen.getByRole("tab", { name: /History/ }).getAttribute("aria-selected"), "true"));
    assert.ok(screen.getByText("Gone app"));
    assert.ok(screen.getByText("localhost:3000 · 2d ago"));
    assert.ok(screen.getByText("localhost:3000 · now"));
    assert.equal(screen.queryByText("Ready app"), null);
    await waitFor(() => assert.ok(scroll.mock.calls.length >= 1));
    assert.ok(document.querySelector('[data-preview="gone"]')?.classList.contains("focused"));
    assert.ok(screen.getByRole("button", { name: "Clear history" }));
    await userEvent.click(testable);
    assert.ok(screen.getByText("Ready app"));
    assert.equal(screen.getByRole("link", { name: /Open app/ }).getAttribute("href"), "https://mac.tail.test:8500");
  });

  test("shows the tab-specific empty cards", async () => {
    stubApi(() => ({ previews: [makePreview({ id: "gone", status: "stopped" })] }));
    render(<AppsView focusedId={null} onOpenWorkspace={() => {}} onNotice={() => {}} />);
    assert.ok(await screen.findByText("Nothing to test yet"));
    await userEvent.click(screen.getByRole("tab", { name: /History/ }));
    assert.equal(screen.queryByText("Nothing to test yet"), null);
    assert.ok(within(document.querySelector('[data-preview="gone"]') as HTMLElement).getByText("Offline"));
    vi.mocked(fetch).mockImplementation(async () => jsonResponse({ previews: [makePreview({ id: "found" })] }));
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    assert.ok(await screen.findByText("No stopped apps"));
  });

  test("runs link actions from the card, reports outcomes, and copies links", async () => {
    let status: Preview["status"] = "active";
    const notice = vi.fn(); const openWorkspace = vi.fn();
    const calls = stubApi(({ url, method }) => {
      if (method === "GET") return { previews: [makePreview({ id: "p1", workspaceId: "ws-9", status, url: status === "active" ? "https://mac.tail.test:8500" : null })] };
      if (url.endsWith("/stop")) { status = "detected"; return {}; }
      if (url.endsWith("/restart")) return {};
      if (url.endsWith("/enable")) return jsonResponse({ error: "Port is busy" }, 409);
      if (method === "DELETE") { status = "stopped"; return {}; }
      throw new Error(`unexpected ${method} ${url}`);
    });
    render(<AppsView focusedId={null} onOpenWorkspace={openWorkspace} onNotice={notice} />);
    assert.ok(await screen.findByText("Ready to open"));
    assert.equal(screen.queryByRole("button", { name: /Fix this/ }), null, "fixes need an onFix handler");
    await userEvent.click(screen.getByRole("button", { name: "Open session" }));
    assert.deepEqual(openWorkspace.mock.calls, [["ws-9"]]);
    await userEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => assert.deepEqual(notice.mock.calls.at(-1), ["Preview link copied"]));
    assert.deepEqual(vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1), ["https://mac.tail.test:8500"]);
    await userEvent.click(screen.getByRole("button", { name: "Restart link" }));
    await waitFor(() => assert.deepEqual(notice.mock.calls.at(-1), ["Private preview link restarted"]));
    await userEvent.click(screen.getByRole("button", { name: "Stop link" }));
    await waitFor(() => assert.deepEqual(notice.mock.calls.at(-1), ["Private preview stopped"]));
    assert.ok(await screen.findByText("Running · setup needed"));
    await userEvent.click(screen.getByRole("button", { name: "Create private link" }));
    await waitFor(() => assert.deepEqual(notice.mock.calls.at(-1), ["Port is busy"]));
    await userEvent.click(screen.getByRole("button", { name: "Remove from list" }));
    await waitFor(() => assert.deepEqual(notice.mock.calls.at(-1), ["Preview removed"]));
    assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
    assert.ok(await screen.findByText("Nothing to test yet"));
    await userEvent.click(screen.getByRole("tab", { name: /History/ }));
    assert.ok(screen.getByRole("button", { name: "Remove from history" }));
  });

  test("reports failed actions generically when the failure is not an Error", async () => {
    const notice = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => { if (init?.method === "POST") throw "offline"; return jsonResponse({ previews: [makePreview({ id: "p1" })] }); }));
    render(<AppsView focusedId={null} onOpenWorkspace={() => {}} onNotice={notice} onFix={async () => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Create private link" }));
    await waitFor(() => assert.deepEqual(notice.mock.calls.at(-1), ["Preview action failed"]));
    await userEvent.click(screen.getByRole("button", { name: "◎ Fix this" }));
    await waitFor(() => assert.deepEqual(notice.mock.calls.at(-1), ["Could not capture preview"]));
  });

  test("clears stopped history only after confirmation and stops at the first failure", async () => {
    const notice = vi.fn();
    let deletes = 0;
    stubApi(({ method }) => {
      if (method === "DELETE") { deletes += 1; return deletes === 2 ? jsonResponse({ error: "locked" }, 500) : {}; }
      return { previews: [makePreview({ id: "a", status: "stopped" }), makePreview({ id: "b", status: "stopped" }), makePreview({ id: "c", status: "stopped" })] };
    });
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmMock);
    render(<AppsView focusedId={null} onOpenWorkspace={() => {}} onNotice={notice} />);
    await userEvent.click(await screen.findByRole("tab", { name: /History/ }));
    await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
    assert.deepEqual(confirmMock.mock.calls, [["Remove 3 stopped apps from history?"]]);
    assert.equal(deletes, 0);
    confirmMock.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
    await waitFor(() => assert.deepEqual(notice.mock.calls.at(-1), ["Could not clear all stopped apps"]));
    assert.equal(deletes, 2);
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "DELETE" ? jsonResponse({}) : jsonResponse({ previews: [makePreview({ id: "a", status: "stopped" })] }));
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => assert.equal(screen.getByRole("tab", { name: /History/ }).textContent, "History 1"));
    await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
    assert.deepEqual(confirmMock.mock.calls.at(-1), ["Remove 1 stopped app from history?"]);
    await waitFor(() => assert.deepEqual(notice.mock.calls.at(-1), ["Stopped app history cleared"]));
  });

  test("captures a preview, annotates it and sends the fix prompt", async () => {
    const notice = vi.fn(); const onFix = vi.fn(async () => {});
    const calls = stubApi(({ url, method }) => {
      if (url.endsWith("/capture")) return { dataUrl: "data:image/png;base64,iVBORw0KGgo=", viewport: { width: 390, height: 844 }, sourceUrl: "http://localhost:3000/" };
      if (url.endsWith("/api/attachments/images")) return { image: { path: "/tmp/fix-web-app.png" } };
      if (method === "GET") return { previews: [makePreview({ id: "p1", name: "Web App", status: "detected" })] };
      throw new Error(`unexpected ${method} ${url}`);
    });
    const context = { drawImage: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), lineWidth: 0 };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,annotated");
    class FakeImage { naturalWidth = 400; naturalHeight = 800; onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_value: string) { queueMicrotask(() => this.onload?.()); } }
    vi.stubGlobal("Image", FakeImage);
    Object.defineProperty(SVGElement.prototype, "setPointerCapture", { value: vi.fn(), configurable: true });
    render(<AppsView focusedId={null} onOpenWorkspace={() => {}} onNotice={notice} onFix={onFix} />);
    await userEvent.click(await screen.findByRole("button", { name: "◎ Fix this" }));
    const dialog = await screen.findByRole("dialog", { name: "Annotate preview" });
    const capture = calls.find((call) => call.url.endsWith("/capture"))?.body as { width: number; height: number };
    assert.ok(capture.width >= 320 && capture.width <= 430);
    assert.ok(capture.height >= 600 && capture.height <= 932);
    const undo = within(dialog).getByRole("button", { name: "Undo" }) as HTMLButtonElement;
    assert.equal(undo.disabled, true);
    const svg = dialog.querySelector("svg") as SVGSVGElement;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 200, right: 100, bottom: 200, x: 0, y: 0, toJSON() {} });
    fireEvent.pointerMove(svg, { clientX: 10, clientY: 10 });
    assert.equal(dialog.querySelectorAll("circle, polyline").length, 0, "moves without a press draw nothing");
    fireEvent.pointerDown(svg, { clientX: 10, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 50, clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    fireEvent.pointerDown(svg, { clientX: -5, clientY: 100, pointerId: 2 });
    fireEvent.pointerCancel(svg, { pointerId: 2 });
    assert.equal(dialog.querySelectorAll("polyline").length, 1);
    assert.equal(dialog.querySelector("polyline")?.getAttribute("points"), "100,100 500,1000");
    assert.equal(dialog.querySelectorAll("circle").length, 1);
    assert.equal(dialog.querySelector("circle")?.getAttribute("cx"), "0");
    assert.equal(undo.disabled, false);
    await userEvent.click(undo);
    assert.equal(dialog.querySelectorAll("circle").length, 0);
    await userEvent.type(within(dialog).getByRole("textbox", { name: "What should change?" }), "Button is cut off");
    await userEvent.click(within(dialog).getByRole("button", { name: "Queue fix" }));
    await waitFor(() => assert.equal(onFix.mock.calls.length, 1));
    const [preview, prompt, queue] = onFix.mock.calls[0] as unknown as [Preview, string, boolean];
    assert.equal(preview.id, "p1");
    assert.equal(queue, true);
    assert.ok(prompt.includes("Feedback: Button is cut off"));
    assert.ok(prompt.includes("Mobile viewport: 390×844"));
    assert.ok(prompt.includes("- /tmp/fix-web-app.png"));
    assert.deepEqual(calls.find((call) => call.url.endsWith("/api/attachments/images"))?.body, { dataUrl: "data:image/png;base64,annotated", name: "fix-web-app.png" });
    assert.equal(context.stroke.mock.calls.length, 1);
    assert.equal(context.arc.mock.calls.length, 0);
    await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  });

  test("sends now without feedback, draws dots for taps, and reports save failures", async () => {
    const notice = vi.fn(); const onFix = vi.fn(async () => {});
    let saveFails = true;
    stubApi(({ url, method }) => {
      if (url.endsWith("/capture")) return { dataUrl: "data:image/png;base64,iVBORw0KGgo=", viewport: { width: 390, height: 844 }, sourceUrl: "http://localhost:3000/" };
      if (url.endsWith("/api/attachments/images")) return saveFails ? jsonResponse({ error: "Disk full" }, 507) : { image: { path: "/tmp/fix-preview.png" } };
      if (method === "GET") return { previews: [makePreview({ id: "p1", name: "", status: "active", url: "https://mac.tail.test" })] };
      throw new Error(`unexpected ${method} ${url}`);
    });
    const context = { drawImage: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), lineWidth: 0 };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,annotated");
    class FakeImage { naturalWidth = 400; naturalHeight = 800; onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_value: string) { queueMicrotask(() => this.onload?.()); } }
    vi.stubGlobal("Image", FakeImage);
    Object.defineProperty(SVGElement.prototype, "setPointerCapture", { value: vi.fn(), configurable: true });
    render(<AppsView focusedId={null} onOpenWorkspace={() => {}} onNotice={notice} onFix={onFix} />);
    await userEvent.click(await screen.findByRole("button", { name: "◎ Fix this" }));
    const dialog = await screen.findByRole("dialog", { name: "Annotate preview" });
    const svg = dialog.querySelector("svg") as SVGSVGElement;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON() {} });
    fireEvent.pointerDown(svg, { clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    await userEvent.click(within(dialog).getByRole("button", { name: "Send now" }));
    await waitFor(() => assert.deepEqual(notice.mock.calls.at(-1), ["Disk full"]));
    assert.ok(screen.getByRole("dialog"), "the editor stays open after a failure");
    assert.equal(context.arc.mock.calls.length, 1);
    saveFails = false;
    await userEvent.click(within(dialog).getByRole("button", { name: "Send now" }));
    await waitFor(() => assert.equal(onFix.mock.calls.length, 1));
    const [, prompt, queue] = onFix.mock.calls[0] as unknown as [Preview, string, boolean];
    assert.equal(queue, false);
    assert.ok(prompt.includes("Inspect the marked area"));
    assert.deepEqual((vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/api/attachments/images"))?.[1]?.body as string).includes('"name":"fix-preview.png"'), true);
  });

  test("reports an annotation failure when the canvas or image is unusable and lets the user cancel", async () => {
    const notice = vi.fn();
    stubApi(({ url }) => url.endsWith("/capture") ? { dataUrl: "data:image/png;base64,iVBORw0KGgo=", viewport: { width: 390, height: 844 }, sourceUrl: "http://localhost:3000/" } : { previews: [makePreview({ id: "p1" })] });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
    class LoadedImage { naturalWidth = 1; naturalHeight = 1; onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_value: string) { queueMicrotask(() => this.onload?.()); } }
    class BrokenImage { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_value: string) { queueMicrotask(() => this.onerror?.()); } }
    vi.stubGlobal("Image", LoadedImage);
    render(<AppsView focusedId={null} onOpenWorkspace={() => {}} onNotice={notice} onFix={async () => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "◎ Fix this" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send now" }));
    await waitFor(() => assert.deepEqual(notice.mock.calls.at(-1), ["Annotation is unavailable"]));
    vi.stubGlobal("Image", BrokenImage);
    await userEvent.click(within(dialog).getByRole("button", { name: "Queue fix" }));
    await waitFor(() => assert.deepEqual(notice.mock.calls.at(-1), ["Could not prepare the preview annotation"]));
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    assert.equal(screen.queryByRole("dialog"), null);
  });
});

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
