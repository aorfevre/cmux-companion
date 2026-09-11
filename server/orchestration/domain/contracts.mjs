/** Errors have stable public codes; transports choose their HTTP representation. */
export class DomainError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = 'DomainError'; this.code = code; }
}
/** @param {unknown} condition @param {string} message @param {string} [code] @returns {asserts condition} */
export function requireValue(condition, message, code = 'INVALID_COMMAND') {
  if (!condition) throw new DomainError(code, message);
}
/** @param {unknown} value @returns {Record<string, unknown>} */
export function object(value) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {unknown} value @param {number} [limit] */
export function text(value, limit = 4000) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !value.includes('\0'), 'Invalid text');
  return value.trim();
}
/** @param {unknown} value */
export function identifier(value) {
  const result = text(value, 128);
  requireValue(/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(result), 'Invalid identifier');
  return result;
}
/** @param {unknown} value @param {number} [minimum] */
export function integer(value, minimum = 0) {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum, 'Invalid integer');
  return value;
}
/** @param {unknown} value */
export function sha(value) {
  requireValue(typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value), 'Invalid commit identity');
  return value;
}
/** @param {unknown} value @param {number} [limit] @returns {unknown[]} */
export function array(value, limit = 100) {
  requireValue(Array.isArray(value) && value.length <= limit, 'Invalid or oversized list');
  return value;
}
/** @param {unknown} value @param {number} [limit] */
export function identifiers(value, limit = 100) {
  const items = array(value, limit).map(identifier);
  requireValue(new Set(items).size === items.length, 'Duplicate identifiers');
  return items;
}
/** Canonical JSON is used for receipts, not as shell quoting. @param {unknown} value @returns {string} */
export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const source = object(value);
  requireValue(Object.getPrototypeOf(source) === Object.prototype || Object.getPrototypeOf(source) === null, 'Expected plain JSON');
  return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(',')}}`;
}
/** Conservative supported Git branch syntax, shared before any remote effect.
 * @param {unknown} value
 */
export function branchName(value) {
  const result = text(value, 500);
  requireValue(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(result) && !result.includes('..') && !result.endsWith('.')
    && result.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock')), 'Unsupported branch name');
  return result;
}
