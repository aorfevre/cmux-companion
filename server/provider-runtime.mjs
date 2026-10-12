import { readFileSync } from 'node:fs';
import { createCodexAgents } from './codex-native.mjs';
import { resolveProviderCommand, validateResolvedCommand, CCS_REQUIRED } from './provider-command.mjs';
import { resolveExecutable } from './local-settings.mjs';
import { probeNativeCapabilities } from './orchestration/adapters/native-capabilities.mjs';
import { createNativeAgents } from './orchestration/adapters/native-agents.mjs';
import { requireValue } from './orchestration/domain/contracts.mjs';

/** cmux adds terminal-decoration shims ahead of the installed CLI. They are
 * not native executables and need a broad inherited PATH to locate their target.
 * Recognize only cmux's explicit shim marker, then pin the underlying binary;
 * CCS remains the launcher and receives this path through CCS_CLAUDE_PATH.
 */
export function resolveNativeExecutable(provider, searchPath = process.env.PATH || '') {
  const selected = resolveExecutable(provider, searchPath);
  if (!selected || !selected.includes('/cmux-cli-shims/')) return selected;
  let source = '';
  try { source = readFileSync(selected, 'utf8').slice(0, 16384); } catch { return selected; }
  const marker = provider === 'claude' ? 'CMUX_CLAUDE_WRAPPER_SHIM' : 'CMUX_CODEX_WRAPPER_SHIM';
  if (!source.startsWith('#!') || !source.includes(marker)) return selected;
  return resolveExecutable(provider, searchPath.split(':').filter(entry => !entry.includes('/cmux-cli-shims')).join(':'));
}

export async function providerInstallation(provider, command, frozen) {
  const resolution = frozen ? validateResolvedCommand(provider, frozen) : await resolveProviderCommand(provider, command);
  const bin = resolution.executable, direct = resolution.kind === provider, ccsxp = resolution.kind === 'ccsxp';
  const nativeBin = direct ? bin : resolveNativeExecutable(provider);
  requireValue(nativeBin, 'The provider CLI must also be installed and available on PATH.', 'UNSUPPORTED_CAPABILITY');
  return { installation: await probeNativeCapabilities({ ccsBin: bin, claudeBin: nativeBin, direct, provider, ccsxp }), direct, ccsxp, resolution };
}
export async function probeProvider(provider, command, tools, frozen) {
  let resolution;
  try {
    if (!resolveExecutable(tools.cmux)) return { ready: false, reason: 'cmux is missing. Configure its installed path in Tools.' };
    resolution = frozen ? validateResolvedCommand(provider, frozen) : await resolveProviderCommand(provider, command);
    await providerInstallation(provider, command, resolution);
    const conversationalReady = ['ccs', 'ccsxp'].includes(resolution.kind);
    return { ready: true, reason: null, resolution, conversationalReady, conversationReason: conversationalReady ? null : CCS_REQUIRED };
  } catch (error) { return { ready: false, reason: error.code === 'UNSUPPORTED_CAPABILITY' ? error.message : 'Provider capability validation failed. Check the installed command.', ...(resolution ? { resolution } : {}) }; }
}
export async function createConfiguredAgents({ config, directory, context }) {
  requireValue(!config.providerResolution?.error, config.providerResolution?.error || 'Saved provider resolution failed', 'UNSUPPORTED_CAPABILITY');
  const { installation, direct, ccsxp, resolution } = await providerInstallation(config.provider, config.command, config.providerResolution);
  const cmux = resolveExecutable(config.tools.cmux);
  requireValue(cmux, 'Configured cmux executable is unavailable', 'UNSUPPORTED_CAPABILITY');
  const factory = config.provider === 'codex' ? createCodexAgents : createNativeAgents;
  return factory({ directory, installation, direct, ccsxp, profile: resolution.args[0], engine: { provider: config.provider, model: config.command.model },
    env: { PATH: process.env.PATH, HOME: process.env.HOME }, cmux: { bin: cmux, env: { PATH: process.env.PATH, HOME: process.env.HOME } }, policy: config.execution }, context);
}
