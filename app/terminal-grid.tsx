"use client";

import { CSSProperties, useMemo } from "react";
import { splitContextLinks } from "./context-links.mjs";
import { nativeComposerStartRow, normalizeRenderGrid, safeTerminalColor, withoutNativeComposer } from "./terminal-grid.mjs";

type TerminalStyle = {
  id: number;
  foreground?: string;
  background?: string;
  bold?: boolean;
  faint?: boolean;
  italic?: boolean;
  underline?: boolean;
  blink?: boolean;
  inverse?: boolean;
  invisible?: boolean;
  strikethrough?: boolean;
  overline?: boolean;
};

type TerminalSpan = { row: number; column: number; cell_width: number; style_id: number; text: string };
type TerminalCursor = { row: number; column: number; visible: boolean; blinking: boolean; style: string } | null;
type RenderGrid = {
  format: "cmux.render-grid.v1";
  columns: number;
  rows: number;
  scrollback_rows: number;
  styles: TerminalStyle[];
  row_spans: TerminalSpan[];
  scrollback_spans: TerminalSpan[];
  cursor: TerminalCursor;
  terminal_foreground?: string;
  terminal_background?: string;
  terminal_cursor_color?: string;
};

export type TerminalView = {
  mode: "grid";
  render_grid: RenderGrid;
  surface_id?: string;
  seq?: number;
} | {
  mode: "text";
  text: string;
  lines?: number;
  surface_id?: string;
};

function groupedRows(spans: TerminalSpan[], count: number) {
  const rows = Array.from({ length: count }, () => [] as TerminalSpan[]);
  for (const span of spans) rows[span.row]?.push(span);
  return rows;
}

function reflowChunks(spans: TerminalSpan[]) {
  const ordered = [...spans].sort((left, right) => left.column - right.column);
  let last = -1;
  for (let index = 0; index < ordered.length; index += 1) if (ordered[index].text.trim()) last = index;
  if (last < 0) return [];
  const chunks: Array<{ gap: string; span: TerminalSpan; text: string }> = [];
  let column = 0;
  for (let index = 0; index <= last; index += 1) {
    const span = ordered[index];
    const gapWidth = Math.min(8, Math.max(0, span.column - column));
    const text = (index === last ? span.text.trimEnd() : span.text).replace(/ {9,}/g, "        ");
    chunks.push({ gap: " ".repeat(gapWidth), span, text });
    column = Math.max(column, span.column + span.cell_width);
  }
  return chunks;
}

function spanStyle(style: TerminalStyle | undefined, foreground: string, background: string): CSSProperties {
  let color = safeTerminalColor(style?.foreground, foreground);
  let fill = safeTerminalColor(style?.background, background);
  if (style?.inverse) [color, fill] = [fill, color];
  const decorations = [style?.underline && "underline", style?.strikethrough && "line-through", style?.overline && "overline"].filter(Boolean).join(" ");
  return {
    color: style?.invisible ? "transparent" : color,
    backgroundColor: fill,
    fontWeight: style?.bold ? 700 : undefined,
    fontStyle: style?.italic ? "italic" : undefined,
    opacity: style?.faint ? 0.58 : undefined,
    textDecoration: decorations || undefined,
  };
}

