#!/usr/bin/env node
import { spawn } from "node:child_process";
import { defaultPaths } from "../src/constants.mjs";

const paths = defaultPaths(process.env.CMUX_COMPANION_HOME);
let stopping = false;
let child = null;
let wake = null;

function stop() {
  stopping = true;
  child?.kill("SIGTERM");
  wake?.();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

async function pollDelayMs() { return 5000; }

function runBootstrap() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (error = null, code = 0, signal = null) => {
      if (settled) return;
      settled = true;
      child = null;
      if (!stopping && (error || code !== 0)) {
        console.error(error?.message || `Updater cycle exited with ${signal || code}`);
      }
      resolve();
    };
    child = spawn(paths.bootstrap, [], { env: process.env, stdio: "inherit" });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => finish(null, code, signal));
  });
}

function pause(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  }).finally(() => { wake = null; });
}

while (!stopping) {
  await runBootstrap();
  const delayMs = await pollDelayMs();
  if (!stopping) await pause(delayMs);
}
