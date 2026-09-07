import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./index.mjs";
import { superviseFrontend } from "./frontend-supervisor.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const frontendPort = Number(process.env.CMUX_COMPANION_FRONTEND_PORT || 3211);
const frontend = spawn(process.execPath, [
  join(root, "node_modules", "vinext", "dist", "cli.js"),
  "start", "--port", String(frontendPort), "--hostname", "127.0.0.1",
], { cwd: root, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } });

// Install signal ownership during startup too. superviseFrontend observes the
// resulting exit and cleans up any bridge that finishes starting afterward.
let supervisor;
let requestedSignal;
const stop = signal => {
  requestedSignal = signal;
  if (supervisor) void supervisor.stop(signal);
  else frontend.kill(signal);
};
process.once("SIGTERM", () => stop("SIGTERM"));
process.once("SIGINT", () => stop("SIGINT"));
try {
  supervisor = await superviseFrontend({ frontend, url: `http://127.0.0.1:${frontendPort}/`, startBridge: startServer });
  if (requestedSignal) await supervisor.stop(requestedSignal);
  const result = await supervisor.closed;
  if (result.error) console.error(result.error);
  process.exit(result.code);
} catch (error) {
  if (!requestedSignal) console.error(error);
  process.exit(requestedSignal ? 0 : 1);
}
