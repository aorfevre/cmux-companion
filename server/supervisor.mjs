import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "./index.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const frontendPort = Number(process.env.CMUX_COMPANION_FRONTEND_PORT || 3211);
const frontend = spawn(process.execPath, [
  join(root, "node_modules", "vinext", "dist", "cli.js"),
  "start",
  "--port", String(frontendPort),
  "--hostname", "127.0.0.1",
], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production" },
});

async function waitForFrontend() {
  const url = `http://127.0.0.1:${frontendPort}/`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (frontend.exitCode !== null) throw new Error("Frontend process exited before becoming ready");
    try {
      const response = await fetch(url);
      if (response.ok) return url;
    } catch {
      // The frontend is still starting.
    }
    await delay(250);
  }
  throw new Error("Frontend did not become ready");
}

let server;
try {
  const frontendUpstream = await waitForFrontend();
  server = await startServer({ frontendUpstream });
} catch (error) {
  frontend.kill();
  throw error;
}

async function stop(signal = "SIGTERM") {
  frontend.kill(signal);
  await server.app.close();
  process.exit(0);
}

frontend.once("exit", (code, signal) => {
  if (code !== 0 && signal !== "SIGTERM") {
    console.error(`cmux companion frontend exited (code=${code}, signal=${signal})`);
    stop().catch(() => process.exit(1));
  }
});
process.once("SIGTERM", () => stop("SIGTERM"));
process.once("SIGINT", () => stop("SIGINT"));
