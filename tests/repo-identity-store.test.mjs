import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openRepoIdentityStore, RepoIdentityStore } from "../server/repo-identity-store.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

function memory() {
  return new RepoIdentityStore({ path: ":memory:" });
}

test("remembers a commit time and answers it back", () => {
  const store = memory();
  assert.equal(store.commitTime(SHA), null, "an unknown commit must not answer");
  store.rememberCommitTimes([{ sha: SHA, commitTime: 1_700_000_000 }]);
  assert.equal(store.commitTime(SHA), 1_700_000_000);
  store.close();
});

// A commit's time is part of what its sha hashes, so the sha is the whole key.
// Anything that is not a sha must never become one.
test("refuses anything that is not a commit sha", () => {
  const store = memory();
  store.rememberCommitTimes([
    { sha: "(initial)", commitTime: 1 },
    { sha: "", commitTime: 1 },
    { sha: SHA.toUpperCase(), commitTime: 1 },
    { sha: "abc", commitTime: 1 },
  ]);
  for (const key of ["(initial)", "", SHA.toUpperCase(), "abc", null, undefined]) {
    assert.equal(store.commitTime(key), null);
  }
  store.close();
});

test("refuses a commit time that is not a usable number", () => {
  const store = memory();
  store.rememberCommitTimes([
    { sha: SHA, commitTime: 0 },
    { sha: OTHER, commitTime: Number.NaN },
  ]);
  assert.equal(store.commitTime(SHA), null);
  assert.equal(store.commitTime(OTHER), null);
  store.close();
});

test("a stored commit time survives a new process", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-repo-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "identity.db");

  const first = new RepoIdentityStore({ path });
  first.rememberCommitTimes([{ sha: SHA, commitTime: 1_700_000_000 }]);
  first.close();

  const second = new RepoIdentityStore({ path });
  assert.equal(second.commitTime(SHA), 1_700_000_000);
  second.close();
});

test("the database file is readable by its owner only", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-repo-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "identity.db");
  const store = new RepoIdentityStore({ path });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  store.close();
});

test("pruning caps the table without losing the newest rows", () => {
  const store = memory();
  const entries = [];
  for (let index = 0; index < 5_100; index += 1) {
    entries.push({ sha: index.toString(16).padStart(40, "0"), commitTime: 1_700_000_000 + index });
  }
  store.rememberCommitTimes(entries);
  store.prune();
  const remaining = store.db.prepare("SELECT COUNT(*) AS count FROM commit_times").get();
  assert.equal(Number(remaining.count), 5_000);
  store.close();
});

// Every failure has to leave the caller running the live git command. None of
// them may throw: the store is an optimisation, never a source of errors.
test("a database that cannot be opened leaves the companion running", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-repo-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "identity.db");
  await writeFile(path, "this is not a database");
  const warnings = [];
  assert.equal(openRepoIdentityStore({ path }, { warn: (...args) => warnings.push(args) }), null);
  assert.equal(warnings.length, 1);
});

test("a store that starts failing answers null rather than throwing", () => {
  const store = memory();
  store.rememberCommitTimes([{ sha: SHA, commitTime: 1_700_000_000 }]);
  store.close();
  // Every later call runs against a closed database.
  assert.equal(store.commitTime(SHA), null);
  assert.equal(store.disabled, true, "one failure must disable the store rather than repeat");
  assert.doesNotThrow(() => store.rememberCommitTimes([{ sha: OTHER, commitTime: 1 }]));
  assert.doesNotThrow(() => store.prune());
});

test("a healthy store opens and reports itself", () => {
  const store = openRepoIdentityStore({ path: ":memory:" });
  assert.ok(store);
  assert.equal(store.disabled, false);
  store.close();
});

// Keep environment mutation inside one synchronous test and restore it even
// when an assertion fails; every store also closes in a finally block.
test("environment status TTL defaults safely and zero disables SQLite status reads and writes", () => {
  const previous = process.env.CMUX_COMPANION_STATUS_TTL_MS;
  try {
    for (const [value, expected] of [[undefined, 30_000], ["", 30_000], [" ", 30_000], ["invalid", 30_000], ["Infinity", 30_000], ["-1", 0], ["123", 123]]) {
      if (value === undefined) delete process.env.CMUX_COMPANION_STATUS_TTL_MS;
      else process.env.CMUX_COMPANION_STATUS_TTL_MS = value;
      const store = memory();
      try { assert.equal(store.statusTtlMs, expected, `environment value: ${value}`); }
      finally { store.close(); }
    }
    process.env.CMUX_COMPANION_STATUS_TTL_MS = "0";
    const store = memory();
    try {
      assert.equal(store.statusTtlMs, 0);
      store.db.prepare("INSERT INTO worktree_status (path, output, last_activity, read_at) VALUES (?, ?, ?, ?)")
        .run("/existing", " M file", 123, Date.now());
      assert.equal(store.status("/existing"), null, "zero must ignore even a fresh stored row");
      store.rememberStatuses([{ path: "/new", output: "?? new" }, { path: "/existing", output: "" }]);
      const rows = store.db.prepare("SELECT path, output FROM worktree_status").all();
      assert.equal(rows.length, 1, "zero must not insert status rows");
      assert.equal(rows[0].output, " M file", "zero must not overwrite status rows");
    } finally { store.close(); }
    const explicit = new RepoIdentityStore({ path: ":memory:", statusTtlMs: 42 });
    try { assert.equal(explicit.statusTtlMs, 42, "explicit constructor values still override the environment"); }
    finally { explicit.close(); }
  } finally {
    if (previous === undefined) delete process.env.CMUX_COMPANION_STATUS_TTL_MS;
    else process.env.CMUX_COMPANION_STATUS_TTL_MS = previous;
  }
});
