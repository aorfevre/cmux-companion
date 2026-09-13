#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

const home = process.env.CMUX_COMPANION_HOME || process.env.HOME;
const current = join(home, ".local", "share", "cmux-companion", "current");
const release = await realpath(current);
process.chdir(release);
process.env.CMUX_COMPANION_RELEASE_SHA = release.split("/").at(-1);
try {
  const manifest = JSON.parse(await readFile(join(release, "release-manifest.json"), "utf8"));
  process.env.CMUX_COMPANION_BUILT_AT ||= manifest.builtAt;
} catch { /* Optional file is not available. */ }
await import(join(release, "server", "supervisor.mjs"));
