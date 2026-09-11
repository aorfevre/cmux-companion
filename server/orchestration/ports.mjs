import { requireValue } from './domain/contracts.mjs';
/** Validate before reserving dispatch; unsupported capability is not a runtime experiment.
 * @param {import('./types.d.ts').AgentPort} port @param {import('./types.d.ts').Role} role @param {import('./types.d.ts').Mode} mode
 */
export function requireCapability(port, role, mode) {
  requireValue(port.capabilities.some((capability) => capability.role === role && capability.mode === mode), `Unsupported ${role}/${mode} capability`, 'UNSUPPORTED_CAPABILITY');
}
