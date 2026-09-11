import { object, requireValue } from './domain/contracts.mjs';
import { transition } from './domain/transitions.mjs';
import { requireCapability } from './ports.mjs';

export class OrchestrationService {
  /** @param {{ store: import('./storage/store.mjs').OrchestrationStore; agents: import('./types.d.ts').AgentPort; repositoryIds?: ReadonlySet<string> }} options */
  constructor({ store, agents, repositoryIds = new Set() }) { this.store = store; this.agents = agents; this.repositoryIds = repositoryIds; }
  /** The user/bridge transport never accepts a caller-supplied Authority object.
   * @param {import('./types.d.ts').Command} command @param {import('./types.d.ts').Authority} authority
   */
  execute(command, authority) {
    return this.store.apply(command, authority, (goal, input, caller) => {
      if (input.type === 'create_goal') requireValue(this.repositoryIds.has(String(object(input.payload).repositoryId)), 'Repository is not allowed', 'FORBIDDEN');
      if (input.type === 'request_attempt') {
        const payload = object(input.payload);
        requireValue(['planner', 'implementer', 'reviewer', 'integrator'].includes(String(payload.role)), 'Unknown role');
        const role = /** @type {import('./types.d.ts').Role} */ (payload.role);
        requireCapability(this.agents, role, role === 'planner' ? 'interactive' : 'background');
      }
      const change = transition(goal, input, caller);
      if (change.intents.some((intent) => intent.kind !== 'terminate')) {
        requireValue(this.repositoryIds.has(change.goal.repositoryId), 'Repository is no longer allowed', 'FORBIDDEN');
      }
      return change;
    });
  }
}
