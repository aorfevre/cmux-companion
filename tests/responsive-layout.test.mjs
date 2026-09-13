import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("desktop layout expands beyond the mobile shell without changing mobile defaults", async () => {
  const css = await readFile(new URL("../app/features.css", import.meta.url), "utf8");
  const desktop = css.match(/@media\(min-width:1024px\)\{([\s\S]*)\}\s*$/)?.[1] || "";
  assert.match(desktop, /\.app-shell\{[^}]*1500px[^}]*padding:0 0 0 216px/);
  assert.match(desktop, /\.bottom-nav\{[^}]*width:216px[^}]*height:100dvh[^}]*flex-direction:column/);
  assert.match(desktop, /\.hero\{[^}]*grid-template-columns:/);
  assert.match(desktop, /\.workspace-list,\.preview-list,\.inbox-list,\.repo-list\{[^}]*auto-fit/);
  assert.match(desktop, /\.usage-providers\{[^}]*repeat\(2/);
  assert.match(desktop, /\.document-shell,\.detail-shell\{[^}]*1500px/);
  assert.match(desktop, /\.session-menu,\.queue-sheet,\.reconnect-sheet\{[^}]*top:50%/);
});
