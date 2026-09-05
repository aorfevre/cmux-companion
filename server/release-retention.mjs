import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";

// The updater owns its retention state and transaction lock. Companion only
// forwards explicit operator requests to the deployed updater's CLI.
export async function releaseRetention(command, options = {}) {
  if (!["status", "preview", "configure", "run"].includes(command)) throw new TypeError("Unknown release retention operation");
  const home = process.env.CMUX_COMPANION_HOME || homedir();
  const script = join(home, ".local", "share", "cmux-companion-updater", "current", "scripts", "operator.mjs");
  const { stdout } = await promisify(execFile)(process.execPath, [script, `cleanup-${command}`, JSON.stringify(options)], { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}
