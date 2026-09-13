#!/usr/bin/env node
import { runEngine } from "../src/engine.mjs";

try {
  await runEngine({ resumeId: process.argv[2] === '--resume' ? process.argv[3] : null, ...(process.env.CMUX_COMPANION_UPDATER_CONFIG ? { configPath: process.env.CMUX_COMPANION_UPDATER_CONFIG } : {}) });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
