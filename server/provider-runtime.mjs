import { createCodexAgents } from './codex-native.mjs';
import { resolveProviderCommand, validateResolvedCommand } from './provider-command.mjs';
import { resolveExecutable } from './local-settings.mjs';
import { probeNativeCapabilities } from './orchestration/adapters/native-capabilities.mjs';
import { createNativeAgents } from './orchestration/adapters/native-agents.mjs';
import { requireValue } from './orchestration/domain/contracts.mjs';

export async function providerInstallation(provider, command, frozen) {
  const resolution = frozen ? validateResolvedCommand(provider, frozen) : await resolveProviderCommand(provider, command);
  const bin = resolution.executable, direct = resolution.kind === provider, ccsxp = resolution.kind === 'ccsxp';
  const nativeBin = direct ? bin : resolveExecutable(provider);
  requireValue(nativeBin, 'The provider CLI must also be installed and available on PATH.', 'UNSUPPORTED_CAPABILITY');
  return { installation: await probeNativeCapabilities({ ccsBin: bin, claudeBin: nativeBin, direct, provider, ccsxp }), direct, ccsxp, resolution };
}
export async function probeProvider(provider, command, tools, frozen) {
  let resolution;
  try {
    if (!resolveExecutable(tools.cmux)) return { ready: false, reason: 'cmux is missing. Configure its installed path in Tools.' };
    resolution = frozen ? validateResolvedCommand(provider, frozen) : await resolveProviderCommand(provider, command);
    await providerInstallation(provider, command, resolution);
    return { ready: true, reason: null, resolution };
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
