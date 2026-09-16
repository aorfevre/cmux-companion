#!/usr/bin/env node
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const home = process.env.CMUX_COMPANION_HOME || process.env.HOME;
const stateRoot = join(home, ".config", "cmux-companion", "updater");
const lockPath = join(stateRoot, "lock");
const transactionPath = join(stateRoot, "transaction.json");
const currentEngine = join(home, ".local", "share", "cmux-companion", "current", "updater", "scripts", "local-updater.mjs");
let preserveLock = false;
const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
async function readTransaction() {
  try { return JSON.parse(await readFile(transactionPath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function acquire() {
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") {
      const [owner, info] = await Promise.all([
        readFile(join(lockPath, "owner.json"), "utf8").then(JSON.parse).catch(() => ({})),
        stat(lockPath),
      ]);
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
      let alive = false;
      if (Number.isInteger(owner.pid)) {
        try { process.kill(owner.pid, 0); alive = true; } catch (pidError) { alive = pidError.code === "EPERM"; }
      }
      if (Number.isInteger(owner.enginePid)) {
        try { process.kill(owner.enginePid, 0); alive = true; } catch (pidError) { if (pidError.code === 'EPERM') alive = true; }
      }
      // An in-progress spawn claim (no engine pid yet) is protected only while
      // its owner lives or the claim is fresh; a crashed owner must not deadlock.
      if (alive || Date.now() - info.mtimeMs <= 15 * 60_000) return false;
      await rm(lockPath, { recursive: true });
      await mkdir(lockPath, { mode: 0o700 });
    } else {
      throw error;
    }
  }
  await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { mode: 0o600 });
  return true;
}

async function saveOwner(details) {
  const path = join(lockPath, 'owner.json'), temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), ...details }), { mode: 0o600 });
  await rename(temporary, path);
}

async function execute(engine, transactionId) {
  await saveOwner({ spawnClaim: true });
  return new Promise((resolve, reject) => {
    const args = [engine];
    if (transactionId) args.push("--resume", transactionId);
    const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
    const recorded = saveOwner({ spawnClaim: true, enginePid: child.pid });
    void recorded.catch(error => { preserveLock = true; reject(error); });
    child.once("error", reject);
    child.once("exit", (code, signal) => { void recorded.then(() => signal ? reject(new Error(`Engine terminated by ${signal}`)) : resolve(code), reject); });
  });
}

if (!await acquire()) process.exit(0);
let exitCode = 0;
try {
  const transaction = await readTransaction();
  if (transaction && transaction.schemaVersion !== 2) throw new Error('Legacy update transaction requires explicit migration');
  const engine = transaction?.recoveryEngine || currentEngine;
  const releases = join(home, '.local', 'share', 'cmux-companion', 'releases');
  const [enginePath, releaseRoot] = await Promise.all([realpath(engine), realpath(releases)]);
  if (!enginePath.startsWith(`${releaseRoot}/`) || !/\/[a-f0-9]{40}\/updater\/scripts\/local-updater\.mjs$/.test(enginePath)) throw new Error('Engine is outside the managed release store');
  if (transaction && await digest(enginePath) !== transaction.expectedEngineDigest) throw new Error('Recovery engine digest changed');
  exitCode = await execute(enginePath, transaction?.id);
} finally {
  if (!preserveLock) await rm(lockPath, { recursive: true, force: true });
}
process.exitCode = exitCode;
