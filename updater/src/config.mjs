import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { readJson } from "./fs-safe.mjs";

const SHA = /^[0-9a-f]{40}$/;

export function normalizeRemote(value) {
  return String(value || "").trim().replace(/\.git\/?$/, "").replace(/^git@github\.com:/, "https://github.com/").replace(/\/$/, "").toLowerCase();
}

export function validateSha(value) {
  if (!SHA.test(value || "")) throw new Error("Remote ref did not resolve to a full 40-character SHA");
  return value;
}

export function retryDelayMs(failures) {
  return [30, 60, 120, 300][Math.min(Math.max(failures - 1, 0), 3)] * 1000;
}

export async function loadConfig(path) {
  const config = await readJson(path);
  if (!config || config.schemaVersion !== 2) throw new Error("Legacy updater requires explicit bundled migration; no automatic installation is authorized");
  if (!Array.isArray(config.targets) || config.targets.length !== 1 || config.targets[0].name !== "companion") throw new Error("Configuration must contain one bundled Companion target");
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(config.repository)) throw new Error("Invalid trusted update repository");
  const health = new URL(config.healthUrl);
  if (health.protocol !== 'http:' || health.hostname !== '127.0.0.1' || health.username || health.password || health.pathname !== '/api/health') throw new Error('Health address must be loopback');
  if (!Number.isInteger(config.pollSeconds) || config.pollSeconds < 1 || config.pollSeconds > 86400) throw new Error('Invalid check interval');
  if (!Number.isInteger(config.healthTimeoutSeconds) || config.healthTimeoutSeconds < 1 || config.healthTimeoutSeconds > 300) throw new Error('Invalid health timeout');
  if (!Array.isArray(config.dataFiles) || config.dataFiles.length !== 2 || config.dataFiles.some(path => typeof path !== 'string' || path !== resolve(path)) || config.tokenFile !== resolve(config.tokenFile || '.')) throw new Error('Explicit private data paths required');
  for (const target of config.targets) {
    if (target.repositoryPath !== resolve(target.repositoryPath) || target.releaseRoot !== resolve(target.releaseRoot)) throw new Error("Repository and release paths must be absolute");
    if (target.remote !== 'origin' || target.branch !== 'main' || normalizeRemote(target.expectedRemote) !== `https://github.com/${config.repository}`.toLowerCase()) throw new Error('Update target must match trusted origin/main');
    target.repositoryPath = await realpath(target.repositoryPath);
    target.releaseRoot = resolve(target.releaseRoot);
    if (!Array.isArray(target.entryPoints) || target.entryPoints.some(path => typeof path !== 'string' || path.startsWith('/') || path.split('/').includes('..'))) throw new Error('Invalid release entries');
  }
  return config;
}
