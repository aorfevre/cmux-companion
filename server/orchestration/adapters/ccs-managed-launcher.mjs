import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { identifier, requireValue } from '../domain/contracts.mjs';
import { assertNativeInstallation } from './native-capabilities.mjs';
import { validateNativeEnvironment } from './ccs.mjs';

const launcher = fileURLToPath(import.meta.url);
const digest = (/** @type {string} */ value) => createHash('sha256').update(value).digest('hex');
const quote = (/** @type {string} */ value) => `'${value.replace(/'/g, `'\\''`)}'`;
/** @typedef {Parameters<typeof assertNativeInstallation>[0]} Installation */
/** @typedef {{bin:string;argv:string[];cwd:string;env:NodeJS.ProcessEnv}} Command */
/** @typedef {{version:1;installation:Installation;argv:string[];cwd:string}} Recipe */

/** CCS selects authentication and routing; Companion owns the final native
 * command. Create this immutable recipe only after trusted resume rewriting.
 * @param {Command} command @param {Installation | undefined} installation
 * @param {string} directory @param {string} runId @returns {Command} */
export function prepareCcsLaunch(command, installation, directory, runId) {
  if (!installation || installation.provider !== 'claude' || installation.bin === installation.nativeBin) return command;
  identifier(runId); assertNativeInstallation(installation); validateNativeEnvironment(command.env);
  requireValue(command.bin === installation.bin && command.env.CCS_CLAUDE_PATH === installation.nativeBin
    && command.argv[1] === '--target' && command.argv[2] === 'claude', 'CCS executable binding changed', 'UNSUPPORTED_CAPABILITY');
  requireValue(realpathSync(directory) === directory && lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'CCS recipe directory changed');
  requireValue(isAbsolute(command.cwd) && realpathSync(command.cwd) === command.cwd, 'CCS working directory changed');
  const argv = command.argv.slice(3);
  requireValue(argv.includes('--restricted') && argv.includes('--strict-mcp-config'), 'CCS native boundary is incomplete');
  const recipePath = join(directory, `ccs-${runId}.json`), shim = join(directory, `ccs-${runId}`);
  const body = JSON.stringify({ version: 1, installation, argv, cwd: command.cwd });
  // A shell bootstrap strips Node preload settings before Node can evaluate
  // them. Every shell operand is a fixed, quoted path or "$@"; no evaluation.
  const source = `#!/bin/sh\nunset NODE_OPTIONS NODE_PATH BUN_OPTIONS LD_PRELOAD DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH\nexec ${quote(process.execPath)} ${quote(launcher)} ${quote(recipePath)} ${quote(digest(body))} "$@"\n`;
  for (const [path, text, mode] of /** @type {[string,string,number][]} */ ([[recipePath, body, 0o400], [shim, source, 0o500]])) {
    try { writeFileSync(path, text, { mode, flag: 'wx', flush: true }); }
    catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
      const stat = lstatSync(path);
      requireValue(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && readFileSync(path, 'utf8') === text, 'CCS launch recipe changed', 'OWNERSHIP_UNCERTAIN');
    }
  }
  return { ...command, env: { ...command.env, CCS_CLAUDE_PATH: shim } };
}

/** Only the pinned session invocation, with CCS additions interspersed, can
 * consume a recipe. Metadata is handled separately and cannot launch a session.
 * @param {string[]} supplied @param {string[]} approved */
export function validateCcsInvocation(supplied, approved) {
  const marker = approved.indexOf('--'), received = supplied.indexOf('--');
  requireValue(marker >= 0 && received >= 0 && supplied.lastIndexOf('--') === received
    && JSON.stringify(supplied.slice(received)) === JSON.stringify(approved.slice(marker)), 'CCS invocation changed');
  for (const flag of ['--session-id', '--resume', '--print']) {
    requireValue(supplied.filter(value => value === flag).length === approved.filter(value => value === flag).length, 'CCS invocation mode changed');
    if (flag !== '--print' && approved.includes(flag)) requireValue(supplied[supplied.indexOf(flag) + 1] === approved[approved.indexOf(flag) + 1], 'CCS conversation changed');
  }
  requireValue(!supplied.includes('--help') && !supplied.includes('--version'), 'CCS metadata invocation changed');
  let cursor = 0;
  for (const value of supplied.slice(0, received)) if (value === approved[cursor]) cursor++;
  requireValue(cursor === marker, 'CCS removed an approved native argument');
}

/** Exec replaces this shim, retaining PID, process group, terminal, signal and
 * exit semantics under the existing provider supervisor. No auth is persisted.
 * @param {string} recipePath @param {string} expectedDigest @param {string[]} supplied */
export function runCcsLauncher(recipePath, expectedDigest, supplied) {
  requireValue(isAbsolute(recipePath) && realpathSync(dirname(recipePath)) === dirname(recipePath), 'Invalid CCS recipe path');
  const stat = lstatSync(recipePath);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && stat.size <= 2 * 1024 * 1024, 'Invalid CCS launch recipe');
  const body = readFileSync(recipePath, 'utf8'); requireValue(digest(body) === expectedDigest, 'CCS launch recipe identity changed');
  const recipe = /** @type {Recipe} */ (JSON.parse(body));
  requireValue(recipe.version === 1 && recipe.installation.provider === 'claude' && recipe.installation.bin !== recipe.installation.nativeBin, 'Invalid CCS native target');
  assertNativeInstallation(recipe.installation); validateNativeEnvironment(process.env);
  requireValue(realpathSync(process.cwd()) === recipe.cwd, 'CCS working directory changed');
  const metadata = supplied.length === 1 && ['--help', '--version'].includes(supplied[0]);
  if (!metadata) {
    validateCcsInvocation(supplied, recipe.argv);
    // Even an unexpected second wrapper invocation cannot duplicate a run.
    writeFileSync(`${recipePath}.sent`, '', { mode: 0o400, flag: 'wx', flush: true });
  }
  const env = Object.fromEntries(Object.entries({ ...process.env, CCS_CLAUDE_PATH: recipe.installation.nativeBin }).filter((entry) => entry[1] !== undefined));
  requireValue(typeof process.execve === 'function', 'Native exec replacement is unavailable');
  process.execve(recipe.installation.nativeBin, [recipe.installation.nativeBin, ...(metadata ? supplied : recipe.argv)], /** @type {Record<string,string>} */ (env));
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { runCcsLauncher(process.argv[2], process.argv[3], process.argv.slice(4)); }
  catch { process.stderr.write('Companion could not validate the managed native launch.\n'); process.exitCode = 2; }
}
