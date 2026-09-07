import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function stampServiceWorker(directory) {
  const digest = createHash("sha256");
  const assets = [];
  async function visit(path, prefix = "") {
    const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const name = `${prefix}${entry.name}`;
      if (name === "sw.js") continue;
      if (entry.isDirectory()) await visit(join(path, entry.name), `${name}/`);
      else if (entry.isFile()) {
        digest.update(name).update("\0").update(await readFile(join(path, entry.name)));
        if (/\.(js|css)$/.test(name)) assets.push(`/${name}`);
      }
    }
  }
  await visit(directory);
  // Include worker behavior itself so a worker-only fix also gets a new cache.
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  digest.update(source);
  const buildId = digest.digest("hex").slice(0, 20);
  await writeFile(join(directory, "sw.js"), source
    .replace('"__CMUX_BUILD_ID__"', JSON.stringify(buildId))
    .replace("const BUILD_ASSETS = [];", `const BUILD_ASSETS = ${JSON.stringify(assets)};`));
  return buildId;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stampServiceWorker(fileURLToPath(new URL("../dist/client", import.meta.url)));
}
