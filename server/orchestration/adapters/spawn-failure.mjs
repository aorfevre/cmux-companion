import { DomainError } from '../domain/contracts.mjs';

const known = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'ENOENT', 'EACCES', 'EPERM', 'ENOEXEC']);
/** Only construct after the spawn error proves no provider PID was assigned.
 * Never wrap an error from an already-started process or identity persistence.
 * @param {unknown} error */
export function stoppedSpawnFailure(error) {
  const code = /** @type {{code?: string} | null} */ (error)?.code;
  return `PROVIDER_SPAWN_${known.has(code ?? '') ? code : 'FAILED'}`;
}
export class StoppedSpawnError extends DomainError {
  /** @param {string} failureCode */
  constructor(failureCode) { super('SPAWN_FAILED', 'Background process could not start'); this.failureCode = failureCode; }
}
