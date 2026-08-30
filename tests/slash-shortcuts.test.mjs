import assert from "node:assert/strict";
import test from "node:test";
import { slashShortcuts, SHORTCUTS } from "../app/slash-shortcuts.mjs";

test("lists useful coding-agent slash shortcuts with provider labels", () => {
  assert.ok(SHORTCUTS.some((item) => item.command === "/review" && item.agents.includes("Codex")));
  assert.ok(SHORTCUTS.some((item) => item.command === "/compact" && item.agents.includes("Claude")));
  assert.ok(SHORTCUTS.every((item) => item.command.startsWith("/") && item.description));
});

test("filters slash shortcuts from the current composer draft", () => {
  assert.deepEqual(slashShortcuts("/rev").map((item) => item.command), ["/review"]);
  assert.ok(slashShortcuts("/").length > 8);
  assert.equal(slashShortcuts("/not-a-command").length, 0);
});
