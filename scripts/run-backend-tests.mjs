import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

// Deterministic tests live directly in tests/*.test.mjs. Live integrations use
// *.live.mjs and separate opt-in commands; also reject the older live-* naming.
export function backendTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs") && !/(^|[.-])live([.-]|$)/i.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = backendTestFiles(fileURLToPath(new URL("../tests", import.meta.url)));
  if (!files.length) throw new Error("No deterministic backend tests found");
  const child = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}
