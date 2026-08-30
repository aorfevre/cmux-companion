import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRenderGrid, safeTerminalColor, terminalViewSignature } from "../app/terminal-grid.mjs";

test("normalizes a cmux render grid and rejects unsafe spans", () => {
  const grid = normalizeRenderGrid({
    format: "cmux.render-grid.v1",
    columns: 80,
    rows: 24,
    scrollback_rows: 2,
    styles: [{ id: 0, foreground: "#ffffff" }],
    row_spans: [
      { row: 3, column: 4, cell_width: 5, style_id: 0, text: "hello" },
      { row: 99, column: 0, cell_width: 1, style_id: 0, text: "outside" },
    ],
    scrollback_spans: [{ row: 1, column: 0, cell_width: 2, style_id: 0, text: "ok" }],
    cursor: { row: 3, column: 9, visible: true, blinking: false, style: "bar" },
  });
  assert.equal(grid.columns, 80);
  assert.deepEqual(grid.row_spans.map((span) => span.text), ["hello"]);
  assert.deepEqual(grid.scrollback_spans.map((span) => span.text), ["ok"]);
  assert.equal(grid.cursor.style, "bar");
});

test("terminal signatures change with rendered content but not object identity", () => {
  const make = (text) => ({ mode: "grid", render_grid: { columns: 2, rows: 1, scrollback_rows: 0, row_spans: [{ row: 0, column: 0, cell_width: 2, style_id: 0, text }], scrollback_spans: [], cursor: null } });
  assert.equal(terminalViewSignature(make("ok")), terminalViewSignature(make("ok")));
  assert.notEqual(terminalViewSignature(make("ok")), terminalViewSignature(make("no")));
});

test("accepts terminal colors without allowing arbitrary CSS", () => {
  assert.equal(safeTerminalColor("#aabbcc", "black"), "#aabbcc");
  assert.equal(safeTerminalColor("url(evil)", "black"), "black");
});
