import { basename, isAbsolute, join } from 'node:path';
import { accessSync, constants, realpathSync, lstatSync } from 'node:fs';
import { requireValue, canonicalJson } from './orchestration/domain/contracts.mjs';
import { currentContract } from './orchestration/domain/transitions.mjs';

/** Resolve only commands authorized by this goal's current approved contract.
 * No settings mutation or shell interpretation is involved.
 * @param {{goal:import('./orchestration/types.d.ts').Goal|null|undefined;repositoryId:string;check:import('./orchestration/types.d.ts').Check;env:NodeJS.ProcessEnv;environmentId:string;policy:import('./orchestration/types.d.ts').BackgroundPolicy}} options
 */
export function resolveGoalCheck({ goal, repositoryId, check, env, environmentId, policy }) {
  requireValue(goal && goal.repositoryId === repositoryId, 'Verification repository changed', 'FORBIDDEN');
  // A review round verifies the head it recorded, under the same approved plan.
  // The commands still come from that plan, never from the round or the fixer.
  const fixing = goal.status === 'addressing_review' && goal.reviewRound?.state === 'verifying'
    && Boolean(goal.reviewRound.verificationOperationId) && Boolean(goal.reviewRound.fixHeadSha);
  requireValue((goal.status === 'building' || fixing) && goal.revision > 0 && goal.approvedRevision === goal.revision,
    'Verification requires approval of the current goal plan', 'NOT_READY');
  const allowed = currentContract(goal).verification.find(entry => canonicalJson(entry) === canonicalJson(check));
  requireValue(allowed, 'Verification command is not in the approved goal plan', 'UNSUPPORTED_CAPABILITY');
  const [executable, ...argv] = allowed.argv;
  requireValue(!['sh', 'bash', 'zsh', 'fish', 'csh', 'dash', 'env', 'cmux'].includes(basename(executable)),
    'Use a direct verification executable, without shell wrappers or cmux RPC', 'UNSUPPORTED_CAPABILITY');
  const bin = resolveExecutable(executable);
  requireValue(bin, 'Planned verification executable is unavailable', 'UNSUPPORTED_CAPABILITY');
  return { bin, argv, env, environmentId: `${environmentId}-goal-${goal.id}-revision-${goal.revision}`, policy };
}

/** Resolve a direct executable using only absolute PATH entries. @param {string} command */
function resolveExecutable(command) {
  requireValue(typeof command === 'string' && command.length > 0 && command.length <= 4096
    && !/[;$`|&<>]/.test(command) && ![...command].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    && (isAbsolute(command) || /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(command)),
  'Use a direct verification executable name or absolute path', 'UNSUPPORTED_CAPABILITY');
  const candidates = isAbsolute(command) ? [command] : (process.env.PATH || '').split(':').filter(isAbsolute).map(path => join(path, command));
  for (const path of candidates) {
    try { accessSync(path, constants.X_OK); const resolved = realpathSync(path); if (lstatSync(resolved).isFile()) return resolved; }
    catch { /* Continue through the explicit executable search path. */ }
  }
  return null;
}
