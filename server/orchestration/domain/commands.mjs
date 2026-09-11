import { identifier, integer, object, requireValue, text } from './contracts.mjs';
/** @param {unknown} value @returns {import('../types.d.ts').Command} */
export function parseCommand(value) {
  const input = object(value);
  requireValue(Object.keys(input).every((key) => ['id', 'goalId', 'expectedVersion', 'type', 'payload'].includes(key)), 'Unknown command envelope field');
  return { id: identifier(input.id), goalId: identifier(input.goalId), expectedVersion: integer(input.expectedVersion), type: text(input.type, 80), payload: object(input.payload) };
}
export const USER_COMMANDS = new Set(['create_goal', 'publish_contract', 'request_revision', 'approve', 'abort', 'authorize_repair', 'retry_task', 'retry_attempt']);
/** @type {Readonly<Record<import('../types.d.ts').Role, ReadonlySet<string>>>} */
export const AGENT_COMMANDS = Object.freeze({
  planner: new Set(['publish_contract']), implementer: new Set(['submit_candidate']),
  reviewer: new Set(['record_review']), integrator: new Set(['submit_integration_repair']),
});
