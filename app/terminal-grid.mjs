const MAX_COLUMNS = 1_000;
const MAX_ROWS = 500;
const MAX_SCROLLBACK_ROWS = 2_000;

function integer(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
}

function normalizeSpan(span, columns, rowLimit) {
  if (!span || typeof span !== "object" || typeof span.text !== "string") return null;
  const row = integer(span.row, -1, -1, rowLimit);
  const column = integer(span.column, -1, -1, columns);
  if (row < 0 || row >= rowLimit || column < 0 || column >= columns) return null;
  const cellWidth = integer(span.cell_width, 0, 0, columns - column);
  if (cellWidth < 1) return null;
  return {
    row,
    column,
    cell_width: cellWidth,
    style_id: integer(span.style_id, 0, 0, 100_000),
    text: span.text.slice(0, 8_000),
  };
}

export function normalizeRenderGrid(value) {
  if (!value || typeof value !== "object" || value.format !== "cmux.render-grid.v1") return null;
  const columns = integer(value.columns, 80, 1, MAX_COLUMNS);
  const rows = integer(value.rows, 24, 1, MAX_ROWS);
  const scrollbackRows = integer(value.scrollback_rows, 0, 0, MAX_SCROLLBACK_ROWS);
  const styles = Array.isArray(value.styles)
    ? value.styles.filter((style) => style && typeof style === "object" && Number.isInteger(Number(style.id))).slice(0, 10_000)
    : [];
  const rowSpans = Array.isArray(value.row_spans)
    ? value.row_spans.map((span) => normalizeSpan(span, columns, rows)).filter(Boolean)
    : [];
  const scrollbackSpans = Array.isArray(value.scrollback_spans)
    ? value.scrollback_spans.map((span) => normalizeSpan(span, columns, scrollbackRows)).filter(Boolean)
    : [];
  const cursor = value.cursor && typeof value.cursor === "object" ? {
    row: integer(value.cursor.row, 0, 0, rows - 1),
    column: integer(value.cursor.column, 0, 0, columns - 1),
    visible: value.cursor.visible === true,
    blinking: value.cursor.blinking === true,
    style: ["block", "bar", "underline", "block_hollow"].includes(value.cursor.style) ? value.cursor.style : "block",
  } : null;
  return {
    ...value,
    columns,
    rows,
    scrollback_rows: scrollbackRows,
    styles,
    row_spans: rowSpans,
    scrollback_spans: scrollbackSpans,
    cursor,
  };
}

export function terminalViewSignature(view) {
  if (!view) return "empty";
  if (view.mode === "text") return `text:${view.text || ""}`;
  const grid = view.render_grid;
  if (!grid) return "grid:missing";
  let hash = 2166136261;
  const add = (value) => {
    const text = String(value ?? "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  };
  add(grid.columns); add(grid.rows); add(grid.scrollback_rows);
  add(grid.terminal_foreground); add(grid.terminal_background); add(grid.terminal_cursor_color);
  for (const style of grid.styles || []) {
    add(style.id); add(style.foreground); add(style.background); add(style.bold); add(style.faint);
    add(style.italic); add(style.underline); add(style.blink); add(style.inverse); add(style.invisible);
    add(style.strikethrough); add(style.overline);
  }
  for (const span of [...(grid.scrollback_spans || []), ...(grid.row_spans || [])]) {
    add(span.row); add(span.column); add(span.cell_width); add(span.style_id); add(span.text);
  }
  add(grid.cursor?.row); add(grid.cursor?.column); add(grid.cursor?.visible);
  return `grid:${hash >>> 0}`;
}

export function safeTerminalColor(value, fallback) {
  return typeof value === "string" && /^(#[0-9a-f]{6}|#[0-9a-f]{8}|rgb\(\d{1,3},\s*\d{1,3},\s*\d{1,3}\))$/i.test(value)
    ? value
    : fallback;
}

export function nativeComposerStartRow(grid) {
  if (!grid || !Array.isArray(grid.row_spans) || !Number.isInteger(grid.rows) || grid.rows < 4) return grid?.rows || 0;
  const rows = Array.from({ length: grid.rows }, () => "");
  for (const span of grid.row_spans) {
    if (span && Number.isInteger(span.row) && rows[span.row] !== undefined) rows[span.row] += String(span.text || "");
  }
  const firstTailRow = Math.max(0, grid.rows - 12);
  for (let row = firstTailRow; row < grid.rows - 2; row += 1) {
    const top = rows[row].trim(); const prompt = rows[row + 1].trim(); const bottom = rows[row + 2].trim();
    if (/^[─━═_-]{10,}$/.test(top) && /^[❯›>]/.test(prompt) && /^[─━═_-]{10,}$/.test(bottom)) return row;
  }
  const tail = rows.slice(-5).join("\n");
  const hasCodexComposer = /Ask Codex to do anything/i.test(tail)
    || (/\bgpt-[a-z0-9._-]+\b/i.test(tail) && /(?:^|\n)\s*›/m.test(tail));
  const hasClaudeComposer = /Claude Code/i.test(tail) && /(?:^|\n)\s*[❯>]/m.test(tail);
  return hasCodexComposer || hasClaudeComposer ? Math.max(0, grid.rows - 4) : grid.rows;
}

export function withoutNativeComposer(text) {
  const lines = String(text || "").split("\n");
  const start = nativeComposerStartRow({
    rows: lines.length,
    row_spans: lines.map((line, row) => ({ row, text: line })),
  });
  return lines.slice(0, start).join("\n").replace(/\n+$/, "");
}
