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
