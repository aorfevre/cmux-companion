import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { stampServiceWorker } from "./stamp-service-worker.mjs";

async function build(args) {
  const start = performance.now();
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  if (code !== 0) throw new Error(`Experiment build failed: ${output.slice(-4000)}`);
  return Math.round(performance.now() - start);
}
async function unusedPort() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}
async function startup(args) {
  const port = await unusedPort();
  const start = performance.now();
  const child = spawn(process.execPath, [...args, "--port", String(port)], { stdio: "ignore" });
  let error;
  const exited = new Promise(resolve => { child.once("error", cause => { error = cause; resolve(); }); child.once("exit", resolve); });
  try {
    while (performance.now() - start < 15_000) {
      if (error) throw error;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Experiment frontend exited during startup");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
        const body = await response.text();
        if (response.ok && body.includes("cmux companion")) return Math.round(performance.now() - start);
      } catch { /* startup remains bounded */ }
      await delay(50);
    }
    throw new Error("Experiment frontend startup deadline expired");
  } finally {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(timer);
  }
}
function size(directory) {
  const result = { files: 0, totalBytes: 0, javascriptBytes: 0, cssBytes: 0, gzipJavascriptBytes: 0 };
  function visit(path) {
    for (const name of readdirSync(path)) {
      const file = join(path, name);
      if (statSync(file).isDirectory()) visit(file);
      else {
        const bytes = readFileSync(file);
        result.files++; result.totalBytes += bytes.length;
        if (file.endsWith(".js")) { result.javascriptBytes += bytes.length; result.gzipJavascriptBytes += gzipSync(bytes).length; }
        if (file.endsWith(".css")) result.cssBytes += bytes.length;
      }
    }
  }
  visit(directory);
  return result;
}
const vinextBuildMs = await build(["node_modules/vinext/dist/cli.js", "build"]);
await stampServiceWorker("dist/client");
const vinextStartupMs = await startup(["node_modules/vinext/dist/cli.js", "start", "--hostname", "127.0.0.1"]);
const spaBuildMs = await build(["node_modules/vite/bin/vite.js", "build", "--config", "experiments/local-spa/vite.config.ts"]);
await stampServiceWorker("outputs/local-spa");
const spaStartupMs = await startup(["node_modules/vite/bin/vite.js", "preview", "--config", "experiments/local-spa/vite.config.ts", "--host", "127.0.0.1", "--strictPort"]);
console.log(JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, vinext: { buildMs: vinextBuildMs, startupMs: vinextStartupMs, ...size("dist/client") }, spa: { buildMs: spaBuildMs, startupMs: spaStartupMs, ...size("outputs/local-spa") } }, null, 2));
