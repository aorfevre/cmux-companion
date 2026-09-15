import assert from "node:assert/strict";

import { afterEach, describe, test, vi } from "vitest";
import { resolveAssetPath, resolveMarkdownPath, splitContextLinks } from "../app/context-links.mjs";
import { isNearBottom, nextFollowState } from "../app/terminal-follow.mjs";
import { nativeComposerStartRow, normalizeRenderGrid, safeTerminalColor, terminalViewSignature, withoutNativeComposer } from "../app/terminal-grid.mjs";
import { relativeTime } from "../app/relative-time";
import { ImageUploadSession } from "../app/image-upload-session";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("context links", () => {
  test("splits Markdown paths and local URLs out of plain text, preferring the longest match at a position", () => {
    const parts = splitContextLinks("Read docs/plan.md#intro then open http://localhost:3000/app and https://[::1]:8443/x plus ./notes.markdown");
    assert.deepEqual(parts, [
      { type: "text", text: "Read " },
      { type: "markdown", text: "docs/plan.md#intro" },
      { type: "text", text: " then open " },
      { type: "local", text: "http://localhost:3000/app" },
      { type: "text", text: " and " },
      { type: "local", text: "https://[::1]:8443/x" },
      { type: "text", text: " plus " },
      { type: "markdown", text: "./notes.markdown" },
    ]);
    assert.deepEqual(splitContextLinks(""), [{ type: "text", text: "" }]);
    assert.deepEqual(splitContextLinks(null), [{ type: "text", text: "" }]);
    assert.deepEqual(splitContextLinks("nothing here"), [{ type: "text", text: "nothing here" }]);
  });

  test("Markdown paths resolve relative to the current file and never escape the repository", () => {
    assert.equal(resolveMarkdownPath("docs/guide/start.md", "../api.md"), "docs/api.md");
    assert.equal(resolveMarkdownPath("docs/guide/start.md", "./sibling.md#section"), "docs/guide/sibling.md");
    assert.equal(resolveMarkdownPath("docs/guide/start.md", "/README.md"), "README.md");
    assert.equal(resolveMarkdownPath("docs/guide/start.md", "sub\\deep.markdown"), "docs/guide/sub/deep.markdown");
    assert.equal(resolveMarkdownPath("README.md", "../../secret.md"), null);
    assert.equal(resolveMarkdownPath("README.md", "script.js"), null);
    assert.equal(resolveMarkdownPath("README.md", ""), null);
    assert.equal(resolveMarkdownPath(undefined, "Space%20Doc.md"), "Space Doc.md");
  });

  test("asset paths accept images only and keep their original extension", () => {
    assert.equal(resolveAssetPath("docs/guide.md", "../assets/flow.png"), "assets/flow.png");
    assert.equal(resolveAssetPath("docs/guide.md", "shot.JPEG?raw=1#x"), "docs/shot.JPEG");
    assert.equal(resolveAssetPath("docs/guide.md", "anim.gif"), "docs/anim.gif");
    assert.equal(resolveAssetPath("docs/guide.md", "photo.webp"), "docs/photo.webp");
    assert.equal(resolveAssetPath("docs/guide.md", "../../out.png"), null);
    assert.equal(resolveAssetPath("docs/guide.md", "archive.zip"), null);
    assert.equal(resolveAssetPath("docs/guide.md", ""), null);
  });
});

describe("terminal follow", () => {
  test("detects the follow zone near the terminal bottom with a configurable threshold", () => {
    assert.equal(isNearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 }), true);
    assert.equal(isNearBottom({ scrollTop: 830, scrollHeight: 1000, clientHeight: 100 }), true);
    assert.equal(isNearBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 100 }), false);
    assert.equal(isNearBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 100 }, 400), true);
  });

  test("only unchanged content keeps a quiet state; readers away from the bottom get an unseen marker", () => {
    assert.deepEqual(nextFollowState({ initial: true, following: false, contentChanged: false }), { scroll: true, unseen: false });
    assert.deepEqual(nextFollowState({ initial: false, following: true, contentChanged: false }), { scroll: false, unseen: false });
    assert.deepEqual(nextFollowState({ initial: false, following: false, contentChanged: true }), { scroll: false, unseen: true });
    assert.deepEqual(nextFollowState({ initial: false, following: true, contentChanged: true }), { scroll: true, unseen: false });
  });
});

