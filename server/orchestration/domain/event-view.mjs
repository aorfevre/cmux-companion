/** Public journal messages are invalidations, not private workflow payloads.
 * Consumers fetch the authoritative goal projection after observing its version.
 * @param {{ id: number; goalId: string; version: number; generation: number; revision: number; kind: string; createdAt: string }} event
 */
export function eventView(event) {
  return { id: event.id, schemaVersion: 1, goalId: event.goalId, version: event.version,
    generation: event.generation, revision: event.revision, kind: event.kind, createdAt: event.createdAt };
}
