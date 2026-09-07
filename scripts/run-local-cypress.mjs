import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

if (process.env.CI) throw new Error("The Cypress suite is intentionally local-only and refuses to run in CI.");

const open = process.argv.includes("--open");
const spaExperiment = process.argv.includes("--spa-experiment");
// vinext binds its development listener to localhost even when Vite receives a
// numeric host. Use the URL it actually advertises, or readiness waits forever
// while the frontend is already serving on IPv6 loopback.
const host = "localhost";
const port = 3221;
const baseUrl = `http://${host}:${port}`;
const environment = { ...process.env, CMUX_COMPANION_LOCAL_E2E: "1" };
await assertPortAvailable(port);
const frontend = spawn(spaExperiment ? process.execPath : "npm", spaExperiment
  ? ["node_modules/vite/bin/vite.js", "preview", "--config", "experiments/local-spa/vite.config.ts", "--host", host, "--port", String(port), "--strictPort"]
  : ["run", "dev", "--", "--host", host, "--port", String(port)], {
  cwd: process.cwd(),
  env: environment,
  stdio: "inherit",
});

async function waitUntilReady() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (frontend.exitCode !== null) throw new Error("The local frontend stopped before Cypress could connect.");
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await delay(500);
  }
  throw new Error(`The local frontend did not become ready at ${baseUrl}`);
}

function stopFrontend() {
  if (frontend.exitCode === null) frontend.kill("SIGTERM");
}

async function assertPortAvailable(candidate) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error(`Local Cypress port ${candidate} is already in use.`)));
    probe.listen(candidate, host, () => probe.close(resolve));
  });
}

process.once("SIGINT", () => { stopFrontend(); process.exit(130); });
process.once("SIGTERM", () => { stopFrontend(); process.exit(143); });

try {
  await waitUntilReady();
  const args = ["cypress", open ? "open" : "run", "--config-file", "cypress.config.ts"];
  if (process.env.CMUX_COMPANION_CYPRESS_BROWSER) args.push("--browser", process.env.CMUX_COMPANION_CYPRESS_BROWSER);
  const cypress = spawn("npx", args, { cwd: process.cwd(), env: environment, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => {
    cypress.once("error", reject);
    cypress.once("exit", (value) => resolve(value ?? 1));
  });
  process.exitCode = Number(code);
} finally {
  stopFrontend();
}
