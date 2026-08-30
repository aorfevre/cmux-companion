import assert from "node:assert/strict";
import test from "node:test";
import { localUrlPort, resolveAssetPath, resolveMarkdownPath, splitContextLinks, terminalContext } from "../app/context-links.mjs";

test("finds Markdown and localhost links in terminal output", () => {
  const parts = splitContextLinks("Read docs/plan.md then open http://localhost:3000/app");
  assert.deepEqual(parts.filter((item) => item.type !== "text"), [
    { type: "markdown", text: "docs/plan.md" }, { type: "local", text: "http://localhost:3000/app" },
  ]);
  assert.deepEqual(terminalContext({ mode: "text", text: "README.md\nhttp://127.0.0.1:5173" }), { markdown: ["README.md"], urls: ["http://127.0.0.1:5173"] });
  assert.equal(localUrlPort("https://localhost:4443"), 4443);
  assert.equal(localUrlPort("https://example.com:4443"), null);
});

test("resolves only repository-relative Markdown and image links", () => {
  assert.equal(resolveMarkdownPath("docs/guide/start.md", "../api.md"), "docs/api.md");
  assert.equal(resolveMarkdownPath("README.md", "../../secret.md"), null);
  assert.equal(resolveMarkdownPath("README.md", "script.js"), null);
  assert.equal(resolveAssetPath("docs/guide.md", "../assets/flow.png"), "assets/flow.png");
});

