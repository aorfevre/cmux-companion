#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { defaultPaths, LABELS } from "../src/constants.mjs";
import { run } from "../src/process.mjs";

const paths = defaultPaths(process.env.CMUX_COMPANION_HOME);
for (const label of [LABELS.updater, LABELS.companion]) {
  await run("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${label}`], { allowFailure: true });
  await rm(join(paths.launchAgents, `${label}.plist`), { force: true });
}
console.log("Removed both LaunchAgents. Credentials, state, logs, and releases were preserved.");
