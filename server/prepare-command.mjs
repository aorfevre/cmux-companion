import { basename } from 'node:path';
import { requireValue } from './orchestration/domain/contracts.mjs';
import { resolveExecutable } from './local-settings.mjs';

/** Resolve the user-approved prepare command for a project, or null when the
 * project has no commanded prepare. Never reads the goal contract.
 * @param {{ prepare?: { source: string; executable?: string; args?: string[] } } | undefined} project
 * @param {{ env: NodeJS.ProcessEnv; environmentId: string; policy: import('./orchestration/types.d.ts').BackgroundPolicy }} options
 */
export function resolvePrepare(project, { env, environmentId, policy }) {
  const prepare = project?.prepare;
  if (!prepare || !['detected', 'custom'].includes(prepare.source)) return null;
  requireValue(typeof prepare.executable === 'string' && Array.isArray(prepare.args), 'Prepare command is incomplete', 'UNSUPPORTED_CAPABILITY');
  requireValue(!['sh', 'bash', 'zsh', 'fish', 'csh', 'dash', 'env', 'cmux'].includes(basename(prepare.executable)), 'Use a direct prepare executable', 'UNSUPPORTED_CAPABILITY');
  const bin = resolveExecutable(prepare.executable, env.PATH);
  requireValue(bin, 'Prepare executable is unavailable', 'UNSUPPORTED_CAPABILITY');
  return { bin, argv: [...prepare.args], env, environmentId: `${environmentId}-prepare`, policy };
}
