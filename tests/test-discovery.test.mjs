import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import test from "node:test";
import { backendTestFiles } from "../scripts/run-backend-tests.mjs";

test("discovers new deterministic tests without admitting live suites or directories", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "companion-discovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ["new-feature.test.mjs", "a.test.mjs", "cmux.live.mjs", "live-cmux.test.mjs", "installed.live.test.mjs", "ui-feature.test.tsx", "fixture.mjs"]) writeFileSync(join(directory, name), "throw new Error('must not execute during discovery');");
  mkdirSync(join(directory, "directory.test.mjs"));
  assert.deepEqual(backendTestFiles(directory).map((path) => basename(path)), ["a.test.mjs", "new-feature.test.mjs"]);
});

test("repository discovery includes the safety test and excludes every live npm entrypoint", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const selected = backendTestFiles(fileURLToPath(new URL(".", import.meta.url))).map(path => basename(path));
  assert.ok(selected.includes("test-discovery.test.mjs"));
  for (const name of Object.keys(manifest.scripts).filter(name => name.startsWith("test:") && name.includes("live"))) {
    const file = manifest.scripts[name].split(" ").at(-1);
    assert.ok(file.endsWith(".live.mjs"), `${name} must use the live naming convention`);
    assert.ok(!selected.includes(basename(file)), `${name} must never enter verify`);
  }
});
