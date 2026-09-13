import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const action = process.argv[2];
if (!['check', 'retry', 'disable', 'enable'].includes(action)) throw new Error('Unknown updater action');
const explicit = process.env.CMUX_COMPANION_UPDATER_REPOSITORY;
if (explicit && !isAbsolute(explicit)) throw new Error('Updater repository must be an absolute directory');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = explicit ? [join(explicit, 'scripts', 'operator.mjs')] : [
  join(homedir(), '.local', 'share', 'cmux-companion', 'current', 'updater', 'scripts', 'operator.mjs'),
  join(root, 'updater', 'scripts', 'operator.mjs'),
];
const script = candidates.find(path => existsSync(path));
if (!script) throw new Error('Updater not found. Install the bundled updater or set CMUX_COMPANION_UPDATER_REPOSITORY to its checkout.');
const child = spawn(process.execPath, [script, action], { stdio: 'inherit' });
child.once('error', () => { process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
