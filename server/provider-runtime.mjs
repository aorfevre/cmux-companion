import { createCodexAgents } from './codex-native.mjs';
import { basename } from 'node:path';
import { providerCommand, resolveExecutable } from './local-settings.mjs';
import { probeNativeCapabilities } from './orchestration/adapters/native-capabilities.mjs';
import { createNativeAgents } from './orchestration/adapters/native-agents.mjs';
import { requireValue } from './orchestration/domain/contracts.mjs';

export async function providerInstallation(provider, command) {
  providerCommand(command, provider);
  const bin = resolveExecutable(command.executable);
  requireValue(bin, 'Provider executable not found. Set its installed path in Settings.', 'UNSUPPORTED_CAPABILITY');
  const direct = basename(command.executable) === provider;
  const nativeBin = direct ? bin : resolveExecutable(provider);
  requireValue(nativeBin, 'The provider CLI must also be installed and available on PATH.', 'UNSUPPORTED_CAPABILITY');
  return { installation: await probeNativeCapabilities({ ccsBin: bin, claudeBin: nativeBin, direct, provider }), direct };
}
export async function probeProvider(provider, command, tools) {
  try {
    if (!resolveExecutable(tools.cmux)) return { ready: false, reason: 'cmux is missing. Configure its installed path in Tools.' };
    await providerInstallation(provider, command);
    return { ready: true, reason: null };
  } catch (error) { return { ready: false, reason: error.code === 'UNSUPPORTED_CAPABILITY' ? error.message : 'Provider capability validation failed. Check the installed command.' }; }
}
export async function createConfiguredAgents({ config, directory, context }) {
  const { installation, direct } = await providerInstallation(config.provider, config.command);
  const cmux = resolveExecutable(config.tools.cmux);
  requireValue(cmux, 'Configured cmux executable is unavailable', 'UNSUPPORTED_CAPABILITY');
  const factory = config.provider === 'codex' ? createCodexAgents : createNativeAgents;
  return factory({ directory, installation, direct, profile: config.command.args[0], engine: { provider: config.provider, model: config.command.model },
    env: { PATH: process.env.PATH, HOME: process.env.HOME }, cmux: { bin: cmux, env: { PATH: process.env.PATH, HOME: process.env.HOME } }, policy: config.execution }, context);
}
