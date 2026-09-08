import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export async function cleanupOldFiles(directory, maxAgeMs) {
  const entries = await readdir(directory).catch(() => []);
  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(entries.map(async (name) => {
    const path = join(directory, name);
    const details = await stat(path).catch(() => null);
    if (details?.isFile() && details.mtimeMs < cutoff) await unlink(path).catch(() => {});
  }));
}
