"use client";

import { CSSProperties, useMemo } from "react";
import { nativeComposerStartRow, normalizeRenderGrid, safeTerminalColor } from "./terminal-grid.mjs";

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

export function TerminalGrid({ view, hideNativeComposer = false }: { view: TerminalView | null; hideNativeComposer?: boolean }) {
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
    return <pre className="terminal-fallback">{view.mode === "text" ? view.text || "No terminal output yet." : "Terminal replay is unavailable."}</pre>;
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
    width: `${grid.columns}ch`,
  } as CSSProperties;

  return (
    <div className="terminal-grid" style={rootStyle} role="log" aria-label="Terminal output">
      {allRows.map((spans, rowIndex) => (
        <div className="terminal-grid-row" key={rowIndex}>
          {spans.map((span, spanIndex) => (
            <span
              className={model.styles.get(span.style_id)?.blink ? "terminal-span blinking" : "terminal-span"}
              key={`${span.column}-${spanIndex}`}
              style={{
                gridColumn: `${span.column + 1} / span ${span.cell_width}`,
                ...spanStyle(model.styles.get(span.style_id), foreground, background),
              }}
            >{span.text}</span>
          ))}
          {grid.cursor?.visible && grid.cursor.row < screenRows.length && rowIndex === cursorRow && (
            <i
              className={`terminal-cursor ${grid.cursor.style}${grid.cursor.blinking ? " blinking" : ""}`}
              style={{ gridColumn: `${grid.cursor.column + 1} / span 1`, borderColor: cursorColor, backgroundColor: cursorColor }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
