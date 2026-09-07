import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { backendTestFiles } from "../scripts/run-backend-tests.mjs";

test("the default test script discovers every deterministic top-level server test", async () => {
  const root = new URL("../", import.meta.url);
  const { scripts } = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(scripts.test, "node scripts/run-backend-tests.mjs");
  const directory = new URL("tests/", root);
  const selected = backendTestFiles(fileURLToPath(directory)).map(path => basename(path));
  const discovered = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(".test.mjs") && !/(^|[.-])live([.-]|$)/i.test(entry.name))
    .map(entry => entry.name).sort();
  assert.deepEqual(selected, discovered);
});
