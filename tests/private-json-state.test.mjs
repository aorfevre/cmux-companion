import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrivateJson } from "../server/private-json-state.mjs";
import { RepositoryFavorites } from "../server/repository-favorites.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "companion-json-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, "state.json") };
}

test("invalid bytes and invalid shapes are preserved privately before recovery", t => {
  const { path } = fixture(t);
  for (const bytes of ['{"truncated":', 'null', '[]']) {
    writeFileSync(path, bytes);
    const backups = [];
    assert.deepEqual(readPrivateJson(path, { items: [] }, undefined, backup => backups.push(backup)), { items: [] });
    assert.equal(readFileSync(backups[0], "utf8"), bytes);
    assert.equal(statSync(backups[0]).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, "utf8"), bytes);
  }
});

test("missing state starts empty but IO errors never become empty state", t => {
  const { path } = fixture(t);
  assert.deepEqual(readPrivateJson(path, { items: [] }), { items: [] });
  mkdirSync(path);
  assert.throws(() => readPrivateJson(path, { items: [] }), { code: "EISDIR" });
});

test("a registry can save and reopen recovered state without losing original evidence", t => {
  const { path, directory } = fixture(t);
  writeFileSync(path, "broken registry");
  const store = new RepositoryFavorites({ path });
  store.set("repository12345678", true);
  assert.equal(new RepositoryFavorites({ path }).has("repository12345678"), true);
  const backup = readdirSync(directory).find(name => name.includes(".corrupt-"));
  assert.equal(readFileSync(join(directory, backup), "utf8"), "broken registry");
});
