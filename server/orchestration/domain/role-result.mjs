import { array, identifier, integer, object, requireValue, sha, text } from './contracts.mjs';
import { ownedArea, parseContract } from './graph.mjs';
import { parseReview } from './review.mjs';

/** @param {Record<string, unknown>} value @param {string[]} fields */
function fields(value, fields) {
  requireValue(Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key)), 'Unexpected or missing result field');
}
/** @param {unknown} value */
function evidence(value) {
  return array(value, 40).map((entry) => {
    const item = object(entry); fields(item, ['path', 'line', 'description']);
    return { path: ownedArea(item.path), line: integer(item.line, 1), description: text(item.description, 4000) };
  });
}

/** Parse an exact role/attempt result, never terminal prose or a PASS marker.
 * This validates submitted identity and shape, not Git truth or current authority.
 * Those checks remain at the service/repository boundary.
 * @param {unknown} value
 * @param {{ goalId: string; attempt: import('../types.d.ts').Attempt }} expected
 * @returns {import('../types.d.ts').RoleResult}
 */
export function parseRoleResult(value, { goalId, attempt }) {
  const input = object(value);
  fields(input, ['schemaVersion', 'goalId', 'attemptId', 'operationId', 'generation', 'revision', 'role', 'target', 'output']);
  requireValue(input.schemaVersion === 1, 'Unsupported result schema');
  requireValue(input.goalId === goalId && input.attemptId === attempt.id && input.operationId === attempt.operationId && input.role === attempt.role, 'Result belongs to another attempt', 'FORBIDDEN');
  requireValue(input.generation === attempt.generation && input.revision === attempt.revision && input.target === attempt.target, 'Result target was replaced', 'STALE_TARGET');
  const common = { schemaVersion: /** @type {const} */ (1), goalId, attemptId: attempt.id, operationId: attempt.operationId, generation: attempt.generation, revision: attempt.revision, target: attempt.target };
  const output = object(input.output);
  switch (attempt.role) {
    case 'planner':
      if (Object.hasOwn(output, 'question')) { fields(output, ['question']); return { ...common, role: 'planner', output: { question: text(output.question, 4000) } }; }
      fields(output, ['contract']); return { ...common, role: 'planner', output: { contract: parseContract(output.contract) } };
    case 'reviewer':
      fields(output, ['schemaVersion', 'target', 'disposition', 'findings']);
      return { ...common, role: 'reviewer', output: parseReview(output, attempt.target) };
    case 'implementer':
      fields(output, ['headSha', 'summary', 'evidence']);
      return { ...common, role: 'implementer', output: { headSha: sha(output.headSha), summary: text(output.summary, 8000), evidence: evidence(output.evidence) } };
    case 'integrator':
      fields(output, ['headSha', 'operationId', 'summary', 'evidence']);
      return { ...common, role: 'integrator', output: { headSha: sha(output.headSha), operationId: output.operationId === null ? null : identifier(output.operationId), summary: text(output.summary, 8000), evidence: evidence(output.evidence) } };
  }
}
export const MAX_ROLE_RESULTS_PER_ATTEMPT = 8;
/** Bound both pending intake and retained rejected evidence for a worker.
 * @param {import('../types.d.ts').Goal['results']} results @param {string} attemptId
 */
export function requireResultCapacity(results, attemptId) {
  const own = (results ?? []).filter(entry => entry.attemptId === attemptId);
  requireValue(own.length < MAX_ROLE_RESULTS_PER_ATTEMPT && !own.some(entry => entry.status === 'pending' || entry.repair), 'Attempt result intake is already occupied or exhausted', 'IDEMPOTENCY_CONFLICT');
}
