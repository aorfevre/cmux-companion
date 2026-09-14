import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants, accessSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DomainError, requireValue } from '../domain/contracts.mjs';

const execute = promisify(execFile);
// Initial native contract versions. Extending this set requires the offline
// argv/hook/result suite and explicit live-evidence gaps, not a model-name guess.
const CLAUDE_VERSIONS = new Set(['2.1.268']);
const CCS_VERSIONS = new Set(['8.9.0', '8.10.0']);
const FLAGS = ['--restricted', '--permission-mode', '--permission-prompts', '--setting-sources', '--strict-mcp-config', '--mcp-config', '--settings', '--tools', '--allowed-tools', '--disable-slash-commands', '--session-id', '--resume', '--print', '--output-format', '--verbose', '--no-session-persistence', '--model', '--effort'];

/** Stable local installation evidence. Paths and stderr stay private.
 * @param {string} path */
function fingerprint(path) {
  const stat = lstatSync(path);
  requireValue(stat.isFile() && !stat.isSymbolicLink(), 'Native installation file changed', 'UNSUPPORTED_CAPABILITY');
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}
/** @param {string} path */
function executable(path) {
  requireValue(isAbsolute(path) && !path.includes('\0'), 'Native executable must be explicit and absolute', 'UNSUPPORTED_CAPABILITY');
  const canonical = realpathSync(path); fingerprint(canonical); accessSync(canonical, constants.X_OK); return canonical;
}

/** Inspect explicit executables without provider profiles, account discovery or
 * CCS startup/migration. The installed CCS package must own its advertised entry.
 * Help/version run directly against the pinned native executable with fixed argv
 * and no inherited credentials. This establishes CLI compatibility, not proof of
 * actual model quality, native permission enforcement or cmux continuity.
 * @param {{ ccsBin: string; claudeBin: string; direct?: boolean; provider?: 'claude'|'codex'; ccsxp?: boolean }} options */
export async function probeNativeCapabilities({ ccsBin, claudeBin, direct = false, provider = 'claude', ccsxp = false }) {
  try {
    const bin = executable(ccsBin), nativeBin = executable(claudeBin);
    const packagePath = direct ? nativeBin : resolve(dirname(bin), ccsxp ? '../..' : '..', 'package.json');
    requireValue(direct || lstatSync(packagePath).size <= 1024 * 1024, 'Invalid CCS installation metadata', 'UNSUPPORTED_CAPABILITY');
    const packageStamp = fingerprint(packagePath);
    const metadata = direct ? { name: '@kaitranntt/ccs', version: 'direct', bin: {} } : JSON.parse(readFileSync(packagePath, 'utf8'));
    requireValue(direct && bin === nativeBin || metadata.name === '@kaitranntt/ccs' && CCS_VERSIONS.has(metadata.version)
      && (!ccsxp || provider === 'codex' && metadata.version === '8.10.0')
      && typeof metadata.bin?.[ccsxp ? 'ccsxp' : 'ccs'] === 'string' && realpathSync(resolve(dirname(packagePath), metadata.bin[ccsxp ? 'ccsxp' : 'ccs'])) === bin,
    'Unsupported CCS installation contract', 'UNSUPPORTED_CAPABILITY');
    const nativeStamp = fingerprint(nativeBin), wrapperStamp = fingerprint(bin);
    const metadataOptions = { cwd: dirname(nativeBin), env: { PATH: '/usr/bin:/bin', LANG: 'C', NO_COLOR: '1' }, timeout: 5000, maxBuffer: 256 * 1024, encoding: /** @type {const} */ ('utf8') };
    const responses = await Promise.allSettled([
      execute(nativeBin, ['--version'], metadataOptions),
      execute(nativeBin, ['--help'], metadataOptions),
    ]);
    requireValue(responses.every((entry) => entry.status === 'fulfilled'), 'Native metadata probe failed', 'UNSUPPORTED_CAPABILITY');
    const [versionResponse, helpResponse] = responses;
    requireValue(versionResponse.status === 'fulfilled' && helpResponse.status === 'fulfilled', 'Native metadata probe failed', 'UNSUPPORTED_CAPABILITY');
    const version = versionResponse.value.stdout.trim().match(provider === 'codex' ? /^codex-cli (\d+\.\d+\.\d+)$/ : /^(\d+\.\d+\.\d+) \(Claude Code\)$/)?.[1];
    const help = helpResponse.value.stdout;
    requireValue(provider === 'codex' ? version === '0.154.0' && ['--config', '--sandbox', '--ask-for-approval', '--strict-config', '--dangerously-bypass-hook-trust'].every(flag => help.includes(flag)) : version && CLAUDE_VERSIONS.has(version) && FLAGS.every((flag) => help.includes(flag))
      && /["']manual["']/.test(help) && /["']none["']/.test(help) && help.includes('stream-json')
      && (help.includes('--append-system-prompt-file') || help.includes('--append-system-prompt[-file]')),
    'Native CLI lacks the supported restricted execution contract', 'UNSUPPORTED_CAPABILITY');
    const identity = Object.freeze({ bin, nativeBin, packagePath, nativeStamp, wrapperStamp, packageStamp, provider });
    const assertCurrent = () => assertNativeInstallation(identity);
    assertCurrent();
    return Object.freeze({
      bin, nativeBin, identity, assertCurrent, ccsxp,
      evidence: Object.freeze({ ...(provider === 'codex' ? { codexVersion: version } : { claudeVersion: version }), ccsVersion: String(metadata.version), permissionEnforcement: 'unverified' }),
      // CCS 8.9.0 resolves this explicit path before searching PATH. Canonicalizing
      // the versioned executable prevents an updater symlink selecting another CLI.
      env: Object.freeze(provider === 'codex' ? { CCS_CODEX_PATH: nativeBin } : { CCS_CLAUDE_PATH: nativeBin }),
      capabilities: Object.freeze({ restricted: true, manualPermissions: true, hooks: true, strictMcp: true, streamJson: true, permissionPromptsNone: true, terminal: true }),
    });
  } catch { throw new DomainError('UNSUPPORTED_CAPABILITY', 'Native installation does not satisfy the supported capability contract'); }
}


/** Persisted compatibility evidence is rechecked by the independent supervisor
 * after activation and immediately before provider send, including after restart.
 * @param {{bin:string; nativeBin:string; packagePath:string; nativeStamp:string; wrapperStamp:string; packageStamp:string;provider?:'claude'|'codex'}} identity */
export function assertNativeInstallation(identity) {
  try {
    requireValue([identity.bin, identity.nativeBin, identity.packagePath].every((path) => isAbsolute(path) && realpathSync(path) === path)
      && fingerprint(identity.nativeBin) === identity.nativeStamp && fingerprint(identity.bin) === identity.wrapperStamp && fingerprint(identity.packagePath) === identity.packageStamp,
    'Native installation changed after capability probing', 'UNSUPPORTED_CAPABILITY');
    accessSync(identity.nativeBin, constants.X_OK); accessSync(identity.bin, constants.X_OK);
  } catch { throw new DomainError('UNSUPPORTED_CAPABILITY', 'Native installation needs a new capability probe'); }
}
