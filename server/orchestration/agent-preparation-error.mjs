/** Internal evidence: adapter construction failed before launch was invoked.
 * Never use this for an exception from launch(), where a worker may exist.
 */
export class AgentPreparationError extends Error {
  constructor() { super('The saved provider could not be prepared. Check its installation and retry.'); this.name = 'AgentPreparationError'; }
}