export function TerminalGrid({ view, hideNativeComposer = false, reflow = false, onMarkdownLink, onLocalUrl }: { view: TerminalView | null; hideNativeComposer?: boolean; reflow?: boolean; onMarkdownLink?: (path: string) => void; onLocalUrl?: (url: string) => void }) {
  const grid = useMemo(() => view?.mode === "grid" ? normalizeRenderGrid(view.render_grid) as RenderGrid | null : null, [view]);
  const model = useMemo(() => {
    if (!grid) return null;
    const styles = new Map(grid.styles.map((style) => [Number(style.id), style]));
    return {
      styles,
      scrollback: groupedRows(grid.scrollback_spans, grid.scrollback_rows),
      screen: groupedRows(grid.row_spans, grid.rows),
    };
  }, [grid]);

  if (!view) return <div className="terminal-loading">Reading terminal…</div>;
  if (view.mode === "text" || !grid || !model) {
    const rawText = view.mode === "text" ? view.text || "No terminal output yet." : "Terminal replay is unavailable.";
    const text = hideNativeComposer ? withoutNativeComposer(rawText) : rawText;
    return <pre className="terminal-fallback">{renderContextText(text, onMarkdownLink, onLocalUrl)}</pre>;
  }

  const foreground = safeTerminalColor(grid.terminal_foreground, "#f2f2f2");
  const background = safeTerminalColor(grid.terminal_background, "#050607");
  const cursorColor = safeTerminalColor(grid.terminal_cursor_color, foreground);
  const screenRows = hideNativeComposer ? model.screen.slice(0, nativeComposerStartRow(grid)) : model.screen;
  const allRows = [...model.scrollback, ...screenRows];
  const cursorRow = grid.scrollback_rows + (grid.cursor?.row || 0);
  const rootStyle = {
    "--terminal-columns": grid.columns,
    "--terminal-foreground": foreground,
    "--terminal-background": background,
    width: reflow ? "100%" : `${grid.columns}ch`,
  } as CSSProperties;

  return (
    <div className={`terminal-grid${reflow ? " reflow" : ""}`} style={rootStyle} role="log" aria-label="Terminal output">
      {allRows.map((spans, rowIndex) => {
        const chunks = reflow ? reflowChunks(spans) : [];
        const decorative = reflow && chunks.length > 0 && /^[─━═_\s-]+$/.test(chunks.map((chunk) => `${chunk.gap}${chunk.text}`).join(""));
        return <div className={`terminal-grid-row${decorative ? " decorative" : ""}`} key={rowIndex}>
          {reflow ? chunks.map((chunk, spanIndex) => (
            <span className={model.styles.get(chunk.span.style_id)?.blink ? "terminal-span blinking" : "terminal-span"} key={`${chunk.span.column}-${spanIndex}`} style={spanStyle(model.styles.get(chunk.span.style_id), foreground, background)}>{chunk.gap}{renderContextText(chunk.text, onMarkdownLink, onLocalUrl)}</span>
          )) : spans.map((span, spanIndex) => (
            <span
              className={model.styles.get(span.style_id)?.blink ? "terminal-span blinking" : "terminal-span"}
              key={`${span.column}-${spanIndex}`}
              style={{
                gridColumn: `${span.column + 1} / span ${span.cell_width}`,
                ...spanStyle(model.styles.get(span.style_id), foreground, background),
              }}
            >{renderContextText(span.text, onMarkdownLink, onLocalUrl)}</span>
          ))}
          {!reflow && grid.cursor?.visible && grid.cursor.row < screenRows.length && rowIndex === cursorRow && (
            <i
              className={`terminal-cursor ${grid.cursor.style}${grid.cursor.blinking ? " blinking" : ""}`}
              style={{ gridColumn: `${grid.cursor.column + 1} / span 1`, borderColor: cursorColor, backgroundColor: cursorColor }}
            />
          )}
        </div>;
      })}
    </div>
  );
}

function renderContextText(text: string, onMarkdownLink?: (path: string) => void, onLocalUrl?: (url: string) => void) {
  return splitContextLinks(text).map((part: { type: string; text: string }, index: number) => {
    if (part.type === "markdown" && onMarkdownLink) return <button type="button" className="terminal-context-link" onClick={() => onMarkdownLink(part.text)} key={`${index}-${part.text}`}>{part.text}</button>;
    if (part.type === "local" && onLocalUrl) return <button type="button" className="terminal-context-link preview" onClick={() => onLocalUrl(part.text)} key={`${index}-${part.text}`}>{part.text}</button>;
    return part.text;
  });
}
