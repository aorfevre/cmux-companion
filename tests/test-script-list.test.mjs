import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { posix } from "node:path";
import test from "node:test";

// This test needs real cmux and must remain an explicit opt-in.
const exclusions = new Set(["tests/live-cmux.test.mjs"]);
const normalize = (path) => posix.normalize(path.replaceAll("\\", "/"));

test("the default test script lists every top-level server test", async () => {
  const root = new URL("../", import.meta.url);
  const { scripts } = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.ok(scripts.test.startsWith("node --test "), 'package.json test script must start with "node --test "');
  const listed = [...new Set(scripts.test.slice("node --test ".length).trim().split(/\s+/).map(normalize))].sort();
  const discovered = (await readdir(new URL("tests/", root), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => normalize(`tests/${entry.name}`)).sort();
  const missing = discovered.filter((path) => !exclusions.has(path) && !listed.includes(path));
  assert.deepEqual(missing, [], `Missing test paths: ${missing.join(", ")}. Add them to the test script in package.json.`);
});
