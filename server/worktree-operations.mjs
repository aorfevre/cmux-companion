import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { promisify } from "node:util";

const executeGit = promisify(execFile);

// Callers own execution policy and stdout defaults; preserve the process result
// and rejection object unchanged.
export function runGit(cwd, args, options, execute = executeGit) {
  return execute("git", ["-C", cwd, ...args], options);
}

export function parseWorktreePorcelain(output) {
  const records = [];
  let current = null;
  for (const field of String(output).split("\0")) {
    if (!field) {
      current = null;
      continue;
    }
    const space = field.indexOf(" ");
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? null : field.slice(space + 1);
    if (key === "worktree") {
      current = { path: value, head: null, branch: null, detached: false, bare: false, locked: false, lockReason: null, prunable: false, pruneReason: null };
      records.push(current);
    } else if (current) {
      if (key === "HEAD") current.head = value;
      else if (key === "branch") current.branch = value?.replace(/^refs\/heads\//, "") ?? null;
      else if (key === "detached" || key === "bare") current[key] = true;
      else if (key === "locked" || key === "prunable") {
        current[key] = true;
        current[key === "locked" ? "lockReason" : "pruneReason"] = value;
      }
    }
  }
  return records;
}

export const cleanupHome = () => join(process.env.CMUX_COMPANION_HOME || homedir(), ".config", "cmux-companion", "worktree-cleanup");
export const digest = (value) => createHash("sha256").update(value).digest("hex");
export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}
// No expiry-based stealing: a crashed owner's lock is intentionally a visible
// repair condition. Removing locks on a timer can race a paused live process.
export async function withOperationLock(key, work, directory = join(cleanupHome(), "locks")) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await plainPath(directory);
  const path = join(directory, digest(key));
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") throw Object.assign(new Error("Another worktree operation holds this lock; retry after it finishes. If this persists, its recorded owner needs to be checked before recovery"), { statusCode: 409 }); throw error; }
  try {
    await writeJson(join(path, "owner.json"), { pid: process.pid, key, createdAt: new Date().toISOString() });
    return await work();
  } finally { await rm(path, { recursive: true }); }
}
export async function plainPath(path, { missing = false } = {}) {
  const absolute = resolve(path);
  let cursor = parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split("/").filter(Boolean)) {
    cursor = join(cursor, part);
    let info;
    try { info = await lstat(cursor); }
    catch (error) { if (missing && error.code === "ENOENT") return null; throw error; }
    if (info.isSymbolicLink()) throw new Error(`Symlink path is protected: ${cursor}`);
  }
  return lstat(absolute);
}
export async function withWorkspaceLaunch(cwd, work, { requireRepository = false, lockDirectory } = {}) {
  // The common-directory lock also covers launches into a subdirectory of a
  // worktree. Cleanup holds this same lock through its final checks and remove.
  const canonical = await realpath(cwd);
  let common;
  try { common = (await runGit(canonical, ["rev-parse", "--path-format=absolute", "--git-common-dir"], undefined)).stdout.trim(); }
  catch (cause) { if (requireRepository) throw cause; return work(); }
  return withOperationLock(`repository:${await realpath(common)}`, async () => {
    if (await realpath(cwd) !== canonical) throw new Error("Workspace path changed before launch");
    return work();
  }, lockDirectory);
}
