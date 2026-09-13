import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, rename, symlink } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function atomicWrite(path, value, mode = 0o600) {
  await ensurePrivateDir(dirname(path));
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", mode);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temp, mode);
  await rename(temp, path);
}

export async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJson(path, value, mode = 0o600) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function isPathInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !resolve(candidate).includes("\0");
}

export async function assertPathInside(root, candidate, { allowMissing = false } = {}) {
  const canonicalRoot = await realpath(root);
  const parent = await realpath(allowMissing ? dirname(candidate) : candidate);
  const checked = allowMissing ? resolve(parent, candidate.split(sep).at(-1)) : parent;
  if (!isPathInside(canonicalRoot, checked)) throw new Error("Path escapes the managed release root");
  return checked;
}

export async function sha256(path) {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

export async function atomicSymlink(target, linkPath) {
  const temp = `${linkPath}.${process.pid}.${randomUUID()}.tmp`;
  await symlink(target, temp);
  await rename(temp, linkPath);
}
