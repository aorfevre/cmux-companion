#!/usr/bin/env node
import { mkdir, readFile, realpath, rename, rm, rmdir, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

// This file runs from ~/.local/libexec and must stay standalone: it cannot import
// updater/src. Keep the lock rule identical to updater/src/lock.mjs.
const home = process.env.CMUX_COMPANION_HOME || process.env.HOME;
const stateRoot = join(home, ".config", "cmux-companion", "updater");
const lockPath = join(stateRoot, "lock");
const transactionPath = join(stateRoot, "transaction.json");
const currentEngine = join(home, ".local", "share", "cmux-companion", "current", "updater", "scripts", "local-updater.mjs");
// Exit codes the launcher reports once per state change (updater/src/cycle-report.mjs).
const EXIT_LOCK_HELD = 3;
const EXIT_LOW_DISK = 4;
const LOCK_STALE_MS = 15 * 60_000;
const MIN_FREE_BYTES = Number(process.env.CMUX_COMPANION_UPDATER_MIN_FREE_BYTES) || 64 * 1024 * 1024;
const failpoint = process.env.CMUX_COMPANION_UPDATER_FAILPOINT || null;
let preserveLock = false;
const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
async function readTransaction() {
  try { return JSON.parse(await readFile(transactionPath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
function ownerAlive(owner) {
  return [owner?.pid, owner?.enginePid].some(pid => Number.isInteger(pid) && pid > 0 && processAlive(pid));
}

async function isStale() {
  let owner, info;
  try {
    [owner, info] = await Promise.all([
      readFile(join(lockPath, "owner.json"), "utf8").then(JSON.parse).catch(() => ({})),
      stat(lockPath),
    ]);
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  // Only a live owner or engine holds the lock. A dead pid, or an unreadable or
  // pid-less owner left by a claimant that crashed between mkdir and the owner
  // write, is an orphan once the directory is older than the stale window. A
  // fresh directory is always protected so a claim being recorded is not stolen.
  return !ownerAlive(owner) && Date.now() - info.mtimeMs > LOCK_STALE_MS;
}

// Reclamation is serialized by an empty marker directory, so only one process
// ever removes and recreates a stale lock, and it re-checks staleness while it
// holds the marker. A claimant that does not hold the marker never deletes
// anything. A marker left by a crashed reclaimer is removed only once it is
// itself older than the stale window; rmdir is atomic and removes nothing else.
async function reclaimStale() {
  const marker = `${lockPath}.reclaim`;
  try {
    await mkdir(marker, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let info;
    try { info = await stat(marker); } catch (statError) { if (statError.code === "ENOENT") return false; throw statError; }
    if (Date.now() - info.mtimeMs <= LOCK_STALE_MS) return false;
    try { await rmdir(marker); } catch (rmError) { if (rmError.code !== "ENOENT") return false; }
    try { await mkdir(marker, { mode: 0o700 }); } catch (mkError) { if (mkError.code === "EEXIST") return false; throw mkError; }
  }
  try {
    if (!await isStale()) return false;
    await rm(lockPath, { recursive: true, force: true });
    try { await mkdir(lockPath, { mode: 0o700 }); } catch (error) { if (error.code === "EEXIST") return false; throw error; }
    return true;
  } finally {
    try { await rmdir(marker); } catch { /* already removed */ }
  }
}

async function acquire() {
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!await isStale()) return false;
    if (!await reclaimStale()) return false;
  }
  try {
    if (failpoint === "owner-write") throw Object.assign(new Error("ENOSPC: injected owner write failure"), { code: "ENOSPC" });
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { mode: 0o600 });
  } catch (error) {
    // ENOENT means a reclaimer removed the directory: ownership is lost and the
    // path may already belong to another claimant, so leave it untouched.
    if (error.code === "ENOENT") return false;
    // Any other failure leaves a fresh directory that only this claimant owns
    // (reclaimers protect it for the stale window). Never leave it ownerless:
    // it would read as held. Keep the original error if the cleanup fails too.
    try { await rm(lockPath, { recursive: true, force: true }); } catch { /* reported by the original error */ }
    throw error;
  }
  return true;
}

async function freeBytes() {
  const info = await statfs(stateRoot);
  return Number(info.bavail) * Number(info.bsize);
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

if (await freeBytes() < MIN_FREE_BYTES) process.exit(EXIT_LOW_DISK);
if (!await acquire()) process.exit(EXIT_LOCK_HELD);
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
// Exit codes 3 and 4 belong to this bootstrap; an engine that exits with them is a plain failure.
process.exitCode = [EXIT_LOCK_HELD, EXIT_LOW_DISK].includes(exitCode) ? 1 : exitCode;
