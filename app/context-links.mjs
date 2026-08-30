const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/[^\s<>'"`)]*)?/gi;
const MARKDOWN_PATH = /(?:\.{0,2}\/|\/)?[a-zA-Z0-9_~.@+-][a-zA-Z0-9_~.@+\-/]*\.(?:md|markdown)(?:#[a-zA-Z0-9_-]+)?/gi;

export function splitContextLinks(text) {
  const source = String(text || "");
  const matches = [
    ...[...source.matchAll(LOCAL_URL)].map((match) => ({ index: match.index, text: match[0], type: "local" })),
    ...[...source.matchAll(MARKDOWN_PATH)].map((match) => ({ index: match.index, text: match[0], type: "markdown" })),
  ].sort((left, right) => left.index - right.index || right.text.length - left.text.length);
  const parts = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index < cursor) continue;
    if (match.index > cursor) parts.push({ type: "text", text: source.slice(cursor, match.index) });
    parts.push({ type: match.type, text: match.text });
    cursor = match.index + match.text.length;
  }
  if (cursor < source.length) parts.push({ type: "text", text: source.slice(cursor) });
  return parts.length ? parts : [{ type: "text", text: source }];
}

export function terminalContext(view) {
  const text = terminalText(view);
  const markdown = []; const urls = [];
  for (const part of splitContextLinks(text)) {
    if (part.type === "markdown" && !markdown.includes(part.text)) markdown.push(part.text);
    if (part.type === "local" && !urls.includes(part.text)) urls.push(part.text);
  }
  return { markdown: markdown.slice(0, 20), urls: urls.slice(0, 12) };
}

export function localUrlPort(value) {
  try {
    const url = new URL(value);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch { return null; }
}

export function resolveMarkdownPath(currentFile, href) {
  const clean = decodeURIComponent(String(href || "").split("#")[0]).replaceAll("\\", "/");
  if (!/\.(?:md|markdown)$/i.test(clean)) return null;
  const base = clean.startsWith("/") ? [] : String(currentFile || "").split("/").slice(0, -1);
  const parts = [...base, ...clean.split("/")]; const resolved = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!resolved.length) return null; resolved.pop(); }
    else resolved.push(part);
  }
  return resolved.join("/");
}

export function resolveAssetPath(currentFile, src) {
  const clean = decodeURIComponent(String(src || "").split(/[?#]/)[0]).replaceAll("\\", "/");
  if (!/\.(?:png|jpe?g|gif|webp)$/i.test(clean)) return null;
  const synthetic = resolveMarkdownPath(currentFile, clean.replace(/\.(png|jpe?g|gif|webp)$/i, ".md"));
  return synthetic?.replace(/\.md$/i, clean.match(/\.(png|jpe?g|gif|webp)$/i)[0]) || null;
}

function terminalText(view) {
  if (!view) return "";
  if (view.mode === "text") return view.text || "";
  const grid = view.render_grid;
  if (!grid) return "";
  const rows = Array.from({ length: Number(grid.scrollback_rows || 0) + Number(grid.rows || 0) }, () => []);
  for (const span of grid.scrollback_spans || []) rows[span.row]?.push(span);
  for (const span of grid.row_spans || []) rows[Number(grid.scrollback_rows || 0) + span.row]?.push(span);
  return rows.map((spans) => spans.sort((a, b) => a.column - b.column).map((span) => span.text).join("")).join("\n");
}