describe("terminal grid normalization", () => {
  test("rejects anything that is not a cmux render grid", () => {
    assert.equal(normalizeRenderGrid(null), null);
    assert.equal(normalizeRenderGrid("grid"), null);
    assert.equal(normalizeRenderGrid({ format: "other" }), null);
  });

  test("clamps dimensions, drops malformed spans and styles, and normalizes the cursor", () => {
    const grid = normalizeRenderGrid({
      format: "cmux.render-grid.v1", columns: 5000, rows: "abc", scrollback_rows: -4,
      styles: [{ id: 0 }, null, "bad", { id: "x" }],
      row_spans: [
        { row: 1, column: 2, cell_width: 999, style_id: 7, text: "wide" },
        { row: 1, column: 2, cell_width: 0, style_id: 0, text: "empty" },
        { row: -1, column: 0, cell_width: 1, style_id: 0, text: "above" },
        { row: 0, column: 2000, cell_width: 1, style_id: 0, text: "right" },
        { row: 0, column: 0, cell_width: 1, style_id: 0, text: 42 },
        null,
        { row: 0, column: 0, cell_width: 1, style_id: "nope", text: "x".repeat(9000) },
      ],
      scrollback_spans: "not an array",
      cursor: { row: 500, column: -3, visible: "yes", blinking: true, style: "weird" },
    });
    assert.equal(grid.columns, 1000);
    assert.equal(grid.rows, 24);
    assert.equal(grid.scrollback_rows, 0);
    assert.deepEqual(grid.styles, [{ id: 0 }]);
    assert.deepEqual(grid.row_spans, [
      { row: 1, column: 2, cell_width: 998, style_id: 7, text: "wide" },
      { row: 0, column: 0, cell_width: 1, style_id: 0, text: "x".repeat(8000) },
    ]);
    assert.deepEqual(grid.scrollback_spans, []);
    assert.deepEqual(grid.cursor, { row: 23, column: 0, visible: false, blinking: true, style: "block" });
    assert.equal(normalizeRenderGrid({ format: "cmux.render-grid.v1", cursor: "none" }).cursor, null);
    assert.equal(normalizeRenderGrid({ format: "cmux.render-grid.v1" }).styles.length, 0);
  });

  test("signatures reflect content, styles and cursor rather than identity", () => {
    const make = (extra = {}) => ({ mode: "grid", render_grid: { columns: 2, rows: 1, scrollback_rows: 0, styles: [{ id: 0, bold: true }], row_spans: [{ row: 0, column: 0, cell_width: 2, style_id: 0, text: "ok" }], scrollback_spans: [], cursor: { row: 0, column: 1, visible: true }, ...extra } });
    assert.equal(terminalViewSignature(make()), terminalViewSignature(make()));
    assert.notEqual(terminalViewSignature(make()), terminalViewSignature(make({ cursor: { row: 0, column: 0, visible: true } })));
    assert.notEqual(terminalViewSignature(make()), terminalViewSignature(make({ styles: [{ id: 0, bold: false }] })));
    assert.equal(terminalViewSignature(null), "empty");
    assert.equal(terminalViewSignature({ mode: "text", text: "hello" }), "text:hello");
    assert.equal(terminalViewSignature({ mode: "text" }), "text:");
    assert.equal(terminalViewSignature({ mode: "grid" }), "grid:missing");
    assert.match(terminalViewSignature({ mode: "grid", render_grid: {} }), /^grid:\d+$/);
  });

  test("accepts hex and rgb colors without allowing arbitrary CSS", () => {
    assert.equal(safeTerminalColor("#aabbcc", "black"), "#aabbcc");
    assert.equal(safeTerminalColor("#aabbccdd", "black"), "#aabbccdd");
    assert.equal(safeTerminalColor("rgb(1, 2, 3)", "black"), "rgb(1, 2, 3)");
    assert.equal(safeTerminalColor("url(evil)", "black"), "black");
    assert.equal(safeTerminalColor(12, "black"), "black");
    assert.equal(safeTerminalColor(undefined, "black"), "black");
  });

  test("locates native composers only in the tail of a tall enough grid", () => {
    assert.equal(nativeComposerStartRow(null), 0);
    assert.equal(nativeComposerStartRow({ rows: 3, row_spans: [] }), 3);
    assert.equal(nativeComposerStartRow({ rows: 10 }), 10);
    const codex = { rows: 18, row_spans: [{ row: 15, text: "› Ask Codex to do anything" }, { row: 17, text: "  gpt-5.6-sol high · ~/repo" }, { row: 40, text: "ignored" }, null] };
    assert.equal(nativeComposerStartRow(codex), 14);
    const codexModelOnly = { rows: 18, row_spans: [{ row: 16, text: "›" }, { row: 17, text: "  gpt-5.6-sol high" }] };
    assert.equal(nativeComposerStartRow(codexModelOnly), 14);
    const claudeFramed = { rows: 18, row_spans: [{ row: 10, text: "──────────────────────────" }, { row: 11, text: "❯ go with 3" }, { row: 12, text: "──────────────────────────" }] };
    assert.equal(nativeComposerStartRow(claudeFramed), 10);
    const claudeTail = { rows: 18, row_spans: [{ row: 16, text: "> " }, { row: 17, text: "Claude Code v2" }] };
    assert.equal(nativeComposerStartRow(claudeTail), 14);
    assert.equal(nativeComposerStartRow({ rows: 18, row_spans: [{ row: 17, text: "$ ready" }] }), 18);
    assert.equal(nativeComposerStartRow({ rows: 18, row_spans: [{ row: 17, text: "Claude Code without a prompt" }] }), 18);
  });

  test("strips the native composer from plain text and trims trailing blank lines", () => {
    assert.equal(withoutNativeComposer("result\n\n› Ask Codex to do anything\n\n  gpt-5.6-sol high · ~/repo"), "result");
    assert.equal(withoutNativeComposer("just output"), "just output");
    assert.equal(withoutNativeComposer(""), "");
    assert.equal(withoutNativeComposer(null), "");
  });
});

