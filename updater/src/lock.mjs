import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";

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

export async function acquireLock(path, { now = Date.now(), staleMs = LOCK_STALE_MS, write = writeFile } = {}) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const [metadata, info] = await Promise.all([
      readFile(`${path}/owner.json`, "utf8").then(JSON.parse).catch(() => ({})),
      stat(path),
    ]);
    if (lockOwnerAlive(metadata) || now - info.mtimeMs <= staleMs) return null;
    await rm(path, { recursive: true });
    await mkdir(path, { mode: 0o700 });
  }
  try {
    await write(`${path}/owner.json`, `${JSON.stringify({ pid: process.pid, createdAt: new Date(now).toISOString() })}\n`, { mode: 0o600 });
  } catch (error) {
    // Never leave an ownerless directory behind: it would read as held. Keep the
    // original error even when the cleanup itself fails.
    try { await rm(path, { recursive: true, force: true }); } catch { /* reported by the original error */ }
    throw error;
  }
  let released = false;
  return async () => {
    if (!released) { released = true; await rm(path, { recursive: true, force: true }); }
  };
}
