import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, sha256 } from "./fs-safe.mjs";
import { run } from "./process.mjs";

export const MANIFEST = "release-manifest.json";

async function regular(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular candidate file: ${path}`);
}

async function dataContractDigest(root) {
  const path = join(root, 'server/data-contract.json');
  try { await regular(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return sha256(path);
}

export async function buildCandidate(target, releasePath, sha, log, { execute = run } = {}) {
  const npm = target.npmPath || "npm";
  await regular(join(releasePath, "package.json"));
  await regular(join(releasePath, "package-lock.json"));
  // The LaunchAgent runs with NODE_ENV=production, which makes npm imply
  // omit=dev. Build tools such as vinext are devDependencies, so a bare
  // `npm ci` installs a tree that cannot build. Force the dev tree in, and
  // clear the variable so no nested npm lifecycle script re-applies omit=dev.
  const buildEnv = { NODE_ENV: "development", npm_config_omit: "" };
  await execute(npm, ["ci", "--include=dev"], { cwd: releasePath, timeoutMs: target.installTimeoutMs || 10 * 60_000, log, env: buildEnv });
  await execute(npm, ["run", "build"], { cwd: releasePath, timeoutMs: target.buildTimeoutMs || 10 * 60_000, log, env: buildEnv });
  const verification = [];
  for (const command of target.verificationCommands || []) {
    if (!Array.isArray(command) || command.length < 1) throw new Error("Invalid verification command");
    await execute(command[0], command.slice(1), { cwd: releasePath, timeoutMs: 5 * 60_000, log });
    verification.push(command);
  }
  for (const entry of target.entryPoints) await regular(join(releasePath, entry));
  const nodeVersion = process.version;
  const npmVersion = (await execute(npm, ["--version"])).stdout.trim();
  const manifest = {
    schemaVersion: 1,
    bundledUpdater: target.bundled === true,
    dataContractSha256: target.bundled === true ? await dataContractDigest(releasePath) : null,
    updaterDigests: target.bundled === true ? Object.fromEntries(await Promise.all(['local-updater.mjs', 'bootstrap.mjs', 'launch-companion.mjs'].map(async file => [file, await sha256(join(releasePath, 'updater', 'scripts', file))]))) : null,
    target: target.name,
    gitSha: sha,
    builtAt: new Date().toISOString(),
    nodeVersion,
    npmVersion,
    engineVersion: target.name === "updater" ? JSON.parse(await readFile(join(releasePath, "package.json"), "utf8")).version : null,
    engineSha256: target.name === "updater" ? await sha256(join(releasePath, "scripts", "local-updater.mjs")) : null,
    bootstrapVersion: target.name === "updater" ? JSON.parse(await readFile(join(releasePath, "package.json"), "utf8")).version : null,
    bootstrapSha256: target.name === "updater" ? await sha256(join(releasePath, "scripts", "bootstrap.mjs")) : null,
    serviceLauncherSha256: target.name === "updater" ? await sha256(join(releasePath, "scripts", "launch-companion.mjs")) : null,
    entryPoints: target.entryPoints,
    verificationCommands: verification,
  };
  await atomicWrite(join(releasePath, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 0o444);
  if (target.bundled === true) {
    if (!manifest.bundledUpdater) throw new Error('Bundled updater manifest required');
    if (await dataContractDigest(releasePath) !== (manifest.dataContractSha256 ?? null)) throw new Error('Data contract digest mismatch');
    for (const file of ['local-updater.mjs', 'bootstrap.mjs', 'launch-companion.mjs']) if (await sha256(join(releasePath, 'updater', 'scripts', file)) !== manifest.updaterDigests?.[file]) throw new Error('Bundled updater digest mismatch');
  }
  return manifest;
}

export async function validateManifest(target, releasePath, sha) {
  const manifest = JSON.parse(await readFile(join(releasePath, MANIFEST), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.target !== target.name || manifest.gitSha !== sha) throw new Error("Release manifest identity mismatch");
  for (const entry of manifest.entryPoints || []) await regular(join(releasePath, entry));
  if (target.name === "updater") {
    if (await sha256(join(releasePath, "scripts", "local-updater.mjs")) !== manifest.engineSha256) throw new Error("Candidate engine digest mismatch");
    if (await sha256(join(releasePath, "scripts", "bootstrap.mjs")) !== manifest.bootstrapSha256) throw new Error("Candidate bootstrap digest mismatch");
    if (await sha256(join(releasePath, "scripts", "launch-companion.mjs")) !== manifest.serviceLauncherSha256) throw new Error("Candidate launcher digest mismatch");
  }
  if (target.bundled === true) {
    if (!manifest.bundledUpdater) throw new Error('Bundled updater manifest required');
    if (await dataContractDigest(releasePath) !== (manifest.dataContractSha256 ?? null)) throw new Error('Data contract digest mismatch');
    for (const file of ['local-updater.mjs', 'bootstrap.mjs', 'launch-companion.mjs']) if (await sha256(join(releasePath, 'updater', 'scripts', file)) !== manifest.updaterDigests?.[file]) throw new Error('Bundled updater digest mismatch');
  }
  return manifest;
}