describe("small helpers", () => {
  test("relative time buckets ages into minutes, hours and days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T12:00:00.000Z"));
    const now = Date.now() / 1000;
    assert.equal(relativeTime(undefined), "now");
    assert.equal(relativeTime(Number.NaN), "now");
    assert.equal(relativeTime(now + 500), "now");
    assert.equal(relativeTime(now - 30), "now");
    assert.equal(relativeTime(now - 90), "1m");
    assert.equal(relativeTime(now - 7_200), "2h");
    assert.equal(relativeTime(now - 3 * 86_400), "3d");
  });

  test("image upload sessions track generation so stale uploads can be dropped", () => {
    const session = new ImageUploadSession("terminal-1");
    assert.equal(session.key, "terminal-1");
    session.activate();
    assert.equal(session.active, true);
    const generation = session.reserve(2);
    assert.equal(generation, 0);
    assert.equal(session.pending, 2);
    const image = { path: "/tmp/a.png", name: "a.png", mime: "image/png", size: 1, preview: "" };
    session.finish(2, [image, { ...image, path: "/tmp/b.png" }]);
    assert.equal(session.pending, 0);
    assert.deepEqual(session.images.map((item) => item.path), ["/tmp/a.png", "/tmp/b.png"]);
    session.remove("/tmp/a.png");
    assert.deepEqual(session.images.map((item) => item.path), ["/tmp/b.png"]);
    session.deactivate();
    assert.equal(session.active, false);
    assert.equal(session.reserve(1), 1);
    session.clear();
    assert.equal(session.generation, 2);
    assert.equal(session.pending, 0);
    assert.deepEqual(session.images, []);
  });
});
