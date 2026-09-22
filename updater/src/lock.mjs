import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";

export async function acquireLock(path, { now = Date.now(), staleMs = 15 * 60_000 } = {}) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const [metadata, info] = await Promise.all([
      readFile(`${path}/owner.json`, "utf8").then(JSON.parse).catch(() => ({})),
      stat(path),
    ]);
    if (!Number.isInteger(metadata.pid) || metadata.pid <= 0) return null;
    // A spawn claim without an engine pid is an engine spawn in progress; it is
    // protected while the owner lives or the claim is fresh. A crashed owner
    // (for example ENOSPC while recording the pid) leaves an orphan that must
    // expire like any other stale lock, or the updater deadlocks forever.
    let alive = false;
    if (Number.isInteger(metadata.pid)) {
      try { process.kill(metadata.pid, 0); alive = true; } catch (pidError) { alive = pidError.code === "EPERM"; }
    }
    if (Number.isInteger(metadata.enginePid)) {
      try { process.kill(metadata.enginePid, 0); alive = true; } catch (pidError) { if (pidError.code === 'EPERM') alive = true; }
    }
    if (alive || now - info.mtimeMs <= staleMs) return null;
    await rm(path, { recursive: true });
    await mkdir(path, { mode: 0o700 });
  }
  await writeFile(`${path}/owner.json`, `${JSON.stringify({ pid: process.pid, createdAt: new Date(now).toISOString() })}\n`, { mode: 0o600 });
  let released = false;
  return async () => {
    if (!released) { released = true; await rm(path, { recursive: true, force: true }); }
  };
}
