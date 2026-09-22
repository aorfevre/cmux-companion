import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRemote, retryDelayMs, validateSha } from "../src/config.mjs";
import { atomicWrite, isPathInside, readJson, sha256, writeJson } from "../src/fs-safe.mjs";
import { acquireLock } from "../src/lock.mjs";
import { redact } from "../src/process.mjs";
import { deploymentNeedsActivation, linkedSha } from "../src/engine.mjs";
import { launchAgentPlist } from "../src/launchd.mjs";
import { defaultPaths } from "../src/constants.mjs";

test("normalizes equivalent GitHub remotes and validates full SHAs", () => {
  assert.equal(normalizeRemote("git@github.com:aorfevre/cmux-companion.git"), "https://github.com/aorfevre/cmux-companion");
  assert.equal(normalizeRemote("https://github.com/aorfevre/cmux-companion.git/"), "https://github.com/aorfevre/cmux-companion");
  assert.equal(validateSha("a".repeat(40)), "a".repeat(40));
  assert.throws(() => validateSha("main"), /40-character/);
});

test("caps network retry backoff at five minutes", () => {
  assert.deepEqual([1, 2, 3, 4, 20].map(retryDelayMs), [30_000, 60_000, 120_000, 300_000, 300_000]);
});

test("path containment rejects siblings and traversal", () => {
  assert.equal(isPathInside("/safe/releases", "/safe/releases/abc"), true);
  assert.equal(isPathInside("/safe/releases", "/safe/releases-evil/abc"), false);
  assert.equal(isPathInside("/safe/releases", "/safe/releases/../token"), false);
});

test("atomic JSON persistence and hashing are deterministic", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmux-updater-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state.json");
  await writeJson(path, { sha: "a".repeat(40) });
  assert.equal((await readJson(path)).sha, "a".repeat(40));
  assert.equal(await sha256(path), await sha256(path));
  await atomicWrite(path, "replacement\n");
  assert.equal(await readFile(path, "utf8"), "replacement\n");
});

test("lock rejects a live owner and releases cleanly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmux-updater-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, "lock");
  const release = await acquireLock(lock);
  assert.equal(typeof release, "function");
  assert.equal(await acquireLock(lock), null);
  await release();
  const next = await acquireLock(lock);
  assert.equal(typeof next, "function");
  await next();
});

test("redacts credentials from subprocess output", () => {
  const value = redact("https://secret@github.com/x/y token=abc password: hidden");
  assert.doesNotMatch(value, /secret|abc|hidden/);
});

test("a missing deployed release requires activation even when its SHA is unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmux-updater-dangling-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sha = "a".repeat(40);
  await mkdir(join(root, "releases"));
  await symlink(`releases/${sha}`, join(root, "current"));
  const target = { releaseRoot: root };
  assert.equal(await linkedSha(target), null);
  assert.equal(deploymentNeedsActivation(sha, sha, null, null), true);
  await mkdir(join(root, "releases", sha));
  assert.equal(await linkedSha(target), sha);
  assert.equal(deploymentNeedsActivation(sha, sha, sha, null), false);
  assert.equal(deploymentNeedsActivation(sha, sha, null, sha), false);
});

test("launch agents keep the updater persistent and restart the companion only after failure", () => {
  const common = { program: ["/path/with &/program"], out: "/tmp/out", error: "/tmp/error" };
  const updater = launchAgentPlist({ ...common, label: "updater", persistent: true, throttleSeconds: 30 });
  assert.match(updater, /<key>KeepAlive<\/key><true\/>/);
  assert.match(updater, /<key>ThrottleInterval<\/key><integer>30<\/integer>/);
  assert.doesNotMatch(updater, /StartInterval/);
  assert.match(updater, /\/path\/with &amp;\/program/);

  const companion = launchAgentPlist({ ...common, label: "companion", keepAlive: true });
  assert.match(companion, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.doesNotMatch(companion, /ThrottleInterval|StartInterval/);
});

test("the persistent updater runner starts more than one bootstrap cycle", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "cmux-updater-runner-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = defaultPaths(home);
  const counter = join(home, "cycles");
  await mkdir(paths.libexec, { recursive: true });
  await writeFile(paths.bootstrap, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.env.CMUX_TEST_COUNTER, "x");\n`);
  await chmod(paths.bootstrap, 0o700);
  await writeJson(paths.config, { pollSeconds: 0.02 });

  const child = spawn(process.execPath, [new URL("../scripts/launch-updater.mjs", import.meta.url).pathname], {
    env: { ...process.env, HOME: home, CMUX_COMPANION_HOME: home, CMUX_TEST_COUNTER: counter },
    stdio: "ignore",
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  const deadline = Date.now() + 7000;
  let cycles = "";
  while (Date.now() < deadline) {
    try { cycles = await readFile(counter, "utf8"); } catch { /* Optional file is not available. */ }
    if (cycles.length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(cycles.length >= 2, `expected at least two cycles, received ${cycles.length}`);
  child.kill("SIGTERM");
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
});

test('stale locks retain unknown launch claims and live orphan engines, but reclaim dead spawn claims', async t => {
  const root = await mkdtemp(join(tmpdir(), 'updater-orphan-lock-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, 'lock'); await mkdir(lock);
  assert.equal(await acquireLock(lock, { now: Date.now() + 3600000 }), null);
  await writeJson(join(lock, 'owner.json'), { pid: 2147483646, spawnClaim: true });
  assert.equal(await acquireLock(lock, { now: Date.now() }), null, 'a fresh spawn claim is protected');
  const release = await acquireLock(lock, { now: Date.now() + 3600000 });
  assert.equal(typeof release, 'function', 'a stale spawn claim with a dead owner is an orphan'); await release(); await mkdir(lock);
  await writeJson(join(lock, 'owner.json'), { pid: 2147483646, spawnClaim: true, enginePid: process.pid });
  assert.equal(await acquireLock(lock, { now: Date.now() + 3600000 }), null);
});
