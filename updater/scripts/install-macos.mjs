#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { installBundled } from '../src/install.mjs';
import { normalizeRemote } from '../src/config.mjs';
import { run } from '../src/process.mjs';
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const remote = (await run('git', ['-C', sourceRoot, 'remote', 'get-url', 'origin'])).stdout.trim();
const repository = normalizeRemote(remote).match(/^https:\/\/github.com\/([^/]+\/[^/]+)$/)?.[1];
const result = await installBundled({ sourceRoot, repository, migrate: process.argv.includes('--migrate'),
  port: process.env.CMUX_COMPANION_PORT ? Number(process.env.CMUX_COMPANION_PORT) : undefined,
  frontendPort: process.env.CMUX_COMPANION_FRONTEND_PORT ? Number(process.env.CMUX_COMPANION_FRONTEND_PORT) : undefined,
  dataDirectory: process.env.CMUX_COMPANION_DATA_DIR, settingsPath: process.env.CMUX_COMPANION_SETTINGS_DB, tokenFile: process.env.CMUX_COMPANION_TOKEN_FILE });
console.log(`Installed Companion ${result.sha}. Configure private transport and cmux automation using the documented setup steps. Automatic installation is off unless previously opted in.`);
