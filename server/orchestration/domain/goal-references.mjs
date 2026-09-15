import { array, integer, object, requireValue, text } from './contracts.mjs';

export const REFERENCE_MAX_BYTES = 1024 * 1024;
export const REFERENCE_MAX_FILES = 8;
export const REFERENCE_BODY_BYTES = 12 * 1024 * 1024;
/** @param {unknown} value */
export function referenceName(value) {
  const name = text(value, 180).normalize('NFC');
  // eslint-disable-next-line no-control-regex -- Reject binary/control bytes in user-supplied references.
  requireValue(!/[\\/\x00-\x1f\x7f]/.test(name) && name !== '.' && name !== '..', 'Use a filename without paths or control characters');
  return name;
}
/** Persisted descriptors contain no client paths or inline file bodies.
 * @param {unknown} value @returns {import('../types.d.ts').GoalReference[]} */
export function parseGoalReferences(value) {
  const references = array(value, REFERENCE_MAX_FILES).map(entry => {
    const item = object(entry), id = text(item.id, 64);
    requireValue(/^[a-f0-9]{64}$/.test(id), 'Invalid reference identity');
    requireValue(['text/plain', 'image/png', 'image/jpeg', 'image/webp'].includes(String(item.mimeType)), 'Unsupported reference type');
    const bytes = integer(item.bytes, 1); requireValue(bytes <= REFERENCE_MAX_BYTES, 'Each reference must be at most 1 MiB');
    return { id, name: referenceName(item.name), mimeType: /** @type {import('../types.d.ts').GoalReference['mimeType']} */ (item.mimeType), bytes };
  });
  requireValue(new Set(references.map(reference => reference.id)).size === references.length, 'Do not attach the same file twice');
  return references;
}
