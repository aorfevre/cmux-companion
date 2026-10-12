import { mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";

export const LOCK_STALE_MS = 15 * 60_000;

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

// Only a live owner or engine holds the lock. A dead pid, or an owner file that
// is unreadable or has no positive pid (left by a claimant that crashed between
// mkdir and the owner write, for example on ENOSPC), is an orphan once the
// directory is older than the stale window. A fresh directory is always
// protected so a claim that is still being recorded is never stolen.
export function lockOwnerAlive(metadata) {
  return [metadata?.pid, metadata?.enginePid].some(pid => Number.isInteger(pid) && pid > 0 && processAlive(pid));
}

async function isStale(path, now, staleMs) {
  let metadata, info;
  try {
    [metadata, info] = await Promise.all([
      readFile(`${path}/owner.json`, "utf8").then(JSON.parse).catch(() => ({})),
      stat(path),
    ]);
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  return !lockOwnerAlive(metadata) && now - info.mtimeMs > staleMs;
}

// Reclamation is serialized by an empty marker directory, so only one process
// ever removes and recreates a stale lock, and it re-checks staleness while it
// holds the marker. A claimant that does not hold the marker never deletes
// anything. A marker left by a crashed reclaimer is removed only once it is
// itself older than the stale window; rmdir is atomic and removes nothing else.
async function reclaimStale(path, now, staleMs) {
  const marker = `${path}.reclaim`;
  try {
    await mkdir(marker, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let info;
    try { info = await stat(marker); } catch (statError) { if (statError.code === "ENOENT") return false; throw statError; }
    if (now - info.mtimeMs <= staleMs) return false;
    try { await rmdir(marker); } catch (rmError) { if (rmError.code !== "ENOENT") return false; }
    try { await mkdir(marker, { mode: 0o700 }); } catch (mkError) { if (mkError.code === "EEXIST") return false; throw mkError; }
  }
  try {
    if (!await isStale(path, now, staleMs)) return false;
    await rm(path, { recursive: true, force: true });
    try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code === "EEXIST") return false; throw error; }
    return true;
  } finally {
    try { await rmdir(marker); } catch { /* already removed */ }
  }
}

export async function acquireLock(path, { now = Date.now(), staleMs = LOCK_STALE_MS, write = writeFile } = {}) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!await isStale(path, now, staleMs)) return null;
    if (!await reclaimStale(path, now, staleMs)) return null;
  }
  try {
    await write(`${path}/owner.json`, `${JSON.stringify({ pid: process.pid, createdAt: new Date(now).toISOString() })}\n`, { mode: 0o600 });
  } catch (error) {
    // ENOENT means a reclaimer removed the directory: ownership is lost and the
    // path may already belong to another claimant, so leave it untouched.
    if (error.code === "ENOENT") return null;
    // Any other failure leaves a fresh directory that only this claimant owns
    // (reclaimers protect it for the stale window). Never leave it ownerless:
    // it would read as held. Keep the original error if the cleanup fails too.
    try { await rm(path, { recursive: true, force: true }); } catch { /* reported by the original error */ }
    throw error;
  }
  let released = false;
  return async () => {
    if (!released) { released = true; await rm(path, { recursive: true, force: true }); }
  };
}
