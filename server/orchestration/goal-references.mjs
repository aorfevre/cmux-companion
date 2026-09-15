import { createHash } from 'node:crypto';
import { ArtifactStore } from './storage/artifacts.mjs';
import { array, object, requireValue, DomainError } from './domain/contracts.mjs';
import { referenceName, parseGoalReferences, REFERENCE_MAX_BYTES, REFERENCE_MAX_FILES } from './domain/goal-references.mjs';

/** Goal inputs use their own private content store and authenticated retrieval.
 * Files are committed before their immutable journal references, like result artifacts.
 */
export class GoalReferences {
  /** @param {{directory: string}} options */
  constructor({ directory }) { this.artifacts = new ArtifactStore({ directory, maxBytes: REFERENCE_MAX_BYTES }); }
  /** @param {import('./types.d.ts').Command} command */
  prepare(command) {
    if (command.type !== 'create_goal') return command;
    const payload = object(command.payload);
    requireValue(payload.references === undefined, 'Upload reference bytes rather than supplying stored identities');
    const files = array(payload.attachments ?? [], REFERENCE_MAX_FILES).map(entry => {
      const file = object(entry), name = referenceName(file.name);
      requireValue(Object.keys(file).every(key => ['name', 'data'].includes(key)) && typeof file.data === 'string' && file.data.length <= Math.ceil(REFERENCE_MAX_BYTES / 3) * 4, 'Each reference must be at most 1 MiB');
      const bytes = Buffer.from(file.data, 'base64');
      requireValue(bytes.length > 0 && bytes.length <= REFERENCE_MAX_BYTES && bytes.toString('base64') === file.data, 'Reference must contain valid base64 file bytes');
      /** @type {import('./types.d.ts').GoalReference['mimeType']} */ let mimeType = 'text/plain';
      if (/\.png$/i.test(name)) {
        requireValue(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'PNG reference has an invalid signature'); mimeType = 'image/png';
      } else if (/\.jpe?g$/i.test(name)) {
        requireValue(bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')), 'JPEG reference has an invalid signature'); mimeType = 'image/jpeg';
      } else if (/\.webp$/i.test(name)) {
        requireValue(bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP', 'WebP reference has an invalid signature'); mimeType = 'image/webp';
      } else {
        requireValue(!/\.(pdf|zip|gz|tar|docx?|xlsx?|pptx?|gif|heic|avif|ico|exe|dmg)$/i.test(name), 'Supported references are UTF-8 text/source files and PNG, JPEG or WebP images');
        let content;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new DomainError('INVALID_REFERENCE', 'Reference must be UTF-8 text or a supported image'); }
        // eslint-disable-next-line no-control-regex -- Reject binary/control bytes in user-supplied references.
        requireValue(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content), 'Reference must be UTF-8 text or a supported image');
      }
      return { descriptor: { id: createHash('sha256').update(bytes).digest('hex'), name, bytes: bytes.length, mimeType }, bytes };
    });
    const references = parseGoalReferences(files.map(file => file.descriptor));
    for (const file of files) this.artifacts.put(file.bytes);
    const rest = { ...payload }; delete rest.attachments;
    return { ...command, payload: { ...rest, ...(references.length ? { references } : {}) } };
  }
  /** @param {import('./types.d.ts').Goal} goal @param {string} id */
  read(goal, id) {
    const reference = goal.references?.find(entry => entry.id === id);
    requireValue(reference, 'Reference is not attached to this goal', 'NOT_FOUND');
    const bytes = this.artifacts.get(reference.id);
    requireValue(bytes.length === reference.bytes, 'Reference integrity check failed');
    return { reference, bytes };
  }
}
