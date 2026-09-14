import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, isAbsolute } from 'node:path';
import { providerCommand, resolveExecutable } from './local-settings.mjs';
import { DomainError, requireValue } from './orchestration/domain/contracts.mjs';
const execute = promisify(execFile);
const ignoredFlags = new Set(['--dangerously-skip-permissions', '--yolo', '--dangerously-bypass-approvals-and-sandbox']);
const known = new Set(['claude', 'codex', 'ccs', 'ccsxp']);

/** Parse words only. No substitutions, operators, redirects, functions or expansion. */
export function simpleAliasWords(source) {
  requireValue(typeof source === 'string' && source.length <= 4096 && !/[\n\r\0;$`|&<>(){}[\]\\!*?~#]/.test(source), 'Use a simple alias to claude, codex, ccs or ccsxp; shell expressions and functions are unsupported', 'UNSUPPORTED_CAPABILITY');
  const words = []; let word = '', quote = null, started = false;
  for (const character of source.trim()) {
    if (quote) { if (character === quote) quote = null; else word += character; started = true; }
    else if (character === '"' || character === "'") { quote = character; started = true; }
    else if (/\s/.test(character)) { if (started) { words.push(word); word = ''; started = false; } }
    else { word += character; started = true; }
  }
  requireValue(!quote, 'Alias has unmatched quotes', 'UNSUPPORTED_CAPABILITY');
  if (started) words.push(word);
  requireValue(words.length > 0 && words.every(word => word.length > 0), 'Alias command is empty', 'UNSUPPORTED_CAPABILITY');
  return words;
}

// The fixed shell query reads alias metadata only. The selected alias is never
// executed or interpolated into shell source, even if it contains shell syntax.
export async function readTerminalAlias(name) {
  requireValue(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name), 'Enter one terminal command name', 'UNSUPPORTED_CAPABILITY');
  try {
    const result = await execute('/bin/zsh', ['-lic', 'if (( $+aliases[$1] )); then builtin print -r -- "__CMUX_ALIAS__${aliases[$1]}"; elif (( $+functions[$1] )); then exit 65; else exit 66; fi', 'cmux-provider-alias', name],
      { env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, SHELL: '/bin/zsh', TERM: 'dumb' }, timeout: 5000, maxBuffer: 32768, encoding: 'utf8' });
    const output = result.stdout.split('__CMUX_ALIAS__').at(-1)?.trim();
    requireValue(result.stdout.includes('__CMUX_ALIAS__') && output, 'Terminal alias was not found', 'UNSUPPORTED_CAPABILITY');
    return output;
  } catch (error) {
    throw new DomainError('UNSUPPORTED_CAPABILITY', error.code === 65 ? 'Shell functions are unsupported. Use a simple alias to claude, codex, ccs or ccsxp.' : 'Terminal alias could not be read. Use a simple alias or the installed provider path.');
  }
}

/** Resolve once for a probe or goal snapshot. Execution only consumes this frozen
 * normalized object, never the alias again. Dependency injection keeps tests local. */
export async function resolveProviderCommand(provider, command, { readAlias = readTerminalAlias, resolve = resolveExecutable } = {}) {
  providerCommand(command, provider);
  const requested = [command.executable, ...command.args].join(' ');
  let words = [command.executable, ...command.args]; const removed = [];
  const visited = new Set();
  for (let depth = 0; !known.has(basename(words[0])); depth++) {
    requireValue(!isAbsolute(words[0]) && words.length === 1 && depth < 4 && !visited.has(words[0]), 'Use a supported provider executable or a simple terminal alias', 'UNSUPPORTED_CAPABILITY');
    visited.add(words[0]); words = simpleAliasWords(await readAlias(words[0]));
    words = words.filter((word, index) => { if (index && ignoredFlags.has(word)) { removed.push(word); return false; } return true; });
  }
  const [entry, ...args] = words, kind = basename(entry);
  requireValue(kind === provider && args.length === 0 || kind === 'ccs' && args.length === 1 && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(args[0]) || kind === 'ccsxp' && provider === 'codex' && args.length === 0,
    'Alias must select this provider directly, ccs with one profile, or ccsxp for Codex; extra flags are managed by Companion', 'UNSUPPORTED_CAPABILITY');
  const executable = resolve(entry);
  requireValue(executable, 'Resolved provider executable not found. Install the command or enter its installed path.', 'UNSUPPORTED_CAPABILITY');
  const message = `Resolved ${requested} to ${[executable, ...args].join(' ')}.${removed.length ? ` Ignored ${removed.join(', ')}; Companion manages permissions, hooks and isolation.` : ' Companion manages permissions, hooks and isolation.'}`;
  return { version: 1, provider, requested, executable, args, kind, model: command.model, ignoredPermissionFlags: removed, message };
}

export function validateResolvedCommand(provider, resolved) {
  requireValue(resolved?.version === 1 && resolved.provider === provider && isAbsolute(resolved.executable) && known.has(resolved.kind), 'Saved provider command is invalid; create a new goal after configuring the provider', 'UNSUPPORTED_CAPABILITY');
  requireValue(Array.isArray(resolved.args) && (resolved.kind === provider && resolved.args.length === 0 || resolved.kind === 'ccs' && resolved.args.length === 1 && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(resolved.args[0]) || resolved.kind === 'ccsxp' && provider === 'codex' && resolved.args.length === 0), 'Saved provider arguments are invalid', 'UNSUPPORTED_CAPABILITY');
  return resolved;
}
